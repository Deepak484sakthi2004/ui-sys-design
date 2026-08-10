# Chapter 13 — Tiered Storage
### Pushing the Cold Tail to Cheap Storage

---

For most of Kafka's life, broker disk was the bottleneck on retention.
Want to keep a year of data? Buy a year's worth of SSD on every broker
in the cluster. The math gets painful fast: a topic taking 1 TB/day,
with RF=3, stored for 365 days, is 1095 TB of SSD on local disks —
maybe $300,000 just in storage costs, and that's before you factor in
the operational complexity of running brokers with 100+ TB of local
disk each.

Object storage — S3, GCS, Azure Blob — solves this for batch systems by
being two orders of magnitude cheaper per byte. For decades, the streaming
world watched the data-lake world get cheaper while their own storage
costs stayed nailed to SSD pricing. Eventually, the streaming world
caught up.

KIP-405, proposed in 2019 and stabilised in Kafka 3.6 (2023), introduced
**tiered storage**: a feature that lets old segments be transparently
offloaded to object storage while the hot tail stays on local disk. The
contract is simple: consumers can read any offset, transparently, no
matter where it lives. The cost is enormously different — pennies per
GB-month for cold storage versus dollars for SSD.

This chapter:

- The architecture: the `RemoteLogManager`, segment lifecycle in two tiers.
- How writes flow into tiered storage (hint: they don't, directly — only
  closed segments do).
- How reads flow back: which paths bypass local disk, which do not.
- Performance characteristics: latency, throughput, and what gets cached.
- The interaction with replication, compaction, and tracing.
- When tiered storage is the right answer; when it isn't.
- Implementation status: KIP-405 made the broker pluggable; you bring
  the storage backend.

---

## 13.1 The big picture

A partition with tiered storage enabled lives in two places at once:

```
HOT TIER (local disk):
  my-topic-0/
    00000000000000345672.log     ← active and recent segments
    00000000000000345672.index
    ...
    00000000000000387893.log     ← active segment

COLD TIER (S3 or equivalent):
  s3://my-kafka-tiered-storage/
    cluster-uuid-abc123/
      my-topic-uuid-xyz/
        partition-0/
          00000000000000000000.log    ← old segments, copied here
          00000000000000000000.index
          00000000000000000000.timeindex
          00000000000000012345.log
          ...
          00000000000000345671.log    ← last cold-tier segment
```

The local broker has only the recent segments; the older ones live in
S3. A consumer reading offset 100 (which is in cold storage) gets
served from S3 transparently; the broker fetches the segment range
needed and serves it.

Two key configurations control the boundary:

```properties
# Local retention — how much to keep on local disk
local.retention.ms=43200000        # 12 hours
local.retention.bytes=...          # or by size

# Total retention — including cold tier
retention.ms=31536000000           # 1 year
retention.bytes=...                # or by size
```

Local retention is the disk's commitment; total retention is the
"effectively infinite" boundary. Together they say "keep 12 hours hot,
keep 1 year cold."

---

## 13.2 The RemoteLogManager

KIP-405's broker-side architecture introduces the **RemoteLogManager**
(RLM), a per-broker component that:

1. Watches local segments and decides which to upload to cold tier.
2. Manages the upload itself, via a pluggable backend.
3. Manages cold-tier reads when consumers ask for old offsets.
4. Maintains a metadata layer mapping offsets to cold-tier locations.

```
                        ┌────────────────────────────────────┐
                        │          BROKER                     │
                        │                                     │
   producer / consumer  │      ┌──────────────┐               │
   <───────────────────────────│   KafkaApi   │               │
                        │      └───┬──────┬───┘               │
                        │          │      │                   │
                        │          │      │                   │
                        │     ┌────▼────┐ │                   │
                        │     │ LocalLog│ │ (hot tier)        │
                        │     └────┬────┘ │                   │
                        │          │      │                   │
                        │          │      ▼                   │
                        │          │  ┌─────────────────────┐ │
                        │          └──│ RemoteLogManager    │ │
                        │             └────┬─────────┬──────┘ │
                        │                  │         │        │
                        └──────────────────│─────────│────────┘
                                           │         │
                              upload       │         │ download
                                           │         │
                                           ▼         ▼
                                        ┌────────────────────┐
                                        │  Object Storage    │
                                        │  (S3 / GCS / etc.) │
                                        └────────────────────┘
```

The RLM has two responsibilities: **copy old segments to remote
storage** and **fetch them back when needed**.

### 13.2.1 The pluggable backend

KIP-405 deliberately made the storage backend pluggable. Kafka does
not bake S3 into the core. Instead, you implement two interfaces:

- `RemoteStorageManager` — handles segment upload, download, deletion.
- `RemoteLogMetadataManager` — handles offset → cold-storage-location
  mapping.

The reference implementation is `LocalTieredStorage` (for testing,
uses the local filesystem). Production-ready implementations exist for
S3, GCS, Azure, HDFS — typically maintained by Confluent, AWS, or
specific vendor teams. Aiven, for example, maintains a popular
open-source S3 implementation.

```properties
remote.log.storage.system.enable=true
remote.log.storage.manager.class.name=io.aiven.kafka.tieredstorage.RemoteStorageManager
remote.log.metadata.manager.class.name=org.apache.kafka.server.log.remote.metadata.storage.TopicBasedRemoteLogMetadataManager
remote.log.storage.manager.impl.prefix=rsm.config.
remote.log.metadata.manager.impl.prefix=rlmm.config.

rsm.config.storage.backend.class=io.aiven.kafka.tieredstorage.storage.s3.S3Storage
rsm.config.s3.bucket.name=my-kafka-tiered-storage
rsm.config.s3.region=us-east-1
```

(The exact properties depend on the implementation. Production
documentation is improving but still varies.)

### 13.2.2 The metadata manager

The default metadata manager is `TopicBasedRemoteLogMetadataManager`. It
stores cold-tier metadata in *another internal Kafka topic*:
`__remote_log_metadata`. Records here are essentially:

```
key: (topicId, partition)
value: (offsetRange, remoteSegmentId, segmentMetadata)
```

The topic is compacted, replicated for durability, and consulted
during read paths. This is yet another self-referential trick: Kafka
uses Kafka to track Kafka's own out-of-band storage.

---

## 13.3 The segment lifecycle, with tiering

The lifecycle of a segment in a tiered topic:

### Phase 1: Active

The active segment is being written to. It's on local disk. RLM
ignores it.

### Phase 2: Closed, recent

The segment has been rolled (a new active segment was opened); it's
read-only, on local disk. RLM has not yet copied it to remote.

### Phase 3: Copied to remote

The RLM upload thread picks the segment, uploads it to remote storage,
records the metadata. The segment is now in **both places**.

### Phase 4: Local deletion

After the segment has been remote for at least
`local.retention.ms` (or local size threshold reached), the local copy
is deleted. The segment now exists *only* in cold storage.

### Phase 5: Remote deletion

Eventually, the segment exceeds `retention.ms` for the topic. The RLM
issues a delete to cold storage. The segment is gone.

```
    ┌──────────────────────────────────────────────────────┐
    │ ACTIVE     │ CLOSED  │ UPLOADED │ LOCAL DELETED │ X  │
    │            │         │          │               │    │
    │ local only │ local   │ local +  │ remote only   │ del│
    │            │ only    │ remote   │               │    │
    └──────────────────────────────────────────────────────┘
        ↑          ↑          ↑           ↑              ↑
        │          │          │           │              │
       new      segment    RLM uploads  local         remote
       writes   rolled     to remote    retention     retention
                                        deletes       deletes
```

### Read behaviour at each phase

- Phase 1-3: reads from local disk (fast, page cache, sendfile).
- Phase 4: reads from remote (slower, network round trip).
- Phase 5: `OFFSET_OUT_OF_RANGE`.

The transition between phase 3 and phase 4 is the key UX moment. During
phase 3, the segment is in both places — a consumer reading at that
moment goes through local. After local deletion, the same segment now
requires a network fetch.

---

## 13.4 Read paths in detail

### 13.4.1 Local-tier read

Same as Chapter 6's read path. The broker uses `sendfile()`, zero-copy
all the way to the wire.

### 13.4.2 Cold-tier read

The broker:

1. Looks up the offset in `__remote_log_metadata`. Finds segment
   metadata: `(remoteSegmentId, byteRangeForOffset)`.
2. Issues a download via the `RemoteStorageManager` for the relevant
   byte range.
3. Streams the bytes back to the consumer, possibly through an
   in-memory buffer.

The `sendfile` zero-copy path is **broken**: bytes flow through user-space
on their way from S3 to the wire. This is fundamental — the data isn't
in the page cache, it's coming from the network.

### 13.4.3 Caching

Some implementations (e.g., Aiven's) cache recently-fetched cold-tier
segments on local disk to amortise download cost across consumers. This
adds complexity (cache eviction policy, disk space management) but
substantially improves the read economy when multiple consumers read
the same old data.

The exact caching policy depends on the implementation. KIP-405's
contract doesn't mandate any.

### 13.4.4 Latency

Cold-tier read latency depends on the backend. For S3:

- **First-byte latency**: 30-100 ms typical.
- **Throughput per stream**: 50-100 MB/s typical (single connection).

A consumer starting from a cold offset experiences a 100 ms delay on
the first record, then sustained throughput. Subsequent records from
the same segment are served from the broker's in-memory buffer of the
fetched range.

For most batch / replay workloads, this is fine. For real-time
backfills or interactive replays, it may not be. Tier carefully.

---

## 13.5 Replication and tiered storage

Here's a subtlety: **only the leader uploads to cold tier**. Followers
keep local copies of segments at least up to `local.retention.ms`, but
they do not duplicate the upload.

When a leader change happens:

- The new leader inherits the cold-tier metadata from the metadata
  topic (no need to re-upload).
- The new leader takes over uploading new segments as they age out
  of `local.retention.ms`.

This is more efficient than naive "every replica uploads its own copy"
— S3 storage costs are paid once per cluster, not RF times.

A consequence: if you have RF=3 with `local.retention=12h`, your local
disk usage per broker is roughly RF × hot_tail × bytes_per_second.
After the segment is in cold storage and the local retention has fired,
all three replicas delete their local copies (independently, after their
own local retention timer fires). Cold storage holds only one
authoritative copy per partition.

---

## 13.6 Compaction and tiered storage

Compaction does not interact well with tiered storage. The cleaner
needs to read segments to deduplicate by key; reading from cold storage
is slow; rewriting in cold storage is even slower (S3 has no
in-place mutation).

The current state: **compacted topics cannot be tiered.** If
`cleanup.policy=compact` (or `compact,delete`), the topic is
disqualified from tiered storage. This is a real limitation; for state
stores you want to retain forever but can't tier, your options are
unbounded local growth or build your own archival to a separate system.

There are KIPs in flight to address this (KIP-405 follow-ups), but as
of 2026, plain compacted topics are tier-incompatible. Topic with
`cleanup.policy=delete` only — those can tier.

---

## 13.7 The economics

A back-of-envelope comparison for 1 TB/day, 365-day retention, RF=3:

**Without tiered storage:**
- 1 TB/day × 365 days × 3 replicas = 1095 TB on local SSD.
- SSD cost in cloud (AWS gp3-ish): ~$0.10/GB-month.
- Monthly cost: 1095 TB × $100/TB = $109,500/month.
- Annual: ~$1.3M.

**With tiered storage (12h local, 1y total):**
- Local: 1 TB/day × 12h/24h × 3 replicas = 1.5 TB on local SSD.
- Cold: 1 TB/day × 364.5 days × 1 replica = ~365 TB on S3 (single copy).
- SSD cost: $150/month.
- S3 standard: ~$0.022/GB-month for the first 50 TB, less above.
  Roughly 365 TB × $20/TB = $7,300/month for storage.
- Plus S3 request costs: depends on read patterns. Often modest if
  consumers mostly read recent data.

Total tiered: ~$7,500/month vs $109,500/month without. **An order of
magnitude cheaper.**

The break-even point depends on your read pattern. If most reads are of
hot data (the last day or week), tiered storage wins easily. If you
constantly replay old data, S3 GET costs and bandwidth start to bite.

---

## 13.8 When tiered storage is the right answer

Use tiered storage when:

- **You want long retention (weeks or more) and storage is the bottleneck.**
- **Most reads are of recent data**; old data is occasionally replayed
  for backfills, audits, or disaster-recovery.
- **You can tolerate slightly higher latency on cold reads** (~100 ms
  first byte).
- **Your topic uses `cleanup.policy=delete`** (compacted topics are out).

Don't use it when:

- **Retention is short anyway.** If you keep 7 days of data, the
  storage cost is moderate; tiered storage adds operational complexity
  for marginal savings.
- **Your reads are uniformly distributed across history.** S3 fetch
  costs and bandwidth eat your savings.
- **You need consistent low-latency reads on old data.** Real-time
  retroactive analytics don't suit it.
- **Compaction is your primary cleanup policy.**

---

## 13.9 Operational considerations

### 13.9.1 The metadata topic

`__remote_log_metadata` has its own configuration:

```properties
remote.log.metadata.topic.num.partitions=50
remote.log.metadata.topic.replication.factor=3
remote.log.metadata.topic.retention.ms=-1   # never delete metadata
```

The topic is high-write — every upload, every read of cold data, every
deletion writes a record. But records are small. Plan for a few GB of
metadata per cluster per year of operation.

### 13.9.2 Upload backpressure

If the upload backend is slow or throwing errors, segments accumulate
on local disk. The RLM's upload queue grows; eventually local disk
fills up. Watch:

- `remote-log-manager-task-queue-size` JMX
- Broker disk free space

If uploads can't keep up, *something is wrong* — either the backend is
unreachable, or your retention parameters are too aggressive for the
upload throughput.

### 13.9.3 Network egress

Cold-tier reads pull bytes from object storage to the broker. In
public-cloud environments, this is **free intra-region** but has
real cost cross-region. Make sure your buckets are in the right region.

If you serve consumers cross-region (a Kafka client in us-east-1
reading data whose home is in us-west-2), consider whether tiered
storage exacerbates this — the broker pulls from S3 in us-west-2 then
forwards to the client in us-east-1.

### 13.9.4 Failure modes

- **Backend unreachable.** Cold reads fail with retriable errors.
  Local reads continue. Set up alerts on RLM error rates.
- **Object storage data corruption.** Rare but possible. Make sure your
  bucket has versioning if your tolerance is low.
- **Object storage deletion.** If the bucket is deleted (or the
  credentials change), every old offset becomes unreachable. Treat
  the bucket as critical infrastructure.
- **Metadata topic loss.** The remote-log metadata is what makes
  cold-tier data findable. Loss of `__remote_log_metadata` is
  catastrophic. Make sure RF and ISR config protect it.

---

## 13.10 Configurations that matter

```properties
# Cluster-level (broker)
remote.log.storage.system.enable=true
remote.log.storage.manager.class.name=...      # implementation class
remote.log.metadata.manager.class.name=...     # default usually fine

# Per-topic
remote.storage.enable=true                     # opt-in per topic
local.retention.ms=43200000                    # 12 hours hot
local.retention.bytes=...                      # or by size
retention.ms=31536000000                       # 1 year total
retention.bytes=-1                             # unlimited total

# RLM behaviour
remote.log.manager.task.interval.ms=30000      # how often RLM checks for upload candidates
remote.log.manager.thread.pool.size=10         # upload concurrency
remote.log.reader.threads=10                   # read concurrency
remote.log.reader.max.pending.tasks=100        # backpressure on reads
```

The two important per-topic settings:

1. `remote.storage.enable=true`
2. `local.retention.ms` set to whatever your hot-cache size budget is.

The cluster-level config is mostly broker setup; once configured for
the cluster, individual topics opt in.

---

## Summary box

- Tiered storage moves cold segments from local SSD to cheap object
  storage (S3, etc), bounded only by your retention budget.
- KIP-405 makes the storage backend pluggable; pick an implementation
  (Aiven, AWS, Confluent) and configure it.
- Reads are transparent: consumers read offsets, the broker decides
  hot vs cold, fetches as needed. Cold reads break `sendfile`'s
  zero-copy and incur ~100 ms first-byte latency.
- **Compacted topics cannot tier**. Plain `cleanup.policy=delete` only.
- Economics are dramatic for long-retention, mostly-recent-read
  workloads — easily 10× cheaper than all-SSD.
- The metadata topic `__remote_log_metadata` is critical
  infrastructure; protect its replication.
- Watch upload backpressure and cold-read latency JMX metrics.

## Further reading

- KIP-405: Kafka Tiered Storage. The seminal proposal; ~30 pages.
- Aiven's open-source tiered storage implementation:
  github.com/aiven/tiered-storage-for-apache-kafka.
- Confluent's documentation on Tiered Storage in Confluent Platform —
  similar ideas, somewhat different operational model.
- The `org.apache.kafka.server.log.remote.*` packages in the source.

## War story: the bucket that was deleted

A team had been running tiered storage for 18 months. Backups were
fine, replication was fine, the daily ops were unremarkable. One
afternoon, an SRE — operating outside the Kafka team — was cleaning up
"unused" S3 buckets to save money. The Kafka tiered-storage bucket had
been tagged "kafka-test" by an earlier intern who set it up; the SRE,
seeing "test", deleted it.

Two months of data older than 7 days was gone. The hot tier (last 7
days) was unaffected; consumers reading recent data didn't notice.
But the analytics team, doing a 90-day backfill on a research
question, hit `OFFSET_OUT_OF_RANGE` on a topic that nominally retained
1 year.

Recovery: there was none. The data had been the source of truth for
several derived datasets; those datasets still existed (they had been
materialised before the bucket loss), so partial reconstruction was
possible. But anything that needed *raw* events from 8-90 days ago was
permanently lost.

Lessons:

1. **Tag tiered-storage buckets clearly.** "kafka-prod-cold-tier-do-not-delete"
   is appropriate.
2. **Enable bucket versioning and MFA-required deletes.** Don't rely
   on "I'll be careful" — humans make mistakes.
3. **Tiered storage is a critical infrastructure dependency**, not
   a backup. Treat the bucket with the same operational discipline
   as a production database.
4. **Cross-team awareness**: anyone who can delete cloud resources
   should know what's important to keep.

We now treat the cold-tier bucket the same way we treat the database:
strict access control, alarms on bucket-level operations, and a
runbook for any operator interacting with it. Tiered storage is too
cheap and useful to avoid; but it does change the failure surface,
and you need to plan for it.
