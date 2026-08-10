# Chapter 5 — Idempotence and Transactions
### Exactly-Once, Honestly Earned

---

For the first five years of Kafka's life, the official answer to "how do I
get exactly-once?" was, charitably, "design around it." The protocol guaranteed
*at-least-once*; duplicates were a fact of life; you handled them either by
making your processing idempotent at the application level or by dealing with
the consequences. Conferences had panel discussions on the topic. Smart people
argued, in print, that exactly-once was an *epistemological* impossibility in
distributed systems and anyone claiming to provide it was either confused or
lying.

Then, in Kafka 0.11 (2017), the project shipped exactly-once.

The internet's reaction was predictable: "But that's impossible!" "Define
what you mean!" "What about network partitions, what about Byzantine
failures, what about — " And the Kafka team patiently explained: yes, we
know about the FLP impossibility result; yes, we know about CAP; what we have
shipped is *exactly-once delivery within the boundaries of the Kafka system*,
which is a precisely-defined property that solves the most common practical
problem people meant when they said "exactly-once". They were correct, and
fifteen-thousand-word essays from sceptics did not change the fact that the
feature now works in production for thousands of teams.

This chapter is about how. We will start from the simpler half — idempotent
producers — and build up to transactions, which are subtle and where most of
the engineering went. By the end, you should be able to explain:

- Why naive `acks=all` does not give exactly-once.
- How the producer ID and sequence number eliminate duplicates within a
  single producer session.
- How transactions extend that to multi-partition, multi-session,
  consume-process-produce flows.
- Where the **transaction coordinator** lives, what state it keeps, and how
  it survives broker failures.
- What `read_committed` consumers actually see, and how the broker enforces
  the visibility rules.

We will also be honest about what exactly-once does and does not promise — a
distinction many marketing pages elide.

---

## 5.1 The duplicate problem, formally

Setup: producer P sends record R to leader L of partition (T, p), with
`acks=all`. The successful path is:

```
P → L: ProduceRequest(R)
L appends R to local log → offset N
L replicates to followers → HWM advances to N
L → P: ProduceResponse(success, baseOffset=N)
```

Now consider a network failure between steps 3 and 4: L successfully appends
and replicates, but the response packet to P is dropped. P times out.

P's options on timeout:

- **Give up.** "I assume R is lost; I will not deliver it." This is data loss
  on the producer side, which P cannot tell apart from the broker actually
  failing to receive R.
- **Retry.** "I assume R was lost; resend." If R was actually committed,
  this is now a duplicate. If R was actually lost, this is the right thing.

Without idempotence, P cannot distinguish these cases. The retry is the safe
choice for *delivery* (no records lost) but introduces *duplicates*. Choose
your side: lose some, or duplicate some. There is no "neither" without
additional protocol.

> **Lemma.** In any retry-based protocol with possible network message loss,
> exactly-once delivery requires the receiver to recognise duplicates.

This is what idempotence does.

---

## 5.2 The idempotent producer: PID, epoch, sequence

Set `enable.idempotence=true` (default in Kafka 3.0+). The protocol becomes:

### 5.2.1 Producer initialisation

On producer start, before sending any records, the producer makes an
**`InitProducerIdRequest`** to the **transaction coordinator** broker. (For
non-transactional idempotent producers, the coordinator is selected by
hashing some default value; for transactional producers, by hashing the
`transactional.id`.)

The coordinator allocates a fresh **producer ID (PID)** — a 64-bit integer
unique cluster-wide and never reused — and an initial **epoch** (16-bit, starts
at 0). It returns `(PID, epoch)` to the producer.

The PID is per-producer-instance: every restart of the producer (without a
configured `transactional.id`) gets a new PID. So idempotence across
producer restarts is *not* automatic; we will fix this in transactions.

### 5.2.2 Per-record sequence numbers

The producer maintains a **per-partition sequence number**, starting at 0.
Every record sent to partition (T, p) gets the next sequence number:

```
record 1 → (T, p): seq = 0
record 2 → (T, p): seq = 1
record 3 → (T, p): seq = 2
record 1 → (T, p'): seq = 0   // independent counter per partition
```

Each `ProducerBatch` carries the *base sequence number* of its first record;
individual records' sequence numbers are derivable from the base + their
position in the batch.

The wire format of a RecordBatch (recall Chapter 1's pointer to
`01-kafka-internals-deep.md`) has fields specifically for this:

```
RecordBatch.producerId      : int64
RecordBatch.producerEpoch   : int16
RecordBatch.baseSequence    : int32
```

### 5.2.3 Broker-side validation

When the broker (the leader of partition (T, p)) receives a batch:

```
Let lastSeq[(T, p, PID)] be the last sequence number accepted for this
producer/partition.

If batch.baseSequence == lastSeq + 1:
    Accept the batch. Update lastSeq.

If batch.baseSequence == lastSeq + 1 AND epoch is current:
    Normal happy path.

If batch.baseSequence <= lastSeq:
    Duplicate — already seen. Return success WITHOUT re-appending.

If batch.baseSequence > lastSeq + 1:
    OutOfOrderSequenceException — gap. Reject.

If epoch < current epoch:
    InvalidProducerEpoch — fenced. Reject.
```

The "duplicate detection" returns *success* — from the producer's view, the
record was delivered. The broker just doesn't double-write.

The "out of order" rejection is what enforces ordering: even if multiple
in-flight requests are racing, the broker insists on strict in-order
acceptance per sequence number.

### 5.2.4 Producer-state on the broker

Where does `lastSeq` live? In a special in-memory map per partition,
persisted to the partition's log via **producer-state snapshots** —
specifically, the `.snapshot` files we saw in the on-disk layout:

```
my-topic-0/
  00000000000000000000.log
  00000000000000000000.index
  00000000000000000000.timeindex
  00000000000000012345.snapshot   ← producer state at offset 12345
```

A snapshot is taken every time a segment is rolled. On broker restart, the
broker loads the most recent snapshot to reconstruct producer state without
re-reading the entire log. This is the only reason idempotence is fast on
restart — without snapshots, the broker would have to scan the entire log
to rebuild the per-PID sequence map.

Producer state is retained for `transactional.id.expiration.ms` (default 7
days) after the last record from that PID. A producer that goes silent for
8 days, then sends with the same PID, will get an
`UnknownProducerIdException` and be required to fetch a fresh PID. This
matters mostly for low-volume transactional producers and is sometimes a
source of surprising errors.

### 5.2.5 What this gives you, and what it doesn't

Idempotence solves:

- **Retry duplicates** within a single producer session, for a single
  partition.

Idempotence does not solve:

- **Duplicates across producer restarts.** Each restart gets a new PID; the
  broker can't dedupe across PIDs.
- **Multi-partition atomicity.** Sending a record to partition A and another
  to partition B can succeed for one and fail for the other; idempotence
  alone gives no atomicity.
- **Consume-process-produce loops.** A consumer that reads, processes, and
  writes back has no atomic guarantee that "consume offset is committed iff
  produce was committed" — those are independent operations.

For these, you need **transactions**.

---

## 5.3 The transactional producer

Set `transactional.id` to a stable, unique-per-producer-role string and
`enable.idempotence=true`. (The latter is implied by setting
`transactional.id`.)

```java
Properties props = ...;
props.put("transactional.id", "order-processor-instance-1");
props.put("enable.idempotence", "true");

KafkaProducer<String, String> producer = new KafkaProducer<>(props);
producer.initTransactions();    // one-time, on startup

while (running) {
    producer.beginTransaction();
    try {
        producer.send(record1);
        producer.send(record2);
        producer.send(record3);
        producer.commitTransaction();
    } catch (KafkaException e) {
        producer.abortTransaction();
    }
}
```

The semantics:

- All records sent between `beginTransaction()` and `commitTransaction()`
  are atomically committed *together*. Either all are visible to
  `read_committed` consumers, or none are.
- Records can span multiple partitions and even multiple topics. Atomicity
  holds across all of them.
- If the producer crashes mid-transaction, the next instance of the producer
  (with the same `transactional.id`) can recover by aborting the in-flight
  transaction. The protocol ensures the broken transaction's records are
  never visible.

To make this work, three things have to happen:

1. **The transaction coordinator** keeps state about the transaction (which
   partitions, what status).
2. **Control records** are written into the log to mark commit/abort
   boundaries.
3. **Consumers in `read_committed` mode** filter out aborted transactions
   and uncommitted in-flight transactions.

We'll go through each.

---

## 5.4 The transaction coordinator

Kafka has an internal topic called `__transaction_state`. It is structured
exactly like `__consumer_offsets`:

- 50 partitions by default.
- Replication factor 3 (configurable; should match cluster RF).
- Each transaction's state lives in *one* partition, determined by hashing
  the `transactional.id`:

```
coordinator_partition = hash(transactionalId) % num_partitions(__transaction_state)
```

The broker hosting the leader of that partition is the **transaction
coordinator** for that producer.

The coordinator's state per transaction is roughly:

```
{
  transactionalId: "order-processor-instance-1",
  producerId: 12345,
  producerEpoch: 3,
  state: ONGOING | PREPARE_COMMIT | PREPARE_ABORT | COMMITTED | ABORTED | EMPTY,
  partitions: [(topic-A, 5), (topic-A, 12), (topic-B, 0)],   // partitions touched
  txnStartTimestamp: 1709000000000,
  txnTimeoutMs: 60000
}
```

This state is itself stored in the `__transaction_state` topic — appended
as records on every state transition, with snapshotting / log compaction
keeping it bounded. Because the topic is replicated, transaction state
survives coordinator broker failure: when the coordinator broker dies, the
new leader of the relevant `__transaction_state` partition becomes the new
coordinator and reconstructs state from the log.

---

## 5.5 The transaction protocol, step by step

This is intricate. Take it slowly.

### Step 1: `initTransactions()`

Producer calls `initTransactions()`. Internally:

1. Producer sends `FindCoordinatorRequest(transactionalId)` to any broker.
   Reply: which broker is the coordinator.
2. Producer sends `InitProducerIdRequest(transactionalId)` to coordinator.
3. Coordinator does, in order:
   - **If a previous PID exists for this `transactionalId`:**
     bump its epoch (`oldEpoch + 1`). Any in-flight transaction from the old
     epoch is forced to abort. This is **fencing** — a zombie producer
     instance whose epoch is stale will be rejected if it tries to send.
   - **If no previous PID:** allocate a new PID, epoch = 0.
   - Persist the `(transactionalId, PID, epoch)` mapping in
     `__transaction_state`.
4. Coordinator returns `(PID, epoch)` to the producer.

Producer is now ready. PID and epoch are stable across restarts (because
the coordinator persists them, keyed by the stable `transactionalId`).

### Step 2: `beginTransaction()`

Local-only on the producer. Sets a flag that says "we are now in a
transaction." Records sent after this are tagged with the txn flag and
collected for commit/abort.

### Step 3: First `send()` to partition (T, p)

Before the producer sends a record to a partition that is *not yet part of
this transaction*, it must tell the coordinator:

1. Producer sends `AddPartitionsToTxnRequest(transactionalId, [(T, p)])` to
   the coordinator.
2. Coordinator persists the partition addition in `__transaction_state`.
3. Coordinator replies success.
4. Producer now sends the actual `ProduceRequest` to the partition's leader.
   The request is tagged with `(PID, epoch)`. The broker validates against
   the latest known epoch.

Subsequent sends to the same partition skip step 1-3.

### Step 4: `commitTransaction()`

Most of the engineering is here.

1. Producer flushes any pending sends — all batches in this transaction
   must have been acknowledged by their respective partition leaders.
2. Producer sends `EndTxnRequest(transactionalId, PID, epoch, COMMIT)` to
   the coordinator.
3. Coordinator persists state transition: `ONGOING` → `PREPARE_COMMIT`.
   This is the **decision point**. Once persisted, the transaction will
   commit; from now on the protocol is forward-only.
4. Coordinator returns success to the producer. **The producer's
   `commitTransaction()` returns at this point** — but the work isn't done.
5. Coordinator now sends a `WriteTxnMarkersRequest` to **every partition
   leader involved in the transaction**, asking each to write a special
   record called a **commit marker** to its log. We'll cover what this
   record looks like in 5.6.
6. As each partition leader confirms the marker has been written, the
   coordinator notes it. Once all are done, the coordinator persists state
   transition: `PREPARE_COMMIT` → `COMMITTED`.
7. The transaction is fully committed. Records are visible to
   `read_committed` consumers.

If the coordinator dies between step 3 and step 6, the new coordinator —
when elected — reads the log, sees `PREPARE_COMMIT`, and *resumes* sending
commit markers. The transaction will eventually commit. This is why
`PREPARE_COMMIT` is the decision point: once written, the outcome is
inevitable.

### Step 5: `abortTransaction()`

Same as commit, but with `PREPARE_ABORT` and an **abort marker**.
`read_committed` consumers will skip the records that were part of this
aborted transaction — they exist in the log (they were written when
`acks=all` succeeded for each batch), but consumers ignore them.

### Step 6: Recovery on producer restart

When a producer with `transactional.id="order-processor-instance-1"`
restarts:

1. It calls `initTransactions()`.
2. The coordinator looks up the `transactionalId`, finds the existing PID,
   bumps the epoch.
3. If a transaction was `ONGOING` (uncommitted) at the time of the previous
   producer's death, the coordinator now drives it to `PREPARE_ABORT` →
   `ABORTED`, writing abort markers everywhere.
4. The new producer starts with a fresh state, fenced from the old one
   by the bumped epoch.

The previous producer instance, if still alive somehow, will fail any
subsequent `send()` because its epoch is stale. This **fencing** is what
makes transactions safe under split-brain producer scenarios — exactly the
case where the old instance hasn't actually died but is, e.g.,
pause-stopped by a long GC.

---

## 5.6 Control records and the consumer's view

When the coordinator writes a commit/abort marker via `WriteTxnMarkersRequest`,
the partition's log gets a special record:

```
RecordBatch with attributes flag CONTROL_BATCH set
  records:
    Record { key: ControlRecordKey(version, type), value: ... }
```

`type` is `0` for abort, `1` for commit. These records are not user data;
they are *transaction markers*.

A `read_committed` consumer on this partition reads records in offset order
but applies a filter:

- **Skip control records.** They are protocol metadata, not data.
- **Skip records belonging to aborted transactions.** The consumer knows a
  transaction is aborted because the abort marker carries the producer ID
  whose records to skip.
- **Skip records belonging to in-flight transactions.** A record produced
  inside a not-yet-committed transaction has a flag in its batch saying
  it's transactional. The consumer can see it but must wait for the
  matching commit marker before exposing it to the application.

The consumer maintains a **list of aborted transactions** (the
`ListOffsets` API can return this list in fetch responses), and on each
batch, checks whether that batch's `(PID, beginOffset)` falls within an
aborted transaction. If yes, the records are skipped.

Implementation is in `ConsumerNetworkClient` and `Fetcher` on the consumer
side — specifically `Fetcher.parseRecord()` and the abort-tracking logic in
`SubscriptionState`. If you ever need to debug "why is my read_committed
consumer skipping records it shouldn't" — that's where to look.

### The "last stable offset" (LSO)

`read_committed` consumers don't fetch up to HWM (high watermark). They fetch
up to **LSO** (last stable offset), which is HWM minus any in-flight
transactional records. If a transaction starts at offset 1000 but never
commits, the LSO sticks at 1000 — even as new committed records pile up
above it. **Hung transactions block the LSO**, and `read_committed`
consumers stop seeing new data, even though the topic is being written.

This is a real failure mode I have personally debugged. A misconfigured
producer with `transaction.timeout.ms=900000` (15 minutes) crashed
mid-transaction; the coordinator did not abort until the timeout expired;
for 15 minutes, downstream `read_committed` consumers saw zero new records
on that partition while uncommitted records piled up. The fix is, of
course, to use a sane `transaction.timeout.ms` (default 60s; rarely a
reason to raise it).

---

## 5.7 Read-process-write: the streaming exactly-once pattern

The most important transactional use case is the **consume-process-produce**
loop, the bread and butter of stream processing:

```
loop {
    records = consumer.poll();
    output = process(records);
    
    producer.beginTransaction();
    producer.send(output);
    producer.sendOffsetsToTransaction(offsetsForRecords, consumerGroupId);
    producer.commitTransaction();
}
```

The magic line is `sendOffsetsToTransaction`. It tells the producer's
transaction coordinator: "these consumer offsets are also part of this
transaction." When the transaction commits, the offsets are committed; if
it aborts, the offsets are not, and the consumer will re-read on restart.

This makes the loop atomic: input offset advancement and output production
are both part of the same atomic commit. Either both happen or neither does.
This is what Kafka Streams uses internally when you set
`processing.guarantee=exactly_once_v2`.

Important configs for this pattern:

```properties
# Consumer side
isolation.level=read_committed       # don't see uncommitted output
enable.auto.commit=false             # commits are inside the txn, not auto

# Producer side
transactional.id=...                  # required
enable.idempotence=true               # implied
acks=all                              # implied
```

---

## 5.8 EOSv1 vs EOSv2 (Streams readers, especially)

When Kafka Streams talks about `processing.guarantee=exactly_once_v2`, it
refers to a protocol-level optimisation introduced in 2.6+:

**EOSv1** (`exactly_once`, original): one transactional producer per
consumer-instance-per-task. With many tasks (high parallelism), you had
many transactional producers, each maintaining its own coordinator state,
each making its own `InitProducerId` round trip on startup. Slow startup,
high coordinator load.

**EOSv2** (`exactly_once_v2`, KIP-447, Kafka 2.5+): one transactional
producer per *application instance*. The producer handles many partitions
and many consumer-group offsets in a single transaction. Far less metadata,
faster startup, more efficient.

EOSv2 is the right choice unless you are pinned to an old Kafka version.
EOSv1 was deprecated in 3.0 and removed in later versions.

---

## 5.9 The honest scope of "exactly-once"

Marketing pages will tell you "Kafka provides exactly-once." This is true if
you read the words precisely; it is false if you read them naively. Here is
the precise statement:

> Kafka provides exactly-once *semantics* for **records flowing through Kafka**.
> A record produced inside a transaction is delivered to a `read_committed`
> consumer either zero or one times — never more. A consume-process-produce
> loop using transactions atomically advances the consumer offset and the
> produced output: either both are committed or neither is.

What this **does not** cover:

- **External side effects.** If your processing function calls an external
  HTTP API, sends an email, or writes to a non-transactional database, that
  side effect is not part of the Kafka transaction. It can happen even if
  the transaction aborts; it can happen multiple times if the consumer
  retries. *External side effects are still your problem.*
- **Idempotence of your processing function.** If `process(r1)` produces
  output[0], output[1], output[2] and the producer crashes between
  producing output[1] and output[2], the next instance will reprocess `r1`
  and re-produce all three. The new output records will replace the old
  ones (because the transaction was aborted), but `process()` itself ran
  twice. Make sure that's safe.
- **Producers without `transactional.id`.** Idempotence-only producers do
  not survive restarts; restarting gives you a new PID and the broker will
  accept duplicates from the old session.
- **Consumers in `read_uncommitted` mode** (the default). They see all
  records, including from aborted transactions. If you want exactly-once
  semantics on the read side, you must set `isolation.level=read_committed`.

The technical argument that exactly-once is impossible (FLP, Two Generals)
is about *agreement* — getting two independent parties to agree on the
fact of delivery without unbounded protocol. Kafka exactly-once does not
violate FLP because it constrains the problem: both ends of the channel are
inside the Kafka cluster, with a single source of truth (the transactional
log) about whether a record happened. Within that constraint, exactly-once
is achievable, and Kafka achieves it.

The instant you reach outside the cluster — to a database, to a service, to
anything that does not participate in the protocol — you are back in
at-least-once land and need application-level idempotence. There is no
escaping this.

---

## 5.10 Configurations that matter

```properties
# Producer
transactional.id=stable-string-per-producer-instance
enable.idempotence=true
transaction.timeout.ms=60000             # how long the coordinator waits before auto-aborting
delivery.timeout.ms=120000               # outer timeout — must be >= transaction.timeout.ms

# Consumer (for read-side EOS)
isolation.level=read_committed
enable.auto.commit=false                 # commits go through producer

# Broker (cluster-level)
transaction.state.log.replication.factor=3   # must equal cluster RF
transaction.state.log.min.isr=2              # for durability of txn state
```

---

## Summary box

- **Idempotence** uses `(producerId, epoch, sequenceNumber)` per partition
  to deduplicate retries. Default in Kafka 3.0+. Cost is negligible.
- **Transactions** use a per-producer `transactionalId` that maps (via
  hash) to a transaction coordinator broker. Coordinator state lives in the
  internal `__transaction_state` topic, replicated for durability.
- **Two-phase commit** in spirit: `PREPARE_COMMIT` is the decision point;
  partition-level **commit/abort markers** are written to the data log;
  consumers in `read_committed` mode filter on the markers.
- **Fencing** by epoch ensures zombie producers cannot disrupt active
  transactions.
- **`sendOffsetsToTransaction`** atomically commits consumer offsets with
  produced output — this is the consume-process-produce magic.
- **Exactly-once** is exactly-once *within Kafka*; external side effects
  remain your responsibility.

## Further reading

- KIP-98: Exactly Once Delivery and Transactional Messaging. The original
  design doc. ~30 pages, dense, worth the read.
- KIP-129: Streams Exactly-Once Semantics.
- KIP-447: Producer scalability for exactly once semantics. The transition
  from EOSv1 to EOSv2.
- *Designing Data-Intensive Applications*, chapter 9 (Consistency and
  Consensus). Good general framing.

## War story: the LSO that wouldn't move

A team I consulted for had a microservice doing `consume-process-produce`
with EOSv2. Everything worked for a year. One Friday, downstream services
started reporting that they hadn't received new records for forty minutes.

The team checked the producer logs: producing fine. They checked the
broker: HWM advancing normally. They checked consumer lag from the source
side: zero. From every side, the system looked healthy.

Except `read_committed` consumers were stuck.

The diagnosis took three hours and ended at a single discovery: one of the
producer instances had an open transaction whose `transaction.timeout.ms`
had been overridden, in some long-forgotten YAML, to 24 hours. The
instance had died around mid-day; the coordinator was politely waiting
for the configured timeout before aborting; meanwhile, `LSO < HWM` and no
`read_committed` consumer could see anything written after the dead
transaction's `beginOffset`.

The fix was a five-second admin command (`kafka-transactions.sh
--abort-transaction`). The longer fix was tearing the 24-hour config out
of YAML and adding `transaction.timeout.ms` to the cluster-wide validation
list.

The lesson: every transactional system has a *liveness* knob (the
timeout), and every operator needs to know it exists. The default 60
seconds is the default for a reason. Going higher is a deliberate trade —
longer-running transactions for longer LSO stalls when something goes
wrong. Almost no one needs that trade. Almost everyone, sooner or later,
hits the case where it bites.
