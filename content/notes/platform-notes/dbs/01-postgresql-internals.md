# PostgreSQL Internals — Deep Technical Reference

> Target: Senior Java/systems engineer. 40 LPA system design interviews. Every section goes below the API surface.

---

## 1. MVCC — Multi-Version Concurrency Control

### 1.1 Heap Tuple Format

Every row in a PostgreSQL heap file is called a **tuple**. On disk each page is 8 KB (default). A tuple's on-disk layout:

```
+------------------+------------------+------+---------+---------+
|  t_xmin (4 B)    |  t_xmax (4 B)    | ... | t_ctid  | t_infomask ... | user columns |
+------------------+------------------+------+---------+---------+
```

Key fields in `HeapTupleHeaderData`:

| Field | Size | Meaning |
|-------|------|---------|
| `t_xmin` | 4 B | XID of the INSERT transaction |
| `t_xmax` | 4 B | XID of DELETE/UPDATE transaction; 0 = live |
| `t_ctid` | 6 B | Physical location (page, offset) of current version |
| `t_infomask` | 2 B | Hint bits: HEAP_XMIN_COMMITTED, HEAP_XMAX_COMMITTED, etc. |
| `t_infomask2` | 2 B | Number of attributes + HOT flags |

**UPDATE creates two tuples**: old tuple gets `t_xmax` set; new tuple is inserted with new `t_xmin`. The old `t_ctid` points to the new tuple (version chain).

### 1.2 Transaction IDs (XID) and the XID Wraparound Problem

XIDs are 32-bit unsigned integers. At ~2 billion transactions, they wrap. PostgreSQL uses modular arithmetic — the "past" is the 2 billion XIDs older than current. **Freeze** mechanism: VACUUM sets `t_xmin = FrozenTransactionId (2)` for old enough tuples so they are always visible regardless of XID.

```
autovacuum_freeze_max_age = 200,000,000   (trigger freeze vacuum before this)
vacuum_freeze_min_age     = 50,000,000    (only freeze tuples older than this)
```

### 1.3 CLOG (Commit Log) — now pg_xact

`pg_xact/` directory stores 2 bits per XID:

```
00 = IN_PROGRESS
01 = COMMITTED
10 = ABORTED
11 = SUB_COMMITTED (subtransaction)
```

Stored in 8-KB pages (each page covers 32,768 XIDs). In-memory: `clog_cache` is a ring buffer of pages.

**Hint Bits optimization**: Once PostgreSQL confirms a transaction's status from pg_xact, it caches the result in `t_infomask` (`HEAP_XMIN_COMMITTED` / `HEAP_XMIN_INVALID`). Subsequent visibility checks skip the pg_xact lookup entirely. This is why pg_xact reads do not dominate normal query time.

### 1.4 Snapshot and Visibility Check Algorithm

A **snapshot** captures, at transaction start:
- `xmin` — oldest active XID
- `xmax` — first XID not yet assigned
- `xip[]` — list of in-progress XIDs

```
Visibility rule for a tuple (t_xmin, t_xmax):

1. Is t_xmin committed?
   - If IN_PROGRESS → not visible (not inserted yet)
   - If ABORTED → not visible
   - If COMMITTED:
       a. Was t_xmin in xip[] at snapshot time? → not visible (it was in-progress when snapshot was taken)
       b. Was t_xmin >= snapshot.xmax? → not visible (started after snapshot)
       c. Otherwise → t_xmin is visible to this snapshot

2. Is t_xmax set?
   - If 0 → tuple is live
   - If ABORTED → ignore (deletion rolled back), tuple is live
   - If COMMITTED:
       a. Was t_xmax in xip[] at snapshot time? → deletion not visible, tuple is live
       b. Was t_xmax >= snapshot.xmax? → deletion happened after snapshot, tuple is live
       c. Otherwise → tuple is deleted from this snapshot's perspective
```

---

## 2. VACUUM and Autovacuum

### 2.1 Why Dead Tuples Accumulate

Every UPDATE leaves the old tuple version ("dead tuple") in the heap until VACUUM. DELETE also leaves dead tuples. A high-UPDATE workload causes **table bloat** — heap grows without corresponding data growth.

Dead tuple = a tuple whose `t_xmax` is committed and no open transaction can see it anymore.

### 2.2 Free Space Map (FSM)

`pg_fsm` (one per table, stored alongside the heap file). Tracks free bytes per page as an 8-level tree. Only 1 byte per page → approximate. VACUUM updates FSM after cleaning a page. New INSERT probes FSM to find a page with enough space.

```
FSM structure: binary tree, each internal node = max(children)
Root = max free space in whole table
INSERT: walk tree to find leaf page with free >= row_size
```

### 2.3 Visibility Map (VM)

One bit per heap page:
- **All-visible bit**: all tuples on this page are visible to all current/future transactions → index-only scans can skip heap fetch
- **All-frozen bit**: all tuples frozen → VACUUM can skip the page entirely

### 2.4 Regular VACUUM vs VACUUM FULL

| Aspect | VACUUM | VACUUM FULL |
|--------|--------|-------------|
| Lock | ShareUpdateExclusiveLock (concurrent reads/writes OK) | AccessExclusiveLock (table completely locked) |
| Space reclaim | Marks dead space reusable in FSM; does NOT shrink file | Rewrites entire table to new file, returns space to OS |
| Index | Does not rebuild indexes | Rebuilds all indexes |
| Duration | Fast, incremental | Slow, O(table size) |
| Use case | Routine maintenance | Emergency bloat removal |

`VACUUM ANALYZE` — runs VACUUM + updates planner statistics in one pass.

### 2.5 Autovacuum Internals

`autovacuum launcher` spawns `autovacuum worker` processes. Trigger conditions per table:

```
dead_tuples_threshold = autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * n_live_tuples
# default: 50 + 0.2 * n_live_tuples

analyze_threshold = autovacuum_analyze_threshold + autovacuum_analyze_scale_factor * n_live_tuples
# default: 50 + 0.1 * n_live_tuples
```

Cost-based throttling: `autovacuum_vacuum_cost_delay` (default 2ms) introduces sleep between page reads to limit I/O impact.

**Key tuning knobs for high-write tables:**
```sql
ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor = 0.01,   -- trigger at 1% dead tuples instead of 20%
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.005
);
```

---

## 3. Index Types

### 3.1 B-Tree Internals

Default index type. Uses Lehman-Yao B-Link tree (adds right-sibling pointers for concurrent access without read locks during traversal).

**Page structure** (8 KB default):
```
+------------------+
|  PageHeader      |  24 bytes
+------------------+
|  Opaque area     |  B-tree metadata (level, next/prev sibling LSNs)
+------------------+
|  Item pointers   |  Array of (offset, length) pairs
+------------------+
|   (free space)   |
+------------------+
|  Index entries   |  (key, heap TID) pairs, stored in reverse
+------------------+
```

Leaf pages contain `(key_value, heap_TID)` pairs. Internal pages contain `(key_value, child_page_no)`.

**Page splits**: when a leaf page fills up, it splits 50/50 by default. Fill factor (`fillfactor=90`) leaves 10% free on each page → reduces splits for write-heavy indexes. For mostly-read indexes use `fillfactor=100`.

**Index bloat**: dead index entries from UPDATEs/DELETEs are cleaned during VACUUM. Unlike heap, B-tree pages can never return space to OS without `REINDEX`.

### 3.2 Hash Indexes

- O(1) point lookups for equality only (`=`). Cannot support range queries.
- Since PostgreSQL 10: WAL-logged and crash-safe.
- Internally: two-level hash table. Top-level maps hash buckets → overflow pages.
- Useful when cardinality is very high and only equality needed (e.g., UUID primary keys for cache lookups).

### 3.3 GIN — Generalized Inverted Index

For multi-valued columns: arrays, JSONB, tsvector (full-text).

**Structure**: Two-level B-tree:
1. **Term dictionary tree**: sorted terms (array elements, JSON keys/values, lexemes)
2. **Posting list**: for each term, a sorted list of heap TIDs containing that term

```
GIN for JSONB column:
  Term "status"    → [TID(1,1), TID(3,2), TID(7,1)]
  Term "active"    → [TID(1,1), TID(7,1)]
  Term "inactive"  → [TID(3,2)]
```

**GIN on JSONB**: Can index all key-value pairs with `jsonb_ops` or only top-level keys with `jsonb_path_ops` (smaller, faster, but no key-only queries).

**fastupdate**: GIN has a "pending list" (unsorted buffer) for fast inserts. Flushed to main tree during VACUUM or when threshold (`gin_pending_list_limit`, default 4MB) reached. Trade-off: faster writes, slower reads until flush.

### 3.4 GiST — Generalized Search Tree

Framework for custom index types. Used for:
- Geometric types (PostGIS), full-text (`@@` operator with `tsvector`)
- Nearest-neighbor searches (`<->` operator)

Each internal node stores a "predicate" bounding the subtree. Allows lossy indexing (index may return false positives, rechecked against actual row).

### 3.5 BRIN — Block Range INdex

Stores `(min, max)` per range of heap pages (default 128 pages per range). Extremely small index (~a few KB for a billion-row table).

**Only useful when column is correlated with physical storage order** — e.g., an `inserted_at` timestamp where new rows are appended. Queries on unordered columns get no benefit.

```sql
CREATE INDEX ON events USING BRIN (event_time) WITH (pages_per_range = 64);
```

BRIN scan: check which block ranges overlap query range → load only those heap pages.

---

## 4. WAL — Write-Ahead Log

### 4.1 Why WAL

**Durability without fsync on every write**: write WAL record (sequential I/O) → acknowledge commit → later flush dirty heap/index pages (random I/O). On crash, replay WAL from last checkpoint.

### 4.2 WAL Record Format

Each WAL record has:
```
xl_tot_len  (4B) — total record length
xl_xid      (4B) — transaction ID
xl_prev     (8B) — LSN of previous record (for backward scan)
xl_info     (1B) — record type flags
xl_rmid     (1B) — resource manager ID (Heap, Btree, XLOG, etc.)
crc         (4B) — CRC32 of record
[data]      — resource-manager specific payload
```

WAL is segmented into 16-MB files in `pg_wal/`. Identified by LSN (Log Sequence Number): a 64-bit byte offset into the WAL stream.

### 4.3 Checkpoints

A checkpoint ensures all dirty buffers modified before the checkpoint LSN are flushed to disk. After a crash, recovery only needs to replay WAL from the checkpoint's `redo LSN`.

**Checkpoint process**:
1. Write a checkpoint WAL record (records current redo LSN)
2. Flush all dirty shared_buffers to disk (spread over `checkpoint_completion_target`, default 0.9 = 90% of `checkpoint_timeout`)
3. Write a "checkpoint complete" record to WAL
4. Update `pg_control` with new checkpoint LSN

```
checkpoint_timeout = 5min    # max time between checkpoints
max_wal_size = 1GB           # also triggers checkpoint when WAL grows beyond this
checkpoint_completion_target = 0.9
```

**Too-frequent checkpoints** → high I/O. **Too-infrequent** → long crash recovery time. `pg_stat_bgwriter` shows checkpoint stats.

### 4.4 Crash Recovery

On restart after crash:
1. Read `pg_control` → find latest valid checkpoint LSN
2. Read WAL from that LSN forward
3. For each WAL record: re-apply the operation (`REDO`)
4. Database reaches consistent state when WAL is fully replayed
5. Roll back any in-progress transactions (using abort records or lack of commit)

**REDO only** — PostgreSQL WAL is redo-only (no undo in WAL). Rollback is done by writing compensating WAL records or using pg_xact to mark aborted.

### 4.5 WAL for Replication

Same WAL stream used for crash recovery is shipped to standbys. Physical replication sends raw WAL bytes — standby has exact byte-for-byte copy of primary.

---

## 5. Streaming Replication

### 5.1 Architecture

```
Primary                          Standby
  |                                 |
  |--- WAL writer ---> pg_wal/      |
  |                                 |
  |<-- WAL receiver (connects) ---->|
  |                                 |
  |--- WAL sender (reads pg_wal) -->|
  |                                 |
  |          WAL stream (TCP)       |
  |================================>|
                                    |
                            WAL receiver writes
                            to standby pg_wal/
                                    |
                            startup process
                            replays WAL continuously
```

### 5.2 Synchronous vs Asynchronous

| | Async | Sync |
|--|-------|------|
| Commit returns | After WAL written locally | After at least one sync standby confirms WAL received |
| RPO | Potential data loss (lag) | Zero data loss |
| Latency | Low | Higher (RTT to standby) |
| Config | `synchronous_standby_names = ''` | `synchronous_standby_names = 'standby1'` |

`synchronous_commit = remote_write` → ack when standby wrote to OS buffer (not fsync'd)
`synchronous_commit = remote_apply` → ack when standby has applied (replayed) the WAL

### 5.3 Replication Slots

**Problem without slots**: if a standby lags behind, the primary may recycle WAL files the standby still needs → standby must be rebuilt from scratch.

**Replication slot** tracks the lowest LSN any consumer has confirmed receiving. Primary retains WAL until all slots have consumed it.

```sql
SELECT * FROM pg_replication_slots;
-- slot_name, active, restart_lsn, confirmed_flush_lsn
```

**Danger**: an unused (inactive) slot causes unbounded WAL accumulation → disk full. Monitor `pg_replication_slots` for `active = false` slots.

### 5.4 Physical vs Logical Replication

| | Physical | Logical |
|--|----------|---------|
| Granularity | Entire cluster byte-for-byte | Selected tables/operations |
| Schema | Must be identical | Can differ (different PG version, schema evolution) |
| Filtering | None | Can replicate subset of tables |
| Use case | HA standby | CDC, cross-version migration, partial replication |
| Protocol | WAL bytes | Decoded row changes (INSERT/UPDATE/DELETE) |

Logical replication uses `wal_level = logical` (vs `replica` for physical). The logical decoding API converts WAL to row-change events.

---

## 6. Query Execution

### 6.1 EXPLAIN ANALYZE — Reading the Output

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT ...;
```

```
Seq Scan on orders  (cost=0.00..18340.00 rows=1000000 width=64)
                      (actual time=0.012..203.445 rows=999871 loops=1)
  Buffers: shared hit=8340 read=0
```

Key metrics:
- `cost=startup..total` — planner estimate in arbitrary units
- `rows=N` — planner estimate
- `actual time=start..end ms` — measured time for first/last row
- `loops=N` — node executed N times (nested loops multiply)
- `Buffers: shared hit=X read=Y` — X from buffer cache, Y from disk
- `rows=actual` vs `rows=estimated` — large divergence = stale stats, run ANALYZE

### 6.2 Scan Types

| Scan | When chosen | Notes |
|------|------------|-------|
| Sequential Scan | Low selectivity (>5-10% of table), small table, no index | Reads every page; can use parallel workers |
| Index Scan | High selectivity, small result set | Alternates between index and heap; random I/O |
| Index-Only Scan | All needed columns in index, page is all-visible | No heap access; fastest for covered queries |
| Bitmap Index Scan | Medium selectivity (between the above two) | Phase 1: build bitmap of matching TIDs; Phase 2: sort TIDs, fetch heap pages in order |

**Bitmap Heap Scan** is critical to understand: it batches random heap accesses into sequential-ish I/O by sorting TIDs before heap access. Much better than Index Scan when selectivity is ~1-5%.

### 6.3 Join Algorithms

| Join | Algorithm | When chosen |
|------|-----------|-------------|
| Nested Loop | For each outer row, probe inner | Small inner, indexed inner |
| Hash Join | Hash smaller relation, probe with larger | Unsorted relations, no index on join column, work_mem sufficient |
| Merge Join | Sort both sides, merge | Pre-sorted inputs or sorted indexes; large sorted data sets |

**Hash Join cost**: O(N + M) with O(M) memory (M = smaller side). If work_mem too small → batched multi-pass hash join (spills to disk).

**Merge Join**: requires both inputs sorted on join key. With suitable indexes, PostgreSQL may choose merge join even for large tables.

---

## 7. Connection Pooling

### 7.1 Why PostgreSQL Connections Are Expensive

PostgreSQL uses **process-per-connection** model (not threads). Each new connection:
- `fork()` a new backend process (~5-10 MB RSS)
- Allocates per-backend memory (work_mem, etc.)
- Establishes SSL handshake, authentication

At 1000 connections: 5-10 GB RAM just for backend processes. Context switching between 1000 processes degrades performance significantly. **PostgreSQL performs best with 100-300 connections** (tune with `max_connections`).

### 7.2 PgBouncer

Connection multiplexer between application and PostgreSQL.

**Pooling modes**:
| Mode | How it works | Connection released |
|------|-------------|-------------------|
| Session pooling | 1 server connection per client session | When client disconnects |
| Transaction pooling | Server connection held only during transaction | After COMMIT/ROLLBACK |
| Statement pooling | Server connection released after each statement | After each SQL statement (breaks multi-statement txns) |

**Transaction pooling** is the sweet spot for most apps: 1000 app connections → 50-100 PostgreSQL backend connections.

**Limitations of transaction pooling**:
- Cannot use `SET` (session-level config)
- Cannot use advisory locks
- Cannot use `LISTEN/NOTIFY`
- Prepared statements: must use protocol-level prepared statements or disable (`server_reset_query`)

```ini
# pgbouncer.ini
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 50
reserve_pool_size = 10
```

---

## 8. Partitioning

### 8.1 Declarative Partitioning (PostgreSQL 10+)

```sql
CREATE TABLE orders (
    order_id BIGINT,
    created_at TIMESTAMP,
    status TEXT
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2024 PARTITION OF orders
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
```

Types: `RANGE`, `LIST`, `HASH`.

### 8.2 Partition Pruning

The planner eliminates partitions that cannot satisfy the WHERE clause. **Static pruning**: at plan time. **Dynamic pruning**: at execution time (when partition key is a parameter).

```sql
EXPLAIN SELECT * FROM orders WHERE created_at >= '2024-06-01';
-- Only orders_2024 partition is scanned
```

`enable_partition_pruning = on` (default).

### 8.3 Indexes on Partitioned Tables

Creating an index on the parent table creates matching indexes on all child partitions. Each partition has its own independent index B-tree. There is **no global index** spanning all partitions (unlike Oracle).

**Consequence**: queries filtering on non-partition-key columns must scan all partitions' indexes → can be slow if many partitions exist. Workaround: always include partition key in queries that need efficient access.

---

## 9. JSONB Internals

### 9.1 Storage Format

`JSONB` is binary decomposed JSON:
- Keys are sorted lexicographically
- Deduplication of object keys
- Type tagging for each value (null, bool, number, string, array, object)
- Stored in a contiguous varlena (variable-length) blob

`JSON` type stores raw text (faster write, slower read). `JSONB` parses on write, faster on read and supports GIN indexing.

### 9.2 GIN Index on JSONB

```sql
-- Default operator class: indexes all key-value pairs
CREATE INDEX ON docs USING GIN (data);

-- jsonb_path_ops: only indexes values (not keys), smaller index, faster for containment
CREATE INDEX ON docs USING GIN (data jsonb_path_ops);
```

GIN inverted index maps each JSON path element (key or `key=value` pair) to a posting list of document TIDs.

Query `data @> '{"status": "active"}'` → GIN lookup for term `status=active` → fetch TIDs → heap fetch.

---

## 10. Lock Types

### 10.1 Lock Hierarchy

Weakest to strongest (higher lock blocks lower conflicting modes):

| Lock Mode | Who acquires it | Blocks |
|-----------|----------------|--------|
| AccessShareLock | SELECT | AccessExclusiveLock only |
| RowShareLock | SELECT FOR UPDATE/SHARE | ExclusiveLock, AccessExclusiveLock |
| RowExclusiveLock | INSERT, UPDATE, DELETE | ShareLock, ShareRowExclusiveLock, ExclusiveLock, AELock |
| ShareUpdateExclusiveLock | VACUUM, CREATE INDEX CONCURRENTLY, ANALYZE | Itself + stronger |
| ShareLock | CREATE INDEX (non-concurrent) | RowExclusiveLock and stronger |
| ShareRowExclusiveLock | Trigger creation | ShareLock and stronger |
| ExclusiveLock | Rare (some built-in functions) | All except AccessShareLock |
| AccessExclusiveLock | ALTER TABLE, DROP TABLE, VACUUM FULL, REINDEX | Everything |

**DDL operations** (ALTER TABLE, DROP TABLE, REINDEX, VACUUM FULL, TRUNCATE) all take `AccessExclusiveLock` — they block all reads and writes.

**`CREATE INDEX CONCURRENTLY`** uses `ShareUpdateExclusiveLock` — allows concurrent reads/writes during index build.

### 10.2 Row-Level Locks

`SELECT FOR UPDATE` → `RowShareLock` on table, `ExclusiveLock` on specific rows (stored in `pg_locks` for unresolved lock waits; "fast path" for uncontested locks).

### 10.3 Diagnosing Lock Waits

```sql
-- Find blocking queries
SELECT
    pid, wait_event_type, wait_event, state, query,
    pg_blocking_pids(pid) AS blocked_by
FROM pg_stat_activity
WHERE wait_event_type = 'Lock';
```

---

## 11. Transaction Isolation Levels

### 11.1 Read Committed (default)

- New snapshot taken at the **start of each statement** (not transaction)
- Non-repeatable reads possible: same row can return different values across statements in one transaction
- Phantom reads possible

### 11.2 Repeatable Read

- Snapshot taken at **start of transaction**, held for entire duration
- Non-repeatable reads prevented
- Phantoms prevented (PostgreSQL's RR is stronger than SQL standard)
- **Serialization anomaly possible**: write skew (two transactions read the same data, each writes based on what it read, producing a globally inconsistent result)

### 11.3 Serializable (SSI)

**Serializable Snapshot Isolation** — PostgreSQL's implementation since 9.1.

Uses **predicate locks** (not regular locks) to track read-write dependencies between transactions. Detects serialization anomalies (dangerous read-write-read cycles) and aborts one of the conflicting transactions with:

```
ERROR: could not serialize access due to read/write dependencies among transactions
```

**No performance cliff**: SSI in PostgreSQL does not use lock-based range locking. Overhead is tracking `SIReadLock` entries. Retry logic required in application.

```java
// Application must handle serialization failures
@Retryable(value = SerializationFailureException.class, maxAttempts = 3)
@Transactional(isolation = Isolation.SERIALIZABLE)
public void transferFunds(...) { ... }
```

---

## 12. Production Diagnostics

### 12.1 pg_stat_statements

```sql
-- Must be loaded: shared_preload_libraries = 'pg_stat_statements'
SELECT
    query,
    calls,
    total_exec_time / calls AS avg_ms,
    rows / calls AS avg_rows,
    shared_blks_hit / calls AS cache_hits_per_call,
    shared_blks_read / calls AS disk_reads_per_call
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

**Key signals**:
- High `disk_reads_per_call` → missing index or buffer cache too small
- High `avg_ms` with low `disk_reads` → CPU-bound (complex query, sort/hash with insufficient work_mem)
- Very high `calls` + low `avg_ms` → potential N+1 query from ORM

### 12.2 pg_locks + pg_stat_activity (Lock Diagnosis)

```sql
SELECT
    blocked.pid AS blocked_pid,
    blocked.query AS blocked_query,
    blocking.pid AS blocking_pid,
    blocking.query AS blocking_query,
    locks.mode AS lock_mode,
    locks.relation::regclass AS locked_table
FROM pg_stat_activity blocked
JOIN pg_locks ON pg_locks.pid = blocked.pid AND NOT pg_locks.granted
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
JOIN pg_locks locks ON locks.pid = blocking.pid AND locks.granted;
```

### 12.3 pg_stat_activity

```sql
SELECT pid, usename, application_name, state, wait_event_type, wait_event,
       now() - query_start AS duration, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;
```

States:
- `active` — executing query
- `idle in transaction` — inside BEGIN but idle: **holds locks, blocks VACUUM**
- `idle in transaction (aborted)` — previous statement errored, transaction open
- `idle` — waiting for next command

**`idle in transaction` is a major operational hazard** — can block DDL and autovacuum indefinitely.

```sql
-- Kill long-idle-in-transaction sessions
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND now() - state_change > interval '5 minutes';
```

### 12.4 Index Usage Stats

```sql
-- Unused indexes (waste write overhead)
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY schemaname, tablename;

-- Table sequential scan ratio
SELECT relname, seq_scan, idx_scan,
       seq_scan::float / NULLIF(seq_scan + idx_scan, 0) AS seq_ratio
FROM pg_stat_user_tables
WHERE seq_scan > 0
ORDER BY seq_scan DESC;
```

---

## Interview Quick-Fire Reference

| Question | Key Answer |
|----------|-----------|
| How does PostgreSQL implement MVCC? | Multiple physical tuple versions in heap; xmin/xmax + snapshot-based visibility |
| What does VACUUM do at the storage level? | Marks dead tuple space as reusable in FSM; updates visibility map; does NOT shrink file |
| When does a bitmap heap scan beat an index scan? | Medium selectivity (~1-5%); batches TID list for sequential-ish heap access |
| Why are PostgreSQL connections expensive? | fork() per connection; each ~5-10 MB; no thread model |
| What does AccessExclusiveLock block? | Everything — all SELECTs, all DML. DDL takes this lock |
| What is SSI? | Serializable via predicate locks tracking read-write dependency cycles; no blocking |
| What is a replication slot danger? | Inactive slot causes unbounded WAL retention → disk full |
| VACUUM FULL vs VACUUM | VACUUM FULL rewrites table (AELock, shrinks file); VACUUM marks space reusable (no shrink, no blocking) |
