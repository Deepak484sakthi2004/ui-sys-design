# Chapter 18: Monitoring, Tuning, and Production Operations

## What to Watch, What to Change, and What to Do When It Breaks

---

MySQL does not tell you it is sick until it is dying. Buffer pool evictions accelerate
silently. History list length creeps upward. Lock waits pile up behind a forgotten
`SELECT ... FOR UPDATE` in an uncommitted transaction. By the time the application
starts throwing connection timeouts, the root cause happened minutes or hours ago.

This chapter is the operator's instrumentation manual. We start with Performance Schema,
decode `SHOW ENGINE INNODB STATUS`, build a dashboard, tune the critical variables at
both the InnoDB and OS level, and end with a production runbook for 3 AM emergencies.

---

## 1. Performance Schema — MySQL's Instrumentation Engine

### 1.1 Architecture — An In-Memory Database of Runtime Metrics

Performance Schema is a storage engine — a separate in-memory database inside mysqld,
storing instrumentation data in hash tables and ring buffers. It intercepts internal
function calls through **instruments** and routes collected events to **consumers**.

```
  MySQL Server Process
  ┌────────────────────────────────────────────────────────────┐
  │  SQL Layer       InnoDB          Thread Manager            │
  │  ┌──────┐       ┌──────┐       ┌──────────┐               │
  │  │parse │       │buf   │       │thread    │               │
  │  │opt   │       │pool  │       │create    │               │
  │  │exec  │       │lock  │       │schedule  │               │
  │  └──┬───┘       └──┬───┘       └────┬─────┘               │
  │     │              │               │                       │
  │     ▼              ▼               ▼                       │
  │  ┌─────────────────────────────────────────┐               │
  │  │       INSTRUMENTATION POINTS            │               │
  │  └──────────────────┬──────────────────────┘               │
  │                     ▼                                      │
  │  ┌─────────────────────────────────────────┐               │
  │  │    PERFORMANCE SCHEMA ENGINE            │               │
  │  │  Instruments → Consumers → Tables       │               │
  │  │  Pre-allocated in-memory buffers.       │               │
  │  │  No disk I/O. Data lost on restart.     │               │
  │  └─────────────────────────────────────────┘               │
  └────────────────────────────────────────────────────────────┘
```

>>> Performance Schema is a storage engine, not a log file. Its tables are backed by
in-memory ring buffers — data is lost on restart by design. In interviews, this
distinction signals you understand MySQL's internal architecture.

### 1.2 Instruments and Consumers

**Instruments** define *what* to measure (hierarchical names):
```
  wait/synch/mutex/innodb/buf_pool_mutex     ← mutex wait in buffer pool
  wait/io/file/innodb/innodb_data_file       ← data file I/O
  statement/sql/select                       ← SELECT statement
  memory/innodb/buf_buf_pool                 ← buffer pool memory allocation
```

**Consumers** define *where* events go (hierarchical — disabling a parent disables children):
```
  global_instrumentation                     ← master switch
    └── thread_instrumentation
          ├── events_statements_current → history → history_long
          ├── events_waits_current     → history → history_long
          ├── events_stages_current    → history → history_long
          └── events_transactions_current → history → history_long
```

### 1.3 Enable/Disable Instruments

```sql
-- Enable all InnoDB mutex instruments
UPDATE performance_schema.setup_instruments
SET ENABLED = 'YES', TIMED = 'YES'
WHERE NAME LIKE 'wait/synch/mutex/innodb/%';

-- Enable memory instruments for InnoDB
UPDATE performance_schema.setup_instruments
SET ENABLED = 'YES' WHERE NAME LIKE 'memory/innodb/%';

-- At startup (my.cnf):
-- performance-schema-instrument='memory/%=ON'
-- performance-schema-consumer-events-statements-history-long=ON
```

### 1.4 Key Performance Schema Tables

```sql
-- TOP QUERIES BY TOTAL TIME (events_statements_summary_by_digest)
SELECT DIGEST_TEXT, COUNT_STAR AS exec_count,
    ROUND(SUM_TIMER_WAIT/1e12, 2) AS total_sec,
    ROUND(AVG_TIMER_WAIT/1e12, 4) AS avg_sec,
    SUM_ROWS_EXAMINED, SUM_ROWS_SENT,
    ROUND(SUM_ROWS_EXAMINED/NULLIF(SUM_ROWS_SENT,0), 1) AS exam_to_sent
FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;

-- TOP WAIT EVENTS (events_waits_summary_global_by_event_name)
SELECT EVENT_NAME, COUNT_STAR,
    ROUND(SUM_TIMER_WAIT/1e12, 2) AS total_wait_sec
FROM performance_schema.events_waits_summary_global_by_event_name
WHERE COUNT_STAR > 0 ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;

-- FILE I/O HOTSPOTS (file_summary_by_instance)
SELECT FILE_NAME, COUNT_READ, COUNT_WRITE,
    ROUND(SUM_TIMER_READ/1e12, 2) AS read_sec,
    ROUND(SUM_TIMER_WRITE/1e12, 2) AS write_sec
FROM performance_schema.file_summary_by_instance
ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;

-- TABLE I/O WAITS (table_io_waits_summary_by_table)
SELECT OBJECT_SCHEMA, OBJECT_NAME, COUNT_FETCH, COUNT_INSERT,
    COUNT_UPDATE, COUNT_DELETE
FROM performance_schema.table_io_waits_summary_by_table
WHERE OBJECT_SCHEMA NOT IN ('performance_schema','mysql','sys')
ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;

-- LOCK ANALYSIS (data_locks + data_lock_waits)
SELECT r.ENGINE_TRANSACTION_ID AS waiting_trx, r.LOCK_MODE AS waiting_for,
    b.ENGINE_TRANSACTION_ID AS blocking_trx, b.LOCK_MODE AS blocking_mode
FROM performance_schema.data_lock_waits w
JOIN performance_schema.data_locks r ON w.REQUESTING_ENGINE_LOCK_ID = r.ENGINE_LOCK_ID
JOIN performance_schema.data_locks b ON w.BLOCKING_ENGINE_LOCK_ID = b.ENGINE_LOCK_ID;

-- ACTIVE THREADS (threads)
SELECT THREAD_ID, PROCESSLIST_USER, PROCESSLIST_COMMAND,
    PROCESSLIST_TIME, LEFT(PROCESSLIST_INFO, 100) AS query
FROM performance_schema.threads
WHERE TYPE='FOREGROUND' AND PROCESSLIST_COMMAND != 'Sleep'
ORDER BY PROCESSLIST_TIME DESC;

-- MEMORY BY CATEGORY (memory_summary_global_by_event_name)
SELECT EVENT_NAME,
    ROUND(CURRENT_NUMBER_OF_BYTES_USED/1024/1024, 2) AS current_mb,
    ROUND(HIGH_NUMBER_OF_BYTES_USED/1024/1024, 2) AS high_water_mb
FROM performance_schema.memory_summary_global_by_event_name
WHERE CURRENT_NUMBER_OF_BYTES_USED > 0
ORDER BY CURRENT_NUMBER_OF_BYTES_USED DESC LIMIT 15;
```

**Performance overhead**: Default instruments (statements, stages) add ~5-10%. With all
mutex/rwlock instruments enabled, overhead can reach 15-20%. Leave statement instruments
on always; enable wait/synch instruments only when actively debugging contention.

---

## 2. sys Schema — Human-Readable Views

The sys schema wraps Performance Schema in views that format bytes and durations into
human-readable output. Installed by default since MySQL 5.7.

```sql
-- QUERIES IN 95th PERCENTILE OF RUNTIME
SELECT * FROM sys.statements_with_runtimes_in_95th_percentile LIMIT 10;

-- TABLE STATISTICS: rows, data size, I/O latency
SELECT * FROM sys.schema_table_statistics WHERE table_schema = 'mydb';

-- INDEX USAGE STATISTICS
SELECT * FROM sys.schema_index_statistics WHERE table_schema = 'mydb';

-- UNUSED INDEXES — candidates for removal
SELECT * FROM sys.schema_unused_indexes
WHERE object_schema NOT IN ('mysql', 'performance_schema', 'sys');

-- REDUNDANT INDEXES — one index is a prefix of another
SELECT * FROM sys.schema_redundant_indexes WHERE table_schema = 'mydb';

-- BUFFER POOL BY TABLE — which tables dominate the pool
SELECT * FROM sys.innodb_buffer_stats_by_table ORDER BY allocated DESC LIMIT 15;

-- TOTAL MEMORY
SELECT * FROM sys.memory_global_total;

-- MEMORY BY THREAD
SELECT * FROM sys.memory_by_thread_by_current_bytes ORDER BY current_allocated DESC LIMIT 10;

-- HOST AND USER SUMMARIES
SELECT * FROM sys.host_summary;
SELECT * FROM sys.user_summary;

-- I/O BY FILE
SELECT * FROM sys.io_global_by_file_by_bytes ORDER BY total DESC LIMIT 15;
```

>>> `schema_unused_indexes` and `schema_redundant_indexes` are interview gold. Unused
indexes waste disk, slow writes (every INSERT maintains the B+Tree), and consume buffer
pool pages. Caveat: Performance Schema resets on restart, so an index appears "unused"
if the server recently restarted and the relevant query has not yet run.

### 2.2 Essential Procedures

```sql
-- Full diagnostic dump (WARNING: massive output)
CALL sys.diagnostics(60, 30, 'current');

-- Show enabled instruments and consumers
CALL sys.ps_setup_show_enabled(TRUE, TRUE);

-- Statement performance diff between two snapshots
CALL sys.statement_performance_analyzer('create_tmp', 'baseline', NULL);
CALL sys.statement_performance_analyzer('snapshot', NULL, NULL);
CALL sys.statement_performance_analyzer('save', 'baseline', NULL);
-- ... run workload for 60 seconds ...
CALL sys.statement_performance_analyzer('snapshot', NULL, NULL);
CALL sys.statement_performance_analyzer('delta', 'baseline',
    'with_runtimes_in_95th_percentile');
```

---

## 3. SHOW ENGINE INNODB STATUS — The Dashboard

Every experienced DBA reads this output like a pilot reads a cockpit panel. Key sections:

```
  ┌─────────────────────────────────────────────────────────────┐
  │  BACKGROUND THREAD         ← page cleaner, purge activity  │
  │  SEMAPHORES                ← mutex/rw-lock contention       │
  │  LATEST DETECTED DEADLOCK  ← most recent deadlock info      │
  │  TRANSACTIONS              ← active transactions, purge     │
  │  FILE I/O                  ← I/O thread status, pending ops │
  │  INSERT BUFFER AND AHI     ← change buffer + adaptive hash  │
  │  LOG                       ← redo log LSN, checkpoint age   │
  │  BUFFER POOL AND MEMORY    ← hit rate, dirty pages, free    │
  │  ROW OPERATIONS            ← rows read/ins/upd/del per sec  │
  └─────────────────────────────────────────────────────────────┘
```

### 3.1 Section-by-Section Decode

**SEMAPHORES:**
```
OS WAIT ARRAY INFO: reservation count 184032
OS WAIT ARRAY INFO: signal count 178456
RW-shared spins 0, rounds 523471, OS waits 162390
RW-excl spins 0, rounds 184290, OS waits 5765
```
- High OS waits relative to spin rounds = threads sleeping on mutexes instead of spinning
  = contention that spinning cannot resolve.
- **Critical**: Lines like `--Thread 140234567 has waited at btr0sea.cc line 123 for
  600 seconds the semaphore` indicate a latch deadlock. InnoDB will crash itself after
  `innodb_fatal_semaphore_timeout` (default 600s).

**TRANSACTIONS:**
```
Trx id counter 12348
Purge done for trx's n:o < 12340 undo n:o < 0 state: running
History list length 1523
```
- **History list length** = unpurged undo records. Must stay low (< 1000). If growing
  continuously, purge cannot keep up — likely a long-running transaction holding an old
  read view. History list > 100,000 = undo tablespace bloat, buffer pool degradation,
  and slower secondary index lookups via undo traversal.

**LATEST DETECTED DEADLOCK:**
```
*** (1) TRANSACTION:
TRANSACTION 12345, ACTIVE 3 sec starting index read
UPDATE orders SET status = 'shipped' WHERE order_id = 1001

*** (2) TRANSACTION:
TRANSACTION 12346, ACTIVE 2 sec starting index read
UPDATE orders SET status = 'cancelled' WHERE order_id = 1002

*** WE ROLL BACK TRANSACTION (1)
```
- InnoDB rolls back the transaction with fewest row modifications (least "weight").
- Enable `innodb_print_all_deadlocks = ON` to capture ALL deadlocks in the error log.

**LOG:**
```
Log sequence number          82734523456
Log buffer assigned up to    82734523456
Current LSN                  82734523456
LSN at last checkpoint       82734400000
456 log i/o's done, 2.34 log i/o's/second
```
- **Checkpoint age** = Current LSN - LSN at last checkpoint. Must stay below redo log
  capacity. If it approaches the limit, InnoDB performs synchronous sharp checkpoints
  and writes stall.

**BUFFER POOL AND MEMORY:**
```
Buffer pool size   131072        ← total pages (131072 * 16KB = 2GB)
Free buffers       1024          ← unused pages
Database pages     128000        ← pages with data
Modified db pages  3456          ← dirty pages awaiting flush
Buffer pool hit rate 999 / 1000  ← THIS IS THE CRITICAL NUMBER
```
- **Hit rate 999/1000 (99.9%)** is the target. Below 990/1000 = buffer pool too small.
- **Dirty ratio** = Modified/Database pages. Should stay below 75%.
- **Free buffers = 0** sustained = every read requires an eviction first.

**ROW OPERATIONS:**
```
12 read views open inside InnoDB
Number of rows inserted 456789, updated 123456, deleted 78901, read 9876543
```
- Many open read views prevent purge from cleaning undo records older than the oldest
  view. This directly drives history list growth.

**Critical metrics summary by section:**

| Section | Key Metric | Healthy | Alarm |
|---------|-----------|---------|-------|
| SEMAPHORES | Lines with "has waited ... N seconds" | None | Any wait > 30s |
| TRANSACTIONS | History list length | < 1,000 | > 10,000 |
| FILE I/O | Pending reads/writes/fsyncs | 0 sustained | Non-zero sustained |
| INSERT BUFFER/AHI | `hash searches / (hash + non-hash)` | > 50% | < 50% |
| LOG | Checkpoint age vs redo capacity | < 80% | > 90% |
| BUFFER POOL | Hit rate | 999/1000 | < 990/1000 |
| BUFFER POOL | Modified/Database pages | < 50% | > 75% |
| ROW OPERATIONS | Read views open | Low | Many open |

>>> In interviews, if asked "how do you diagnose deadlocks": enable
`innodb_print_all_deadlocks`, read SHOW ENGINE INNODB STATUS for the latest one,
and use `data_locks` + `data_lock_waits` for real-time visibility. InnoDB resolves
deadlocks via a wait-for graph with O(V+E) cycle detection, not timeouts.

---

## 4. Key InnoDB Metrics for Dashboards

```
  ┌──────────────────────┬──────────────────────┬─────────────┬──────────────────┐
  │  Metric              │  Source              │  Good Value │  Alert Threshold │
  ├──────────────────────┼──────────────────────┼─────────────┼──────────────────┤
  │  Buffer pool hit rate│  INNODB STATUS       │  >= 99.9%   │  < 99.0%        │
  │  Dirty page ratio    │  _pages_dirty/_data  │  < 50%      │  > 75%          │
  │  History list length │  INNODB STATUS       │  < 1,000    │  > 10,000       │
  │  Checkpoint age      │  LSN - checkpoint    │  < 80% redo │  > 90% redo     │
  │  Row lock waits/s    │  Innodb_row_lock_waits│ < 10/s     │  > 100/s        │
  │  Row lock time avg   │  _row_lock_time_avg  │  < 10 ms    │  > 100 ms       │
  │  Threads running     │  Threads_running     │  < 2x cores │  > 4x cores     │
  │  Threads connected   │  Threads_connected   │  < 80% max  │  > 90% max      │
  │  Slow queries/s      │  Slow_queries delta  │  < 1/s      │  > 10/s         │
  │  Aborted connects    │  Aborted_connects    │  < 1/min    │  > 10/min       │
  │  Replication lag     │  Seconds_Behind_Src  │  < 1s       │  > 30s          │
  │  Temp tables on disk │  disk_tables/total   │  < 5%       │  > 25%          │
  └──────────────────────┴──────────────────────┴─────────────┴──────────────────┘
```

>>> For system design interviews, name three metrics with thresholds: buffer pool hit
rate > 99.9%, history list length < 1000, threads running < 2x CPU cores. This shows
you know which needles to watch in the haystack.

---

## 5. InnoDB Tuning — The Critical Variables

### 5.1 innodb_buffer_pool_size

The single most important MySQL variable. This is the LRU cache for data and index pages.

```
  Memory Layout on a 128 GB Dedicated MySQL Server:

  ┌──────────────────────────────────────────────────────┐
  │                  128 GB Total RAM                    │
  ├──────────────────────────────────────────────────────┤
  │  innodb_buffer_pool_size = 96 GB (75%)               │
  │  ┌──────────────────────────────────────────────────┐│
  │  │  Data pages, index pages, change buffer,         ││
  │  │  adaptive hash index, lock info, dict cache      ││
  │  └──────────────────────────────────────────────────┘│
  ├──────────────────────────────────────────────────────┤
  │  Per-connection buffers: ~10 MB * 500 conns = 5 GB   │
  ├──────────────────────────────────────────────────────┤
  │  InnoDB internal: redo log buffer, purge, AHI = 4 GB │
  ├──────────────────────────────────────────────────────┤
  │  OS + filesystem cache + monitoring agents = 23 GB   │
  └──────────────────────────────────────────────────────┘
```

| Property | Detail |
|----------|--------|
| **Default** | 128 MB (absurdly small for production) |
| **Recommended** | 70-80% of total RAM on a dedicated server |
| **Why** | Every page miss = 16KB disk read. 99% hit rate = 1 in 100 goes to disk. 99.9% = 1 in 1000. 10x I/O reduction. |
| **Monitor** | `SHOW ENGINE INNODB STATUS` hit rate; `Innodb_buffer_pool_reads` |
| **Resize online** | `SET GLOBAL innodb_buffer_pool_size = 96*1024*1024*1024;` Resizes in chunks of `innodb_buffer_pool_chunk_size` (default 128 MB). |

```sql
-- Check current buffer pool hit rate
SELECT ROUND(@@innodb_buffer_pool_size/1024/1024/1024, 1) AS pool_gb,
    ROUND((1 - (
        (SELECT VARIABLE_VALUE FROM performance_schema.global_status
         WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') /
        NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status
         WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'), 0)
    )) * 100, 2) AS hit_rate_pct;
```

### 5.2 innodb_redo_log_capacity (innodb_log_file_size pre-8.0.30)

| Property | Detail |
|----------|--------|
| **Default** | 100 MB (8.0.30+) or 2x48 MB = 96 MB |
| **Recommended** | 1-2 GB OLTP. 4-8 GB write-heavy. |
| **Why** | Small redo log forces frequent sharp checkpoints — writes stall until dirty pages flush. Manifests as periodic latency spikes. |
| **Sizing** | Capture redo bytes/hour at peak. Set capacity to 1-2x that value. |

```sql
-- MySQL 8.0.30+: dynamic redo log capacity
SET GLOBAL innodb_redo_log_capacity = 2 * 1024 * 1024 * 1024;  -- 2 GB

-- Measure redo generation rate (run twice with 60s interval)
SELECT VARIABLE_VALUE FROM performance_schema.global_status
WHERE VARIABLE_NAME = 'Innodb_os_log_written';
-- Compare values: delta / 60 = bytes/second of redo generation
-- Multiply by 3600 for hourly rate. Set capacity to 1-2x hourly rate.
```

### 5.3 innodb_flush_log_at_trx_commit

```
  Value 1 (default): COMMIT → write → fsync → return OK     (full durability)
  Value 2:           COMMIT → write to OS → return OK        (fsync every 1s)
  Value 0:           COMMIT → write to buffer → return OK    (flush every 1s)
```

| Value | Risk | Use Case |
|-------|------|----------|
| **1** | Zero data loss | Default, OLTP, financial |
| **2** | Lose ~1s on OS crash/power loss | Good tradeoff for most apps |
| **0** | Lose ~1s on mysqld crash | Test environments, batch loads |

>>> This is one of the most commonly asked MySQL tuning questions. Know all three values
and the performance difference: value=2 can be 2-3x faster for writes due to reduced
fsync calls. Relate it back to redo log mechanics from Chapter 8.

### 5.4 innodb_flush_method

**O_DIRECT** (default on Linux since 8.0.26): Bypass OS filesystem cache for data files.
Prevents double buffering (data in both buffer pool and OS page cache). Always use on Linux.

### 5.5 innodb_io_capacity / innodb_io_capacity_max

Tells InnoDB how fast the storage is for background I/O calibration.

| Storage | io_capacity | io_capacity_max |
|---------|-------------|-----------------|
| HDD | 200-400 | 400-800 |
| SSD | 2000-5000 | 4000-10000 |
| NVMe | 10000-20000 | 20000-40000 |

Too low on fast storage = dirty page buildup. Too high = background I/O starves foreground.

### 5.6 Thread and Cleaner Configuration

```ini
innodb_read_io_threads  = 8    # Default 4. Set to core count (up to 64).
innodb_write_io_threads = 8    # Default 4. Match read threads.
innodb_page_cleaners    = 8    # Default 4. Set <= buffer_pool_instances.
innodb_purge_threads    = 4    # Default 4. Increase if history list grows.
```

### 5.7 innodb_adaptive_hash_index

ON by default. Builds in-memory hash over hot B+Tree pages. Accelerates point lookups
but consumes buffer pool memory and can cause AHI latch contention. If hash searches /
(hash + non-hash) < 50% in INNODB STATUS, disable it. Use `innodb_adaptive_hash_index_parts = 8`
to reduce contention.

### 5.8 innodb_change_buffer_max_size

Default 25% of buffer pool. Defers writes to non-unique secondary indexes. On SSDs, reduce
to 10-15% or disable (0) since random I/O is fast. On HDDs, keep at 25%.

### 5.9 Production my.cnf Template (128 GB RAM, NVMe, 32-core)

```ini
[mysqld]
innodb_buffer_pool_size        = 96G
innodb_buffer_pool_instances   = 16
innodb_redo_log_capacity       = 4G
innodb_flush_log_at_trx_commit = 1
innodb_flush_method            = O_DIRECT
innodb_io_capacity             = 10000
innodb_io_capacity_max         = 20000
innodb_read_io_threads         = 8
innodb_write_io_threads        = 8
innodb_page_cleaners           = 16
innodb_purge_threads           = 4
innodb_adaptive_hash_index     = ON
innodb_change_buffer_max_size  = 15
max_connections                = 500
thread_cache_size              = 64
tmp_table_size                 = 256M
max_heap_table_size            = 256M
internal_tmp_mem_storage_engine = TempTable
```

---

## 6. Query Performance Analysis

### 6.1 Slow Query Log

```ini
[mysqld]
slow_query_log         = ON
slow_query_log_file    = /var/log/mysql/slow.log
long_query_time        = 0.5              # 500ms (default 10s is too high)
log_queries_not_using_indexes = ON
log_throttle_queries_not_using_indexes = 60
min_examined_row_limit = 1000
log_slow_extra         = ON              # 8.0.14+
```

### 6.2 pt-query-digest

```bash
# Aggregate slow log by query fingerprint
pt-query-digest /var/log/mysql/slow.log > /tmp/digest.txt

# Filter by time range
pt-query-digest --since="2024-01-15 08:00:00" --until="2024-01-15 09:00:00" \
    /var/log/mysql/slow.log

# Track over time in a review table
pt-query-digest --review h=localhost,D=slow_query_review,t=queries \
    /var/log/mysql/slow.log
```

### 6.3 Performance Schema Digest Queries

```sql
-- Live equivalent of pt-query-digest (no slow log needed)
SELECT SCHEMA_NAME, DIGEST_TEXT, COUNT_STAR AS calls,
    ROUND(SUM_TIMER_WAIT/1e12, 2) AS total_sec,
    ROUND(AVG_TIMER_WAIT/1e12, 4) AS avg_sec,
    SUM_NO_INDEX_USED AS full_scans
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME NOT IN ('mysql','performance_schema','sys')
ORDER BY SUM_TIMER_WAIT DESC LIMIT 20;
```

### 6.4 EXPLAIN Workflow

```
  Identify slow query (slow log / P_S digest)
       │
       ▼
  EXPLAIN SELECT ...          ← check type, key, rows, Extra
       │
       ▼
  EXPLAIN ANALYZE SELECT ...  ← 8.0.18+: actual execution times
       │
       ▼
  Check indexes (SHOW INDEX)  ← covering index? composite index?
       │
       ▼
  Optimize: add index / rewrite query / denormalize
```

```sql
-- EXPLAIN ANALYZE — actually runs the query with real vs estimated costs
EXPLAIN ANALYZE
SELECT o.order_id, o.total, c.name
FROM orders o JOIN customers c ON o.customer_id = c.id
WHERE o.created_at > '2024-01-01' AND o.status = 'pending'
ORDER BY o.created_at DESC LIMIT 20\G
```

---

## 7. OS-Level Tuning for MySQL

### 7.1 Filesystem and I/O

```bash
# XFS recommended for MySQL — better large file and parallel I/O performance
mkfs.xfs -f /dev/nvme0n1p1
mount -o noatime,allocsize=16m /dev/nvme0n1p1 /var/lib/mysql

# I/O scheduler: none for SSD/NVMe, deadline for HDD
echo none > /sys/block/nvme0n1/queue/scheduler
```

### 7.2 Memory and Process Settings

```bash
# vm.swappiness = 1 (NOT 0)
# Why 1 not 0: swappiness=0 can trigger OOM killer immediately under pressure
# instead of gently swapping inactive pages first. 1 is a pressure relief valve.
echo 1 > /proc/sys/vm/swappiness

# Transparent Huge Pages: DISABLE
# THP causes latency spikes from khugepaged compaction and page allocation stalls
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# File descriptors: MySQL needs one per .ibd file, log, connection, temp file
# /etc/security/limits.conf
# mysql  soft  nofile  65535
# mysql  hard  nofile  65535
```

>>> In interviews, saying "set swappiness to 0" is a common mistake. Explain that
swappiness=0 can trigger OOM kills under sudden memory pressure, while swappiness=1
gives the kernel just enough flexibility to swap inactive memory before resorting
to killing mysqld.

### 7.3 NUMA and CPU

```
  NUMA Topology (2-socket server):

  ┌──────────────────────┐    ┌──────────────────────┐
  │   NUMA Node 0        │    │   NUMA Node 1        │
  │  ┌──────┐ ┌───────┐  │    │  ┌──────┐ ┌───────┐  │
  │  │ CPU  │ │ Local │  │    │  │ CPU  │ │ Local │  │
  │  │ 0-15 │ │ RAM   │  │◄──►│  │16-31 │ │ RAM   │  │
  │  │      │ │ 64 GB │  │QPI │  │      │ │ 64 GB │  │
  │  └──────┘ └───────┘  │    │  └──────┘ └───────┘  │
  └──────────────────────┘    └──────────────────────┘

  Problem: Buffer pool allocated on Node 0's RAM ⇒ threads on
  Node 1 access it via QPI interconnect — 50% higher latency.
  Solution: Interleave memory allocation across both nodes.
```

```bash
# NUMA: interleave memory across nodes
numactl --interleave=all mysqld_safe &
# Or in systemd: ExecStart=/usr/bin/numactl --interleave=all /usr/sbin/mysqld
# Or in my.cnf (8.0.14+): innodb_numa_interleave = ON

# CPU governor: performance mode (disable frequency scaling)
# Default 'powersave'/'ondemand' causes latency spikes during frequency transitions
cpupower frequency-set -g performance
# Or: tuned-adm profile throughput-performance
```

### 7.4 OS Tuning Checklist

```
  ┌─────────────────────────┬─────────────────────────────────┐
  │  Setting                │  Value                          │
  ├─────────────────────────┼─────────────────────────────────┤
  │  Filesystem             │  XFS, noatime                   │
  │  I/O scheduler (SSD)    │  none                           │
  │  I/O scheduler (HDD)    │  deadline                       │
  │  vm.swappiness          │  1                              │
  │  Transparent Huge Pages │  never (disabled)               │
  │  File descriptors       │  65535+                         │
  │  NUMA policy            │  numactl --interleave=all       │
  │  CPU governor           │  performance                    │
  │  net.core.somaxconn     │  4096                           │
  └─────────────────────────┴─────────────────────────────────┘
```

---

## 8. Production Operations Runbook

### 8.1 Table Maintenance

```sql
-- ANALYZE TABLE: recalculate index statistics for optimizer
-- Does NOT lock the table in InnoDB (read-only sampling)
-- Run after bulk loads or deleting > 30% of rows
ANALYZE TABLE orders;

-- OPTIMIZE TABLE: rebuild clustered index, reclaim fragmented space
-- WARNING: requires free disk = table size; metadata lock blocks DDL during rename
-- For large tables use pt-online-schema-change or gh-ost instead
OPTIMIZE TABLE orders;

-- Check fragmentation
SELECT TABLE_NAME,
    ROUND(DATA_LENGTH/1024/1024, 2) AS data_mb,
    ROUND(DATA_FREE/1024/1024, 2) AS free_mb
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'mydb' ORDER BY DATA_FREE DESC;
```

### 8.2 Binary Log Management

```sql
-- Set automatic expiry (8.0+)
SET GLOBAL binlog_expire_logs_seconds = 604800;  -- 7 days

-- Manual purge (NEVER purge logs replicas have not consumed)
PURGE BINARY LOGS TO 'mysql-bin.000145';
PURGE BINARY LOGS BEFORE '2024-01-10 00:00:00';

-- Verify replica positions first
SHOW REPLICAS;
```

### 8.3 Long-Running Query Management

```sql
-- Find long-running queries
SELECT ID, USER, HOST, TIME AS seconds, LEFT(INFO, 200) AS query
FROM INFORMATION_SCHEMA.PROCESSLIST
WHERE COMMAND != 'Sleep' AND TIME > 10 ORDER BY TIME DESC;

-- Kill query (not connection)
KILL QUERY 12345;

-- Set max execution time for SELECTs (8.0+)
SET GLOBAL MAX_EXECUTION_TIME = 30000;  -- 30s in milliseconds

-- Per-query hint
SELECT /*+ MAX_EXECUTION_TIME(5000) */ * FROM orders WHERE created_at > '2024-01-01';
```

### 8.4 Connection Management

```sql
-- Check connection usage vs limit
SHOW GLOBAL STATUS LIKE 'Threads_connected';
SHOW GLOBAL STATUS LIKE 'Max_used_connections';
SHOW VARIABLES LIKE 'max_connections';

-- Kill stale sleeping connections (leak detection)
SELECT USER, HOST, COUNT(*) AS conn_count
FROM INFORMATION_SCHEMA.PROCESSLIST
WHERE COMMAND = 'Sleep' AND TIME > 300
GROUP BY USER, HOST ORDER BY conn_count DESC;

-- Set timeouts to auto-kill stale connections
SET GLOBAL wait_timeout = 600;
SET GLOBAL interactive_timeout = 600;
```

### 8.5 Emergency Procedures

**Disk Full:**
```bash
# Priority: restore write capability immediately
# Step 1: Identify space consumers
du -sh /var/lib/mysql/*/ | sort -rh | head -10
ls -lhS /var/lib/mysql/mysql-bin.*

# Step 2: Purge old binary logs (fastest space recovery)
mysql -e "PURGE BINARY LOGS BEFORE NOW() - INTERVAL 1 DAY;"

# Step 3: Disable verbose logging temporarily
mysql -e "SET GLOBAL general_log=OFF; SET GLOBAL slow_query_log=OFF;"

# Step 4: Check for unbounded temp tablespace (ibtmp1) — restart to reset
ls -lh /var/lib/mysql/ibtmp*

# Step 5: Long-term — alert at 80% and 90% disk utilization
# Set innodb_temp_data_file_path with max size to prevent recurrence
```

**Out of Memory:**
```bash
# Step 1: Confirm OOM was the cause
dmesg | grep -i "out of memory\|oom\|killed process"
journalctl -u mysqld --since "1 hour ago" | grep -i oom

# Step 2: Verify memory budget
# Total MySQL memory ≈ buffer_pool + (max_connections * per_conn_avg) + OS
# per_conn_avg ≈ sort_buffer + join_buffer + read_buffer + thread_stack
#              ≈ 2-10 MB in typical OLTP
# RULE: buffer_pool + (max_connections * 10 MB) + 4 GB < total RAM
```
```sql
-- Step 3: Check actual memory allocation
SELECT EVENT_NAME,
    ROUND(CURRENT_NUMBER_OF_BYTES_USED/1024/1024, 2) AS current_mb
FROM performance_schema.memory_summary_global_by_event_name
ORDER BY CURRENT_NUMBER_OF_BYTES_USED DESC LIMIT 20;

-- Step 4: Shrink buffer pool if overprovisioned (online in 8.0+)
SET GLOBAL innodb_buffer_pool_size = 64 * 1024 * 1024 * 1024;

-- Step 5: Reduce max_connections to limit per-connection memory
SET GLOBAL max_connections = 300;
```

**Replication Broken:**
```sql
-- Step 1: Diagnose
SHOW REPLICA STATUS\G
-- Key fields: Slave_IO_Running, Slave_SQL_Running, Last_Errno, Last_Error
-- Seconds_Behind_Master, Retrieved_Gtid_Set vs Executed_Gtid_Set

-- Error 1062 (duplicate entry) — data drift
-- Option A: Skip (dangerous — masks inconsistency)
SET GLOBAL SQL_SLAVE_SKIP_COUNTER = 1;
START REPLICA;

-- Option B (GTID): Skip specific transaction
SET GTID_NEXT = 'source-uuid:problematic-gtid-number';
BEGIN; COMMIT;  -- inject empty transaction
SET GTID_NEXT = 'AUTOMATIC';
START REPLICA;

-- Option C (correct): Rebuild replica from xtrabackup/mysqldump

-- IO thread stopped (cannot connect to source):
-- Check: source host, port, user, password, firewall, max_connections on source
CHANGE REPLICATION SOURCE TO
    SOURCE_HOST = 'primary.host', SOURCE_PORT = 3306,
    SOURCE_USER = 'repl_user', SOURCE_PASSWORD = '...',
    SOURCE_AUTO_POSITION = 1;
START REPLICA;
```

**Corrupted Table:**
```sql
-- Step 1: Verify corruption
CHECK TABLE orders;

-- Step 2: If corrupt, set force recovery in my.cnf and restart
-- [mysqld]
-- innodb_force_recovery = 1
-- Levels: 1=skip corrupt pages, 2=skip background threads, 3=skip undo
--         4=skip insert buffer, 5=skip undo log, 6=skip redo (last resort)

-- Step 3: Dump all data at minimum viable recovery level
-- mysqldump --all-databases --single-transaction > /backup/emergency.sql

-- Step 4: Restore to a fresh instance
```

---

## 9. Percona Monitoring and Management (PMM)

### 9.1 Architecture

```
  ┌────────────────────────────────────────────────────────────┐
  │                    PMM Server                              │
  │  ┌───────────┐  ┌────────────┐  ┌──────────────────┐      │
  │  │ Grafana   │  │ ClickHouse │  │ VictoriaMetrics  │      │
  │  │(dashboards│  │(QAN data   │  │(time-series      │      │
  │  │ & alerts) │  │ storage)   │  │ metric store)    │      │
  │  └───────────┘  └────────────┘  └──────────────────┘      │
  └─────────────────────────┬──────────────────────────────────┘
                            │ HTTPS
  ┌─────────────────────────┼──────────────────────────────────┐
  │  MySQL Host             │                                  │
  │  ┌──────────────────────┴─────────────────────────────┐    │
  │  │          PMM Client (pmm-agent)                    │    │
  │  │  mysqld_exporter (P_S, SHOW STATUS)                │    │
  │  │  node_exporter   (CPU, RAM, disk, network)         │    │
  │  └────────────────────────────────────────────────────┘    │
  └────────────────────────────────────────────────────────────┘
```

### 9.2 Key Dashboards

| Dashboard | Key Panels |
|-----------|------------|
| **MySQL Overview** | QPS, connections, threads running, buffer pool hit rate |
| **InnoDB Metrics** | Checkpoint age, history list, row lock waits, redo throughput |
| **Query Analytics (QAN)** | Top queries by load, per-query EXPLAIN, execution trends |
| **Node Summary** | CPU, RAM, disk I/O, network, load average |

### 9.3 QAN Workflow

QAN captures every query via Performance Schema or slow log, normalizes by digest, and
ranks by load (total time as percentage of wall clock). Click any query to see execution
time distribution (min/avg/95th/max), rows examined vs sent ratio, full table scan flag,
and EXPLAIN output directly from the PMM interface.

>>> When asked "how do you monitor MySQL in production," name PMM specifically. It is
free, open-source, and the de facto standard. Mention the three-layer stack:
VictoriaMetrics for time-series, ClickHouse for query analytics, Grafana for
visualization and alerting.

---

## 10. Capacity Planning

### 10.1 Disk Capacity Formula

```
  Required Disk = Data + Indexes + Binary Logs + Redo Logs
                + Undo + Temp + OS + Headroom

  ┌──────────────────────────┬──────────────────────────────────────┐
  │  Component               │  How to Calculate                    │
  ├──────────────────────────┼──────────────────────────────────────┤
  │  Data + Indexes          │  INFORMATION_SCHEMA.TABLES           │
  │                          │  + growth_rate * months_ahead        │
  │  Binary logs             │  daily_binlog_MB * retention_days    │
  │  Redo logs               │  innodb_redo_log_capacity (fixed)    │
  │  Undo tablespace         │  Monitor file size (grows with long  │
  │                          │  transactions)                       │
  │  Temp tablespace         │  Can grow unbounded — set max size   │
  │  Headroom for migrations │  Reserve = largest table size        │
  │  OS + monitoring         │  Reserve 20%                         │
  └──────────────────────────┴──────────────────────────────────────┘
  RULE: Provision 2x current usage. Alert at 70% utilization.
```

### 10.2 Memory Formula

```
  Total MySQL Memory ≈ Buffer Pool + Per-Connection + OS Reserve

  Buffer Pool:       70-80% of RAM (dedicated server)
  Per-Connection:    2-5 MB typical, 20+ MB worst case (large sorts/joins)
                     Total = max_connections * avg_per_connection
  OS Reserve:        Max(10% RAM, 4 GB)

  Example (128 GB server):
    Buffer pool:     96 GB (75%)
    Per-connection:  5 GB  (500 conns * 10 MB)
    InnoDB internal: 4 GB  (redo buffer, dict cache, AHI)
    OS reserve:      23 GB
```

### 10.3 CPU and Network

```
  CPU: Monitor Threads_running. If consistently > 2x CPU cores, either
  add CPU or optimize queries. Adding CPU to a full-table-scan query
  over 100M rows does nothing.

  Network:
  - Replication: binlog_rate * num_replicas = outbound from primary
  - Application: avg_result_size * QPS
  - Backup: xtrabackup can saturate 1 Gbps for 500 GB database
```

```sql
-- Track data growth weekly
SELECT TABLE_SCHEMA,
    ROUND(SUM(DATA_LENGTH+INDEX_LENGTH)/1024/1024/1024, 2) AS total_gb,
    SUM(TABLE_ROWS) AS approx_rows
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
GROUP BY TABLE_SCHEMA ORDER BY total_gb DESC;
```

---

## 11. Source Code References

| Component | Source File | Key Function |
|-----------|------------|--------------|
| Performance Schema engine | `storage/perfschema/pfs_engine_table.cc` | `PFS_engine_table::read_row()` |
| Instrument registration | `storage/perfschema/pfs_instr.cc` | `register_mutex_v1()` |
| Statement digest | `sql/sql_digest.cc` | `compute_digest_text()` |
| InnoDB monitor output | `storage/innobase/srv/srv0srv.cc` | `srv_printf_innodb_monitor()` |
| Buffer pool stats | `storage/innobase/buf/buf0buf.cc` | `buf_stats_get_pool_info()` |
| Checkpoint logic | `storage/innobase/log/log0chkp.cc` | `log_checkpoint()` |
| Page cleaner | `storage/innobase/buf/buf0flu.cc` | `buf_flush_page_cleaner_coordinator()` |
| Purge coordinator | `storage/innobase/srv/srv0srv.cc` | `srv_purge_coordinator_thread()` |
| Slow query log | `sql/log.cc` | `slow_log_print()` |

---

## 12. Summary

```
  The Observability Stack:

                ┌──────────────────────────┐
                │   PMM / Grafana          │  Dashboards & Alerts
                ├──────────────────────────┤
                │   sys Schema             │  Human-readable views
                ├──────────────────────────┤
                │   Performance Schema     │  In-memory instrumentation
                ├──────────────────────────┤
                │   SHOW ENGINE INNODB     │  InnoDB internal dashboard
                │   STATUS                 │
                ├──────────────────────────┤
                │   SHOW GLOBAL STATUS     │  Server-wide counters
                └──────────────────────────┘
```

Key takeaways:

1. **Performance Schema is a storage engine** with in-memory tables. Default instruments
   add ~5-10% overhead and should always be enabled.
2. **sys schema** makes Performance Schema usable. `schema_unused_indexes` and
   `statements_with_runtimes_in_95th_percentile` are the two most-used views.
3. **INNODB STATUS**: buffer pool hit rate, history list length, checkpoint age, and
   semaphore waits are the four numbers that tell you if InnoDB is healthy.
4. **innodb_buffer_pool_size** at 70-80% of RAM is the single most impactful variable.
5. **innodb_flush_log_at_trx_commit**: 1 for durability, 2 for performance with ~1s
   data loss risk. Know both values and their tradeoffs.
6. **OS tuning is not optional**: XFS, noatime, swappiness=1, THP disabled, NUMA
   interleave, performance CPU governor.
7. **pt-query-digest + Performance Schema digests** are complementary: slow log for
   historical analysis, Performance Schema for live analysis.
8. **Emergency procedures must be rehearsed**, not just documented. Practice disk full,
   OOM, replication broken, and corruption recovery quarterly.
9. **Capacity planning is about growth rate**, not current usage. Alert at 70% disk.
10. **PMM** is the de facto open-source standard for MySQL monitoring: VictoriaMetrics
    + ClickHouse + Grafana.

---

**Next chapter**: [Chapter 19 — MySQL in the Cloud: Aurora, PlanetScale, TiDB](19-mysql-in-the-cloud.md) —
How cloud-native engines disaggregate MySQL's storage layer, replace the redo log with
distributed consensus, and what tradeoffs they make for elastic scalability.
