# Apache Pulsar Internals — Deep Technical Reference

> Target: Senior Java/JVM engineer, 40 LPA system design interviews.
> Assumes Kafka familiarity — Pulsar explained in contrast where relevant.

---

## 1. Architecture: The Three-Layer Model

```
┌─────────────────────────────────────────────────────────────┐
│                    PULSAR CLIENTS                            │
│           (Java/Python/Go/C++ clients)                       │
└────────────────┬───────────────────┬────────────────────────┘
                 │ Produce/Consume    │
                 ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                  BROKER LAYER (Stateless)                    │
│                                                              │
│  Broker-1      Broker-2      Broker-3                       │
│  (owns topics  (owns topics  (owns topics                    │
│   by hash)      by hash)      by hash)                       │
│                                                              │
│  No local state — all state in BookKeeper + ZooKeeper        │
└──────────────┬──────────────────────────────────────────────┘
               │ Read/Write ledgers
               ▼
┌─────────────────────────────────────────────────────────────┐
│                  BOOKKEEPER LAYER (Storage)                  │
│                                                              │
│  Bookie-1     Bookie-2     Bookie-3     Bookie-4             │
│  (stores      (stores      (stores      (stores              │
│   ledger       ledger       ledger       ledger              │
│   fragments)   fragments)   fragments)   fragments)          │
│                                                              │
│  Local disk: journal + entrylog (append-only WAL)            │
└──────────────────────────────────────────────────────────────┘
               │ Metadata / coordination
               ▼
┌─────────────────────────────────────────────────────────────┐
│               ZOOKEEPER (Metadata & Coordination)            │
│                                                              │
│  - Broker ownership of topic bundles                         │
│  - Ledger metadata (which bookies hold which ledger)         │
│  - Cursor metadata (subscription positions) — partial        │
│  - Cluster membership                                        │
└─────────────────────────────────────────────────────────────┘
```

### Key Architectural Difference from Kafka

| Aspect | Kafka | Pulsar |
|--------|-------|--------|
| Broker role | Stateful (owns partition data on local disk) | Stateless (serves topics, data in BookKeeper) |
| Storage | Local disks on brokers | Distributed BookKeeper cluster |
| Broker failure | Partition leader election (30s+ in ZK era) | Instant broker failover (any broker can own any topic) |
| Storage scaling | Add brokers (coupled compute+storage) | Add bookies independently |
| Compute scaling | Add brokers (re-partition needed) | Add brokers (immediate, no data migration) |

**The "separation of compute and storage"** is Pulsar's defining architectural choice. A broker crash means another broker immediately takes over the topic — it reads from BookKeeper, no data movement required.

---

## 2. BookKeeper: The Storage Engine

### 2.1 Core Concepts

```
Ledger:
  - Append-only sequence of entries
  - Created by ONE writer (broker) at a time
  - Immutable once "closed" (fenced)
  - Identified by a 64-bit ledgerId

Entry:
  - Atomic unit of storage in BookKeeper
  - Contains: ledgerId + entryId + data + CRC
  - entryId is monotonically increasing within a ledger

Bookie:
  - A BookKeeper storage node
  - Stores entries in journal (WAL) + EntryLog files
  - Journal: fsync'd on every write for durability
  - EntryLog: large files combining entries from multiple ledgers (reduces fragmentation)
```

### 2.2 Ensemble, Write Quorum, Ack Quorum

The three parameters that define BookKeeper's replication:

```
E  = Ensemble size   — how many bookies in the pool for this ledger
Qw = Write Quorum    — how many bookies each entry is written to
Qa = Ack Quorum      — how many acks needed before write is confirmed

Constraint: E >= Qw >= Qa

Example: E=5, Qw=3, Qa=2
  - Ledger is spread across 5 bookies
  - Each entry written to 3 of those 5 bookies (round-robin striping)
  - Write confirmed when 2 of 3 ack
  - Can tolerate: Qa-1 = 1 failure without data loss
  - Can continue writing: E-Qw = 2 bookie failures (by replacing failed bookie in ensemble)
```

**Striping**: With E=5, Qw=3, entries are round-robin striped across the 5 bookies. Entry 0 → bookies [B1,B2,B3], Entry 1 → [B2,B3,B4], Entry 2 → [B3,B4,B5], Entry 3 → [B4,B5,B1]...

This provides both replication AND I/O parallelism (each write is distributed across multiple bookies).

### 2.3 BookKeeper Write Protocol

```
1. Client (broker) sends AddEntry to Qw bookies in parallel (async)
2. Each bookie:
   a. Appends to journal (fsync → durable on disk)
   b. Adds to memtable (write cache)
   c. Sends ACK
3. When Qa ACKs received: entry confirmed to client
4. Background: bookies flush memtable to EntryLog files

On bookie failure during write:
  - If < Qa acks received: write fails → broker must handle
  - Broker creates a new "ensemble change": removes failed bookie,
    adds a healthy one, continues writing
  - The ensemble change is recorded in ledger metadata (ZooKeeper)
  - Fencing: before creating new ledger, client writes a FENCE entry
    to prevent old client from writing to same ledger (split-brain prevention)
```

### 2.4 BookKeeper vs Kafka ISR

| Aspect | Kafka ISR | BookKeeper Quorum |
|--------|-----------|-------------------|
| Replication unit | Partition (all data) | Per-entry, striped |
| Write path | Leader writes, followers pull | Client pushes to all replicas |
| ACK policy | acks=all (all ISR must ack) | Qa out of Qw acks |
| Node failure | Leader election, new leader pulls | Bookie removed from ensemble, new bookie added |
| Read path | Only from leader | Only from leader (strict consistency) |
| Catch-up reads | Follower reads from leader | Bookie reads from peers (auto-recovery) |

**Key Pulsar advantage**: Bookie failure is isolated. The ensemble is updated and writing continues immediately. No "leader election" for storage. Kafka's ISR model requires all replicas to keep up — one slow follower can stall producer throughput (when `acks=all`).

### 2.5 BookKeeper Read Protocol

```
Read path:
  1. Client requests entry (ledgerId, entryId) from the bookie that holds it
     (bookie selection: consistent hashing from ledger metadata)
  2. Bookie checks write cache (memtable) first, then reads EntryLog
  3. Returns entry

Speculative reads: For latency-sensitive reads, client can send read to
  multiple bookies and use the first response (hedged reads).
  pulsar.client.bookkeeperClientSpeculativeReadTimeoutJitterMs controls this.
```

---

## 3. Pulsar Topic Architecture

### 3.1 Persistent vs Non-Persistent Topics

```
Persistent:    persistent://tenant/namespace/topic
Non-Persistent: non-persistent://tenant/namespace/topic
```

- **Persistent**: Messages stored in BookKeeper. Survive broker/bookie restarts. Production default.
- **Non-Persistent**: Messages kept only in broker memory. Zero disk I/O. Max throughput. No durability — if broker crashes, in-flight messages lost. Use for: real-time metrics, live video frames, anything where loss is acceptable for speed.

### 3.2 Partitioned Topics

```
Partitioned topic: persistent://tenant/ns/my-topic
  ↳ persistent://tenant/ns/my-topic-partition-0   (actual topic)
  ↳ persistent://tenant/ns/my-topic-partition-1
  ↳ persistent://tenant/ns/my-topic-partition-2

Each partition = independent non-partitioned topic
Each partition has its own broker owner, its own set of ledgers in BookKeeper
```

Routing modes:
- `RoundRobinPartition` — no key → round-robin across partitions (batching-aware)
- `SinglePartition` — no key → randomly pick one partition and stick to it
- `CustomPartition` — implement `MessageRouter`
- Keyed messages: `hash(key) % numPartitions`

### 3.3 Topic Ledger Rolling

A Pulsar topic is stored as a series of closed ledgers + one open (active) ledger:

```
Topic: my-topic-partition-0
  Ledger 1001 (closed): entries 0-9999
  Ledger 1002 (closed): entries 10000-19999
  Ledger 1003 (OPEN):   entries 20000-... (current)

Ledger roll triggers:
  - Time-based: managedLedgerMaxLedgerRolloverTimeMinutes (default 240 min)
  - Size-based: managedLedgerMaxSizePerLedgerMb (default 2048 MB)
  - Entry count: managedLedgerMaxEntriesPerLedger

On roll:
  1. Close current ledger (fence it in BookKeeper)
  2. Create new ledger in BookKeeper
  3. Update managed ledger metadata in ZooKeeper/metadata store
```

---

## 4. Subscription Types — Deep Semantics

```
Topic: T (3 partitions: P0, P1, P2)
       Messages: M1, M2, M3, M4, M5, M6

Subscription S1 with 2 consumers: C1, C2
```

### 4.1 Exclusive

```
  Only ONE consumer allowed per subscription.
  If C2 tries to subscribe while C1 is active → ConnectException

  Use when:
    - Strict ordering required
    - Exactly-one consumer must process all messages
    - State machines, event sourcing projections
```

### 4.2 Failover

```
  Multiple consumers register, ONE is designated ACTIVE (master consumer).
  Master = first consumer to connect (or reelected if master dies).
  Other consumers are standby — receive 0 messages until master fails.

  Per partition: each partition has its own master consumer.
  C1 may be master for P0, C2 may be master for P1 → load balancing at partition level.

  Use when:
    - High availability with ordering guarantees
    - Want standby consumer for instant failover without rebalance (like Kafka static membership)
    - Financial transactions, ordered audit logs
```

### 4.3 Shared

```
  All consumers receive messages in round-robin.
  Multiple consumers can be active simultaneously.
  NO ordering guarantee — messages interleaved across consumers.

  Semantics: effectively a queue (point-to-point JMS Queue model)

  Consumer C1 gets: M1, M3, M5
  Consumer C2 gets: M2, M4, M6

  Use when:
    - Task queue / work queue pattern
    - Order doesn't matter
    - Maximum throughput, horizontal scaling of consumers
    - Job dispatching, email sending, async notifications
```

### 4.4 Key_Shared

```
  Messages with the same key ALWAYS routed to the same consumer.
  Different keys can go to different consumers.
  Guarantees per-key ordering + horizontal scaling.

  Key routing modes:
    AUTO_SPLIT (default): consistent hashing of key → consumer slot
    STICKY:               producer explicitly assigns key range to consumer

  Key "blue" → always C1
  Key "red"  → always C2
  Key "green"→ always C1 (if hash collides)

  CRITICAL CONSTRAINT: You cannot nack (negativeAcknowledge) a message in
  Key_Shared mode and have it redelivered immediately to a different consumer
  — it must go back to the same consumer (to preserve ordering).
  Dead letter queues are the recommended pattern for failures.

  Use when:
    - Per-user/per-session processing with multiple consumers
    - Sharded stateful processing (like Kafka consumer group with key-based assignment)
    - Shopping cart updates, user activity streams
```

### 4.5 Subscription vs Consumer Group (Kafka Comparison)

```
Kafka:
  Consumer Group "my-group" with 3 consumers reading 6 partitions:
    Consumer 1: partitions 0, 1
    Consumer 2: partitions 2, 3
    Consumer 3: partitions 4, 5
  → RangeAssignor or StickyAssignor handles partition assignment
  → Ordering per partition guaranteed

Pulsar Shared subscription with 3 consumers:
  All 3 get messages round-robin from broker
  → No partition-level assignment concept
  → Easy scale-out without rebalance (just add consumer — no group coordinator overhead)
```

---

## 5. Cursor Management

### 5.1 How Cursors Work

A cursor represents **the current read position** of a subscription in a topic.

```
Cursor state:
  - markDeletePosition: highest contiguous acked offset
  - individualDeletedMessages: set of non-contiguous acked offsets (bitset)
  - lastActive: timestamp of last activity

Topic: offsets 0, 1, 2, 3, 4, 5, 6, 7, 8, 9
Subscription cursor:
  Consumer acked: 0, 1, 2, 4, 7  (not 3, 5, 6, 8, 9)
  markDeletePosition = 2 (highest contiguous)
  individualDeletedMessages = {4, 7}
  → Broker will redeliver: 3, 5, 6, 8, 9
```

### 5.2 Cursor Storage — BookKeeper, Not ZooKeeper

Early Pulsar versions stored cursor state in ZooKeeper. This was a critical mistake discovered at scale:
- 1000 topics × 10 subscriptions = 10,000 cursors updating constantly
- ZooKeeper overwhelmed → cluster instability

Modern Pulsar: cursor state stored in a **cursor ledger** in BookKeeper. Only the cursor ledger ID and some metadata (lastActive, etc.) stored in ZooKeeper.

```
Cursor write path:
  Consumer acks message M
  ↓
  Broker updates in-memory cursor state
  ↓
  Periodically (or on threshold): broker writes cursor snapshot to BookKeeper
                                  (creates/updates cursor ledger)
  ↓
  ZooKeeper stores: { subscriptionName → cursorLedgerId }
```

### 5.3 Acknowledgment Modes

- **Individual ack** (`consumer.acknowledge(msg)`): acks specific message. More granular, higher overhead (tracks individual deletes).
- **Cumulative ack** (`consumer.acknowledgeCumulative(msg)`): acks all messages up to and including this one. Like Kafka's offset commit. Only works with Exclusive/Failover (one consumer per partition stream).
- **Negative ack** (`consumer.negativeAcknowledge(msg)`): redelivery requested after `negativeAckRedeliveryDelay`. Does NOT advance cursor.
- **Dead letter policy**: After `maxRedeliverCount` negative acks, message sent to dead letter topic.

---

## 6. Tiered Storage — Offloading to Object Storage

### 6.1 Architecture

```
Hot data (recent):
  BookKeeper bookies → fast I/O, expensive storage

Cold data (old):
  Object storage (S3, GCS, Azure Blob, Aliyun OSS)
  via Apache jclouds abstraction layer

Trigger for offload:
  - managedLedgerOffloadAutoTriggerSizeThresholdBytes
  - managedLedgerOffloadDeletionLagMs (wait before deleting from BK)
```

### 6.2 How Offload Works

```
1. Broker detects a closed ledger exceeds offload threshold
2. Offloader worker thread reads ledger from BookKeeper
3. Writes ledger contents to object storage (segmented, parallel multipart upload)
   Structure: s3://bucket/managed-ledger/<tenant>/<ns>/<topic>/<ledgerId>/
   Data stored as raw block files (Pulsar's own format, NOT Avro or Parquet)
4. Updates ManagedLedger metadata in ZooKeeper:
   ledger.offloadContext = { driverName=S3, bucket=..., key=..., region=... }
5. After managedLedgerOffloadDeletionLagMs (default 4h):
   Deletes ledger from BookKeeper to free space
```

### 6.3 Read Path for Offloaded Data

```
Consumer reads offset in a cold ledger:
  Broker checks ManagedLedger metadata → ledger is offloaded to S3
  Broker instantiates S3 offloader reader
  Reads from S3 (higher latency than BookKeeper)
  Returns to consumer

From consumer's perspective: transparent (same API)
From SLA perspective: cold reads have 10-100ms latency vs <1ms from BookKeeper
```

### 6.4 Use Case

Pulsar tiered storage is a compelling alternative to Kafka's approach of large disk arrays on brokers. With Pulsar:
- Keep 2-7 days hot in BookKeeper (SSD bookies)
- Offload to S3 for compliance/audit (effectively infinite retention)
- One streaming system replaces both a Kafka cluster AND an S3 data lake export pipeline

---

## 7. Pulsar Functions & Pulsar IO

### 7.1 Pulsar Functions

Lightweight, serverless compute framework embedded in Pulsar. Think AWS Lambda triggered by Pulsar topics.

```java
public class WordCountFunction implements Function<String, Integer> {
    @Override
    public Integer process(String input, Context context) {
        return input.split("\\s+").length;
    }
}
```

```
Deployment:
  Source topic → [Pulsar Function] → Sink topic
                     ↑
              Runs in broker process (thread mode)
              OR in Kubernetes pods (process/k8s mode)
              OR in dedicated functions worker cluster

Exactly-once:
  Functions framework handles offset tracking + retry
  Input ack is tied to output publish + offset commit atomically
```

**When to use**: Simple stateless transformations, routing, enrichment. NOT for complex stateful stream processing (use Flink for that).

### 7.2 Pulsar IO (Connectors)

Source connectors (external system → Pulsar) and sink connectors (Pulsar → external system). Built on Pulsar Functions runtime.

Notable connectors: Kafka (bridge), Debezium CDC, Elasticsearch, JDBC, Kinesis, MongoDB.

**Kafka-Pulsar migration pattern**: Use Kafka source connector to read from Kafka, publish to Pulsar. Zero-downtime migration.

---

## 8. Schema Registry — Built-in vs Confluent

### 8.1 Pulsar's Built-in Schema Registry

Pulsar has a schema registry **natively embedded** — no separate service needed.

```java
// Producer with schema
Producer<User> producer = client.newProducer(Schema.AVRO(User.class))
    .topic("persistent://tenant/ns/users")
    .create();

// Schema enforcement at broker level
// Broker validates each produce request against registered schema
```

Schema storage: schemas stored in the broker's metadata store (ZooKeeper/BookKeeper). Associated with topic, versioned.

Compatibility modes: `BACKWARD`, `FORWARD`, `FULL`, `ALWAYS_COMPATIBLE`, `ALWAYS_INCOMPATIBLE`.

### 8.2 Kafka's External Confluent Schema Registry

```
Kafka does NOT have a built-in schema registry.
Confluent Schema Registry is a SEPARATE service:
  - Runs as a separate JVM process
  - Stores schemas in a Kafka topic (_schemas)
  - Clients (producers/consumers) call REST API to register/fetch schemas
  - Wire format: [0x00][schema_id:4 bytes][avro/protobuf payload]

Drawback: additional operational component, separate scaling, additional network hop
Advantage: richer ecosystem, Confluent Platform integration
```

### 8.3 Comparison

| Aspect | Pulsar | Kafka (Confluent) |
|--------|--------|-------------------|
| Schema storage | Built-in (broker metadata) | External service |
| Additional services | None | Schema Registry + ZooKeeper/KRaft |
| Schema evolution checks | At broker (produce-time enforcement) | At producer/consumer via client library |
| Supported formats | Avro, Protobuf, JSON Schema, primitives | Avro, Protobuf, JSON Schema |
| Operational complexity | Lower | Higher |

---

## 9. Multi-Tenancy

### 9.1 Hierarchy

```
Pulsar:
  Cluster
    └── Tenant (team, product, organization)
            └── Namespace (logical grouping of topics + policies)
                    └── Topic

Example:
  persistent://ecommerce/orders/order-placed
  persistent://ecommerce/orders/order-shipped
  persistent://analytics/clickstream/raw
  persistent://analytics/clickstream/processed
```

### 9.2 Namespace Policies

Each namespace carries its own policies:
- **Retention policy**: how long to retain messages after all subscriptions have consumed them
- **Backlog quota**: max unacked messages per subscription (triggers producer backpressure or message dropping)
- **Message TTL**: auto-expire unacked messages after N seconds
- **Encryption**: require end-to-end encryption for all topics in namespace
- **Geo-replication**: which remote clusters to replicate to
- **Rate limiting**: produce/consume rate per namespace
- **Storage quota**: max storage bytes per namespace

### 9.3 Bundle-Based Load Balancing

Pulsar maps namespace topics to **bundles** (hash ranges). A bundle is the unit of load balancing:

```
Namespace has N bundles (default 4, configurable).
Each bundle maps to a range of hash(topic_name) values.
Each bundle is owned by one broker.

Load balancer:
  - Monitors CPU/memory/bandwidth per broker per bundle
  - If broker is overloaded: transfer bundle to less loaded broker
  - Bundle transfer: drain current broker (wait for pending reads/writes),
    close ledgers, reassign in ZooKeeper, new broker takes over
  - No data movement (data stays in BookKeeper)

This is why Pulsar broker scaling is instant compared to Kafka partition rebalancing.
```

---

## 10. Geo-Replication

### 10.1 Async Replication (default)

```
DC-West cluster                    DC-East cluster
  Broker-W receives message
  ↓
  Writes to BookKeeper-W (local commit)
  ↓
  Geo-replicator thread (per topic per remote cluster):
    Reads from local BookKeeper
    Publishes to DC-East broker
    DC-East broker writes to BookKeeper-East
  ↓
  ACK back to W producer BEFORE geo-replication completes

→ Async: producer latency unaffected by remote cluster
→ Risk: if DC-West fails before replication completes, messages lost
```

### 10.2 Sync Replication (BookKeeper-level)

Pulsar also supports **BookKeeper's region-aware placement**: Qw=3, with bookies distributed across 2 DCs. Entry must be written to 1+ bookie in each DC before Qa acks are received.

```
E=4 (2 per DC), Qw=4, Qa=2 (1 per DC required)
  → Synchronous cross-DC write, higher latency, zero data loss
  → Used for financial/compliance workloads
```

### 10.3 Compared to Kafka MirrorMaker2

| Aspect | Pulsar geo-replication | Kafka MirrorMaker2 |
|--------|----------------------|-------------------|
| Native support | Yes (built-in, per-namespace config) | No (separate tool) |
| Replication lag | Sub-second | Seconds (batch-based) |
| Offset mapping | Native (same subscription cursor across DCs) | Complex (offset translation required) |
| Bidirectional | Yes, with cycle detection | Yes (complex setup) |
| Management | Pulsar admin API | Separate Kafka Connect cluster |

---

## 11. When to Choose Pulsar Over Kafka

### Use Pulsar when:

1. **Multi-tenancy is a first-class requirement**: SaaS platform, internal platform serving many teams. Pulsar's tenant/namespace model with per-namespace isolation beats Kafka's bolt-on ACL model.

2. **Independent compute and storage scaling**: Traffic is spiky. You need to add consumers without adding storage, or add storage (more topics, longer retention) without more CPUs.

3. **Native geo-replication across 3+ DCs**: Pulsar's geo-replication is simpler to operate than MirrorMaker2.

4. **Multiple messaging patterns in one system**: Queuing (Shared subscriptions), pub-sub (Exclusive/Failover), and streaming (persistent topics) — one system replaces RabbitMQ + Kafka.

5. **Very long retention with tiered storage**: Pulsar + S3 offloading is more operationally simple than Kafka + external archival pipeline.

6. **Pulsar Functions for lightweight stream processing**: Avoid Kafka Connect + Kafka Streams as separate deployments.

### Stick with Kafka when:

1. You already have a mature Kafka ecosystem (Kafka Streams, ksqlDB, Confluent Platform).
2. You need the widest connector ecosystem (Kafka Connect has more connectors).
3. Your team has deep Kafka expertise.
4. Very high throughput with simple fan-out patterns (Kafka's sequential disk I/O + page cache + zero-copy is extremely hard to beat for raw throughput).
5. You're on Confluent Cloud (managed Kafka is excellent; managed Pulsar is less mature outside StreamNative).

### Performance reality check:

Kafka typically achieves higher raw throughput per broker (up to 2-3 GB/s writes on fast NVMe) because:
- No network hop to BookKeeper — leader writes directly to local disk
- Zero-copy `sendfile()` for consumer reads
- Simpler quorum protocol (pull-based ISR vs push-based Qa acks)

Pulsar trades some throughput for operational flexibility. For most production workloads (<500 MB/s per topic), the difference is irrelevant.

---

## 12. Interview Fast-Fire Q&A

**Q: How does Pulsar avoid the Kafka partition rebalancing problem?**
A: Pulsar brokers are stateless. Topic ownership is just a ZooKeeper/metadata record. On broker failure, any other broker immediately takes over the topic — it reads ledger history from BookKeeper, creates a new ledger, and starts serving. No partition reassignment, no data copy. Consumer reconnects to new broker transparently. Under the hood, the new broker "fences" the old ledger by writing a special BookKeeper fence entry, preventing any zombie writes from the crashed broker.

**Q: Explain E, Qw, Qa with an example and failure tolerances.**
A: E=5, Qw=3, Qa=2. Each entry is striped across 5 bookies, written to 3, acked when 2 confirm. Failure tolerance: Qa-1 = 1 bookie can fail without data loss (2 copies remain). For continued writes: if a bookie fails, the ensemble is changed (new bookie substituted), writing continues. The auto-recovery service on surviving bookies replicates under-replicated entries in the background.

**Q: What is a cursor in Pulsar and how does it differ from a Kafka consumer offset?**
A: Kafka consumer offsets are per-partition integers stored in `__consumer_offsets`. Pulsar cursors are per-subscription objects stored in BookKeeper (cursor ledger). Cursors track both a `markDeletePosition` (highest contiguous ack) and individual acks (bitmap of non-contiguous acks). This supports individual message acknowledgment — impossible in Kafka where you can only commit offsets in order.

**Q: When would you use Key_Shared subscription?**
A: When you need ordering per key AND horizontal scaling. Example: processing user events in order per user, with 10 consumer instances. Key_Shared hashes user IDs to consumers. Unlike Kafka, you can add/remove consumers dynamically without rebalancing (consistent hashing remaps the key range). Caveat: nacking a message doesn't immediately redeliver to another consumer — it must go back to the same consumer, so you need a dead-letter policy for poison messages.

**Q: How does Pulsar's tiered storage affect consumers?**
A: Completely transparent. The consumer uses the same API regardless of where data is stored. The broker checks the managed ledger metadata — if the ledger is offloaded to S3, it uses the S3 offloader to read and stream back to the consumer. Latency increases for cold reads (S3 is ~10-50ms vs BookKeeper ~1ms), but throughput can be sustained. You cannot compact tiered-storage data (unlike Kafka compaction), so use TTL/retention policies instead.

---

Sources:
- [Pulsar Architecture Overview](https://pulsar.apache.org/docs/next/concepts-architecture-overview/)
- [BookKeeper Replication Protocol](https://bookkeeper.apache.org/archives/docs/r4.4.0/bookkeeperProtocol.html)
- [Guide to BookKeeper Replication Protocol (Jack Vanlightly)](https://medium.com/splunk-maas/a-guide-to-the-bookkeeper-replication-protocol-tla-series-part-2-29f3371fe395)
- [Understanding Apache Pulsar (Jack Vanlightly)](https://jack-vanlightly.com/blog/2018/10/2/understanding-how-apache-pulsar-works)
- [Pulsar Subscription Types](https://pulsar.apache.org/docs/next/concepts-messaging/)
- [Understanding Cursors in Apache Pulsar](https://dzone.com/articles/understanding-cursors-tracking-mechanism-in-pulsar)
- [Tiered Storage Overview (Pulsar)](https://pulsar.apache.org/docs/2.11.x/tiered-storage-overview/)
- [Pulsar Multi-Tenancy](https://pulsar.apache.org/docs/next/concepts-multi-tenancy/)
- [Pulsar Geo-Replication](https://pulsar.apache.org/docs/2.10.x/administration-geo/)
- [Pulsar Newbie Guide for Kafka Engineers (StreamNative)](https://streamnative.io/blog/pulsar-newbie-guide-for-kafka-engineers-part-3-ledgers-bookies)
