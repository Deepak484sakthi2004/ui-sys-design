# Chapter 16: Partitioning and Sharding

## When Do You Split Tables, and When Do You Split Clusters?

---

> A single MySQL instance scales vertically until it doesn't. At that point,
> you have two levers: split the data within one instance (partitioning), or
> split the data across many instances (sharding). These two strategies solve
> different problems, carry different costs, and fail in different ways.
>
> This chapter covers both in full depth -- when to reach for each, how they
> work internally, and the operational reality of running either in production.
> We ground every decision in the InnoDB internals from Part 1: partition
> pruning depends on the optimizer's cost model (Chapter 2), each partition is
> a separate B+Tree tablespace (Chapter 3), and shard topology interacts
> directly with replication (Chapter 12).

---

## 16.1 Partitioning vs Sharding -- Fundamental Distinction

Before diving into mechanics, draw a hard line between these two strategies.
They are complementary, not interchangeable.

**Partitioning**: one logical table, split into multiple physical segments
(partitions), all within a SINGLE MySQL instance. MySQL manages the split.
The application sees one table and issues normal SQL. The storage engine
maintains multiple B+Trees under the hood.

**Sharding**: data distributed across MULTIPLE independent MySQL instances.
The application (or a middleware proxy) manages the split. Each shard is a
fully autonomous database server with its own buffer pool, redo log, undo
tablespace, and replication topology.

```
PARTITIONING (single instance)
+--------------------------------------------------------------+
|                        mysqld (one server)                    |
|                                                               |
|  orders (logical table)                                       |
|  +----------+  +----------+  +----------+  +----------+      |
|  |  p2022   |  |  p2023   |  |  p2024   |  |  p2025   |      |
|  | .ibd     |  | .ibd     |  | .ibd     |  | .ibd     |      |
|  | (B+Tree) |  | (B+Tree) |  | (B+Tree) |  | (B+Tree) |      |
|  +----------+  +----------+  +----------+  +----------+      |
|                                                               |
|  Shared buffer pool, shared redo log, one set of threads      |
+--------------------------------------------------------------+

SHARDING (multiple instances)
+------------------+  +------------------+  +------------------+
|  Shard 0         |  |  Shard 1         |  |  Shard 2         |
|  mysqld          |  |  mysqld          |  |  mysqld          |
|  +------------+  |  |  +------------+  |  |  +------------+  |
|  | users      |  |  |  | users      |  |  |  | users      |  |
|  | id 1-1M    |  |  |  | id 1M-2M   |  |  |  | id 2M-3M   |  |
|  +------------+  |  |  +------------+  |  |  +------------+  |
|  own buffer pool |  |  own buffer pool |  |  own buffer pool |
|  own redo log    |  |  own redo log    |  |  own redo log    |
+------------------+  +------------------+  +------------------+
     ^                      ^                      ^
     |                      |                      |
     +---- Application / Middleware (routing) -----+
```

### Side-by-Side Comparison

| Aspect | Partitioning | Sharding |
|--------|-------------|----------|
| Scope | Single instance | Multiple instances |
| Management | MySQL (transparent) | Application/middleware |
| Transparency | Fully transparent to application | Requires application changes |
| Scale limit | Single server resources (CPU, RAM, disk I/O) | Horizontal scale-out (add more machines) |
| Cross-partition queries | Supported (full scan if no pruning) | Complex (distributed scatter-gather) |
| Transactions | Full ACID (one instance) | XA transactions or eventual consistency |
| Schema changes | One ALTER TABLE (affects all partitions) | Must coordinate across all shards |
| Backup | Single mysqldump/xtrabackup | Per-shard backup coordination |
| Failover | Standard replica promotion | Per-shard failover, topology management |
| Operational complexity | Low | Very high |

**>>> In interviews, clearly distinguish partitioning (single-node, MySQL-managed, transparent)
from sharding (multi-node, application-managed, invasive). Many candidates conflate the two.**

---

## 16.2 MySQL Partitioning -- Types and Mechanics

MySQL supports four partitioning strategies, each suited to different data
access patterns. Since MySQL 8.0, only InnoDB supports partitioning (MyISAM,
NDB, and other engines lost partitioning support).

### 16.2.1 RANGE Partitioning

Partition by continuous value ranges. The most common strategy in production.

```sql
CREATE TABLE orders (
    id BIGINT AUTO_INCREMENT,
    order_date DATE NOT NULL,
    customer_id BIGINT NOT NULL,
    amount DECIMAL(10,2),
    status TINYINT,
    PRIMARY KEY (id, order_date)
) PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p2022 VALUES LESS THAN (2023),
    PARTITION p2023 VALUES LESS THAN (2024),
    PARTITION p2024 VALUES LESS THAN (2025),
    PARTITION p2025 VALUES LESS THAN (2026),
    PARTITION pmax  VALUES LESS THAN MAXVALUE
);
```

Each partition is physically a separate `.ibd` file with its own B+Tree.
When you `INSERT INTO orders (order_date) VALUES ('2024-06-15')`, InnoDB
evaluates `YEAR('2024-06-15') = 2024`, determines that 2024 < 2025, and
routes the row to partition `p2024`.

**Use cases**:

- **Time-series data**: orders, logs, events -- query windows are naturally
  bounded by date. Older partitions become read-only and can be archived.

- **Data retention**: `DROP PARTITION p2020` is effectively instantaneous
  (drops the `.ibd` file) versus `DELETE FROM orders WHERE YEAR(order_date) = 2020`
  which must scan millions of rows, generate undo records, write redo log,
  and hold locks for the duration.

- **Regulatory compliance**: GDPR/SOX requires data purge after N years.
  Partition by year and drop expired partitions.

```
DROP PARTITION vs DELETE:
+-----------------------------------------------------------+
| Operation          | DROP PARTITION p2020 | DELETE rows    |
|--------------------|----------------------|----------------|
| Time               | < 1 second           | Minutes-hours  |
| Redo log generated | None (file unlink)   | Megabytes-GB   |
| Undo log generated | None                 | Megabytes-GB   |
| Locks held         | Metadata lock only   | Row/gap locks  |
| Buffer pool impact | Evicts p2020 pages   | Full scan      |
| Replication cost   | DDL event only       | Row-by-row     |
+-----------------------------------------------------------+
```

**RANGE COLUMNS** variant -- supports multiple columns and non-integer types
without wrapping in a function:

```sql
CREATE TABLE events (
    id BIGINT AUTO_INCREMENT,
    event_date DATE NOT NULL,
    region VARCHAR(10) NOT NULL,
    payload JSON,
    PRIMARY KEY (id, event_date, region)
) PARTITION BY RANGE COLUMNS (event_date) (
    PARTITION p_2024_q1 VALUES LESS THAN ('2024-04-01'),
    PARTITION p_2024_q2 VALUES LESS THAN ('2024-07-01'),
    PARTITION p_2024_q3 VALUES LESS THAN ('2024-10-01'),
    PARTITION p_2024_q4 VALUES LESS THAN ('2025-01-01'),
    PARTITION pmax      VALUES LESS THAN (MAXVALUE)
);
```

### 16.2.2 LIST Partitioning

Partition by discrete enumerated values. Useful when data has a natural
categorical dimension.

```sql
CREATE TABLE customers (
    id BIGINT AUTO_INCREMENT,
    name VARCHAR(200),
    region_id INT NOT NULL,
    email VARCHAR(255),
    PRIMARY KEY (id, region_id)
) PARTITION BY LIST (region_id) (
    PARTITION p_us VALUES IN (1, 2, 3),
    PARTITION p_eu VALUES IN (4, 5, 6),
    PARTITION p_ap VALUES IN (7, 8, 9)
);
```

If a row is inserted with a `region_id` value not present in any partition
definition, MySQL raises an error: `Table has no partition for value 10`.
There is no `MAXVALUE` equivalent for LIST. You must explicitly cover all
values or face runtime errors.

**LIST COLUMNS** variant -- supports string values directly:

```sql
PARTITION BY LIST COLUMNS (country_code) (
    PARTITION p_americas VALUES IN ('US', 'CA', 'MX', 'BR'),
    PARTITION p_europe  VALUES IN ('GB', 'DE', 'FR', 'NL'),
    PARTITION p_asia    VALUES IN ('JP', 'KR', 'SG', 'IN')
);
```

### 16.2.3 HASH Partitioning

Distribute rows evenly across a fixed number of partitions using a modular
hash function.

```sql
CREATE TABLE sessions (
    id BIGINT AUTO_INCREMENT,
    user_id BIGINT NOT NULL,
    session_data MEDIUMBLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, user_id)
) PARTITION BY HASH (user_id) PARTITIONS 8;
```

MySQL computes `partition_id = user_id % 8` (for integer expressions) and
routes the row to that partition. Distribution is only as even as the value
distribution of the hash expression.

**LINEAR HASH** variant -- uses a power-of-two algorithm instead of modulo.
Adding or removing partitions reorganizes fewer rows, but distribution is
less uniform:

```sql
PARTITION BY LINEAR HASH (user_id) PARTITIONS 8;
```

The linear hash algorithm:

```
V = POWER(2, CEILING(LOG(2, num_partitions)))
partition_id = user_id & (V - 1)
if partition_id >= num_partitions:
    partition_id = user_id & ((V / 2) - 1)
```

When you add partitions to a LINEAR HASH table, only about 1/N of the rows
need to move (similar to consistent hashing). With regular HASH, all rows
must be redistributed.

### 16.2.4 KEY Partitioning

Like HASH, but uses MySQL's internal hash function (`MD5`-based for NDB,
password-like hash for InnoDB) instead of a user-supplied expression.

```sql
CREATE TABLE audit_log (
    id BIGINT AUTO_INCREMENT,
    user_id BIGINT NOT NULL,
    action VARCHAR(100),
    details TEXT,
    PRIMARY KEY (id, user_id)
) PARTITION BY KEY (user_id) PARTITIONS 16;
```

KEY partitioning can partition on any column type, including strings, dates,
and compound keys. HASH partitioning requires an integer expression.

If no column is specified, KEY partitioning uses the primary key:

```sql
PARTITION BY KEY () PARTITIONS 16;   -- uses primary key columns
```

### 16.2.5 Subpartitioning (Composite Partitioning)

Combine RANGE or LIST at the top level with HASH or KEY at the sub-level.

```sql
CREATE TABLE web_logs (
    id BIGINT AUTO_INCREMENT,
    log_date DATE NOT NULL,
    server_id INT NOT NULL,
    request TEXT,
    response_code SMALLINT,
    PRIMARY KEY (id, log_date, server_id)
) PARTITION BY RANGE (YEAR(log_date))
  SUBPARTITION BY HASH (server_id)
  SUBPARTITIONS 4 (
    PARTITION p2023 VALUES LESS THAN (2024),
    PARTITION p2024 VALUES LESS THAN (2025),
    PARTITION p2025 VALUES LESS THAN (2026),
    PARTITION pmax  VALUES LESS THAN MAXVALUE
);
```

This creates 4 partitions x 4 subpartitions = 16 physical segments. Each
subpartition has its own `.ibd` file. The naming convention is
`table_name#P#partition_name#SP#subpartition_name.ibd`.

```
Subpartitioning structure:
+-----------+-----------+-----------+-----------+
|  p2023    |  p2024    |  p2025    |  pmax     |  <-- RANGE by year
|           |           |           |           |
| sp0 | sp1 | sp0 | sp1 | sp0 | sp1 | sp0 | sp1|
| sp2 | sp3 | sp2 | sp3 | sp2 | sp3 | sp2 | sp3|  <-- HASH by server_id
+-----------+-----------+-----------+-----------+
  16 physical .ibd files total
```

**Caution**: subpartitioning multiplies the number of physical files and
open file handles. 100 RANGE partitions x 16 HASH subpartitions = 1,600
`.ibd` files for a single table.

---

## 16.3 Partition Pruning -- The Key Performance Feature

Partition pruning is the only reason partitioning improves query performance.
If the optimizer cannot prune, partitioning makes queries **slower**, not faster.

### 16.3.1 How Pruning Works

During optimization (Chapter 2), MySQL's partition pruning code examines
the WHERE clause, identifies conditions on the partition column, and
eliminates partitions that cannot possibly contain matching rows.

```
Query: SELECT * FROM orders WHERE order_date = '2024-06-15'

Without partitioning:
  Full table scan or index scan of one big B+Tree

With partitioning (RANGE by year):
  Optimizer sees: YEAR('2024-06-15') = 2024, which is < 2025
  Prunes to: partition p2024 only
  Scans: one B+Tree (1/5 of the data)

  +--------+--------+--------+--------+--------+
  | p2022  | p2023  | p2024  | p2025  | pmax   |
  | SKIP   | SKIP   | SCAN   | SKIP   | SKIP   |
  +--------+--------+--------+--------+--------+
```

### 16.3.2 Verifying Pruning with EXPLAIN

```sql
EXPLAIN SELECT * FROM orders WHERE order_date = '2024-06-15'\G

-- Key output:
-- partitions: p2024              <-- only p2024 accessed
-- type: ALL (within p2024)
-- rows: 50000

EXPLAIN SELECT * FROM orders WHERE order_date BETWEEN '2023-06-01' AND '2024-03-15'\G

-- partitions: p2023,p2024        <-- two partitions scanned
```

In MySQL 8.0, `EXPLAIN ANALYZE` shows actual partition access:

```sql
EXPLAIN ANALYZE
SELECT * FROM orders WHERE order_date = '2024-06-15'\G

-- -> Filter: (orders.order_date = '2024-06-15')
--    -> Table scan on orders (partition: p2024)
--       (cost=5230 rows=50000) (actual time=0.03..12.4 rows=137 loops=1)
```

### 16.3.3 When Pruning Does NOT Work

Pruning fails silently. The query still runs, it just scans all partitions.

**Functions on the partition column defeat pruning**:

```sql
-- NO pruning: function applied to column
SELECT * FROM orders WHERE MONTH(order_date) = 6;
-- partitions: p2022,p2023,p2024,p2025,pmax   (ALL)

-- YES pruning: direct comparison
SELECT * FROM orders WHERE order_date >= '2024-06-01'
                       AND order_date <  '2024-07-01';
-- partitions: p2024
```

**Mismatch between partition expression and WHERE clause**:

```sql
-- Table partitioned by: RANGE (YEAR(order_date))
-- This prunes:
WHERE order_date >= '2024-01-01' AND order_date < '2025-01-01'

-- This also prunes (MySQL can match YEAR() expression):
WHERE YEAR(order_date) = 2024

-- This does NOT prune (TO_DAYS is not the partition function):
WHERE TO_DAYS(order_date) >= TO_DAYS('2024-01-01')
```

**OR conditions spanning partitions**:

```sql
-- Prunes to two partitions:
WHERE order_date = '2023-03-15' OR order_date = '2024-09-01'
-- partitions: p2023,p2024

-- No pruning possible:
WHERE order_date = '2024-06-15' OR customer_id = 42
-- partitions: p2022,p2023,p2024,p2025,pmax   (ALL)
-- (customer_id is not the partition column)
```

**>>> Partition column MUST appear in the WHERE clause for pruning to work.
If your most common query does not filter on the partition column, partitioning
will hurt performance rather than help.**

### 16.3.4 The Partition Column + Primary Key Constraint

This is the single most common partitioning gotcha and the reason most first
attempts at partitioning fail.

**Rule**: Every unique index (including the primary key) must include all
columns of the partition expression.

```sql
-- This FAILS:
CREATE TABLE orders (
    id BIGINT AUTO_INCREMENT,
    order_date DATE NOT NULL,
    PRIMARY KEY (id)                   -- partition col not in PK
) PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p2024 VALUES LESS THAN (2025)
);
-- ERROR 1503: A PRIMARY KEY must include all columns in the table's
--             partitioning function

-- This WORKS:
CREATE TABLE orders (
    id BIGINT AUTO_INCREMENT,
    order_date DATE NOT NULL,
    PRIMARY KEY (id, order_date)       -- partition col included
) PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p2024 VALUES LESS THAN (2025)
);
```

**Why this constraint exists**: MySQL must be able to determine the target
partition from the primary key alone, without reading the row. If the PK
is just `(id)` and you do `SELECT * FROM orders WHERE id = 42`, MySQL cannot
know which partition contains id=42 without scanning all partitions. By
requiring the partition column in the PK, MySQL can compute the target
partition from the key.

The same applies to all UNIQUE indexes:

```sql
-- FAILS:
ALTER TABLE orders ADD UNIQUE INDEX (customer_id);
-- ERROR: unique index must include partition column

-- WORKS:
ALTER TABLE orders ADD UNIQUE INDEX (customer_id, order_date);
```

**>>> "Why does partitioning require the partition column in every unique key?"
is a top-tier interview question. The answer: without it, uniqueness enforcement
would require checking ALL partitions on every insert, defeating the purpose.**

---

## 16.4 Partition Operations

### 16.4.1 Adding Partitions

```sql
-- Add a new partition for 2026
ALTER TABLE orders ADD PARTITION (
    PARTITION p2026 VALUES LESS THAN (2027)
);
```

If a MAXVALUE partition exists, you cannot ADD PARTITION. You must
REORGANIZE it instead:

```sql
ALTER TABLE orders REORGANIZE PARTITION pmax INTO (
    PARTITION p2026 VALUES LESS THAN (2027),
    PARTITION pmax  VALUES LESS THAN MAXVALUE
);
```

REORGANIZE physically moves rows from the old partition into the new ones.
If `pmax` contained 10 million rows that now belong to `p2026`, those rows
are read and rewritten. This is a data-moving operation, not metadata-only.

### 16.4.2 Dropping Partitions

```sql
ALTER TABLE orders DROP PARTITION p2020;
```

This is a metadata-only + file-unlink operation. The `.ibd` file for `p2020`
is deleted. No row-by-row deletion, no undo log, no redo log beyond the
DDL event. Completion time is independent of row count.

```
Timeline comparison for removing 50M rows:

DROP PARTITION:
|--DDL--|  (~0.5 seconds, metadata lock only)

DELETE FROM ... WHERE YEAR(order_date) = 2020:
|------- scan 50M rows ------- generate undo ------- write redo -------|
  (~30 minutes, row locks held, replication lag generated)
```

### 16.4.3 Truncating Partitions

```sql
ALTER TABLE orders TRUNCATE PARTITION p2020;
```

Like DROP, but keeps the partition definition. The `.ibd` file is recreated
empty. All data is gone. This is also near-instantaneous.

### 16.4.4 Exchanging Partitions

Swap a partition with a standalone (non-partitioned) table atomically:

```sql
-- Create an archive table with identical structure
CREATE TABLE archive_2022 LIKE orders;
ALTER TABLE archive_2022 REMOVE PARTITIONING;

-- Swap partition p2022 with the archive table
ALTER TABLE orders EXCHANGE PARTITION p2022 WITH TABLE archive_2022;
```

After this operation:
- `orders` partition `p2022` contains whatever was in `archive_2022` (typically empty)
- `archive_2022` contains all rows that were in `p2022`

This is a metadata-only operation -- MySQL renames the `.ibd` files. No row
copying. It completes in milliseconds regardless of data volume.

```
Before EXCHANGE:
  orders.p2022.ibd  [50M rows, 12 GB]
  archive_2022.ibd  [0 rows, 0 GB]

After EXCHANGE:
  orders.p2022.ibd  [0 rows, 0 GB]      (was archive_2022)
  archive_2022.ibd  [50M rows, 12 GB]   (was orders.p2022)
```

Validation: by default MySQL validates that all rows in the standalone table
satisfy the partition constraint. Use `WITHOUT VALIDATION` to skip (faster
but dangerous if data doesn't match the partition range).

### 16.4.5 Automated Partition Management

In production, you manage partitions with a scheduled job. The pattern:

```
Cron job (daily/weekly/monthly):
1. Check if "next" partition exists
2. If not, REORGANIZE pmax to add it
3. Check if oldest partition exceeds retention policy
4. If so, EXCHANGE with archive table, then DROP or compress archive
```

Example shell script (simplified):

```bash
#!/bin/bash
# Add partition for next year if missing
NEXT_YEAR=$(($(date +%Y) + 1))
PARTITION_NAME="p${NEXT_YEAR}"

mysql -e "
  ALTER TABLE orders REORGANIZE PARTITION pmax INTO (
    PARTITION ${PARTITION_NAME} VALUES LESS THAN ($((NEXT_YEAR + 1))),
    PARTITION pmax VALUES LESS THAN MAXVALUE
  );
" 2>/dev/null || echo "Partition ${PARTITION_NAME} already exists"

# Drop partitions older than 3 years
CUTOFF_YEAR=$(($(date +%Y) - 3))
for year in $(seq 2020 $CUTOFF_YEAR); do
    mysql -e "ALTER TABLE orders DROP PARTITION p${year};" 2>/dev/null
done
```

**>>> In interviews, if you propose partitioning, always mention the automation
story. Partitions that are not automatically managed become a ticking time
bomb (pmax fills up, or you run out of disk on a single partition).**

---

## 16.5 Partitioning Limitations

These are hard constraints, not configuration options. Know them before
proposing partitioning in a design.

### 16.5.1 Unique Index Constraint

Every unique index (including the primary key) must include ALL columns
used in the partition expression. Covered in detail in section 16.3.4.

### 16.5.2 No Foreign Keys

InnoDB does not support foreign key constraints on partitioned tables --
neither as the referencing table nor the referenced table.

```sql
-- FAILS: partitioned table cannot have foreign keys
CREATE TABLE order_items (
    id BIGINT,
    order_id BIGINT,
    order_date DATE,
    PRIMARY KEY (id, order_date),
    FOREIGN KEY (order_id) REFERENCES orders(id)  -- ERROR
) PARTITION BY RANGE (YEAR(order_date)) (...);

-- ALSO FAILS: cannot reference a partitioned table
CREATE TABLE payments (
    id BIGINT PRIMARY KEY,
    order_id BIGINT,
    FOREIGN KEY (order_id) REFERENCES orders(id)  -- ERROR (orders is partitioned)
);
```

This means you must enforce referential integrity in the application layer
when using partitioning.

### 16.5.3 Maximum Partitions

MySQL supports a maximum of 8,192 partitions per table (including
subpartitions). This sounds generous until you consider subpartitioning:
100 RANGE partitions x 82 HASH subpartitions = 8,200 -- exceeds the limit.

### 16.5.4 File Handle Explosion

Each partition (or subpartition) is a separate `.ibd` file. MySQL must
open file handles for each. With 1,000 partitions across 10 tables, that
is 10,000 `.ibd` files. Add the adaptive hash index, change buffer, and
data dictionary, and you push into `open_files_limit` territory.

```
Guideline:
  Partitions per table    File handles    Recommendation
  < 50                    Manageable      Standard production use
  50 - 200                Monitor         Increase open_files_limit
  200 - 1000              Caution         Reconsider design
  > 1000                  Danger          Almost certainly wrong
```

### 16.5.5 No Global Secondary Index

This is the biggest functional limitation compared to Oracle's partitioning.

In MySQL, every index on a partitioned table is a **local index** -- it
spans only one partition. There is no global secondary index that spans
all partitions.

```
Oracle (global index):                MySQL (local indexes only):
+-----------------------------+       +----------+----------+----------+
| Global secondary index      |       | p2022    | p2023    | p2024    |
| (one B+Tree spanning all    |       | local    | local    | local    |
|  partitions)                |       | idx      | idx      | idx      |
|                             |       | (B+Tree) | (B+Tree) | (B+Tree) |
+----+-----------+----+-------+       +----------+----------+----------+
     |           |    |
  p2022       p2023  p2024            Query by non-partition indexed col:
                                      must probe index in EVERY partition
```

Consequence: a query like `SELECT * FROM orders WHERE customer_id = 42`
(where `customer_id` is indexed but is not the partition column) must
probe the `customer_id` index in every partition. With 100 partitions,
that is 100 index lookups instead of 1.

### 16.5.6 Partition-Unaware Queries Are Worse

A query without the partition column in WHERE scans ALL partitions.
This is worse than a single unpartitioned table because:

1. Each partition has its own B+Tree with overhead (root page, internal nodes)
2. The optimizer issues a separate handler call per partition
3. Buffer pool locality is destroyed (pages from N partitions compete)

```sql
-- On partitioned table with 100 partitions:
SELECT * FROM orders WHERE customer_id = 42;
-- 100 separate index probes, one per partition

-- On non-partitioned table:
SELECT * FROM orders WHERE customer_id = 42;
-- 1 index probe
```

**>>> "Partitioning is NOT a substitute for indexing. A query that doesn't
filter on the partition column performs worse on a partitioned table than on
a non-partitioned one." This catches many interview candidates who propose
partitioning as a generic performance tool.**

---

## 16.6 When to Partition vs When NOT To

### Good Use Cases

| Scenario | Why Partitioning Helps |
|----------|----------------------|
| Time-series with archival | DROP PARTITION is O(1) vs DELETE which is O(N). Regulatory retention becomes trivial |
| Time-bounded queries | 90% of queries filter by date range. Pruning eliminates most data |
| Geographic segmentation | Queries filter by region. List partitioning prunes to regional data |
| Large table maintenance | OPTIMIZE TABLE per partition (parallelize maintenance windows) |
| Bulk data loading | EXCHANGE PARTITION to swap in pre-loaded data instantly |

### Bad Use Cases

| Scenario | Why Partitioning Hurts |
|----------|----------------------|
| General performance improvement | Use indexes. Partitioning without pruning is slower |
| Small tables (< 10M rows) | Overhead exceeds benefit. Index lookups are already fast |
| Random access by non-partition key | Every query probes all partitions |
| Tables with foreign keys | Not supported. Must drop FK constraints |
| Write-heavy with no read benefit | Partitions add write overhead (determine target partition per row) |

### Decision Flowchart

```
                    Need to scale a single table?
                             |
                    +--------+--------+
                    |                 |
              Query pattern       Data lifecycle
              benefits from       requires purge
              partition pruning?  by range?
                    |                 |
               +----+----+      +----+----+
               |         |      |         |
              YES        NO    YES        NO
               |         |      |         |
          Partition    Consider  Partition  Do NOT
          (RANGE or   indexes   (RANGE)   partition
           LIST)      first              (use indexes
                                          + DELETE)
```

---

## 16.7 Sharding -- Horizontal Scale-Out

Partitioning hits a ceiling: the single MySQL instance. When you need more
write throughput than one server can provide, more storage than one machine
has, or more connections than one mysqld can handle, you must shard.

### 16.7.1 When a Single Instance Fails

```
Single MySQL instance limits:
+------------------------------------------------------+
| Resource          | Practical Limit                   |
|-------------------|-----------------------------------|
| Write throughput  | 50K-100K TPS (depends on hardware)|
| Data volume       | 2-5 TB (buffer pool < data = pain)|
| Connections       | 5,000-10,000 (thread-per-conn)    |
| Single query      | Cannot parallelize within InnoDB  |
| Vertical scaling  | Largest EC2: 24 TB RAM, 448 vCPU  |
|                   | but cost is exponential           |
+------------------------------------------------------+
```

Sharding breaks these limits by distributing data across N independent
MySQL instances:

```
Before sharding (one instance):
  Write TPS: 80K (at ceiling)
  Data: 4 TB (buffer pool miss rate climbing)
  Connections: 4,000 (thread contention visible)

After sharding to 4 instances:
  Write TPS: 80K * 4 = 320K aggregate
  Data: 1 TB per shard (buffer pool hit rate 99%+)
  Connections: 1,000 per shard (healthy headroom)
```

### 16.7.2 What a Shard IS

Each shard is a fully independent MySQL topology:

```
+------------------------------------------------------------------+
|                          Shard 0                                  |
|                                                                   |
|  +------------------+    +------------------+                     |
|  | Primary          |    | Replica 1        |                     |
|  | (read-write)     |--->| (read-only)      |                     |
|  | buffer pool: 64G |    | buffer pool: 64G |                     |
|  | redo log: 4 GB   |    |                  |                     |
|  +------------------+    +------------------+                     |
|           |                                                       |
|           |              +------------------+                     |
|           +------------->| Replica 2        |                     |
|                          | (read-only)      |                     |
|                          +------------------+                     |
|                                                                   |
|  Own schema, own data, own replication, own backups               |
+------------------------------------------------------------------+
```

Each shard has:
- Its own data (a subset of the full dataset)
- Its own indexes and buffer pool
- Its own redo log, undo tablespace, binary log
- Its own replication topology (primary + replicas)
- Its own backup schedule
- Its own failover mechanism

---

## 16.8 Shard Key Selection

The shard key is the most critical sharding decision. It determines how data
is distributed, which queries can be routed to a single shard, and which
queries require scatter-gather across all shards.

### 16.8.1 Properties of a Good Shard Key

| Property | Why It Matters |
|----------|---------------|
| High cardinality | Many distinct values = even distribution across shards |
| Even distribution | Prevents hot shards (one shard getting disproportionate load) |
| Query affinity | Most queries include the shard key, enabling single-shard routing |
| Stable | Value doesn't change (changing shard key = moving row between shards) |
| Monotonic-safe | Not auto-incrementing (would send all writes to one shard) |

### 16.8.2 Example: Multi-Tenant SaaS

```sql
-- Shard key: tenant_id (or user_id for consumer apps)
-- Each tenant's data lives entirely on one shard

Shard 0: tenant_id IN (1, 5, 9, 13, ...)
Shard 1: tenant_id IN (2, 6, 10, 14, ...)
Shard 2: tenant_id IN (3, 7, 11, 15, ...)
Shard 3: tenant_id IN (4, 8, 12, 16, ...)
```

Why this works: 95% of queries in a multi-tenant SaaS are scoped to a
single tenant. `SELECT * FROM orders WHERE tenant_id = 42 AND order_date > ...`
routes to exactly one shard. No scatter-gather needed.

### 16.8.3 Bad Shard Key Examples

**Low cardinality**: `status` column with values (ACTIVE, INACTIVE, SUSPENDED).
Three values means at most three shards, and ACTIVE is 95% of rows -- massive
hotspot.

**Temporal**: `created_at` as shard key. Recent data (last 30 days) receives
99% of writes. One shard is on fire while others idle.

```
Temporal shard key problem:

Time ───────────────────────────────────────────>

Shard 0 (Jan-Mar):  ████████ [historical, idle]
Shard 1 (Apr-Jun):  ████████ [historical, idle]
Shard 2 (Jul-Sep):  ████████ [historical, idle]
Shard 3 (Oct-Dec):  ████████████████████████████ [CURRENT, ALL WRITES HERE]
                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                     Hot shard! Same problem as single instance.
```

**Auto-incrementing ID without hashing**: `shard = id % N` works, but if IDs
are assigned sequentially, recent IDs cluster on one shard. Hash the ID first.

### 16.8.4 Composite Shard Keys

For more granular distribution, combine multiple columns:

```
Shard key: (tenant_id, entity_type)

Tenant 1, ORDERS  -> Shard 0
Tenant 1, USERS   -> Shard 2
Tenant 2, ORDERS  -> Shard 1
Tenant 2, USERS   -> Shard 3
```

This spreads a single large tenant across multiple shards (preventing one
mega-tenant from becoming a hotspot), while still keeping each entity type
for a tenant co-located for transactional consistency.

### 16.8.5 The Cross-Shard Query Problem

Any query that does NOT include the shard key must scatter-gather to ALL shards:

```
Query: SELECT * FROM orders WHERE tenant_id = 42 AND status = 'SHIPPED'
Route: shard = hash(42) % 4 = shard 2
Cost:  1 shard queried

Query: SELECT COUNT(*) FROM orders WHERE status = 'SHIPPED'
Route: unknown (no shard key in WHERE)
Cost:  ALL 4 shards queried, results aggregated
```

```
Scatter-Gather Pattern:

Application / Middleware
         |
    +----+----+----+----+
    |    |    |    |    |
    v    v    v    v    v
  Shard  Shard  Shard  Shard
    0      1      2      3
    |    |    |    |    |
    +----+----+----+----+
         |
    Merge results
         |
    Return to app
```

Scatter-gather latency = max(shard latencies) + merge overhead.
At 100 shards, even a simple COUNT(*) requires 100 round trips.

**>>> "What happens when a query doesn't include the shard key?" is a
standard interview question. Answer: scatter-gather to all shards. This
is why shard key selection is the single most important sharding decision.**

---

## 16.9 Sharding Strategies

### 16.9.1 Hash-Based Sharding

```
shard_id = hash(shard_key) % num_shards
```

```
Hash-based distribution:

   tenant_id=1 ──hash──> 73921 % 4 = 1 ──> Shard 1
   tenant_id=2 ──hash──> 48110 % 4 = 2 ──> Shard 2
   tenant_id=3 ──hash──> 55003 % 4 = 3 ──> Shard 3
   tenant_id=4 ──hash──> 20444 % 4 = 0 ──> Shard 0
   tenant_id=5 ──hash──> 91287 % 4 = 3 ──> Shard 3
```

**Advantages**:
- Even distribution (assuming good hash function)
- Simple to implement
- Deterministic routing (no lookup needed)

**Disadvantages**:
- Resharding is painful: changing `num_shards` from 4 to 5 changes
  `hash(key) % N` for most keys, requiring massive data migration
- Range queries are impossible (consecutive shard keys land on different shards)

### 16.9.2 Consistent Hashing

Solves the resharding problem of modular hashing.

```
Consistent Hashing Ring:

         0
        /|\
       / | \
      /  |  \
   330   |   30      Shard 0 owns: 330 -> 0 -> 30 -> 90
     \   |   /       Shard 1 owns: 90 -> 150
      \  |  /        Shard 2 owns: 150 -> 210
       \ | /         Shard 3 owns: 210 -> 330
        \|/
  300 ---+--- 60
        /|\
       / | \
      /  |  \
   270   |   90
      \  |  /
       \ | /
        \|/
  240 ---+--- 120
        /|\
       / | \
      /  |  \
   210   |  150
      \  |  /
       \ | /
        \|/
        180

  Shards on ring:
    Shard 0: position 30
    Shard 1: position 90
    Shard 2: position 150
    Shard 3: position 210

  Key placement: hash(key) -> walk clockwise to find owning shard

  Adding Shard 4 at position 270:
    Only keys between 210-270 move from Shard 0 to Shard 4
    ~1/N of data migrates (not all data)
```

When adding a new shard, only keys between the new shard's position and
the preceding shard need to move. With N shards, roughly 1/N of the data
migrates instead of (N-1)/N with modular hashing.

**Virtual nodes**: each physical shard gets multiple positions on the ring
(e.g., 256 virtual nodes per shard). This smooths out distribution
irregularities.

```
Virtual nodes on consistent hash ring:

Physical   Virtual nodes (positions on ring)
Shard 0:   [12, 45, 78, 134, 201, 267, 312, ...]
Shard 1:   [23, 56, 91, 145, 223, 278, 334, ...]
Shard 2:   [34, 67, 102, 156, 234, 289, 345, ...]
Shard 3:   [5, 39, 113, 167, 245, 300, 356, ...]

Each shard "owns" multiple small segments of the ring
  -> much more even distribution than 1 position per shard
```

### 16.9.3 Range-Based Sharding

```
Shard 0: user_id     1 - 1,000,000
Shard 1: user_id 1,000,001 - 2,000,000
Shard 2: user_id 2,000,001 - 3,000,000
Shard 3: user_id 3,000,001 - 4,000,000
```

**Advantages**:
- Easy to understand and debug
- Range queries are efficient (consecutive keys on same shard)
- Easy to split: split shard 0 into [1-500K] and [500K+1-1M]

**Disadvantages**:
- Prone to hotspots: the latest range (newest users) gets most traffic
- Uneven shard sizes over time (early shards may have more inactive users)

**Mitigation**: combine with time-aware routing. Old shards become read-mostly
and can use smaller hardware. New shards get beefy write-optimized instances.

### 16.9.4 Directory-Based Sharding

A lookup table (the directory) maps each shard key value to a shard ID:

```
Directory table (on a dedicated MySQL instance or in Redis):
+-------------+----------+
| shard_key   | shard_id |
+-------------+----------+
| tenant_1    | 0        |
| tenant_2    | 2        |
| tenant_3    | 1        |
| tenant_4    | 3        |
| tenant_5    | 0        |  <-- tenant_5 moved from shard 2 to shard 0
+-------------+----------+
```

**Advantages**:
- Maximum flexibility: can move individual tenants between shards
- Handles hot tenants by isolating them on dedicated shards
- No resharding formula change -- just update the directory

**Disadvantages**:
- Directory is a single point of failure (must be highly available)
- Directory is a bottleneck (every query requires a lookup)
- Must be aggressively cached (local cache with short TTL or pub/sub invalidation)

```
Directory-based routing:

App ─── "tenant_id=42" ──> Directory Cache (local)
                                |
                           Cache hit?
                          /          \
                        YES           NO
                        |              |
                   shard_id=2     Query directory DB
                        |              |
                        |         shard_id=2
                        |         (update cache)
                        |              |
                        +------+-------+
                               |
                          Route to Shard 2
```

### 16.9.5 Geographic Sharding

Data stored on the shard closest to the user for latency reduction:

```
+-------------------+    +-------------------+    +-------------------+
|  us-east-1        |    |  eu-west-1        |    |  ap-southeast-1   |
|  US Shard         |    |  EU Shard         |    |  APAC Shard       |
|  +-----------+    |    |  +-----------+    |    |  +-----------+    |
|  | users     |    |    |  | users     |    |    |  | users     |    |
|  | orders    |    |    |  | orders    |    |    |  | orders    |    |
|  | payments  |    |    |  | payments  |    |    |  | payments  |    |
|  +-----------+    |    |  +-----------+    |    |  +-----------+    |
|  RTT to users:    |    |  RTT to users:    |    |  RTT to users:    |
|  5-20ms           |    |  5-20ms           |    |  5-20ms           |
+-------------------+    +-------------------+    +-------------------+
```

Good for: compliance (data residency laws), latency-sensitive applications.

Complex for: users who travel, global reports spanning all regions,
cross-region transactions.

---

## 16.10 Vitess -- Sharding Middleware at Scale

Vitess is the open-source MySQL sharding framework originally built at
YouTube. It is now a CNCF graduated project and powers production sharding
at Slack, Square, HubSpot, GitHub, and dozens of others. PlanetScale offers
managed Vitess as a service.

### 16.10.1 Architecture

```
+------------------------------------------------------------------+
|                        Application                                |
|                   (uses MySQL protocol)                           |
+----------------------------+-------------------------------------+
                             |
                             | MySQL protocol (3306)
                             v
+------------------------------------------------------------------+
|                         VTGate                                    |
|                    (Stateless proxy)                              |
|                                                                   |
|  - Parses SQL                                                     |
|  - Resolves shard routing via VIndex                              |
|  - Scatter-gather for cross-shard queries                         |
|  - Connection pooling (multiplexes app conns to shard conns)      |
|  - Query rewriting and plan caching                               |
+--------+-----------+-----------+-----------+---------------------+
         |           |           |           |
         v           v           v           v
+------------+ +------------+ +------------+ +------------+
| VTTablet   | | VTTablet   | | VTTablet   | | VTTablet   |
| (Shard 0   | | (Shard 1   | | (Shard 2   | | (Shard 3   |
|  Primary)  | |  Primary)  | |  Primary)  | |  Primary)  |
|            | |            | |            | |            |
| - Manages  | | - Manages  | | - Manages  | | - Manages  |
|   one MySQL| |   one MySQL| |   one MySQL| |   one MySQL|
|   instance | |   instance | |   instance | |   instance |
| - Conn pool| | - Conn pool| | - Conn pool| | - Conn pool|
|   to MySQL | |   to MySQL | |   to MySQL | |   to MySQL |
| - Health   | | - Health   | | - Health   | | - Health   |
|   checks   | |   checks   | |   checks   | |   checks   |
| - Backup   | | - Backup   | | - Backup   | | - Backup   |
+-----+------+ +-----+------+ +-----+------+ +-----+------+
      |              |              |              |
      v              v              v              v
+----------+   +----------+   +----------+   +----------+
|  MySQL   |   |  MySQL   |   |  MySQL   |   |  MySQL   |
| (Shard 0)|   | (Shard 1)|   | (Shard 2)|   | (Shard 3)|
+----------+   +----------+   +----------+   +----------+

                    +--------------------+
                    | Topology Server    |
                    | (etcd / ZooKeeper) |
                    |                    |
                    | - Shard map        |
                    | - Tablet health    |
                    | - Schema versions  |
                    | - Serving state    |
                    +--------------------+
```

### 16.10.2 Key Components

**VTGate** (stateless, horizontally scalable):
- Accepts MySQL protocol connections from applications
- Parses SQL and determines target shard(s) using VIndex
- Executes scatter-gather for cross-shard queries
- Connection pooling: multiplexes thousands of app connections into
  a small number of connections per shard
- Can be deployed behind a load balancer (multiple VTGate instances)

**VTTablet** (one per MySQL instance):
- Acts as a sidecar agent for a single MySQL process
- Manages connection pooling between VTGate and MySQL
- Handles health reporting, backups, schema management
- Enforces query throttling and deny-listing
- Manages replication for its MySQL instance

**Topology Server** (etcd, ZooKeeper, or Consul):
- Stores the shard map: which keyspace-shard lives on which tablet
- Tracks tablet health and serving state (primary, replica, rdonly)
- Stores VSchema (virtual schema defining vindexes)
- Enables service discovery for VTGate

### 16.10.3 VIndex -- Virtual Index for Shard Routing

A VIndex is a mapping from a column value to a shard (keyspace ID).

```yaml
# VSchema definition
{
  "sharded": true,
  "vindexes": {
    "hash": {
      "type": "hash"
    },
    "customer_lookup": {
      "type": "consistent_lookup_unique",
      "params": {
        "table": "customer_lookup",
        "from": "customer_id",
        "to": "keyspace_id"
      }
    }
  },
  "tables": {
    "orders": {
      "column_vindexes": [
        {
          "column": "customer_id",
          "name": "hash"            // primary vindex
        }
      ]
    },
    "order_items": {
      "column_vindexes": [
        {
          "column": "order_id",
          "name": "customer_lookup"  // lookup vindex
        }
      ]
    }
  }
}
```

**VIndex types**:

| Type | Mechanism | Use Case |
|------|-----------|----------|
| `hash` | MD5 hash of column value | Primary vindex for even distribution |
| `consistent_lookup` | Lookup table mapping value to keyspace_id | Foreign-key-like cross-table routing |
| `consistent_lookup_unique` | Unique lookup table | One-to-one mapping |
| `unicode_loose_md5` | Case-insensitive hash | String columns with case-insensitive routing |
| `numeric` | Identity (value = keyspace_id) | Already-hashed values |
| `region_json` | JSON config mapping regions to keyspace_id ranges | Geographic sharding |

### 16.10.4 Resharding with Vitess

Vitess automates the resharding process that is otherwise the hardest
operational task in a sharded system.

```
Resharding flow (splitting shard 0 into shard 0a and shard 0b):

1. Create target shards (0a, 0b) with empty MySQL instances
2. VDiff: start SplitClone -- copies existing data from shard 0
3. Start VReplication: filtered replication from shard 0 to 0a/0b
   (each target shard receives only rows matching its keyrange)
4. VDiff: verify source and target data match
5. SwitchReads: route read traffic to new shards
6. SwitchWrites: route write traffic to new shards (brief pause)
7. Cleanup: remove old shard 0

Timeline:
|---copy data---|---replicate----|--verify--|switch|--cleanup--|
    (hours)         (minutes)     (minutes)  (sec)   (async)
```

The key property: **zero downtime**. During the copy and replication
phases, the original shard 0 continues serving traffic. The switch is
a brief metadata update (seconds of write unavailability).

### 16.10.5 Who Uses Vitess

| Company | Scale | Notes |
|---------|-------|-------|
| YouTube/Google | Original creator | Thousands of MySQL shards |
| Slack | Messaging store | Migrated from hand-rolled sharding |
| Square | Payment processing | Mission-critical financial data |
| HubSpot | CRM platform | Multi-tenant SaaS at scale |
| GitHub | Git metadata | Repository and user data |
| PlanetScale | DBaaS | Managed Vitess, serverless offering |
| Naukri.com | Job platform | Large-scale user and job data |

**>>> Vitess is the standard answer to "how do I shard MySQL?" for any team that
doesn't want to build and maintain a custom sharding layer. In system design
interviews, naming Vitess (and knowing it uses VTGate + VTTablet + vindexes)
demonstrates production awareness beyond textbook patterns.**

---

## 16.11 Cross-Shard Operations

Sharding introduces distributed systems problems that do not exist in a
single-instance deployment. Each of these problems has known solutions,
all with tradeoffs.

### 16.11.1 Cross-Shard Queries

Any query without the shard key in the WHERE clause triggers scatter-gather:

```sql
-- Single-shard (fast):
SELECT * FROM orders WHERE customer_id = 42 AND status = 'SHIPPED';
-- VTGate: hash(42) -> shard 2 -> route to shard 2 only

-- Cross-shard scatter-gather (slow):
SELECT COUNT(*), SUM(amount)
FROM orders
WHERE order_date > '2024-01-01';
-- VTGate: no customer_id -> send to ALL shards -> merge results
```

Vitess handles scatter-gather automatically, but performance degrades
linearly with shard count. With 256 shards, a scatter-gather query opens
256 connections and waits for the slowest shard.

### 16.11.2 Cross-Shard JOINs

The most painful operation in a sharded system. Two tables sharded on
different keys (or a sharded table joined with a reference table) cannot
be joined at the MySQL level.

```sql
-- This JOIN cannot execute on a single shard:
SELECT o.*, c.name
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.order_date > '2024-01-01';
-- orders and customers may live on different shards
```

**Solutions**:

1. **Co-locate related tables**: shard `orders` and `customers` by the
   same key (`customer_id`). JOINs become local to each shard.

2. **Denormalize**: store `customer_name` directly in the `orders` table.
   Eliminates the JOIN at the cost of data duplication and update complexity.

3. **Reference tables**: small, rarely-changing tables (countries, currencies,
   categories) replicated to every shard. Vitess supports this natively.

4. **Application-level JOIN**: fetch from one shard, then query the other.
   Two round trips but no cross-shard coordination.

```
Co-location strategy:

Shard 0:                         Shard 1:
+------------------+             +------------------+
| customers        |             | customers        |
| (cust_id 1-1000) |             | (cust_id 1001+)  |
+------------------+             +------------------+
| orders           |             | orders           |
| (cust_id 1-1000) |             | (cust_id 1001+)  |
+------------------+             +------------------+
| payments         |             | payments         |
| (cust_id 1-1000) |             | (cust_id 1001+)  |
+------------------+             +------------------+

JOINs between customers, orders, payments are LOCAL
(no cross-shard coordination needed)
```

### 16.11.3 Cross-Shard Transactions

Single-instance MySQL gives you full ACID transactions. Sharding breaks this.

**Option 1: XA Transactions (Distributed 2PC)**

MySQL supports XA (eXtended Architecture) transactions:

```sql
-- On shard 0:
XA START 'txn-123-shard0';
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
XA END 'txn-123-shard0';
XA PREPARE 'txn-123-shard0';

-- On shard 1:
XA START 'txn-123-shard1';
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
XA END 'txn-123-shard1';
XA PREPARE 'txn-123-shard1';

-- Coordinator: both prepared successfully
XA COMMIT 'txn-123-shard0';
XA COMMIT 'txn-123-shard1';
```

Problems with XA:
- **Performance**: 2PC requires two round trips (PREPARE + COMMIT) to each shard.
  Each PREPARE is an fsync. Throughput drops 3-5x compared to local commits.
- **Blocking**: if the coordinator crashes between PREPARE and COMMIT, prepared
  transactions hold locks until manual resolution.
- **Operational complexity**: monitoring, timeout handling, orphaned transaction cleanup.

**Option 2: Saga Pattern (Eventually Consistent)**

A sequence of local transactions with compensating transactions for rollback:

```
Saga: Transfer $100 from Account A (Shard 0) to Account B (Shard 1)

Step 1: Debit A on Shard 0   (local transaction)
Step 2: Credit B on Shard 1  (local transaction)

If Step 2 fails:
  Compensate Step 1: Credit A on Shard 0 (undo the debit)

Timeline:
  |--- Step 1 (committed) ---|--- Step 2 (committed) ---|
  
  Between Step 1 and Step 2: $100 has "disappeared"
  (A debited, B not yet credited)
  This is the eventual consistency window
```

Sagas are simpler to implement and perform better than XA, but they:
- Have a consistency window where invariants are violated
- Require idempotent operations (retries must be safe)
- Require compensating transactions for every forward step

**>>> Interview tip: when discussing sharded transactions, state the tradeoff
explicitly. XA gives strong consistency at the cost of performance and
operational risk. Sagas give better performance at the cost of eventual
consistency. Most production systems choose Sagas and design around the
consistency window.**

### 16.11.4 Sequence Generation

AUTO_INCREMENT does not work across shards. If shard 0 and shard 1 both
auto-increment independently, you get duplicate IDs.

**Solutions**:

| Strategy | Mechanism | Pros | Cons |
|----------|-----------|------|------|
| Snowflake IDs | 64-bit: timestamp + machine_id + sequence | Sortable, no coordination | Clock skew issues, machine_id management |
| UUID v7 | 128-bit: timestamp + random | Sortable, no coordination, standard | 16 bytes vs 8 bytes, index bloat (Chapter 13) |
| Centralized ID service | Dedicated service allocates ID blocks | Simple, guaranteed unique | Single point of failure, network hop |
| Shard-offset | Shard 0: 0,4,8,12... Shard 1: 1,5,9,13... | Simple, no coordination | Fixed shard count baked into IDs |

```
Snowflake ID structure (64 bits):
+--+-------------------+----------+------------+
|  |    timestamp       | machine  |  sequence  |
|  |    (41 bits)       | (10 bits)|  (12 bits) |
+--+-------------------+----------+------------+
 |        |                  |           |
 |        |                  |           +-- 4096 IDs per ms per machine
 |        |                  +-- 1024 machines
 |        +-- ~69 years from epoch
 +-- sign bit (always 0)

Result: globally unique, roughly time-sortable, 8 bytes (fits BIGINT)
```

**>>> UUID v7 is the modern recommendation for new systems. It is time-sortable
(good for B+Tree insert patterns, see Chapter 13), 128 bits (no coordination
needed), and an IETF standard (RFC 9562). The 16-byte storage cost is
acceptable on modern hardware.**

### 16.11.5 Global Secondary Indexes

In a non-sharded MySQL, you create a secondary index and queries use it.
In a sharded system, secondary indexes are local to each shard. A query
by a non-shard-key column must scatter-gather.

**Solution 1: Vitess Lookup VIndex**

Vitess maintains a lookup table that maps the secondary column value to the
shard key, enabling single-shard routing:

```
orders table (sharded by customer_id):
  Shard 0: customer_id 1-1000
  Shard 1: customer_id 1001-2000

Lookup table (order_id -> customer_id):
+----------+-------------+
| order_id | customer_id |
+----------+-------------+
| 5001     | 42          |  -> Shard 0
| 5002     | 1500        |  -> Shard 1
| 5003     | 42          |  -> Shard 0
+----------+-------------+

Query: SELECT * FROM orders WHERE order_id = 5001
  1. Lookup: order_id 5001 -> customer_id 42
  2. Route: hash(42) -> Shard 0
  3. Execute: SELECT on Shard 0 only
```

**Solution 2: External Search Index (Elasticsearch)**

For full-text and complex queries across shard key boundaries, maintain
an Elasticsearch index alongside MySQL:

```
MySQL Shards (source of truth)          Elasticsearch (search index)
+--------+  +--------+  +--------+     +-------------------------+
|Shard 0 |  |Shard 1 |  |Shard 2 |     | orders index            |
|        |  |        |  |        | --> | (all shards, denormalized|
|        |  |        |  |        | CDC |  searchable fields)      |
+--------+  +--------+  +--------+     +-------------------------+

Change Data Capture (Debezium / Maxwell) streams changes to ES
```

---

## 16.12 Resharding -- The Hardest Part

Resharding -- changing the number of shards or moving data between shards --
is the most operationally dangerous procedure in a sharded system.

### 16.12.1 When to Reshard

- A shard exceeds storage capacity
- A shard is a hotspot (one tenant generating disproportionate load)
- Adding capacity (scaling from 4 to 8 shards)
- Rebalancing after uneven growth

### 16.12.2 Approach 1: Vitess Automated Resharding

Vitess handles resharding as a built-in operation:

```
Vitess Resharding: Split shard [-80] into [-40] and [40-80]

Phase 1: Provision
  - Create new MySQL instances for target shards
  - Set up VTTablets for new shards
  - Register in topology server

Phase 2: Clone
  - VReplication copies existing data from source to targets
  - Each target receives only rows in its keyrange
  - Source continues serving traffic during copy

Phase 3: Catch-up
  - VReplication tails the binlog from source shard
  - Applies only relevant changes to each target
  - Replication lag converges to near-zero

Phase 4: Verify
  - VDiff compares source and target data for consistency
  - Reports any discrepancies

Phase 5: Switch
  - SwitchReads: read traffic routes to new shards
  - SwitchWrites: write traffic routes to new shards
  - Brief write pause (typically < 1 second)

Phase 6: Cleanup
  - Remove old shard from topology
  - Decommission old MySQL instance
```

### 16.12.3 Approach 2: Manual Double-Write

Without Vitess, resharding is a manual multi-step process:

```
Manual Resharding Timeline:

Step 1: Set up new shard topology
  Old: [Shard 0] [Shard 1] [Shard 2] [Shard 3]
  New: [Shard 0] [Shard 1] [Shard 2] [Shard 3] [Shard 4] [Shard 5] [Shard 6] [Shard 7]

Step 2: Double-write
  Application writes to BOTH old shard AND new shard for every write
  Old shards continue serving reads

Step 3: Backfill
  Copy historical data from old shards to new shards
  (Must handle conflicts with double-writes -- idempotent upserts)

Step 4: Verify
  Compare row counts, checksums between old and new

Step 5: Switch reads
  Route read traffic to new shards
  Monitor for correctness

Step 6: Stop double-writes
  Route write traffic to new shards only

Step 7: Decommission old shards
```

This process takes weeks to months for large datasets and is error-prone.
Each step can fail, and rollback becomes increasingly difficult after
step 5.

### 16.12.4 Virtual Shards -- Minimizing Future Resharding

The smartest way to handle resharding is to avoid it. **Virtual shards**
(also called logical shards) decouple the number of logical shards from
the number of physical instances.

```
Virtual Shards Strategy:

256 virtual shards mapped to 4 physical MySQL instances:

  Physical Instance 0:  virtual shards 0-63
  Physical Instance 1:  virtual shards 64-127
  Physical Instance 2:  virtual shards 128-191
  Physical Instance 3:  virtual shards 192-255

Routing: shard_key -> hash -> virtual_shard_id (0-255)
         virtual_shard_id -> physical_instance (lookup table)

Scaling from 4 to 8 physical instances:
  Physical Instance 0:  virtual shards 0-31
  Physical Instance 4:  virtual shards 32-63    <-- new
  Physical Instance 1:  virtual shards 64-95
  Physical Instance 5:  virtual shards 96-127   <-- new
  Physical Instance 2:  virtual shards 128-159
  Physical Instance 6:  virtual shards 160-191  <-- new
  Physical Instance 3:  virtual shards 192-223
  Physical Instance 7:  virtual shards 224-255  <-- new

Data migration: move complete virtual shards (entire databases)
  No row-level re-routing needed
  Virtual shard 32 moves as a unit from Instance 0 to Instance 4
```

The key insight: within a virtual shard, no row's shard assignment changes.
You move entire virtual shard databases between physical instances. This is
a `mysqldump` + restore or a replication-based migration -- well-understood
operations.

**>>> In system design interviews, always mention virtual shards when
discussing sharding. It shows you understand that resharding is the
hardest operational problem and that pre-planning avoids it. Start with
256 or 1024 virtual shards, even if you initially have 4 physical instances.**

---

## 16.13 Sharding vs Other Scaling Options

Sharding is powerful but carries enormous operational complexity. Before
reaching for it, exhaust simpler alternatives.

### 16.13.1 The Scaling Ladder

```
Scaling options in order of increasing complexity:
(Exhaust each level before moving to the next)

Level 1: Query Optimization
  +--------------------------------------------+
  | - Add missing indexes (Chapter 14)          |
  | - Rewrite slow queries (EXPLAIN ANALYZE)    |
  | - Fix N+1 query patterns                    |
  | - Use covering indexes                      |
  | Cost: engineer time only                    |
  | Impact: 10x-1000x improvement possible      |
  +--------------------------------------------+
            |
            v
Level 2: Vertical Scaling
  +--------------------------------------------+
  | - More RAM (bigger buffer pool)             |
  | - Faster storage (NVMe, higher IOPS)        |
  | - More CPU cores                            |
  | Cost: $$$, but simple                       |
  | Impact: 2x-10x                              |
  +--------------------------------------------+
            |
            v
Level 3: Read Replicas
  +--------------------------------------------+
  | - Route reads to replicas (Chapter 12)      |
  | - ProxySQL / MySQL Router (Chapter 15)      |
  | - Application-level read/write splitting    |
  | Cost: N replica instances, replication lag   |
  | Impact: scales reads linearly               |
  +--------------------------------------------+
            |
            v
Level 4: Caching
  +--------------------------------------------+
  | - Redis / Memcached for hot data            |
  | - Application-level cache (Hibernate L2)    |
  | - CDN for static/semi-static data           |
  | Cost: cache invalidation complexity         |
  | Impact: 10x-100x reduction in DB queries    |
  +--------------------------------------------+
            |
            v
Level 5: Data Archival
  +--------------------------------------------+
  | - Move old data to archive tables/instances |
  | - Use partitioning for lifecycle management |
  | - Cold storage (S3, Glacier) for compliance |
  | Cost: application changes for archive access|
  | Impact: reduces active dataset dramatically  |
  +--------------------------------------------+
            |
            v
Level 6: Sharding
  +--------------------------------------------+
  | - Horizontal data distribution              |
  | - Per-shard topology management             |
  | - Cross-shard query complexity              |
  | - Resharding operational burden             |
  | Cost: months of engineering, ongoing ops    |
  | Impact: near-infinite horizontal scale      |
  +--------------------------------------------+
```

### 16.13.2 The Cost of Sharding

Before choosing sharding, quantify what it costs:

```
Engineering Cost:
  - Shard key analysis and data model changes: 2-4 weeks
  - Middleware setup (Vitess) or custom routing layer: 4-8 weeks
  - Cross-shard query handling: 2-4 weeks
  - Data migration: 2-8 weeks (depends on data volume)
  - Testing and validation: 4-8 weeks
  Total: 3-6 months of senior engineering time

Ongoing Operational Cost:
  - Per-shard monitoring and alerting
  - Per-shard backup and restore procedures
  - Per-shard failover runbooks
  - Schema migration coordination across shards
  - Resharding when shards grow unevenly
  - On-call complexity multiplied by shard count

What You Lose:
  - Simple JOINs across the full dataset
  - Simple aggregation queries (SELECT COUNT(*) FROM ...)
  - Single-instance ACID transactions
  - Simple schema changes (one ALTER TABLE)
  - Simple backup and restore (one mysqldump)
```

### 16.13.3 When Sharding IS the Right Answer

Despite the cost, sharding is necessary when:

1. **Write throughput exceeds single-instance capacity**: read replicas
   don't help with writes. Only sharding distributes write load.

2. **Data volume exceeds practical single-instance storage**: when the
   working set far exceeds available RAM and you can't buy a bigger machine,
   sharding is the only option.

3. **Tenant isolation**: large tenants on dedicated shards prevents noisy
   neighbors from affecting other tenants.

4. **Regulatory data residency**: data must reside in specific geographic
   regions. Geographic sharding is the natural solution.

**>>> "Sharding is the scaling option of last resort. The operational complexity
is enormous. Exhaust query optimization, vertical scaling, read replicas,
caching, and archival first. Many teams shard prematurely and spend years
paying the operational tax." This is a critical interview signal -- it shows
you understand that sharding is a tool of last resort, not a badge of honor.**

---

## 16.14 Partitioning + Sharding: Combining Both

In large-scale production systems, partitioning and sharding are often used
together. Each shard contains partitioned tables.

```
Combined architecture:

     Shard 0                    Shard 1                    Shard 2
+------------------+      +------------------+      +------------------+
| orders           |      | orders           |      | orders           |
| (customers 1-1M) |      | (customers 1M-2M)|      | (customers 2M-3M)|
|                  |      |                  |      |                  |
| +-----------+    |      | +-----------+    |      | +-----------+    |
| | p2023     |    |      | | p2023     |    |      | | p2023     |    |
| | p2024     |    |      | | p2024     |    |      | | p2024     |    |
| | p2025     |    |      | | p2025     |    |      | | p2025     |    |
| | pmax      |    |      | | pmax      |    |      | | pmax      |    |
| +-----------+    |      | +-----------+    |      | +-----------+    |
|                  |      |                  |      |                  |
| Sharding splits  |      | Sharding splits  |      | Sharding splits  |
| by customer      |      | by customer      |      | by customer      |
|                  |      |                  |      |                  |
| Partitioning     |      | Partitioning     |      | Partitioning     |
| splits by time   |      | splits by time   |      | splits by time   |
+------------------+      +------------------+      +------------------+
```

**Why combine them**:

- **Sharding** handles horizontal scale (more write throughput, more data)
- **Partitioning** handles data lifecycle within each shard (archival, purge)
- DROP PARTITION works per-shard, keeping data retention simple
- Each shard's partitions are independently managed

**Example at scale**:
- 32 shards (hash-based on customer_id)
- Each shard: orders table partitioned by RANGE(YEAR(order_date))
- 5 year retention: 5 partitions per shard
- DROP PARTITION runs on each shard to purge data older than 5 years
- New year partition added via automated cron on each shard

---

## 16.15 ProxySQL and Custom Sharding Layers

Not every team adopts Vitess. For simpler sharding needs, lightweight
middleware can handle shard routing.

### 16.15.1 ProxySQL Shard Routing

ProxySQL (covered in Chapter 15 for connection pooling and read/write
splitting) can also route queries to specific shards based on query rules:

```
ProxySQL shard routing rules:

Rule 1: customer_id present in query
  -> Extract customer_id via regex
  -> Compute shard_id = hash(customer_id) % num_shards
  -> Route to hostgroup for shard_id

Rule 2: No customer_id in query
  -> Route to all shard hostgroups (scatter)
  -> Merge results

Configuration:
  INSERT INTO mysql_query_rules (
    rule_id, match_pattern, destination_hostgroup, apply
  ) VALUES (
    1, 'customer_id\s*=\s*(\d+)', NULL, 1  -- dynamic routing
  );
```

Limitations: ProxySQL's query parsing is regex-based, not a full SQL parser.
Complex queries may not route correctly. Vitess has a full SQL parser and
is more reliable for production sharding.

### 16.15.2 Application-Level Sharding

The simplest approach: the application determines the shard and connects
directly.

```java
// Java example: application-level shard routing
public class ShardRouter {
    private final Map<Integer, DataSource> shardDataSources;
    private final int numShards;

    public DataSource getShardForCustomer(long customerId) {
        int shardId = Math.abs(Long.hashCode(customerId)) % numShards;
        return shardDataSources.get(shardId);
    }

    public <T> List<T> scatterGather(String sql, RowMapper<T> mapper) {
        return shardDataSources.values().parallelStream()
            .flatMap(ds -> executeQuery(ds, sql, mapper).stream())
            .collect(Collectors.toList());
    }
}
```

This is the approach many companies start with. It works until:
- Resharding requires application changes
- Cross-shard queries become complex
- Connection management becomes a burden
- Multiple applications need shard-aware code

At that point, middleware (Vitess, ProxySQL, or a custom proxy) is the
natural evolution.

---

## 16.16 Real-World Partitioning and Sharding Patterns

### 16.16.1 Pattern: Time-Series with Rolling Partitions

```
System: E-commerce order history (500M orders, growing 2M/day)

Schema:
  CREATE TABLE orders (
      id BIGINT AUTO_INCREMENT,
      order_date DATE NOT NULL,
      customer_id BIGINT NOT NULL,
      amount DECIMAL(10,2),
      PRIMARY KEY (id, order_date),
      INDEX idx_customer (customer_id, order_date)
  ) PARTITION BY RANGE (TO_DAYS(order_date)) (
      PARTITION p202401 VALUES LESS THAN (TO_DAYS('2024-02-01')),
      PARTITION p202402 VALUES LESS THAN (TO_DAYS('2024-03-01')),
      -- ... monthly partitions ...
      PARTITION pmax VALUES LESS THAN MAXVALUE
  );

Operations:
  - Monthly cron: REORGANIZE pmax to add next month's partition
  - Quarterly: EXCHANGE oldest partition with archive table
  - Archive table compressed and backed up to S3
  - Active partitions: 24 months (24 partitions)
  - 95% of queries filter by order_date -> excellent pruning
```

### 16.16.2 Pattern: Multi-Tenant SaaS with Vitess

```
System: B2B SaaS platform (10,000 tenants, 50 TB total data)

Sharding:
  - Shard key: tenant_id
  - 64 shards (Vitess keyspace)
  - Hash vindex on tenant_id for even distribution
  - "Whale" tenants (top 5 by data volume) on dedicated shards

Per-shard:
  - Primary + 2 replicas
  - 128 GB buffer pool per instance
  - Tables partitioned by RANGE(created_at) for lifecycle management

Cross-shard:
  - Admin dashboard queries scatter-gather (acceptable for internal tools)
  - Tenant-facing queries always include tenant_id (single-shard)
  - Global search powered by Elasticsearch (CDC via Debezium)
```

### 16.16.3 Pattern: Financial Ledger with Geographic Sharding

```
System: Payment processing across US, EU, APAC

Sharding:
  - Geographic shards: us-east, eu-west, ap-southeast
  - Shard key: payment_region (derived from merchant country)
  - Directory-based routing (regulatory requirement: data residency)

Per-shard:
  - InnoDB with innodb_flush_log_at_trx_commit = 1 (full durability)
  - Synchronous replication within region (Group Replication)
  - Async replication to DR region
  - Tables partitioned by RANGE(transaction_date) for retention

Cross-shard:
  - Global settlement: nightly batch job aggregates across all shards
  - XA transactions for cross-region transfers (rare, <0.1% of volume)
  - Each region is autonomous for 99.9% of operations
```

---

## 16.17 Common Interview Questions and Answers

### Q: "Our orders table has 2 billion rows and queries are slow. Should we partition?"

Structured answer:

```
1. First: check if queries are using indexes properly
   - EXPLAIN ANALYZE the slow queries
   - Missing index on filter column is 100x more impactful than partitioning

2. Check if the problem is read or write:
   - Read: consider read replicas + caching before partitioning
   - Write: partitioning doesn't help write throughput (same instance)

3. If queries are time-bounded (WHERE order_date > X):
   - RANGE partition by order_date
   - Pruning reduces scanned data dramatically
   - DROP PARTITION for archival is the killer feature

4. If queries are NOT time-bounded:
   - Partitioning likely hurts (full partition scan)
   - Consider sharding if single instance can't cope
```

### Q: "How do you handle a migration from a single MySQL instance to a sharded architecture?"

```
Phase 1: Preparation (weeks 1-4)
  - Profile query patterns to choose shard key
  - Identify cross-shard query requirements
  - Design denormalization strategy for JOINs
  - Choose middleware (Vitess recommended)

Phase 2: Dual-Write (weeks 5-12)
  - Set up target shards
  - Application writes to both old and new
  - Backfill historical data to new shards
  - Verify data consistency (checksums, row counts)

Phase 3: Cutover (week 13)
  - Switch reads to new shards (shadow reads first)
  - Compare results between old and new
  - Switch writes to new shards
  - Monitor for 1-2 weeks

Phase 4: Cleanup (week 14-16)
  - Remove dual-write code
  - Decommission old single instance
  - Document shard topology and runbooks
```

### Q: "Why can't you just use a bigger machine instead of sharding?"

```
Vertical scaling works until:
  1. Diminishing returns: 2x machine cost != 2x performance
  2. Write ceiling: one redo log, one set of undo tablespaces
  3. Single point of failure: bigger machine = bigger blast radius
  4. Cost: largest cloud instances are 10-50x more expensive per unit
  5. Hard limits: max RAM, max cores, max IOPS on a single machine

But vertical scaling should ALWAYS be tried first because:
  1. Zero application changes
  2. Zero operational complexity increase
  3. Hours to implement vs months for sharding
  4. AWS r6g.16xlarge (512 GB RAM, 64 vCPU) handles most workloads
```

### Q: "What is the difference between MySQL partitioning and PostgreSQL partitioning?"

```
Key differences:
  1. MySQL requires partition column in every unique index.
     PostgreSQL allows global unique indexes (since PG 11).

  2. MySQL has no global secondary index.
     PostgreSQL indexes span all partitions by default.

  3. MySQL partitioning is native (single executor handles all partitions).
     PostgreSQL uses inheritance-based partitioning (declarative since PG 10).

  4. MySQL: max 8192 partitions.
     PostgreSQL: no hard limit (but performance degrades past ~1000).

  5. MySQL EXCHANGE PARTITION has no PostgreSQL equivalent.
     PostgreSQL uses ATTACH/DETACH PARTITION (similar concept, different syntax).

  6. Both support RANGE, LIST, HASH.
     PostgreSQL also supports custom partitioning via procedural logic.
```

---

## 16.18 Chapter Summary

```
Decision Matrix:
+-------------------------------------------------------+
|                                                       |
|  Data lifecycle management needed?                    |
|       YES ──> MySQL Partitioning (RANGE by time)      |
|       NO  ──> Don't partition                         |
|                                                       |
|  Single instance at capacity?                         |
|       YES ──> Walk the scaling ladder:                |
|               1. Optimize queries                     |
|               2. Vertical scale                       |
|               3. Read replicas                        |
|               4. Cache                                |
|               5. Archive                              |
|               6. THEN shard (if all else exhausted)   |
|       NO  ──> Don't shard                             |
|                                                       |
|  Must shard?                                          |
|       YES ──> Vitess (unless strong reason not to)    |
|               Virtual shards (256+) from day one      |
|               Co-locate related tables on same shard  |
|               Design for single-shard queries         |
|               Plan for cross-shard aggregation        |
|       NO  ──> Celebrate. Sharding is expensive.       |
|                                                       |
+-------------------------------------------------------+
```

**Key takeaways**:

1. **Partitioning** is a single-instance optimization for data lifecycle
   management. Its power comes from partition pruning and instant partition
   operations (DROP, EXCHANGE). Without pruning, it makes queries worse.

2. **Sharding** is multi-instance horizontal scaling. It solves capacity
   problems that no single machine can handle. The shard key determines
   everything -- choose it based on query patterns, not data distribution.

3. **Vitess** is the production-grade answer to MySQL sharding. It handles
   shard routing, resharding, schema management, and connection pooling.

4. **Virtual shards** minimize future resharding pain. Over-provision
   logical shards from day one.

5. **Sharding is the option of last resort.** The operational tax is real
   and ongoing. Exhaust every other scaling option first.

---

*Next chapter: [Chapter 17 — High Availability and Disaster Recovery](17-high-availability-and-disaster-recovery.md) covers what happens when shards fail -- Group Replication, InnoDB Cluster, orchestrator-based failover, and zero-downtime topology changes.*
