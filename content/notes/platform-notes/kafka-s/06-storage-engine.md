# Chapter 6 — The Storage Engine
### Logs on Disk, Page Cache, and the Magic of `sendfile()`

---

If the log is the soul of Kafka, the storage engine is its body. Everything
in this book — the producer's idempotence, the consumer's offsets, the
controller's metadata — is, at the bottom, *files on disks on brokers*.
Kafka's storage engine is famously simple in its architecture: it uses the
filesystem rather than implementing its own block management; it leans hard
on the OS page cache instead of an internal cache; it uses sequential
writes and sparse indexes; it sends data straight from disk to network with
zero copies. This simplicity is the source of its throughput, and it is also
the source of every operational subtlety that has ever bitten anyone with a
broker on fire at 3 a.m.

This chapter walks the storage engine top to bottom. We cover:

- The on-disk layout (revisiting and extending Chapter 1's sketch).
- How writes flow from broker memory to disk to followers, and what fsync
  does (and does not) do.
- How reads use the sparse index, the page cache, and `sendfile()`.
- Segment lifecycle: rolling, retention, deletion, compaction (the latter
  in summary; full chapter in Chapter 12).
- Recovery on broker restart.
- The configurations that matter, and how to think about disk sizing.

You should finish this chapter able to predict, looking at any Kafka cluster's
disks, what the workload is doing — and to predict, given a workload, how
the disks will behave.

---

## 6.1 The on-disk layout, in full

Each broker has one or more **log directories** (`log.dirs` config). Within
each log directory, every partition the broker hosts gets a subdirectory:

```
/var/lib/kafka/data/                       # log.dirs[0]
  my-topic-0/                              # partition 0 of my-topic
  my-topic-1/
  my-topic-2/
  __consumer_offsets-0/                    # internal topic
  __consumer_offsets-1/
  ...
  __cluster_metadata-0/                    # KRaft metadata log (controller node)
  meta.properties                          # broker ID, cluster ID, version
  recovery-point-offset-checkpoint         # per-partition recovery offsets
  replication-offset-checkpoint            # per-partition HWM checkpoint
  log-start-offset-checkpoint              # per-partition log-start offset
  cleaner-offset-checkpoint                # for log compaction
```

The four `*-checkpoint` files are flat text files updated periodically by
the broker. They allow the broker to skip log scanning on cold start,
recovering quickly to the last known good state. We'll come back to them in
6.7.

Inside a partition directory:

```
my-topic-0/
  00000000000000000000.log
  00000000000000000000.index
  00000000000000000000.timeindex
  00000000000000000000.txnindex                  ← aborted-txn index (only if any txns)
  00000000000000000000.snapshot                  ← producer state at this offset
  00000000000017293841.log
  00000000000017293841.index
  00000000000017293841.timeindex
  00000000000017293841.snapshot
  00000000000034587682.log                       ← active segment
  00000000000034587682.index
  00000000000034587682.timeindex
  leader-epoch-checkpoint                        ← (epoch, startOffset) tuples
  partition.metadata                             ← topic ID (uuid)
```

Each numeric prefix is the **base offset** of that segment — the offset of
the first record in it. Segments are non-overlapping and contiguous: segment
17293841 holds offsets 17293841 through (34587682 - 1).

Files explained:

- **`.log`** — the actual record bytes, formatted as RecordBatch v2.
- **`.index`** — sparse offset → file-position index.
- **`.timeindex`** — sparse timestamp → relative-offset index.
- **`.txnindex`** — list of aborted transactions in this segment (only
  written if the segment contains transactional data).
- **`.snapshot`** — producer-state snapshot for idempotence/transactions.
- **`leader-epoch-checkpoint`** — the history of (leaderEpoch, startOffset)
  pairs for this partition. Used during recovery to detect and truncate
  stale data after a leader change.
- **`partition.metadata`** — the topic's UUID (KIP-516, since 2.8).
  Allows topic recreation to be detected.

The segment file (`.log`) is **always append-only**. The OS does not need
random-write performance; the disk does not seek to old positions; the
filesystem's allocation choices are simpler. This is the foundational
performance trick.

---

## 6.2 What's inside a `.log` file

A `.log` file is a sequence of `RecordBatch` records concatenated end to
end. We saw the wire format in Chapter 4 and it is repeated in
`01-kafka-internals-deep.md`. Here is the structure with byte counts again
for completeness, because it matters for what comes next:

```
RecordBatch (v2):
  baseOffset           : int64   (8)
  batchLength          : int32   (4)   bytes from "magic" onward
  partitionLeaderEpoch : int32   (4)   leader's epoch when this was written
  magic                : int8    (1)   currently 2
  crc                  : uint32  (4)   CRC32C of bytes after this field
  attributes           : int16   (2)   flags: compression, timestamp type,
                                        transactional, control
  lastOffsetDelta      : int32   (4)
  baseTimestamp        : int64   (8)
  maxTimestamp         : int64   (8)
  producerId           : int64   (8)   for idempotence
  producerEpoch        : int16   (2)
  baseSequence         : int32   (4)
  records              : ARRAY<Record>
```

A few observations that matter for the broker:

- The **`partitionLeaderEpoch`** is set by the broker, not the producer. The
  leader stamps this on every batch it appends, recording its own epoch
  number at the time. This is the data needed to enforce KIP-101 truncation
  on leader changes (Chapter 8).
- The **`crc`** covers everything after itself — corrupting any byte in
  the batch is detectable. The broker validates on read. This is one
  reason "torn writes" from sudden power loss are detectable: the partial
  batch will fail CRC.
- The **`attributes`** flags include a `CONTROL` bit, which marks the
  batch as a transaction marker (commit/abort), and a `TXN` bit, which
  marks it as part of an open transaction. Consumers use these.
- The **`baseOffset`** is set by the leader on append and is the offset of
  the first record in the batch. The producer sends `baseOffset=0` on the
  wire (before assignment); the leader assigns. `lastOffsetDelta` is fixed
  by the producer (it's `numRecords - 1` essentially).

Records inside the batch are varint-encoded, with relative offsets and
relative timestamps so common short-record streams pack densely. With
compression on, the entire records array (everything after the
`baseSequence` field) is compressed as one blob. Decompression is bypassed
entirely on the broker for all the fast paths — we'll see why shortly.

---

## 6.3 The sparse offset index

The `.index` file is a flat array of fixed-size entries:

```
struct IndexEntry {
    int32 relativeOffset;    // (offset - baseOffset of segment), 4 bytes
    int32 position;          // byte offset into the .log file, 4 bytes
};
```

8 bytes per entry. The file is **memory-mapped** by the broker
(`MappedByteBuffer`) — Linux mmap, no read syscalls per lookup, the OS
serves bytes from the page cache.

The index is **sparse**: the broker writes one entry every
`log.index.interval.bytes` bytes of `.log` data appended (default 4096). So
if your log has 1 GB of data and 4 KB index intervals, the index has
1 GB / 4 KB = 256K entries × 8 bytes = 2 MB. Tiny.

### Lookup algorithm

To find offset `O` in a partition:

1. **Find the segment.** The broker keeps a sorted list of segments
   in memory (a `ConcurrentSkipListMap` keyed by base offset, in the source).
   Floor lookup gives the segment whose `baseOffset ≤ O`.
2. **Search the index.** In that segment's `.index`, binary search for
   `relativeOffset ≤ (O - baseOffset)`. Returns the latest entry with a
   relative offset at most that target.
3. **Linear scan the `.log` from the entry's `position`** until offset `O`
   is found. Bounded by `log.index.interval.bytes` (4 KB), so at most a
   handful of batches scanned.

Why not dense? A dense index — one entry per record — would be roughly the
same size as the log. Sparse keeps it tiny enough to fit in RAM (page
cache), so lookups are O(log n) memory operations plus O(1) disk seek.

The 4 KB default index interval is, in practice, never tuned. It's a sweet
spot between "small index, more linear scan" and "big index, less scan."

### Offset → position is approximate, not exact

The fact that the index is sparse has subtle consequences. If you ask for
"offset 723", the broker:

- Looks up index entry with relativeOffset ≤ 723's relative offset.
- Returns position 81920.
- Tells the consumer: "start reading at byte 81920 of the .log file."

The first batch the consumer reads might *not* contain offset 723; it might
contain offset 700, with offset 723 some bytes further in. The consumer
parses the batches and skips records before its target offset. This is
fine; it's just record decoding. But it means **`fetchOffset` is a
hint, not a precise byte address**, and the broker does not need to
maintain a precise byte-level mapping.

---

## 6.4 The timeindex

The `.timeindex` file:

```
struct TimeIndexEntry {
    int64 timestamp;          // 8 bytes (epoch millis)
    int32 relativeOffset;     // 4 bytes (the corresponding offset)
};
```

12 bytes per entry. Sparse, written every
`log.index.interval.bytes` bytes (same trigger as `.index`).

Used for two operations:

1. **`offsetsForTimes(timestamp)`** — consumer asks "what offset had a
   message at or after this timestamp?" Broker binary-searches the
   timeindex.
2. **Time-based retention.** The broker scans the timeindex of each segment
   to find segments whose maximum timestamp is older than
   `log.retention.ms`. Those segments can be deleted.

The timeindex's existence is why time-based retention is precise to the
segment level (not record-level), and why moving the system clock backwards
on a broker can cause hilarious retention bugs (the scan logic uses
*timestamps*, which may now go backwards). In production, **never** play
games with the system clock.

The timeindex was added in Kafka 0.10. Before that, retention was
purely message-count-based and time-based retention was a hack that didn't
really work. Worth knowing if you encounter ancient deployments.

---

## 6.5 Writes: from producer's network thread to disk

When a producer's `ProduceRequest` arrives at the leader, here is what
happens, layer by layer:

### 6.5.1 Network layer

The broker's network threads (`numNetworkThreads`, default 3) read the
bytes off the socket. They don't parse; they just shovel bytes. Once a
complete request is buffered, the network thread hands it to the
`requestQueue` for processing.

### 6.5.2 Request handler thread

The request handler threads (`numIoThreads`, default 8) pull from the
`requestQueue`, decode the request, and execute it. For a ProduceRequest:

1. Authenticate (if SASL/TLS).
2. Authorise (if ACLs are on).
3. Validate the request format.
4. For each (topic, partition) in the request:
   - Find the local partition's `Log` object.
   - Validate the batch: CRC, sequence numbers (idempotence), magic byte.
   - Append to the in-memory log via `Log.append()`.

`Log.append()` is the heart of the write path. It does:

```java
synchronized (lock) {
    // Validate offset assignment
    long baseOffset = nextOffset;
    
    // Update batch's baseOffset and partitionLeaderEpoch in place
    rewriteBatchHeader(batch, baseOffset, currentLeaderEpoch);
    
    // Write batch bytes to active segment's log file via FileChannel
    activeSegment.append(batch);
    
    // Update sparse index if interval reached
    if (positionInSegment - lastIndexPosition >= indexInterval) {
        activeSegment.indexFile.append(relativeOffset, positionInSegment);
        activeSegment.timeIndexFile.append(maxTimestamp, relativeOffset);
        lastIndexPosition = positionInSegment;
    }
    
    nextOffset = baseOffset + batchSize;
}
```

The `FileChannel.write()` is a normal POSIX write — it goes into the **OS
page cache**, not directly to disk. The `write()` returns as soon as the
bytes are in cache; the kernel will flush to disk later, asynchronously,
on its own schedule.

This is the first surprising fact: **Kafka does not fsync on write.** By
default. Every modern Kafka cluster relies on replication, not fsync, for
durability. We will return to this.

### 6.5.3 Followers fetch and replicate

Concurrent with the leader's append, **follower replica fetcher threads**
on each follower broker are running their fetch loop:

```java
while (running) {
    FetchRequest req = new FetchRequest(myLEO);
    FetchResponse resp = leader.fetch(req);
    for (Batch batch in resp.batches) {
        localLog.append(batch);  // same Log.append, but on the follower
        myLEO = batch.lastOffset + 1;
    }
    leader.notifyOfMyLEO(myLEO);
}
```

This is the same `Log.append()` we just walked through, but on the
follower, with batches arriving from the leader's fetch response.

Once enough followers have appended a given offset, the leader's
`HighWatermarkCheckpointer` (a periodic broker thread) sees that all ISR
LEOs are ≥ the offset, advances the partition's HWM, and updates the
`replication-offset-checkpoint` file. Producers waiting in the
**ProducePurgatory** for `acks=all` are now satisfied and their responses
are sent.

We will go deep on replication in Chapter 8. For now: the write happens to
the leader's page cache, the followers pull the bytes, the HWM advances,
the ack flows back.

### 6.5.4 Why no fsync?

Kafka deliberately does not call `fsync()` after each batch. Configuration
allows it (`flush.messages`, `flush.ms`), but the recommended setting is to
disable explicit flush and rely on:

1. **OS-level dirty page writeback** — the kernel will flush pages to
   disk eventually (typically within seconds, depending on
   `dirty_writeback_centisecs` and kin).
2. **Replication-based durability** — even if a single broker loses its
   page cache before flush (kernel panic, hard crash, power loss), the data
   is on (RF-1) other brokers. The lost broker rejoins via the ISR
   protocol and re-fetches whatever it missed.

The trade is: fsync per batch is *very* expensive — every fsync is a
synchronous round trip to disk hardware, often costing tens of
milliseconds, and Kafka writes thousands of batches per second. Skipping
fsync gives a 10-100× throughput improvement, and the cost is "if all RF
brokers crash simultaneously before their kernels flush, you can lose a
few hundred ms of writes."

For most workloads, this is the right trade. For workloads where it isn't
— banking, regulatory — there are knobs to dial up:

```properties
flush.messages=1                     # fsync every message (expensive!)
flush.ms=1000                        # fsync at most every 1s
```

But: **even with fsync, the durability promise is the same** — if RF-1
brokers fail simultaneously, you can lose data. fsync just changes the
window from "until kernel flush" to "until next fsync". In practice, with
RF=3 and rack-awareness, the simultaneous-failure scenario is so rare that
fsync's cost outweighs its benefit for almost all use cases.

This is a controversial position when said aloud. The empirical evidence
of Kafka's deployment over fifteen years supports it.

---

## 6.6 Reads: page cache, sendfile, zero copy

The read path is even simpler than the write path, and where Kafka's
performance reputation is mostly earned.

### 6.6.1 The fetch request

A consumer (or follower) sends a `FetchRequest` with:

- `(topic, partition, fetchOffset, maxBytes)` for each partition desired.
- A `minBytes` and `maxWaitMs` — broker will hold the request until it has
  `minBytes` available *or* `maxWaitMs` elapses. (Long-poll semantics.)

### 6.6.2 The broker's response

For each requested partition, the broker:

1. Looks up the segment containing `fetchOffset` (skip-list lookup).
2. Looks up `fetchOffset` in the segment's `.index` (mmap'd, fast).
3. Computes a byte range: `[startPosition, startPosition + maxBytes]`.
4. Issues `FileChannel.transferTo(socketChannel, startPosition, maxBytes)` —
   the JVM's wrapper around Linux `sendfile(2)`.

`sendfile` is the magic. It instructs the kernel:

> Copy bytes from this file descriptor (the .log file) starting at this
> offset, for this many bytes, to this socket descriptor.

The kernel does this **without ever copying the bytes through user-space**.
The data flows:

```
disk → page cache → NIC buffer → wire
```

Compare to a naive `read()`/`write()` loop:

```
disk → page cache → user buffer → kernel send buffer → NIC buffer → wire
                    (copy 1)        (copy 2)
```

`sendfile` saves two copies and two context switches per read. At 100 MB/s
fetch rate, that is a real number of saved CPU cycles.

### 6.6.3 The page cache as Kafka's only cache

Kafka has no internal record cache. None. There is no LRU of recently-read
records, no in-memory hot store. *The OS page cache is the cache.*

This is more elegant than it first looks:

- The kernel manages the cache. It is shared among all readers (consumers
  and follower fetchers) on the broker.
- When a consumer reads recently-written data, it almost always hits the
  page cache: the data was written to the page cache moments ago and
  hasn't been evicted yet. Disk I/O is unnecessary.
- When a consumer reads old data (long catch-up), the kernel reads from
  disk, populates the page cache, and the data is now warm for any other
  consumers. The next consumer wanting the same range gets it from cache.
- Eviction is LRU at the page level. In a healthy broker, the active
  segments are nearly always cached; old segments are cold but reads of
  them populate cache for follow-up reads.

The implication: **broker memory should be sized for the page cache**,
not for the JVM heap. A common production layout is 64 GB of RAM with 6 GB
of JVM heap and 50+ GB of page cache. The JVM doesn't need much; the page
cache wants everything.

This is why `swappiness=0` or `1` is the recommended tuning on Kafka
brokers — you don't want the kernel swapping JVM pages out under page-cache
pressure, because the page cache is *more* valuable than the JVM heap on a
broker.

### 6.6.4 Zero-copy and TLS — the ugly truth

`sendfile` works only when the bytes leaving the page cache are sent
*as-is* to the wire. If you have **TLS enabled**, the bytes need to be
encrypted before sending, which requires user-space processing, which
breaks the zero-copy path.

This is, unfortunately, one of the most underdiscussed costs of TLS on
Kafka. Enabling TLS can cost you 30-50% of throughput on a broker that
was previously bottlenecked on `sendfile`. There are mitigations:

- Linux 4.13+ has **kernel TLS (kTLS)**. The kernel does the encryption,
  preserving the zero-copy path. Java added support for this in JEP 246
  (rejected) and again later; as of recent Java versions, `OpenSSL`-based
  providers can use kTLS, but the standard JDK SSL provider does not.
- Some operators run TLS at a sidecar (e.g., `stunnel`) so the broker
  serves cleartext locally. This works but adds operational complexity.
- Some operators just accept the throughput cost.

Chapter 18 (Security) goes deeper. The summary: TLS is necessary in any
serious deployment, and its cost is real.

---

## 6.7 Segment lifecycle

A segment moves through stages: **active**, **closed**, **eligible for
retention**, **deleted**. Plus the parallel track of **eligible for
compaction**.

### 6.7.1 Active segment

Each partition has exactly one active segment, the one currently being
written to. Index files for the active segment are still being appended.
No retention or compaction can touch the active segment.

### 6.7.2 Roll trigger

A segment is rolled (the active segment closed, a new one opened) when any
of:

1. **`log.segment.bytes`** — the active `.log` file has reached
   1 GB (default).
2. **`log.roll.ms` / `log.roll.hours`** — the active segment is older
   than 7 days (default).
3. **`.index` is full** — index file has reached
   `log.index.size.max.bytes` (default 10 MB).
4. **The producer's `maxTimestamp - segment's earliest timestamp` exceeds
   `log.roll.ms`**. Catches the case where the segment-creation timestamp
   is fine but the segment contains records spanning a long time range.

On roll: the broker opens the new segment file (with the next offset as
filename), starts appending there, marks the old segment closed. Closed
segment is now read-only.

### 6.7.3 Retention

A periodic broker thread (`LogManager.cleanupLogs`) iterates all closed
segments and decides whether to delete them. Two policies, set per-topic
via `cleanup.policy`:

**`delete`** (default): segments are deleted when they exceed the
retention bound:

- **Time-based**: segment's max timestamp is older than `log.retention.ms`
  (default 7 days, 168 hours).
- **Size-based**: the partition's total size exceeds `log.retention.bytes`
  (default unlimited; common production settings: 500GB to several TB).
- **Either** — if both are set, whichever fires first.

**`compact`**: segments are not time-deleted; instead, the **log cleaner**
periodically rewrites segments to retain only the latest record per key.
We dedicate Chapter 12 to this.

**`delete,compact`**: both. Compact during retention; delete only old
records that have been superseded.

### 6.7.4 Deletion mechanics

When a segment is deleted, the broker doesn't immediately `rm` the files.
It first **renames** them with a `.deleted` suffix:

```
00000000000000123456.log → 00000000000000123456.log.deleted
```

After a delay (`file.delete.delay.ms`, default 60 seconds), they are
unlinked. This delay gives in-flight readers (consumers, follower fetchers)
that have the file open via `FileChannel` time to finish — the `unlink`
won't actually remove the file until the last `FileChannel` is closed,
but explicit delay simplifies reasoning.

### 6.7.5 Log start offset

After deletion, the partition's **log start offset** advances to the base
offset of the oldest remaining segment. This is the lowest offset still
readable. A consumer attempting to read an offset below the log start
offset gets an `OFFSET_OUT_OF_RANGE` error and must reset (typically to
`earliest` to start from the new log start).

Log start offset is checkpointed in the `log-start-offset-checkpoint` file,
which is periodically (`log.log-start-offset-checkpoint.interval.ms`)
flushed.

---

## 6.8 Recovery on broker restart

A clean shutdown of a broker is a coordinated affair: the broker stops
accepting traffic, flushes all logs (final fsync), writes the
`recovery-point-offset-checkpoint`, and exits. On restart, the broker
reads the recovery point and *trusts* that the log is good up to that
offset — no scanning needed.

A *crash* shutdown is different. The recovery point may not have been
written; the page cache may have had unflushed pages; the active segment
may have a torn write at the end (a partial batch from a write interrupted
mid-flight).

On startup with `cleanShutdownFile` not present, the broker enters
**recovery mode** for each partition:

1. Find the segment that contained the recovery offset.
2. Validate every batch from there to end of segment — checksum, valid
   offsets, valid framing. The first batch that fails validation marks
   the **truncation point**. Every byte after it is discarded.
3. For active segments only: this also rebuilds the `.index` and
   `.timeindex` to match the truncated `.log`.
4. The leader-epoch-checkpoint is replayed to rebuild the in-memory
   `LeaderEpochCache`, used for follower truncation logic (Chapter 8).

Recovery is the slow part of broker restart, and on a busy broker with
hundreds of partitions, can take minutes. The `numRecoveryThreadsPerDataDir`
config (default 1) controls parallelism; raising it speeds restart on
multi-disk brokers significantly.

In the wild, you will sometimes see brokers stuck for tens of minutes on
"loading log segments" during cold start. Almost always the issue is too
many partitions per disk and `numRecoveryThreadsPerDataDir=1`. Double or
quadruple it.

---

## 6.9 Multiple log directories and JBOD

A broker can have multiple `log.dirs`. Each disk gets one. The partitions
are distributed across them by a placement strategy:

- **Until KIP-963 (Kafka 3.7+):** simple round-robin per partition. No
  awareness of disk fullness.
- **KIP-963 (3.7+):** partitions placed by free space, attempting to keep
  disks balanced.

If a single disk fails on a multi-disk broker:

- **Pre-KIP-112 (Kafka 0.10):** the broker would crash entirely. Lost one
  disk → lost the whole broker. Painful.
- **KIP-112 (Kafka 1.0+):** the broker continues running with the
  surviving disks; the partitions on the failed disk are marked offline
  and re-replicate from elsewhere.

This **JBOD** (Just a Bunch Of Disks) mode is preferred to RAID for
production Kafka. Reasons:

- Kafka's replication is the durability mechanism. RAID-5/6 add write
  amplification with minimal benefit (you already have RF=3 elsewhere).
- RAID-0 (stripe) has worse failure semantics — losing one disk loses all
  partitions on the broker. With JBOD, only the partitions on the bad disk
  are affected.
- JBOD scales linearly with disks; RAID often bottlenecks on the controller.

The downside is that JBOD requires manual rebalancing after disk
replacement. KIP-963 helped; tools like Cruise Control have helped further;
nothing is fully automatic.

---

## 6.10 Tiered storage (preview)

Kafka 3.6+ supports **tiered storage** (KIP-405): old segments can be
offloaded to S3 or HDFS, with only the hot tail kept on local disk. This
changes the storage story significantly:

- Local disk holds, say, the last 24 hours.
- Old segments are uploaded to S3 with their indexes.
- A consumer reading old data fetches from S3 transparently (the broker
  does the proxying).
- Retention can now be effectively unlimited — S3 storage is two orders of
  magnitude cheaper than SSD per byte.

We dedicate Chapter 13 to tiered storage. The relevant point for *this*
chapter is: the on-disk layout described above is what you see for the hot
tier; the cold tier has its own layout in object storage. Recovery,
replication, and the page cache discussions all apply to the hot tier
only.

---

## 6.11 Configurations that matter

```properties
# Layout
log.dirs=/data/kafka1,/data/kafka2     # multiple disks (JBOD)
num.recovery.threads.per.data.dir=4    # parallel recovery on cold start

# Segments
log.segment.bytes=1073741824           # 1 GB; rarely tuned
log.roll.hours=168                     # 7 days; rarely tuned
log.index.interval.bytes=4096          # never tuned
log.index.size.max.bytes=10485760      # 10 MB; never tuned

# Retention
log.retention.hours=168                # 7 days global default
log.retention.bytes=-1                 # unlimited; usually overridden per-topic
log.retention.check.interval.ms=300000 # how often to scan for deletion candidates

# Flushing — usually leave alone
log.flush.interval.messages=Long.MAX
log.flush.interval.ms=null
log.flush.scheduler.interval.ms=Long.MAX

# Recovery
log.recovery.threads.per.data.dir=4

# Cleaner (compaction)
log.cleaner.enable=true
log.cleaner.threads=1                  # raise on compaction-heavy clusters

# Per-topic overrides via topic configs (preferred to global):
# retention.ms, retention.bytes, segment.bytes, segment.ms,
# cleanup.policy, compression.type, min.insync.replicas
```

Per-topic overrides are how you express "log topic A has 24-hour retention,
log topic B has 30-day retention" without needing different brokers. Set
them via:

```bash
kafka-configs.sh --alter --entity-type topics --entity-name topic-A \
  --add-config retention.ms=86400000
```

---

## Summary box

- A partition is a **directory** of segment files on a broker.
- Each segment is `(.log, .index, .timeindex, .snapshot, [.txnindex])`,
  named by base offset.
- Writes are **append-only** to the active segment; sparse `.index` is
  built every 4 KB; **no fsync** by default — replication is the
  durability mechanism.
- Reads use mmap on the index for fast lookup, then `sendfile()` for
  zero-copy disk-to-network transfer. **The OS page cache is the cache.**
- TLS breaks `sendfile` — kTLS is the only way to keep zero-copy with
  encryption.
- Segments roll on size, time, or index-full; closed segments are deletable
  by retention or rewritable by compaction.
- Recovery on cold start scans active segments for torn writes, rebuilds
  indexes, replays leader-epoch history.
- JBOD is preferred over RAID for multi-disk brokers; KIP-112 makes single
  disk failures survivable.

## Further reading

- KIP-101: Alter Replication Protocol to use Leader Epoch rather than
  HWM. Background for the recovery and replication interactions.
- KIP-405: Kafka Tiered Storage.
- KIP-630: Kafka Raft Snapshot. Why metadata snapshots matter, similar
  ideas.
- *Linux Kernel Development* by Robert Love, chapter 16 (Page Cache and
  Page Writeback). For the substrate Kafka assumes.
- The Kafka source: `core/src/main/scala/kafka/log/Log.scala` (older
  Scala) or the newer `LocalLog.java`. Surprisingly readable.

## War story: the broker that "wasn't doing anything"

A team called me about a broker whose `requestHandler` idle-percent was
sitting at 95% — meaning the broker was almost entirely idle by
self-report. And yet, producers were timing out, consumers were lagged.
From every Kafka-level metric, the broker had nothing to do. From every
client perspective, it was unresponsive.

`vmstat 1` told the story: `wa` (I/O wait) was at 60%. The broker's
threads were idle because they were *all blocked on disk I/O*. The
RequestHandler idle metric measures CPU idleness — it has no view of I/O
wait. The CPU was indeed idle; the disks were on fire.

Why? `iotop`: a parallel `aws s3 cp` was copying old log segments to
backup, monopolising the disk's IOPS budget. The kernel's I/O scheduler
was queuing Kafka's writes behind the backup process's reads.

Fix: throttle the backup with `ionice` and `nice`. Cluster recovered in
minutes.

Lessons:

- The four-layer model (Chapter 3) saves your life. Layer 1, the
  substrate, was where the problem lived; Layer 2 had no visibility.
- Don't share Kafka brokers' disks with other heavy I/O. They will lose.
- Watch `iowait` and `await` from `iostat -x` on every broker host. If
  iowait is high and Kafka throughput is low, you have an I/O contention
  problem before you have a Kafka problem.

The page cache and the disk are Kafka's true commodities. Treat them with
the respect a database treats its buffer pool — even though you cannot,
in Kafka's model, manage them directly. They are managed by the kernel,
and the kernel does not know your SLO. *You* do.
