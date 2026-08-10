# Chapter 19: MySQL in the Cloud — Aurora, PlanetScale, TiDB

## How Cloud-Native Engines Re-Architect MySQL's Storage Layer

---

MySQL was designed for a single machine: one process, one disk, one set of redo
logs. For two decades, every scaling strategy — replication, sharding, connection
pooling — worked around that assumption without changing it. The cloud generation
tears it open. Amazon Aurora replaces the storage engine with a distributed log.
PlanetScale wraps Vitess sharding into a managed service. TiDB builds a new
distributed SQL engine that speaks the MySQL wire protocol but stores data in a
Raft-replicated key-value layer.

This chapter evaluates each approach from first principles. We trace the
architectural decisions that differ from vanilla MySQL, measure what they gain and
what they sacrifice, and provide a decision framework for choosing between them.
Every claim is grounded in the internals from Part 1 — you will understand exactly
which InnoDB assumptions each cloud engine preserves and which it discards.

This is the final chapter of the book. By the end, you will have a complete map
of MySQL — from the byte layout of a 16 KB page (Chapter 6) to a globally
distributed NewSQL engine that speaks MySQL protocol.

---

## 19.1 Amazon RDS MySQL — Managed MySQL on EC2

### What RDS Actually Is

Amazon RDS for MySQL is not a new database engine. It is the same MySQL Community
or Enterprise binary you would install on a bare EC2 instance, wrapped in
automation. The MySQL process runs on an EC2 instance. The data directory sits on
an EBS volume. RDS adds the operational layer: automated patching, backups,
monitoring, and failover orchestration.

```
RDS MySQL — What You See vs What Runs

  Your Application
       |
       v
  ┌────────────────────────────────────────┐
  │          RDS Endpoint (DNS)            │
  │  writer: mydb.xxxxx.us-east-1.rds...   │
  │  reader: mydb-ro.xxxxx.us-east-1.rds...│
  └────────────────┬───────────────────────┘
                   |
                   v
  ┌────────────────────────────────────────┐
  │           EC2 Instance                 │
  │  ┌──────────────────────────────────┐  │
  │  │  mysqld (standard MySQL binary)  │  │
  │  │  - InnoDB buffer pool            │  │
  │  │  - Redo log on EBS               │  │
  │  │  - Binlog on EBS                 │  │
  │  │  - Data files (.ibd) on EBS      │  │
  │  └──────────────────────────────────┘  │
  │                                        │
  │  RDS Agent (monitoring, patching)      │
  └────────────────┬───────────────────────┘
                   |
                   v
  ┌────────────────────────────────────────┐
  │        EBS Volume (gp3/io1/io2)        │
  │  - Replicated within AZ               │
  │  - Max 64 TB                           │
  │  - gp3: 3,000 baseline IOPS, 125 MB/s │
  │  - io1: up to 64,000 IOPS             │
  │  - io2: up to 256,000 IOPS (Block     │
  │          Express)                      │
  └────────────────────────────────────────┘
```

### Instance Classes and Storage

RDS instances map directly to EC2 instance types. Understanding the tiers matters
because MySQL performance characteristics change dramatically at each level.

| Instance Class | vCPUs | RAM     | Network     | Use Case                              |
|---------------|-------|---------|-------------|---------------------------------------|
| db.t3.micro   | 2     | 1 GB    | Burst       | Dev/test only                         |
| db.t3.medium  | 2     | 4 GB    | Burst       | Small apps, buffer pool ~3 GB         |
| db.r6g.large  | 2     | 16 GB   | Up to 10G   | Production starts here                |
| db.r6g.2xlarge| 8     | 64 GB   | Up to 10G   | Mid-tier, buffer pool ~50 GB          |
| db.r6g.8xlarge| 32    | 256 GB  | 10G         | Large OLTP, buffer pool ~200 GB       |
| db.r6g.16xlarge| 64   | 512 GB  | 25G         | Max single-instance, buffer pool ~400 GB |

**Storage tiers** (recall from Chapter 11 — I/O is the bottleneck):

- **gp3**: 3,000 baseline IOPS, burstable. Cost-effective for most workloads.
  IOPS and throughput independently configurable up to 16,000 IOPS and 1,000 MB/s.
- **io1**: Provisioned IOPS up to 64,000. For latency-sensitive OLTP where you
  need deterministic I/O.
- **io2 Block Express**: Up to 256,000 IOPS with sub-millisecond latency. For
  extreme workloads. Only available on Nitro instances.

>>> In interviews, know that RDS MySQL inherits all of InnoDB's I/O
characteristics from Chapters 8-11. The buffer pool hit ratio, redo log write
throughput, and doublewrite overhead are identical to self-managed MySQL. RDS
does not change the engine — it automates the operations.

### Multi-AZ: Synchronous Replication

RDS Multi-AZ deploys a synchronous standby in a different Availability Zone.
This is NOT MySQL replication — it uses EBS-level synchronous block replication
or, on newer instance types, a transaction log–based synchronous mechanism.

```
RDS Multi-AZ Architecture

  ┌─────────────────────┐        ┌─────────────────────┐
  │   AZ-a (Primary)    │        │   AZ-b (Standby)    │
  │                     │        │                     │
  │  ┌───────────────┐  │  sync  │  ┌───────────────┐  │
  │  │    mysqld      │  │ block  │  │    mysqld      │  │
  │  │   (active)     │──│─repl──│──│  (passive)     │  │
  │  └───────┬───────┘  │        │  └───────┬───────┘  │
  │          │          │        │          │          │
  │  ┌───────▼───────┐  │        │  ┌───────▼───────┐  │
  │  │  EBS Volume   │  │  sync  │  │  EBS Volume   │  │
  │  │  (primary)    │──│───────│──│  (mirror)      │  │
  │  └───────────────┘  │        │  └───────────────┘  │
  └─────────────────────┘        └─────────────────────┘
           ▲
           │
      DNS endpoint
      (single writer)

  Failover: ~60 seconds
  - Detect primary failure
  - Promote standby
  - Flip DNS CNAME
  - Application reconnects
```

**Failover time is approximately 60 seconds.** This consists of failure detection
(~30s), DNS propagation (~30s), and InnoDB crash recovery on the standby. You
cannot read from the standby in Multi-AZ — it is a warm standby only, not a
read replica.

### Read Replicas

RDS supports up to **15 read replicas** using standard MySQL asynchronous
replication (the exact mechanism from Chapter 12 — binlog + relay log).

- Replicas can be in-region or cross-region
- Cross-region replicas use encrypted binlog transfer
- Each replica has its own EBS storage (full copy of data)
- Replication lag depends on write volume, network, and replica capacity

### Automated Backups and PITR

- Automated snapshots: EBS snapshots taken daily during the backup window
- Transaction logs (binlogs): continuously uploaded to S3
- PITR granularity: restorable to any second within the retention period (up to 35 days)
- Restore creates a NEW RDS instance (not in-place)

### Parameter Groups and Performance Insights

**Parameter groups** map directly to `my.cnf` configuration. Key parameters you
can tune (referencing earlier chapters):

- `innodb_buffer_pool_size` — Chapter 4
- `innodb_log_file_size` — Chapter 8
- `innodb_flush_log_at_trx_commit` — Chapter 8
- `max_connections` — Chapter 15
- `binlog_format` — Chapter 12

**Performance Insights** provides wait-event analysis similar to Oracle ASH. It
shows which queries are waiting on what resources (CPU, I/O, lock waits), mapped
to the internal thread and mutex architecture from Chapter 11.

### Limitations — What You Give Up

| Capability                   | Self-Managed | RDS MySQL |
|------------------------------|:----------:|:---------:|
| OS-level access (SSH)        | Yes        | No        |
| SUPER privilege              | Yes        | No        |
| Custom plugins               | Yes        | No        |
| Custom storage engines       | Yes        | No        |
| LOAD DATA LOCAL INFILE       | Yes        | Restricted|
| Direct filesystem access     | Yes        | No        |
| Arbitrary MySQL version      | Yes        | No (curated versions) |
| Binary log download          | Yes        | Via procedures|
| Custom SSL certificates      | Yes        | Managed only |

>>> RDS MySQL is the right answer when the interviewer asks "how do you run MySQL
in production at scale without a dedicated DBA team." It eliminates the
operational burden (patching, backups, monitoring) without changing any MySQL
internal behavior. For interviews: RDS is the operational answer. Aurora is
the architectural answer. Know the difference.

---

## 19.2 Amazon Aurora MySQL — The Storage Revolution

### The Key Architectural Insight

Aurora's central innovation is not a better MySQL. It is a fundamentally different
storage architecture that replaces InnoDB's local file I/O with a purpose-built,
log-structured distributed storage service. The MySQL compute layer (parser,
optimizer, executor, buffer pool) remains largely unchanged. Everything below the
storage API is new.

The insight, articulated in the 2017 SIGMOD paper: **"The log IS the database."**
In traditional MySQL, the write path produces four types of I/O: redo log, binlog,
data pages (doublewrite), and modified pages. Aurora eliminates all of them except
the redo log. The storage layer receives redo log records and reconstructs data
pages on demand.

```
Traditional MySQL Write Path vs Aurora Write Path

  TRADITIONAL MySQL (4x write amplification):
  
    Transaction Commit
         │
         ├──> 1. Redo log write        (WAL — sequential)
         ├──> 2. Binlog write          (sequential)
         ├──> 3. Doublewrite buffer    (sequential, then random)
         └──> 4. Data page flush       (random I/O)
    
    Total: 4 distinct I/O streams, each to local EBS
    Write amplification: ~4x the logical data change


  AURORA MySQL (1x — redo-only):
  
    Transaction Commit
         │
         └──> 1. Redo log records ──> Storage Service (6 copies)
    
    No binlog write (unless explicitly enabled)
    No doublewrite buffer (storage handles atomicity)
    No data page flush (storage materializes pages)
    
    Total: 1 network write (redo log records only)
    Write amplification: ~1x
```

>>> Aurora's write amplification reduction from 4x to 1x is perhaps the single
most important architectural insight in cloud databases. In an interview, you
should be able to explain: (1) What the four writes are in traditional MySQL,
(2) Why Aurora only needs one, (3) How the storage layer reconstructs pages
from redo records. This directly references Chapters 8 (redo log) and 9
(doublewrite buffer).

### Full Architecture — 6 Copies, 3 AZs, Quorum Protocol

Aurora stores data in a distributed storage volume spanning 3 Availability Zones.
Each 10 GB segment of data (called a "Protection Group") is replicated to 6
storage nodes — 2 per AZ. Writes use a 4/6 quorum. Reads use a 3/6 quorum.

```
Aurora Storage Architecture

  ┌─────────────────────────────────────────────────────────────────┐
  │                    Aurora Compute Layer                         │
  │                                                                 │
  │  ┌──────────────┐     ┌──────────────┐    ┌──────────────┐     │
  │  │  Writer       │     │  Reader       │    │  Reader       │    │
  │  │  Instance     │     │  Replica 1    │    │  Replica 2    │    │
  │  │              │     │              │    │              │     │
  │  │  Buffer Pool │     │  Buffer Pool │    │  Buffer Pool │     │
  │  │  Query Exec  │     │  Query Exec  │    │  Query Exec  │     │
  │  └──────┬───────┘     └──────┬───────┘    └──────┬───────┘     │
  │         │                    │                    │              │
  └─────────│────────────────────│────────────────────│──────────────┘
            │   Redo log         │   Page reads       │
            │   records only     │   from cache        │
            ▼                    ▼                    ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │              Aurora Distributed Storage Volume                  │
  │                                                                 │
  │  ┌─── AZ-a ────┐  ┌─── AZ-b ────┐  ┌─── AZ-c ────┐           │
  │  │              │  │              │  │              │           │
  │  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │          │
  │  │ │Storage   │ │  │ │Storage   │ │  │ │Storage   │ │          │
  │  │ │Node 1    │ │  │ │Node 3    │ │  │ │Node 5    │ │          │
  │  │ │(copy 1)  │ │  │ │(copy 3)  │ │  │ │(copy 5)  │ │          │
  │  │ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │          │
  │  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │          │
  │  │ │Storage   │ │  │ │Storage   │ │  │ │Storage   │ │          │
  │  │ │Node 2    │ │  │ │Node 4    │ │  │ │Node 6    │ │          │
  │  │ │(copy 2)  │ │  │ │(copy 4)  │ │  │ │(copy 6)  │ │          │
  │  │ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │          │
  │  └──────────────┘  └──────────────┘  └──────────────┘          │
  │                                                                 │
  │  Write quorum: 4 of 6 (survives AZ failure + 1 node failure)   │
  │  Read quorum:  3 of 6 (fast reads from nearest copies)         │
  │  Segment size: 10 GB (Protection Group)                        │
  │  Auto-scales:  10 GB to 128 TB                                  │
  └─────────────────────────────────────────────────────────────────┘
```

### Why 4/6 Write Quorum and 3/6 Read Quorum

The quorum arithmetic is not arbitrary. It is designed for a specific failure model:

- **Tolerate losing an entire AZ** (2 copies) **plus one additional node failure**:
  - Lose AZ-a (2 nodes) → 4 remaining nodes → still meet 4/6 write quorum? No.
  - So write quorum of 4/6 means: lose 1 AZ (2 nodes) and still write? 4 remain,
    need 4 → Yes, exactly at the boundary.
  - Lose 1 AZ + 1 extra node → 3 remaining → cannot write, but CAN still read
    (3/6 quorum met). System degrades to read-only, not offline.

- **Read availability**: 3/6 quorum means reads survive losing an entire AZ
  (2 nodes) plus one additional node (3 of 6 still available).

```
Failure Tolerance Matrix

  Failure Scenario          Nodes Lost  Remaining  Write(4)?  Read(3)?
  ─────────────────────────────────────────────────────────────────────
  Single node failure       1           5          Yes        Yes
  Two node failures (same AZ) 2        4          Yes        Yes
  Full AZ loss              2           4          Yes        Yes
  AZ loss + 1 node          3           3          No         Yes
  AZ loss + 2 nodes         4           2          No         No
  Two AZ loss               4           2          No         No
```

>>> In system design interviews, the 4/6 and 3/6 quorum is a frequent question.
The key insight: W + R > N (4 + 3 > 6) guarantees that every read sees at least
one copy that participated in the most recent write. This is the standard quorum
intersection property. Aurora applies it at the storage segment level, not at
the database instance level.

### Log-Is-The-Database — How It Works

When Aurora writes data, the following happens:

1. The compute node generates a redo log record (same format as InnoDB's redo log,
   Chapter 8).
2. The log record is sent to all 6 storage nodes for the relevant Protection Group.
3. Each storage node appends the log record to its local write-ahead log.
4. When 4 of 6 storage nodes acknowledge, the write is durable. The transaction
   can commit.
5. Storage nodes asynchronously apply redo log records to materialize data pages.
   This is called "log application" or "page materialization."
6. When a compute node needs a page that is not in its buffer pool, it reads
   from the storage service. The storage node returns a materialized page, or
   applies pending log records on the fly before returning.

```
Write Flow Detail

  Writer Instance                     Storage Nodes (1..6)
       │                                     │
       │  1. Generate redo log record         │
       │     (LSN = 100042)                   │
       │                                     │
       │  2. Send to all 6 nodes ───────────>│  Node 1: append log, ACK
       │                              ┌──────│  Node 2: append log, ACK
       │                              │      │  Node 3: append log, ACK
       │  3. Wait for 4 ACKs <───────┘      │  Node 4: append log, ACK
       │     (quorum met: 4/6)               │  Node 5: still replicating...
       │                                     │  Node 6: still replicating...
       │  4. Commit transaction               │
       │     (return success to client)       │
       │                                     │  5. Background: apply redo
       │                                     │     records to materialize
       │                                     │     data pages
       │                                     │
       │  6. Buffer pool miss?               │
       │     Read page from storage ────────>│  Return materialized page
       │     (page = base + applied logs)    │
```

The redo log records are the authoritative source of truth. Data pages are a cache
that can always be reconstructed from the log. This is why Aurora can separate
compute from storage — the compute node does not need local persistent storage for
data files.

### Aurora Replicas — Shared Storage, Minimal Lag

Unlike RDS read replicas (which use binlog-based async replication and maintain
separate storage copies), Aurora Replicas share the SAME storage volume as the
writer.

```
RDS Read Replica                    Aurora Replica
                                    
  Writer ──binlog──> Replica         Writer ──(redo)──> Storage
  [EBS 1]            [EBS 2]                              ▲
                                     Replica ─────────────┘
  - Full data copy on replica                (shared storage)
  - Seconds to minutes lag          
  - Binlog transfer over network    - No data copy on replica
                                    - ~10-20ms lag (cache invalidation)
                                    - Writer sends cache invalidation
                                      messages to replicas
```

Aurora supports up to **15 replicas** (vs 5 for RDS). Replica lag is typically
10-20ms because replicas only need to invalidate stale pages in their buffer
pools — they do not replay binlog events. When a replica needs a page, it reads
from the shared storage volume, which already has the latest data.

### Aurora Serverless v2

Aurora Serverless v2 adds automatic compute scaling. The database scales between
a minimum and maximum capacity, measured in Aurora Capacity Units (ACUs).
One ACU is approximately 2 GB of RAM.

```
Aurora Serverless v2 Scaling

  Load ──────────────────────────────────────────────>

  ACU
  128 |                                    ┌────────
      |                                ┌───┘
   64 |                            ┌───┘
      |                        ┌───┘
   32 |                    ┌───┘
      |                ┌───┘
   16 |            ┌───┘
      |        ┌───┘
    4 |    ┌───┘
      |┌───┘
  0.5 |┘                                          
      +──────────────────────────────────────────── time
       idle          ramp up              peak

  - Min: 0.5 ACU (~1 GB RAM)
  - Max: configurable, up to 256 ACU (~512 GB RAM)
  - Scaling increment: 0.5 ACU
  - Scaling speed: seconds (not minutes)
  - You pay for what you use, per-second billing
```

>>> Aurora Serverless v2 is the answer for variable-workload scenarios in
interviews: "We have a SaaS platform where tenants have unpredictable traffic
patterns." The key point: compute scales, but storage is always the same
distributed volume — there is no cold start for data access, only for compute.

### Aurora Global Database

Aurora Global Database replicates an entire Aurora cluster to one or more
secondary regions. It uses dedicated storage-level replication — not binlog
replication.

```
Aurora Global Database

  ┌─────────── Primary Region (us-east-1) ──────────────┐
  │                                                      │
  │  Writer ──> Aurora Storage Volume                    │
  │             │                                        │
  │             │  Storage-level replication              │
  └─────────────│────────────────────────────────────────┘
                │  (typically <1 second lag)
                ▼
  ┌─────────── Secondary Region (eu-west-1) ────────────┐
  │                                                      │
  │  Aurora Storage Volume (read-only)                   │
  │             │                                        │
  │  Reader ────┘                                        │
  │  (can be promoted to writer in <1 minute)            │
  └──────────────────────────────────────────────────────┘

  RPO: < 1 second (typical replication lag)
  RTO: < 1 minute (promote secondary to primary)
  
  Use cases:
  - Disaster recovery across regions
  - Low-latency reads for global users
  - Regulatory compliance (data residency)
```

### Aurora Parallel Query

Parallel Query pushes predicate evaluation and aggregation down to the storage
layer. Instead of the compute node fetching millions of pages and filtering,
the storage nodes evaluate WHERE clauses and return only matching rows.

```
Traditional Query Path:
  Compute: "Give me all pages for table orders"
  Storage: sends 1,000,000 pages
  Compute: filters WHERE status = 'pending' → 1,000 rows

Parallel Query Path:
  Compute: "Give me rows from orders WHERE status = 'pending'"
  Storage: scans pages internally, applies predicate
  Storage: returns 1,000 matching rows
  Network transfer: reduced by 1000x
```

This is conceptually similar to predicate pushdown in distributed query engines
(Spark, Presto). It helps most for analytical queries over large tables — OLTP
point lookups already use indexes and transfer minimal data.

### Aurora Backtrack — Time Travel Without Restoring

Backtrack allows you to rewind an Aurora cluster to a specific point in time
without restoring from a backup. It uses the redo log history stored in the
storage layer.

```
  Accidental DELETE at 14:00:05
  
  Traditional recovery:
    1. Find most recent backup (13:00:00)
    2. Restore to new instance (~30 min for large DBs)
    3. Apply binlogs from 13:00:00 to 14:00:04
    4. Extract corrected data
    5. Merge into production
    Total: hours
  
  Aurora Backtrack:
    1. CALL mysql.rds_backtrack_db(14, 0, 4)
       -- rewind to 14:00:04
    2. Done. Database is at pre-DELETE state.
    Total: seconds to minutes
    
  - Configurable window: up to 72 hours
  - Cost: proportional to change rate (stored redo records)
  - Caution: backtrack rewinds the ENTIRE cluster
```

### Aurora Limitations

Despite its architectural advantages, Aurora has real constraints:

| Limitation                        | Detail                                          |
|-----------------------------------|------------------------------------------------|
| No MyISAM or other engines        | InnoDB only. System tables use Aurora-native.    |
| Cost premium                      | 20-50% more than equivalent RDS MySQL            |
| Vendor lock-in                    | Storage format is proprietary; no migration path to self-managed MySQL storage |
| No direct storage access          | Cannot attach Aurora storage to another engine   |
| MySQL version lag                 | Aurora MySQL tracks upstream MySQL but lags behind community releases |
| Binlog overhead                   | If you enable binlog (for external replication), you lose some write amplification benefit |
| Backtrack limitations             | Rewinds the entire cluster; cannot backtrack a single table |
| Cross-region write forwarding     | Available but adds latency (write to primary region) |

---

## 19.3 Aurora vs RDS MySQL — Decision Matrix

This table codifies the architectural differences. Every cell maps to a concept
from earlier chapters.

```
┌───────────────────────┬──────────────────────────┬──────────────────────────┐
│ Dimension             │ RDS MySQL                │ Aurora MySQL             │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Engine                │ Vanilla MySQL (Community │ Modified MySQL with      │
│                       │ or Enterprise binary)    │ custom storage API       │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Storage               │ EBS (gp3/io1/io2)        │ Distributed, log-        │
│                       │ Single-AZ volume         │ structured, 3 AZ, 6     │
│                       │                          │ copies                   │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Write amplification   │ ~4x (redo + binlog +     │ ~1x (redo only)          │
│                       │ doublewrite + page flush)│                          │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Max storage           │ 64 TB                    │ 128 TB                   │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Write failover time   │ ~60s (Multi-AZ)          │ ~30s (replica promotion) │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Read replicas         │ Up to 15 (async, binlog) │ Up to 15 (shared storage,│
│                       │ Seconds–minutes lag      │ ~10-20ms lag)            │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Replica storage       │ Full copy per replica    │ Shared (no extra storage │
│                       │                          │ cost for replicas)       │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Cross-region          │ Cross-region read replica│ Global Database (<1s     │
│                       │ (async binlog)           │ storage-level repl)      │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Backtrack             │ Not available            │ Up to 72 hours           │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Parallel query        │ Not available            │ Push predicates to       │
│                       │                          │ storage layer            │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Serverless            │ Not available            │ Serverless v2 (0.5-256   │
│                       │                          │ ACU, per-second billing) │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Cost (normalized)     │ 1x                       │ 1.2x - 1.5x             │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Portability           │ High (standard MySQL)    │ Low (proprietary storage)│
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ Best for              │ Lift-and-shift, cost-    │ High write throughput,   │
│                       │ sensitive, need MySQL    │ fast failover, need      │
│                       │ compatibility            │ replicas with low lag    │
└───────────────────────┴──────────────────────────┴──────────────────────────┘
```

>>> The interview question "When would you choose RDS over Aurora?" has a specific
correct answer: when cost matters more than write throughput, when you need exact
MySQL binary compatibility (e.g., specific plugins), or when you want portability
to migrate to self-managed MySQL later. Aurora wins on everything else.

---

## 19.4 Google Cloud SQL for MySQL

### Architecture

Google Cloud SQL for MySQL is Google's managed MySQL equivalent of RDS. The
underlying engine is standard MySQL 5.7 or 8.0 running on Compute Engine VMs
with Persistent Disk storage.

```
Cloud SQL Architecture

  ┌────────────────────────────────────────────────┐
  │            Cloud SQL Instance                   │
  │                                                 │
  │  ┌──────────────────────────────────────┐       │
  │  │  mysqld (standard MySQL 5.7 / 8.0)  │       │
  │  └──────────────┬───────────────────────┘       │
  │                 │                               │
  │  ┌──────────────▼───────────────────────┐       │
  │  │  Persistent Disk (SSD or HDD)        │       │
  │  │  - Regional PD: sync replicated      │       │
  │  │  - Up to 64 TB                       │       │
  │  └──────────────────────────────────────┘       │
  │                                                 │
  │  Cloud SQL Proxy (sidecar for auth + encryption)│
  └────────────────────────────────────────────────┘
```

### High Availability

Cloud SQL HA uses regional Persistent Disk (synchronous replication across zones)
combined with a standby instance. Failover is automatic but typically takes
approximately 60-120 seconds — similar to RDS Multi-AZ.

### Read Replicas

- Up to 10 read replicas per primary
- Async MySQL replication (binlog-based, like Chapter 12)
- Cross-region replicas supported
- Can promote a replica to standalone instance

### Cloud SQL Insights

Cloud SQL Insights provides query-level performance analysis: query fingerprinting,
wait-event analysis, and lock-wait detection. It is Google's equivalent of
Performance Insights / Performance Schema.

### Cloud SQL Proxy

The Cloud SQL Proxy is a sidecar process that handles authentication and encrypted
connections to Cloud SQL instances. It replaces the need for IP whitelisting and
SSL certificate management.

```
Application Pod                     Google Cloud
┌─────────────────┐                 ┌──────────────────────┐
│                 │                 │                      │
│  App ──> localhost:3306           │   Cloud SQL Instance │
│           │                      │                      │
│  Cloud SQL Proxy ───IAM auth────>│   mysqld             │
│  (sidecar)       encrypted       │                      │
│                                  │                      │
└─────────────────┘                 └──────────────────────┘
```

### AlloyDB for PostgreSQL

Google's response to Aurora is AlloyDB — but it is PostgreSQL-based, not MySQL.
For MySQL workloads on GCP, Cloud SQL remains the primary option. There is no
"Aurora-equivalent" for MySQL on Google Cloud.

---

## 19.5 Azure Database for MySQL — Flexible Server

### Architecture

Azure Database for MySQL Flexible Server replaced the older "Single Server" tier.
It runs standard MySQL 5.7 or 8.0 on Azure VMs with managed disks.

### HA Modes

```
Azure MySQL Flexible Server HA Options

  Mode 1: Same-Zone HA
  ┌────────────────────────────────────────┐
  │  Availability Zone A                   │
  │                                        │
  │  Primary ──sync──> Standby             │
  │  [Managed Disk]    [Managed Disk]      │
  │                                        │
  │  Failover: ~60s, no cross-zone latency│
  └────────────────────────────────────────┘

  Mode 2: Zone-Redundant HA
  ┌────────────────┐    ┌────────────────┐
  │  AZ-1           │    │  AZ-2           │
  │                 │    │                 │
  │  Primary        │sync│  Standby        │
  │  [Managed Disk] │───>│  [Managed Disk] │
  │                 │    │                 │
  │  Failover: ~120s (cross-zone)         │
  └────────────────┘    └────────────────┘
```

### Read Replicas and Integrations

- Up to 10 read replicas (async replication)
- Azure Active Directory (Entra ID) integration for authentication
- Azure Monitor integration for metrics and alerts
- Data-in and Data-out encryption with Azure managed keys

>>> For interviews, Azure MySQL is rarely the deep-dive topic. Know that it
exists, that it uses standard MySQL replication internally, and that the
architectural trade-offs (managed operations vs. no OS access) are identical to
RDS. The differentiator is enterprise Azure ecosystem integration (Entra ID,
Azure Monitor, Azure Private Link).

---

## 19.6 PlanetScale — Vitess as a Service

### What PlanetScale Actually Is

PlanetScale is a managed, horizontally-scalable MySQL service built on **Vitess**,
the sharding middleware originally developed at YouTube to scale MySQL. PlanetScale
does not run a single MySQL instance — it orchestrates a fleet of MySQL instances
(called "vttablets") behind a routing layer (called "vtgate").

```
PlanetScale Architecture (Vitess Under the Hood)

  Application
       │
       ▼
  ┌────────────────────────────────────────────────────────┐
  │                    VTGate Layer                         │
  │  (SQL-aware proxy: query routing, scatter-gather)      │
  │                                                        │
  │  - Parses incoming SQL                                 │
  │  - Determines which shard(s) to hit                    │
  │  - Routes single-shard queries directly                │
  │  - Executes cross-shard queries with scatter-gather    │
  │  - Connection pooling (hundreds of app conns →         │
  │    tens of MySQL conns per shard)                      │
  └───────┬──────────────┬──────────────┬──────────────────┘
          │              │              │
          ▼              ▼              ▼
  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │  Shard -80   │ │  Shard 80-c0 │ │  Shard c0-   │
  │              │ │              │ │              │
  │ ┌──────────┐ │ │ ┌──────────┐ │ │ ┌──────────┐ │
  │ │ Primary  │ │ │ │ Primary  │ │ │ │ Primary  │ │
  │ │ (vttablet│ │ │ │ (vttablet│ │ │ │ (vttablet│ │
  │ │  +mysqld)│ │ │ │  +mysqld)│ │ │ │  +mysqld)│ │
  │ └──────────┘ │ │ └──────────┘ │ │ └──────────┘ │
  │ ┌──────────┐ │ │ ┌──────────┐ │ │ ┌──────────┐ │
  │ │ Replica  │ │ │ │ Replica  │ │ │ │ Replica  │ │
  │ │ (vttablet│ │ │ │ (vttablet│ │ │ │ (vttablet│ │
  │ │  +mysqld)│ │ │ │  +mysqld)│ │ │ │  +mysqld)│ │
  │ └──────────┘ │ │ └──────────┘ │ │ └──────────┘ │
  └──────────────┘ └──────────────┘ └──────────────┘
  
  Each shard = autonomous MySQL instance
  Sharding key = hash of primary key (or custom vindex)
  VTGate is stateless and horizontally scalable
```

### Branching — Git for Database Schemas

PlanetScale's signature developer experience feature is schema branching. You
create a branch of your database schema (not data), make schema changes on the
branch, and open a "Deploy Request" — analogous to a pull request.

```
PlanetScale Branching Workflow

  main (production schema)
    │
    ├── CREATE BRANCH "add-orders-index"
    │   │
    │   │  ALTER TABLE orders ADD INDEX idx_status (status);
    │   │
    │   └── Open Deploy Request
    │       │
    │       │  Schema diff review (like a code diff):
    │       │  + ADD INDEX idx_status ON orders (status)
    │       │
    │       ├── CI checks: compatibility analysis
    │       │   - Will this lock the table?
    │       │   - Estimated time for large tables?
    │       │
    │       └── Deploy (merge) → applied to production
    │           using Online DDL (gh-ost / pt-osc internally)
    │
    main (updated schema)
```

### Non-Blocking Schema Changes

All schema changes in PlanetScale are applied using online DDL tools (internally
using a mechanism similar to gh-ost or Vitess's own online DDL). This means:

- No table locks during ALTER TABLE
- Writes continue during schema migration
- Automatic rollback if the migration fails
- Progress tracking and cancellation

This is critical because in traditional MySQL, an ALTER TABLE on a 500 GB table
can lock writes for hours (Chapter 13 discussed the implications of DDL on
InnoDB's clustered index).

### Connection Model

PlanetScale uses a connection-pooling model that is fundamentally different from
direct MySQL connections:

```
Traditional MySQL:       PlanetScale:
                         
  App (1000 conns)        App (1000 conns)
       │                       │
       ▼                       ▼
  mysqld                  VTGate (stateless proxy)
  (1000 threads,               │
   each with stack,        Multiplexed to
   sort buffer,            10-20 actual MySQL
   join buffer...)         connections per shard
                                │
                           mysqld (per shard)
                           (10-20 threads)
```

This addresses the connection scaling problem from Chapter 15 — PlanetScale
gives you effectively unlimited application connections without the memory
overhead of maintaining thousands of MySQL threads.

### Boost — Query Caching

PlanetScale Boost is a managed query cache that sits in front of the MySQL
shards. Unlike MySQL's old query cache (removed in 8.0 due to the global mutex
problem described in Chapter 1), Boost is:

- External to MySQL (no mutex contention)
- Automatically invalidated based on table modifications
- Compatible with parameterized queries
- Configurable TTL per query pattern

### Insights

PlanetScale Insights provides per-query analytics: latency percentiles, rows
examined vs returned, and query frequency. It maps directly to the slow query
log and Performance Schema concepts from Chapter 2, but presented as a managed
dashboard.

### PlanetScale Limitations

| Limitation                       | Reason                                           |
|----------------------------------|--------------------------------------------------|
| No foreign keys                  | Vitess cannot enforce FK constraints across shards. Cross-shard FK would require distributed transactions on every write. |
| No stored procedures             | Vitess SQL parser does not support procedure execution across shards. |
| No triggers                      | Same limitation — triggers are shard-local but Vitess cannot guarantee cross-shard trigger semantics. |
| No LOCK TABLES                   | Not meaningful in a sharded environment. |
| Limited JOIN across shards       | Cross-shard JOINs use scatter-gather, which is slow for large result sets. |
| No direct MySQL access           | You connect through VTGate, not directly to mysqld. |
| No custom MySQL plugins          | Vitess manages the MySQL instances. |

>>> PlanetScale is the interview answer for "How do you scale MySQL writes
horizontally?" The key trade-off to articulate: you get horizontal write scaling
by giving up foreign keys, stored procedures, and some JOIN capabilities. If
your schema uses FKs heavily, PlanetScale requires a redesign. If your schema
is already service-oriented with application-enforced referential integrity,
PlanetScale is a natural fit.

---

## 19.7 TiDB — MySQL-Compatible NewSQL

### Architecture

TiDB is an open-source, distributed SQL database that speaks the MySQL wire
protocol but stores data in a completely different engine. It is not MySQL with
sharding bolted on (like Vitess/PlanetScale). It is a new database built from
scratch that happens to be MySQL-compatible.

```
TiDB Architecture

  ┌─────────────────────────────────────────────────────────────────┐
  │                      TiDB Server Layer                         │
  │              (Stateless SQL Processing Nodes)                  │
  │                                                                 │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
  │  │ TiDB     │  │ TiDB     │  │ TiDB     │  │ TiDB     │       │
  │  │ Server 1 │  │ Server 2 │  │ Server 3 │  │ Server N │       │
  │  │          │  │          │  │          │  │          │       │
  │  │ - Parser │  │ - Parser │  │ - Parser │  │ - Parser │       │
  │  │ - Optim. │  │ - Optim. │  │ - Optim. │  │ - Optim. │       │
  │  │ - Exec.  │  │ - Exec.  │  │ - Exec.  │  │ - Exec.  │       │
  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘       │
  └───────│──────────────│──────────────│──────────────│─────────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                    PD (Placement Driver)                        │
  │                  (Cluster Metadata + TSO)                       │
  │                                                                 │
  │  - Timestamp Oracle (TSO): generates globally ordered           │
  │    timestamps for transactions (like a Lamport clock)           │
  │  - Region metadata: which TiKV node holds which key range      │
  │  - Scheduling: balances regions across TiKV nodes               │
  │  - Leader election: Raft-based, typically 3 or 5 PD nodes      │
  └─────────────────────────────────────────────────────────────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                      TiKV Storage Layer                         │
  │              (Distributed Key-Value Store)                      │
  │                                                                 │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
  │  │ TiKV Node 1  │  │ TiKV Node 2  │  │ TiKV Node 3  │          │
  │  │              │  │              │  │              │          │
  │  │ Region A     │  │ Region A     │  │ Region A     │          │
  │  │ (leader)     │  │ (follower)   │  │ (follower)   │          │
  │  │              │  │              │  │              │          │
  │  │ Region B     │  │ Region B     │  │ Region C     │          │
  │  │ (follower)   │  │ (leader)     │  │ (leader)     │          │
  │  │              │  │              │  │              │          │
  │  │ RocksDB      │  │ RocksDB      │  │ RocksDB      │          │
  │  │ (local KV)   │  │ (local KV)   │  │ (local KV)   │          │
  │  └──────────────┘  └──────────────┘  └──────────────┘          │
  │                                                                 │
  │  Each Region: ~96 MB of contiguous key range                    │
  │  Raft group: 3 replicas per Region (configurable)               │
  │  Split/merge: automatic when region grows/shrinks               │
  └─────────────────────────────────────────────────────────────────┘
          │              │              │              
          ▼              ▼              ▼              
  ┌─────────────────────────────────────────────────────────────────┐
  │                    TiFlash (Columnar Store)                     │
  │                   (Optional OLAP Acceleration)                  │
  │                                                                 │
  │  - Columnar replicas of selected tables                         │
  │  - Asynchronously replicated from TiKV via Raft Learner        │
  │  - Enables HTAP: OLTP on TiKV, OLAP on TiFlash                │
  │  - Optimizer automatically routes analytical queries to TiFlash │
  └─────────────────────────────────────────────────────────────────┘
```

### Raft Consensus — How Data Stays Consistent

Every Region (key range) in TiKV is replicated using the Raft consensus protocol.
This means every write to a Region must be agreed upon by a majority of replicas
before it is committed.

```
Raft Write Flow for a Single Region

  Client: INSERT INTO orders (id, amount) VALUES (42, 100.00)
       │
       ▼
  TiDB Server: translates SQL to KV operations
       │  key = tablePrefix_orders_42
       │  value = encoded(id=42, amount=100.00)
       │
       ▼
  PD: "Region for key range [orders_40..orders_50] → Region R7,
       leader = TiKV Node 2"
       │
       ▼
  TiKV Node 2 (Region R7 leader):
       │
       ├── 1. Append to local Raft log
       │
       ├── 2. Send AppendEntries RPC to followers:
       │      → TiKV Node 1 (R7 follower): ACK
       │      → TiKV Node 3 (R7 follower): ACK
       │
       ├── 3. Majority (2/3) acknowledged → committed
       │
       ├── 4. Apply to local RocksDB (state machine)
       │
       └── 5. Return success to TiDB Server → Client
```

### Distributed Transactions — Percolator Model

TiDB implements distributed transactions using a variant of Google's Percolator
protocol (from the 2010 OSDI paper). This is a two-phase commit protocol built
on top of the key-value layer.

```
TiDB Distributed Transaction (Percolator 2PC)

  Transaction: UPDATE accounts SET balance = balance - 100 WHERE id = 1;
               UPDATE accounts SET balance = balance + 100 WHERE id = 2;
  
  Phase 1: Prewrite
  ──────────────────
  1. TiDB gets start_ts from PD's TSO (e.g., ts=100)
  2. Choose a "primary key" (e.g., accounts_1)
  3. For each key involved:
     - Write a lock: {key=accounts_1, ts=100, type=LOCK, primary=accounts_1}
     - Write the new value: {key=accounts_1, ts=100, type=DATA, value=...}
     - Lock check: if another transaction's lock exists → conflict → retry or abort
  4. All prewrites succeed → ready to commit
  
  Phase 2: Commit
  ──────────────────
  5. TiDB gets commit_ts from PD's TSO (e.g., ts=105)
  6. Write commit record for primary key:
     {key=accounts_1, ts=100, type=WRITE, commit_ts=105}
  7. Primary committed → transaction is committed
  8. Asynchronously commit secondary keys:
     {key=accounts_2, ts=100, type=WRITE, commit_ts=105}
  9. Clean up locks
  
  MVCC:
  - Readers at ts=99 see old values (before this transaction)
  - Readers at ts=106 see new values
  - No global lock manager needed — locks are stored in KV layer
```

>>> Percolator's key insight: once the primary key's commit record is written,
the transaction is committed — even if the process crashes before writing
secondary commit records. Recovery can determine transaction status by checking
the primary key. This is fundamentally different from InnoDB's undo-log-based
MVCC (Chapter 7) and is a common distributed systems interview topic.

### HTAP — Hybrid Transactional/Analytical Processing

TiDB's HTAP capability comes from maintaining two physical representations of
the same data:

```
HTAP Data Flow

  Write ──> TiKV (Row Store, Raft)
                │
                │  Raft Learner (async)
                ▼
            TiFlash (Column Store)

  OLTP Query (point lookup, small range scan):
    TiDB → TiKV  (row-optimized, B-Tree-like access)

  OLAP Query (aggregation, scan-heavy):
    TiDB → TiFlash  (columnar, vectorized execution)

  Mixed workload: optimizer chooses automatically
  based on cost estimation
```

### MySQL Compatibility Level

TiDB aims for MySQL compatibility but is not a drop-in replacement.

| Feature                         | MySQL 8.0     | TiDB          |
|---------------------------------|:------------:|:-------------:|
| MySQL wire protocol             | Yes          | Yes           |
| SQL syntax (DML)                | Full         | ~95%          |
| SQL syntax (DDL)                | Full         | ~90%          |
| Stored procedures               | Yes          | Limited       |
| Triggers                        | Yes          | No            |
| Foreign keys                    | Yes          | Experimental  |
| Window functions                | Yes          | Yes           |
| CTEs                            | Yes          | Yes           |
| JSON functions                  | Yes          | Yes           |
| AUTO_INCREMENT behavior         | Sequential   | Non-sequential (distributed allocation) |
| Transaction isolation           | All 4 levels | SI + RC (no RU, no true Serializable) |
| Character sets                  | Full         | utf8mb4 primary |
| INFORMATION_SCHEMA              | Full         | Partial       |
| Optimizer hints                 | MySQL syntax | TiDB-specific  |

### TiDB Limitations

| Limitation                                | Impact                                            |
|-------------------------------------------|---------------------------------------------------|
| Higher latency for single-row operations  | Raft consensus adds 1-3ms per write vs InnoDB's local fsync |
| No true Serializable isolation            | Snapshot Isolation can have write skew anomalies   |
| Non-sequential AUTO_INCREMENT             | Applications assuming monotonic IDs will break     |
| Some MySQL syntax unsupported             | Stored procedures, certain DDL variations          |
| Operational complexity                    | PD + TiKV + TiDB + TiFlash = many components      |
| Network partition sensitivity             | Raft requires majority; minority partitions stall  |

---

## 19.8 Comparison Table — MySQL vs Aurora vs PlanetScale vs TiDB

```
┌──────────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│ Dimension        │ MySQL (self) │ Aurora MySQL │ PlanetScale  │ TiDB         │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Wire protocol    │ MySQL        │ MySQL        │ MySQL        │ MySQL        │
│                  │              │              │ (via VTGate) │              │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Storage engine   │ InnoDB       │ Aurora       │ InnoDB       │ TiKV         │
│                  │ (local disk) │ (distributed │ (per shard)  │ (Raft +      │
│                  │              │ log-struct.) │              │ RocksDB)     │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Horizontal write │ No (single   │ No (single   │ Yes (Vitess  │ Yes (Raft    │
│ scaling          │ writer)      │ writer)      │ sharding)    │ regions,     │
│                  │              │              │              │ auto-split)  │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Max write        │ 1 node       │ 1 node       │ N shards     │ N TiKV nodes │
│ throughput       │              │ (faster I/O) │              │              │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Consistency      │ Serializable │ Serializable │ Per-shard    │ Snapshot     │
│ model            │ (InnoDB)     │ (InnoDB)     │ Serializable │ Isolation    │
│                  │              │              │ Cross-shard  │ (global)     │
│                  │              │              │ eventual     │              │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ OLAP support     │ Poor (row    │ Parallel     │ Poor (row    │ TiFlash      │
│                  │ store only)  │ Query helps  │ store only)  │ (columnar,   │
│                  │              │              │              │ real HTAP)   │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Ops complexity   │ High (you    │ Low (managed │ Low (fully   │ Medium-High  │
│                  │ manage all)  │ by AWS)      │ managed)     │ (many comps) │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Foreign keys     │ Yes          │ Yes          │ No           │ Experimental │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Stored procs     │ Yes          │ Yes          │ No           │ Limited      │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Vendor lock-in   │ None         │ High (AWS)   │ Medium       │ Low (OSS)    │
│                  │              │              │ (Vitess OSS) │              │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Cost model       │ Infra only   │ Per-instance │ Per-row-read │ Infra or     │
│                  │              │ + I/O + stor.│ + storage    │ TiDB Cloud   │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Best for         │ Full control,│ High write   │ Horizontal   │ Global dist.,│
│                  │ cost-        │ throughput,  │ write scale, │ HTAP, strong │
│                  │ sensitive    │ fast failover│ schema mgmt  │ consistency  │
└──────────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
```

>>> This comparison table is the synthesis of the entire chapter. In a system
design interview, when asked "Which MySQL-compatible database would you choose
for X?", use this matrix to structure your answer. Start with the workload
characteristics (read-heavy vs write-heavy, OLTP vs OLAP, single-region vs
multi-region), then map to the right column.

---

## 19.9 Migration Strategies

### MySQL to Aurora — Snapshot or DMS

```
Strategy 1: Snapshot Migration (fastest, but requires downtime)

  Source: RDS MySQL or self-managed MySQL
  
  1. Create RDS MySQL snapshot (or Percona XtraBackup for self-managed)
  2. Restore snapshot as Aurora cluster
     aws rds restore-db-cluster-from-snapshot \
       --db-cluster-identifier my-aurora \
       --snapshot-identifier my-mysql-snapshot \
       --engine aurora-mysql
  3. Verify data integrity
  4. Point application to Aurora endpoint
  
  Downtime: minutes (snapshot) to hours (large databases)
  Data loss: only writes during cutover window


Strategy 2: DMS Continuous Replication (near-zero downtime)

  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │  Source   │     │   DMS    │     │  Aurora   │
  │  MySQL    │────>│  Task    │────>│  Target   │
  │          │     │          │     │          │
  └──────────┘     └──────────┘     └──────────┘
  
  1. Create DMS replication instance
  2. Create source endpoint (MySQL) and target endpoint (Aurora)
  3. Create migration task with:
     - Full load: initial bulk copy
     - CDC (Change Data Capture): ongoing replication via binlog
  4. Monitor replication lag until caught up
  5. Stop writes to source, wait for CDC to drain
  6. Switch application to Aurora endpoint
  
  Downtime: seconds (just the final cutover)
```

### MySQL to PlanetScale — Import Tool

```
PlanetScale Import Flow

  1. Schema preparation:
     - Remove foreign key constraints (PlanetScale does not support FK)
     - Remove triggers and stored procedures
     - Ensure AUTO_INCREMENT columns use BIGINT
  
  2. Import:
     pscale database create mydb --region us-east
     pscale database import mydb \
       --host source-mysql.example.com \
       --port 3306 \
       --user import_user
  
  3. PlanetScale reads binlog for continuous sync
  
  4. Verification:
     - Row counts per table
     - Checksum comparison
     - Application smoke tests against PlanetScale branch
  
  5. Cutover:
     - Update application connection string to PlanetScale endpoint
     - PlanetScale stops reading source binlog
  
  Critical pre-migration step: refactor application to remove
  dependency on FK enforcement, stored procedures, and triggers.
  This is often the longest part of the migration (weeks to months).
```

### MySQL to TiDB — Lightning and DM

```
TiDB Migration Tools

  Tool 1: TiDB Lightning (bulk initial load)
  ──────────────────────────────────────────
  - Reads MySQL dump files (mysqldump or Dumpling output)
  - Converts to TiKV SST files
  - Ingests directly into TiKV (bypasses SQL layer)
  - Speed: hundreds of GB per hour
  
  Dumpling ──> SQL/CSV files ──> TiDB Lightning ──> TiKV (SST ingest)
  
  
  Tool 2: TiDB DM (Data Migration — continuous replication)
  ─────────────────────────────────────────────────────────
  - Reads MySQL binlog (like a MySQL replica)
  - Translates binlog events to TiDB SQL
  - Handles schema conversion automatically
  - Supports shard merging (multiple MySQL → one TiDB)
  
  MySQL Primary ──binlog──> DM Worker ──SQL──> TiDB Server
  
  
  Combined Migration Pattern:
  
  1. Use Dumpling to export consistent snapshot
  2. Use TiDB Lightning to bulk-load snapshot
  3. Start DM from the binlog position of the snapshot
  4. DM catches up with real-time changes
  5. Verify data consistency (sync-diff-inspector)
  6. Cutover: redirect application traffic to TiDB
```

### General Migration Pattern

Regardless of the target, every MySQL migration follows the same logical pattern:

```
Universal MySQL Migration Pattern

  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
  │  Setup  │───>│ Initial │───>│Continuous│───>│ Verify  │───>│ Cutover │
  │         │    │  Load   │    │  Repl.   │    │         │    │         │
  └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
       │              │              │              │              │
       ▼              ▼              ▼              ▼              ▼
  - Provision     - Snapshot     - Binlog-based  - Row counts   - Stop writes
    target          export         CDC             checksum       to source
  - Network       - Bulk import  - Monitor lag   - Data diff    - Wait for
    connectivity  - Schema        - Handle         (sync-diff)    repl drain
  - Credentials    conversion      conflicts     - App smoke    - Switch DNS
  - Schema prep                                    tests          or conn str
    (FK removal                                  - Perf         - Verify
    for PS,                                        benchmark      writes on
    type compat                                                   target
    for TiDB)                                                   - Rollback
                                                                  plan ready
```

>>> In interviews, the migration pattern matters more than the specific tool.
Show that you understand: (1) Initial load vs continuous replication, (2) The
critical moment of cutover — you need to stop writes to the source and wait for
replication to drain, (3) Verification before cutover (never skip checksums),
(4) A rollback plan that reverses the direction.

---

## 19.10 Cloud MySQL Selection Guide

### Decision Tree

```
Cloud MySQL Selection Decision Tree

  START: Do you need MySQL compatibility?
    │
    ├── No ──> This chapter does not apply. Consider PostgreSQL,
    │          DynamoDB, Cassandra, etc.
    │
    └── Yes
         │
         ├── Do you need horizontal write scaling?
         │    │
         │    ├── No
         │    │    │
         │    │    ├── AWS?
         │    │    │    │
         │    │    │    ├── Write-heavy, need fast failover?
         │    │    │    │    │
         │    │    │    │    ├── Yes ──> AURORA MySQL
         │    │    │    │    │   (1x write amp, 30s failover,
         │    │    │    │    │    shared storage replicas)
         │    │    │    │    │
         │    │    │    │    └── No ──> RDS MySQL
         │    │    │    │        (cheaper, full MySQL compat,
         │    │    │    │         standard InnoDB behavior)
         │    │    │    │
         │    │    │    └── Need serverless / variable load?
         │    │    │         ──> AURORA Serverless v2
         │    │    │
         │    │    ├── GCP? ──> Cloud SQL for MySQL
         │    │    │            (or AlloyDB if you can use Postgres)
         │    │    │
         │    │    └── Azure? ──> Azure MySQL Flexible Server
         │    │
         │    └── Yes
         │         │
         │         ├── Need strong global consistency?
         │         │    │
         │         │    ├── Yes ──> TiDB
         │         │    │   (Raft consensus, Percolator 2PC,
         │         │    │    true distributed transactions,
         │         │    │    HTAP with TiFlash)
         │         │    │
         │         │    └── No (per-shard consistency OK)
         │         │         ──> PlanetScale
         │         │             (Vitess sharding, managed,
         │         │              schema branching, but no FK)
         │         │
         │         └── Need HTAP (analytics + transactions)?
         │              ──> TiDB (TiFlash columnar store)
         │
         └── Special considerations:
              │
              ├── Must avoid vendor lock-in?
              │    ──> Self-managed MySQL or TiDB (open source)
              │
              ├── Small team, no DBA?
              │    ──> PlanetScale or Aurora (fully managed)
              │
              └── Must have FK / stored procedures?
                   ──> Aurora or RDS MySQL (not PlanetScale)
```

### Cost Considerations

Cost comparison per 1 TB database, single-region, running 24/7.
Estimates are approximate and vary by region and negotiated pricing.

```
Monthly Cost Estimate (approximate, 2024 pricing)

  ┌─────────────────────┬───────────┬────────────┬──────────────┐
  │ Component           │ RDS MySQL │ Aurora     │ PlanetScale  │
  │                     │ (r6g.2xl) │ (r6g.2xl)  │ (Scaler Pro) │
  ├─────────────────────┼───────────┼────────────┼──────────────┤
  │ Compute             │  $500     │  $580      │  included    │
  │ Storage (1 TB)      │  $115     │  $100      │  $250        │
  │ I/O                 │  included*│  $200**    │  included    │
  │ Backup storage      │  free***  │  free***   │  included    │
  │ Read replica (x1)   │  $500     │  $580      │  included    │
  ├─────────────────────┼───────────┼────────────┼──────────────┤
  │ TOTAL (approx)      │  $1,115   │  $1,460    │  $1,000+     │
  └─────────────────────┴───────────┴────────────┴──────────────┘

  * RDS gp3: IOPS included up to 3,000; io1 charged per IOPS
  ** Aurora: $0.20 per million I/O requests
  *** Backup storage free up to total database size

  TiDB Cloud (dedicated):
  - Comparable to Aurora pricing for equivalent capacity
  - Additional cost for TiFlash nodes if HTAP is needed
  - Self-hosted TiDB: infrastructure cost only (open source)

  Key cost insight:
  - Aurora LOOKS more expensive per-instance, but for read-heavy
    workloads, shared storage means replicas cost only compute
    (no duplicate storage). For 5+ replicas, Aurora can be cheaper.
  - PlanetScale pricing is row-read-based, which is unpredictable
    for scan-heavy workloads. It favors point-lookup patterns.
```

### Final Recommendation by Use Case

| Use Case                                    | Recommended Solution           | Reason |
|---------------------------------------------|-------------------------------|--------|
| Standard OLTP, <10 TB, single region        | RDS MySQL or Cloud SQL         | Simple, cost-effective, full MySQL compatibility |
| Write-heavy OLTP, need fast failover        | Aurora MySQL                   | 1x write amp, 30s failover, shared storage |
| Variable/unpredictable workload             | Aurora Serverless v2           | Auto-scaling compute, pay per use |
| Global users, multi-region reads            | Aurora Global Database         | Storage-level replication, <1s lag |
| Horizontal write scaling, no FK required    | PlanetScale                    | Vitess sharding, schema branching, managed |
| Global consistency, distributed transactions| TiDB                           | Raft + Percolator, true distributed ACID |
| OLTP + OLAP on same data                   | TiDB with TiFlash              | Row + columnar stores, single system |
| Maximum portability, avoid lock-in          | Self-managed MySQL             | You own everything; combine with ProxySQL and Orchestrator |
| Multi-cloud or hybrid                       | TiDB (self-hosted)             | Open source, runs anywhere |

---

## 19.11 Summary — From Single-Instance to Distributed MySQL

This chapter — and this book — traced MySQL from a single `mysqld` process
handling one query at a time to globally distributed systems processing millions
of transactions per second while speaking the same wire protocol.

### The Spectrum of MySQL Solutions

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                                                                  │
  │  Self-Managed MySQL                                              │
  │  ├── Full control, full responsibility                           │
  │  ├── InnoDB on local disk (Chapters 3-11)                        │
  │  ├── Manual replication, failover, backup                        │
  │  └── Best for: teams with deep MySQL expertise                   │
  │       │                                                          │
  │       ▼                                                          │
  │  RDS MySQL / Cloud SQL / Azure MySQL                             │
  │  ├── Same engine, managed operations                             │
  │  ├── Automated backups, patching, monitoring                     │
  │  ├── Multi-AZ for HA, read replicas for scale                   │
  │  └── Best for: most production workloads                         │
  │       │                                                          │
  │       ▼                                                          │
  │  Aurora MySQL                                                    │
  │  ├── Storage revolution: log-is-the-database                     │
  │  ├── 1x write amplification (vs 4x traditional)                  │
  │  ├── Shared storage: 15 replicas with 10-20ms lag                │
  │  ├── Serverless v2, Global Database, Backtrack                   │
  │  └── Best for: write-heavy, need fast failover on AWS            │
  │       │                                                          │
  │       ▼                                                          │
  │  PlanetScale (Vitess)                                            │
  │  ├── Horizontal write scaling via sharding                       │
  │  ├── Schema branching, non-blocking DDL                          │
  │  ├── Trade-off: no FK, no stored procs, no triggers              │
  │  └── Best for: massive write scale, service-oriented schemas     │
  │       │                                                          │
  │       ▼                                                          │
  │  TiDB (NewSQL)                                                   │
  │  ├── New engine, MySQL wire protocol                             │
  │  ├── Raft consensus, Percolator transactions                     │
  │  ├── HTAP with TiFlash columnar store                            │
  │  ├── Trade-off: higher per-query latency, some incompatibilities │
  │  └── Best for: global distribution, HTAP, strong consistency     │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
```

### Key Takeaways for Interviews

1. **Aurora's core insight**: "The log is the database." Redo log records are the
   only write; storage reconstructs pages on demand. This eliminates doublewrite,
   binlog, and page flush — reducing write amplification from 4x to 1x. Cite the
   2017 SIGMOD paper.

2. **Aurora's quorum**: 4/6 write, 3/6 read across 3 AZs. W + R > N guarantees
   read-your-writes. Survives AZ failure + 1 node for writes, AZ + 2 nodes for reads.

3. **PlanetScale/Vitess trade-off**: Horizontal write scaling in exchange for
   no foreign keys. If your schema already enforces referential integrity at the
   application level, this trade-off costs nothing. If it relies on FK constraints,
   migration requires significant refactoring.

4. **TiDB's architecture**: Stateless SQL (TiDB Server) + metadata coordinator (PD)
   + Raft-replicated KV storage (TiKV) + columnar analytics (TiFlash). Each
   component scales independently. Percolator 2PC provides distributed ACID.

5. **Migration is always**: setup, initial load, continuous replication, verification,
   cutover. The tool varies; the pattern is universal.

6. **The choice is about trade-offs, not features**: every cloud MySQL solution
   sacrifices something. Aurora sacrifices portability. PlanetScale sacrifices FK
   and stored procs. TiDB sacrifices per-query latency and full MySQL compatibility.
   Self-managed MySQL sacrifices operational simplicity. State the trade-off
   explicitly in interviews.

---

### Cross-References to Earlier Chapters

| Topic in This Chapter                          | Foundation Chapter |
|------------------------------------------------|-------------------|
| Write amplification (redo, binlog, doublewrite, page flush) | Chapter 8 (Redo Log), Chapter 9 (Doublewrite) |
| Aurora's buffer pool behavior                  | Chapter 4 (Buffer Pool) |
| Aurora's log application / page materialization | Chapter 8 (Crash Recovery) |
| RDS parameter tuning                           | Chapter 4, 8, 11, 15 |
| PlanetScale connection pooling vs MySQL threads | Chapter 15 (Connection Pooling) |
| Vitess sharding model                          | Chapter 16 (Sharding) |
| InnoDB locking (absent in TiDB's Percolator)   | Chapter 10 (Locking) |
| Replication in RDS, Cloud SQL, Azure            | Chapter 12 (Replication) |
| HA failover mechanics                          | Chapter 17 (HA and DR) |
| TiDB's MVCC vs InnoDB's MVCC                   | Chapter 7 (MVCC) |

---

*This concludes Chapter 19 and the book.*

*From the byte layout of a 16 KB InnoDB page to a globally distributed NewSQL
engine that speaks MySQL protocol — you now have the internals knowledge that
separates senior engineers who USE MySQL from those who UNDERSTAND it.*

*Return to: [Table of Contents](00-table-of-contents.md)*

---

**— End of Book —**

**MySQL: From Engine Room to Production — A Systems Engineering Deep Dive**
