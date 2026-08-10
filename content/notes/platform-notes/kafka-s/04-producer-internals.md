# Chapter 4 — Producer Internals
### What Happens Between `producer.send()` and the Wire

---

The Kafka producer is the part of the system most engineers see first and
understand least. Most code paths look like this:

```java
KafkaProducer<String, String> producer = new KafkaProducer<>(props);
producer.send(new ProducerRecord<>("topic", key, value));
```

Two lines. No threading. No batching. No serialisation declared. No
ordering guarantee discussed. And yet, behind those two lines:

- A separate I/O thread is started.
- An off-heap memory pool is allocated.
- The record's key and value are serialised, possibly compressed, possibly
  authenticated.
- The destination partition is computed.
- The record is appended to a per-partition queue.
- A timer starts that, when it fires, will batch the record together with
  others heading to the same broker.
- An asynchronous callback chain is set up so the application can be told
  whether the record made it.

This chapter walks through the entire pipeline. By the end you should be
able to draw the producer's internal state machine, predict its behaviour
under back-pressure and broker failure, and tune every config knob from
first principles rather than from copy-and-paste.

We will assume the Java `KafkaProducer` (`org.apache.kafka.clients.producer.KafkaProducer`)
because it is the reference implementation. Other languages' producers
(librdkafka, sarama, kafka-python) follow the same protocol but make
different internal choices, which we'll call out where relevant.

---

## 4.1 The architecture, all at once

```
   ┌─────────────────────────────────────────────────────────────┐
   │              APPLICATION THREAD(S)                           │
   │                                                              │
   │   producer.send(record, callback)                            │
   │   ──────┬─────────────────────────────────                   │
   │         │                                                    │
   │         ▼                                                    │
   │   1. serialise key/value (configured Serializer)             │
   │         │                                                    │
   │         ▼                                                    │
   │   2. choose partition (Partitioner.partition())              │
   │         │                                                    │
   │         ▼                                                    │
   │   3. RecordAccumulator.append(record)                        │
   │         │                                                    │
   │         │ — appends to a Deque<ProducerBatch> per partition  │
   │         │ — allocates ByteBuffer from BufferPool if needed   │
   │         │ — returns a Future<RecordMetadata>                 │
   │         ▼                                                    │
   │   send() returns                                             │
   └──────────────────────┬───────────────────────────────────────┘
                          │
                          │  asynchronous handoff
                          ▼
   ┌──────────────────────────────────────────────────────────────┐
   │              SENDER THREAD (background)                       │
   │                                                               │
   │   while running:                                              │
   │     batches = accumulator.drainReadyBatches()                 │
   │     groupedByBroker = group batches by destination broker     │
   │     for each broker:                                          │
   │       request = new ProduceRequest(grouped batches)           │
   │       networkClient.send(request, broker)                     │
   │     networkClient.poll()  // I/O, callbacks                   │
   │                                                               │
   │   on response:                                                │
   │     for each batch in request:                                │
   │       complete batch's Future with success or failure         │
   │       fire user-supplied callbacks                            │
   └───────────────────────────────────────────────────────────────┘
```

Two threads. The application thread does the cheap, synchronous setup. The
Sender thread does the expensive, asynchronous I/O. They communicate via
the `RecordAccumulator`, which is a thread-safe in-memory data structure.

This split is the single most important architectural fact about the
producer. It is why `producer.send()` returns in microseconds — the
application thread does not wait for the broker. It is also why bugs
involving callbacks happen on the Sender thread, not the application thread,
and you need to be careful about thread safety in your callbacks.

---

## 4.2 The application thread's path

Let us walk through the application-thread side of `send()`, in order, with
the actual work each step does.

### 4.2.1 Serialisation

The `ProducerRecord<K, V>` arrives with a typed key and value. The producer
holds two configured `Serializer` instances (`key.serializer` and
`value.serializer` configs). Each is invoked to convert its argument to a
`byte[]`.

Common serialisers:

| Class | Use |
|-------|-----|
| `StringSerializer` | UTF-8 strings. The default for many tutorials. |
| `ByteArraySerializer` | Pass-through; you serialised it yourself. |
| `IntegerSerializer`, `LongSerializer` | Primitive numerics. |
| `KafkaAvroSerializer` (Confluent) | Avro with Schema Registry integration. |
| `KafkaProtobufSerializer` | Protobuf with Schema Registry. |
| `KafkaJsonSchemaSerializer` | JSON with schema. |

A serialisation failure throws *synchronously* on the application thread —
the record never reaches the accumulator. This is intentional: schema
violations are programming errors, not transient network conditions. They
should fail loud and immediate.

A subtlety: serialisers are invoked on the application thread. If your
serialiser is expensive (Avro with Schema Registry, on a cold start when
the schema hasn't been registered yet), `send()` will be slow. This catches
people out — they think `send()` is "fire and forget" and don't notice it
blocking on a schema lookup.

### 4.2.2 Partition selection

After serialisation, the producer needs to know which partition to put the
record into. The `Partitioner` interface drives this:

```java
public interface Partitioner extends Configurable, Closeable {
    int partition(String topic, Object key, byte[] keyBytes,
                  Object value, byte[] valueBytes, Cluster cluster);
}
```

Three default implementations have been the de-facto standards over time:

**`DefaultPartitioner`** (Kafka < 2.4): If a key is provided, hash it
(murmur2) and modulo the partition count. If no key, round-robin across all
partitions.

**`UniformStickyPartitioner`** (Kafka 2.4+, KIP-480): Same hash logic for
keyed records. For keyless records, *stick to one partition* until a batch
fills or `linger.ms` expires, then move to a new partition. Result:
batches actually fill instead of being scattered one-record-per-batch
across all partitions.

**`BuiltInPartitioner`** (Kafka 3.3+, KIP-794, default): Sticky logic but
strictly uniform across partitions over time, fixing a subtle bias the
previous sticky partitioner had toward lower-numbered partitions when
linger.ms was very small.

Why the evolution? Because partitioning interacts with batching in
non-obvious ways. Pure round-robin spreads records evenly across partitions,
but each partition then has only 1/N of the records — and batches fill up
1/N as fast — which means tiny batches, poor compression, more requests, and
worse throughput. Sticky partitioners trade strict per-record evenness for
*per-batch* evenness: each individual batch is concentrated, so it's a
"fat" batch, but over many batches the partition counts even out.

For keyed records, the math is simple: `partition = murmur2(key) % numPartitions`.
This is *not* consistent hashing; if `numPartitions` changes, the mapping
changes. (See Chapter 2's lengthy discussion of why this matters.)

For specialised needs you can implement a custom `Partitioner` —
geographically-aware, weighted, consistent-hashing, whatever. Most teams
should not, because most teams' needs are met by the default and a custom
partitioner is one more thing to debug.

### 4.2.3 The RecordAccumulator

The accumulator is the producer's memory. Its public face is `append()`;
its internal structure is a per-partition `Deque<ProducerBatch>`:

```java
ConcurrentMap<TopicPartition, Deque<ProducerBatch>> batches;
BufferPool bufferPool;
```

`append()` does the following, atomically per partition:

1. Look up the deque for `(topic, partition)`.
2. Take the *last* batch in the deque (the one currently being filled).
3. If that batch has space for the new record (size + batch.size limit not
   exceeded), append, return.
4. Otherwise, allocate a new `ByteBuffer` from `BufferPool` (default 16 KB,
   `batch.size` config), wrap it in a `ProducerBatch`, append the record,
   add the batch to the deque, return.

If the BufferPool has no available buffer, **`append()` blocks** until one
is available or `max.block.ms` expires. This is producer back-pressure —
the application thread feels broker pressure here. If the application
ignores this signal (does not handle the resulting `TimeoutException`), it
will silently lose work.

#### BufferPool, ByteBuffer, off-heap

`BufferPool` is a fixed-size pool of `ByteBuffer` instances. Its total size
is `buffer.memory` (default 32 MB). Each buffer is `batch.size` bytes (16
KB), so a fresh BufferPool has 32 MB / 16 KB = 2,048 buffers.

Whether the buffers are off-heap (direct) or heap depends on the
`buffer.memory` setting and JVM. In recent producer versions, buffers are
allocated via `ByteBuffer.allocate()` (heap) unless you've configured
otherwise — the off-heap claim from older docs is partially out of date.
This actually matters less than you think: the bytes will be copied into a
network-buffer-pool ByteBuffer (off-heap, for `sendfile`-style I/O) before
hitting the wire anyway.

What matters is that `buffer.memory` is the *hard limit* on how much
unsent data the producer can hold. If your application produces 100 MB/s
and the broker is unreachable for 1 second, you need at least 100 MB of
`buffer.memory` to absorb that, or `send()` will start blocking. Calculate.

---

## 4.3 The Sender thread

Once a record is in the accumulator, the Sender thread takes over. It runs a
tight loop, conceptually:

```java
while (running) {
    long now = time.milliseconds();
    
    // 1. Find which batches are ready to send
    ReadyCheckResult result = accumulator.ready(metadata, now);
    
    // 2. Refresh metadata if needed (e.g., new topic, leader change)
    if (result.unknownLeaderTopics.size() > 0) {
        metadata.requestUpdate();
    }
    
    // 3. Drain ready batches grouped by destination broker
    Map<Integer, List<ProducerBatch>> batches =
        accumulator.drain(metadata, result.readyNodes, ...);
    
    // 4. Build ProduceRequests, one per broker
    sendProduceRequests(batches, now);
    
    // 5. Do network I/O — send pending requests, receive responses
    client.poll(pollTimeout, now);
}
```

Step 4 — building the `ProduceRequest` — is where multiple
`ProducerBatch`es heading to the same broker get bundled into a single
network request. A broker hosting partitions 0, 5, and 12 of `my-topic` will
receive one `ProduceRequest` with three batches. This batching across
partitions is invisible at the application level but very real on the wire.

### 4.3.1 The "ready" criteria

A batch is *ready to send* if any of:

1. The batch is **full**: `batch.size` bytes accumulated, no more space.
2. The batch's **`linger.ms`** has elapsed since the first record was added.
3. The producer is **flushing**: `flush()` was called, or the producer is
   closing.
4. The BufferPool is **exhausted**: pressure forces an early send.
5. The batch has been **retried** but is now ready to retry again
   (`retry.backoff.ms` elapsed).

Conditions 1 and 2 are the throughput-vs-latency knobs. With `linger.ms=0`
(default), every record is sent as soon as the Sender thread gets to it —
batches are essentially per-record, throughput is poor, compression ratios
are terrible. With `linger.ms=100`, the Sender will wait up to 100 ms for a
batch to fill, gathering many records into one batch. Throughput goes up
substantially; latency adds up to 100 ms. **5–20 ms is a reasonable
default for most applications.**

### 4.3.2 The wire format of a ProduceRequest

For the curious — and for anyone writing a non-Java client — here is what
goes on the wire (v9, current as of Kafka 3.x):

```
ProduceRequest (v9):
  transactionalId      : NULLABLE_STRING
  acks                 : INT16          (0, 1, -1)
  timeoutMs            : INT32
  topicData            : ARRAY of {
    topic              : COMPACT_STRING
    partitionData      : ARRAY of {
      partition        : INT32
      records          : COMPACT_RECORDS
    }
  }
  TaggedFields         : (extensible field area)

ProduceResponse (v9):
  responses            : ARRAY of {
    topic              : COMPACT_STRING
    partitionResponses : ARRAY of {
      partition        : INT32
      errorCode        : INT16
      baseOffset       : INT64           (offset of first record in batch)
      logAppendTime    : INT64
      logStartOffset   : INT64
      recordErrors     : ARRAY of { batchIndex: INT32, message: STRING }
      errorMessage     : STRING
    }
  }
  throttleTimeMs       : INT32           (broker-side quota delay)
  TaggedFields         : ...
```

The full record-level data is in the `COMPACT_RECORDS` field, which is the
RecordBatch v2 format described in the existing
`01-kafka-internals-deep.md` reference. The batch is sent essentially
*as-is* from the producer's accumulator buffer to the broker's log file —
no per-record re-encoding. This is one of the throughput tricks: the batch
is built once on the producer, sent once, written once on the broker.

---

## 4.4 `acks`: the durability dial

`acks` is a producer config that names the durability the producer is
asking for. Three values:

| Value | Meaning | Latency | Durability |
|-------|---------|---------|------------|
| `0` | Send and forget. Producer does not wait for any broker response. | Lowest | None — message can be silently lost |
| `1` | Leader has appended to its local log. | Medium | Survives leader's local log failure only after fsync (which usually doesn't happen until later) — vulnerable to leader crash |
| `all` (or `-1`) | All in-sync replicas have appended (HWM advanced past this record). | Highest | Survives any failure of ≤ `RF - min.insync.replicas` brokers |

`acks=all` is the only setting compatible with the durability invariant
from Chapter 3. **Anything else accepts data loss.** The other two are
relevant only for use cases where some loss is acceptable (e.g., metrics
ingestion at huge volume where you'd rather drop than block).

A subtle gotcha: `acks=all` does **not** mean "all replicas" — it means
"all *in-sync* replicas". If your ISR has shrunk to one (only the leader
is in-sync; followers have all fallen behind), then `acks=all` becomes
equivalent to `acks=1` and you have lost durability. **`min.insync.replicas`
is what stops this from being a silent footgun.** Set it to 2 (with RF=3),
and produces will reject rather than silently downgrade durability.

### Latency calculus

`acks=all` is *not* much slower than `acks=1` in practice. The reason: the
follower replication loop is continuous. When the leader appends a record
locally, the followers are already fetching every few milliseconds. The
HWM advances within milliseconds of the leader's append. The added latency
of `acks=all` over `acks=1` is typically 1-5 ms, well within the
application's noise floor. The "acks=1 is faster" intuition is true but the
difference is usually negligible compared to the durability cost.

What does add real latency to `acks=all` is **a slow follower in the ISR**.
If one of your followers is on a degraded disk and replicating at 50 ms
behind the leader, your `acks=all` produces wait 50 ms. This is why
ISR-shrink alerts matter operationally: a slow follower silently increases
producer latency for everyone.

---

## 4.5 Idempotence and ordering

Plain `acks=all` does not guarantee no duplicates. Consider:

```
1. Producer sends batch B1 to leader.
2. Leader appends, replicates, advances HWM, sends ACK.
3. ACK is lost on the network.
4. Producer times out on B1, retries: sends B1 again.
5. Leader appends B1 a second time.
6. Now the partition has B1 twice — duplicate.
```

This is the *retry duplication* problem. The fix is **idempotence**.

When `enable.idempotence=true` (default since Kafka 3.0):

1. The producer obtains a **producer ID (PID)** from the broker on first
   connection. The PID is unique to this producer instance.
2. Each batch is tagged with `(PID, epoch, sequence_number)`. Sequence
   number increments per-partition.
3. The broker tracks, per-partition, the last accepted `(PID, epoch,
   sequence)` triplet.
4. On a retry, the broker recognises the duplicate `(PID, epoch, sequence)`,
   does not re-append, and returns success to the producer.

This is the producer-side de-duplication. It is local to a single producer
session — restart the producer, you get a new PID, and the broker has no
way to recognise duplicates from the previous session. For *that*, you
need transactions (Chapter 5).

There is a related issue: **ordering on retry.** Without idempotence, if a
producer has multiple in-flight requests to a partition and one fails and
gets retried, the retried request might land *after* a later request. Out
of order. Bad.

With idempotence, the broker enforces *strict in-order acceptance per
sequence number*. A sequence number out of order is rejected. If a retry
arrives after a later request, the broker rejects it (or holds it). This
gives strict ordering even with `max.in.flight.requests.per.connection > 1`
— up to 5, in fact, since KIP-679. Older versions required
`max.in.flight=1` for ordering, which crippled throughput. Modern Kafka
(3.0+ with idempotence) is fine at 5.

### The producer ID lifecycle

A producer ID is allocated by the **transaction coordinator** (a special
broker; we cover it in Chapter 5). For a non-transactional idempotent
producer, the PID is allocated on first `send()` and remains stable for
the producer's lifetime.

PIDs persist on the broker side in the partition's log (in special
"producer state" snapshots, the `.snapshot` files mentioned in the
on-disk layout). Even if all the data records are deleted by retention, the
producer state is retained for a configured period (`transactional.id.expiration.ms`,
default 7 days) so duplicates can be detected. This is why long-lived
producers do not "forget" their idempotence state across leader failovers.

---

## 4.6 Compression

Compression is set per-producer with `compression.type` and applied
*per RecordBatch* (not per record). Six values:

| Type | Speed | Ratio | When to use |
|------|-------|-------|-------------|
| `none` | — | 1× | Ultra-low-latency producers; tiny records where overhead dominates |
| `gzip` | Slow (CPU) | 4–6× | Bandwidth-constrained, CPU-rich (rare) |
| `snappy` | Fast | 2.5–4× | Legacy default; reasonable but Lz4 / zstd usually better now |
| `lz4` | Very fast | 2.5–4× | Default for high-throughput cases — fast enough not to bottleneck the Sender |
| `zstd` | Fast (configurable level) | 4–6× | Modern best choice — better ratio than lz4 at similar speed; widely supported since Kafka 2.1 |
| `lz4-fast`, `zstd-fast` | (variants) | | Use defaults unless you've measured |

**Rule of thumb:** if you have any volume worth talking about, compression
should be on. `lz4` or `zstd` for greenfield. `snappy` only if you have
backward-compatibility constraints with very old consumers.

Compression is done in the **Sender thread** before the request goes out.
This is important: it does not slow down `send()` calls, but it does mean
the Sender thread has CPU work to do. If your Sender thread is bottlenecked,
expensive compression (gzip) makes it worse; cheap compression (lz4) helps
by reducing the bytes shipped.

### The end-to-end compression chain

A subtle, performance-relevant fact: compressed batches are stored
**compressed** on the broker's disk, sent **compressed** over the wire to
consumers, and decompressed only *in the consumer*. The broker does not
decompress on receive (except for some validation paths) and does not
re-compress on send. This is critical to the throughput story: the same
compressed bytes flow producer → broker disk → broker network → consumer,
saving CPU at the broker and bandwidth on the wire.

(Two exceptions: compaction, which has to read records to dedupe by key, so
it decompresses-modifies-recompresses; and any consumer-fetch with
`compression.type` *override* at the topic level, which is rare.)

---

## 4.7 Callback, Future, and error handling

`producer.send()` returns `Future<RecordMetadata>`. Most production code
does *not* call `.get()` on this Future — that would synchronously wait,
defeating the async design. Instead, you pass a callback:

```java
producer.send(record, (metadata, exception) -> {
    if (exception != null) {
        // failure: log, retry, or fail the operation
    } else {
        // success: metadata.partition(), metadata.offset() are populated
    }
});
```

The callback is invoked **on the Sender thread**, not the application
thread. This has implications:

- Don't do heavy work in the callback. The Sender thread is shared across
  all in-flight requests; blocking it stalls every other producer call.
- Don't use thread-local state in the callback unless you understand which
  thread it's running on.
- Be careful with synchronisation: callbacks for the same partition are
  invoked in order (because batches for one partition are sent and acked
  in order), but callbacks for different partitions are not ordered with
  each other.

### What can go wrong, and how to handle it

| Exception | Meaning | Action |
|-----------|---------|--------|
| `TimeoutException` (from `send()` itself) | BufferPool exhausted, `max.block.ms` elapsed | Application back-pressure: slow producers, or consumer too far behind |
| `RecordTooLargeException` | Record exceeds `max.request.size` or broker's `message.max.bytes` | Resize — usually you have a bug producing huge records |
| `NotLeaderOrFollowerException` | Leader has moved | Producer auto-retries (transparent) |
| `OutOfOrderSequenceException` (idempotent producer) | Broker received an out-of-order sequence number — bug or the producer was fenced | Investigate: usually indicates a serious issue |
| `UnknownProducerIdException` | Broker has expired this producer's PID state | Producer should reset — typically transparent but worth alerting on if frequent |
| `AuthorizationException` | Producer lacks ACL for the topic | Configuration error; should fail fast |
| `RecordBatchTooLargeException` | Batch exceeds broker's max | `batch.size` too large or compression off; reduce |

A user-supplied callback receives the exception via the second argument; it
is the application's job to log/alert/handle. There is **no global "all
records succeeded" event**; each record is independent.

---

## 4.8 The transactional producer (preview)

A transactional producer extends the idempotent producer with **atomic
multi-partition writes**. Set `transactional.id` to a stable string, call
`initTransactions()` once, then wrap your sends:

```java
producer.beginTransaction();
producer.send(record1);  // partition A
producer.send(record2);  // partition B
producer.send(record3);  // partition C
producer.commitTransaction();  // all-or-nothing
```

Either all three records are committed (visible to consumers with
`isolation.level=read_committed`) or none are. We dedicate Chapter 5 to the
transactional protocol — there is a transaction coordinator, special
control records, the consumer-side filtering, the various failure modes —
and it is genuinely subtle. For now: know it exists, know it requires
`enable.idempotence=true` (which sets it implicitly), and know that
`transactional.id` must be **stable across restarts** if you want fencing
and recovery semantics.

---

## 4.9 The configs that matter, ranked

You will read recommendations to "tune the producer" all over the internet.
Most of those recommendations are noise. Here are the configs that move the
needle, ranked by impact:

### Tier 1: durability and correctness

```properties
acks=all
enable.idempotence=true
max.in.flight.requests.per.connection=5
retries=2147483647            # default; do not override
delivery.timeout.ms=120000    # how long send() will keep trying total
```

These four are non-negotiable for a "correct" producer in 2026. They are
also the defaults in modern Kafka. Don't change them unless you have a
written reason.

### Tier 2: throughput and latency

```properties
linger.ms=20                  # default 0; raise to 5-100 for batching
batch.size=65536              # default 16384; raise to 64K-1M for high throughput
compression.type=lz4          # or zstd; default 'none' is wasteful
buffer.memory=67108864        # default 32MB; raise if producing >100 MB/s
```

These are throughput dials. The exact numbers depend on your traffic; the
*direction* is "raise from defaults if you have any volume."

### Tier 3: timing and back-pressure

```properties
request.timeout.ms=30000      # how long for one request to be acked
max.block.ms=60000            # how long send() blocks on BufferPool exhaustion
```

These shape the producer's behaviour under stress. `max.block.ms` is the
back-pressure dial — a producer that blocks for 60 seconds is probably
worse for you than one that fails fast and lets you handle it.

### Tier 4: rare-need

Everything else. Don't touch unless you've measured and have a reason.

---

## 4.10 The mental model of the producer in five sentences

1. The producer's main thread is fast; it serialises, partitions, and
   appends to the accumulator, then returns.
2. A separate Sender thread polls the accumulator, batches together records
   bound for the same broker, compresses, and sends.
3. Replies come asynchronously; the Sender thread invokes user-supplied
   callbacks with success metadata or failure exceptions.
4. Idempotence (default since Kafka 3.0) makes retries safe — the broker
   de-duplicates per `(producerId, epoch, sequence)`.
5. `acks=all` plus `min.insync.replicas≥2` is the floor for durability;
   anything less is a deliberate trade for latency or throughput.

If you have these five in your head, every config-tuning recommendation in
the rest of the world makes sense in context.

---

## Summary box

- The producer is **two threads**: application (cheap, sync) and Sender
  (expensive, async).
- The **RecordAccumulator** is the bridge: a per-partition deque of
  `ProducerBatch` objects backed by a `BufferPool`. Exhaustion is your
  back-pressure signal.
- **Sticky partitioner** (default since 2.4) batches records to the same
  partition until the batch fills, *then* moves on — far better than
  round-robin for batching/compression.
- **Idempotence** (`(PID, epoch, seq)` triplet) eliminates duplicates from
  retries. Cost is negligible; it is the default in modern Kafka.
- **`acks=all` + `min.insync.replicas≥2`** is the durability floor.
  Anything less is a known trade-off, not a default.
- Compression is per-batch, applied in the Sender thread, and the
  compressed bytes flow end-to-end without re-encoding. **Always on** in
  production — `lz4` or `zstd`.
- The four configs that matter most: `acks`, `enable.idempotence`,
  `linger.ms`, `compression.type`. Get those right; defaults are fine for
  most else.

## Further reading

- KIP-98: Exactly Once Delivery and Transactional Messaging. The original
  design doc for idempotence + transactions.
- KIP-480: Sticky Partitioner.
- KIP-679: Producer will enable the strongest delivery guarantees by
  default. Why idempotence flipped on in 3.0.
- KIP-794: Strictly Uniform Sticky Partitioner.
- The `KafkaProducer` JavaDoc at the top of the class. Genuinely
  authoritative; the writers are the implementers.

## War story: the case of the silently dropped messages

A team I worked with ran a very-high-volume producer with `acks=1`,
`retries=0`, `enable.idempotence=false`. Their reasoning, when I asked, was
"we don't need duplicates, and we want maximum throughput." This was on a
cluster doing a routine rolling restart roughly once a week.

What they did not realise: every rolling restart caused a leader election
on every partition that had been led by the restarting broker. Each leader
election is a brief window — usually under a second — where the producer's
metadata is stale and a `ProduceRequest` to the old leader returns
`NOT_LEADER_OR_FOLLOWER`. With `retries=0`, the producer's response was to
fail the record. With no idempotence and no failure handling in the
application, the record was just *gone*.

Over the year, they dropped about 0.04% of all records. They noticed only
because a downstream analytics team complained that record counts didn't
match the producing service's logs.

The fix was a single-line config change: `retries=2147483647`. They had
been running with the explicit override for years, set by someone who had
left the company.

The lesson is twofold. First: the defaults have evolved over Kafka's
lifetime to be quite good. Second: every config you override has a reason,
and that reason should be in your runbook. Configs you don't remember
overriding are the configs that hurt you.

When in doubt: don't override. The Kafka maintainers have spent more time
thinking about defaults than you have.
