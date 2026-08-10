# MySQL InnoDB Internals — Deep Technical Reference

> Target: Senior Java/systems engineer. 40 LPA system design interviews.

---

## 1. InnoDB Architecture Overview

```
+---------------------------------------------------+
|                  InnoDB Storage Engine            |
|                                                   |
|  +------------------+  +----------------------+  |
|  |   Buffer Pool    |  |   Change Buffer      |  |
|  |  (LRU young+old) |  | (defer secondary idx)|  |
|  +------------------+  +----------------------+  |
|                                                   |
|  +------------------+  +----------------------+  |
|  | Adaptive Hash    |  |   Log Buffer         |  |
|  |    Index (AHI)   |  | (redo log staging)   |  |
|  +------------------+  +----------------------+  |
|                                                   |
|  +------------------------------------------+    |
|  |         Undo Log Tablespace              |    |
|  |  (version chain for MVCC + rollback)     |    |
|  +------------------------------------------+    |
|                                                   |
|  +------------------------------------------+    |
|  |         Redo Log (circular)              |    |
|  |    ib_logfile0  ib_logfile1              |    |
|  +------------------------------------------+    |
|                                                   |
|  +------------------------------------------+    |
|  |       .ibd files (tablespaces)           |    |
|  |   clustered B+Tree + secondary indexes   |    |
|  +------------------------------------------+    |
+---------------------------------------------------+
```

---

## 2. Buffer Pool

### 2.1 Structure

The buffer pool caches data pages, index pages, adaptive hash index entries, the change buffer, and undo log pages in RAM. Default page size = 16 KB.

Can be split into multiple **buffer pool instances** (`innodb_buffer_pool_instances`, default 8) to reduce mutex contention on the LRU list.

### 2.2 LRU with Young/Old Sublists

Standard LRU evicts the least recently accessed page — problematic for full-table scans (pollutes the cache with cold data). InnoDB solution: **midpoint insertion strategy**.

```
        HEAD                                    TAIL
+--------+--------+   midpoint   +--------+--------+
| young  | young  |      |       | old    | old    |
| (new)  | pages  |      |       | pages  | (LRU)  |
+--------+--------+      |       +--------+--------+
<--------- 5/8 --------->|<---------- 3/8 -------->
                         ^
              innodb_old_blocks_pct = 37 (default)
              = 37% of buffer pool is "old" sublist
```

**Insertion**: new page read from disk → inserted at midpoint (head of old sublist), NOT at head of young sublist.

**Promotion to young sublist**: requires the page to be accessed a second time AND at least `innodb_old_blocks_time` milliseconds (default 1000ms) after initial insertion. This prevents full scans from flooding young sublist.

**Eviction**: from tail of old sublist (truly cold pages).

**Result**: hot OLTP working set stays in young sublist; large sequential scans touch pages in old sublist briefly and they get evicted without polluting young pages.

### 2.3 Adaptive Hash Index (AHI)

InnoDB automatically builds an in-memory hash index for frequently accessed B-Tree leaf pages.

- Only for equality predicates (`WHERE id = 123`)
- Hash index maps `(index_key)` → `(leaf page pointer)`
- Bypasses B-Tree traversal entirely → O(1) instead of O(log N)
- Built and maintained automatically; cannot be explicitly created
- Can be disabled: `innodb_adaptive_hash_index = OFF` (helps under heavy write contention on AHI latch)

### 2.4 Change Buffer

When a secondary index page is NOT in the buffer pool and a DML (INSERT/UPDATE/DELETE) modifies it, InnoDB defers the secondary index write to the **change buffer** (a special B-Tree stored in the system tablespace).

Later, when the index page is read into the buffer pool (due to a query), the buffered changes are **merged** into the page (**change buffer merge**).

Benefits: converts random I/O (writing scattered secondary index pages) into sequential writes to change buffer.

Only works for **non-unique secondary indexes** (unique indexes require immediate read to check uniqueness).

```
innodb_change_buffer_max_size = 25  (% of buffer pool)
innodb_change_buffering = all       (buffer inserts, deletes, purges)
```

---

## 3. MVCC in InnoDB

### 3.1 InnoDB vs PostgreSQL MVCC Comparison

| Aspect | PostgreSQL | InnoDB |
|--------|-----------|--------|
| Old versions stored | In heap (table pages) | In undo log (separate) |
| Cleanup mechanism | VACUUM | Purge thread |
| Bloat location | Table/index files | Undo tablespace |
| Visibility check | Snapshot + pg_xact lookup | ReadView + undo log traversal |
| Version chain | t_ctid forward pointer | `DB_ROLL_PTR` in row header |

### 3.2 Row Header Hidden Columns

Every InnoDB row has 3 hidden system columns:

| Column | Size | Purpose |
|--------|------|---------|
| `DB_TRX_ID` | 6B | Transaction ID of last INSERT or UPDATE |
| `DB_ROLL_PTR` | 7B | Pointer to undo log record for this version |
| `DB_ROW_ID` | 6B | Auto-generated row ID (only if no PK/unique key) |

### 3.3 ReadView

A **ReadView** is a snapshot of active transaction state at a point in time. Contains:
- `creator_trx_id` — XID of the transaction creating this view
- `m_ids[]` — list of active (uncommitted) transaction IDs when snapshot was taken
- `m_low_limit_id` — minimum transaction ID that was active
- `m_up_limit_id` — next XID to be assigned (all XIDs >= this are invisible)

**Visibility rule** for a row version with `DB_TRX_ID = trx_id`:
```
IF trx_id == creator_trx_id        → visible (my own changes)
ELSE IF trx_id >= m_up_limit_id    → NOT visible (started after snapshot)
ELSE IF trx_id < m_low_limit_id    → visible (committed before any active txn)
ELSE IF trx_id IN m_ids[]          → NOT visible (was active when snapshot taken)
ELSE                               → visible (committed before snapshot)
```

If current version not visible → follow `DB_ROLL_PTR` to undo log for older version → repeat.

### 3.4 RC vs RR — The Key Difference

| Isolation | ReadView created | Effect |
|-----------|----------------|--------|
| READ COMMITTED | Per **statement** | Sees data committed before each statement — non-repeatable reads possible |
| REPEATABLE READ | Per **transaction** (first SELECT) | Same snapshot for entire transaction — consistent reads |

This is the fundamental MVCC lever in InnoDB. Same code path, different ReadView lifetime.

### 3.5 Undo Log Architecture

**Two types of undo logs**:
- **Insert undo log**: only needed for transaction rollback; deleted after transaction commits
- **Update undo log**: needed for rollback AND MVCC visibility; held until no active ReadView references the version

**Undo log segments** are stored in the undo tablespace (`innodb_undo_tablespace`, separate files since MySQL 8.0). Each transaction gets its own undo log segment.

**Purge thread**: background thread that deletes undo log records no longer needed by any ReadView. Analog of PostgreSQL's VACUUM for undo logs.

```sql
-- Monitor undo log size
SHOW STATUS LIKE 'Innodb_undo%';
SHOW ENGINE INNODB STATUS\G  -- "TRANSACTION" section shows undo history length
```

**Undo history length growing** = long-running transaction holding old ReadView → purge thread blocked → undo tablespace grows → performance degrades.

---

## 4. B+Tree Index Internals

### 4.1 Clustered Index (Primary Key)

InnoDB stores the actual **row data inside the primary key B+Tree leaf pages**. This is called a **clustered index** (or index-organized table).

```
Clustered Index B+Tree:

Internal page:  [10 | ptr] [50 | ptr] [90 | ptr]
                   |           |          |
Leaf page:   [(1,rowA)(5,rowB)(9,rowC)]  [(51,rowD)(70,rowE)]  ...
              ^ full row data here ^
```

**Implication**: by PK lookup = one B-Tree traversal → leaf page → done. All columns available.

**Choosing a PK**: monotonically increasing integers (AUTO_INCREMENT, BIGINT) are ideal. Random UUIDs as PK cause **page splits and index fragmentation** because insertions are scattered across the B-Tree rather than appended to the rightmost leaf.

### 4.2 Secondary Indexes

Secondary index leaf nodes contain `(indexed_column_value, primary_key_value)` — NOT the full row.

```
Secondary index on (email):
Leaf page:  [(alice@..., pk=7), (bob@..., pk=2), (carol@..., pk=15)]
```

**Double lookup (bookmark lookup)**:
1. Traverse secondary index → get PK value
2. Traverse clustered index with PK → get row

**Covering index**: if all columns needed by the query are in the secondary index, step 2 is skipped. This is the "Using index" in EXPLAIN output.

```sql
-- Covering index for this query:
-- SELECT name, email FROM users WHERE email = 'alice@example.com'
CREATE INDEX idx_email_name ON users(email, name);
-- email is search key, name is also in index → no clustered index lookup needed
```

### 4.3 Index Cardinality and Statistics

```sql
ANALYZE TABLE users;          -- Update index statistics
SHOW INDEX FROM users;        -- See Cardinality column
```

InnoDB uses **random dive sampling** to estimate cardinality. `innodb_stats_persistent_sample_pages` (default 20) controls accuracy vs speed. Poor cardinality estimates → bad query plans.

---

## 5. Redo Log

### 5.1 Structure

The redo log is a **circular buffer** of fixed-size log files on disk. Default: two 50-MB files (`ib_logfile0`, `ib_logfile1`). MySQL 8.0.30+ supports dynamic redo log sizing.

```
Redo log file ring:
[ib_logfile0: 50MB][ib_logfile1: 50MB] → wraps around

                  checkpoint_lsn
                       |
[...old...written...|checkpoint|...active WAL...latest_lsn...]
```

### 5.2 LSN and Checkpoints

**LSN (Log Sequence Number)**: monotonically increasing byte offset into the redo log stream.

Every page in the buffer pool has an `oldest_modification_lsn`. When a page is flushed to disk, `oldest_modification_lsn` is cleared.

**Checkpoint**: InnoDB periodically advances the checkpoint LSN to the oldest LSN of any dirty page in the buffer pool. Log space before checkpoint can be reused (overwritten).

```
innodb_log_file_size (per file) + innodb_log_files_in_group = total redo log space
```

**If redo log fills up**: InnoDB is forced to flush dirty pages synchronously to advance the checkpoint → **sharp performance drop** (log write stall). Size the redo log to hold at least 1 hour of writes.

**MySQL 8.0.30+**: `innodb_redo_log_capacity` — single parameter, InnoDB manages files automatically.

### 5.3 Crash Recovery with Redo Log

1. On restart, InnoDB finds last `checkpoint_lsn` in log header
2. Reads redo log from `checkpoint_lsn` to end of written log
3. Replays all changes (`REDO` phase) → brings all pages to crash-consistent state
4. Rolls back uncommitted transactions using undo logs (`UNDO` phase)

---

## 6. Locking in InnoDB

### 6.1 Record Locks, Gap Locks, Next-Key Locks

InnoDB operates on **index records**, not physical rows.

**Record Lock**: locks a single index record.
```sql
SELECT * FROM orders WHERE id = 5 FOR UPDATE;
-- Acquires record lock on index entry id=5
```

**Gap Lock**: locks the gap between two index values (no actual record). Prevents INSERT into the gap.
```sql
-- If id=5 exists and id=10 exists:
SELECT * FROM orders WHERE id BETWEEN 6 AND 9 FOR UPDATE;
-- Gap lock on (5, 10) — prevents INSERT of id=6,7,8,9
```

**Next-Key Lock** = Record Lock + Gap Lock on the gap before the record.
- Default locking granularity under REPEATABLE READ
- Next-key lock on record with key `K` = lock record `K` + lock gap `(prev_key, K]`

```
Index: [1, 5, 10, 15, 20]
Next-key locks covering id=10: (-inf,1], (1,5], (5,10], (10,15]
Query: SELECT ... WHERE id = 10 FOR UPDATE
→ Locks: record 10 + gap (5,10]
```

### 6.2 How Next-Key Locks Prevent Phantom Reads

```sql
-- Transaction 1 (RR isolation):
SELECT COUNT(*) FROM orders WHERE status = 'pending';
-- Acquires next-key locks on all 'pending' index entries + gaps between them

-- Transaction 2 (concurrent):
INSERT INTO orders (status) VALUES ('pending');
-- BLOCKED by gap lock from Transaction 1
-- → Transaction 1 will see same COUNT on re-read → no phantom
```

### 6.3 Deadlocks

InnoDB detects deadlocks automatically, rolls back the transaction with the least "weight" (number of rows changed), and raises error 1213. Application must retry.

```sql
SHOW ENGINE INNODB STATUS\G  -- "LATEST DETECTED DEADLOCK" section
```

Common deadlock pattern in Java: two transactions acquiring rows in different orders. Solution: always acquire locks in a consistent order.

### 6.4 EXPLAIN — Type Column Decoded

| Type | Description | When |
|------|-------------|------|
| `const` | PK/unique key equality, 0-1 rows | `WHERE pk = 5` |
| `eq_ref` | PK/unique key join, one row per outer | JOIN on PK |
| `ref` | Non-unique index equality | `WHERE status = 'active'` |
| `range` | Index range scan | `WHERE id BETWEEN 1 AND 100` |
| `index` | Full index scan (all pages) | ORDER BY on indexed column, covers query |
| `ALL` | Full table scan | No usable index |

Performance order: `const > eq_ref > ref > range > index > ALL`

Key extra info:
- `Using index` = covering index (no back-lookup to clustered index)
- `Using index condition` = Index Condition Pushdown (ICP): filter applied at storage engine level
- `Using filesort` = in-memory or disk sort (no index ordering)
- `Using temporary` = needs temp table (GROUP BY/ORDER BY on non-indexed columns)

---

## 7. Replication

### 7.1 Binary Log Formats

```sql
binlog_format = STATEMENT | ROW | MIXED
```

| Format | What's logged | Pros | Cons |
|--------|-------------|------|------|
| STATEMENT | SQL statements | Small log | Non-deterministic functions (NOW(), RAND()) → inconsistency |
| ROW | Before/after row images | Deterministic; safe for all operations | Large log (every changed row) |
| MIXED | STATEMENT by default, ROW for non-deterministic | Balance | Complex |

**ROW format** is now the default and recommended for most setups. Essential for change-data-capture (CDC) tools like Debezium.

### 7.2 GTID-Based Replication

**GTID (Global Transaction Identifier)** = `source_uuid:transaction_sequence_number`

```
Example GTID: 3E11FA47-71CA-11E1-9E33-C80AA9429562:23
```

Benefits:
- Each transaction has a unique, globally consistent ID
- Replicas can auto-position without specifying binlog file/offset
- Easier failover: replica connects to new primary, syncs by GTID gap
- Circular replication protection: reject GTIDs already in `@@GLOBAL.gtid_executed`

```sql
SHOW MASTER STATUS\G         -- shows GTID state on primary
SHOW REPLICA STATUS\G        -- shows replica GTID position
```

### 7.3 Replication Architecture

```
Primary (binary log)
    |
    +---> Replica 1 (I/O thread → relay log → SQL thread)
    |
    +---> Replica 2 (parallel SQL threads for multi-threaded replication)
```

**Parallel replication** (`replica_parallel_workers`): MySQL 8.0 supports applying transactions in parallel on replica, grouped by database or by commit group (WRITESET). Dramatically reduces replica lag on high-throughput primaries.

### 7.4 Semi-Synchronous Replication

Primary waits for at least one replica to acknowledge receiving (not applying) the binlog event before returning commit to client.

```sql
INSTALL PLUGIN rpl_semi_sync_source SONAME 'semisync_source.so';
SET GLOBAL rpl_semi_sync_source_enabled = 1;
SET GLOBAL rpl_semi_sync_source_timeout = 1000;  -- ms; fall back to async if no ack
```

RPO: near-zero (one transaction can be lost only if the single-ack replica also fails).

### 7.5 Group Replication (MySQL InnoDB Cluster)

All nodes participate in a **Paxos-based consensus protocol** (MySQL's implementation called "XCom"). Writes must be certified by group majority.

```
Client → Primary → Group Communication System (Paxos/XCom)
                        ↓ certify
              All nodes apply the certified transaction
```

Modes:
- **Single-primary mode**: one writer, rest are replicas (read scale-out)
- **Multi-primary mode**: all nodes accept writes (conflict detection via certification)

**Certification**: before applying, each node checks if the transaction's write set conflicts with other concurrent transactions. Conflicting transaction is rolled back.

---

## 8. HikariCP — Java Connection Pooling

### 8.1 Why HikariCP is the Gold Standard

- Minimal bytecode (~130KB)
- `ConcurrentBag` — lock-free connection bag (no `synchronized` blocks)
- Fast connection acquisition via thread-local + shared queue hybrid
- Zero idle-connection overhead (`allowMaximumPoolSize` separate from `minimumIdle`)

### 8.2 Critical Configuration for MySQL

```java
HikariConfig config = new HikariConfig();
config.setJdbcUrl("jdbc:mysql://host:3306/db?useSSL=true&serverTimezone=UTC");
config.setUsername("user");
config.setPassword("pass");

// Pool sizing
config.setMaximumPoolSize(10);           // Rule of thumb: (2 * CPU_cores) + effective_disk_spindles
config.setMinimumIdle(5);
config.setIdleTimeout(600_000);         // 10 min: evict idle connections
config.setMaxLifetime(1_800_000);        // 30 min: force recycle before MySQL's wait_timeout
config.setConnectionTimeout(30_000);    // 30s: fail fast if pool exhausted

// Critical: detect stale connections
config.setKeepaliveTime(60_000);        // Ping MySQL every 60s for idle connections
config.setConnectionTestQuery("SELECT 1"); // for drivers that don't support isValid()

// InnoDB-specific
config.addDataSourceProperty("cachePrepStmts", "true");
config.addDataSourceProperty("prepStmtCacheSize", "250");
config.addDataSourceProperty("prepStmtCacheSqlLimit", "2048");
config.addDataSourceProperty("useServerPrepStmts", "true");  // server-side prepared stmts
```

### 8.3 Pool Sizing — Avoiding the N+1 Pool Problem

**`wait_timeout` pitfall**: MySQL closes idle connections server-side after `wait_timeout` (default 8h, often reduced to 10min on cloud). HikariCP's `maxLifetime` must be less than MySQL's `wait_timeout`.

**Pool size formula (Hikari docs)**:
```
pool_size = Tn × Cm
where Tn = max concurrent threads, Cm = average concurrent connections per thread
Practical: start at 10, monitor pool-wait metrics, increase only if pool exhaustion observed
```

**Spring Boot 3 auto-configuration**:
```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 10
      minimum-idle: 5
      idle-timeout: 600000
      max-lifetime: 1800000
      connection-timeout: 30000
      keepalive-time: 60000
```

---

## 9. Partitioning

### 9.1 Partition Types

| Type | Use case | Example |
|------|----------|---------|
| RANGE | Time-based, sequential ranges | Partition by year |
| LIST | Discrete values | Partition by region code |
| HASH | Distribute evenly | Partition by user_id HASH |
| KEY | Like HASH but uses MySQL's hashing function | General purpose |

### 9.2 Limitations of MySQL Partitioning

- **Every partition is a separate .ibd file** (or file-per-partition with file-per-table)
- **No global secondary index** spanning partitions (like PostgreSQL, unlike Oracle)
- **Foreign keys**: partitioned tables cannot have (or reference) foreign keys
- **Partition pruning**: optimizer eliminates partitions using WHERE clauses — only works if partition column is in WHERE

```sql
CREATE TABLE events (
    id BIGINT NOT NULL AUTO_INCREMENT,
    event_time DATETIME NOT NULL,
    ...
    PRIMARY KEY (id, event_time)  -- partition key must be part of PK
) PARTITION BY RANGE (YEAR(event_time)) (
    PARTITION p2022 VALUES LESS THAN (2023),
    PARTITION p2023 VALUES LESS THAN (2024),
    PARTITION p2024 VALUES LESS THAN (2025),
    PARTITION pmax  VALUES LESS THAN MAXVALUE
);
```

---

## Interview Quick-Fire Reference

| Question | Key Answer |
|----------|-----------|
| Where does InnoDB store row data? | In the clustered (primary key) B+Tree leaf pages |
| What does a secondary index contain? | (indexed_column, primary_key_value) — not full row |
| How does InnoDB MVCC differ from PostgreSQL? | Old versions in undo log (not heap); ReadView per-statement (RC) or per-transaction (RR) |
| What is a next-key lock? | Record lock + gap lock before it; prevents phantom reads in RR |
| EXPLAIN type=ALL vs type=ref | ALL = full table scan; ref = non-unique index equality lookup |
| InnoDB redo log fills up → what happens? | Forced dirty page flush → performance stall; size redo log larger |
| Why use covering index? | Avoids double-lookup (secondary index → clustered index); "Using index" in EXPLAIN |
| What does the change buffer do? | Defers writes to non-unique secondary index pages not in buffer pool; merges on read |
| HikariCP maxLifetime purpose? | Force connection recycle before MySQL closes idle connection via wait_timeout |
| ROW vs STATEMENT binlog | ROW: safe for all DML including non-deterministic; larger; required for CDC (Debezium) |
