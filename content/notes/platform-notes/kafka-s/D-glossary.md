# Appendix D — Glossary
### Terms, with Cross-References to Chapters

---

A reference for the vocabulary used across the book. Each term
includes a short definition and the chapter where it's covered in
depth.

---

**Acks** — Producer-side durability setting. `0`, `1`, or `all`. See
Chapter 4.

**ACL** — Access Control List. The authorisation rule format Kafka
uses. See Chapter 18.

**Active Controller** — In KRaft mode, the Raft leader of the
controller quorum; the broker currently making cluster-wide
decisions. See Chapter 9.

**Active segment** — The currently-being-written segment of a
partition. See Chapter 6.

**AdminClient** — The Java API for cluster administration
operations. Configures topics, ACLs, etc.

**Avro** — A compact binary serialisation format with schema-based
evolution. The most common Schema Registry format. See Chapter 16.

**Backward compatibility (schema)** — The new schema can read records
produced under the old schema. See Chapter 16.

**Batch** — A `RecordBatch` (v2) — the unit of compression,
transmission, and disk storage. See Chapters 4 and 6.

**BookKeeper** — The storage layer underlying Apache Pulsar.
Mentioned for contrast in Chapter 24.

**Broker** — A single Kafka server process. The operational unit. See
Chapter 2.

**BufferPool** — The producer's pool of `ByteBuffer` instances used
to hold pending batches. Bounded by `buffer.memory`. See Chapter 4.

**CDC (Change Data Capture)** — Streaming a database's WAL into
Kafka. See Chapters 15 and 21.

**Cleaner thread** — The broker thread that performs log compaction.
See Chapter 12.

**Cluster Linking** — Confluent's commercial cross-cluster
replication feature.

**Compaction** — Retaining only the latest record per key in a
topic; the alternative cleanup policy to deletion. See Chapter 12.

**Connect** — Kafka Connect; the framework for source/sink
connectors. See Chapter 15.

**Connector** — A configured integration unit in Connect (source or
sink).

**Consumer** — An application that reads records from one or more
topics. See Chapter 10.

**Consumer Group** — A set of consumers that share partition
assignments cooperatively. See Chapter 11.

**ConsumerGroupHeartbeat** — The heartbeat RPC in the new (KIP-848)
consumer protocol.

**Controller** — The component owning cluster-wide metadata. In
KRaft, a quorum of dedicated nodes; in ZK era, an elected broker. See
Chapter 9.

**Cooperative rebalancing** — Incremental rebalance protocol where
only changing partitions are revoked. See Chapter 11.

**Coordinator** — A broker designated to manage state for a specific
group / transaction. See Chapters 5 and 11.

**CRC** — Cyclic Redundancy Check; the integrity check on
RecordBatches. See Chapter 6.

**Debezium** — Open-source CDC platform built on Kafka Connect. See
Chapter 15.

**Delivery semantics** — At-most-once, at-least-once, exactly-once.

**Delivery timeout** — `delivery.timeout.ms`; the producer's outer
retry budget.

**Dedupe buffer** — The cleaner thread's hash map for compaction.
See Chapter 12.

**Dirty / Clean region** — A compacted partition's regions; the
clean has been compacted, the dirty has not. See Chapter 12.

**EOS / EOSv1 / EOSv2** — Exactly-once semantics; v1 = original,
v2 = KIP-447 redesign. See Chapter 5.

**Epoch** — A monotonic counter incremented on leader change
(partition) or producer (re-)init (idempotence).

**Fetcher** — A thread (consumer-side or follower-side) issuing
FetchRequests.

**Fetch from follower** — KIP-392; consumer reads from a same-rack
follower. See Chapters 8 and 10.

**Fluid Compute** — Vercel's compute model (mentioned in plugin
context, not Kafka-related).

**Follower** — A non-leader replica of a partition. Replicates by
fetching from the leader. See Chapter 8.

**Forward compatibility** — Old schema can read records produced
under new schema. See Chapter 16.

**fsync** — POSIX system call to flush dirty pages to disk. Kafka
mostly avoids it. See Chapter 6.

**G1GC** — The default JVM garbage collector for Kafka.

**Group Coordinator** — Broker responsible for a consumer group's
state. See Chapter 11.

**HWM (High Watermark)** — The highest offset committed (replicated
to all ISR). See Chapter 8.

**Idempotent producer** — Producer that uses (PID, epoch, seq) to
deduplicate retries. See Chapter 5.

**ISR (In-Sync Replicas)** — Replicas caught up to the leader within
`replica.lag.time.max.ms`. See Chapter 8.

**JBOD** — Just a Bunch Of Disks; the recommended multi-disk layout
for Kafka brokers. See Chapter 6.

**JoinGroup / SyncGroup** — The classic two-phase consumer rebalance
protocol. See Chapter 11.

**Kafka Streams** — Kafka's stream-processing library. See Chapter 14.

**Keystone** — Netflix's data ingestion pipeline. See Chapter 23.

**KIP** — Kafka Improvement Proposal. The RFC-like process for
non-trivial changes.

**KRaft** — Kafka Raft; the metadata management replacement for
ZooKeeper. See Chapter 9.

**LEO (Log End Offset)** — The offset of the next record to be
written on a replica. See Chapter 8.

**Leader** — The replica handling all client traffic for a
partition. See Chapter 2.

**Leader Epoch** — Monotonic counter, incremented per leader
election. Used to safely truncate logs after fail-over. See
Chapter 8.

**Linger.ms** — Producer config; how long to wait for a batch to
fill. See Chapter 4.

**Log** — An append-only, totally ordered sequence of records. See
Chapter 1.

**Log start offset** — The lowest offset still retained on disk.
Below it, records have been deleted by retention.

**Log compaction** — See Compaction.

**LSO (Last Stable Offset)** — In transactional contexts, HWM minus
any in-flight transactional records. See Chapter 5.

**Mantis** — Netflix's stream processor. See Chapter 23.

**Mental model** — In this book, the four-layer model
(applications, client protocol, broker internals, physical) and
the four invariants. See Chapter 3.

**Metadata log** — In KRaft, the `__cluster_metadata` topic
containing all cluster state changes. See Chapter 9.

**MirrorMaker (MM2)** — Tool for replicating data between Kafka
clusters. See Chapter 19.

**`min.insync.replicas`** — Minimum ISR size for `acks=all` to
succeed. See Chapter 3.

**Mutual TLS (mTLS)** — TLS where the client also presents a
certificate. See Chapter 18.

**OAuth/OAUTHBEARER** — JWT-based authentication mechanism for
SASL. See Chapter 18.

**Offset** — The unique position of a record within its partition.

**Page cache** — The OS's filesystem cache; Kafka's primary read
cache. See Chapter 6.

**Partition** — One log within a topic. The unit of parallelism and
ordering. See Chapter 2.

**Partitioner** — Function determining which partition a record
goes to. See Chapter 4.

**PID (Producer ID)** — 64-bit identifier assigned by the
transaction coordinator for idempotence/transactions. See Chapter 5.

**Plugin** — A connector implementation (in Connect) or other
extension class.

**Processor (network thread)** — Broker thread reading bytes from
sockets and pushing requests. See Chapter 7.

**Producer** — An application that writes records. See Chapter 4.

**Protobuf** — Protocol Buffers; alternative to Avro. See Chapter 16.

**Purgatory** — Broker data structure for delayed operations
(produce waiting for HWM, fetch waiting for data). See Chapter 7.

**Raft** — Consensus protocol; KRaft is Kafka's variant. See
Chapter 9.

**Range Assignor** — Default consumer assignment strategy
(partitions divided in ranges). See Chapter 11.

**Read-committed / Read-uncommitted** — Consumer isolation levels;
read-committed filters out aborted-transaction records. See
Chapter 5.

**Rebalance** — Reassignment of partitions among consumer group
members. See Chapter 11.

**Record** — A single key/value/headers/timestamp tuple.

**RecordAccumulator** — Producer-side per-partition batch buffer.
See Chapter 4.

**RecordBatch** — Wire-level grouping of records, the unit of
compression and storage. See Chapter 6.

**Redpanda** — Apache-Kafka-compatible C++ implementation. See
Chapter 24.

**Remote Log Manager (RLM)** — Broker component for tiered
storage. See Chapter 13.

**Replica** — A copy of a partition's log on a particular broker.
See Chapter 2.

**Replication factor (RF)** — Number of replicas per partition.

**Request handler thread** — Broker thread processing requests
(`num.io.threads`). See Chapter 7.

**Retention** — How long records are kept. Time-based or
size-based. See Chapter 6.

**RocksDB** — Embedded key-value store used by Kafka Streams for
state. See Chapter 14.

**SASL** — Simple Authentication and Security Layer; pluggable
authentication framework. See Chapter 18.

**Schema Registry** — Service storing Avro/Protobuf/JSON schemas
referenced by Kafka records. See Chapter 16.

**SCRAM** — Salted Challenge-Response Authentication Mechanism;
SASL/SCRAM. See Chapter 18.

**Segment** — A file in a partition's log, named by base offset. See
Chapter 6.

**Sender thread** — Producer's background thread doing network
I/O. See Chapter 4.

**`sendfile()`** — Linux syscall for zero-copy disk-to-network
transfer. See Chapter 6.

**Share Group** — KIP-932; the new queue-semantics consumer model.
See Chapter 24.

**SMT (Single Message Transform)** — Inline record modification in
Connect. See Chapter 15.

**Snapshot (Streams)** — A periodic checkpoint of state-store
contents.

**Snapshot (Raft)** — A periodic point-in-time view of the metadata
log; KIP-630.

**Snapshot (.snapshot file)** — Producer-state snapshot for
idempotence/transactions on disk.

**Sparse index** — The .index file's structure; one entry per
~4 KB of log. See Chapter 6.

**Static membership** — KIP-345; consumer's stable identity that
survives session timeouts. See Chapter 11.

**Sticky Partitioner** — Producer partitioner that fills a batch
before switching. See Chapter 4.

**Streams** — See Kafka Streams.

**Subject (Schema Registry)** — Logical schema namespace, typically
named after a topic. See Chapter 16.

**Tiered storage** — KIP-405; offloading old segments to object
storage. See Chapter 13.

**Timeindex** — The .timeindex file mapping timestamps to offsets.
See Chapter 6.

**TLS** — Transport Layer Security; encryption / identity for
connections. See Chapter 18.

**Tombstone** — A record with `value=null`, signaling deletion in a
compacted topic. See Chapter 12.

**Topic** — A named log; logically, N partitions. See Chapter 2.

**Transaction Coordinator** — Broker managing transactional
producer state. See Chapter 5.

**Transactional ID** — Stable identifier for a transactional
producer; allows recovery across restarts. See Chapter 5.

**Unclean leader election** — Electing a non-ISR replica as leader;
causes data loss. See Chapter 8.

**WarpStream** — Kafka-compatible system using S3 as primary
storage. See Chapter 24.

**Worker (Connect)** — A JVM process running Connect tasks. See
Chapter 15.

**Zero-copy** — Avoiding user-space buffer copies; Kafka uses
`sendfile`. See Chapter 6.

**ZooKeeper (ZK)** — Distributed coordination service; the legacy
metadata layer (pre-KRaft). See Chapter 9.

---

## A note on usage

This glossary is meant for lookup, not reading-through. The chapters
are where the depth lives. If a term here is mysterious, the
chapter reference will explain it.

For a more precise definition than this gives — particularly for
protocol-level terms — see Appendix A (wire protocol).
