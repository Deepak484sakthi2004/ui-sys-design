# Chapter 10 — Consumer Internals
### The Fetch Protocol, Position Management, and the Pause-Resume Dance

---

The consumer is the half of Kafka that engineers misunderstand most often,
in my experience. The producer's behaviour is mostly synchronous from the
caller's view — you call `send()`, you get a callback, life is simple. The
consumer's behaviour is fundamentally a *loop*, with a `poll()` call at its
heart, and around that `poll()` orbits a halo of subtle questions: when do
records get committed, what does "auto-commit" actually do, why does the
consumer suddenly stop processing for thirty seconds, what happens if my
`poll()` is too slow, how do offsets relate to records, why does my consumer
sometimes re-process records I'm sure it processed already.

The answers are mostly in the consumer's internal state machine, which is
not as small or simple as the producer's. The consumer juggles:

- A long-lived TCP connection to one or more brokers.
- A per-partition fetch position (separate from a per-partition committed
  offset).
- Periodic heartbeats to a group coordinator (Chapter 11) so the group
  knows it's alive.
- Async record buffering and synchronous record delivery to the user.
- Rebalance state transitions (assigned partitions are revoked, then
  reassigned).

This chapter walks through it. We cover:

- The `poll()` loop and what happens on each call.
- The fetch protocol: long polling, `min.bytes`, `max.bytes`, prefetching.
- The five offsets the consumer tracks and what each is for.
- Auto-commit vs manual commit, with the failure modes laid out.
- Pause and resume, used right.
- Position management on rebalance, restart, and reset.
- The `read_committed` consumer's filtering logic.

By the end you should be able to predict the consumer's exact behaviour
under any failure or configuration. Chapter 11 then builds on this with
the group-coordinator and rebalancing protocol — they are conceptually
separable, but production consumer behaviour is the interaction of both.

---

## 10.1 The consumer is single-threaded (mostly)

The first surprise: `KafkaConsumer` is **not thread-safe** for most
operations. The Java documentation is explicit:

> The Kafka consumer is NOT thread-safe. All network I/O happens in the
> thread of the application making the call.

This is unlike the producer, which has a separate Sender thread. The
consumer does its network I/O on whichever thread calls `poll()`.

Why? Because the consumer's internal state — current positions, fetch
buffers, group membership state — is intricate, and making it thread-safe
would require fine-grained locking that would slow the common case. The
implementation choice is "if you want concurrency, run multiple consumers
in multiple threads, each on its own partitions."

The exception is `wakeup()`, which can be called from any thread. It
interrupts a blocking `poll()` and is the standard way to shut down a
consumer cleanly:

```java
consumer.wakeup();   // safe from any thread; the polling thread will throw WakeupException
```

The "single-threaded" model has a major design implication: the consumer
must be very careful about how long any single operation takes, because
no parallel work can happen while it's blocked. Heartbeats need to fire;
fetches need to make progress; commits need to be issued. All of this is
synchronous in the consumer's thread. We will see how this plays out.

In modern Kafka (since 3.7+), there is a **new consumer protocol** (KIP-848)
that introduces a separate background thread for heartbeats, but the
classic protocol — still in heavy use in 2026 — is single-threaded
through and through.

---

## 10.2 The poll loop, in detail

A typical consumer loop:

```java
KafkaConsumer<K, V> consumer = new KafkaConsumer<>(props);
consumer.subscribe(Arrays.asList("my-topic"));

try {
    while (running.get()) {
        ConsumerRecords<K, V> records = consumer.poll(Duration.ofMillis(1000));
        
        for (ConsumerRecord<K, V> record : records) {
            process(record);
        }
        
        consumer.commitSync();
    }
} catch (WakeupException e) {
    // shutdown
} finally {
    consumer.close();
}
```

What does `poll()` actually do?

```
poll(timeout):
    1. If first poll: do group join (Chapter 11) and partition assignment.
    2. Re-validate group membership: am I still in the group?
       (Heartbeat check — if I missed too many, leave and rejoin.)
    3. If there's data already in the fetch buffers: return it immediately.
    4. Otherwise:
       a. Send FetchRequests for partitions whose buffers are empty.
       b. Wait for FetchResponses or until timeout expires.
       c. Buffer received records.
    5. Update the consumer's "position" for each partition based on what
       was buffered.
    6. Return the buffered records to the caller.
    7. (If auto-commit enabled and interval elapsed: commit offsets.)
```

The function is *synchronous*: it does not return until either records are
available or the timeout has passed. Importantly, while inside `poll()`,
the consumer can also do **non-record work**: heartbeating, partition
re-assignment handshakes, periodic offset commits, fetch dispatching. The
outer caller sees nothing of this; it just gets a `ConsumerRecords`
object back.

### 10.2.1 The hidden background work

Even though the consumer is single-threaded, `poll()` does a lot of work
besides returning records:

- **Heartbeats.** The consumer needs to send heartbeats every
  `heartbeat.interval.ms` (default 3000 ms) to the group coordinator. In
  the classic protocol, there is a *separate heartbeat thread* (yes,
  despite the "single-threaded" claim — heartbeats are too important to
  skip when the application is busy). But other work — the fetch
  dispatch, the offset commit, the rebalance handshake — happens inside
  `poll()`.
- **Fetch dispatch.** For partitions whose local buffer is below
  `fetch.min.bytes` worth of data, `poll()` sends a `FetchRequest`. This
  is fire-and-forget from the caller's view; the response will be
  processed on the next `poll()` (or this one, if it arrives in time).
- **Auto-commit.** If `enable.auto.commit=true` and
  `auto.commit.interval.ms` has elapsed, `poll()` issues an
  `OffsetCommitRequest`. **This is one of the most subtle interactions in
  the consumer**, and we cover it in 10.5.

### 10.2.2 The poll timeout: what it means and doesn't

The `timeout` parameter to `poll()` is the maximum time to *wait for
records*. It is **not** a budget for the whole call; group coordination
work can extend the call beyond timeout (for example, a rebalance can
take minutes if assignments are big — and the consumer will not return
records until the rebalance settles).

This catches engineers out: they set `poll(Duration.ofMillis(100))` and
are surprised when occasionally `poll()` takes 30 seconds. The timeout
is for the steady-state read; rebalance and similar events are
unbounded by this parameter.

For controlling the *outer* timing, use `max.poll.interval.ms` (the time
between successive `poll()` calls before the consumer is considered
hung, default 300000 ms = 5 minutes). If `poll()` is not called within
that interval, the coordinator declares the consumer dead and triggers
a rebalance.

---

## 10.3 The fetch protocol

A `FetchRequest` is the consumer's way of asking the broker for records.
The wire format (v13 in modern Kafka):

```
FetchRequest:
  cluster_id              : NULLABLE_STRING
  replica_id              : INT32         // -1 for consumers; broker_id for follower fetches
  max_wait_ms             : INT32         // long-poll timeout
  min_bytes               : INT32         // long-poll minimum
  max_bytes               : INT32         // global cap on response size
  isolation_level         : INT8          // 0 = read_uncommitted, 1 = read_committed
  session_id              : INT32         // KIP-227 incremental fetch sessions
  session_epoch           : INT32
  topics                  : ARRAY of {
    topic_id              : UUID
    partitions            : ARRAY of {
      partition_id        : INT32
      current_leader_epoch: INT32         // for staleness detection
      fetch_offset        : INT64
      last_fetched_epoch  : INT32         // KIP-320 OffsetsForLeaderEpoch verification
      log_start_offset    : INT64         // for follower fetches
      partition_max_bytes : INT32
    }
  }
  forgotten_topics        : ARRAY of ...  // KIP-227 incremental fetch
  rack_id                 : COMPACT_STRING // KIP-392 rack-aware fetch
```

A few features worth understanding:

### 10.3.1 Long polling

The broker holds the fetch open until either:

- `min_bytes` of data are available across all requested partitions, or
- `max_wait_ms` elapses.

This is the **long-poll** mechanism. With `min_bytes=1` (default), the
broker returns the moment any record is available, which gives near-zero
latency. With `min_bytes=1MB`, the broker waits to amass a megabyte of
data before responding — better throughput but higher latency.

For low-latency consumers, leave `fetch.min.bytes` at 1. For batch-style
consumers (analytics, ETL), raise it to 1MB or more — the throughput
improvement is substantial.

### 10.3.2 Incremental fetch sessions (KIP-227)

Pre-KIP-227, every fetch sent the full list of partitions to fetch from,
along with each partition's current position. For consumers with thousands
of assigned partitions, the request was big, often dwarfing the response.

KIP-227 introduced **incremental fetch sessions**:

1. First fetch establishes a session with the broker; broker assigns a
   `session_id`.
2. Subsequent fetches send only **changed** partitions (new positions, new
   subscriptions). Unchanged partitions are inferred.
3. `forgotten_topics` lets the consumer signal "drop these from the
   session — I'm no longer interested."

Saves a lot of bandwidth on large-fan-in consumers. Enabled by default.

### 10.3.3 Reading from followers (KIP-392)

Default: consumers fetch from the leader. KIP-392 (Kafka 2.4+) added
**rack-aware follower fetching**: if the consumer's rack matches a
follower's rack, the consumer can fetch from the follower instead, saving
inter-rack network traffic.

```properties
client.rack=us-east-1a       # consumer's rack
```

The consumer reads `replica.selector.class` on the broker side
(`RackAwareReplicaSelector`) to find a same-rack replica.

A subtle gotcha: the *leader's HWM* is what defines visibility. A
follower's HWM may lag by a fetch round trip (Chapter 8), which means
**fetching from followers shows you slightly stale data**. For most
consumers this is irrelevant; for latency-critical consumers, prefer
leader fetch.

### 10.3.4 Read-committed isolation

`isolation.level=read_committed` (default `read_uncommitted`) instructs
the broker to:

- Return records only up to the **Last Stable Offset (LSO)** — not HWM.
- Include in the response a list of **aborted transactions** (their PIDs
  and the partition's offset ranges affected).

The consumer client then filters out records belonging to aborted
transactions before delivering them to the application. The filtering is
in `Fetcher.parseRecord()` and `SubscriptionState`; it is not free —
each record's `(producerId, batch)` is checked against the aborted-txn
list.

For high-throughput pipelines, the cost is small but real. Profile if it
matters.

---

## 10.4 Subscribing vs assigning

There are two ways for a consumer to start consuming:

### Subscribe (group-managed)

```java
consumer.subscribe(Arrays.asList("topic-A", "topic-B"));
```

The consumer joins a group (defined by `group.id` config). The group
coordinator (Chapter 11) assigns partitions to consumers in the group.
On membership change (consumer joins/leaves), partitions are
re-assigned. This is the common case.

### Assign (manual)

```java
consumer.assign(Arrays.asList(
    new TopicPartition("my-topic", 0),
    new TopicPartition("my-topic", 1)
));
```

The consumer takes the listed partitions explicitly. **No group
coordination.** No rebalance, no peer discovery, no automatic failover.
The consumer is on its own.

Use `assign` when:

- You're building a tool (e.g., a backup utility) that needs precise
  control.
- You have one consumer per partition and don't want the rebalance
  protocol's overhead.
- You're implementing your own coordination on top.

Use `subscribe` for everything else, which is most things.

---

## 10.5 The five offsets, and the difference between *position* and *committed*

A consumer tracks several offsets per partition. They are named confusingly
in the Kafka literature; here is the careful taxonomy.

| Offset name | Where it lives | Role |
|-------------|----------------|------|
| **Position** | In-memory in the consumer | Where the consumer will fetch next |
| **Last consumed** | In-memory in the consumer | Offset of the most recently returned-to-application record (= position - 1, for that partition) |
| **Committed** | `__consumer_offsets` topic | The offset stored on the broker for this consumer group / partition |
| **Log Start** | Broker | Lowest readable offset on the partition |
| **HWM** | Broker | Highest committed offset on the partition |

The crucial distinction is **position vs committed**. They are different
numbers.

```
... 100 ─────── 150 ─────── 200 ───────── 250 ─────── ...
   committed    last consumed   position           HWM
                (= position-1)    (next to fetch)
```

- The consumer **fetched** records up to offset 200 from the broker.
- It has **delivered** records through offset 199 to the application.
- The application has **processed** them, but the consumer has only
  **committed** through offset 150 (committed offset is the offset of the
  *next* record to read, by convention — so committed=151 means
  "everything up to offset 150 is processed").

If the consumer crashes now, on restart, the new instance will fetch
from offset 151 — and reprocess records 151 through 199. **Records
delivered to the application but not yet committed will be reprocessed.**

This is the at-least-once semantic. The committed offset is the
durability boundary; the position is just where the consumer happens to
be reading.

### 10.5.1 The committed offset's storage

Committed offsets live in the internal `__consumer_offsets` topic
(default 50 partitions, RF 3). Each commit is a record:

```
key:   (group, topic, partition)   // typed: GroupTopicPartition
value: (offset, metadata, timestamp)
```

This is a *log-compacted* topic (Chapter 12). The cleaner thread retains
only the latest record per key, so the topic's size is bounded by
(number of consumer groups × number of distinct partitions across
subscriptions × ~30 bytes per record), which is tiny — typically a few
MB even for very large clusters.

A consumer commits by sending an `OffsetCommitRequest` to the **group
coordinator** broker (the one hosting the relevant `__consumer_offsets`
partition). The coordinator appends to the partition. Once the append is
acked (with `acks=all` semantics), the commit is durable.

---

## 10.6 Auto-commit vs manual commit

`enable.auto.commit` controls how offsets get committed. Default `true`,
which I argue is the wrong default but is what you get.

### 10.6.1 Auto-commit (`enable.auto.commit=true`)

Inside `poll()`, on every call, the consumer checks: has
`auto.commit.interval.ms` (default 5000 ms) elapsed since the last
commit? If yes, commit the *current position* of every assigned
partition.

Note carefully: it commits the **position**, which is "what was last
*returned* by `poll()`". It does NOT know whether the application has
processed the records. If the application processed half of the batch
and then crashed, but `poll()` had returned the whole batch, the
auto-commit can have committed offsets ahead of what was actually
processed — and those records are lost on restart.

This is the auto-commit data-loss bug that has cost the industry a lot
of money. I have seen it in production at three different companies.
Each time, the team's reasoning was "I'll worry about correctness later;
auto-commit is convenient." Each time, "later" arrived as an incident.

### 10.6.2 Manual commit (`enable.auto.commit=false`)

The application is responsible for committing offsets explicitly:

```java
ConsumerRecords<K,V> records = consumer.poll(Duration.ofMillis(1000));
for (ConsumerRecord<K,V> record : records) {
    process(record);
}
consumer.commitSync();   // or commitAsync() with a callback
```

Now the commit happens **after** processing. Crash between process and
commit: the record is reprocessed (at-least-once). Crash between commit
and the next batch: nothing lost.

`commitSync()` blocks until the commit is acked or `default.api.timeout.ms`
expires. `commitAsync()` returns immediately and accepts a callback for
success/failure. The choice:

- `commitSync` at the end of each batch: simple, slow (one round trip per
  batch).
- `commitAsync` for in-flight commits, plus `commitSync` on shutdown: faster,
  more complex (need to handle async failures, retries).

A common idiom:

```java
while (running) {
    ConsumerRecords<K,V> records = consumer.poll(...);
    process(records);
    consumer.commitAsync((offsets, exception) -> {
        if (exception != null) log.warn("commit failed", exception);
    });
}
// On shutdown, ensure the final commit is durable:
consumer.commitSync();
consumer.close();
```

**Recommended setting for production: `enable.auto.commit=false`**, and
commit explicitly after processing. Even if you don't need exactly-once,
this gives you correct at-least-once with no data loss on crash.

### 10.6.3 Per-record commit?

No. **Don't commit per record.** Each commit is a network round trip to
the coordinator and an append to `__consumer_offsets`; doing this per
record kills throughput and floods the offsets topic.

Commit per batch (after processing the records returned by one `poll()`).
This is the natural unit and the one Kafka's protocol is designed for.

---

## 10.7 Pause and resume: the underused tool

When a consumer's downstream processing is slow — say, you're writing
records to a database that's struggling — the natural reflex is to slow
down `poll()` calls. **This is wrong.** The consumer's heartbeats and
group-coordination work all happen inside `poll()`; if you don't `poll()`
fast enough, `max.poll.interval.ms` fires and the consumer is kicked out
of the group, triggering a rebalance.

The right tool is `pause()`:

```java
ConsumerRecords<K,V> records = consumer.poll(...);

if (downstreamIsBackedUp()) {
    consumer.pause(consumer.assignment());   // stop fetching, but keep heartbeating
}
process(records);
if (downstreamIsHealthy()) {
    consumer.resume(consumer.assignment());
}
```

While paused, `poll()` returns no records but continues to:

- Heartbeat (so group membership stays alive).
- Process group-coordination events (joins, sync, etc).
- Process metadata updates.

The consumer is "alive" for group purposes but not making progress on
fetches. This is the **back-pressure** tool.

Use this when:

- You're writing to a downstream system that's degraded and want to slow
  yourself down without losing group membership.
- You need to do periodic, expensive work that takes longer than
  `max.poll.interval.ms` (e.g., once-an-hour batch flushes).

Most consumers never need pause/resume. The ones that do, *really* need
it, and the alternative (rebalances every time downstream slows) is
disastrous.

---

## 10.8 Position management on rebalance, restart, and reset

A consumer's position is fragile state. Three things can change it:

### 10.8.1 Rebalance

When a partition is reassigned to a different consumer in the group, the
*new* consumer fetches the **committed** offset and starts from there.
**The old consumer's in-memory position is lost** — anything it had
fetched but not committed will be re-fetched and reprocessed by the new
owner.

This is the single most common cause of unexpected duplicates: a
rebalance happens, the consumer that was about to commit is interrupted,
the new owner re-reads.

To minimize:

- Use **CooperativeStickyAssignor** (Chapter 11) — keeps assignments
  stable across rebalances.
- Use **static membership** (`group.instance.id`) — a consumer that
  reconnects within `session.timeout.ms` keeps its assignment.
- Commit frequently (but per batch, not per record).
- Make processing idempotent so duplicates are harmless.

### 10.8.2 Restart

A consumer with the same `group.id` and partition assignment, restarted,
fetches the committed offset and starts from there. Same semantics as
rebalance.

### 10.8.3 Reset

A consumer subscribing to a partition for the first time has no committed
offset. `auto.offset.reset` controls what happens:

- `latest` (default): start at the current LEO. Skip all historical
  records. Useful for "I only care about new events."
- `earliest`: start at the log start offset. Read all retained history.
  Useful for "I want to backfill" or "I want to derive a complete state
  store."
- `none`: throw an exception. The application must handle missing
  offsets explicitly. Used when you want to fail loudly rather than make
  a wrong default choice.

A common surprise: `auto.offset.reset` *also* fires when the committed
offset has been deleted by retention. If a consumer has been down for
longer than retention, its committed offset (1000) is now below the log
start offset (5000); the consumer reads `OFFSET_OUT_OF_RANGE` and
applies `auto.offset.reset`. A consumer that was supposed to "resume
where it left off" will silently fast-forward to the latest record (with
default `latest`) and skip several days of data without warning.

Set `auto.offset.reset=none` if you want this to fail loudly; otherwise,
ensure your consumer downtime is well under retention.

### 10.8.4 Programmatic positioning

```java
consumer.seek(new TopicPartition("my-topic", 0), 12345);
consumer.seekToBeginning(partitions);
consumer.seekToEnd(partitions);
consumer.offsetsForTimes(timestampsByPartition);   // lookup offset by timestamp
```

`seek()` overrides the position for the next `poll()`. Useful for replay
(reset a partition's position to a known value). `offsetsForTimes()` is
the timeindex-based API for "find the first offset at or after this
timestamp" — handy for "replay the last hour of data."

---

## 10.9 The fetcher's prefetch and buffering

The consumer doesn't fetch and immediately deliver. There's a buffer.

Internally:

```
                     ┌──────────────────────────────┐
                     │  Per-partition fetch buffer  │
                     │   ┌─┬─┬─┬─┬─┬─┬─┐            │
                     │   └─┴─┴─┴─┴─┴─┴─┘  records   │
                     └──────────────────────────────┘
                                 ↑
                                 │
                       FetchRequest/Response
                                 │
                                 ↓
                          BROKER (leader of partition)
```

When `poll()` is called and the buffer has records, they are returned
immediately — no broker round trip. When the buffer is low, a fetch is
sent in the background (within `poll()`'s execution).

Configs:

- `fetch.min.bytes` — minimum bytes in a fetch response (long-poll
  threshold).
- `fetch.max.bytes` — maximum bytes total.
- `fetch.max.wait.ms` — long-poll timeout.
- `max.partition.fetch.bytes` — per-partition cap (default 1 MB).
- `max.poll.records` — maximum records returned per `poll()` call.

`max.poll.records` is the one most worth tuning. Default is 500. If your
processing is fast (sub-millisecond per record), 500 is fine; if it's
slow (tens of milliseconds), 500 records can take a long time and risk
hitting `max.poll.interval.ms`. Lower it.

A neat trick: set `max.poll.records=10` for slow consumers, and the
consumer will batch its work into 10-record chunks, calling `poll()` more
frequently and giving heartbeats more chance to fire.

---

## 10.10 Configurations that matter

```properties
# Identity
group.id=my-consumer-group
group.instance.id=consumer-instance-1   # static membership; a stable string per consumer instance

# Subscription
auto.offset.reset=earliest               # or 'latest'; never 'none' unless you handle exceptions

# Commits
enable.auto.commit=false                 # PRODUCTION SETTING; flip to true at your peril
auto.commit.interval.ms=5000             # ignored if auto-commit is off

# Polling & timing
max.poll.records=500                     # tune if processing is slow
max.poll.interval.ms=300000              # 5 min; how long between polls before being kicked
heartbeat.interval.ms=3000               # heartbeat frequency
session.timeout.ms=45000                 # broker considers consumer dead after this

# Fetching
fetch.min.bytes=1                        # raise to 1MB+ for batch consumers
fetch.max.wait.ms=500
fetch.max.bytes=52428800                 # 50 MB total
max.partition.fetch.bytes=1048576        # 1 MB per partition

# Isolation
isolation.level=read_uncommitted         # or read_committed (with transactional producers)

# Assignor
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor

# Rack
client.rack=us-east-1a                   # for follower-fetch

# Connection
connections.max.idle.ms=540000           # 9 min; less than broker's 10 min
```

The *single most important* setting: `enable.auto.commit=false`. The
*second most important*: `partition.assignment.strategy=CooperativeStickyAssignor`
(rebalance behaviour, Chapter 11). Get those two right and everything
else is fine-tuning.

---

## Summary box

- The Java consumer is **single-threaded for fetch and processing**;
  heartbeats run on a separate thread (classic protocol).
- `poll()` returns buffered records, dispatches new fetches, and
  performs group-coordination work — all in one call.
- The fetch protocol uses **long polling** (`min.bytes` /
  `max.wait.ms`) and supports incremental fetch sessions (KIP-227) and
  rack-aware follower fetch (KIP-392).
- **Position** ≠ **committed**. Position is in-memory, advances on
  every poll. Committed is durable, advances only on commit.
  Reprocessing on restart is bounded by the gap.
- **`enable.auto.commit=true` is dangerous.** Use manual commit
  (`commitSync()` or `commitAsync()`) after processing.
- **Pause/resume** is the back-pressure tool, not slow `poll()` calls.
- `auto.offset.reset` fires not just on first read, but also when the
  committed offset has been deleted by retention. Plan for this.
- `max.poll.records` is the most-tuned config; lower it for slow
  consumers to keep heartbeats firing.

## Further reading

- KIP-62: Allow consumer to send heartbeats from a background thread.
  How heartbeats decoupled from poll loop.
- KIP-227: Introduce Incremental FetchRequests to Increase Partition
  Scalability.
- KIP-320: Allow fetchers to detect and handle log truncation.
- KIP-392: Allow consumers to fetch from closest replica.
- KIP-848: The Next Generation of the Consumer Rebalance Protocol —
  redesigns the protocol; covered in Chapter 11.
- *Kafka: The Definitive Guide* (2nd ed) chapter 4 for an operator's
  view of the consumer.

## War story: the consumer that lost the data it had read

A team had a consumer pipeline doing `auto.offset.reset=latest`,
`enable.auto.commit=true`, processing critical records and writing to a
database. They got a regulator request for "all events from last
Tuesday" — the database had only half of them.

The forensics:

- The consumer had had a long GC pause one Tuesday afternoon (~40 seconds).
- During the pause, the consumer missed several heartbeats. The
  coordinator marked it dead and rebalanced.
- A different consumer instance took over the partitions. It saw the
  committed offset (auto-committed by the dead consumer 4 seconds before
  the GC pause) and started from there.
- The dead consumer recovered and rejoined the group. It got a different
  partition assignment.

So far so normal. But the *committed offset was advanced by the
auto-commit thread before the records had been written to the
database*. The new consumer didn't reprocess them; the old consumer
didn't finish them. About 5,000 records — between the auto-commit and
the GC pause — were silently lost.

This is the classic auto-commit failure mode: the commit advanced
beyond the application's actual progress.

The fix was a 4-line change: `enable.auto.commit=false`, and an
explicit `commitSync` call after the database write succeeded. The
team also set `partition.assignment.strategy=CooperativeStickyAssignor`
so the GC-paused consumer wouldn't lose its assignments on reconnect
(saving the rebalance overhead).

Tested by deliberately stalling a consumer for 60 seconds in staging
and verifying no records were skipped. The test went green; they
shipped; problem solved.

The lesson: auto-commit is an opt-in performance optimisation that
trades correctness for convenience. The convenience is small; the
correctness cost is unbounded. Almost no production consumer should
use it.
