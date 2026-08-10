# Chapter 14 — Kafka Streams
### A Library for Building Stateful Applications on Kafka

---

If the producer/consumer/broker triad is Kafka's atomic vocabulary, Kafka
Streams is the first non-trivial sentence built from it. Streams is a Java
library — not a separate cluster, not a runtime, not a daemon — that turns
a Kafka topic (or several) into a programmable stream that you can filter,
transform, aggregate, join, window, and write back to other Kafka topics.
The output of a Streams application is itself a Kafka topic, which other
Streams applications (or other systems entirely) can read, ad infinitum.

Streams is, in a precise sense, the canonical answer to the question
"what would it look like if you wrote a stream processor that *only*
used Kafka — no separate state store, no separate scheduler, no
separate cluster?" The answer is surprisingly elegant. The answer is
also subtle, with several implementation details that take time to
internalise.

This chapter covers:

- The KStream / KTable / GlobalKTable distinction and why it matters.
- How Streams applications execute: tasks, threads, and the partitioning
  contract.
- The state store: RocksDB on local disk, plus a changelog topic in
  Kafka for fault tolerance.
- Joins, windowing, and aggregations.
- Exactly-once semantics in Streams (and how it uses the transactional
  protocol from Chapter 5).
- The processor API for when the DSL isn't enough.
- Operational realities — backups, recovery, scaling, the tax of
  stateful streaming.

By the end you should be able to read a Streams application and predict
its operational footprint: which topics it consumes, which it produces,
where its state lives, and what happens during a failover.

---

## 14.1 The conceptual move: streams and tables are two views of the same thing

The deepest insight of Kafka Streams is the **stream-table duality**.

> A **stream** is an unbounded sequence of immutable events. Each event
> is independent; their order matters but they don't supersede each
> other.
>
> A **table** is a snapshot of "the current value per key". Each key
> has at most one value at any moment.

These look like different things. They are, secretly, the same:

- **Stream → Table.** Read the stream, keep only the latest value per
  key. The result is a table.
- **Table → Stream.** Read each row's update history (every change is
  an event). The result is a stream.

Compacted topics (Chapter 12) are tables in disguise. Non-compacted
topics are streams. Streams the library makes both visible and lets you
move between them:

```java
KStream<String, Order>  orders         = builder.stream("orders");
KTable<String, Order>   latestPerOrder = orders.toTable();
KStream<String, Order>  asStream       = latestPerOrder.toStream();
```

Many real applications need both views. "A user's current profile" is a
table; "all profile changes" is a stream; either can derive the other,
and Streams' core abstractions reflect this.

---

## 14.2 The DSL, in one example

The Streams DSL is a fluent Java API. A near-canonical "word count"
example:

```java
StreamsBuilder builder = new StreamsBuilder();

KStream<String, String> textLines = builder.stream("input-topic");

KTable<String, Long> wordCounts = textLines
    .flatMapValues(value -> Arrays.asList(value.toLowerCase().split("\\W+")))
    .groupBy((key, word) -> word)
    .count(Materialized.as("word-counts-store"));

wordCounts.toStream().to("output-topic", Produced.with(Serdes.String(), Serdes.Long()));

KafkaStreams streams = new KafkaStreams(builder.build(), props);
streams.start();
```

Walking through:

1. Read from `input-topic` as a `KStream<String, String>`.
2. Flat-map each value (split on word boundaries) into individual words.
3. Group by the new key (the word itself).
4. Count — each unique word's running tally. The `Materialized.as`
   creates a named local state store ("word-counts-store") to hold
   the counts.
5. Convert the `KTable` back to a stream and write to `output-topic`.

Underneath this fluent declaration, Streams has built a **topology** of
processor nodes — a DAG with `input-topic` as the source, the
flatMap/groupBy/count nodes as transformations, and the `output-topic`
as the sink. The topology is then executed by the Streams runtime.

---

## 14.3 The execution model

A Streams application is **horizontally scalable** because the topology
is partitioned the same way the input topics are.

### 14.3.1 Tasks

A Streams application is divided into **tasks**. There is one task per
input partition (or, more precisely, per *partition group* — a set of
co-partitioned input partitions). If your input topic has 24
partitions, your application has 24 tasks; each task is responsible for
one slice of the data.

Tasks are deterministic: task 5 is always the task that reads partition
5 of the input topics. This determinism is crucial for state recovery
— a task's state belongs to it, and only it, and rolls forward only
when the task processes its inputs.

### 14.3.2 Threads

A Streams application instance runs N threads
(`num.stream.threads`, default 1). Each thread runs a subset of the
tasks. With 24 tasks and 4 threads, each thread runs 6 tasks
sequentially in a loop.

A Streams *application* (a deployment unit) can have many instances;
each instance has its own threads; the assignment of tasks to instances
is done by the underlying consumer group protocol (Chapter 11). When
you scale out — adding more instances — tasks are rebalanced and
distributed.

### 14.3.3 The execution loop

Each thread:

```
loop:
    consumer.poll() → get records for tasks owned by this thread
    for each record:
        find the task that owns this record's partition
        execute the task's topology on the record
        # this may write to local state, produce output, etc.
    if commit interval elapsed:
        commit consumer offsets, flush state, commit transaction (EOS)
```

Note: Streams uses **a single consumer per thread** internally
(actually two — one for input topics, one for the changelog), and the
tasks share that consumer. When a task is busy, the consumer doesn't
fetch for the others. Slow tasks block fast ones on the same thread.

For balance, run as many threads as your CPU has cores, and ensure
tasks are CPU-bound on the order of milliseconds, not seconds.

---

## 14.4 State stores

Streams' stateful operations (counts, aggregations, joins, windows) all
need somewhere to keep state. The choice would have been:

- Store state in memory? Lost on crash.
- Store state in a remote DB? Fast network round trip per record kills
  throughput.
- Store state in **Kafka**? Reading state per record is too slow.

Kafka Streams chose a fourth option: **store state in an embedded
RocksDB on local disk, with a changelog topic in Kafka as durable
backup**.

```
                    Streams Application Instance
                    ┌─────────────────────────────────────┐
                    │                                     │
                    │   Task processing                   │
                    │       ↓ ↑                           │
                    │   In-memory cache                   │
                    │       ↓ ↑                           │
                    │   RocksDB on local disk             │
                    │       ↓                             │
                    │   Async write to Kafka changelog    │
                    └────────────┬────────────────────────┘
                                 │
                                 ↓
                    ┌─────────────────────────────────────┐
                    │   Kafka topic: my-app-state-changelog│  ← compacted
                    │   (partitioned same as input)        │
                    └──────────────────────────────────────┘
```

### 14.4.1 RocksDB

RocksDB is an embedded key-value store from Facebook. It's an LSM-tree
implementation, optimised for write-heavy workloads. Streams uses it
because:

- It's fast for the access patterns Streams needs (point lookups,
  prefix scans).
- It scales to data sizes much larger than RAM.
- It has tunable compaction, bloom filters, block caches — all the
  knobs you'd want.

Each task gets its own RocksDB instance, on local disk, in a
per-task directory. The state directory layout:

```
${state.dir}/${application.id}/${task-id}/${state-store-name}/
    rocksdb files...
```

For our word-count example with task ID `0_0` and a state store named
`word-counts-store`:

```
/tmp/kafka-streams/word-count-app/0_0/word-counts-store/000005.sst
                                                       /000007.sst
                                                       /CURRENT
                                                       /MANIFEST-000003
                                                       ...
```

### 14.4.2 The changelog topic

Local disk is fast but not durable enough — a host failure loses the
state. Streams solves this by **mirroring every state-store update to
a Kafka changelog topic**:

```java
state.put("user-7", 42);
// → also writes ("user-7", 42) to my-app-state-changelog topic
```

The changelog topic is:

- **Compacted** (`cleanup.policy=compact`). Only the latest value per
  key is retained.
- **Co-partitioned with the input.** If input topic has 24 partitions,
  changelog has 24 partitions, and partition N of the changelog is
  written by task N.
- Internal to the application — Streams creates and manages it.

When a task fails over to a new instance:

1. New instance picks up the task.
2. New instance reads the changelog topic from the beginning,
   reconstructing the state into a new RocksDB instance.
3. Once caught up to the current end of the changelog, the task is
   ready and starts processing input.

Recovery time = changelog topic's compacted size / network bandwidth.
For large state (10s of GB), this can be **minutes to hours**. This is
the cost of stateful streaming.

### 14.4.3 Standby replicas

To reduce recovery time, Streams supports **standby replicas**:

```java
props.put("num.standby.replicas", 1);
```

A standby replica is a passive read-only copy of a task's state on
*another instance*. It tails the changelog topic, keeping its
RocksDB state warm. When the task fails over, the new owner can be the
standby — already warm, ready to start processing immediately.

The trade: more instances need more state-store space. With
`num.standby.replicas=1`, each task's state lives on 2 instances; with
`num.standby.replicas=2`, on 3 instances. Disk planning needs to
account.

---

## 14.5 Joins, windowing, and aggregations

The DSL supports several stateful operations. Each has a specific
semantic.

### 14.5.1 Stream-stream join

Join two streams within a time window:

```java
KStream<String, Order>   orders   = ...;
KStream<String, Payment> payments = ...;

KStream<String, OrderWithPayment> joined = orders.join(
    payments,
    (order, payment) -> new OrderWithPayment(order, payment),
    JoinWindows.of(Duration.ofMinutes(10))
);
```

Each side's records are buffered for the window duration; pairs that
appear within the window are joined.

State requirement: a buffer of records on both sides for at least the
window duration. State store size = window × throughput.

### 14.5.2 Stream-table join

Enrich a stream with a table's current values:

```java
KStream<String, Order>     orders = ...;
KTable<String, Customer> customers = ...;

KStream<String, EnrichedOrder> enriched = orders.join(
    customers,
    (order, customer) -> new EnrichedOrder(order, customer)
);
```

Each order is joined with the current customer record at the moment
the order is processed. The customer table is read-only from the
stream's perspective.

State requirement: the customer table's full state, locally. With many
customers, this can be large.

### 14.5.3 Aggregations and windowing

Tumbling, hopping, sliding, session windows. Each has its own
semantics; tumbling is the simplest:

```java
KTable<Windowed<String>, Long> hourlyCounts = events
    .groupByKey()
    .windowedBy(TimeWindows.of(Duration.ofHours(1)))
    .count();
```

The output key is `Windowed<String>` — the original key plus the
window's start/end timestamps.

State requirement: counts (or accumulators) for every (key, window)
pair currently active. With many keys and long windows, this grows.
Old windows are eventually expired (`grace.period`) and their state
cleaned.

---

## 14.6 Time semantics

Streams supports three notions of time:

- **Event time**: the timestamp embedded in the record (typically the
  record's `timestamp` field, set by the producer).
- **Processing time**: when the record arrives at the Streams app.
- **Ingestion time**: when the record was appended to the input topic
  (i.e., the broker's append timestamp).

For most analytical applications, you want event time — the time the
real-world event happened, not the time you got around to processing
it. Streams uses event time by default for windowing.

The trade-off is **out-of-order events**. If a producer sends an event
late (e.g., a phone going offline and replaying buffered events),
that event has an old timestamp. Streams must decide: re-open old
windows, or discard?

Configurable via `grace.period`:

- Within grace: re-open the window, recompute aggregates.
- After grace: discard the late event.

`grace.period` should be set based on your data's reality. Five seconds
is a common default for clickstream; days might be needed for
mobile-collected sensor data.

---

## 14.7 Exactly-once in Streams

Streams' exactly-once is the cleanest application of the transactional
protocol from Chapter 5.

Set `processing.guarantee=exactly_once_v2` and Streams:

1. Begins a transaction at the start of each commit interval.
2. Within the transaction, processes records, writes outputs to topics,
   writes to changelog topics for state.
3. Atomically commits the consumer offsets along with the produced
   records (using `sendOffsetsToTransaction`).
4. Commits the transaction.

If anything goes wrong (crash, exception), the transaction aborts,
the offsets aren't advanced, and the next instance reprocesses from
the last committed point. The intermediate writes — to output topics,
changelog topics — are aborted, invisible to downstream
`read_committed` consumers.

This gives:

- Exactly-once consumption of input.
- Exactly-once production to output topics.
- Exactly-once update of the changelog (and therefore of recoverable
  state).

The only remaining hole: **side effects in your processor functions**.
If your `mapValues` function calls an external API, that's not in the
transaction; it can re-run on retry. Make external calls idempotent or
move them outside the topology.

EOSv2 (the v2 variant from KIP-447) is the default since Kafka 2.6+.
Older "exactly_once" (v1) is deprecated. Use v2.

---

## 14.8 The Processor API: when the DSL isn't enough

The DSL covers the common cases. For more control, Streams exposes the
**Processor API**:

```java
class CustomProcessor implements Processor<String, Event, String, Result> {
    private ProcessorContext<String, Result> ctx;
    private KeyValueStore<String, State> store;
    
    @Override
    public void init(ProcessorContext<String, Result> ctx) {
        this.ctx = ctx;
        this.store = ctx.getStateStore("my-store");
    }
    
    @Override
    public void process(Record<String, Event> record) {
        State current = store.get(record.key());
        State next = update(current, record.value());
        store.put(record.key(), next);
        
        if (shouldEmit(next)) {
            ctx.forward(record.withValue(toResult(next)));
        }
    }
}
```

You manage state explicitly, you decide when to emit, you can schedule
periodic timer callbacks (`ctx.schedule(...)`). The Processor API is
imperative; the DSL is declarative. Most projects use the DSL with
occasional drops to Processor API for the parts the DSL can't express.

---

## 14.9 Operational realities

Streams looks simple in code. Operationally, it's a complex stateful
distributed system. The big ticket items:

### 14.9.1 State store size

Plan disk for state. For a Streams app with stateful operations, your
state can be many times larger than the input topic per day. Common
under-estimate: "the input is 10 GB/day so state is around that size."
Wrong — state is *cumulative*. A `count()` of all events ever seen
grows unboundedly. Use windowed aggregations or apply explicit
expirations.

### 14.9.2 Recovery time

If an instance fails, its tasks rebalance to other instances. New
owners must rebuild RocksDB state from the changelog. This takes time
— minutes to hours for big states. During recovery, those partitions
don't process input.

Mitigations:

- `num.standby.replicas=1` — recovery is instant from the warm
  standby.
- Co-locate Streams instances on stable infrastructure (avoid spot
  instances).
- Keep state size as small as possible — windows, retention, key
  cardinality.

### 14.9.3 Scaling out

Adding a Streams instance triggers a rebalance. With cooperative
rebalancing (default in modern Streams), only the moving tasks pause;
others continue. With many large state stores moving, overall
processing throughput is reduced during rebalance even though
individual unaffected tasks run normally.

Best practice: scale out incrementally (one instance at a time), give
each new instance time to warm up its state before adding the next.

### 14.9.4 Topology versioning

Changing the topology in a non-trivial way invalidates the old changelog.
Adding a new aggregation, renaming a state store — these require
re-processing from scratch.

For a Streams application that's been running for months, "deploy a new
version" might require hours of replay. Plan for this.

A common operational pattern is **shadow deployment**: run the new
version on a new application ID, replaying from the start of the input
topics. When it catches up to current, cut over.

### 14.9.5 Monitoring

Streams exposes JMX metrics under `kafka.streams:*`:

- `process-rate` — records per second through the topology.
- `commit-rate` — transactions committed per second (EOS).
- `process-latency-avg/max` — per-record processing time.
- `e2e-latency-avg/max` — input-to-output latency.
- per state store: `put-rate`, `get-rate`, `delete-rate`,
  `restore-rate` (during recovery).

Watch `restore-rate` during incidents — it's the canary that says "I'm
re-reading the changelog right now." High restore rate plus zero
process rate = a task is rebuilding state.

---

## 14.10 When Streams is the right answer (and when it isn't)

### 14.10.1 Right answer when

- You need stateful processing of Kafka data, and the state semantics
  fit (per-partition, durable via changelog, recoverable).
- Latency requirements are sub-second to a few seconds.
- The data volume is meaningful but bounded — single-digit TB of
  state per application is reasonable; 100s of TB is not.
- You're already in a JVM ecosystem.

### 14.10.2 Wrong answer when

- You need cross-partition state (e.g., "join arbitrary records by
  any key, regardless of partitioning"). Streams enforces co-partitioning;
  if you need anything more, you fight the tool.
- Your state is huge (hundreds of TB). Recovery time becomes
  prohibitive.
- You need ad-hoc query access to the state (Streams' state stores
  support point lookups via interactive queries, but not arbitrary
  SQL).
- You're on a non-JVM stack. Streams is Java-only; Flink and others
  are options for polyglot environments.
- Sub-millisecond latency. Streams has a commit interval (default
  30s, EOS forces this); end-to-end latency is bounded by it.

### 14.10.3 The "Streams or DB+CDC?" debate

A common alternative pattern: stream Kafka events into a transactional
database (Postgres, etc.), do the stateful processing in SQL, stream
the database's changes back out via CDC. This is more familiar to
most teams, has better tooling for ad-hoc query, but is two systems
to operate.

I have opinions: for *novel* state (state that is itself a derivation
of streaming events), Streams is often cleaner. For *existing* state
(your business already lives in a database), CDC + SQL is often
simpler. Don't pick one because of fashion; pick based on where the
data lives.

---

## 14.11 Configurations that matter

```properties
# Identity
application.id=word-count-app                # acts as group.id

# Resources
num.stream.threads=4                         # threads per instance
state.dir=/data/kafka-streams                # local state directory

# Standby replicas
num.standby.replicas=1                       # warm standbys for recovery

# Commit
commit.interval.ms=30000                     # how often to commit/flush
processing.guarantee=exactly_once_v2         # EOS

# Topology
default.deserialization.exception.handler=org.apache.kafka.streams.errors.LogAndContinueExceptionHandler
default.production.exception.handler=org.apache.kafka.streams.errors.DefaultProductionExceptionHandler

# State store cache (per instance, total)
cache.max.bytes.buffering=10485760            # 10 MB; fits typical use cases

# Time
default.timestamp.extractor=org.apache.kafka.streams.processor.WallclockTimestampExtractor
                                              # or FailOnInvalidTimestamp, or custom
```

The most important: `application.id`, `num.stream.threads`,
`processing.guarantee`. Everything else is fine-tuning.

---

## Summary box

- Streams is a **library**, not a separate service. Your app is a
  Streams app.
- The **stream-table duality** is fundamental — KStream and KTable are
  two views of the same data.
- A Streams application is divided into **tasks** (one per input
  partition); each task has its own **RocksDB state store** backed by a
  Kafka **changelog topic** for durability.
- **Standby replicas** speed up failover by keeping a warm copy of
  state on another instance.
- **Joins** require co-partitioning; streams must be partitioned the
  same way for a join to work.
- **EOSv2** (`processing.guarantee=exactly_once_v2`) gives true
  exactly-once for Kafka-bound side effects; external side effects are
  still your problem.
- **Recovery time** can be substantial (minutes to hours) if state is
  large and standbys are absent. Plan for it.
- The **Processor API** is the escape hatch when the DSL isn't enough.

## Further reading

- KIP-129: Streams Exactly-Once Semantics.
- KIP-447: Producer scalability for exactly once semantics — also the
  basis of EOSv2 in Streams.
- KIP-535: Allow state stores to serve stale reads during rebalance.
- *Mastering Kafka Streams and ksqlDB* by Mitch Seymour. The most
  comprehensive book on Streams.
- Apache Kafka source: `streams/` directory. Particularly
  `streams/src/main/java/org/apache/kafka/streams/processor/internals/StreamThread.java`
  for the execution model.

## War story: the topology change that took a week to recover

A team had a Streams application with about 200 GB of state across
all tasks, running on 12 instances with `num.standby.replicas=0` (no
standbys; they hadn't planned for it).

A developer changed the topology: added a new state store for a new
aggregation. Routine code change, ran tests, deployed.

The deploy triggered a full rebalance of every task. Each new task
owner had to rebuild RocksDB from the changelog. Across 12 instances,
each pulling ~17 GB of state from changelog topics over a 100 Mbps
intra-cluster network: about *24 hours* of recovery time before
processing resumed.

During those 24 hours, the application's downstream consumers were
silent. Pages went off; SREs investigated; the issue was eventually
understood; the team waited.

Lessons:

1. **`num.standby.replicas=1` should be the default for any
   Streams app with non-trivial state.** The cost (extra disk) is
   tiny compared to the benefit (instant failover, painless deploys).
2. **Topology changes are dangerous.** Even small additions can
   trigger massive recovery. Run capacity tests for "what does a
   full topology rebuild look like?" before going to production.
3. **Don't deploy stateful Streams apps casually.** Treat each deploy
   as a planned event with a recovery budget. Schedule them; have
   alerts and rollbacks.

After the incident, the team adopted standby replicas, set up
recovery-time monitoring, and added a "topology version" annotation
to deploys with a manual gate for changes that would invalidate state.

Streams is a powerful tool, but its operational profile is closer to
"distributed database" than to "stateless web server." Plan
accordingly.
