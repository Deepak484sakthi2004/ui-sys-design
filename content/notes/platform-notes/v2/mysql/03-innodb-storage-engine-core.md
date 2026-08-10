# Chapter 3: InnoDB Storage Engine Core — The Complete Systems Diagram

> *"InnoDB is not a storage engine. It is an embedded transactional database that MySQL
> happens to talk to through a handler interface."*
> — Heikki Tuuri, creator of InnoDB

---

## 3.1 History and Design Philosophy

### 3.1.1 Origins: Innobase Oy, Helsinki, 1995

Heikki Tuuri founded Innobase Oy in Helsinki, Finland, with a singular obsession: build a
storage engine that treats ACID compliance and crash recovery as first-class citizens, not
afterthoughts bolted onto a file-based table format.

The timeline that shaped InnoDB:

```
1995    Heikki Tuuri founds Innobase Oy, begins InnoDB development.
        Core insight: embed a full transactional engine (MVCC, WAL, B+Tree)
        inside MySQL's pluggable storage engine API.

2000    InnoDB ships as a MySQL plugin. First production-grade transactional
        engine for MySQL. MyISAM remains default.

2001    MySQL AB and Innobase Oy sign licensing agreement.
        InnoDB bundled with MySQL distributions.

2005    Oracle acquires Innobase Oy. Community panics — Oracle now controls
        MySQL's only serious transactional engine while owning a competing DB.

2008    Sun Microsystems acquires MySQL AB ($1B).

2010    Oracle acquires Sun ($7.4B). Oracle now owns both MySQL and InnoDB.
        MySQL 5.5: InnoDB becomes the DEFAULT storage engine, replacing MyISAM.
        This is the single most important release in MySQL's history.

2013    MySQL 5.6: file-per-table default, transportable tablespaces,
        fulltext indexes in InnoDB, memcached plugin.

2016    MySQL 5.7: native JSON support, generated columns, parallel replication,
        InnoDB spatial indexes, buffer pool dump/restore.

2018    MySQL 8.0: data dictionary in InnoDB (no more .frm files), instant DDL,
        undo tablespace management, redo log archiving, hash join executor.

2024    MySQL 9.0/9.1: JavaScript stored programs, vector data type,
        continued optimizer improvements.
```

### 3.1.2 Design Goals

InnoDB's architecture answers four questions simultaneously:

1. **ACID Transactions** — Full isolation levels (READ UNCOMMITTED through SERIALIZABLE),
   group commit, XA distributed transactions.

2. **Crash Recovery** — WAL (write-ahead logging) + doublewrite buffer guarantees that
   any committed transaction survives a power failure and any partial write is detected.

3. **Row-Level Locking** — Locks individual index records (not whole pages or tables),
   enabling high-concurrency OLTP workloads.

4. **MVCC** — Readers never block writers. Writers never block readers. Old row versions
   maintained in undo logs until no active transaction needs them.

>>> **Interview Insight**: "Why did MySQL switch from MyISAM to InnoDB as default?"
>>> MyISAM uses table-level locking and has no crash recovery (corrupted tables after
>>> unclean shutdown). InnoDB provides row-level locking, MVCC, WAL-based crash recovery,
>>> and foreign key support. The switch in 5.5 acknowledged that transactional integrity
>>> is non-negotiable for production workloads.

### 3.1.3 InnoDB vs MyISAM — The Architectural War

```
Feature              | InnoDB                        | MyISAM
---------------------+-------------------------------+---------------------------
Locking              | Row-level (record locks,      | Table-level only
                     | gap locks, next-key locks)    |
Transactions         | Full ACID                     | None
Crash Recovery       | WAL + doublewrite buffer,     | No WAL; repair table
                     | automatic on restart          | required after crash
MVCC                 | Yes — undo log versioning     | No — readers block writers
Foreign Keys         | Enforced                      | Ignored
Full-Text Search     | Yes (since 5.6)               | Yes
Clustered Index      | Primary key IS the table      | Heap file + separate indexes
                     | (index-organized table)       |
Compression          | Page-level (KEY_BLOCK_SIZE)    | Row-level (myisampack)
Count(*)             | Table scan (MVCC means no     | Stored metadata (instant)
                     | single "correct" count)       |
Data Files           | .ibd (tablespace)             | .MYD (data) + .MYI (index)
Buffer Management    | Buffer Pool (LRU, adaptive)   | Key cache (indexes only,
                     |                               | OS cache for data)
```

>>> **Interview Insight**: "Why is `SELECT COUNT(*)` slow in InnoDB?"
>>> Because of MVCC. Different transactions see different versions of rows. There is no
>>> single "true" row count — each transaction's count depends on its read view. InnoDB
>>> must perform a full index scan (cheapest secondary index) to count visible rows.
>>> MyISAM stores metadata row count because it has no MVCC — the count is always global.

### 3.1.4 InnoDB vs PostgreSQL Storage — Fundamental Design Differences

```
Dimension            | InnoDB                        | PostgreSQL (Heap + TOAST)
---------------------+-------------------------------+---------------------------
Table Organization   | Index-organized (clustered    | Heap-organized (rows stored
                     | on PK, data in leaf pages)    | in arbitrary heap pages)
MVCC Strategy        | Undo-log based: current ver-  | In-place: OLD row versions
                     | sion in-place, old versions   | remain in heap alongside
                     | in rollback segment           | new versions (HOT, etc.)
Cleanup Mechanism    | Purge threads remove old      | VACUUM process reclaims
                     | undo records asynchronously   | dead tuple space
Write Amplification  | Doublewrite buffer → 2x for   | Full-page writes after
                     | data pages, WAL for redo      | checkpoint (full_page_writes)
Index Types          | B+Tree (primary), B+Tree      | B-tree, Hash, GiST, SP-GiST,
                     | (secondary), R-Tree, FTS      | GIN, BRIN, Bloom
Secondary Index Cost | Stores PK value → double      | Stores ctid (heap TID) →
                     | lookup on non-covering scan   | single lookup but VACUUM
                     |                               | must update indexes
Buffer Pool          | Own buffer pool (bypasses     | Shared buffers + OS page
                     | OS page cache ideally)        | cache (double buffering
                     |                               | common)
Page Size            | 16 KB default (4K/8K/32K/64K) | 8 KB default (compile-time)
WAL                  | Physiological redo log        | Physiological WAL
                     | (page ID + offset + data)     | (similar design)
```

>>> **Interview Insight**: "InnoDB vs PostgreSQL MVCC — which is better?"
>>> Neither universally. InnoDB's undo-based MVCC keeps the main table clean (no bloat)
>>> but pays the cost of maintaining rollback segments and purge lag. PostgreSQL's
>>> in-place MVCC avoids the undo log overhead but suffers from heap bloat requiring
>>> VACUUM. Long-running transactions hurt both: in InnoDB, purge stalls and undo space
>>> grows; in PostgreSQL, dead tuples accumulate and table bloats.

---

## 3.2 Complete Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         InnoDB STORAGE ENGINE                                   │
│                                                                                 │
│  ┌───────────────────────────── IN-MEMORY ────────────────────────────────────┐ │
│  │                                                                            │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                       BUFFER POOL (128 MB default)                   │  │ │
│  │  │  ┌────────────────┐  ┌────────────────┐  ┌───────────────────────┐  │  │ │
│  │  │  │  Data Pages    │  │  Index Pages   │  │  Undo Log Pages       │  │  │ │
│  │  │  │  (clustered    │  │  (secondary    │  │  (cached undo         │  │  │ │
│  │  │  │   index leaf)  │  │   B+Tree)      │  │   records)            │  │  │ │
│  │  │  └────────────────┘  └────────────────┘  └───────────────────────┘  │  │ │
│  │  │  ┌────────────────┐  ┌────────────────┐  ┌───────────────────────┐  │  │ │
│  │  │  │  Change Buffer │  │  Adaptive Hash │  │  Lock Hash Table      │  │  │ │
│  │  │  │  (deferred 2nd │  │  Index (AHI)   │  │  (record/gap/table    │  │  │ │
│  │  │  │   idx updates) │  │  (auto-built)  │  │   lock structs)       │  │  │ │
│  │  │  └────────────────┘  └────────────────┘  └───────────────────────┘  │  │ │
│  │  │  ┌────────────────────────┐  ┌──────────────────────────────────┐   │  │ │
│  │  │  │  Free List / LRU List  │  │  Flush List (dirty pages        │   │  │ │
│  │  │  │  / Unzip LRU           │  │  ordered by oldest_modification)│   │  │ │
│  │  │  └────────────────────────┘  └──────────────────────────────────┘   │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                            │ │
│  │  ┌───────────────────┐  ┌──────────────────────┐  ┌─────────────────────┐ │ │
│  │  │  LOG BUFFER       │  │  DATA DICTIONARY     │  │  TRX SYSTEM         │ │ │
│  │  │  (64 MB default)  │  │  CACHE (DD tables    │  │  (active trx list,  │ │ │
│  │  │  (redo log staging│  │   metadata cached    │  │   read views,       │ │ │
│  │  │   before flush)   │  │   in buffer pool)    │  │   trx_id counter)   │ │ │
│  │  └─────────┬─────────┘  └──────────────────────┘  └─────────────────────┘ │ │
│  │            │                                                               │ │
│  └────────────┼───────────────────────────────────────────────────────────────┘ │
│               │                                                                 │
│  ─────────────┼──────────── BACKGROUND THREADS ──────────────────────────────── │
│               │                                                                 │
│  ┌────────────┴──────────┐  ┌──────────────┐  ┌─────────────────────────────┐  │
│  │  Log Writer Thread    │  │  Page Cleaner│  │  Purge Threads              │  │
│  │  Log Flusher Thread   │  │  Threads     │  │  (undo cleanup)             │  │
│  │  Log Checkpointer     │  │  (dirty page │  │                             │  │
│  │  Write/Flush Notifier │  │   flushing)  │  │  Master Thread              │  │
│  └────────────┬──────────┘  └──────┬───────┘  │  (coordinator)              │  │
│               │                    │          └──────────────┬──────────────┘  │
│               │                    │                         │                  │
│  ─────────────┼────────────────────┼─────────────────────────┼───── DISK ────── │
│               │                    │                         │                  │
│               ▼                    ▼                         ▼                  │
│  ┌─────────────────┐  ┌─────────────────────┐  ┌────────────────────────────┐  │
│  │  REDO LOG       │  │  SYSTEM TABLESPACE  │  │  UNDO TABLESPACES          │  │
│  │  ib_redo_logN   │  │  ibdata1            │  │  undo_001, undo_002        │  │
│  │  (circular WAL) │  │  - Change buffer    │  │  (rollback segments,       │  │
│  │                 │  │  - Data dictionary   │  │   old row versions)        │  │
│  │                 │  │  - Doublewrite meta  │  │                            │  │
│  └─────────────────┘  └─────────────────────┘  └────────────────────────────┘  │
│                                                                                 │
│  ┌─────────────────┐  ┌─────────────────────┐  ┌────────────────────────────┐  │
│  │  FILE-PER-TABLE │  │  DOUBLEWRITE BUFFER │  │  TEMP TABLESPACE           │  │
│  │  TABLESPACES    │  │  #ib_16384_0.dblwr  │  │  ibtmp1 (session temp)     │  │
│  │  schema/tbl.ibd │  │  #ib_16384_1.dblwr  │  │  temp_1.ibt .. temp_10.ibt│  │
│  │  (per-table     │  │  (torn page         │  │  (internal temp tables,    │  │
│  │   data+index)   │  │   protection)       │  │   temp rollback segments)  │  │
│  └─────────────────┘  └─────────────────────┘  └────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow: A Single INSERT Statement

```
  Client: INSERT INTO orders (id, amount) VALUES (42, 99.95)
     │
     ▼
  1. SQL Layer parses, optimizes, calls handler::ha_write_row()
     │
     ▼
  2. InnoDB assigns transaction ID (trx_id) from trx_sys
     │
     ├──► 3a. Generate UNDO record (for rollback/MVCC)
     │         Write undo record to undo log page in buffer pool
     │
     ├──► 3b. Insert row into clustered index B+Tree leaf page
     │         (page in buffer pool — mark page DIRTY)
     │
     ├──► 3c. For each secondary index:
     │         If page in buffer pool → insert directly, mark dirty
     │         If page NOT in buffer pool → buffer in CHANGE BUFFER
     │
     └──► 3d. Generate REDO log records for all page modifications
              Write to LOG BUFFER
     │
     ▼
  4. On COMMIT:
     ├──► Log Writer flushes log buffer to redo log files on disk
     ├──► Log Flusher calls fsync() on redo log (if innodb_flush_log_at_trx_commit=1)
     └──► Return success to client
              (dirty data pages still only in buffer pool — NOT yet on disk)
     │
     ▼
  5. Later (asynchronously):
     ├──► Page Cleaner threads flush dirty pages from buffer pool to .ibd files
     │    (through doublewrite buffer for torn-page protection)
     ├──► Purge threads clean up undo records no longer needed by any read view
     └──► Change buffer merges deferred secondary index changes when pages are read
```

>>> **Interview Insight**: "Does InnoDB write data to the table file on COMMIT?"
>>> No. On COMMIT, InnoDB only guarantees the redo log is on disk (fsync). The actual
>>> data pages are flushed later by background page cleaner threads. This is the
>>> fundamental WAL contract: as long as the redo log is durable, the data can be
>>> reconstructed from it during crash recovery.

---

## 3.3 In-Memory Structures

### 3.3.1 Buffer Pool

The buffer pool is InnoDB's most critical in-memory structure. It caches data pages,
index pages, undo pages, change buffer pages, and adaptive hash index entries. Detailed
treatment is in Chapter 4; here we cover the essentials.

**Key properties:**
- Default size: 128 MB. Production: typically 70-80% of system RAM.
- Page size: 16 KB default (matching on-disk page size).
- Organized as a hash table of `(space_id, page_no)` -> `buf_page_t` for O(1) lookup.
- Three linked lists manage page lifecycle:
  - **Free List**: pages available for use.
  - **LRU List**: pages in use, ordered by recent access. Split into "young" (hot) and
    "old" (cold) sublists at the 3/8 point (`innodb_old_blocks_pct=37`).
  - **Flush List**: dirty pages ordered by `oldest_modification` LSN.

**Multiple buffer pool instances** (`innodb_buffer_pool_instances`):
- Reduces mutex contention on the buffer pool mutex.
- Each instance has its own free list, LRU list, flush list, and mutex.
- Pages are assigned to instances by `hash(space_id, page_no) % instances`.
- Default: 8 instances (if buffer pool >= 1 GB) in MySQL 5.7+. In 8.0, auto-tuned.

Source: `storage/innobase/buf/buf0buf.cc` — `buf_pool_init()`, `buf_page_get_gen()`.

### 3.3.2 Change Buffer (Insert Buffer Evolution)

The change buffer is one of InnoDB's most clever optimizations. It defers writes to
**non-unique secondary index pages** that are not currently in the buffer pool.

**Problem it solves:**
A table with 5 secondary indexes means an INSERT touches 6 B+Trees (1 clustered + 5
secondary). If the secondary index pages are not in the buffer pool, each insert would
require 5 random disk reads just to load those pages, modify them, and mark them dirty.

**Solution:**
Instead of reading the page from disk, buffer the change in a special B+Tree structure
(the change buffer) that lives in the system tablespace. When the secondary index page
is eventually read into the buffer pool (by a SELECT or by the purge/merge thread),
the buffered changes are merged into it.

```
Without Change Buffer:              With Change Buffer:

INSERT row                           INSERT row
  │                                    │
  ├─► Update clustered index (BP)      ├─► Update clustered index (BP)
  ├─► Read sec_idx page from DISK      ├─► Buffer change in change buffer
  ├─► Update sec_idx page              │   (in buffer pool, backed by ibdata1)
  ├─► Read sec_idx2 page from DISK     ├─► Buffer change in change buffer
  ├─► Update sec_idx2 page             │
  └─► ... (repeat per index)           └─► Done — no disk reads!

                                    Later, when sec_idx page is read:
                                      Merge buffered changes into page
```

**What operations are buffered:**
- Originally only INSERTs (hence "insert buffer" in older MySQL).
- MySQL 5.5+: INSERT, DELETE-mark, PURGE operations on secondary indexes.
- Renamed to "Change Buffer" to reflect broader scope.
- Controlled by `innodb_change_buffering`: `all`, `inserts`, `deletes`, `changes`,
  `purges`, `none`.

**What is NOT buffered:**
- Unique secondary index changes (must read the page to check uniqueness constraint).
- Clustered index changes (always accessed, always in buffer pool for active rows).
- Pages already in the buffer pool (no need to defer — modify directly).

**Change buffer as a B+Tree:**
The change buffer is itself a B+Tree stored in the system tablespace (`ibdata1`).
Key: `(space_id, page_no, counter)`. The counter ensures ordering of operations
for the same page. Merges apply operations in order.

Source: `storage/innobase/ibuf/ibuf0ibuf.cc` — `ibuf_insert()`, `ibuf_merge_or_delete_for_page()`.

**Sizing:** `innodb_change_buffer_max_size` = 25 (default) = up to 25% of buffer pool.

>>> **Interview Insight**: "When would you disable the change buffer?"
>>> On SSD-backed systems with write-heavy workloads and few secondary indexes, the
>>> change buffer adds overhead (maintaining the B+Tree, deferred merges) with limited
>>> benefit since random reads are fast on SSD. Set `innodb_change_buffering=none`.
>>> Also disable if you see change buffer mutex contention in `SHOW ENGINE INNODB STATUS`.

### 3.3.3 Adaptive Hash Index (AHI)

InnoDB's B+Tree traversal requires following a root-to-leaf path for every lookup.
For hot pages accessed repeatedly with the same search pattern, this traversal is
redundant. The Adaptive Hash Index builds an in-memory hash table that maps
(index prefix) -> (leaf page pointer) for hot B+Tree pages, converting O(log n)
B+Tree traversals into O(1) hash lookups.

```
Normal B+Tree lookup:           With AHI:

  Root Page                       Hash Table (in-memory only)
     │                            ┌────────────────────────────┐
     ▼                            │ hash(col_prefix) → page_ptr│
  Internal Page                   │ hash(col_prefix) → page_ptr│
     │                            │ hash(col_prefix) → page_ptr│
     ▼                            └────────────┬───────────────┘
  Internal Page                                │
     │                                         ▼
     ▼                            Direct to leaf page (O(1))
  Leaf Page (3-4 page reads)
```

**Key characteristics:**
- Entirely automatic — InnoDB monitors access patterns and builds hashes.
- Uses buffer pool memory (reduces space for cached pages).
- Partitioned into `innodb_adaptive_hash_index_parts` (default: 8) to reduce contention.
- NOT persistent — rebuilt on restart, lost on shutdown.
- Can be disabled: `innodb_adaptive_hash_index=OFF`.

**When AHI helps:** Point lookups (`WHERE id = ?`) with uniform access patterns.
**When AHI hurts:** Range scans, workloads with many different search prefixes
(AHI thrashes), or when the rw-lock on `btr_search_latch` becomes a bottleneck.

Source: `storage/innobase/btr/btr0sea.cc` — `btr_search_guess_on_hash()`.

Performance Schema: `SHOW GLOBAL STATUS LIKE 'Innodb_adaptive_hash%'` shows
`hash searches/s` vs `non-hash searches/s`. If the hash search ratio is low,
AHI is wasting memory.

>>> **Interview Insight**: "Should you always enable the Adaptive Hash Index?"
>>> No. In MySQL 8.0, AHI is often disabled in cloud-managed databases (Aurora, RDS)
>>> and high-concurrency OLTP systems because the internal rw-lock (`btr_search_latch`,
>>> now partitioned) becomes a contention point. Monitor `SEMAPHORES` section in
>>> `SHOW ENGINE INNODB STATUS`. If you see waits on `btr_search_latch`, disable AHI.

### 3.3.4 Log Buffer

The log buffer is a contiguous memory region that stages redo log records before they
are written to the redo log files on disk.

```
  mtr commit                   Log Writer Thread          Log Flusher Thread
     │                              │                           │
     ▼                              ▼                           ▼
  ┌──────────────┐            ┌──────────────┐           ┌──────────────┐
  │  LOG BUFFER  │ ──write──► │  OS Buffer   │ ──fsync─► │  Redo Log    │
  │  (in-memory, │            │  (kernel      │           │  Files       │
  │   64 MB)     │            │   page cache) │           │  (on disk)   │
  └──────────────┘            └──────────────┘           └──────────────┘
```

**Key properties:**
- Size: `innodb_log_buffer_size` (default 16 MB, often 64 MB in production).
- Redo records are appended by `mtr_t::commit()`.
- Concurrent transactions write to the log buffer using a lock-free reservation
  scheme (MySQL 8.0 redesign: `log_buffer_reserve()` uses `log.sn` atomic counter).
- The log buffer is a circular buffer; if full, writers wait for the log writer
  to drain it.

**Flush triggers:**
1. Transaction commit (if `innodb_flush_log_at_trx_commit` = 1 or 2).
2. Log buffer is half-full.
3. Every second (background log writer thread).
4. Checkpoint advance requires space.

Source: `storage/innobase/log/log0buf.cc`, `storage/innobase/log/log0write.cc`.

### 3.3.5 Lock System Hash Table

InnoDB maintains an in-memory hash table for all record-level and table-level locks.

- Hash key: `(space_id, page_no)` — all locks for records on the same page
  share a hash bucket.
- Lock structs (`lock_t`) are allocated from a memory heap per transaction.
- Types: record locks, gap locks, next-key locks, insert intention locks, table locks.
- The lock system uses a global mutex (`lock_sys->mutex`, sharded in 8.0 into
  `lock_sys->latches` based on page hash) to protect the hash table.

Lock memory is NOT taken from the buffer pool — it uses its own allocator.

Source: `storage/innobase/lock/lock0lock.cc` — `lock_rec_lock()`, `lock_table()`.

### 3.3.6 Data Dictionary Cache

In MySQL 8.0, the data dictionary (DD) is stored in InnoDB tables within the `mysql`
schema. These DD tables are cached in the buffer pool like any other InnoDB pages.

Additionally, a DD object cache (separate from the buffer pool) caches deserialized
table definitions, column metadata, index definitions, etc. This avoids reparsing
DD table rows on every table access.

The DD cache uses a multi-level scheme:
1. **Thread-local cache** — per-thread auto-releaser for DD objects in current statement.
2. **Shared cache** — global LRU cache of DD objects (`dd::cache::Shared_dictionary_cache`).
3. **Buffer pool** — raw DD table pages.
4. **Disk** — DD tables in `mysql.ibd`.

Pre-8.0: The data dictionary was split between `.frm` files (server layer) and the
InnoDB internal data dictionary (in `ibdata1`). This caused consistency issues and
was a major source of bugs — a crash between writing `.frm` and updating the InnoDB
dictionary left the schema in an inconsistent state.

Source: `sql/dd/cache/dictionary_client.cc`, `storage/innobase/dict/dict0dict.cc`.

---

## 3.4 On-Disk Structures

### 3.4.1 System Tablespace (`ibdata1`)

The system tablespace is the original monolithic file that InnoDB used for everything.
Over successive MySQL releases, components have been moved out to dedicated files:

```
ibdata1 Contents by MySQL Version:

  MySQL 5.5:                    MySQL 8.0:
  ┌─────────────────────┐      ┌─────────────────────┐
  │ Data dictionary      │      │ Change buffer B+Tree│ ◄── still here
  │ Doublewrite buffer   │      │ Doublewrite metadata│ ◄── metadata only (8.0.20+)
  │ Change buffer B+Tree │      │ System internal     │
  │ Undo logs (rollback  │      │  tables             │
  │  segments 0-127)     │      └─────────────────────┘
  │ User table data      │
  │  (if innodb_file_    │      Moved OUT:
  │   per_table=OFF)     │      - Data dictionary → mysql.ibd (8.0)
  └─────────────────────┘      - Undo logs → undo_001/002 (8.0)
                                - Doublewrite pages → .dblwr files (8.0.20)
                                - User table data → .ibd per table (5.6 default)
```

**Critical operational note:** `ibdata1` never shrinks. If undo logs or table data
once lived in `ibdata1`, that space is reclaimed internally (added to free list) but
the file size on disk does not decrease. This is the #1 reason to enable
`innodb_file_per_table` (default since 5.6) and separate undo tablespaces (8.0).

Configuration:
```
innodb_data_file_path = ibdata1:1G:autoextend   # starting size 1 GB, grows as needed
innodb_autoextend_increment = 64                # extend by 64 MB at a time
```

Source: `storage/innobase/fsp/fsp0fsp.cc` — file space management.

### 3.4.2 File-Per-Table Tablespaces (`.ibd` files)

When `innodb_file_per_table=ON` (default since MySQL 5.6), each InnoDB table gets
its own tablespace file: `<datadir>/<schema>/<table>.ibd`.

**Contents of a `.ibd` file:**
- Clustered index (primary key B+Tree with row data in leaf pages).
- All secondary indexes (each a separate B+Tree).
- Tablespace metadata (FSP header, extent descriptors, INODE pages).
- Per-table undo log pages (for online DDL operations only).

**Advantages of file-per-table:**
1. `DROP TABLE` reclaims disk space immediately (delete the `.ibd` file).
2. `OPTIMIZE TABLE` rebuilds the table and reclaims fragmented space.
3. Tables can be moved to different storage devices.
4. `ALTER TABLE ... DISCARD/IMPORT TABLESPACE` for transportable tablespaces.
5. Independent encryption per table.

**One `.ibd` file = one tablespace = one space_id:**
```
  mysql> SELECT space, name, file_size, allocated_size
         FROM information_schema.innodb_tablespaces
         WHERE name LIKE 'mydb/%';

  +-------+------------------+-----------+----------------+
  | space | name             | file_size | allocated_size |
  +-------+------------------+-----------+----------------+
  |    42 | mydb/orders      |  98304000 |       94371840 |
  |    43 | mydb/order_items | 147456000 |      143654912 |
  +-------+------------------+-----------+----------------+
```

Source: `storage/innobase/fil/fil0fil.cc` — `fil_ibd_create()`, `fil_ibd_open()`.

### 3.4.3 General Tablespaces

General tablespaces allow multiple tables to share a single `.ibd` file. This is
a middle ground between system tablespace and file-per-table.

```sql
CREATE TABLESPACE ts_orders
  ADD DATAFILE 'ts_orders.ibd'
  ENGINE = InnoDB;

CREATE TABLE orders (...) TABLESPACE ts_orders;
CREATE TABLE order_items (...) TABLESPACE ts_orders;
```

**Use cases:** Grouping related tables for I/O locality, applying shared encryption,
or managing fewer files (file-per-table with thousands of tables creates thousands
of file descriptors).

### 3.4.4 Undo Tablespaces

Undo tablespaces store rollback segments containing undo log records. These records
serve two purposes:
1. **Transaction rollback** — undo changes if a transaction aborts.
2. **MVCC read views** — provide old row versions for consistent reads.

**Evolution:**
- Pre-8.0: Undo logs stored in `ibdata1` (system tablespace). Causes `ibdata1` bloat.
- MySQL 8.0: Minimum 2 undo tablespaces (`undo_001`, `undo_002`). Separate from system
  tablespace. Can be truncated to reclaim space.
- `innodb_undo_tablespaces` = 2 (default, minimum). Can be increased online.

```
  ┌──────────────────────────────────────┐
  │          UNDO TABLESPACE             │
  │  ┌────────────────────────────────┐  │
  │  │  Rollback Segment 0           │  │
  │  │  ┌────────┐ ┌────────┐       │  │
  │  │  │ Undo   │ │ Undo   │ ...   │  │
  │  │  │ Log 1  │ │ Log 2  │       │  │
  │  │  └────────┘ └────────┘       │  │
  │  └────────────────────────────────┘  │
  │  ┌────────────────────────────────┐  │
  │  │  Rollback Segment 1           │  │
  │  │  ...                           │  │
  │  └────────────────────────────────┘  │
  │  ... up to 128 rollback segments     │
  └──────────────────────────────────────┘
```

Each rollback segment supports up to ~1024 concurrent transactions (limited by undo
slot count per rollback segment page). With 128 rollback segments across 2 undo
tablespaces: 128 * 1024 = ~131,072 concurrent transactions maximum.

**Undo tablespace truncation:**
MySQL 8.0 can automatically truncate undo tablespaces when they grow beyond
`innodb_max_undo_log_size` (default 1 GB). The purge thread marks the tablespace
for truncation, and InnoDB recreates it at minimum size. Requires at least 2 undo
tablespaces so one can be truncated while the other serves transactions.

Source: `storage/innobase/trx/trx0rseg.cc`, `storage/innobase/trx/trx0undo.cc`.

### 3.4.5 Redo Log Files

The redo log is InnoDB's write-ahead log — the mechanism that ensures durability.
Every page modification is recorded in the redo log BEFORE the page is written to
the tablespace file.

**Pre-8.0.30:**
- Fixed files: `ib_logfile0`, `ib_logfile1` (circular, fixed size).
- `innodb_log_file_size` * `innodb_log_files_in_group` = total redo log capacity.
- Changing log file size required clean shutdown, delete log files, restart.

**MySQL 8.0.30+:**
- Dynamic redo log: files in `#innodb_redo/` directory.
- Named `#ib_redo_N` (N = log sequence number range).
- `innodb_redo_log_capacity` replaces the old size/count variables.
- Can be resized dynamically without restart.

```
  Redo Log Circular Structure (conceptual):

     LSN 1000         LSN 5000         LSN 9000
        │                │                │
        ▼                ▼                ▼
  ┌─────────────────────────────────────────────────┐
  │ ████████████████████████████████░░░░░░░░░░░░░░░ │
  │ ▲ checkpoint_lsn    ▲ write_lsn    ▲ capacity  │
  │ │                    │                          │
  │ Oldest dirty page   Current write              │
  │ not yet flushed     position                   │
  └─────────────────────────────────────────────────┘

  Space between checkpoint_lsn and capacity = available log space
  If write_lsn catches up to checkpoint_lsn → STALL (furious flushing)
```

**Critical LSN markers:**
- `flushed_to_disk_lsn` — all redo up to this LSN is on disk (fsync'd).
- `write_lsn` — all redo up to this LSN is written (may be in OS cache).
- `current_lsn` (`log.sn` converted) — latest redo generated.
- `checkpoint_lsn` — all pages modified before this LSN are flushed to tablespace
  files. Crash recovery replays from `checkpoint_lsn` to `flushed_to_disk_lsn`.

Source: `storage/innobase/log/log0log.cc`, `storage/innobase/log/log0recv.cc`.

>>> **Interview Insight**: "What happens if the redo log fills up?"
>>> InnoDB stalls all writes and forces an aggressive checkpoint — flushing dirty
>>> pages to advance `checkpoint_lsn` and free redo log space. This is called a
>>> "furious flushing" or "sync flush" event. During this stall, the server appears
>>> hung because no transaction can generate new redo records. This is why redo log
>>> sizing is critical: `innodb_redo_log_capacity` should be large enough to absorb
>>> write bursts (typically 1-4 GB for OLTP, more for bulk loads).

### 3.4.6 Doublewrite Buffer Files

The doublewrite buffer protects against torn pages — a partial 16 KB page write caused
by a crash mid-I/O (disk hardware writes 512-byte or 4 KB sectors atomically, not 16 KB).

**Write path:**
1. Before flushing a dirty page to its tablespace `.ibd` file, write it to the
   doublewrite buffer first.
2. Doublewrite buffer is sequential (fast sequential write).
3. Then write the page to its actual location in the `.ibd` file (random write).
4. If a crash occurs during step 3, recovery reads the intact copy from the
   doublewrite buffer and restores the page.

```
  Dirty Page in Buffer Pool
       │
       ├──► 1. Write to Doublewrite Buffer (sequential, fast)
       │        ┌──────────────────────────────────────┐
       │        │ DWB: [Page1][Page2][Page3]...        │
       │        │ (batch of 64 pages flushed together) │
       │        └──────────────────────────────────────┘
       │
       └──► 2. Write to actual .ibd location (random I/O)
                ┌──────────────────────────────────────┐
                │ orders.ibd: ... [Page at offset X] ...│
                └──────────────────────────────────────┘
```

**MySQL 8.0.20+ change:**
Doublewrite buffer moved from `ibdata1` to separate files:
`#ib_16384_0.dblwr`, `#ib_16384_1.dblwr` (16384 = default page size).
Configurable via `innodb_doublewrite_dir`, `innodb_doublewrite_files`,
`innodb_doublewrite_pages`.

**When to disable:** `innodb_doublewrite=OFF`
- File systems with atomic 16 KB writes (ZFS, some enterprise SANs).
- When using `O_DIRECT` on file systems that guarantee atomic page writes.
- Replicas where data can be rebuilt from the primary.
- Note: disabling saves ~2x write amplification for data pages.

Source: `storage/innobase/buf/buf0dblwr.cc` — `buf_dblwr_write_single_page()`.

### 3.4.7 Temporary Tablespace

InnoDB uses two types of temporary tablespace:

**Session temporary tablespace (`ibt` files):**
- Pool of on-disk temp tablespace files: `temp_1.ibt` through `temp_10.ibt`.
- One file assigned per session that creates internal temp tables.
- Used for: complex sort operations, GROUP BY, UNION, subquery materialization.
- Reclaimed when session disconnects.

**Global temporary tablespace (`ibtmp1`):**
- Rollback segments for changes to user-created temporary tables.
- Recreated on server restart (temp data is not persistent).
- `innodb_temp_data_file_path = ibtmp1:12M:autoextend:max:5G`

---

## 3.5 Tablespace File Format

Every InnoDB tablespace file (`.ibd`, `ibdata1`, undo tablespaces) shares the same
page-based format. Understanding this format is essential for crash forensics,
`innodb_space` tool analysis, and interview-level depth.

### 3.5.1 Page — The Fundamental Unit

All InnoDB I/O operates on fixed-size pages (default 16 KB = 16,384 bytes).

```
  16 KB InnoDB Page Layout:
  ┌─────────────────────────────────────────────────────────────┐
  │  FIL Header (38 bytes)                                      │
  │  ┌─────────────────────────────────────────────────────────┐│
  │  │ Checksum (4)  │ Page No (4)  │ Prev Page (4)           ││
  │  │ Next Page (4) │ LSN (8)      │ Page Type (2)           ││
  │  │ Flush LSN (8) │ Space ID (4)                            ││
  │  └─────────────────────────────────────────────────────────┘│
  │                                                             │
  │  Page Body (16,252 bytes)                                   │
  │  (contents depend on page type — index, undo, FSP, etc.)   │
  │                                                             │
  │  FIL Trailer (8 bytes)                                      │
  │  ┌─────────────────────────────────────────────────────────┐│
  │  │ Old-style Checksum (4) │ Low 32 bits of LSN (4)        ││
  │  └─────────────────────────────────────────────────────────┘│
  └─────────────────────────────────────────────────────────────┘
```

**Page types (`FIL_PAGE_TYPE`):**
```
  FIL_PAGE_INDEX          (17855)  B+Tree node (data or index page)
  FIL_PAGE_UNDO_LOG       (2)      Undo log page
  FIL_PAGE_INODE          (3)      Segment INODE page
  FIL_PAGE_IBUF_FREE_LIST (4)      Change buffer free list
  FIL_PAGE_FSP_HDR        (8)      File space header (page 0)
  FIL_PAGE_XDES           (9)      Extent descriptor page
  FIL_PAGE_SDI            (17853)  Serialized Dictionary Info (8.0)
```

Source: `storage/innobase/include/fil0fil.h` — page type constants.

### 3.5.2 Extent — 64 Contiguous Pages = 1 MB

An extent is a block of 64 contiguous pages (64 * 16 KB = 1 MB).
InnoDB allocates space in extents for sequential I/O efficiency.

```
  Extent (1 MB = 64 pages):
  ┌────┬────┬────┬────┬────┬─ ... ─┬────┬────┐
  │ P0 │ P1 │ P2 │ P3 │ P4 │       │P62 │P63 │
  └────┴────┴────┴────┴────┴─ ... ─┴────┴────┘
    16   16   16   16   16            16   16  KB
  │◄─────────────── 1 MB ────────────────────►│
```

For small tables (< 1 extent), InnoDB allocates individual pages from "fragment"
extents shared among multiple segments.

### 3.5.3 Segment — Collection of Extents for an Index

Each B+Tree in InnoDB uses two segments:
- **Leaf segment** — extents holding leaf pages (where actual row data resides).
- **Non-leaf segment** — extents holding internal (non-leaf) B+Tree pages.

This separation allows InnoDB to:
1. Allocate leaf pages contiguously for range scan performance.
2. Keep internal pages (frequently accessed) in separate extents.

```
  B+Tree Index on Disk:

  Non-leaf segment:   ┌─────────────────────┐
                      │  Extent A: internal  │
                      │  B+Tree pages        │
                      └─────────────────────┘

  Leaf segment:       ┌─────────────────────┐  ┌─────────────────────┐
                      │  Extent B: leaf      │  │  Extent C: leaf      │
                      │  pages (row data)    │  │  pages (row data)    │
                      └─────────────────────┘  └─────────────────────┘
```

### 3.5.4 XDES — Extent Descriptor Entries

Extent Descriptor (XDES) entries track the state of each extent in a tablespace.
Each XDES entry is 40 bytes:

```
  XDES Entry (40 bytes):
  ┌────────────────────────────────────────────────────┐
  │ Segment ID (8 bytes)  — which segment owns this    │
  │ FLST Node  (12 bytes) — linked list pointers       │
  │ State      (4 bytes)  — FREE / FREE_FRAG /         │
  │                         FULL_FRAG / FSEG            │
  │ Bitmap     (16 bytes) — 2 bits per page (64 pages) │
  │                         bit 0: free/in-use          │
  │                         bit 1: clean/dirty (unused) │
  └────────────────────────────────────────────────────┘
```

XDES entries are stored on XDES pages. The first XDES page is page 0 (the FSP_HDR
page). Each XDES page describes 256 extents (256 * 1 MB = 256 MB). So one XDES page
appears every 256 MB (every 16,384 pages): page 0, page 16384, page 32768, etc.

### 3.5.5 INODE Pages

Segment INODE pages track the extents belonging to each segment (leaf or non-leaf
for each index). Each INODE entry contains:

- Segment ID
- Three linked lists of extent descriptors:
  - **FREE**: fully unused extents allocated to this segment.
  - **NOT_FULL**: partially used extents (some pages free).
  - **FULL**: fully used extents (all 64 pages in use).
- 32 "fragment" page slots for small allocations (individual pages, not full extents).

Each INODE page holds 85 INODE entries (for default 16 KB page size). Since each
B+Tree index needs 2 segments (leaf + non-leaf), one INODE page can describe
42 indexes.

### 3.5.6 FSP_HDR — File Space Header (Page 0)

Page 0 of every tablespace is the FSP_HDR page. It contains:

```
  Page 0 (FSP_HDR) layout:
  ┌─────────────────────────────────────────────────────┐
  │  FIL Header (38 bytes)                               │
  │  FSP Header (112 bytes):                              │
  │    - Space ID                                         │
  │    - Size (in pages)                                  │
  │    - FREE list (of full extents not assigned to       │
  │      any segment)                                     │
  │    - FREE_FRAG list (extents with some free pages)    │
  │    - FULL_FRAG list (fragment extents fully used)     │
  │    - Next segment ID to allocate                      │
  │    - INODE page list (FULL and NOT_FULL)              │
  │  XDES entries for first 256 extents (40 * 256 bytes) │
  │  FIL Trailer (8 bytes)                                │
  └─────────────────────────────────────────────────────┘
```

**Physical addressing in InnoDB:**
Every location in a tablespace is identified by `(space_id, page_no)`.
The offset in the file = `page_no * page_size`.
A record on a page is identified by `(space_id, page_no, heap_no)`.

```
  Tablespace Physical Layout:

  Page 0: FSP_HDR (space header + first 256 XDES entries)
  Page 1: IBUF_BITMAP (change buffer bitmap for this 256-MB range)
  Page 2: INODE page (segment descriptors)
  Page 3: SDI page (serialized dictionary info in 8.0)
  Page 4: B+Tree root page for clustered index (usually)
  Page 5: B+Tree root page for first secondary index
  Page 6+: B+Tree internal/leaf pages, undo pages, etc.
  ...
  Page 16384: XDES page (descriptors for next 256 extents)
  Page 16385: IBUF_BITMAP
  ...
```

Source: `storage/innobase/fsp/fsp0fsp.cc` — `fsp_header_init()`, `fsp_alloc_seg_inode()`.

>>> **Interview Insight**: "Walk me through how InnoDB finds a row given a primary key."
>>> 1. Look up the tablespace for the table: `space_id` from data dictionary cache.
>>> 2. Find the root page of the clustered index (stored in `SYS_INDEXES` / DD table).
>>> 3. Start at root page, binary search within page's page directory (sparse index
>>>    of record offsets). Follow child page pointer for the matching range.
>>> 4. Repeat binary search at each internal page level.
>>> 5. At leaf page: binary search for the record. The row data is inline in the
>>>    leaf page (clustered index = index-organized table).
>>> 6. If the row has overflow columns (BLOB/TEXT > 768 bytes for COMPACT format),
>>>    follow overflow page pointers.

---

## 3.6 Background Threads

InnoDB runs multiple background threads that perform asynchronous maintenance operations.
In MySQL 8.0, the log subsystem was completely redesigned with dedicated threads.

### 3.6.1 Master Thread

The master thread is the oldest InnoDB background thread. In early InnoDB, it was
responsible for almost everything: flushing, purging, checkpointing. In MySQL 8.0,
most of these responsibilities have been delegated to specialized threads.

**Current responsibilities (8.0):**
- Periodic change buffer merge.
- Adaptive flushing coordination (signaling page cleaner threads).
- Background statistics updates (`dict_update_statistics()`).
- SRV_MASTER tick (once per second) for internal housekeeping.

The master thread runs in 1-second and 10-second loops:

```
  Master Thread Pseudo-code (simplified):

  loop:
    sleep(1 second)

    # Every 1 second:
    - Flush log buffer (if needed)
    - Merge change buffer (if I/O capacity available)
    - Signal page cleaners (if dirty page percentage high)

    # Every 10 seconds:
    - Merge change buffer aggressively
    - Background checkpoint (if needed)
    - Purge undo logs (delegated to purge threads)
    - Adjust adaptive flushing rate

  # On idle:
    - Aggressive change buffer merge
    - Aggressive flushing
```

Source: `storage/innobase/srv/srv0srv.cc` — `srv_master_thread()`.

### 3.6.2 Page Cleaner Threads

Page cleaner threads flush dirty pages from the buffer pool to disk. This is one of
the most I/O-intensive operations in InnoDB.

```
  innodb_page_cleaners = 4 (default, matches innodb_buffer_pool_instances)

  Page Cleaner Coordinator Thread
       │
       ├──► Page Cleaner Worker 1  ──► flush dirty pages for BP instance 1
       ├──► Page Cleaner Worker 2  ──► flush dirty pages for BP instance 2
       ├──► Page Cleaner Worker 3  ──► flush dirty pages for BP instance 3
       └──► Page Cleaner Worker 4  ──► flush dirty pages for BP instance 4
```

**Adaptive flushing algorithm:**
InnoDB dynamically adjusts the number of pages flushed per second based on:
1. Redo log fill rate — how fast `write_lsn` is approaching `checkpoint_lsn`.
2. Dirty page percentage — `innodb_max_dirty_pages_pct` (default 90).
3. I/O capacity — `innodb_io_capacity` and `innodb_io_capacity_max`.

The flush rate formula (simplified):
```
  redo_log_fill_ratio = (write_lsn - checkpoint_lsn) / redo_log_capacity
  desired_flush_rate = innodb_io_capacity * f(redo_log_fill_ratio)

  If redo_log_fill_ratio > 75%: aggressive flushing (approaching stall)
  If redo_log_fill_ratio > 85%: sync flushing (server stalls)
```

Dirty pages are flushed through the doublewrite buffer (unless disabled) in two modes:
- **LRU flushing** — evict cold pages from the LRU tail to make room for new pages.
- **Flush list flushing** — flush oldest dirty pages to advance checkpoint LSN.

Source: `storage/innobase/buf/buf0flu.cc` — `buf_flush_page_cleaner_coordinator()`,
`pc_flush_slot()`.

### 3.6.3 Purge Threads

Purge threads clean up undo log records that are no longer needed by any active
transaction's read view.

```
  innodb_purge_threads = 4 (default)

  Purge Coordinator Thread
       │
       ├──► Purge Worker 1  ──► process purge batch (delete-marked records)
       ├──► Purge Worker 2  ──► process purge batch
       ├──► Purge Worker 3  ──► process purge batch
       └──► Purge Worker 4  ──► process purge batch
```

**What purge does:**
1. **Remove delete-marked records** — When a DELETE statement runs, InnoDB marks the
   row with a delete flag but does not physically remove it (other transactions may
   need to read the old version). Purge physically removes these rows.
2. **Remove old undo records** — Undo log records that no read view references.
3. **Free undo log pages** — Return pages to the undo tablespace for reuse.

**Purge lag:**
`SHOW GLOBAL STATUS LIKE 'Innodb_history_list_length'` — number of undo log records
waiting to be purged. High values indicate purge cannot keep up (common cause:
long-running transactions holding old read views).

`innodb_max_purge_lag` — if history list length exceeds this, InnoDB adds artificial
delay to DML statements to throttle writes and let purge catch up.

Source: `storage/innobase/trx/trx0purge.cc` — `trx_purge()`, `srv_do_purge()`.

>>> **Interview Insight**: "What causes undo tablespace bloat?"
>>> Long-running transactions. Even a single `SELECT` with `REPEATABLE READ` holds a
>>> read view that prevents purge from cleaning undo records created after that read
>>> view was opened. A 1-hour reporting query on a write-heavy system can cause GB of
>>> undo accumulation. Solutions: read from a replica, use `READ COMMITTED` for reports,
>>> or set `innodb_undo_log_truncate=ON` with separate undo tablespaces.

### 3.6.4 I/O Threads

InnoDB uses dedicated threads for asynchronous I/O operations:

```
  innodb_read_io_threads  = 4 (default)  — handle async read requests
  innodb_write_io_threads = 4 (default)  — handle async write requests
```

On Linux, these threads use native AIO (`io_submit/io_getevents` on kernel >= 2.6
with `innodb_use_native_aio=ON`). On systems without native AIO, InnoDB simulates
async I/O with a thread pool (simulated AIO).

**Read-ahead:** InnoDB prefetches pages it predicts will be needed:
- **Linear read-ahead** (`innodb_read_ahead_threshold=56`): if 56 of the 64 pages in
  an extent are accessed sequentially, prefetch the next extent.
- **Random read-ahead** (disabled by default): if 13+ pages from the same extent are
  in the buffer pool, prefetch the remaining pages. Rarely useful; disabled in 8.0.

Source: `storage/innobase/os/os0file.cc` — `os_aio_func()`, `os_aio_linux_handler()`.

### 3.6.5 Log Subsystem Threads (MySQL 8.0 Redesign)

MySQL 8.0 decomposed the monolithic log writer into multiple specialized threads
for better scalability:

```
  Transaction commits ──► Log Buffer
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────┐
  │                    LOG SUBSYSTEM                          │
  │                                                          │
  │  Log Writer Thread ──► writes log buffer to OS cache     │
  │       │                                                  │
  │       ▼                                                  │
  │  Log Write Notifier ──► signals txns waiting for write   │
  │                                                          │
  │  Log Flusher Thread ──► fsync redo log to disk           │
  │       │                                                  │
  │       ▼                                                  │
  │  Log Flush Notifier ──► signals txns waiting for fsync   │
  │                                                          │
  │  Log Checkpointer ──► advances checkpoint_lsn,           │
  │                       writes checkpoint record            │
  │                                                          │
  │  Log Closer ──► closes inactive redo log files           │
  └──────────────────────────────────────────────────────────┘
```

**Why the decomposition?**
In MySQL 5.7, the log writer and flusher were the same thread. Under high concurrency,
this single thread became a bottleneck: it had to write AND fsync AND notify, serializing
all three operations. The 8.0 redesign pipelines these operations across threads:

```
  5.7 (serial):    [ write | fsync | notify | write | fsync | notify | ... ]

  8.0 (pipelined): [ write | write | write | write | ... ]
                   [ ---- | fsync | fsync | fsync | ... ]
                   [ ---- | ----- | notify| notify| ... ]
```

**Log Write Notifier** and **Log Flush Notifier** use event-based notification:
committing transactions wait on a specific LSN. When the writer/flusher passes that
LSN, the notifier wakes the waiting transaction. This avoids polling loops.

Source: `storage/innobase/log/log0write.cc` — `log_writer()`, `log_flusher()`,
`log_write_notifier()`, `log_flush_notifier()`, `log_checkpointer()`.

---

## 3.7 Mini-Transactions (mtr)

### 3.7.1 The Fundamental Unit of Atomicity Inside InnoDB

A mini-transaction (mtr) is the lowest-level unit of atomicity in InnoDB. It is
**not** a user-visible transaction — it is an internal mechanism that ensures a group
of page modifications and their redo log records are applied atomically.

```
  User Transaction vs Mini-Transaction:

  BEGIN;                           ┌── User Transaction (trx_t) ──────────┐
    INSERT INTO orders (...)       │                                       │
         ├─ mtr: modify undo page  │  ┌─ mtr_1 ─────────────────────────┐ │
         │  (allocate undo slot)   │  │ latch undo page                 │ │
         │                         │  │ write undo record               │ │
         │                         │  │ generate redo for undo page mod │ │
         │                         │  │ commit: copy redo to log buffer │ │
         │                         │  │ release latches                 │ │
         │                         │  └─────────────────────────────────┘ │
         │                         │                                       │
         ├─ mtr: insert into       │  ┌─ mtr_2 ─────────────────────────┐ │
         │  clustered index page   │  │ latch index page(s)             │ │
         │                         │  │ insert record into leaf page    │ │
         │                         │  │ possibly split page (new mtr)   │ │
         │                         │  │ generate redo log records       │ │
         │                         │  │ commit: copy redo to log buffer │ │
         │                         │  │ release latches                 │ │
         │                         │  └─────────────────────────────────┘ │
         │                         │                                       │
         ├─ mtr: update secondary  │  ┌─ mtr_3 ─────────────────────────┐ │
         │  index (or change       │  │ ... (similar pattern)           │ │
         │  buffer)                │  └─────────────────────────────────┘ │
    COMMIT;                        │                                       │
                                   └───────────────────────────────────────┘
```

### 3.7.2 mtr_t Structure

The `mtr_t` struct (defined in `storage/innobase/include/mtr0mtr.h`) contains:

```cpp
struct mtr_t {
  mtr_buf_t  m_memo;      // list of latched pages/blocks (for release on commit)
  mtr_buf_t  m_log;       // accumulated redo log records for this mtr
  bool       m_made_dirty; // did this mtr modify any page?
  lsn_t      m_start_lsn; // LSN at mtr start
  lsn_t      m_end_lsn;   // LSN at mtr commit
  FlushObserver* m_flush_observer;  // for DDL operations
  // ...
};
```

### 3.7.3 mtr Lifecycle

```
  mtr_start(&mtr)
       │
       ├──► Acquire latches on pages (s-latch for read, x-latch for write)
       │    Each latched page is recorded in m_memo
       │
       ├──► Modify pages in buffer pool
       │    For each modification, generate redo log record into m_log
       │    Mark modified pages as dirty (oldest_modification = current LSN)
       │
       └──► mtr_commit(&mtr)
              │
              ├──► Copy all redo records from m_log to the global log buffer
              │    This is ATOMIC — the entire m_log is copied as a single
              │    contiguous block with MLOG_MULTI_REC_END marker
              │
              ├──► Add dirty pages to their buffer pool flush lists
              │
              └──► Release all latches recorded in m_memo (LIFO order)
```

**Key guarantee:** If a crash occurs, either ALL redo records from an mtr are in the
log (and will be replayed), or NONE are. There is no partial mtr in the redo log.
The `MLOG_MULTI_REC_END` marker and the `MLOG_SINGLE_REC_FLAG` bit ensure this.

### 3.7.4 mtr vs User Transaction

| Aspect           | User Transaction (trx_t)      | Mini-Transaction (mtr_t)      |
|------------------|-------------------------------|-------------------------------|
| Visibility       | User-visible (BEGIN/COMMIT)   | Internal to InnoDB            |
| Scope            | Multiple SQL statements       | Single atomic page operation  |
| Atomicity via    | Undo log (rollback)           | Redo log (all-or-nothing)     |
| Concurrency      | MVCC + lock manager           | Latches (no deadlock detect)  |
| Duration         | Milliseconds to hours         | Microseconds                  |
| Nesting          | Contains many mtrs            | Never nested                  |

### 3.7.5 Latching Protocol Within mtr

mtrs acquire latches (not locks) on buffer pool pages. The latching protocol follows
strict ordering rules to prevent internal deadlocks:

1. Latches are always acquired in a predefined order (see Section 3.8).
2. An mtr holds latches for its entire duration — no latch is released until commit.
3. No deadlock detection for latches — the ordering protocol prevents deadlocks.
4. If a page latch cannot be obtained immediately (contention), the thread spins
   briefly, then yields to the OS scheduler.

Source: `storage/innobase/mtr/mtr0mtr.cc` — `mtr_t::commit()`, `mtr_t::start()`.

>>> **Interview Insight**: "What is the difference between a latch and a lock in InnoDB?"
>>> Locks (record locks, table locks) are for user-level concurrency — they protect
>>> logical data (rows) and use deadlock detection. Latches (mutexes, rw-locks) are for
>>> internal concurrency — they protect physical data structures (buffer pool pages,
>>> B+Tree pages) and use a strict ordering protocol (no deadlock detection needed).
>>> Locks can be held for the duration of a transaction. Latches are held only for the
>>> duration of a mini-transaction (microseconds).

---

## 3.8 Latching and Internal Synchronization

### 3.8.1 InnoDB Mutex Implementation

InnoDB implements its own mutex type rather than directly using `pthread_mutex_t`.
The InnoDB mutex (`ib_mutex_t`, historically `os_mutex_t`) adds:

- **Spin-wait optimization:** Before blocking on the OS mutex, the thread spins for
  `innodb_spin_wait_delay` iterations (default 6). If the latch is released during
  the spin, the thread avoids the expensive OS context switch.
- **Spin-wait pause:** Uses the `PAUSE` instruction (x86 `_mm_pause()`) during the spin
  loop to reduce CPU pipeline stalls and power consumption.
- **Performance Schema instrumentation:** Each mutex is registered with Performance
  Schema for wait/contention monitoring.

```
  InnoDB Mutex Acquisition:

  try_lock()  ──► attempt atomic CAS (compare-and-swap)
      │
      ├── success → acquired, return
      │
      └── fail → spin loop (innodb_spin_wait_delay iterations)
              │
              ├── spin success → acquired, return
              │
              └── spin fail → os_event_wait() (OS-level blocking)
                     │
                     └── woken → acquired, return
```

Source: `storage/innobase/sync/sync0sync.cc`, `storage/innobase/include/ib0mutex.h`.

### 3.8.2 Read-Write Locks (rw_lock_t)

InnoDB's `rw_lock_t` allows concurrent shared (S) access and exclusive (X) access.
Used extensively for B+Tree pages (S-latch for readers, X-latch for writers) and
buffer pool page latches.

Additionally, InnoDB supports an **SX-latch** (shared-exclusive) for B+Tree
non-leaf pages:
- SX-latch blocks X-latch acquisition but allows S-latch acquisition.
- Used when modifying a subtree: the parent node gets SX-latch (allowing other
  subtrees to be read) while the target leaf gets X-latch.

```
  Compatibility Matrix:
              Held
  Requested   S     SX    X
  S           OK    OK    WAIT
  SX          OK    WAIT  WAIT
  X           WAIT  WAIT  WAIT
```

Source: `storage/innobase/sync/sync0rw.cc` — `rw_lock_s_lock_func()`, `rw_lock_x_lock_func()`.

### 3.8.3 Latch Ordering Protocol

To prevent internal deadlocks, InnoDB defines a strict latch ordering. A thread
holding latch at level N may only acquire latches at level N+1 or higher.

```
  InnoDB Latch Ordering (partial, from lowest to highest level):

  Level 0:    File system mutexes
  Level 100:  LOG related: log_sys mutex, log_buffer mutex
  Level 200:  REDO: log_writer mutex, log_flusher mutex
  Level 300:  LOCK: lock_sys mutex (sharded in 8.0)
  Level 400:  TRX: trx_sys mutex
  Level 500:  UNDO: rseg mutex, undo page latches
  Level 600:  PURGE: purge_sys mutex
  Level 700:  INDEX: index->lock (rw_lock on B+Tree structure)
  Level 800:  TREE: btr_search_latch (AHI partitions)
  Level 900:  BUFFER: buf_pool mutex, page hash latch
  Level 1000: PAGE: buf_block_t::mutex (individual page latch)
  Level 1100: FIL: fil_system mutex

  Rule: If you hold a latch at level 700, you may only acquire
        latches at level 800, 900, 1000, etc. NEVER level 600.
```

**Debug mode:** InnoDB in debug builds (`-DWITH_DEBUG=ON`) tracks all latches held
by each thread and asserts if the ordering protocol is violated. This is checked by
`sync_check_iterate()` (the latch-level checker).

Source: `storage/innobase/include/sync0types.h` — `latch_level_t` enumeration.

### 3.8.4 Hot Latches — Known Contention Points

These are the latches most likely to appear in `SHOW ENGINE INNODB STATUS` SEMAPHORES
section under heavy load:

```
  Latch                          Cause of Contention           Mitigation
  ─────────────────────────────────────────────────────────────────────────────
  buf_pool->mutex                Buffer pool operations        More BP instances
                                 (page lookup, LRU management)

  log_sys->mutex /               Concurrent redo log writes    8.0 lock-free
  log_buffer mutex               (multiple txns committing)    log buffer

  lock_sys->mutex                Lock table operations         8.0 sharded
  (now lock_sys latches)         (grant/wait/release)          lock system

  trx_sys->mutex                 Transaction ID assignment,    Read-only txns
                                 read view creation            skip trx_sys

  btr_search_latch               Adaptive Hash Index           Disable AHI or
  (now partitioned)              maintenance                   increase parts

  index->lock                    B+Tree structure              SX-latch for
                                 modifications (splits/merges) non-leaf pages

  dict_sys->mutex                Data dictionary lookups       DD cache sizing
```

### 3.8.5 Performance Schema Latch Instrumentation

Monitor latch contention through Performance Schema:

```sql
-- Top 10 mutex waits by total wait time
SELECT event_name,
       count_star AS waits,
       ROUND(sum_timer_wait / 1000000000, 2) AS total_wait_ms,
       ROUND(avg_timer_wait / 1000000000, 4) AS avg_wait_ms
FROM performance_schema.events_waits_summary_global_by_event_name
WHERE event_name LIKE 'wait/synch/mutex/innodb/%'
ORDER BY sum_timer_wait DESC
LIMIT 10;

-- Top rw-lock contention
SELECT event_name,
       count_star AS waits,
       ROUND(sum_timer_wait / 1000000000, 2) AS total_wait_ms
FROM performance_schema.events_waits_summary_global_by_event_name
WHERE event_name LIKE 'wait/synch/rwlock/innodb/%'
ORDER BY sum_timer_wait DESC
LIMIT 10;
```

Also visible in `SHOW ENGINE INNODB STATUS`:
```
----------
SEMAPHORES
----------
OS WAIT ARRAY INFO: reservation count 47421
--Thread 140234567891712 has waited at btr0sea.cc line 1127 for 0.0012 sec
the semaphore: rw-lock 0x7f8a40012c80 created at btr0sea.cc:930
number of readers 0, waiters flag 1, lock_word: -1
Last time write locked in file btr0sea.cc line 1127
```

>>> **Interview Insight**: "How does InnoDB avoid internal deadlocks?"
>>> Through strict latch ordering. Every latch in InnoDB has a defined level number.
>>> A thread must only acquire latches in ascending level order. Since all threads
>>> follow the same ordering, circular waits (the necessary condition for deadlock)
>>> cannot form. This is different from user-level lock deadlock detection (waits-for
>>> graph), which IS needed because user transactions can acquire locks in any order.

---

## 3.9 InnoDB Configuration — The Critical Parameters

### Memory Parameters

```
┌──────────────────────────────────┬──────────┬──────────────┬──────────────────────────────┐
│ Parameter                        │ Default  │ Recommended  │ Why                          │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_buffer_pool_size          │ 128 MB   │ 70-80% RAM   │ Main cache for data+index.   │
│                                  │          │              │ Largest impact on perf.      │
│                                  │          │              │ More = fewer disk reads.     │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_buffer_pool_instances     │ 8 (if    │ 8-16         │ Reduces buffer pool mutex    │
│                                  │ BP>=1GB) │              │ contention. Each instance    │
│                                  │          │              │ ~1 GB minimum.               │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_log_buffer_size           │ 16 MB    │ 64-256 MB    │ Larger = fewer log flushes   │
│                                  │          │              │ during burst writes. Holds   │
│                                  │          │              │ redo records before flush.   │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_change_buffer_max_size    │ 25       │ 25 (HDD),    │ % of buffer pool for change  │
│                                  │          │ 0 (SSD)      │ buffer. SSD: random reads    │
│                                  │          │              │ cheap, disable buffering.    │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_adaptive_hash_index       │ ON       │ OFF (often)  │ AHI lock contention at high  │
│                                  │          │              │ concurrency. Monitor before  │
│                                  │          │              │ disabling.                   │
└──────────────────────────────────┴──────────┴──────────────┴──────────────────────────────┘
```

### I/O Parameters

```
┌──────────────────────────────────┬──────────┬──────────────┬──────────────────────────────┐
│ Parameter                        │ Default  │ Recommended  │ Why                          │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_io_capacity               │ 200      │ 2000-10000   │ I/O ops/sec InnoDB can use   │
│                                  │          │ (SSD)        │ for background tasks (flush, │
│                                  │          │              │ merge). SSD: much higher.    │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_io_capacity_max           │ 2000     │ 2x io_cap    │ Ceiling for urgent flushing. │
│                                  │          │ or device    │ Prevents I/O saturation on   │
│                                  │          │ max IOPS     │ burst.                       │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_flush_method              │ fsync    │ O_DIRECT     │ Bypass OS page cache.        │
│                                  │          │              │ Avoids double-buffering      │
│                                  │          │              │ (buffer pool + page cache).  │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_doublewrite               │ ON       │ ON (HDD),    │ Torn page protection. Can    │
│                                  │          │ OFF (atomic  │ disable on ZFS/atomic-write  │
│                                  │          │ write FS)    │ storage to halve write amp.  │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_read_io_threads           │ 4        │ 4-16         │ Async read threads. More     │
│                                  │          │              │ helps with many concurrent   │
│                                  │          │              │ read-ahead / scan workloads. │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_write_io_threads          │ 4        │ 4-16         │ Async write threads for      │
│                                  │          │              │ dirty page flush I/O.        │
└──────────────────────────────────┴──────────┴──────────────┴──────────────────────────────┘
```

### Logging Parameters

```
┌──────────────────────────────────┬──────────┬──────────────┬──────────────────────────────┐
│ Parameter                        │ Default  │ Recommended  │ Why                          │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_redo_log_capacity         │ 100 MB   │ 1-4 GB       │ Total redo log size (8.0.30) │
│ (or innodb_log_file_size *       │ (2x48MB) │              │ Larger = fewer checkpoints   │
│  innodb_log_files_in_group)      │          │              │ = less furious flushing.     │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_flush_log_at_trx_commit   │ 1        │ 1 (safety),  │ 1 = fsync on every commit    │
│                                  │          │ 2 (speed)    │ (full ACID). 2 = write to    │
│                                  │          │              │ OS cache (1s data loss risk). │
│                                  │          │              │ 0 = flush every sec only.    │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_log_writer_threads        │ ON       │ ON           │ Dedicated log writer (8.0).  │
│                                  │          │              │ Disable only if low          │
│                                  │          │              │ concurrency (< 4 threads).   │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_undo_tablespaces          │ 2        │ 2-4          │ Separate undo from ibdata1.  │
│                                  │          │              │ More = more concurrent       │
│                                  │          │              │ rollback segment access.     │
└──────────────────────────────────┴──────────┴──────────────┴──────────────────────────────┘
```

### Concurrency and Purge Parameters

```
┌──────────────────────────────────┬──────────┬──────────────┬──────────────────────────────┐
│ Parameter                        │ Default  │ Recommended  │ Why                          │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_thread_concurrency        │ 0        │ 0            │ 0 = unlimited. InnoDB's own  │
│                                  │          │              │ ticket system throttles      │
│                                  │          │              │ threads. Only set if > 64    │
│                                  │          │              │ concurrent users on old HW.  │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_purge_threads             │ 4        │ 4-8          │ Parallel undo purge. More    │
│                                  │          │              │ threads if history list > 1M │
│                                  │          │              │ under sustained write load.  │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_page_cleaners             │ 4        │ = BP         │ Dirty page flush threads.    │
│                                  │          │ instances    │ Match buffer pool instances.  │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_max_dirty_pages_pct       │ 90       │ 75-90        │ Target dirty page ratio.     │
│                                  │          │              │ Lower = more aggressive      │
│                                  │          │              │ flushing, smoother I/O but   │
│                                  │          │              │ more total I/O.              │
├──────────────────────────────────┼──────────┼──────────────┼──────────────────────────────┤
│ innodb_max_purge_lag             │ 0        │ 0 or 100000  │ 0 = no throttle. Set to      │
│                                  │          │              │ 100K+ to slow writes when    │
│                                  │          │              │ purge cannot keep up.        │
└──────────────────────────────────┴──────────┴──────────────┴──────────────────────────────┘
```

### Quick-Reference: innodb_flush_log_at_trx_commit Decision Matrix

```
  Value   On COMMIT                          Durability          Performance
  ─────   ──────────────────────────────── ──────────────────── ──────────────
  1       write to OS cache + fsync          Full ACID.           Slowest.
          (redo log guaranteed on disk)      Zero data loss.      1 fsync per
                                                                  commit.

  2       write to OS cache only             Survives mysqld      ~2-3x faster
          (fsync every 1 second by           crash. Loses up      than 1.
          background thread)                 to 1s on OS/power
                                             crash.

  0       write to log buffer only           Loses up to 1s on    Fastest.
          (flush + fsync every 1 second)     ANY crash (even      Rarely used
                                             mysqld crash).       in production.
```

>>> **Interview Insight**: "`innodb_flush_log_at_trx_commit=2` vs `=1` — when is 2 acceptable?"
>>> Value 2 is acceptable on replicas (data can be rebuilt from primary), on systems with
>>> battery-backed write cache (BBWC) where OS crash without fsync still reaches disk,
>>> or when the application tolerates up to 1 second of data loss. In a primary with
>>> financial transactions, always use 1. The performance difference is significant:
>>> value 1 requires one fsync() syscall per commit (or group commit batch), while
>>> value 2 amortizes fsync over many commits (background thread every ~1 second).

---

## 3.10 Putting It All Together — Component Interaction Map

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                      CLIENT SQL STATEMENT                               │
  │              (e.g., UPDATE orders SET amount=100 WHERE id=42)           │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
                                   ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │  SQL LAYER: Parse → Optimize → ha_innobase::update_row()              │
  └────────────────────────────────┬───────────────────────────────────────┘
                                   │
         ┌─────────────────────────┼──────────────────────────────┐
         │                         │                              │
         ▼                         ▼                              ▼
  ┌──────────────┐    ┌───────────────────────┐    ┌──────────────────────┐
  │ TRX SYSTEM   │    │ LOCK SYSTEM           │    │ UNDO SUBSYSTEM       │
  │ Assign trx_id│    │ Acquire X-lock on     │    │ Write undo record    │
  │ Create read  │    │ record (id=42)        │    │ (old row version     │
  │ view         │    │ Check for conflicts   │    │  for rollback/MVCC)  │
  └──────┬───────┘    └───────────────────────┘    └──────────┬───────────┘
         │                                                     │
         ▼                                                     ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  BUFFER POOL                                                         │
  │  ┌─────────────────────────────────────────────────────────────────┐ │
  │  │  Clustered index leaf page (space=42, page=1337):               │ │
  │  │    Locate record id=42                                          │ │
  │  │    mtr_start()                                                  │ │
  │  │      x-latch page                                               │ │
  │  │      modify record in-place (new amount=100)                    │ │
  │  │      set DB_TRX_ID = current trx_id                            │ │
  │  │      set DB_ROLL_PTR → undo record                             │ │
  │  │      generate redo log record → m_log                          │ │
  │  │    mtr_commit() → copy redo to LOG BUFFER, mark page dirty     │ │
  │  └─────────────────────────────────────────────────────────────────┘ │
  │                                                                      │
  │  ┌─────────────────────────────────────────────────────────────────┐ │
  │  │  Secondary index pages: if amount is indexed,                   │ │
  │  │    delete-mark old entry, insert new entry                      │ │
  │  │    (or buffer in CHANGE BUFFER if page not in BP)               │ │
  │  └─────────────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────────────┘
         │
         ▼ On COMMIT:
  ┌──────────────────────────────────────────────────────────────────────┐
  │  LOG BUFFER → Log Writer → OS Buffer → Log Flusher → REDO LOG DISK │
  │  (fsync if innodb_flush_log_at_trx_commit = 1)                      │
  │  Log Flush Notifier → wake committing thread → return OK to client  │
  └──────────────────────────────────────────────────────────────────────┘
         │
         ▼ Later (background):
  ┌──────────────────────────────────────────────────────────────────────┐
  │  PAGE CLEANER THREADS:                                               │
  │    Flush dirty pages → DOUBLEWRITE BUFFER → .ibd tablespace files   │
  │                                                                      │
  │  PURGE THREADS:                                                      │
  │    Clean up undo records when no read view references them           │
  │                                                                      │
  │  LOG CHECKPOINTER:                                                   │
  │    Advance checkpoint_lsn after dirty pages are flushed              │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## 3.11 Key Source Files Reference

For readers who want to trace InnoDB's source code (MySQL 8.0, `storage/innobase/`):

```
  Component              Source Files                           Key Functions
  ─────────────────────────────────────────────────────────────────────────────────
  Buffer Pool            buf/buf0buf.cc, buf/buf0lru.cc         buf_pool_init()
                         buf/buf0flu.cc                          buf_page_get_gen()
                                                                 buf_flush_batch()

  Change Buffer          ibuf/ibuf0ibuf.cc                      ibuf_insert()
                                                                 ibuf_merge_or_delete_for_page()

  Adaptive Hash Index    btr/btr0sea.cc                         btr_search_guess_on_hash()

  Log Buffer / WAL       log/log0buf.cc, log/log0write.cc       log_buffer_reserve()
                         log/log0log.cc, log/log0recv.cc        log_writer(), log_flusher()

  Mini-Transactions      mtr/mtr0mtr.cc                         mtr_t::start()
                         include/mtr0mtr.h                       mtr_t::commit()

  Lock System            lock/lock0lock.cc                      lock_rec_lock()
                                                                 lock_deadlock_check()

  Transaction System     trx/trx0trx.cc, trx/trx0sys.cc        trx_start_low()
                                                                 trx_commit_in_memory()

  Undo / Purge           trx/trx0undo.cc, trx/trx0purge.cc     trx_undo_report_row_operation()
                         trx/trx0rseg.cc                        trx_purge()

  B+Tree Operations      btr/btr0btr.cc, btr/btr0cur.cc        btr_cur_search_to_nth_level()
                         btr/btr0pcur.cc                         btr_page_split_and_insert()

  File Space Mgmt        fsp/fsp0fsp.cc, fsp/fsp0file.cc       fsp_alloc_free_page()
                                                                 fsp_alloc_free_extent()

  Doublewrite            buf/buf0dblwr.cc                       buf_dblwr_write_single_page()

  Data Dictionary        dict/dict0dict.cc, dict/dict0mem.cc    dict_table_open_on_name()

  Tablespace I/O         fil/fil0fil.cc, os/os0file.cc          fil_io(), os_aio_func()

  Server/Master Thread   srv/srv0srv.cc                         srv_master_thread()
```

---

## 3.12 Summary — InnoDB as a Systems Diagram

InnoDB is a complete embedded database engine with its own buffer management, logging,
concurrency control, and I/O subsystem. The key architectural principles:

1. **WAL protocol:** Redo log hits disk before data pages. This decouples commit
   latency from data page flush latency.

2. **Buffer pool centrality:** Everything flows through the buffer pool. Pages are
   modified only in memory; background threads handle persistence.

3. **Mini-transaction atomicity:** Every internal operation (page split, index insert,
   undo record write) is wrapped in an mtr that guarantees atomic redo log records.

4. **Deferred work:** Change buffer defers secondary index I/O. Purge defers dead row
   cleanup. Page cleaners defer data page writes. This amortization is what makes
   InnoDB fast on spinning disks and efficient on SSDs.

5. **Latch ordering over deadlock detection:** Internal synchronization uses a strict
   ordering protocol — simpler, faster, and provably correct.

6. **Background thread specialization (8.0):** Dedicated threads for log writing,
   flushing, checkpointing, purging, and page cleaning — each can be tuned independently.

>>> **Interview Insight**: "Explain InnoDB's architecture in 60 seconds."
>>> InnoDB is an index-organized storage engine centered on a buffer pool that caches
>>> 16 KB pages. All modifications happen in memory and are recorded in a redo log
>>> (WAL) before commit. The redo log ensures durability — dirty data pages are flushed
>>> asynchronously by page cleaner threads through a doublewrite buffer for torn-page
>>> protection. MVCC is implemented via undo logs stored in separate tablespaces: old
>>> row versions are maintained for consistent reads and cleaned up by purge threads.
>>> Secondary index updates can be deferred via the change buffer to avoid random I/O.
>>> An adaptive hash index optionally accelerates point lookups on hot B+Tree pages.
>>> Internal atomicity uses mini-transactions (mtrs); internal synchronization uses a
>>> strict latch ordering protocol. The entire system is tuned through ~20 key
>>> parameters governing memory allocation, I/O capacity, and flush behavior.

---

*Next: [Chapter 4 — Buffer Pool Deep Dive](04-buffer-pool-deep-dive.md) takes us inside
InnoDB's most critical in-memory structure: the LRU algorithm, page hash, free list
management, buffer pool resizing, dump/restore, and the adaptive flushing algorithm
that prevents checkpoint stalls.*
