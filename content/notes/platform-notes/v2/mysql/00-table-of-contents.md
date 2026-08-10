# MySQL: From Engine Room to Production — A Systems Engineering Deep Dive

> Written from the perspective of a MySQL engine developer and systems engineering researcher.
> Target audience: Senior engineers preparing for Staff/Principal-level interviews (40+ LPA).

---

## Book Structure

### Part 1: The Engine Room — MySQL Internals

These chapters dissect MySQL as if you built it. Each chapter maps source code paths,
explains the data structures chosen and why, and shows how decisions in the storage engine
ripple up to query performance.

| Ch | Title | Core Question |
|----|-------|---------------|
| 01 | [MySQL Server Architecture](01-mysql-server-architecture.md) | How does a SQL statement travel from TCP socket to disk and back? |
| 02 | [The SQL Layer — Parser, Optimizer, Executor](02-sql-layer-parser-optimizer-executor.md) | How does MySQL turn `SELECT *` into a physical access plan? |
| 03 | [InnoDB Storage Engine Core](03-innodb-storage-engine-core.md) | What does InnoDB look like as a systems diagram? |
| 04 | [Buffer Pool Deep Dive](04-buffer-pool-deep-dive.md) | How does InnoDB manage 128 GB of RAM without thrashing? |
| 05 | [B+Tree and Index Structures](05-btree-and-index-structures.md) | How is data physically organized on disk and traversed? |
| 06 | [Row Formats and Page Layout](06-row-formats-and-page-layout.md) | What does a 16 KB page look like byte-by-byte? |
| 07 | [MVCC and Transaction Processing](07-mvcc-and-transaction-processing.md) | How do concurrent readers and writers avoid blocking each other? |
| 08 | [Write-Ahead Logging — Redo Log and Crash Recovery](08-redo-log-and-crash-recovery.md) | How does InnoDB survive a power failure mid-write? |
| 09 | [Undo Log, Purge, and Doublewrite Buffer](09-undo-log-purge-doublewrite.md) | How are old row versions managed and torn pages prevented? |
| 10 | [Locking Internals](10-locking-internals.md) | Why does a range scan lock rows you didn't ask for? |
| 11 | [Thread Architecture and I/O Subsystem](11-thread-architecture-and-io.md) | How does MySQL use OS threads, memory, and disk I/O? |
| 12 | [Replication Internals](12-replication-internals.md) | How does a byte written on the primary reach the replica? |

### Part 2: The Operator's Manual — Scaling MySQL

These chapters are for the developer who runs MySQL at scale. Every recommendation is
grounded in the internals from Part 1 — you'll know *why* a config change works, not
just *that* it does.

| Ch | Title | Core Question |
|----|-------|---------------|
| 13 | [Schema Design for Scale](13-schema-design-for-scale.md) | How do data type choices ripple through B+Trees, buffer pool, and replication? |
| 14 | [Indexing Mastery and Query Optimization](14-indexing-mastery-and-query-optimization.md) | How do you design indexes that make the optimizer's job trivial? |
| 15 | [Connection Pooling and Middleware](15-connection-pooling-and-middleware.md) | How do HikariCP, ProxySQL, and MySQL Router fit together? |
| 16 | [Partitioning and Sharding](16-partitioning-and-sharding.md) | When do you split tables, and when do you split clusters? |
| 17 | [High Availability and Disaster Recovery](17-high-availability-and-disaster-recovery.md) | How do you architect for zero-downtime and zero-data-loss? |
| 18 | [Monitoring, Tuning, and Production Operations](18-monitoring-tuning-production.md) | What do you watch, and what do you change when it breaks? |
| 19 | [MySQL in the Cloud — Aurora, PlanetScale, TiDB](19-mysql-in-the-cloud.md) | How do cloud-native engines re-architect MySQL's storage layer? |

---

## How to Read This Book

**If you built databases before**: Start with Chapter 6 (Page Layout) and Chapter 7 (MVCC) —
these are where InnoDB's design philosophy diverges most from PostgreSQL and Oracle.

**If you're a Java/Spring developer scaling MySQL**: Start with Part 2, then read Part 1
chapters as the "why" behind each recommendation.

**If you're preparing for system design interviews**: Read Chapters 1, 7, 8, 10, 12, 16, 17
— these cover the architecture decisions interviewers probe most.

---

## Conventions

- `source_file.cc:function_name()` — References to MySQL 8.0 source code (github.com/mysql/mysql-server)
- `[InnoDB]` — InnoDB-specific behavior (vs MyISAM or other engines)
- `[8.0+]` — Feature available only in MySQL 8.0 and later
- `>>>` — Interview-critical insight
- ASCII diagrams use fixed-width formatting — view in a monospace font

---
