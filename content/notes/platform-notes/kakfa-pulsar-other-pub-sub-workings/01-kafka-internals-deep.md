# Kafka Internals — Deep Technical Reference

> Target: Senior Java/JVM engineer, 40 LPA system design interviews.
> Every section is interview-dense. No fluff.

---

## 1. Log Segment Anatomy: .log / .index / .timeindex

Each Kafka topic-partition is stored as an **ordered list of segments** on disk.

```
/data/kafka/my-topic-0/
  00000000000000000000.log          ← actual message data
  00000000000000000000.index        ← sparse offset → file-position index
  00000000000000000000.timeindex    ← sparse timestamp → relative-offset index
  00000000000000012345.log
  00000000000000012345.index
  00000000000000012345.timeindex
  00000000000000012345.snapshot     ← producer epoch snapshots (EOS)
  leader-epoch-checkpoint           ← leader epoch history
```

The filename **prefix** is the base offset of the first message in that segment.

### 1.1 .log File — Record Batch Wire Format

The unit of storage is the **RecordBatch** (not individual records). Wire format (v2+):

```
RecordBatch {
  baseOffset          : int64     (8 bytes)
  batchLength         : int32     (4 bytes) — bytes from magic onward
  partitionLeaderEpoch: int32     (4 bytes)
  magic               : int8      (1 byte)  — currently 2
  crc                 : uint32    (4 bytes) — CRC32C of everything after
  attributes          : int16     (2 bytes) — compression, timestamp type, txn, control
  lastOffsetDelta     : int32     (4 bytes)
  baseTimestamp       : int64     (8 bytes)
  maxTimestamp        : int64     (8 bytes)
  producerId          : int64     (8 bytes) — EOS idempotency
  producerEpoch       : int16     (2 bytes)
  baseSequence        : int32     (4 bytes)
  records             : ARRAY<Record>
}

Record {
  length              : varint
  attributes          : int8
  timestampDelta      : varint
  offsetDelta         : varint
  keyLength           : varint
  key                 : bytes
  valueLength         : varint
  value               : bytes
  headers             : ARRAY<Header>
}
```

Key points:
- **Compression** is applied at the RecordBatch level, not per-record. LZ4 and Zstandard give the best Kafka throughput/ratio tradeoff.
- `partitionLeaderEpoch` is written by the leader; used during recovery to detect and fence stale data.
- The `.log` file is **append-only**; it is never modified in place (except truncation during recovery).

### 1.2 .index File — Sparse Offset Index

```
Entry (8 bytes per entry):
  relativeOffset : int32    (offset - baseOffset of segment)
  position       : int32    (byte position in .log file)
```

- **Sparse**: one entry every `log.index.interval.bytes` (default 4096 bytes) of appended data.
- On lookup: binary search gives the entry with the largest relativeOffset ≤ target. Then linear scan of `.log` from that position.
- Max size: `log.index.size.max.bytes` (default 10 MB = 1.3M entries). When full, a new segment is rolled.

### 1.3 .timeindex File — Timestamp Index

```
Entry (12 bytes per entry):
  timestamp      : int64    (8 bytes) — epoch millis
  relativeOffset : int32    (4 bytes) — maps into .index for file position
```

- Used for **time-based log retention** (`log.retention.ms`) and `offsetsForTimes()` consumer API.
- 12 bytes/entry vs 8 bytes/entry means it fills faster than `.index`, can trigger segment rolling independently.

### 1.4 Segment Rolling Triggers

A new segment is opened when any of these are exceeded:
1. `log.segment.bytes` (default 1 GB) — size of `.log` file
2. `log.roll.ms` / `log.roll.hours` (default 7 days) — age
3. `.index` or `.timeindex` file full

---

## 2. Broker Storage: Sparse Index Binary Search

```
Consumer asks: "Give me offset 723"

1. Find the segment with baseOffset <= 723:
   - Active segment list is in memory (LogSegment objects)
   - Binary search on segment base offsets → segment with base 512

2. In 00000000000000000512.index, binary search for relativeOffset = (723-512) = 211
   - Found: relativeOffset=200 → position=81920

3. Sequential scan of .log from byte 81920 until offset 723 found
   (at most log.index.interval.bytes = 4096 bytes to scan)
```

**Why sparse?** Full dense index would be as large as the log itself. Sparse keeps it tiny (fits in OS page cache).

---

## 3. Replication Protocol: ISR, HWM, LEO, Leader Epoch

### 3.1 Definitions

| Term | Meaning |
|------|---------|
| **LEO** (Log End Offset) | Next offset to be written on a replica |
| **HWM** (High Watermark) | Highest offset committed (replicated to all ISR members) |
| **ISR** (In-Sync Replicas) | Set of replicas whose LEO is within `replica.lag.time.max.ms` of the leader |
| **Leader Epoch** | Monotonically increasing int, incremented every time a new leader is elected |

### 3.2 Replication Flow

```
Producer → Leader (append to log, LEO advances)
         ↓
Follower FetchRequest (fetchOffset = own LEO)
         ↓
Leader responds with records + current HWM
         ↓
Follower appends, updates its LEO, caches HWM
         ↓
Leader: when all ISR LEOs >= new message offset → HWM advances
         ↓
Leader ACKs producer (acks=all waits for HWM advance)
```

### 3.3 High Watermark Propagation — The Subtle Bug (pre-KIP-101)

Old behavior: follower learned about HWM only in the NEXT fetch response. If leader crashed after advancing HWM but before follower's next fetch:
- Follower becomes leader with HWM behind actual committed offset
- Could expose uncommitted data or cause unnecessary truncation

**KIP-101 fix (Leader Epoch):** Each replica tracks the `(leaderEpoch, startOffset)` pair. On becoming leader, a replica first fetches the `endOffset` of the previous leader epoch from the new leader (via `OffsetsForLeaderEpoch` RPC). It then truncates its log to that offset — no more reliance on potentially stale HWM.

```
Leader Epoch Sequence:
  Epoch 0: offsets 0-99   (broker A was leader)
  Epoch 1: offsets 100-199 (broker B elected, wrote offsets 100-199)
  Epoch 2: offsets 200+   (broker A re-elected)

On B's recovery:
  B asks A: "What was the end offset of epoch 1?"
  A says: 200
  B's log has offsets to 210 (some unacknowledged writes)
  B truncates to 200 → safe
```

### 3.4 Unclean Leader Election — Data Loss Mechanism

- If `unclean.leader.election.enable=true` (default false in modern Kafka):
  - A broker NOT in ISR can be elected leader
  - Any messages between old leader's HWM and out-of-sync replica's LEO are **permanently lost**
  - Committed messages that consumers already read disappear
- **Never enable** in production unless availability > durability is an explicit requirement (e.g., metrics pipelines where a few dropped points are tolerable)

### 3.5 ISR Shrinking

A follower is removed from ISR if:
- It hasn't sent a fetch request within `replica.lag.time.max.ms` (default 30s)
- A lagging replica (LEO too far behind)

ISR membership is tracked in ZooKeeper (pre-KRaft) / `__cluster_metadata` topic (KRaft). The controller pushes ISR updates to leaders via `LeaderAndIsrRequest`.

---

## 4. Producer: Batching Internals

### 4.1 RecordAccumulator

The Java producer's `RecordAccumulator` is a `ConcurrentMap<TopicPartition, Deque<ProducerBatch>>`.

```
send(record)
  ↓
Serialize + determine partition
  ↓
RecordAccumulator.append()
  - If current ProducerBatch for partition has space → append
  - Else → allocate new ProducerBatch from BufferPool
          (BufferPool is a pool of ByteBuffers — off-heap if using direct memory)
  ↓
Sender thread (background I/O thread)
  - Polls accumulator for "ready" batches
  - Batch is ready when:
      a) batch.size filled (default 16KB)
      b) linger.ms elapsed (default 0ms — disabled)
      c) BufferPool exhausted (back pressure)
      d) Producer flush() called
  ↓
NetworkClient sends ProduceRequest per broker (multiple partitions batched per request)
```

### 4.2 BufferPool and Off-Heap Memory

`BufferPool` uses `ByteBuffer.allocateDirect()` — direct (off-heap) memory. `buffer.memory` (default 32 MB) is the total pool size. When exhausted, `send()` blocks for `max.block.ms` then throws `TimeoutException`. This is Kafka's **back-pressure mechanism** on the producer side.

### 4.3 Compression

Applied per RecordBatch. Compression codecs:
- `none` — no compression (baseline)
- `gzip` — good ratio, slow (pure JVM)
- `snappy` — moderate ratio, fast (JNI via xerial)
- `lz4` — fast decompression, good throughput (preferred for consumers)
- `zstd` — best ratio, configurable speed, modern choice (Kafka 2.1+)

Compression is done in the Sender thread (not the application thread).

### 4.4 Sticky Partitioner (Kafka 2.4+)

Old RoundRobinPartitioner: distributed records across all partitions evenly but created many tiny batches (bad for batching when no key is set).

StickyPartitioner logic:
1. Choose a partition and **stick to it** until the current batch is sent or `linger.ms` fires
2. Switch to a new random partition for the next batch
3. Result: batches fill up to `batch.size` → compression ratio improves dramatically

**KIP-794** (Kafka 3.3+): Strictly Uniform Sticky Partitioner ensures partition distribution is uniform over time (previous version had bias toward lower-numbered partitions).

---

## 5. Consumer: Fetch Protocol

### 5.1 FetchRequest Internals

```java
// Consumer poll() loop internals:
// 1. ConsumerNetworkClient sends FetchRequest to partition leaders
// 2. FetchRequest parameters:
//    - maxWaitMs     = fetch.max.wait.ms (default 500ms)
//    - minBytes      = fetch.min.bytes   (default 1 byte)
//    - maxBytes      = fetch.max.bytes   (default 50MB)
//    - partitionData = [(topicPartition, fetchOffset, maxPartitionBytes)]

// Broker response:
// - Waits until minBytes of data available OR maxWaitMs expires
// - Returns RecordBatch data (still compressed, as-is from .log)
//   → Zero-copy via sendfile() on Linux
```

**fetch.min.bytes** is the most important throughput knob: set to 1MB+ for batch consumers to reduce broker-side calls.

**fetch.max.wait.ms**: The broker holds the fetch request open (long poll) until `minBytes` is available. Reduces empty responses without adding artificial latency (unlike linger.ms on producer side).

### 5.2 Partition Assignment — Assignors

| Assignor | Strategy | Sticky? | Cooperative? |
|----------|----------|---------|--------------|
| `RangeAssignor` | Sorted partitions / sorted consumers, first consumer gets extra if uneven | No | No |
| `RoundRobinAssignor` | Partitions distributed round-robin | No | No |
| `StickyAssignor` | Minimize movements; keep previous assignments | Yes | No (eager) |
| `CooperativeStickyAssignor` | Same as Sticky but two-phase rebalance | Yes | Yes |

**Default since Kafka 3.0**: `RangeAssignor` (legacy) or `CooperativeStickyAssignor` (recommended).

### 5.3 Eager vs Cooperative Rebalancing

```
EAGER REBALANCING (old, stop-the-world):
  1. All consumers receive RevokPartitions → stop processing ALL partitions
  2. All send JoinGroup to coordinator
  3. Leader sends SyncGroup with new assignment
  4. All consumers resume with new partitions
  → Full stop-the-world for entire group, even for consumers whose partitions didn't change

COOPERATIVE REBALANCING (two-phase, incremental):
  Phase 1 — Find partitions to revoke:
    1. JoinGroup request (no partition revocation yet)
    2. Coordinator identifies which partitions need to move
    3. Only affected consumers revoke their targeted partitions
    4. SyncGroup assigns new partitions

  Phase 2 — Reassign revoked partitions:
    1. Another JoinGroup round for the revoked partitions only
    2. Assign to new consumers
  → Non-moving partitions NEVER stop processing
  → Up to 20x faster rebalance in large groups
```

### 5.4 Static Group Membership

`group.instance.id` (KIP-345): Consumer declares a static identity. On restart, it rejoins with same ID and gets same partitions back — **no rebalance triggered** as long as it rejoins within `session.timeout.ms`. Essential for Kafka Streams applications with large local state stores (avoids state migration).

---

## 6. Consumer Group Coordinator

### 6.1 Group Coordinator Selection

```
coordinatorBroker = hash(groupId) % __consumer_offsets.partition_count
```
Default: 50 partitions in `__consumer_offsets`. The broker hosting the leader replica of the matching partition becomes the Group Coordinator for that consumer group.

### 6.2 Heartbeat vs Poll — The Two-Timeout Confusion

| Config | Default | What it detects | Thread |
|--------|---------|-----------------|--------|
| `heartbeat.interval.ms` | 3000ms | Nothing directly — sets heartbeat frequency | Dedicated heartbeat thread |
| `session.timeout.ms` | 45000ms | Broker detects dead consumer (no heartbeat received) | Broker-side timer |
| `max.poll.interval.ms` | 300000ms | Application stuck (poll() not called) | Client-side timer |

**Critical distinction:**
- `session.timeout.ms`: heartbeat thread is alive and sending, but consumer PROCESS is dead → detected by broker
- `max.poll.interval.ms`: consumer process is alive (heartbeat running) but application code is STUCK in processing loop → detected client-side. When exceeded, consumer calls `leaveGroup()` itself, triggering rebalance.

**Common pitfall**: You have slow message processing. Heartbeats keep going (consumer looks alive). But `max.poll.interval.ms` (default 5 min) is exceeded. Consumer voluntarily leaves group → rebalance. If you have heavy processing, increase `max.poll.interval.ms` OR process in a separate thread and call `pause()/resume()` on partitions.

### 6.3 __consumer_offsets Topic

- 50 partitions, compacted topic
- Key: `(groupId, topic, partition)` — serialized as bytes
- Value: `OffsetAndMetadata { offset, leaderEpoch, metadata, commitTimestamp, expireTimestamp }`
- On `commitSync()` / `commitAsync()`: consumer sends `OffsetCommitRequest` to the Group Coordinator (not to any broker — must go to coordinator specifically)
- Coordinator writes to `__consumer_offsets` partition it owns
- **Retention**: default 7 days after the consumer group goes inactive (via `offsets.retention.minutes`)

---

## 7. Exactly-Once Semantics (EOS)

### 7.1 Idempotent Producer (enable.idempotence=true)

**PID (Producer ID)**: Assigned by the broker cluster when producer initializes. Unique per producer instance (not persistent across restarts unless transactional).

**Sequence Numbers**: Per `(PID, TopicPartition)`, starting at 0. Monotonically increasing.

```
Producer → Broker: {PID=42, epoch=0, seq=5, data=...}
Broker logic:
  - Expected seq for (PID=42, tp=topic-0) = 5? → Accept, write to log
  - seq=5 again (retry after timeout)? → Duplicate, ACK without writing
  - seq=7 (skipped 6)? → OutOfOrderSequenceException → producer fatal error
```

Broker keeps **last 5 sequence numbers per (PID, partition)** in memory (configurable). On broker restart, loaded from log via `producerSnapshotId` files (`.snapshot`).

**Guarantees**: exactly-once per-partition. Does NOT prevent duplicates across restarts (PID changes on restart) unless using transactions.

### 7.2 Transactional Producer — 2PC Under the Hood

```java
producer.initTransactions();   // registers transactionalId with TransactionCoordinator
producer.beginTransaction();
producer.send(record1);
producer.send(record2);
producer.sendOffsetsToTransaction(offsets, consumerGroupMetadata); // for consume-transform-produce
producer.commitTransaction();  // or abortTransaction()
```

**Transaction Coordinator**: A broker designated by hashing `transactionalId` against `__transaction_state` topic (default 50 partitions). Persists transaction state there.

#### Two-Phase Commit Protocol:

```
Phase 1 — Prepare:
  1. Producer calls commitTransaction()
  2. Producer sends EndTxnRequest(COMMIT) to TransactionCoordinator
  3. Coordinator writes PREPARE_COMMIT to __transaction_state
  4. Coordinator sends WriteTxnMarkersRequest to all partition leaders
     that received data in this transaction
  5. Each partition leader writes a COMMIT control batch (marker) to its log

Phase 2 — Complete:
  6. Once all markers written, Coordinator writes COMPLETE_COMMIT to __transaction_state
  7. Coordinator responds to producer: transaction done

Control batch (commit/abort marker) in .log:
  RecordBatch {
    attributes: isControl=true, isTransactional=true
    records: [ControlRecord { type=COMMIT }]
  }
```

**Recovery scenario**: If coordinator crashes between steps 3 and 6, on restart it reads `__transaction_state`, sees `PREPARE_COMMIT`, resends `WriteTxnMarkersRequest`. Idempotent.

### 7.3 Consumer: read_committed Isolation

```java
consumer = new KafkaConsumer<>(props);
props.put("isolation.level", "read_committed");  // default: read_uncommitted
```

With `read_committed`:
- Consumer fetches up to the **Last Stable Offset (LSO)**, not HWM
- LSO = HWM - (size of any open/uncommitted transactions in front)
- Messages from **aborted** transactions are silently filtered client-side using control batches in the log
- **Consequence**: open transactions block ALL consumer progress on that partition → keep transactions short

```
LSO < HWM when there are open transactions:

Offset:  0  1  2  3  4  5  6  7  8
         ↑                          ↑
         committed  [txn A open]    HWM

LSO = 3  (consumer sees only 0-3)
```

---

## 8. Log Compaction

### 8.1 Compaction Mechanics

```
Partition log (compaction-enabled topic):
  Head (active segment): new writes, always retained
  Tail (older segments): subject to compaction

Cleaner thread:
  1. Scans tail segments, builds an in-memory OffsetMap: {key → latestOffset}
     (bounded by cleaner.dedupe.buffer.size, default 128MB)
  2. Writes a new "clean" log: for each record, keep only if
     record.offset == offsetMap[record.key]
  3. Swaps segments atomically via file rename
  4. Scheduler picks the "dirtiest" topic first (dirty = bytes in head / total bytes)
     Threshold: min.cleanable.dirty.ratio (default 0.5)
```

### 8.2 Tombstones

- Record with **null value** = tombstone (delete marker)
- Tombstone is retained through the first cleaning pass (consumers must see it)
- After `delete.retention.ms` (default 24h) from when tombstone was written, it is deleted in the next compaction pass
- **Two-pass requirement**: tombstone must survive at least one cleaning before removal (prevents race where a new consumer starting after the tombstone is deleted would see a phantom key)

### 8.3 Compaction and EOS

Compaction preserves control batches (commit/abort markers) for the `log.message.timestamp.difference.max.ms` window so that consumers with open transactions can still see them.

---

## 9. Controller: ZooKeeper Era vs KRaft

### 9.1 ZooKeeper Era (pre-3.0 default)

One broker is elected "controller" via ZooKeeper ephemeral node `/controller`. The controller:
- Tracks broker liveness (ZK watches on `/brokers/ids/<id>`)
- Maintains partition leadership via ISR changes (read/write ZK znodes)
- Sends `LeaderAndIsrRequest` and `UpdateMetadataRequest` to all brokers
- Handles `ControlledShutdown` requests

**Scalability bottleneck**: On startup or failover, controller reads ALL partition metadata from ZooKeeper — O(partitions) ZK reads. At 200,000 partitions, controller failover took 30-60 seconds.

### 9.2 KRaft Mode (Kafka 3.3+ production, 4.0 ZK-free)

```
KRaft Architecture:
  ┌─────────────────────────────────────────┐
  │           Controller Quorum             │
  │  [Controller-1] [Controller-2] [Controller-3]  │
  │        ↑         ↑         ↑             │
  │     Raft Leader          Raft Followers  │
  └─────────────────────────────────────────┘
            │
            │ Fetch metadata records
            ▼
  ┌─────────────────────┐
  │    Broker Nodes     │
  │ (can also be voters)│
  └─────────────────────┘
```

- Metadata stored in **`__cluster_metadata`** internal topic (single partition, replicated across controller quorum)
- KRaft uses an **event-sourced model**: each metadata change is an append to the metadata log
- **Active controller** = Raft leader. Processes all metadata mutations.
- Brokers fetch from `__cluster_metadata` continuously → eventual consistency for metadata (sub-millisecond in practice)
- Controller failover: new leader already has full in-memory state (it was following the log) → failover in milliseconds, not seconds
- Supports **1M+ partitions** per cluster (LinkedIn tested)

**KIP-853** (Kafka 3.7+): Dynamic controller quorum membership — add/remove controller nodes without full restart.

---

## 10. Why Kafka Is Fast — Page Cache & Zero-Copy

### 10.1 Sequential I/O

- Kafka's `.log` files are append-only → disk writes are sequential
- Modern SSDs: sequential write ~500 MB/s, random write ~100 MB/s
- Modern HDDs: sequential write ~200 MB/s, random write ~1 MB/s
- Linear read of `.log` during consumption is sequential too

### 10.2 OS Page Cache Exploitation

```
Without page cache (typical JVM broker):
  disk → kernel buffer → user-space JVM heap (copy 1)
  JVM heap → network buffer (copy 2)
  + GC overhead on all those byte[]

Kafka's approach:
  disk → OS page cache (copy 1, done by OS on first read)
  On subsequent reads of same data: served directly from RAM
  Kafka process barely touches the data
```

Kafka deliberately keeps its heap SMALL (4-8 GB) and lets the OS use remaining RAM for page cache. A 32 GB machine with 6 GB heap leaves 26 GB for page cache — effectively 26 GB of in-memory message store.

### 10.3 Zero-Copy via sendfile()

When a consumer fetches data that is already in the page cache:

```
Traditional copy path (4 copies):
  page cache → kernel buffer (DMA copy)
  kernel buffer → user buffer (CPU copy)
  user buffer → socket buffer (CPU copy)
  socket buffer → NIC (DMA copy)

sendfile() path (2 copies, 0 CPU copies for data):
  page cache → socket buffer (via kernel, DMA)
  socket buffer → NIC (DMA copy)
  Application CPU: 0 copies of data

Java API: FileChannel.transferTo() → maps to sendfile() on Linux
```

Kafka's `FileRecords.writeTo(TransportLayer)` uses `FileChannel.transferTo()`. This only works because:
1. The data is in its compressed, wire-format form on disk (no decompression/recompression)
2. All consumers of the same topic read the same bytes → same page cache pages are reused

**Zero-copy breaks when**:
- SSL/TLS is enabled (data must pass through user space for encryption) → falls back to 4-copy path
- Consumer uses `isolation.level=read_committed` with active transactions (data must be filtered)

---

## 11. JVM Tuning for Kafka Brokers

### 11.1 Heap Sizing Philosophy

Kafka stores NO message data in heap. Heap is used for:
- Connection metadata
- NetworkClient send/receive buffers (off-heap DirectByteBuffers — bounded by `socket.send.buffer.bytes`, `socket.receive.buffer.bytes`)
- RecordAccumulator (producer side, `buffer.memory` — off-heap)
- Log metadata objects (LogSegment, LogManager structures) — ON heap
- Fetch session caches

**Recommended**: `-Xms6G -Xmx6G` for most brokers. Match Xms=Xmx to prevent heap resize pauses.

### 11.2 G1GC (Java 11-20 default recommendation)

```bash
KAFKA_HEAP_OPTS="-Xms6G -Xmx6G"
KAFKA_JVM_PERFORMANCE_OPTS="
  -XX:+UseG1GC
  -XX:MaxGCPauseMillis=20
  -XX:InitiatingHeapOccupancyPercent=35
  -XX:+ExplicitGCInvokesConcurrent
  -XX:G1HeapRegionSize=16M
  -XX:MetaspaceSize=96M
  -XX:MinMetaspaceFreeRatio=50
  -XX:MaxMetaspaceFreeRatio=80
"
```

- `IHOP=35%`: Start concurrent GC cycle when heap is 35% full (prevents full GC)
- `G1HeapRegionSize=16M`: Larger regions → fewer regions to process → shorter GC
- `MaxGCPauseMillis=20`: Target; G1 is not guaranteed but tries

### 11.3 ZGC (Java 17+, recommended for high-throughput)

```bash
KAFKA_JVM_PERFORMANCE_OPTS="
  -XX:+UseZGC
  -XX:+ZGenerational    # Java 21+, generational ZGC (default in Java 23+)
  -XX:MaxGCPauseMillis=5
"
```

- ZGC: sub-millisecond GC pauses regardless of heap size (tested up to TB heaps)
- All GC work is concurrent — stop-the-world pauses ~0.1ms
- Netflix migrated to Generational ZGC in 2024 for Kafka brokers → eliminated GC-related producer timeouts

### 11.4 Off-Heap Usage in Kafka

| Component | Memory type | Config |
|-----------|-------------|--------|
| Socket send/recv buffers | Off-heap (OS) | `socket.send.buffer.bytes` |
| Producer RecordAccumulator | Off-heap DirectByteBuffer | `buffer.memory` |
| Fetch response assembly | Off-heap DirectByteBuffer | `replica.fetch.response.max.bytes` |
| Page cache (messages) | OS-managed, not JVM | Available RAM minus heap |

The JVM heap never holds actual message bytes in steady state. This is by design — it eliminates the largest source of GC pressure and lets the OS optimize caching aggressively.

---

## 12. Interview Fast-Fire Q&A

**Q: Why is Kafka fast?**
A: Three reasons: (1) Sequential I/O on append-only logs → disk throughput parity with sequential access. (2) OS page cache exploitation — avoids JVM heap allocation for messages, zero GC on data path. (3) Zero-copy `sendfile()` for consumer fetches — data moves from page cache to NIC without CPU involvement.

**Q: How does exactly-once work end-to-end?**
A: Idempotent producer (PID + sequence numbers) prevents duplicates within a session. Transactional API provides 2PC: coordinator writes PREPARE state, sends control records (commit/abort markers) to all partitions, then writes COMPLETE state. Consumer with `read_committed` reads only up to LSO (not HWM) and filters aborted transactions. Consume-transform-produce loop uses `sendOffsetsToTransaction()` to include offset commit in the transaction atomically.

**Q: What happens during a Kafka rebalance?**
A: Eager: all consumers stop, revoke all partitions, coordinator runs JoinGroup/SyncGroup, all resume. Cooperative: only partitions that must move are revoked (two JoinGroup rounds). The coordinator is the broker owning the `__consumer_offsets` partition for the group's hash.

**Q: Explain leader epoch and why it matters.**
A: Each leadership change increments the leader epoch. Written into every RecordBatch. On recovery, a replica fetches `OffsetsForLeaderEpoch` to find where the previous epoch ended, then truncates its log to that point. Prevents the "stale HWM" data loss bug where a recovering follower would expose uncommitted data.

**Q: What is LSO and how does it differ from HWM?**
A: HWM = highest offset fully replicated across ISR. LSO = HWM minus all open/uncommitted transactional data. `read_committed` consumers see up to LSO only. Open transactions block LSO advancement, causing consumer lag that isn't reflected in standard lag metrics (you need to monitor LSO lag separately).

**Q: Why can log compaction cause consumer issues?**
A: Compaction can delete records a consumer hasn't read yet if it's behind. If a consumer's committed offset points to a deleted record, on next fetch it gets `OffsetOutOfRange`, and must reset (typically to earliest or latest). Monitor `log.cleaner.min.compaction.lag.ms` to prevent compaction of recently written data.

---

Sources:
- [Kafka Storage Internals (Conduktor)](https://www.conduktor.io/blog/understanding-kafka-s-internal-storage-and-log-retention)
- [Deep dive into Apache Kafka storage internals (Strimzi)](https://strimzi.io/blog/2021/12/17/kafka-segment-retention/)
- [KIP-98 Exactly Once Delivery (Apache Kafka)](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging)
- [Kafka Transactions (Strimzi)](https://strimzi.io/blog/2023/05/03/kafka-transactions/)
- [Cooperative Rebalancing (Confluent)](https://www.confluent.io/blog/cooperative-rebalancing-in-kafka-streams-consumer-ksqldb/)
- [Sticky Partitioner (Confluent)](https://www.confluent.io/blog/apache-kafka-producer-improvements-sticky-partitioner/)
- [Zero-Copy Optimization (2minutestreaming)](https://blog.2minutestreaming.com/p/apache-kafka-zero-copy-operating-system-optimization)
- [JVM Tuning for Kafka Brokers (Conduktor)](https://www.conduktor.io/blog/kafka-jvm-tuning-g1gc-vs-zgc-production)
- [KRaft Overview (Confluent)](https://docs.confluent.io/platform/current/kafka-metadata/kraft.html)
- [Log Compaction (Confluent)](https://docs.confluent.io/kafka/design/log_compaction.html)
