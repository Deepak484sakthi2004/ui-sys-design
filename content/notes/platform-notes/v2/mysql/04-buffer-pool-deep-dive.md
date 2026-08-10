# Chapter 4: Buffer Pool Deep Dive — How InnoDB Manages 128 GB of RAM Without Thrashing

> The buffer pool is InnoDB's central nervous system. Every row read, every index
> traversal, every undo lookup, every secondary index change flows through this
> single memory arena. Get it wrong and a 128 GB server performs worse than a
> 16 GB one. This chapter takes you inside the data structures, algorithms, and
> source code paths that make InnoDB's buffer pool one of the most battle-tested
> memory management subsystems in production databases.

---

## 4.1 Buffer Pool Fundamentals

### 4.1.1 What Lives in the Buffer Pool

The buffer pool is not merely a "page cache." It hosts six distinct categories
of data, each competing for the same finite memory:

```
+----------------------------------------------------------------------+
|                         BUFFER POOL (128 GB)                         |
|                                                                      |
|  +-------------------+  +-------------------+  +-----------------+  |
|  |   DATA PAGES      |  |   INDEX PAGES     |  |   UNDO PAGES    |  |
|  | (clustered index  |  | (secondary index  |  | (old row         |  |
|  |  leaf + non-leaf) |  |  leaf + non-leaf) |  |  versions for    |  |
|  |                   |  |                   |  |  MVCC)           |  |
|  +-------------------+  +-------------------+  +-----------------+  |
|                                                                      |
|  +-------------------+  +-------------------+  +-----------------+  |
|  | CHANGE BUFFER     |  | ADAPTIVE HASH     |  |  SYSTEM PAGES   |  |
|  | (deferred sec.    |  |   INDEX (AHI)     |  | (insert buffer  |  |
|  |  index writes)    |  | (hash index on    |  |  bitmap, FSP    |  |
|  |                   |  |  hot B+Tree pages)|  |  header, etc.)  |  |
|  +-------------------+  +-------------------+  +-----------------+  |
+----------------------------------------------------------------------+
```

| Category | Description | Typical Share |
|----------|-------------|---------------|
| Data pages | Clustered index (primary key) leaf and internal nodes | 50-70% |
| Index pages | Secondary index leaf and internal nodes | 15-30% |
| Undo pages | Old row versions in undo tablespace, cached for MVCC reads | 2-10% |
| Change buffer pages | B-Tree in system tablespace buffering secondary index writes | 0-25% (configurable) |
| Adaptive hash index | In-memory hash table for hot B+Tree lookups | 0-10% |
| System pages | File space management, insert buffer bitmap, etc. | <1% |

### 4.1.2 Page Size

Every buffer pool frame holds exactly one InnoDB page. The page size is set at
instance initialization and cannot be changed afterward.

```
innodb_page_size = 16384   -- default: 16 KB
                           -- valid: 4096, 8192, 16384, 32768, 65536
```

| Page Size | Pros | Cons |
|-----------|------|------|
| 4 KB | Matches OS page size, less wasted space for small rows | More B+Tree levels, more page splits |
| 8 KB | Good for OLTP with small rows (< 200 bytes) | Slightly deeper trees than 16 KB |
| 16 KB (default) | Best all-around balance, matches InnoDB's internal assumptions | May waste space for very small rows |
| 32 KB | Fewer B+Tree levels for wide rows | Higher I/O amplification, more lock contention per page |
| 64 KB | Minimum B+Tree depth for analytical workloads | 64 KB atomic writes are harder to guarantee, wastes buffer pool |

>>> **Interview insight**: "Why is 16 KB the default and not 4 KB like the OS page size?"
>>> InnoDB batches multiple row operations per page. A 16 KB page holds ~100-500 rows
>>> depending on row width. Larger pages mean fewer B+Tree levels (3 levels can index
>>> ~2 billion rows at 16 KB). The trade-off is I/O amplification -- reading one row
>>> requires fetching 16 KB. For OLTP workloads where the working set fits in the buffer
>>> pool, this is irrelevant because the page is already in memory.

### 4.1.3 Buffer Pool Sizing

```
innodb_buffer_pool_size = 107374182400   -- 100 GB (out of 128 GB total RAM)
```

**Rule of thumb**: 70-80% of available RAM on a dedicated MySQL server.

Why not 90-95%? InnoDB is not the only consumer of memory:

```
Total Server RAM = 128 GB

  innodb_buffer_pool_size ........... 100 GB  (78%)
  OS page cache (for redo log, 
    binlog, doublewrite) ............   8 GB  (6%)
  Per-connection memory 
    (sort_buffer, join_buffer,
     read_buffer, tmp tables) .......   8 GB  (6%) -- 500 connections * 16 MB peak
  InnoDB internal structures
    (lock system, dict cache, 
     AHI overhead, trx system) ......   4 GB  (3%)
  OS + kernel + monitoring ..........   4 GB  (3%)
  MySQL metadata, PS, I_S ...........   4 GB  (3%)
```

>>> **Interview insight**: A common production mistake is setting `innodb_buffer_pool_size`
>>> to 90%+ of RAM. Under load, `sort_buffer_size * max_connections` plus temp tables
>>> push the process into swap. The OOM killer terminates mysqld. Always account for
>>> per-connection memory at peak concurrency.

### 4.1.4 Buffer Pool Instances

```
innodb_buffer_pool_instances = 16   -- one per ~6-8 GB of buffer pool
```

Each instance is a **completely independent** buffer pool with its own:
- LRU list
- Free list
- Flush list
- Page hash table
- Mutex (`buf_pool->mutex`)

Pages are assigned to instances via a hash: `instance = hash(space_id, page_no) % num_instances`.

```
+------------------------------------------------------------------+
|                     BUFFER POOL (100 GB)                         |
|                                                                  |
|  Instance 0    Instance 1    Instance 2   ...   Instance 15      |
|  +----------+  +----------+  +----------+      +----------+     |
|  | LRU list |  | LRU list |  | LRU list |      | LRU list |     |
|  | Free list|  | Free list|  | Free list|      | Free list|     |
|  | Flush lst|  | Flush lst|  | Flush lst|      | Flush lst|     |
|  | Page hash|  | Page hash|  | Page hash|      | Page hash|     |
|  | Mutex    |  | Mutex    |  | Mutex    |      | Mutex    |     |
|  | ~6.25 GB |  | ~6.25 GB |  | ~6.25 GB |      | ~6.25 GB |     |
|  +----------+  +----------+  +----------+      +----------+     |
+------------------------------------------------------------------+
```

**Why instances matter**: In MySQL 5.5, a single buffer pool mutex serialized all
page lookups, evictions, and flushes. With 64 cores hammering concurrent queries,
that mutex became the bottleneck. Splitting into N instances lets N threads operate
on different instances concurrently.

**Source**: `buf/buf0buf.cc:buf_pool_init()` allocates `srv_buf_pool_instances`
separate `buf_pool_t` structs.

**Sizing heuristic**: If `innodb_buffer_pool_size` < 1 GB, MySQL forces instances = 1.
For larger pools, MySQL 8.0 defaults to 1 instance per GB but caps at the configured
value. Common production value: 8-32 instances.

### 4.1.5 Chunk Size and Online Resize

```
innodb_buffer_pool_chunk_size = 134217728   -- 128 MB (default)
```

The buffer pool is allocated in **chunks**. Each chunk is a contiguous block of
`innodb_buffer_pool_chunk_size` bytes, containing:
- An array of `buf_block_t` control structures
- An array of 16 KB frames (the actual page memory)

```
  One Chunk (128 MB)
  +-------------------------------------------------------------+
  | Control Blocks (buf_block_t array)                          |
  | [block0][block1][block2]...[blockN]                         |
  | Each block: ~300 bytes overhead (pointers, state, latch)    |
  +-------------------------------------------------------------+
  | Page Frames (16 KB each)                                    |
  | [frame0 16KB][frame1 16KB][frame2 16KB]...[frameN 16KB]     |
  +-------------------------------------------------------------+
  
  N = chunk_size / page_size = 128 MB / 16 KB = 8192 pages per chunk
```

**Online resize** (MySQL 5.7+): You can change `innodb_buffer_pool_size` at
runtime without restarting mysqld:

```sql
SET GLOBAL innodb_buffer_pool_size = 120 * 1024 * 1024 * 1024;  -- grow to 120 GB
```

The resize operation:
1. Calculates new number of chunks needed
2. **Growing**: allocates new chunks, adds their blocks to the free list
3. **Shrinking**: withdraws pages from the tail of the LRU list, frees chunks
4. The operation is performed in the background by `buf_resize_thread`
5. Progress is logged to the error log

**Constraint**: `innodb_buffer_pool_size` must be a multiple of
`innodb_buffer_pool_chunk_size * innodb_buffer_pool_instances`. If not, MySQL
rounds up to the next valid multiple.

```
Example: chunk_size = 128 MB, instances = 16
  Minimum granularity = 128 MB * 16 = 2 GB
  You can resize in 2 GB increments: 98 GB → 100 GB → 102 GB
```

---

## 4.2 Internal Data Structures

This section maps the C structures and linked lists that form the buffer pool's
internal machinery. Understanding these is essential for reading `SHOW ENGINE
INNODB STATUS` and diagnosing buffer pool pathologies.

### 4.2.1 The buf_pool_t Structure

Each buffer pool instance is represented by a `buf_pool_t` struct
(`include/buf0buf.h`). Simplified layout:

```
buf_pool_t (one per instance)
+------------------------------------------------------------------+
| mutex                    -- protects LRU, free list, page hash   |
| flush_list_mutex         -- protects flush list (separate lock)  |
|                                                                  |
| chunks[]                 -- array of buf_chunk_t (memory chunks) |
| n_chunks                 -- number of allocated chunks           |
|                                                                  |
| page_hash                -- hash table: (space_id,page_no)→page  |
|                                                                  |
| free         (UT_LIST)   -- list of free buf_block_t             |
| LRU          (UT_LIST)   -- LRU list (young + old)               |
| flush_list   (UT_LIST)   -- dirty pages sorted by oldest_mod LSN |
| unzip_LRU    (UT_LIST)   -- decompressed pages for compressed    |
|                             tables                               |
|                                                                  |
| old_list_len             -- number of pages in old sublist       |
| LRU_old                  -- pointer to first page in old sublist |
|                                                                  |
| stat                     -- hit/miss/read-ahead counters         |
| freed_page_clock         -- approximate clock for LRU heuristics |
+------------------------------------------------------------------+
```

### 4.2.2 buf_page_t and buf_block_t

Every page tracked by the buffer pool has a control structure. There are two levels:

```
buf_page_t (lightweight descriptor)
+------------------------------------------+
| space          (uint32)  -- tablespace ID |
| offset         (uint32)  -- page number   |
| state          (enum)    -- page state    |
| buf_fix_count  (uint32)  -- pin count     |
| io_fix         (enum)    -- I/O state     |
| oldest_modification (lsn_t) -- dirty LSN  |
| newest_modification (lsn_t) -- latest LSN |
| list node (LRU)          -- LRU position  |
| list node (flush_list)   -- flush list    |
| hash node                -- page hash     |
+------------------------------------------+

buf_block_t (full page block -- extends buf_page_t)
+------------------------------------------+
| buf_page_t    page       -- embedded      |
| frame         (byte*)   -- ptr to 16 KB   |
|                            page data      |
| lock          (rw_lock_t) -- page latch   |
|                (S for read, X for write)  |
| modify_clock  (uint64)  -- optimistic     |
|                            latch version  |
| n_hash_helps  (uint32)  -- AHI build aid  |
+------------------------------------------+
```

**Key distinction**: `buf_page_t` is used for compressed pages that are stored in
their compressed form only (no decompressed frame). `buf_block_t` includes the
actual 16 KB frame pointer and the page-level rw-lock. For uncompressed pages
(the common case), InnoDB always uses `buf_block_t`.

**Page states** (from `buf0buf.h`):

```
BUF_BLOCK_NOT_USED       -- in free list, no page loaded
BUF_BLOCK_FILE_PAGE      -- a normal file page in the buffer pool
BUF_BLOCK_MEMORY         -- used for internal InnoDB memory (e.g., lock system)
BUF_BLOCK_REMOVE_HASH    -- being removed from page hash
BUF_BLOCK_ZIP_PAGE       -- compressed page, no decompressed frame
BUF_BLOCK_ZIP_DIRTY      -- compressed dirty page
```

**io_fix states**:

```
BUF_IO_NONE     -- no pending I/O
BUF_IO_READ     -- async read in progress
BUF_IO_WRITE    -- being flushed to disk
BUF_IO_PIN      -- pinned for other internal operations
```

### 4.2.3 Page Hash Table

The page hash provides O(1) lookup of any cached page given its `(space_id, page_no)` pair.

```
  Query arrives: SELECT * FROM orders WHERE id = 42
  
  InnoDB needs page (space=5, page_no=1037)
  
  Step 1: Determine buffer pool instance
    instance_no = ut_fold_ulint_pair(5, 1037) % n_instances
    
  Step 2: Hash lookup within instance
    fold = ut_fold_ulint_pair(space_id, page_no)
    bucket = fold % page_hash->n_cells
    
  +----+----+----+----+----+----+----+----+----+----+
  |  0 |  1 |  2 | .. | bucket | .. |    |    | N  |
  +----+----+----+----+----+----+----+----+----+----+
                        |
                        v
                  +------------+     +------------+
                  | space=5    |---->| space=12   |
                  | page=1037  |     | page=455   | (collision chain)
                  | →buf_page_t|     | →buf_page_t|
                  +------------+     +------------+
```

**Source**: `buf/buf0buf.cc:buf_page_hash_get_low()`.

The hash table uses **chaining** for collision resolution. In MySQL 8.0, the page
hash uses partitioned rw-locks (one lock per `n_cells / 16` buckets) to allow
concurrent reads. This replaced the single `buf_pool->mutex` protection from
earlier versions.

```
Page Hash Table (per instance for 6.25 GB, ~400K pages)
+------------------------------------------------------------+
| n_cells = next_prime(2 * n_pages) ≈ 800K buckets           |
| Load factor ≈ 0.5 (low collision rate)                     |
| Each bucket: pointer to singly-linked list of buf_page_t   |
| Latch: partitioned rw-lock (16 partitions)                 |
+------------------------------------------------------------+
```

### 4.2.4 Free List

The free list is a doubly-linked list of `buf_block_t` entries that have
`state = BUF_BLOCK_NOT_USED`. These blocks have allocated frames (16 KB memory)
but no page loaded into them.

```
Free List
  HEAD                                              TAIL
  +----------+    +----------+    +----------+    +----------+
  | block    |--->| block    |--->| block    |--->| block    |
  | state:   |    | state:   |    | state:   |    | state:   |
  | NOT_USED |    | NOT_USED |    | NOT_USED |    | NOT_USED |
  | frame:   |    | frame:   |    | frame:   |    | frame:   |
  | [16KB]   |    | [16KB]   |    | [16KB]   |    | [16KB]   |
  +----------+    +----------+    +----------+    +----------+

  Operations:
    Page read miss → remove block from HEAD of free list
    Page eviction  → return block to TAIL of free list
```

At startup, all blocks are on the free list. As pages are read from disk,
blocks move from the free list to the LRU list. Under steady-state operation
of a properly sized buffer pool, the free list is often empty or nearly empty
-- all frames are occupied by cached pages.

**When free list is empty**: a page read must evict a page from the LRU tail
before it can proceed. If the LRU tail page is dirty, it must be flushed first.
This is the single most common cause of stalls in an undersized buffer pool.

### 4.2.5 LRU List

The LRU list is the heart of buffer pool management. Every page currently cached
(state = `BUF_BLOCK_FILE_PAGE`) is on this list. The list is split into two sublists
at a configurable midpoint. Full details in Section 4.3.

### 4.2.6 Flush List

The flush list contains **only dirty pages** -- pages that have been modified in
memory but not yet written to their tablespace file on disk. Pages are ordered
by `oldest_modification` LSN (the LSN of the first modification since the page
was last clean).

```
Flush List (sorted by oldest_modification LSN, ascending)
  HEAD (oldest dirty page)                      TAIL (newest dirty page)
  +----------+    +----------+    +----------+    +----------+
  | page A   |--->| page C   |--->| page F   |--->| page Q   |
  | old_mod: |    | old_mod: |    | old_mod: |    | old_mod: |
  | LSN 1000 |    | LSN 2500 |    | LSN 5100 |    | LSN 9800 |
  | new_mod: |    | new_mod: |    | new_mod: |    | new_mod: |
  | LSN 9500 |    | LSN 4200 |    | LSN 8700 |    | LSN 9800 |
  +----------+    +----------+    +----------+    +----------+
  
  oldest_modification: LSN when page was FIRST dirtied (after last flush)
  newest_modification: LSN of MOST RECENT modification
  
  Invariant: pages are ordered by oldest_modification
             (not newest_modification)
```

**Why order by oldest_modification?** This ordering is critical for checkpoint
advancement. The checkpoint LSN can advance to the `oldest_modification` of the
head of the flush list. Flushing the oldest-dirty page first allows the
checkpoint to move forward, which in turn allows redo log space to be reclaimed.

**Source**: `buf/buf0flu.cc:buf_flush_insert_into_flush_list()` -- inserts at the
tail (newest). `buf_flush_remove()` removes after writing to disk.

**Interaction with the LRU list**: A dirty page appears on BOTH the LRU list and
the flush list simultaneously. The LRU list tracks recency of access; the flush
list tracks dirtiness. A page can be evicted from the LRU list only after it has
been flushed (removed from the flush list).

```
  Page lifecycle on both lists:
  
  Read from disk    → on LRU only (clean)
  Modified          → on LRU + flush list (dirty)
  Flushed to disk   → on LRU only (clean again)
  Evicted           → removed from LRU, returned to free list
  
  A dirty page CANNOT be evicted. It must be flushed first.
```

>>> **Interview insight**: "What is the relationship between the flush list and the
>>> redo log?" The flush list determines how fast the checkpoint can advance. If
>>> dirty pages with old LSNs linger in the buffer pool, the checkpoint stalls,
>>> and redo log space cannot be reused. This is why adaptive flushing targets the
>>> oldest dirty pages first -- it is not about I/O efficiency, it is about
>>> unlocking redo log space.

---

## 4.3 LRU Algorithm -- Midpoint Insertion Strategy

### 4.3.1 Why Standard LRU Fails for Databases

A naive LRU eviction policy works well for general-purpose caches. For a database,
it is catastrophic. Consider this scenario:

```
Buffer pool: 100,000 pages (hot OLTP working set)
Query: SELECT * FROM audit_log  -- full table scan, 5 million pages

Standard LRU:
  - Scan reads 5M pages, each goes to HEAD of LRU
  - All 100K hot OLTP pages are evicted
  - Scan finishes; those 5M pages are never touched again
  - OLTP queries now hit disk for every page
  - Buffer pool hit rate drops from 99.9% to 0%
  - Recovery takes hours as working set is re-cached
  
Result: One analyst's query destroys production OLTP performance.
```

This is called **sequential scan pollution** (also: **cache flooding**). Every
major database engine has a defense against it. InnoDB's solution is the
**midpoint insertion strategy**.

### 4.3.2 The Two-Sublist Architecture

```
LRU List with Midpoint Insertion
                                                                    
 ACCESS FREQUENCY HIGH ◄─────────────────────────────► ACCESS FREQUENCY LOW

 ┌─────────────────────────────────────┬────────────────────────────┐
 │          YOUNG SUBLIST              │       OLD SUBLIST          │
 │         (hot/new pages)             │      (cold pages)         │
 │                                     │                           │
 │  HEAD                               │                      TAIL │
 │  ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐    │  ┌───┐ ┌───┐ ┌───┐ ┌───┐│
 │  │ P │→│ Q │→│ R │→│ S │→│ T │→ ──│──│ U │→│ V │→│ W │→│ X ││
 │  │hot│ │   │ │   │ │   │ │   │    │  │old│ │   │ │   │ │LRU││
 │  └───┘ └───┘ └───┘ └───┘ └───┘    │  └───┘ └───┘ └───┘ └───┘│
 │                                     │  ▲                       │
 │  ◄──── ~63% of buffer pool ────►   │  │ midpoint              │
 │  (innodb_old_blocks_pct = 37       │  │ New pages from disk   │
 │   means 37% is old, 63% is young)  │  │ are inserted HERE     │
 └─────────────────────────────────────┴──┼───────────────────────┘
                                          │
                                    Midpoint insertion point
```

**Configuration**:

```
innodb_old_blocks_pct = 37       -- 37% old, 63% young (default)
                                 -- range: 5 to 95
innodb_old_blocks_time = 1000    -- promotion delay in milliseconds (default)
                                 -- range: 0 to 2^32-1
```

### 4.3.3 Page Insertion and Promotion Rules

**Rule 1: New pages always enter at the midpoint (head of old sublist)**

When a page is read from disk (cache miss), it is inserted at the midpoint --
NOT at the head of the LRU list. This is the key defense against scan pollution.

```
  Page read from disk → inserted at OLD sublist HEAD
  
  Before:
  YOUNG: [P]→[Q]→[R]→[S]→[T] | OLD: [U]→[V]→[W]→[X]
  
  After inserting page Z:
  YOUNG: [P]→[Q]→[R]→[S]→[T] | OLD: [Z]→[U]→[V]→[W]→[X]
                                       ▲
                                   new page here
  
  X is evicted if free list is empty and LRU tail page is clean.
```

**Rule 2: Promotion to young sublist requires a second access after the delay**

A page in the old sublist is promoted to the HEAD of the young sublist only if:
1. It is accessed again (a "hit" on an old-sublist page)
2. At least `innodb_old_blocks_time` milliseconds have elapsed since insertion

```
  Page Z is in old sublist (inserted at time T0)
  
  Access at T0 + 500ms:  innodb_old_blocks_time = 1000ms
    → 500ms < 1000ms → NOT promoted, stays in old sublist
    
  Access at T0 + 1200ms:
    → 1200ms > 1000ms → PROMOTED to HEAD of young sublist
    
  After promotion:
  YOUNG: [Z]→[P]→[Q]→[R]→[S]→[T] | OLD: [U]→[V]→[W]
          ▲
     promoted here
```

**Rule 3: The 1/4 optimization for the young sublist**

To reduce list manipulation overhead, pages in the first **1/4** of the young
sublist are NOT moved to the head on access. Only pages in the bottom 3/4 of
the young sublist are moved to the head when accessed.

```
  YOUNG SUBLIST:
  ┌──────────────┬─────────────────────────────────┐
  │  First 1/4   │  Remaining 3/4                  │
  │ (no-move     │ (moved to head on access)       │
  │  zone)       │                                  │
  ├──────────────┼─────────────────────────────────┤
  │ [P][Q][R]    │ [S][T][U][V][W][X][Y]           │
  └──────────────┴─────────────────────────────────┘
  
  Access page P → no movement (already in top 1/4)
  Access page T → move T to head of young sublist
```

**Source**: `buf/buf0lru.cc:buf_page_peek_if_young()` checks whether a page is in
the first 1/4 by comparing `buf_pool->freed_page_clock` with the page's
`freed_page_clock` value.

### 4.3.4 How Scan Resistance Works

Let us trace a full table scan through this machinery:

```
Scenario: 500K-page OLTP working set in buffer pool (mostly young sublist)
           DBA runs: SELECT COUNT(*) FROM large_table  (10M pages)

Step 1: Scan begins. Pages are read from disk.
        Each new page → inserted at OLD sublist head
        
Step 2: The scan reads each page once and moves on.
        Access pattern: read page, process, never touch again.
        Time between first and only access = 0ms.
        
Step 3: Since pages are only accessed once, they NEVER satisfy the
        promotion criteria (no second access, and no time delay passed).
        They remain in the old sublist.
        
Step 4: As new scan pages enter the old sublist head, old scan pages
        fall off the old sublist tail and are evicted.
        
Step 5: The young sublist is UNTOUCHED. Hot OLTP pages remain cached.
        
Result: 10M-page scan cycles through only the old sublist (~37% of
        buffer pool), while 63% of the pool (young sublist) is protected.
```

```
During full table scan:

YOUNG (protected):                    OLD (absorbs scan):
┌──────────────────────┐    ┌──────────────────────────────┐
│ Hot OLTP pages       │    │ scan scan scan scan scan ... │
│ (500K pages,         │    │ ← new scan pages enter here  │
│  undisturbed)        │    │                 evicted here →│
│                      │    │                               │
│ These pages are      │    │ Pages cycle through old       │
│ NEVER evicted by     │    │ sublist and fall off tail     │
│ the scan             │    │ without ever reaching young   │
└──────────────────────┘    └──────────────────────────────┘
```

>>> **Interview insight**: "How does InnoDB protect its buffer pool from full table
>>> scans?" Answer in three parts: (1) midpoint insertion -- new pages go to old
>>> sublist, not head, (2) promotion delay -- `innodb_old_blocks_time` prevents
>>> scan pages from being promoted since they are accessed only once in quick
>>> succession, (3) eviction from old tail -- scan pages push each other out of
>>> the old sublist without affecting the young sublist. This is why a careless
>>> `SELECT *` on a 100 GB table does not destroy production performance.

### 4.3.5 Comparison with Other Database Engines

| Engine | Algorithm | Scan Resistance Mechanism |
|--------|-----------|--------------------------|
| **InnoDB** | Midpoint insertion LRU | Young/old split, promotion delay timer |
| **PostgreSQL** | Clock-sweep | Circular buffer with usage_count (0-5). Pages start at 5, decremented on sweep. Evicted at 0. Large scans use a small shared ring buffer (256 KB) instead of main pool. |
| **Oracle** | Touch-count LRU | Hot/cold ends. Pages need 2+ touches within a time window to move to hot end. Full scans use direct path read (bypass buffer cache entirely). |
| **SQL Server** | Clock algorithm | BPOOL with clock-based eviction. Large scans may bypass buffer pool or use a separate "lazy writer" to manage pressure. |

**Key difference**: PostgreSQL's approach for large sequential scans is arguably
more aggressive -- it routes them through a tiny ring buffer that never touches
the main shared buffers at all. InnoDB allows scans to use the old sublist (37%
of the pool), which is more memory but simpler to implement. Oracle's direct path
reads bypass the buffer cache entirely for full scans, which is the most aggressive
isolation but requires the optimizer to make the right call.

---

## 4.4 Page Lifecycle -- From Disk to Eviction

### 4.4.1 Page Read Path (Cache Miss)

This is the complete sequence when InnoDB needs a page that is not in the buffer pool.

```
Thread: user query needs page (space_id=5, page_no=1037)

  ┌─────────────────────────────────────────────────────────┐
  │ 1. HASH LOOKUP                                          │
  │    buf_page_hash_get_low(space=5, page=1037)            │
  │    → miss (page not in buffer pool)                     │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 2. ALLOCATE FRAME                                       │
  │    Try free list first:                                  │
  │      buf_LRU_get_free_block()                           │
  │        → if free list non-empty: take block from head   │
  │        → if free list empty:                            │
  │            scan LRU tail for clean, unpinned page       │
  │            buf_LRU_free_page() → evict, return to free  │
  │            if no clean page at tail:                    │
  │              buf_flush_single_page_from_LRU()           │
  │              → synchronous flush of LRU tail page       │
  │              → THIS IS THE STALL PATH                   │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 3. SUBMIT ASYNC I/O                                     │
  │    fil_io(OS_FILE_READ, space=5, page=1037, frame)      │
  │    Set io_fix = BUF_IO_READ                              │
  │    Set state  = BUF_BLOCK_FILE_PAGE                      │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 4. INSERT INTO PAGE HASH                                │
  │    buf_page_hash_insert(space=5, page=1037, block)      │
  │    → future lookups will find this page                  │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 5. INSERT INTO LRU AT MIDPOINT                          │
  │    buf_LRU_add_block(block, TRUE)                       │
  │    → TRUE = add to OLD sublist head                      │
  │    Set block->old = TRUE                                 │
  │    Set block->access_time = current_time                 │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 6. I/O COMPLETION                                       │
  │    buf_page_io_complete(block)                          │
  │    Set io_fix = BUF_IO_NONE                              │
  │    Verify checksum (CRC32 or innodb for page corruption)│
  │    If page is corrupted → force crash or error log      │
  │    Page is now available for use                         │
  └─────────────────────────────────────────────────────────┘
```

**Source path**: `buf/buf0buf.cc:buf_page_get_gen()` is the main entry point for
all page accesses. It checks the page hash, handles cache misses via
`buf_read_page()`, and manages latching.

### 4.4.2 Page Modification Path

Once a page is in the buffer pool, modifying it follows a strict protocol
to ensure crash recovery is possible.

```
Thread: UPDATE orders SET status='shipped' WHERE id=42
        Page (space=5, page=1037) is already in buffer pool

  ┌─────────────────────────────────────────────────────────┐
  │ 1. PIN PAGE                                             │
  │    Increment buf_fix_count (atomic)                     │
  │    → prevents eviction while we hold a reference        │
  │    A pinned page CANNOT be evicted from the LRU list    │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 2. ACQUIRE PAGE LATCH                                   │
  │    rw_lock_x_lock(block->lock)  (exclusive for write)   │
  │    or                                                   │
  │    rw_lock_s_lock(block->lock)  (shared for read)       │
  │                                                         │
  │    NOTE: Page latch ≠ row lock ≠ table lock             │
  │    Page latch is a physical concurrency control on the  │
  │    16 KB memory frame. It is held for microseconds.     │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 3. START MINI-TRANSACTION (mtr)                         │
  │    mtr_t mtr;                                           │
  │    mtr.start();                                         │
  │    Record redo log entries for this modification:       │
  │      MLOG_REC_UPDATE_IN_PLACE or                       │
  │      MLOG_COMP_REC_UPDATE_IN_PLACE                     │
  │    These go into the mtr's local log buffer first       │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 4. MODIFY PAGE IN MEMORY                                │
  │    Update the row data in the 16 KB frame               │
  │    Update page directory, record offsets as needed      │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 5. MARK PAGE DIRTY                                      │
  │    If page.oldest_modification == 0:                     │
  │      → page was clean, set oldest_modification = mtr.lsn│
  │      → add page to flush list                           │
  │    Set newest_modification = mtr.lsn                     │
  │    (always updated, even if page was already dirty)     │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 6. ADD TO FLUSH LIST (if newly dirty)                   │
  │    buf_flush_insert_into_flush_list(block)              │
  │    → inserted at TAIL (newest oldest_modification)      │
  │    Protected by flush_list_mutex                        │
  └──────────────────────┬──────────────────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────────────────┐
  │ 7. COMMIT MTR                                           │
  │    mtr.commit()                                         │
  │    → copies mtr's redo log entries to the global        │
  │      redo log buffer (log_buffer_reserve_and_write)     │
  │    → releases page latch                                │
  │    → decrements buf_fix_count (unpin)                   │
  └─────────────────────────────────────────────────────────┘
```

**Critical observation**: The page is modified in memory BEFORE the redo log is
written to disk. The redo log is written to the log buffer during `mtr.commit()`,
and it is flushed to disk by the log writer thread asynchronously (or
synchronously at `COMMIT` time depending on `innodb_flush_log_at_trx_commit`).
The WAL (Write-Ahead Logging) guarantee is maintained because the redo log entry
is always written to the log buffer before the dirty page can be flushed to disk.

### 4.4.3 Page Eviction Path

```
  Page eviction (LRU replacement):
  
  ┌─────────────────────────────────────────────────────────┐
  │ Scan LRU list from TAIL                                 │
  │ For each page:                                          │
  │   Is buf_fix_count == 0? (not pinned)                   │
  │   Is io_fix == BUF_IO_NONE? (no pending I/O)            │
  │   Is it clean? (oldest_modification == 0)               │
  │                                                         │
  │   YES to all three → evict this page                    │
  │     1. Remove from page hash                            │
  │     2. Remove from LRU list                             │
  │     3. Set state = BUF_BLOCK_NOT_USED                   │
  │     4. Add to free list                                 │
  │                                                         │
  │   NO (dirty, pinned, or I/O in progress) → skip,       │
  │       continue scanning toward head                     │
  └─────────────────────────────────────────────────────────┘
```

>>> **Interview insight**: "What happens when the buffer pool has no free pages and
>>> all LRU tail pages are dirty?" This is the worst-case scenario. InnoDB must
>>> perform a **synchronous single-page flush** -- it picks a dirty page from the
>>> LRU tail, writes it to disk synchronously, waits for the I/O, then reclaims
>>> the frame. The user thread blocks during this flush. This is visible as
>>> `buf_LRU_single_flush` waits in Performance Schema. The solution is proper
>>> adaptive flushing configuration so dirty pages are continuously flushed in
>>> the background, keeping clean pages available at the LRU tail.

---

## 4.5 Adaptive Flushing

### 4.5.1 The Core Problem

InnoDB uses write-ahead logging: modifications are recorded in the redo log first,
then the dirty data pages are written to their tablespace files "lazily" in the
background. But the redo log is circular and finite. If dirty pages are not
flushed fast enough:

```
REDO LOG (circular, e.g., 4 GB total)
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ████████████████░░░░░░░░░░░░████████████████████████████    │
│  ▲               ▲             ▲                        ▲    │
│  │               │             │                        │    │
│  checkpoint_lsn  │         write_lsn              end of log │
│  (can reclaim    │         (latest write)                     │
│  space behind    │                                           │
│  this point)     │                                           │
│                  reusable space                               │
│                  (between checkpoint and write head)          │
│                                                              │
│  If write_lsn catches up to checkpoint_lsn:                  │
│  → NO REDO LOG SPACE LEFT                                    │
│  → ALL writes block until pages are flushed                  │
│  → SYNCHRONOUS FLUSH STORM → production outage               │
└──────────────────────────────────────────────────────────────┘
```

**Synchronous flush**: When redo log space is critically low, InnoDB enters
"furious flushing" mode. All user threads block while the page cleaner threads
flush dirty pages as fast as possible. During this time, throughput drops to
near zero. This is the dreaded "InnoDB stall."

### 4.5.2 The Adaptive Flushing Algorithm

Adaptive flushing (`innodb_adaptive_flushing = ON`, default) continuously
adjusts the background flush rate to prevent redo log space exhaustion.

The algorithm (simplified from `buf/buf0flu.cc:page_cleaner_flush_pages_recommendation()`):

```
Inputs:
  lsn_rate          = rate of redo log generation (bytes/sec)
  oldest_lsn        = oldest_modification LSN on flush list head
  current_lsn       = current redo log write position
  lsn_age           = current_lsn - oldest_lsn (age of oldest dirty page)
  max_lsn_age       = total redo log capacity
  lsn_age_factor    = lsn_age / max_lsn_age (how full is the redo log)
  
  io_capacity       = innodb_io_capacity (e.g., 2000 IOPS)
  io_capacity_max   = innodb_io_capacity_max (e.g., 4000 IOPS)
  
Algorithm:
  IF lsn_age_factor < innodb_adaptive_flushing_lwm (default 10%):
      → no adaptive flushing needed, use minimal background flush
      
  ELSE:
      → Calculate target_flush_rate:
      
        pct_for_lsn = (lsn_age_factor - lwm) / (100 - lwm) * 100
        
        This percentage is applied against io_capacity:
        
        n_pages_to_flush = io_capacity * (pct_for_lsn / 100)
        
        Capped at io_capacity_max
        
  IF lsn_age_factor > 70%:
      → Aggressive flushing: exponentially increase flush rate
      → May exceed io_capacity_max
      
  IF lsn_age_factor > 90%:
      → Critical: synchronous flush (all user threads stall)
```

**Visualized**:

```
Flush Rate vs Redo Log Fullness

  Flush                                            ▲ sync flush
  Rate   ▲                                         │ (stall)
  (IOPS) │                                    ┌────┤
         │                              ┌─────┘    │
         │                         ┌────┘          │
         │                    ┌────┘               │
         │               ┌────┘                    │
         │          ┌────┘                         │
         │     ┌────┘                              │
         │─────┘                                   │
io_cap   │····································     │
  min    │                                         │
         └────────┬──────┬──────┬──────┬──────┬────┘
         0%      10%    30%    50%    70%    90%   100%
                  ▲              Redo Log Fill %    ▲
                  │                                │
                  lwm                           sync flush
              (innodb_adaptive_                 threshold
               flushing_lwm)
```

### 4.5.3 Key Configuration Parameters

```
innodb_io_capacity = 2000
  -- estimated I/O operations per second the storage can handle
  -- for NVMe SSD: 5000-20000
  -- for SATA SSD: 1000-5000
  -- for spinning disk: 200-400
  -- governs background flush rate under normal conditions

innodb_io_capacity_max = 4000
  -- upper bound for adaptive flushing bursts
  -- typically 2x innodb_io_capacity

innodb_adaptive_flushing = ON           -- enable adaptive flushing (default)
innodb_adaptive_flushing_lwm = 10       -- start adaptive flushing at 10% redo fill
innodb_max_dirty_pages_pct = 90         -- target max dirty page percentage
innodb_max_dirty_pages_pct_lwm = 10     -- start pre-flushing at this dirty %
```

>>> **Interview insight**: "How do you tune `innodb_io_capacity` for NVMe storage?"
>>> Run `fio` with the same I/O pattern InnoDB uses: 16 KB random writes, queue
>>> depth 1-4. The result is your baseline. Set `innodb_io_capacity` to ~75% of
>>> that number so InnoDB does not saturate the device. Set `innodb_io_capacity_max`
>>> to 100% of the benchmark. A common mistake is leaving `innodb_io_capacity` at
>>> the default (200) on NVMe -- this throttles background flushing so severely
>>> that dirty pages accumulate, the redo log fills up, and you get synchronous
>>> flush stalls despite having a 500K IOPS device.

### 4.5.4 Flush List Flushing vs LRU List Flushing

InnoDB performs two types of flushing, each with a different goal:

```
┌──────────────────────────────────────────────────────────────────┐
│ FLUSH LIST FLUSHING                                              │
│                                                                  │
│ Goal:    Advance the checkpoint, reclaim redo log space           │
│ Source:  Flush list (oldest dirty pages first)                    │
│ Trigger: Adaptive flushing algorithm                             │
│ Thread:  Page cleaner coordinator + worker threads               │
│ Order:   By oldest_modification LSN (oldest first)               │
│ I/O:     Can batch adjacent pages for better throughput           │
│ Rate:    Controlled by innodb_io_capacity                        │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ LRU LIST FLUSHING                                                │
│                                                                  │
│ Goal:    Create free pages for page reads (prevent stalls)       │
│ Source:  LRU list tail (dirty pages near tail)                   │
│ Trigger: Free list is running low                                │
│ Thread:  Page cleaner threads                                    │
│ Order:   LRU order (least recently used first)                   │
│ I/O:     Usually single-page, less efficient                     │
│ Rate:    As needed to maintain free pages                        │
└──────────────────────────────────────────────────────────────────┘
```

The page cleaner coordinator (`buf_flush_page_cleaner_coordinator`) wakes up
every second and:
1. Checks redo log fill level → decides flush list flush volume
2. Checks free list level across instances → decides LRU flush volume
3. Distributes work across page cleaner worker threads (one per buffer pool instance)

### 4.5.5 Page Cleaner Threads

```
innodb_page_cleaners = 4   -- number of page cleaner threads (default)
                           -- ideally = innodb_buffer_pool_instances
```

```
┌─────────────────────────────────────────────────────────┐
│              PAGE CLEANER ARCHITECTURE                   │
│                                                         │
│  ┌──────────────────────┐                               │
│  │  Coordinator Thread  │ ← wakes every ~1 second       │
│  │  (1 thread)          │                               │
│  │                      │                               │
│  │  Calculates:         │                               │
│  │  - flush list target │                               │
│  │  - LRU flush target  │                               │
│  │  - per-instance work │                               │
│  └──────────┬───────────┘                               │
│             │ distributes work                          │
│    ┌────────┼────────┬──────────┐                       │
│    ▼        ▼        ▼          ▼                       │
│  ┌──────┐┌──────┐┌──────┐  ┌──────┐                    │
│  │Worker││Worker││Worker│  │Worker│                     │
│  │  0   ││  1   ││  2   │  │  3   │                     │
│  │      ││      ││      │  │      │                     │
│  │BP    ││BP    ││BP    │  │BP    │                     │
│  │inst  ││inst  ││inst  │  │inst  │                     │
│  │0,4,8 ││1,5,9 ││2,6,10│ │3,7,11│                     │
│  └──────┘└──────┘└──────┘  └──────┘                    │
│                                                         │
│  Each worker flushes assigned buffer pool instances      │
└─────────────────────────────────────────────────────────┘
```

### 4.5.6 Doublewrite Buffer Interaction

Every page flush goes through the **doublewrite buffer** (unless disabled).
This means each 16 KB page is written to disk **twice** per flush:

```
Page Flush Path (with doublewrite):

  dirty page in buffer pool
         │
         ▼
  ┌─────────────────────────────────────────────┐
  │ 1. Write to doublewrite buffer              │
  │    (sequential area in system tablespace     │
  │     or dedicated .dblwr files in 8.0.20+)   │
  │    → sequential write, fast                  │
  │    → fsync doublewrite area                  │
  └──────────────────────┬──────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────┐
  │ 2. Write to actual tablespace location      │
  │    (random I/O to .ibd file)                │
  │    → if this write is torn (partial write    │
  │      due to crash), recovery reads the       │
  │      intact copy from doublewrite buffer     │
  └──────────────────────┬──────────────────────┘
                         │
  ┌──────────────────────▼──────────────────────┐
  │ 3. Page is now clean                        │
  │    → remove from flush list                  │
  │    → set oldest_modification = 0             │
  │    → page remains on LRU list (still cached) │
  └─────────────────────────────────────────────┘
```

**Why doublewrite?** InnoDB pages are 16 KB, but most filesystems and hardware
write in 4 KB (or 512-byte) sectors. A crash during a 16 KB write can produce
a **torn page** -- half old data, half new data. The checksum will fail, and the
redo log cannot fix it because redo log entries are physiological (they describe
changes to a page, not the full page contents). The doublewrite buffer guarantees
an intact copy exists on disk before the actual tablespace write begins.

**MySQL 8.0.20+**: The doublewrite buffer was moved from the system tablespace
(`ibdata1`) to dedicated files (`.dblwr`), allowing parallel writes and reducing
contention.

>>> **Interview insight**: "Can you disable the doublewrite buffer?" Yes, with
>>> `innodb_doublewrite = OFF`. Safe only if the filesystem guarantees atomic
>>> 16 KB writes (e.g., ZFS with matching recordsize, or FusionIO with atomic
>>> write support). On ext4/XFS with standard hardware, disabling doublewrite
>>> risks silent data corruption after a crash.

---

## 4.6 Read-Ahead

### 4.6.1 Linear Read-Ahead

When InnoDB detects that pages in an extent (64 consecutive pages = 1 MB at 16 KB
page size) are being accessed sequentially, it pre-fetches the next extent.

```
innodb_read_ahead_threshold = 56   -- default: 56 out of 64 pages
```

```
Extent N (64 pages, 1 MB)                    Extent N+1 (64 pages)
┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬─────────┐  ┌──┬──┬──┬──┬──┬──┬──┐
│██│██│██│██│██│██│██│██│██│██│...  ██│██│  │  │  │  │  │  │  │  │
│p0│p1│p2│p3│p4│p5│p6│p7│p8│p9│... p62│63│  │p0│p1│p2│p3│p4│p5│p6│
└──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴─────────┘  └──┴──┴──┴──┴──┴──┴──┘
 ██ = accessed (in ascending order)           ↑
                                              pre-fetched async
 When 56 of 64 pages in extent N have        when threshold is met
 been accessed sequentially → trigger
 async read of all pages in extent N+1
```

**Source**: `buf/buf0rea.cc:buf_read_ahead_linear()`.

The algorithm checks whether the pages were accessed in ascending (or descending)
order by looking at the `access_time` of each page in the extent. If at least
`innodb_read_ahead_threshold` pages show monotonically increasing access times,
the next extent is pre-fetched asynchronously.

**LRU interaction**: Pre-fetched pages are inserted at the **old sublist head**
(midpoint). If the scan continues and accesses them, they get promoted to the
young sublist. If the scan stops or changes direction, pre-fetched pages age
out of the old sublist without polluting the young sublist.

### 4.6.2 Random Read-Ahead

```
innodb_random_read_ahead = OFF   -- disabled by default
```

If enabled, InnoDB checks whether 13 or more pages from the same extent are
already in the buffer pool (regardless of access order). If so, it pre-fetches
the remaining pages in that extent.

```
Extent N (64 pages)
┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐
│██│  │  │██│  │██│  │██│  │  │██│██│  │██│██│  │ ...
│p0│  │  │p3│  │p5│  │p7│  │  │10│11│  │13│14│  │
└──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘
 ██ = already in buffer pool (13 pages)

 → pre-fetch remaining 51 pages in this extent
```

**Why disabled by default?** Random read-ahead often causes more harm than good.
If an application is randomly accessing pages across an extent, pre-fetching the
rest wastes I/O bandwidth and buffer pool space. It was useful on spinning disks
where sequential reads were dramatically cheaper than random reads. On SSDs,
the benefit is marginal and the buffer pool pollution cost is real.

### 4.6.3 Read-Ahead for Different Scan Types

| Scan Type | Read-Ahead Behavior |
|-----------|-------------------|
| Full table scan | Linear read-ahead triggers quickly (pages accessed sequentially within extents). Pre-fetched pages go to old sublist. |
| Range scan (index) | Linear read-ahead triggers if the range covers sequential leaf pages. Benefits depend on index fragmentation. |
| Point lookup | No read-ahead. Single page read. |
| Index scan (covering) | Linear read-ahead on secondary index leaf pages if range is large enough. |

**Monitoring**:
```sql
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read_ahead%';
-- Innodb_buffer_pool_read_ahead         -- pages pre-fetched by read-ahead
-- Innodb_buffer_pool_read_ahead_evicted -- pre-fetched pages evicted without access
--   (high value = read-ahead is wasteful, consider increasing threshold or disabling)
```

---

## 4.7 Change Buffer (Insert Buffer)

### 4.7.1 The Problem

When a row is inserted, updated, or deleted, InnoDB must modify every secondary
index that includes a changed column. Each secondary index page is at a different
random location on disk. For a table with 5 secondary indexes, one INSERT
requires 5 random reads (to load each index leaf page) and 5 random writes.

```
INSERT INTO orders (id, customer_id, status, created_at, region)
  VALUES (1001, 42, 'new', NOW(), 'us-east');

Clustered index:     page already in buffer pool (sequential insert) → fast
Secondary index 1:   idx_customer_id   → leaf page probably NOT in pool → random I/O
Secondary index 2:   idx_status        → leaf page probably NOT in pool → random I/O
Secondary index 3:   idx_created_at    → leaf page probably NOT in pool → random I/O
Secondary index 4:   idx_region        → leaf page probably NOT in pool → random I/O

Without change buffer: 4 random disk reads + 4 random disk writes
With change buffer:    0 disk I/O (changes buffered in memory)
```

### 4.7.2 How It Works

The change buffer is a special B-Tree stored in the system tablespace (`ibdata1`).
When a DML modifies a non-unique secondary index page that is NOT in the buffer
pool, InnoDB records the change in the change buffer B-Tree instead of reading
the index page from disk.

```
┌─────────────────────────────────────────────────────────────────┐
│ CHANGE BUFFER ARCHITECTURE                                      │
│                                                                 │
│  User thread: INSERT INTO t VALUES(...)                         │
│       │                                                         │
│       ▼                                                         │
│  Secondary index page in buffer pool?                           │
│       │                                                         │
│  ┌────┴────┐                                                    │
│  │  YES    │  → modify page directly (normal path)              │
│  ├─────────┤                                                    │
│  │  NO     │  → is index UNIQUE?                                │
│  │         │       │                                            │
│  │         │  ┌────┴────┐                                       │
│  │         │  │  YES    │ → must read page to check uniqueness  │
│  │         │  │         │   → cannot buffer, do normal I/O      │
│  │         │  ├─────────┤                                       │
│  │         │  │  NO     │ → buffer change in CHANGE BUFFER      │
│  │         │  │         │   → no disk I/O needed now            │
│  │         │  └─────────┘                                       │
│  └─────────┘                                                    │
│                                                                 │
│  Change Buffer (B-Tree in ibdata1):                             │
│  ┌─────────────────────────────────────┐                        │
│  │  Key: (space_id, page_no, counter)  │                        │
│  │  Value: buffered operation          │                        │
│  │         (INSERT/DELETE-MARK/DELETE) │                        │
│  └─────────────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

### 4.7.3 Merge Process

Buffered changes are merged (applied to the actual secondary index page) in
three scenarios:

```
Merge Trigger 1: PAGE READ
  When the secondary index page is eventually read into the buffer pool
  (e.g., by a SELECT query), any pending changes for that page are applied
  immediately during the read.
  
  SELECT * FROM orders WHERE customer_id = 42
    → reads idx_customer_id leaf page into buffer pool
    → change buffer entries for that page are merged
    → page now reflects all buffered modifications

Merge Trigger 2: BACKGROUND MERGE
  The ibuf merge thread periodically merges buffered changes during idle time.
  Rate is governed by innodb_io_capacity.

Merge Trigger 3: BUFFER FULL
  When the change buffer reaches innodb_change_buffer_max_size % of the
  buffer pool, forced merges begin.
```

### 4.7.4 Configuration

```
innodb_change_buffer_max_size = 25    -- max 25% of buffer pool (default)
                                      -- range: 0 to 50

innodb_change_buffering = all          -- what operations to buffer
  -- all:     buffer inserts, delete-marks, and purge deletes (default)
  -- none:    disable change buffer entirely
  -- inserts: buffer only inserts
  -- deletes: buffer only delete-marks
  -- changes: buffer inserts + delete-marks
  -- purges:  buffer purge operations only
```

### 4.7.5 Why Only Non-Unique Secondary Indexes?

A unique index requires an immediate uniqueness check when inserting a new entry.
This check requires reading the index leaf page from disk to see if the key
already exists. Since the page must be read anyway, there is no benefit to
buffering the change -- the I/O has already happened.

```
UNIQUE index insert:
  1. Read leaf page from disk (mandatory -- must check uniqueness)
  2. If no duplicate → insert entry into page in buffer pool
  3. Page is already in buffer pool, so change buffer adds no value

NON-UNIQUE index insert:
  1. No uniqueness check needed → no mandatory read
  2. Buffer the INSERT in change buffer → skip disk I/O entirely
  3. Merge later when page is read for some other reason
```

>>> **Interview insight**: "Should I add a UNIQUE constraint to every secondary index
>>> for data integrity?" From a correctness standpoint, yes, if the column is truly
>>> unique. But the performance cost is significant: unique secondary indexes cannot
>>> use the change buffer, so every INSERT requires reading the index leaf page.
>>> For high-ingestion workloads (logging, event systems, IoT), non-unique secondary
>>> indexes with change buffering can be 2-5x faster for writes. Design the schema
>>> knowing this trade-off.

### 4.7.6 Performance Impact

```
Without change buffer (5 secondary indexes, random I/O):
  INSERT throughput: ~2,000 rows/sec (limited by random reads to load index pages)
  
With change buffer:
  INSERT throughput: ~20,000 rows/sec (no random reads, changes buffered)
  
Trade-off:
  + Converts random I/O to sequential (change buffer writes are sequential)
  + Dramatically improves write throughput
  - Delayed merge means secondary index is "eventually consistent" in memory
  - Merge storms: if many changes accumulate, a single page read triggers
    merging hundreds of changes → that one read takes much longer
  - Crash recovery must replay un-merged changes from the change buffer
```

---

## 4.8 Adaptive Hash Index (AHI)

### 4.8.1 What AHI Does

The Adaptive Hash Index is an optimization that InnoDB builds automatically.
When it detects that certain B+Tree pages are being accessed with the same
search pattern repeatedly, it builds an in-memory hash index for direct O(1)
access, bypassing the B+Tree traversal entirely.

```
Without AHI:
  SELECT * FROM users WHERE id = 42
  
  B+Tree traversal: root → internal → internal → leaf
  Cost: 3-4 page accesses (all in buffer pool, but still pointer chasing)
  Latency: ~3-5 microseconds

With AHI:
  Hash lookup: hash(id=42) → direct pointer to leaf page + record offset
  Cost: 1 hash probe
  Latency: ~0.5-1 microsecond
```

### 4.8.2 How AHI Is Built

InnoDB monitors access patterns on each B+Tree index page. The criteria for
building a hash entry:

```
AHI Build Decision:

  For each buffer pool page that is a B+Tree leaf page:
  
  Track: n_hash_helps    -- number of times the page was accessed with
                            a consistent key prefix
         n_hash_potential -- estimated benefit of building hash entries
  
  Build hash entries when:
  1. The same index page is accessed >= 17 times (configurable internally)
     with the same leftmost column prefix
  2. The pattern shows the SAME columns being used for lookup
  3. InnoDB determines that hash entries would save B+Tree traversals
  
  Example monitoring:
    users table, PRIMARY KEY (id)
    Access 1: WHERE id = 10  → page 1037, prefix = (id)
    Access 2: WHERE id = 20  → page 1037, prefix = (id)
    ...
    Access 17: WHERE id = 5  → page 1037, prefix = (id)
    → Build hash entries: hash(id=10)→record, hash(id=20)→record, ...
```

### 4.8.3 AHI Partitioning

```
innodb_adaptive_hash_index_parts = 8   -- default: 8 partitions
```

```
┌─────────────────────────────────────────────────────────────────┐
│                 ADAPTIVE HASH INDEX                             │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐     ┌──────────┐      │
│  │ Part 0   │ │ Part 1   │ │ Part 2   │     │ Part 7   │      │
│  │          │ │          │ │          │ ... │          │      │
│  │ rw-lock  │ │ rw-lock  │ │ rw-lock  │     │ rw-lock  │      │
│  │          │ │          │ │          │     │          │      │
│  │ hash_tbl │ │ hash_tbl │ │ hash_tbl │     │ hash_tbl │      │
│  │ [][][]...│ │ [][][]...│ │ [][][]...│     │ [][][]...│      │
│  └──────────┘ └──────────┘ └──────────┘     └──────────┘      │
│                                                                 │
│  Each partition protects its own hash table with a rw-lock.     │
│  Partition = hash(index_id, fold) % n_parts                    │
│  More parts = less contention, but more memory overhead.        │
└─────────────────────────────────────────────────────────────────┘
```

### 4.8.4 When AHI Helps

| Workload | AHI Benefit |
|----------|-------------|
| OLTP point lookups (SELECT by PK) | High -- eliminates B+Tree traversal |
| Hot rows accessed repeatedly | High -- hash lookup for each access |
| Read-heavy with stable working set | Medium -- depends on access pattern consistency |
| Range scans (BETWEEN, ORDER BY) | None -- AHI is not used for range scans |
| Heavy writes | Negative -- AHI must be maintained on every page split/merge |
| High concurrency writes | Negative -- AHI partition latch contention |

### 4.8.5 When AHI Hurts

AHI maintains its own hash table in memory, protected by rw-locks (one per
partition). Problems arise when:

```
Problem 1: WRITE CONTENTION
  Every page split, page merge, or record reorganization invalidates AHI
  entries on that page. Under heavy write load, AHI maintenance overhead
  exceeds its lookup benefit.
  
  Symptom: btr_search_latch waits dominate in SHOW ENGINE INNODB STATUS
  
Problem 2: MEMORY WASTE
  AHI can consume significant memory (visible in SHOW ENGINE INNODB STATUS
  under "Hash table size"). This memory comes from the buffer pool allocation.
  For workloads that do not benefit from AHI, this is wasted memory.
  
Problem 3: PARTITION CONTENTION
  Even with 8 partitions, high-concurrency point lookups on a few hot indexes
  can create latch contention on one or two partitions.
  
  Solution: increase innodb_adaptive_hash_index_parts to 16 or 32
  Or: disable AHI entirely
```

### 4.8.6 Monitoring AHI

```sql
-- From SHOW ENGINE INNODB STATUS:
-------------------------------------
INSERT BUFFER AND ADAPTIVE HASH INDEX
-------------------------------------
Ibuf: size 1, free list len 0, seg size 2, 0 merges
merged operations:
 insert 0, delete mark 0, delete 0
discarded operations:
 insert 0, delete mark 0, delete 0
Hash table size 276707, node heap has 0 buffer(s)
Hash table size 276707, node heap has 2 buffer(s)
Hash table size 276707, node heap has 4 buffer(s)
...
0.00 hash searches/s, 0.00 non-hash searches/s    ← KEY METRIC
```

```sql
-- Status variables for AHI effectiveness:
SHOW GLOBAL STATUS LIKE 'Innodb_adaptive_hash%';

+------------------------------------------+--------+
| Variable_name                            | Value  |
+------------------------------------------+--------+
| Innodb_adaptive_hash_searches            | 523847 |  ← lookups served by AHI
| Innodb_adaptive_hash_searches_btree      | 198234 |  ← lookups that fell through to B+Tree
+------------------------------------------+--------+

-- Decision rule:
--   hash_ratio = searches / (searches + searches_btree)
--   If hash_ratio < 30% → AHI is wasting memory, consider disabling
--   If hash_ratio > 70% → AHI is effective, keep enabled
```

```sql
-- Disable AHI (can be done at runtime):
SET GLOBAL innodb_adaptive_hash_index = OFF;
```

>>> **Interview insight**: "When would you disable the Adaptive Hash Index?"
>>> Three scenarios: (1) Write-heavy workloads where `btr_search` latch contention
>>> appears in the semaphore waits section of `SHOW ENGINE INNODB STATUS`.
>>> (2) When `Innodb_adaptive_hash_searches` is much lower than
>>> `Innodb_adaptive_hash_searches_btree` -- AHI is not being used but is consuming
>>> memory. (3) After upgrading to MySQL 8.0 on fast NVMe storage where B+Tree
>>> traversals in memory are already sub-microsecond and AHI's benefit is
>>> marginal compared to its latch overhead.

---

## 4.9 Buffer Pool Warmup (Dump and Load)

### 4.9.1 The Cold Start Problem

After a MySQL restart, the buffer pool is empty. Every query hits disk. For a
128 GB buffer pool that was 99.9% hit rate before restart, the first few minutes
(or hours) after restart can see 100x slower response times:

```
Before restart:
  Buffer pool: 128 GB, 8M pages cached
  Hit rate: 99.95%
  Avg query: 0.5 ms

After restart (cold):
  Buffer pool: 128 GB, 0 pages cached
  Hit rate: 0%
  Avg query: 50 ms (100x slower)
  
  Recovery time to 99% hit rate:
    With random OLTP workload: 30-120 minutes
    With buffer pool warmup:   5-15 minutes
```

### 4.9.2 Dump and Load Configuration

```
innodb_buffer_pool_dump_at_shutdown = ON    -- dump on clean shutdown (default ON in 8.0)
innodb_buffer_pool_load_at_startup = ON     -- reload on startup (default ON in 8.0)
innodb_buffer_pool_dump_pct = 25            -- dump top 25% most recently used pages
                                            -- default: 25 (range: 1-100)
```

### 4.9.3 What Is Dumped

The dump file (`ib_buffer_pool` in the data directory) stores ONLY page identifiers,
NOT page data:

```
ib_buffer_pool file format:
  
  space_id,page_no
  space_id,page_no
  space_id,page_no
  ...
  
  Each entry: ~10-20 bytes of text (space_id,page_no as ASCII numbers)
  
  For 8M pages (128 GB buffer pool):
    File size: ~80-160 MB (not 128 GB!)
    
  This is just a list of which pages were hot. On startup, InnoDB reads
  these pages from their tablespace files back into the buffer pool.
```

```
Dump/Load Process:

  SHUTDOWN:
  ┌─────────────────────────────────────────────┐
  │ 1. Walk LRU list of each buffer pool        │
  │    instance (young sublist first)            │
  │ 2. Record (space_id, page_no) for each page │
  │ 3. Stop at innodb_buffer_pool_dump_pct %    │
  │ 4. Write to ib_buffer_pool (text file)      │
  └─────────────────────────────────────────────┘
  
  STARTUP:
  ┌─────────────────────────────────────────────┐
  │ 1. Read ib_buffer_pool file                 │
  │ 2. Sort entries by (space_id, page_no)      │
  │    → converts random I/O to sequential      │
  │ 3. Issue async reads for each page           │
  │ 4. Pages are loaded into buffer pool         │
  │ 5. Progress logged every 10 seconds          │
  └─────────────────────────────────────────────┘
```

### 4.9.4 On-Demand Dump and Load

You can trigger dump/load at runtime without restarting:

```sql
-- Manual dump (e.g., before planned maintenance):
SET GLOBAL innodb_buffer_pool_dump_now = ON;

-- Monitor progress:
SHOW STATUS LIKE 'Innodb_buffer_pool_dump_status';
-- Example: "Buffer pool(s) dump completed at 210501 14:30:05"

-- Manual load (e.g., after adding a replica):
SET GLOBAL innodb_buffer_pool_load_now = ON;

-- Monitor progress:
SHOW STATUS LIKE 'Innodb_buffer_pool_load_status';
-- Example: "Buffer pool(s) load completed at 210501 14:35:22"

-- Abort a running load:
SET GLOBAL innodb_buffer_pool_load_abort = ON;
```

### 4.9.5 Production Best Practices

```
Scenario: Rolling restart of a 3-node InnoDB Cluster

  1. SET GLOBAL innodb_buffer_pool_dump_now = ON on node to restart
  2. Wait for dump to complete (check status variable)
  3. Switch traffic away from node (via ProxySQL/Router)
  4. Restart mysqld
  5. innodb_buffer_pool_load_at_startup = ON kicks in automatically
  6. Monitor load progress:
       SHOW STATUS LIKE 'Innodb_buffer_pool_load_status';
  7. Wait until load completes or hit rate > 99%
  8. Switch traffic back to node
  
  Total warmup time: ~5-15 minutes for 100 GB pool (NVMe)
  vs ~60+ minutes for natural warmup from live traffic
```

>>> **Interview insight**: "How do you handle MySQL restarts in production without
>>> impacting latency SLAs?" Buffer pool dump/load is half the answer. The other
>>> half is gradual traffic routing: use ProxySQL or MySQL Router to send a small
>>> percentage of traffic to the restarted node first, then ramp up. The dump/load
>>> pre-populates pages, but the LRU ordering is lost -- pages load as if they are
>>> all new (midpoint insertion). A few minutes of live traffic is needed for the
>>> truly hot pages to promote to the young sublist.

---

## 4.10 Monitoring and Troubleshooting

### 4.10.1 SHOW ENGINE INNODB STATUS -- Buffer Pool Section

```sql
SHOW ENGINE INNODB STATUS\G

-- Relevant section:
----------------------
BUFFER POOL AND MEMORY
----------------------
Total large memory allocated 137363456
Dictionary memory allocated 376602
Buffer pool size   8192          ← total pages (8192 * 16KB = 128 MB in this example)
Free buffers       1024          ← pages on free list
Database pages     7100          ← pages on LRU list (young + old)
Old database pages 2601          ← pages in old sublist
Modified db pages  350           ← dirty pages (on flush list)
Pending reads      0             ← pages waiting for async read
Pending writes: LRU 0, flush list 0, single page 0
Pages made young 15234, not young 87543   ← promotion/rejection counters
0.00 youngs/s, 0.00 non-youngs/s
Pages read 125678, created 4532, written 78901
0.00 reads/s, 0.00 creates/s, 0.00 writes/s
Buffer pool hit rate 999 / 1000  ← THIS IS THE CRITICAL METRIC
    → should be > 995/1000 (99.5%) for OLTP
    → < 990/1000 indicates buffer pool too small or working set too large
Pages read ahead 12345, evicted without access 234, Random read ahead 0
LRU len: 7100, unzip_LRU len: 0
I/O sum[0]:cur[0], unzip sum[0]:cur[0]
```

**Per-instance output** (when multiple instances):

```
---BUFFER POOL 0
Buffer pool size   512
Free buffers       64
Database pages     444
Old database pages 163
...
---BUFFER POOL 1
Buffer pool size   512
...
```

### 4.10.2 information_schema Tables

```sql
-- Aggregate stats per buffer pool instance:
SELECT 
  POOL_ID,
  POOL_SIZE,
  FREE_BUFFERS,
  DATABASE_PAGES,
  OLD_DATABASE_PAGES,
  MODIFIED_DATABASE_PAGES,
  PAGES_MADE_YOUNG,
  PAGES_NOT_MADE_YOUNG,
  HIT_RATE,                    -- per-1000 hit rate
  YOUNG_MAKE_PER_THOUSAND_GETS,
  NOT_YOUNG_MAKE_PER_THOUSAND_GETS
FROM information_schema.INNODB_BUFFER_POOL_STATS;
```

```sql
-- Per-page details (WARNING: acquires buffer pool mutex, DO NOT run on production):
SELECT 
  SPACE,
  PAGE_NUMBER,
  PAGE_TYPE,             -- INDEX, UNDO_LOG, INODE, IBUF_INDEX, etc.
  TABLE_NAME,
  INDEX_NAME,
  IS_OLD,                -- in old sublist?
  NUMBER_RECORDS,
  DATA_SIZE,
  COMPRESSED_SIZE,
  IS_STALE,
  FREE_PAGE_CLOCK
FROM information_schema.INNODB_BUFFER_PAGE
WHERE TABLE_NAME LIKE '%orders%'
LIMIT 100;
```

**WARNING**: `INNODB_BUFFER_PAGE` acquires a global latch on each buffer pool
instance to scan all pages. On a 128 GB buffer pool, this takes seconds and
blocks all buffer pool operations. NEVER run this query on a production server
under load. Use it only on staging or during maintenance windows.

```sql
-- Safer alternative: INNODB_BUFFER_PAGE_LRU (still takes latch, but ordered)
SELECT 
  POOL_ID,
  LRU_POSITION,
  SPACE,
  PAGE_NUMBER,
  PAGE_TYPE,
  TABLE_NAME,
  IS_OLD,
  IS_STALE
FROM information_schema.INNODB_BUFFER_PAGE_LRU
WHERE POOL_ID = 0
ORDER BY LRU_POSITION
LIMIT 50;
```

### 4.10.3 Key Metrics and Alert Thresholds

```
┌───────────────────────────────────────┬───────────┬──────────────────────┐
│ Metric                                │ Healthy   │ Action if Breached   │
├───────────────────────────────────────┼───────────┼──────────────────────┤
│ Buffer pool hit rate                  │ > 99.5%   │ Increase pool size   │
│                                       │           │ or reduce working set│
├───────────────────────────────────────┼───────────┼──────────────────────┤
│ Free buffers                          │ > 5% of   │ If 0: pool is full,  │
│                                       │ pool size │ LRU eviction active  │
├───────────────────────────────────────┼───────────┼──────────────────────┤
│ Modified db pages (dirty ratio)       │ < 75%     │ Tune io_capacity,    │
│                                       │           │ check flushing       │
├───────────────────────────────────────┼───────────┼──────────────────────┤
│ Pages read ahead evicted w/o access   │ < 20% of  │ Increase threshold   │
│                                       │ read-ahead│ or disable read-ahead│
├───────────────────────────────────────┼───────────┼──────────────────────┤
│ Pending reads                         │ 0-5       │ > 50: I/O subsystem  │
│                                       │           │ saturated            │
├───────────────────────────────────────┼───────────┼──────────────────────┤
│ Pending writes (flush list)           │ 0-10      │ > 100: flushing      │
│                                       │           │ bottleneck           │
├───────────────────────────────────────┼───────────┼──────────────────────┤
│ Single page writes                    │ 0         │ > 0: LRU stalls,     │
│                                       │           │ sync single-page     │
│                                       │           │ flush occurring      │
└───────────────────────────────────────┴───────────┴──────────────────────┘
```

### 4.10.4 Performance Schema Integration

```sql
-- Memory consumption by buffer pool:
SELECT * FROM performance_schema.memory_summary_global_by_event_name
WHERE EVENT_NAME LIKE '%buf_buf_pool%';

-- Buffer pool mutex/rw-lock contention:
SELECT 
  EVENT_NAME,
  COUNT_STAR,
  SUM_TIMER_WAIT / 1e12 as total_wait_seconds,
  AVG_TIMER_WAIT / 1e9 as avg_wait_ms
FROM performance_schema.events_waits_summary_global_by_event_name
WHERE EVENT_NAME LIKE '%buf_pool%'
   OR EVENT_NAME LIKE '%buf0buf%'
   OR EVENT_NAME LIKE '%flush_list%'
ORDER BY SUM_TIMER_WAIT DESC;
```

### 4.10.5 Common Troubleshooting Scenarios

**Scenario 1: Buffer Pool Hit Rate Drops Below 99%**

```
Diagnostic steps:
  1. Check if working set grew (new data, new indexes)
     → SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_reads';
       (physical reads from disk -- should be near zero for OLTP)
  
  2. Check for full table scans polluting the pool
     → SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read_ahead_evicted';
       (high value = scans are loading and discarding pages)
     → Check slow query log for SELECT without index
  
  3. Check if change buffer or AHI is consuming too much pool
     → SHOW ENGINE INNODB STATUS → INSERT BUFFER AND ADAPTIVE HASH INDEX
  
  4. Resolution:
     → Increase innodb_buffer_pool_size (online resize)
     → Add missing indexes to eliminate scans
     → Reduce innodb_change_buffer_max_size if change buffer is too large
```

**Scenario 2: Periodic Throughput Drops (Flush Storms)**

```
Diagnostic steps:
  1. Correlate throughput drops with SHOW ENGINE INNODB STATUS:
     → Look for "log sequence number - last checkpoint" growing
     → Look for "Pending writes: flush list" spiking
  
  2. Check innodb_io_capacity vs actual device capability:
     → Run: fio --rw=randwrite --bs=16k --numjobs=4 ...
     → If innodb_io_capacity << device capability, increase it
  
  3. Check redo log size:
     → innodb_redo_log_capacity (8.0.30+) or innodb_log_file_size * innodb_log_files_in_group
     → If too small, dirty pages age out faster, triggering aggressive flushing
  
  4. Resolution:
     → Increase innodb_io_capacity and innodb_io_capacity_max
     → Increase redo log capacity (reduces flush urgency)
     → Ensure innodb_page_cleaners = innodb_buffer_pool_instances
```

**Scenario 3: Memory Pressure / OOM**

```
Diagnostic steps:
  1. Check total memory consumption:
     → SELECT @@innodb_buffer_pool_size / (1024*1024*1024) AS pool_gb;
     → SELECT @@max_connections;
     → Estimate per-connection peak:
       sort_buffer_size + join_buffer_size + read_buffer_size + 
       read_rnd_buffer_size + tmp_table_size ≈ per-connection peak
  
  2. Calculate worst case:
     → pool_size + (max_connections * per_connection_peak) + OS overhead
     → Must be < physical RAM
  
  3. Resolution:
     → Reduce innodb_buffer_pool_size (online resize)
     → Reduce max_connections
     → Reduce per-connection buffers
     → Use connection pooling (ProxySQL / HikariCP) to limit actual concurrency
```

### 4.10.6 Diagnostic Query Cheat Sheet

```sql
-- 1. Buffer pool overview
SELECT 
  FORMAT(@@innodb_buffer_pool_size / (1024*1024*1024), 1) AS pool_size_gb,
  @@innodb_buffer_pool_instances AS instances,
  @@innodb_buffer_pool_chunk_size / (1024*1024) AS chunk_size_mb,
  @@innodb_old_blocks_pct AS old_blocks_pct,
  @@innodb_old_blocks_time AS old_blocks_time_ms;

-- 2. Hit rate and efficiency
SELECT
  (1 - (Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests)) * 100 
    AS hit_rate_pct,
  Innodb_buffer_pool_reads AS physical_reads,
  Innodb_buffer_pool_read_requests AS logical_reads,
  Innodb_buffer_pool_pages_dirty AS dirty_pages,
  Innodb_buffer_pool_pages_free AS free_pages,
  Innodb_buffer_pool_pages_total AS total_pages
FROM (
  SELECT 
    VARIABLE_VALUE AS val,
    VARIABLE_NAME AS name
  FROM performance_schema.global_status
  WHERE VARIABLE_NAME IN (
    'Innodb_buffer_pool_reads',
    'Innodb_buffer_pool_read_requests',
    'Innodb_buffer_pool_pages_dirty',
    'Innodb_buffer_pool_pages_free',
    'Innodb_buffer_pool_pages_total'
  )
) AS stats;

-- 3. Dirty page ratio
SELECT 
  Innodb_buffer_pool_pages_dirty / Innodb_buffer_pool_pages_total * 100 
    AS dirty_pct
FROM performance_schema.global_status
WHERE VARIABLE_NAME IN (
  'Innodb_buffer_pool_pages_dirty',
  'Innodb_buffer_pool_pages_total'
);

-- 4. Read-ahead effectiveness  
SELECT
  Innodb_buffer_pool_read_ahead AS pages_prefetched,
  Innodb_buffer_pool_read_ahead_evicted AS prefetched_but_never_used,
  IF(Innodb_buffer_pool_read_ahead > 0,
     Innodb_buffer_pool_read_ahead_evicted / Innodb_buffer_pool_read_ahead * 100,
     0) AS waste_pct
FROM performance_schema.global_status
WHERE VARIABLE_NAME LIKE 'Innodb_buffer_pool_read_ahead%';

-- 5. AHI effectiveness
SELECT 
  Innodb_adaptive_hash_searches AS ahi_hits,
  Innodb_adaptive_hash_searches_btree AS ahi_misses,
  Innodb_adaptive_hash_searches / 
    (Innodb_adaptive_hash_searches + Innodb_adaptive_hash_searches_btree) * 100 
    AS ahi_hit_rate_pct
FROM performance_schema.global_status
WHERE VARIABLE_NAME LIKE 'Innodb_adaptive_hash%';
```

---

## 4.11 Source Code Reference Map

For readers who want to trace the buffer pool implementation in the MySQL 8.0
source tree (`github.com/mysql/mysql-server`):

```
storage/innobase/
├── include/
│   ├── buf0buf.h          -- buf_pool_t, buf_block_t, buf_page_t definitions
│   ├── buf0flu.h          -- flush list, adaptive flushing declarations
│   ├── buf0lru.h          -- LRU list operations
│   ├── buf0rea.h          -- read-ahead declarations
│   ├── buf0types.h        -- type aliases and enums (buf_io_fix, page state)
│   └── buf0checksum.h     -- page checksum functions
├── buf/
│   ├── buf0buf.cc         -- core buffer pool: init, page_get, hash table
│   │   ├── buf_pool_init()           -- allocate buffer pool instances
│   │   ├── buf_page_get_gen()        -- main page access entry point
│   │   ├── buf_page_hash_get_low()   -- page hash lookup
│   │   └── buf_page_io_complete()    -- async I/O completion handler
│   ├── buf0flu.cc         -- flushing: flush list, adaptive flushing
│   │   ├── buf_flush_page_cleaner_coordinator() -- coordinator thread
│   │   ├── buf_flush_list()          -- flush list flushing
│   │   ├── buf_flush_LRU_list()      -- LRU list flushing
│   │   ├── page_cleaner_flush_pages_recommendation() -- adaptive algorithm
│   │   └── buf_flush_insert_into_flush_list()  -- add dirty page
│   ├── buf0lru.cc         -- LRU operations
│   │   ├── buf_LRU_get_free_block()  -- get free block (evict if needed)
│   │   ├── buf_LRU_add_block()       -- insert at midpoint
│   │   ├── buf_LRU_make_block_young()-- promote to young sublist
│   │   ├── buf_page_peek_if_young()  -- 1/4 optimization check
│   │   └── buf_LRU_free_page()       -- evict clean page
│   ├── buf0rea.cc         -- read-ahead
│   │   ├── buf_read_ahead_linear()   -- linear read-ahead
│   │   └── buf_read_ahead_random()   -- random read-ahead (if enabled)
│   └── buf0dblwr.cc       -- doublewrite buffer
│       ├── buf_dblwr_write_single_page() -- single page doublewrite
│       └── buf_dblwr_write_batch()       -- batch doublewrite
└── ibuf/
    └── ibuf0ibuf.cc       -- change buffer (insert buffer)
        ├── ibuf_insert()             -- buffer a secondary index change
        ├── ibuf_merge_or_delete_for_page() -- merge on page read
        └── ibuf_contract()           -- background merge
```

---

## 4.12 Summary — The Buffer Pool Mental Model

```
                         USER QUERY
                             │
                             ▼
                   ┌─────────────────────┐
                   │    PAGE HASH        │ ──── O(1) lookup
                   │ hash(space,page_no) │
                   └────────┬────────────┘
                      HIT   │        MISS
               ┌────────────┤            │
               ▼            │            ▼
         Pin page,          │     ┌──────────────┐
         acquire latch      │     │  FREE LIST   │
               │            │     │  (or evict   │
               ▼            │     │   LRU tail)  │
         Read/modify        │     └──────┬───────┘
         page in memory     │            │
               │            │            ▼
               │            │     Async I/O read
               │            │            │
               │            │            ▼
               │            │     Insert at LRU
               │            │     midpoint (old)
               │            │            │
               ▼            ▼            ▼
         ┌─────────────────────────────────────┐
         │              LRU LIST               │
         │  YOUNG ◄──── midpoint ────► OLD     │
         │  (hot)                     (cold)   │
         │                                     │
         │  Promotion: 2nd access + delay      │
         │  Eviction:  clean pages from tail   │
         └───────────────┬─────────────────────┘
                         │ if dirty
                         ▼
         ┌─────────────────────────────────────┐
         │           FLUSH LIST                │
         │  ordered by oldest_modification LSN │
         │                                     │
         │  Flushed by page cleaner threads    │
         │  Rate: adaptive flushing algorithm  │
         │  Path: page → doublewrite → .ibd    │
         └─────────────────────────────────────┘
```

**The five invariants** that govern buffer pool correctness:

1. **Every cached page is on exactly one of**: free list (unused) or LRU list (in use).
2. **Every dirty page is on both**: the LRU list AND the flush list.
3. **A page cannot be evicted while pinned** (`buf_fix_count > 0`) or during I/O (`io_fix != NONE`).
4. **A dirty page cannot be evicted**. It must be flushed first, which removes it from the flush list.
5. **The redo log entry for a modification is always written to the log buffer before the dirty page can be flushed to disk** (WAL guarantee).

>>> **Final interview insight**: If asked "Walk me through what happens in the
>>> buffer pool when a row is updated," connect all the pieces: page hash lookup
>>> (4.2.3) → pin and latch (4.4.2) → modify page in frame → generate redo log
>>> in mtr → mark dirty, add to flush list (4.2.6) → release latch and unpin →
>>> page cleaner eventually flushes via doublewrite (4.5.6) → page becomes clean
>>> → eligible for LRU eviction (4.4.3). This single trace touches every major
>>> buffer pool subsystem and demonstrates systems-level understanding of InnoDB.

---

*Next chapter: [Chapter 5 — B+Tree and Index Structures](05-btree-and-index-structures.md)*
