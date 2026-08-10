# Chapter 5: B+Tree and Index Structures

## How Data Is Physically Organized on Disk and Traversed

> Every row you have ever read from MySQL was found by walking a B+Tree. Every row you ever
> inserted caused a B+Tree mutation. This chapter explains the data structure that sits between
> your SQL and your spinning rust (or flash cells), why InnoDB chose it over every alternative,
> and how its physical properties dictate the performance characteristics of every query you
> will ever write.

---

## 5.1 Why B+Trees — The Disk I/O Argument

### 5.1.1 The Cost Model: Random vs Sequential I/O

Every data structure choice in a storage engine is a bet on the cost ratio between random
and sequential I/O. Here are the numbers that matter:

| Metric | HDD (7200 RPM) | SSD (NVMe) | DRAM |
|--------|----------------|------------|------|
| Random read latency | 8-12 ms | 0.05-0.1 ms | 50-100 ns |
| Sequential throughput | 100-200 MB/s | 2-7 GB/s | 25-50 GB/s |
| Random IOPS (4 KB) | 100-200 | 100,000-1,000,000 | N/A |
| Cost per GB | $0.02 | $0.10-0.25 | $3-5 |

The key insight: even on NVMe SSDs, a random read is still **500-1000x slower than
a sequential read of the same bytes**. The ratio narrowed from ~100,000x on spinning rust,
but it did not disappear. Any index structure that minimizes random I/O wins.

```
Cost of a query ≈ (number of random I/Os) * (random_read_latency)
                + (bytes read sequentially) / (sequential_throughput)

For HDD:  1 random read = 10ms = reading 1 MB sequentially
For SSD:  1 random read = 0.1ms = reading 500 KB sequentially
```

### 5.1.2 Why Not a Binary Search Tree? Why Not a Hash?

**Binary Search Tree (BST / Red-Black / AVL)**:
- Height = O(log2 N). For 1 billion rows: log2(10^9) ≈ 30 levels
- Each level = one random disk read → 30 random reads per lookup
- On HDD: 30 * 10ms = 300ms per point query. Unusable.

**Hash Index**:
- O(1) point lookups — optimal for `WHERE id = 42`
- Cannot do range queries (`WHERE id BETWEEN 10 AND 50`), ordering, or prefix matching
- Hash collisions cause chain walking — unpredictable I/O
- InnoDB's Adaptive Hash Index (AHI) is a hash layered *on top of* B+Tree for hot pages

**B-Tree (original Bayer-McCreight)**:
- Each node stores keys AND data → larger nodes → lower fanout
- Internal nodes carry data payload → fewer keys per page → taller tree

**B+Tree** (InnoDB's choice):
- Internal nodes store ONLY keys and child pointers → maximum fanout
- ALL data lives in leaf nodes → predictable leaf-level scans
- Leaf nodes form a doubly-linked list → range scans never revisit internal nodes

>>> Interview: "Why does InnoDB use B+Trees instead of hash indexes?" Answer both the
>>> range-scan argument AND the fanout/height argument. Mention that InnoDB does have an
>>> in-memory Adaptive Hash Index for hot equality lookups, but the on-disk structure is
>>> always B+Tree.

### 5.1.3 Fanout Calculation — Why B+Trees Are Shallow

The fanout (branching factor) of a B+Tree internal node determines the tree height.
Higher fanout = fewer levels = fewer random I/Os.

```
InnoDB page size: 16,384 bytes (16 KB)
Page header + trailer overhead: ~120 bytes
Usable space per internal page: ~16,264 bytes

Each internal node entry:
  - Key (e.g., BIGINT PK):     8 bytes
  - Child page pointer:        6 bytes (4-byte page_no + 2-byte offset in some representations)
  - Record header overhead:    ~5 bytes
  Total per entry:             ~19 bytes

Fanout ≈ 16,264 / 19 ≈ 856 entries per internal node
```

With composite keys or wider key types, fanout decreases:

| Key Type | Key Size | Pointer | Overhead | Fanout |
|----------|----------|---------|----------|--------|
| BIGINT | 8 B | 6 B | 5 B | ~856 |
| INT | 4 B | 6 B | 5 B | ~1,084 |
| VARCHAR(36) UUID | 36 B | 6 B | 7 B | ~332 |
| CHAR(36) UUID | 36 B | 6 B | 7 B | ~332 |
| Composite (a INT, b INT) | 8 B | 6 B | 5 B | ~856 |
| Composite (a BIGINT, b BIGINT, c BIGINT) | 24 B | 6 B | 5 B | ~465 |

### 5.1.4 Height Calculation — Rows Reachable per Level

For a BIGINT primary key with fanout ~856:

```
Level 0 (root):       1 page                  → 856 child pointers
Level 1:              856 pages                → 856^2 = 732,736 child pointers
Level 2:              732,736 pages            → 856^3 = 627,222,016 child pointers
Level 3 (leaf):       627,222,016 leaf pages

Each leaf page holds ~70-100 rows (depends on row size).
Assume 80 rows per leaf page:

Total rows ≈ 627,222,016 * 80 ≈ 50 billion rows

Tree height = 4 levels (root + 2 internal + leaf)
```

```
                    +------ ROOT ------+                    (Level 0: 1 page, in RAM)
                    |   [k1|k2|...|k856]|
                    +--+----+------+---+
                   /   |    |      |    \
              +---+  +-+-+ +-+-+ +-+-+  +---+
              |   |  |   | |   | |   |  |   |              (Level 1: 856 pages, likely in RAM)
              +---+  +---+ +---+ +---+  +---+
             / | \    / \    |    / \   / | \
            /  |  \  /   \   |   /   \ /  |  \
          +--+ +-+ +-+ +--+ | +--+ +-+ +-+ +--+
          |  | | | | | |  | | |  | | | | | |  |            (Level 2: ~733K pages)
          +--+ +-+ +-+ +--+ | +--+ +-+ +-+ +--+
          /\   /\  /\   /\  /\  /\  /\  /\   /\
         LEAF PAGES (Level 3: ~627M pages, contain actual row data)
```

**Critical performance insight**: the root page is *always* cached in the buffer pool. Level 1
pages (856 pages = ~14 MB) are almost always cached too. So a point query on a 50-billion-row
table requires at most **2 random disk reads** (Level 2 + Leaf), assuming buffer pool is
reasonably sized.

>>> Interview: "How many disk reads does a B+Tree lookup require for a billion-row table?"
>>> Answer: 3-4 levels total. Root and level-1 are always in buffer pool cache. So 1-2 random
>>> disk reads for a point query. For a 1-million-row table, typically 0-1 random reads
>>> (everything fits in buffer pool).

---

## 5.2 Clustered Index (Primary Key B+Tree)

### 5.2.1 Index-Organized Table — The Core Concept

InnoDB is an **index-organized table** (IOT) engine. There is no separate "heap" file storing
rows. The primary key B+Tree IS the table. Row data lives directly in the leaf pages of the
clustered index.

This is fundamentally different from PostgreSQL's heap-organized storage where table data lives
in heap pages and indexes contain pointers (ctid) to heap tuples.

```
+============================================================================+
|                     InnoDB Clustered Index B+Tree                          |
|                                                                            |
|  +------------------------------------------------------------------+     |
|  |                    ROOT PAGE (Internal)                           |     |
|  |  [min_key | ptr_0] [10 | ptr_1] [50 | ptr_2] [90 | ptr_3]       |     |
|  +----------+--------------+--------------+-----------+-------------+     |
|             |              |              |           |                    |
|      +------+    +---------+    +---------+    +------+                   |
|      v           v              v              v                          |
|  +----------+ +----------+ +----------+ +----------+                     |
|  | INTERNAL | | INTERNAL | | INTERNAL | | INTERNAL |                     |
|  |[1|3|7|9] | |[10|20|30]| |[50|60|70]| |[90|95|99]|                     |
|  +--+--+--+-+ +--+--+--+-+ +--+--+--+-+ +--+--+--+-+                    |
|     |  |  |      |  |  |      |  |  |      |  |  |                       |
|     v  v  v      v  v  v      v  v  v      v  v  v                       |
|  +=====+ +=====+ +=====+ +=====+ +=====+ +=====+                        |
|  |LEAF | |LEAF | |LEAF | |LEAF | |LEAF | |LEAF |    ... more leaves      |
|  |PAGE | |PAGE | |PAGE | |PAGE | |PAGE | |PAGE |                         |
|  |     | |     | |     | |     | |     | |     |                         |
|  | PK=1| | PK=3| |PK=10| |PK=50| |PK=90| |PK=95|                       |
|  | col1| | col1| | col1| | col1| | col1| | col1|                        |
|  | col2| | col2| | col2| | col2| | col2| | col2|                        |
|  | col3| | col3| | col3| | col3| | col3| | col3|                        |
|  | ... | | ... | | ... | | ... | | ... | | ... |                        |
|  | PK=2| | PK=7| |PK=20| |PK=60| |PK=92| |PK=99|                       |
|  | col1| | col1| | col1| | col1| | col1| | col1|                        |
|  | ... | | ... | | ... | | ... | | ... | | ... |                        |
|  +=====+ +=====+ +=====+ +=====+ +=====+ +=====+                        |
|     |        |       |       |       |       |                            |
|     +--------+-------+-------+-------+-------+                           |
|              DOUBLY-LINKED LIST (leaf page chain)                        |
+============================================================================+

Key: Internal nodes hold (key, page_pointer) pairs only.
     Leaf nodes hold FULL ROW DATA: (PK, col1, col2, ..., colN, trx_id, roll_ptr)
```

Source reference: `storage/innobase/btr/btr0btr.cc` — B+Tree structure management.
The clustered index is created in `dict_table_t` and its root page number is stored in
the data dictionary (`SYS_INDEXES` table, or in MySQL 8.0+, the `mysql.indexes` DD table).

### 5.2.2 Leaf Page Linked List — Range Scan Optimization

Leaf pages are connected by a **doubly-linked list** via `PAGE_BTR_SEG_LEAF` pointers:

```
  LEAF PAGE A              LEAF PAGE B              LEAF PAGE C
+---------------+      +---------------+      +---------------+
| PAGE_PREV: -- |<-----| PAGE_PREV: A  |<-----| PAGE_PREV: B  |
| PAGE_NEXT: B  |----->| PAGE_NEXT: C  |----->| PAGE_NEXT: -- |
|               |      |               |      |               |
| Records:      |      | Records:      |      | Records:      |
| PK=1, row...  |      | PK=51, row... |      | PK=101, row...|
| PK=2, row...  |      | PK=52, row... |      | PK=102, row...|
| ...           |      | ...           |      | ...           |
| PK=50, row... |      | PK=100, row...|      | PK=150, row...|
+---------------+      +---------------+      +---------------+
```

Range query `SELECT * FROM t WHERE pk BETWEEN 51 AND 120`:
1. Traverse B+Tree from root to find leaf page containing PK=51 → Page B
2. Scan forward through Page B (PK=51 to PK=100)
3. Follow `PAGE_NEXT` pointer to Page C
4. Scan Page C (PK=101 to PK=120)
5. Stop

**No re-traversal from root.** Sequential leaf-page reads can be prefetched by the OS or
InnoDB's read-ahead (`innodb_read_ahead_threshold`, default 56 — triggers linear read-ahead
after 56 of the 64 pages in an extent are accessed sequentially).

### 5.2.3 Implicit Primary Key — What Happens Without a PK

InnoDB REQUIRES a clustered index. If you do not define one, InnoDB picks one for you:

```
Decision tree for clustered index selection:

1. Explicit PRIMARY KEY defined?
   YES → Use it as clustered index
   NO  → Continue

2. First UNIQUE index where ALL columns are NOT NULL?
   YES → Use it as clustered index
   NO  → Continue

3. InnoDB generates a hidden 6-byte monotonically increasing
   column called DB_ROW_ID and uses it as the clustered index.
   - DB_ROW_ID is a global counter shared across ALL tables
     that lack an explicit PK
   - This is a contention point: a single mutex
     (dict_sys->mutex) protects the counter
   - You cannot reference DB_ROW_ID in queries
```

Source reference: `row/row0mysql.cc:row_create_table_for_mysql()` — the logic that determines
which index becomes the clustered index.

>>> Interview: "What happens if you don't define a primary key on an InnoDB table?"
>>> InnoDB checks for a UNIQUE NOT NULL index first, then falls back to a hidden 6-byte
>>> DB_ROW_ID. The hidden row ID is a global counter with mutex contention across all
>>> PK-less tables — another reason to ALWAYS define an explicit PK.

### 5.2.4 Primary Key Selection — Performance Implications

The choice of primary key has enormous performance implications because it determines the
physical ordering of ALL rows on disk and is appended to every secondary index entry.

#### AUTO_INCREMENT BIGINT (Optimal)

```
Sequential insert pattern:

Before insert PK=101:
  LEAF PAGE [... PK=97 | PK=98 | PK=99 | PK=100 | FREE ]
                                                     ^
                                              insert here (rightmost)

After insert PK=101:
  LEAF PAGE [... PK=97 | PK=98 | PK=99 | PK=100 | PK=101 ]

  - Always appends to the rightmost leaf page
  - No page splits until page is full
  - When page splits, it's an asymmetric 90/10 split (old page keeps 90%, new page gets 10%)
  - Buffer pool hot page: same page used for many consecutive inserts
  - Minimal write amplification
```

#### Random UUID v4 (Worst Case)

```
Random insert pattern (UUID = 'a3f7c2b1-...' → somewhere in the middle):

  LEAF A                   LEAF B                   LEAF C
  [a1... | a2... | a3...]  [b1... | b5... | b9...]  [c2... | c7... | c8...]
               ^
         insert 'a3f7...' here → but LEAF A is FULL!

  → PAGE SPLIT:
    1. Allocate new LEAF A'
    2. Move ~50% of LEAF A records to LEAF A'
    3. Insert new record into correct page
    4. Update parent internal node pointer
    5. Potentially cascade split up the tree

  Result:
  LEAF A  [a1... | a2... ]         (half empty)
  LEAF A' [a3... | a3f7... ]       (half empty)
  LEAF B  [b1... | b5... | b9...]  (full, will split next UUID insert here)
```

Performance degradation with random UUIDs:
- **2-3x write amplification** from constant page splits
- **~50% space utilization** in leaf pages (vs ~90%+ with sequential)
- **Buffer pool thrashing**: every insert touches a different page
- **Fragmented .ibd file**: pages allocated non-sequentially on disk
- **Larger secondary indexes**: 16-byte UUID vs 8-byte BIGINT appended to every entry

#### UUID v7 / ULID (Good Compromise)

```
UUID v7 format:
  +------ 48 bits ------+--- 4 ---+--- 12 ---+--- 2 ---+--- 62 bits ---+
  | Unix timestamp (ms)  | ver (7) | rand_a   | var (2) | rand_b       |
  +----------------------+---------+----------+---------+--------------+

  The timestamp prefix makes inserts roughly time-ordered:
  - 2024-01-01 00:00:00.001 → 018c6... 
  - 2024-01-01 00:00:00.002 → 018c6... (slightly higher)
  - 2024-01-01 00:00:00.003 → 018c6... (slightly higher)

  Within the same millisecond, random suffix may cause minor reordering,
  but inserts are 95%+ sequential → minimal page splits.
```

| PK Type | Insert Pattern | Page Utilization | Write Amplification | Secondary Index Overhead |
|---------|---------------|-----------------|--------------------|-----------------------|
| AUTO_INCREMENT BIGINT | Append-only | 90-95% | 1x (baseline) | +8 bytes per entry |
| AUTO_INCREMENT INT | Append-only | 90-95% | 1x | +4 bytes per entry |
| UUID v4 (BINARY(16)) | Random | 50-65% | 2-3x | +16 bytes per entry |
| UUID v7 (BINARY(16)) | Mostly sequential | 85-90% | 1.1-1.2x | +16 bytes per entry |
| ULID (BINARY(16)) | Mostly sequential | 85-90% | 1.1-1.2x | +16 bytes per entry |
| Natural key (email) | Random | 50-65% | 2-3x | +N bytes per entry |

>>> Interview: "Your team wants to use UUID as the primary key. What are the trade-offs?"
>>> Random UUIDs cause page splits, fragmentation, write amplification, and bloated secondary
>>> indexes. Recommend UUID v7 or ULID for time-ordered insertion. Or use BIGINT PK with
>>> UUID as a UNIQUE secondary index for external references. If using UUID, store as
>>> BINARY(16), not CHAR(36) — saves 20 bytes per PK and per secondary index entry.

### 5.2.5 Page Split Mechanics — The Full Story

When a leaf page is full and a new record must be inserted at a position within it:

```
BEFORE SPLIT:

  Parent Internal Page:
  [...| 50 | ptr_B | 100 | ptr_C |...]
            |              |
            v              v
  LEAF B (FULL):           LEAF C:
  [51|55|60|65|70|         [101|110|120|...]
   75|80|85|90|95|100]
        ^
    Insert PK=72 here — but page is full!


SPLIT ALGORITHM (btr/btr0btr.cc:btr_page_split_and_insert):

  Step 1: Find the split point (approximately middle record)
          Split point = PK=75

  Step 2: Allocate new page (LEAF B')
          Source: fseg_alloc_free_page() from the tablespace free list

  Step 3: Move records >= split point to new page
          LEAF B:  [51|55|60|65|70|72]        (records < 75 + new record)
          LEAF B': [75|80|85|90|95|100]       (records >= 75)

  Step 4: Update parent internal page
          [...| 50 | ptr_B | 75 | ptr_B' | 100 | ptr_C |...]

  Step 5: Update leaf page linked list
          LEAF B  → PAGE_NEXT = B'
          LEAF B' → PAGE_PREV = B, PAGE_NEXT = C
          LEAF C  → PAGE_PREV = B'

  Step 6: Write redo log records for all modifications


AFTER SPLIT:

  Parent Internal Page:
  [...| 50 | ptr_B | 75 | ptr_B' | 100 | ptr_C |...]
            |             |              |
            v             v              v
  LEAF B:           LEAF B':           LEAF C:
  [51|55|60|        [75|80|85|         [101|110|120|...]
   65|70|72]         90|95|100]
  (~50% full)       (~50% full)
```

**Sequential insert optimization**: InnoDB detects when inserts are happening at the rightmost
position (e.g., AUTO_INCREMENT). Instead of a 50/50 split, it does an asymmetric split:

```
Sequential insert at rightmost position:

  LEAF (FULL): [991|992|993|994|995|996|997|998|999|1000]
  Insert PK=1001

  OPTIMIZED SPLIT:
  LEAF:      [991|992|993|994|995|996|997|998|999|1000]  (keeps ~100%)
  NEW LEAF:  [1001]                                      (new rightmost page)

  This avoids wasting 50% space on every split during bulk loads.
```

Source reference: `btr/btr0cur.cc:btr_cur_optimistic_insert()` — tries insert without split.
If that fails, `btr_cur_pessimistic_insert()` → `btr_page_split_and_insert()`.

---

## 5.3 Secondary Indexes

### 5.3.1 Structure — What Secondary Index Leaves Store

A secondary index leaf node stores: **(indexed_column_values, primary_key_value)**.
It does NOT store the full row. The PK value is the "bookmark" used to look up the full row
in the clustered index.

```
TABLE: users
  PK: id (BIGINT AUTO_INCREMENT)
  Columns: id, email, name, city, created_at
  Secondary Index: idx_email (email)

SECONDARY INDEX B+Tree (idx_email):

  +------------------------------------------------------+
  |              ROOT (Internal Page)                     |
  |  [alice@ | ptr] [mike@ | ptr] [zoe@ | ptr]           |
  +------+----------------+----------------+---------+---+
         |                |                |
         v                v                v
  +--------------+ +--------------+ +--------------+
  | LEAF PAGE    | | LEAF PAGE    | | LEAF PAGE    |
  |              | |              | |              |
  | (alice@, 7)  | | (mike@, 22) | | (zoe@, 3)   |
  | (bob@, 2)    | | (nancy@, 45)| |              |
  | (carol@, 15) | | (oscar@, 8) | |              |
  | (dave@, 31)  | | (pat@, 19)  | |              |
  |              | |              | |              |
  +--------------+ +--------------+ +--------------+
       |                |                |
       +----------------+----------------+
            DOUBLY-LINKED LIST

  Each entry = (email_value, pk=id_value)
  NO row data stored here.
```

### 5.3.2 Double Lookup (Bookmark Lookup)

When a query uses a secondary index but needs columns not in that index:

```
Query: SELECT name, city FROM users WHERE email = 'bob@example.com';
Index: idx_email (email)

STEP 1: Traverse secondary index (idx_email)
                                                           
  ROOT: [alice@ | ptr] [mike@ | ptr]                     
                |                                          
                v                                          
  LEAF: [(alice@, pk=7) | (bob@, pk=2) | (carol@, pk=15)]
                           ^^^^^^^^^^^^                    
                           Found! PK = 2                   

STEP 2: Traverse clustered index with PK=2 (bookmark lookup)
                                                           
  ROOT: [1 | ptr] [50 | ptr] [100 | ptr]                  
         |                                                  
         v                                                  
  LEAF: [(pk=1, row...) | (pk=2, row...) | (pk=3, row...)]
                           ^^^^^^^^^^^^^^                   
                           Found! Return name, city        

Total: 2 B+Tree traversals = potentially 2 * (2-3 random reads) = 4-6 random reads
```

This is why the MySQL optimizer sometimes chooses a full table scan over a secondary index
when a query returns more than ~20-30% of the table — the cost of N bookmark lookups
(random I/O to clustered index) exceeds the cost of a sequential scan of the entire
clustered index.

### 5.3.3 PK Size Matters — The Ripple Effect

Because the PK is appended to EVERY secondary index entry, a larger PK inflates all
secondary indexes:

```
Table with 10 million rows, 5 secondary indexes:

PK = INT (4 bytes):
  Each secondary index entry overhead from PK:  4 bytes
  Per secondary index:  10M * 4 = 40 MB of PK data
  Total across 5 indexes: 200 MB

PK = BIGINT (8 bytes):
  Per secondary index: 10M * 8 = 80 MB
  Total: 400 MB

PK = CHAR(36) UUID:
  Per secondary index: 10M * 36 = 360 MB
  Total: 1,800 MB (1.8 GB!)

PK = BINARY(16) UUID:
  Per secondary index: 10M * 16 = 160 MB
  Total: 800 MB
```

More secondary index data = larger .ibd file, more buffer pool pages consumed,
more I/O for index scans, slower secondary index creation during `ALTER TABLE`.

### 5.3.4 Covering Index — Avoiding the Double Lookup

A **covering index** includes all columns that the query needs. The optimizer recognizes
this and skips the clustered index lookup entirely.

```
Query: SELECT email, name FROM users WHERE email = 'bob@example.com';

Without covering index (idx_email):
  1. Search idx_email → find (bob@, pk=2)
  2. Search clustered index with pk=2 → get name
  Total: 2 B+Tree traversals

With covering index (idx_email_name ON (email, name)):
  1. Search idx_email_name → find (bob@, name='Bob', pk=2)
  2. All columns available — DONE
  Total: 1 B+Tree traversal

EXPLAIN output shows: "Using index" in Extra column → covering index used
```

```
COVERING INDEX B+Tree:

  LEAF PAGE of idx_email_name:
  +----------------------------------------------+
  | (alice@, 'Alice', pk=7)                      |
  | (bob@,   'Bob',   pk=2)   ← all cols here   |
  | (carol@, 'Carol', pk=15)                     |
  +----------------------------------------------+
  
  The query needs email and name — both present in the index.
  PK is always implicitly included, so it's also available.
  No need to visit clustered index.
```

**Index-only scan**: the general term for when the optimizer can satisfy the query entirely
from an index without accessing the base table (clustered index). InnoDB implements this
by checking if all columns in the SELECT list, WHERE clause, and ORDER BY/GROUP BY are
present in the secondary index (including the implicitly appended PK columns).

>>> Interview: "How do you optimize a slow query that uses a secondary index?"
>>> Check if a covering index can eliminate the bookmark lookup. Add the SELECT-list columns
>>> to the index. But beware: wider indexes consume more space, slow down writes, and may
>>> not be used if the optimizer estimates too many rows. EXPLAIN is your friend.

---

## 5.4 Composite (Multi-Column) Indexes

### 5.4.1 Internal Structure — Lexicographic Ordering

A composite index `INDEX(a, b, c)` stores entries sorted first by `a`, then by `b` within
the same `a`, then by `c` within the same `(a, b)`. This is a lexicographic (dictionary)
ordering.

```
TABLE: orders (id, status, customer_id, amount, created_at)
INDEX: idx_status_cust_amount ON (status, customer_id, amount)

COMPOSITE INDEX B+Tree (sorted lexicographically):

  ROOT INTERNAL PAGE:
  +---------------------------------------------------+
  | ('active',100,_) | ptr | ('shipped',500,_) | ptr  |
  +--------+---------+-----+-----------+-------+------+
           |                           |
           v                           v
  +------------------+      +------------------+
  | LEAF PAGE A      |      | LEAF PAGE B      |
  |                  |      |                  |
  | (active, 100, 50)| ←    | (shipped,500,200)|
  | (active, 100,150)| sorted by              |
  | (active, 200, 30)| a, then b,             |
  | (active, 200, 75)| then c                 |
  | (active, 300, 10)|      | (shipped,500,350)|
  | (active, 300, 90)|      | (shipped,600, 40)|
  |                  |      | (shipped,600,180)|
  +------------------+      +------------------+
         |                         |
         +-------------------------+
              LEAF LINKED LIST
```

### 5.4.2 Leftmost Prefix Rule

Because entries are sorted lexicographically, the index can only be used efficiently
when the query filters start from the LEFTMOST column(s) of the index.

```
INDEX(a, b, c) can serve:

  Query                               Uses Index?    How?
  ─────────────────────────────────────────────────────────────
  WHERE a = 1                         YES            Full prefix (a)
  WHERE a = 1 AND b = 2              YES            Full prefix (a, b)
  WHERE a = 1 AND b = 2 AND c = 3    YES            Full prefix (a, b, c)
  WHERE a = 1 AND c = 3              PARTIAL        Uses (a) only; c cannot skip b
  WHERE b = 2                         NO*            Leftmost column missing
  WHERE b = 2 AND c = 3              NO*            Leftmost column missing
  WHERE c = 3                         NO*            Leftmost column missing
  WHERE a = 1 AND b > 5 AND c = 3    PARTIAL        Uses (a, b range); c not usable
                                                      after range on b

  * Unless Index Skip Scan applies (see 5.4.4)
```

**Why does a range predicate on `b` prevent using `c`?**

```
INDEX(a, b, c) — physical ordering:

  (1, 1, 5)
  (1, 1, 9)
  (1, 2, 3)   ← WHERE a=1 AND b > 1 starts scan here
  (1, 2, 7)
  (1, 3, 1)
  (1, 3, 4)   ← b > 1 continues; c values are NOT sorted across different b values
  (1, 4, 2)
  (1, 4, 8)   ← WHERE a=1 AND b > 1 AND c=4 — must scan ALL b>1, filter c in server layer

  c is only sorted within a given (a, b) pair.
  Once b is a range, c values are scattered → index cannot narrow the scan using c.
```

### 5.4.3 The ESR Rule — Designing Optimal Composite Indexes

**ESR = Equality, Sort, Range**. This ordering principle maximizes the effectiveness of a
composite index:

```
1. EQUALITY columns first  — columns with = in WHERE clause
2. SORT columns next       — columns in ORDER BY
3. RANGE columns last      — columns with >, <, >=, <=, BETWEEN, LIKE 'prefix%'

Example query:
  SELECT * FROM orders
  WHERE status = 'active'        -- Equality
    AND amount > 100             -- Range
  ORDER BY created_at;           -- Sort

WRONG index: INDEX(status, amount, created_at)
  - status = 'active' → equality match (good)
  - amount > 100 → range scan, breaks sort ordering
  - created_at → not usable for sorting after range on amount
  - Result: "Using filesort" in EXPLAIN

RIGHT index: INDEX(status, created_at, amount)
  - status = 'active' → equality match (good)
  - created_at → already sorted in index → no filesort needed!
  - amount > 100 → range filter applied last (can use index for filtering)
  - Result: no filesort, efficient scan

ESR sequence for this query:
  E: status    → fixed value narrows to subset
  S: created_at → index already in this order
  R: amount    → range predicate applied as filter on remaining entries
```

```
Visualization of WHY ESR works:

INDEX(status, created_at, amount):

  (active, 2024-01-01, 50)   ← amount < 100, filtered out
  (active, 2024-01-02, 200)  ← amount > 100, returned 1st
  (active, 2024-01-03, 75)   ← amount < 100, filtered out
  (active, 2024-01-04, 300)  ← amount > 100, returned 2nd
  (active, 2024-01-05, 150)  ← amount > 100, returned 3rd

  Results come out in created_at order naturally — no sort needed.
  The range filter on amount just skips non-matching entries.

INDEX(status, amount, created_at):

  (active, 50,  2024-01-01)  ← skipped (amount <= 100)
  (active, 75,  2024-01-03)  ← skipped
  (active, 150, 2024-01-05)  ← returned, but created_at order is: 05, 02, 04
  (active, 200, 2024-01-02)  ← returned
  (active, 300, 2024-01-04)  ← returned

  Results NOT in created_at order → must filesort. Worse performance.
```

>>> Interview: "How would you design an index for: `WHERE status = 'active' AND price > 50
>>> ORDER BY created_at LIMIT 20`?" Apply ESR: INDEX(status, created_at, price). Equality
>>> (status) first, sort (created_at) second, range (price) last. No filesort needed. The
>>> LIMIT 20 means the engine stops after finding 20 matching rows in index order.

### 5.4.4 Index Skip Scan (MySQL 8.0.13+)

Before MySQL 8.0.13, `INDEX(a, b)` was completely useless for `WHERE b = 5` (no leftmost
prefix). MySQL 8.0.13 introduced **index skip scan**: if the leading column has **low
cardinality** (few distinct values), the optimizer can "skip" through each distinct value
of `a` and search for `b = 5` within each group.

```
INDEX(gender, age) — gender has only 2 values: 'M', 'F'

Query: WHERE age = 25

Without skip scan:
  Full table scan (index not usable)

With skip scan (8.0.13+):
  Effectively transforms to:
    WHERE gender = 'M' AND age = 25
    UNION ALL
    WHERE gender = 'F' AND age = 25

  B+Tree traversal:
    1. Seek to (gender='F', age=25) → scan matching entries
    2. Skip to (gender='M', age=25) → scan matching entries
    3. Done

  EXPLAIN shows: "Using index for skip scan"
```

Skip scan is beneficial only when the leading column has few distinct values. If the leading
column has high cardinality (e.g., user_id with millions of values), skip scan degrades to
near-full-index-scan and the optimizer correctly avoids it.

---

## 5.5 Page Splits and Merges

### 5.5.1 Split Triggers and Algorithm

A page split occurs when:
1. A record must be inserted into a leaf page
2. The page does not have enough free space for the new record
3. `btr_cur_optimistic_insert()` fails → falls through to `btr_cur_pessimistic_insert()`

```
SPLIT DECISION FLOW (simplified from btr0cur.cc):

  btr_cur_optimistic_insert(page, record)
    |
    +-- page has enough free space?
         |
         YES → insert record, done
         |
         NO → return DB_FAIL
                |
                v
  btr_cur_pessimistic_insert(page, record)
    |
    +-- acquire index X-latch (exclusive lock on index structure)
    |
    +-- btr_page_split_and_insert()
         |
         +-- Determine split point:
         |     - If insert at rightmost position → asymmetric split
         |     - Otherwise → find middle record → 50/50 split
         |
         +-- Allocate new page from tablespace segment
         |
         +-- Copy records after split point to new page
         |
         +-- Update page directory on both pages
         |
         +-- Insert new record into appropriate page
         |
         +-- Update parent internal node:
         |     - Insert new separator key + pointer to new page
         |     - If parent is also full → recursive split upward
         |
         +-- Update leaf page linked list pointers
         |
         +-- Write redo log records (MLOG_PAGE_SPLIT)
         |
         +-- Release latches
```

### 5.5.2 Sequential Insert Optimization (Asymmetric Split)

InnoDB detects sequential (rightmost) insert patterns and uses an optimized split strategy:

```
Standard middle-of-page insert → 50/50 split:

  FULL PAGE: [r1 | r2 | r3 | r4 | r5 | r6 | r7 | r8 | r9 | r10]
                              ^
                        insert here
  
  After split:
  PAGE A: [r1 | r2 | r3 | r4 | NEW ]       (~50%)
  PAGE B: [r5 | r6 | r7 | r8 | r9 | r10]   (~50%)


Rightmost insert (AUTO_INCREMENT) → asymmetric split:

  FULL PAGE: [r1 | r2 | r3 | r4 | r5 | r6 | r7 | r8 | r9 | r10]
                                                                  ^
                                                            insert here

  After split:
  PAGE A: [r1 | r2 | r3 | r4 | r5 | r6 | r7 | r8 | r9 | r10]  (~100%, untouched)
  PAGE B: [r11]                                                   (new page)

  This is a "split" in name only — really it's just allocating a new rightmost page.
  No record movement, no wasted space.
```

The detection logic is in `btr/btr0cur.cc` — InnoDB checks if the insert position is at
or near the end of the page and whether recent inserts have been sequential. The variable
`PAGE_LAST_INSERT` in the page header tracks the position of the last insert, and
`PAGE_DIRECTION` + `PAGE_N_DIRECTION` track consecutive same-direction inserts.

### 5.5.3 Page Merges

When records are deleted (or marked as deleted and later purged), a page may become
sparsely filled. InnoDB attempts to merge under-filled pages with their neighbors:

```
MERGE TRIGGER:
  After a delete/purge, if page fill level drops below MERGE_THRESHOLD:

  Default MERGE_THRESHOLD = 50% (page is less than half full)

  LEAF A (30% full)        LEAF B (40% full)
  [r1 | r2 | r3 |         [r10 | r11 | r12 | r13 |
   FREE SPACE    ]          FREE SPACE              ]

  Combined records fit in one page? YES →

  AFTER MERGE:
  LEAF A (70% full):
  [r1 | r2 | r3 | r10 | r11 | r12 | r13 | FREE ]

  LEAF B: deallocated, returned to free list
  Parent internal node: remove LEAF B's separator key

  If combined records don't fit → no merge, leave as is
```

**Configuring MERGE_THRESHOLD per index** (MySQL 5.7+):

```sql
-- Set for entire table (applies to all indexes):
ALTER TABLE orders COMMENT 'MERGE_THRESHOLD=40';

-- Set for a specific index:
CREATE INDEX idx_status ON orders(status) COMMENT 'MERGE_THRESHOLD=30';

-- Check current threshold:
SELECT t.NAME as table_name, i.NAME as index_name, i.MERGE_THRESHOLD
FROM information_schema.INNODB_INDEXES i
JOIN information_schema.INNODB_TABLES t ON i.TABLE_ID = t.TABLE_ID
WHERE t.NAME LIKE '%orders%';
```

Lower `MERGE_THRESHOLD` = fewer merges = less contention but more wasted space.
Higher `MERGE_THRESHOLD` = more aggressive reclamation but more merge operations.

### 5.5.4 Monitoring Splits and Merges

```sql
-- InnoDB metrics (must be enabled):
SET GLOBAL innodb_monitor_enable = 'index_page_splits';
SET GLOBAL innodb_monitor_enable = 'index_page_merge_attempts';
SET GLOBAL innodb_monitor_enable = 'index_page_merge_successful';
SET GLOBAL innodb_monitor_enable = 'index_page_reorg_attempts';
SET GLOBAL innodb_monitor_enable = 'index_page_reorg_successful';

-- Query the metrics:
SELECT NAME, COUNT, STATUS
FROM information_schema.INNODB_METRICS
WHERE NAME LIKE 'index_page%';

-- Example output:
-- +-----------------------------------+-------+---------+
-- | NAME                              | COUNT | STATUS  |
-- +-----------------------------------+-------+---------+
-- | index_page_splits                 |  4521 | enabled |
-- | index_page_merge_attempts         |  1203 | enabled |
-- | index_page_merge_successful       |   891 | enabled |
-- | index_page_reorg_attempts         |  2100 | enabled |
-- | index_page_reorg_successful       |  2050 | enabled |
-- +-----------------------------------+-------+---------+

-- High split count with random PK? → Switch to sequential PK
-- merge_attempts >> merge_successful? → Pages can't merge (neighbors also sparse)
--   → Consider OPTIMIZE TABLE to rebuild

-- SHOW ENGINE INNODB STATUS: check SEMAPHORES section for page split contention
-- Look for: "btr0sea.cc" or "btr0cur.cc" waits
SHOW ENGINE INNODB STATUS\G
```

>>> Interview: "You see high `index_page_splits` on a table. How do you diagnose and fix it?"
>>> Check if the PK is random (UUID). Check if there are hot secondary indexes with random
>>> inserts. Solutions: switch to sequential PK, adjust MERGE_THRESHOLD, or if the index is
>>> fragmented, run `ALTER TABLE ... FORCE` for an online rebuild.

---

## 5.6 B+Tree Traversal and Search Internals

### 5.6.1 Cursor Positioning — btr_cur_search_to_nth_level()

Every B+Tree lookup starts with cursor positioning. The entry point is
`btr_cur_search_to_nth_level()` (in MySQL 8.0, refactored as `btr_cur_search_to_nth_level()`
in `btr/btr0cur.cc`), which performs a root-to-leaf traversal:

```
btr_cur_search_to_nth_level(index, level, tuple, mode, cursor):

  1. Pin the root page (buffer pool fix + S-latch or X-latch)
     - Root page number stored in index object (dict_index_t)

  2. LOOP from root down to target level:
     |
     +-- Binary search within current page using page directory:
     |     a. Read page directory (sparse slot array at end of page)
     |     b. Binary search slots to find candidate record range
     |     c. Linear scan within slot to find exact position
     |
     +-- Determine which child pointer to follow
     |
     +-- Latch coupling:
     |     - Acquire latch on child page
     |     - Release latch on parent page (if optimistic)
     |     - Or hold parent latch (if pessimistic — for modifications)
     |
     +-- Descend to child page
     |
     +-- Repeat until target level reached

  3. Position cursor at the found record (or insertion point)
     - cursor->page_cur.rec = pointer to record
     - cursor->page_cur.block = buffer block of the page
```

### 5.6.2 Page Directory — Binary Search Within a Page

Each 16 KB page contains a **page directory** (also called slot array) that enables binary
search among the records within the page. The directory is a sparse index: one slot per
4-8 records.

```
16 KB InnoDB Page Layout (relevant to search):

+------------------------------------------------------------------+
| FIL HEADER (38 bytes)                                            |
+------------------------------------------------------------------+
| PAGE HEADER (56 bytes)                                           |
|   PAGE_N_DIR_SLOTS: number of directory slots                    |
|   PAGE_HEAP_TOP: end of record heap                              |
|   PAGE_N_RECS: number of user records                            |
|   PAGE_LAST_INSERT: offset of last inserted record               |
|   PAGE_DIRECTION: LEFT/RIGHT/NO_DIRECTION                        |
+------------------------------------------------------------------+
| INFIMUM record (smallest possible, anchor)                       |
+------------------------------------------------------------------+
| USER RECORDS (heap area)                                         |
|   Record 1 → Record 2 → Record 3 → ... → Record N              |
|   (linked by next-record offset in each record header)           |
+------------------------------------------------------------------+
| FREE SPACE                                                       |
+------------------------------------------------------------------+
| PAGE DIRECTORY (grows downward from bottom)                      |
|   [slot_0: offset_of_infimum]                                    |
|   [slot_1: offset_of_rec_5]     ← each slot points to           |
|   [slot_2: offset_of_rec_10]      the "owned" record            |
|   [slot_3: offset_of_rec_15]      in a group of 4-8 records     |
|   ...                                                            |
|   [slot_N: offset_of_supremum]                                   |
+------------------------------------------------------------------+
| FIL TRAILER (8 bytes)                                            |
+------------------------------------------------------------------+

Binary search on PAGE DIRECTORY:

  Records in page: [r1, r2, r3, r4, r5, r6, r7, r8, r9, ..., r80]
  
  Page directory slots (every ~6 records):
  slot[0] → infimum
  slot[1] → r6    (owns r1-r6)
  slot[2] → r12   (owns r7-r12)
  slot[3] → r18   (owns r13-r18)
  ...
  slot[13] → r78  (owns r73-r78)
  slot[14] → supremum (owns r79-r80)

  Searching for key K:
  1. Binary search on slot array: O(log(N/6)) comparisons
     → Find slot[i] where slot[i-1].key < K <= slot[i].key
  2. Linear scan from slot[i-1]+1 to slot[i]: at most 8 comparisons
  
  Total: ~4 binary search steps + ~4 linear steps for 80 records
  vs pure linear: 80 comparisons (worst case)
```

Source reference: `page/page0cur.cc:page_cur_search_with_match()` — the core in-page
search function. It receives the tuple to search for and returns the cursor positioned
at the matching record or the insertion point.

### 5.6.3 Pessimistic vs Optimistic Latch Coupling

During tree traversal, InnoDB must hold latches (lightweight locks) on pages to ensure
consistency. Two strategies:

```
OPTIMISTIC TRAVERSAL (read path, point queries):

  Acquire S-latch on root
    Binary search → find child pointer
  Acquire S-latch on child
    Release S-latch on root        ← "hand-over-hand" / "crabbing"
  Acquire S-latch on grandchild
    Release S-latch on child
  ...
  At leaf: hold S-latch only on leaf page

  Advantage: minimal contention — only one page latched at a time
  Used for: SELECT queries, optimistic insert attempts


PESSIMISTIC TRAVERSAL (write path, page splits):

  Acquire X-latch on index (or use SX-latch on upper levels)
    Traverse to leaf holding latches on the path
  At leaf: need to split?
    YES → already hold latches on parent(s) for safe modification
    NO  → release upper latches, proceed with insert

  Why needed: a page split modifies the leaf AND its parent (insert separator key).
  If the parent is also full, the split cascades upward. Without holding the path,
  another thread could modify the parent between our leaf split and parent update.

  MySQL 8.0 refinement: SX-latch (shared-exclusive) on internal nodes.
  Allows concurrent reads on internal pages while a write holds the path.
```

```
Latch Coupling Diagram:

OPTIMISTIC (read):                    PESSIMISTIC (write with potential split):

  [ROOT]  S-latch ──→ release         [ROOT]  SX-latch ──→ hold
     |                                    |
  [INT1]  S-latch ──→ release         [INT1]  SX-latch ──→ hold
     |                                    |
  [INT2]  S-latch ──→ release         [INT2]  X-latch  ──→ hold
     |                                    |
  [LEAF]  S-latch ──→ hold/release    [LEAF]  X-latch  ──→ modify + split
                                                            update INT2
                                                            if INT2 splits → update INT1
                                                            release all
```

### 5.6.4 Persistent Cursor — btr_pcur_t

For range scans and table scans, InnoDB uses a **persistent cursor** (`btr_pcur_t`) that
remembers its position across buffer pool page evictions:

```
struct btr_pcur_t {
    btr_cur_t       btr_cur;        // Current position in the B+Tree
    buf_block_t*    block_when_stored;  // Buffer block at time of store
    rec_t*          old_rec;        // Copy of record at stored position
    ulint           old_n_fields;   // Number of fields stored
    ulint           old_stored;     // Whether position is stored
    page_cur_position_t pos_state;  // POSITIONED, BEFORE_FIRST, AFTER_LAST
    lsn_t           modify_clock;   // Page modify clock at store time
};
```

When a persistent cursor needs to resume after releasing its page latch:

```
btr_pcur_restore_position():

  1. Check if buffer block is still valid and modify_clock matches
     → YES: page hasn't been modified since we stored position
             → cursor still valid, just re-latch the page

     → NO: page was evicted or modified
             → Re-traverse B+Tree from root using stored key
             → Position cursor at or after the stored key
             → Continue scan from there

This is why range scans work correctly even under concurrent modifications:
the cursor can always be restored to the correct position using the stored key.
```

>>> Interview: "How does InnoDB handle a long-running range scan when the buffer pool is
>>> under pressure?" The persistent cursor stores the current key value. If the page is
>>> evicted, InnoDB re-traverses the B+Tree to find the key position again. This adds
>>> overhead but guarantees correctness. The re-traversal uses optimistic latching.

---

## 5.7 Special Index Types

### 5.7.1 Prefix Index

Index only the first N characters of a string column. Reduces index size for long
VARCHAR/TEXT columns at the cost of reduced selectivity and inability to serve as a
covering index.

```sql
-- Full index on email (VARCHAR(255)) — up to 255 bytes per entry
CREATE INDEX idx_email ON users(email);

-- Prefix index — only first 10 characters
CREATE INDEX idx_email_prefix ON users(email(10));
```

```
Prefix index leaf entries:

  Full index:        ('alice.wonderland@company.com', pk=7)    -- 30 bytes for key
  Prefix index(10):  ('alice.wond', pk=7)                      -- 10 bytes for key

  Space saving: 3x fewer bytes per entry → more entries per page → shallower tree
```

**Trade-offs**:
- Cannot be a covering index (the full column value is not in the index)
- Cannot optimize `ORDER BY email` (prefix might not preserve full ordering)
- Useful for equality lookups only when prefix is selective enough

**Choosing prefix length** — find the sweet spot:

```sql
-- Compare selectivity of different prefix lengths:
SELECT
  COUNT(DISTINCT LEFT(email, 5))  / COUNT(*) AS sel_5,
  COUNT(DISTINCT LEFT(email, 10)) / COUNT(*) AS sel_10,
  COUNT(DISTINCT LEFT(email, 15)) / COUNT(*) AS sel_15,
  COUNT(DISTINCT email)           / COUNT(*) AS sel_full
FROM users;

-- Example output:
-- sel_5 = 0.45, sel_10 = 0.92, sel_15 = 0.99, sel_full = 1.00
-- → prefix length 10-15 captures most of the selectivity
```

### 5.7.2 Fulltext Index

InnoDB's fulltext index is an **inverted index** — a fundamentally different structure from
B+Trees. It maps words to the documents (rows) containing them.

```
INVERTED INDEX STRUCTURE:

  Regular B+Tree index:    row → column_value        (forward mapping)
  Fulltext inverted index: word → list of (doc_id, position)  (reverse mapping)

  Table: articles (id, title, body)
  FULLTEXT INDEX ft_body (body)

  Row 1: body = "MySQL uses B+Trees for index storage"
  Row 2: body = "PostgreSQL also uses B+Trees internally"
  Row 3: body = "Redis uses hash tables and skip lists"

  Inverted index entries:
  +-----------+---------------------------+
  | Word      | Document List             |
  +-----------+---------------------------+
  | mysql     | (doc_id=1, pos=1)         |
  | uses      | (1,2), (2,3), (3,2)       |
  | b+trees   | (1,3), (2,5)              |
  | index     | (1,5)                     |
  | storage   | (1,6)                     |
  | postgresql| (2,1)                     |
  | internally| (2,6)                     |
  | redis     | (3,1)                     |
  | hash      | (3,3)                     |
  | tables    | (3,4)                     |
  | skip      | (3,6)                     |
  | lists     | (3,7)                     |
  +-----------+---------------------------+
```

InnoDB fulltext implementation details:
- **FTS_DOC_ID**: hidden BIGINT column auto-added when a fulltext index is created.
  Uniquely identifies each row for the FTS subsystem. You can explicitly define it:
  `FTS_DOC_ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`
- **Auxiliary tables**: 6 internal tables per fulltext index (named `FTS_<index_id>_<N>`)
  that store the inverted index data, partitioned by character range
- **FTS index cache**: in-memory buffer for recent changes. Flushed to auxiliary tables
  on `OPTIMIZE TABLE`, transaction commit (if cache is full), or server shutdown
- **Stopwords**: common words (the, is, at, ...) excluded from indexing. Configurable
  via `innodb_ft_server_stopword_table` or `innodb_ft_user_stopword_table`

```sql
-- Natural language mode (default): ranks by relevance
SELECT *, MATCH(body) AGAINST('MySQL B+Trees' IN NATURAL LANGUAGE MODE) AS relevance
FROM articles
WHERE MATCH(body) AGAINST('MySQL B+Trees' IN NATURAL LANGUAGE MODE);

-- Boolean mode: operators (+required, -excluded, *wildcard)
SELECT * FROM articles
WHERE MATCH(body) AGAINST('+MySQL -PostgreSQL' IN BOOLEAN MODE);

-- Query expansion: two-pass search, second pass adds words from first-pass results
SELECT * FROM articles
WHERE MATCH(body) AGAINST('database' WITH QUERY EXPANSION);
```

### 5.7.3 Spatial Index (R-Tree)

For `POINT`, `LINESTRING`, `POLYGON`, and `GEOMETRY` columns. Uses an **R-Tree** structure
instead of B+Tree. R-Trees organize data by **Minimum Bounding Rectangles (MBRs)**.

```
R-TREE STRUCTURE:

  Root: [MBR_A | ptr] [MBR_B | ptr]
            |              |
            v              v
  Internal: [mbr1|mbr2]   [mbr3|mbr4]     Each entry is an MBR enclosing children
              |    |         |    |
              v    v         v    v
  Leaf:    [p1,p2] [p3,p4] [p5,p6] [p7]   Actual geometry objects

  MBR = (min_x, min_y, max_x, max_y)

  Search for all points within a query rectangle Q:
  1. At root: check which child MBRs overlap with Q
  2. Descend into overlapping children only
  3. At leaf: check exact geometry intersection
```

```sql
CREATE TABLE locations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100),
    position POINT NOT NULL SRID 4326,
    SPATIAL INDEX idx_position (position)
);

-- Find points within a bounding box:
SELECT name FROM locations
WHERE MBRContains(
    ST_MakeEnvelope(ST_GeomFromText('POINT(77.5 12.9)'),
                     ST_GeomFromText('POINT(77.7 13.1)')),
    position
);

-- Find points within 5km of a reference point:
SELECT name, ST_Distance_Sphere(position, ST_GeomFromText('POINT(77.6 13.0)', 4326)) AS dist_m
FROM locations
WHERE ST_Distance_Sphere(position, ST_GeomFromText('POINT(77.6 13.0)', 4326)) < 5000;
```

### 5.7.4 Descending Index (MySQL 8.0+)

Before 8.0, all index columns were stored in ascending order. `DESC` in index definition was
parsed but ignored. MySQL 8.0 supports actual descending storage.

```sql
-- Mixed sort order index:
CREATE INDEX idx_status_date ON orders(status ASC, created_at DESC);

-- This index efficiently serves:
SELECT * FROM orders WHERE status = 'active' ORDER BY created_at DESC;
-- → No filesort! Index is already in (status ASC, created_at DESC) order.

-- Before 8.0, this would require:
SELECT * FROM orders WHERE status = 'active' ORDER BY created_at DESC;
-- → "Using filesort" (index is ASC only, must reverse)
```

```
INDEX(a ASC, b DESC) — Physical ordering:

  (a=1, b=90)     ← a ascending, b descending within same a
  (a=1, b=50)
  (a=1, b=10)
  (a=2, b=80)
  (a=2, b=40)
  (a=2, b=5)
  (a=3, b=95)
  (a=3, b=60)

  Query: WHERE a = 2 ORDER BY b DESC → direct scan, no sort
  Query: WHERE a = 2 ORDER BY b ASC  → backward scan (also supported, no filesort)
```

### 5.7.5 Invisible Index (MySQL 8.0+)

Make an index invisible to the optimizer without dropping it. The index is still maintained
on writes (kept up-to-date), but the optimizer ignores it during query planning.

```sql
-- Make index invisible:
ALTER TABLE orders ALTER INDEX idx_status INVISIBLE;

-- Make it visible again:
ALTER TABLE orders ALTER INDEX idx_status VISIBLE;

-- Check visibility:
SELECT INDEX_NAME, IS_VISIBLE
FROM information_schema.STATISTICS
WHERE TABLE_NAME = 'orders';
```

**Use cases**:
- **Test impact of dropping an index** without actually dropping it. If queries slow down,
  make it visible again instantly (no rebuild needed)
- **Gradual index cleanup**: make invisible, monitor for a week, then drop if no impact
- **Force optimizer to use a different plan** during debugging

```
Timeline for safe index removal:

  Day 1: ALTER TABLE orders ALTER INDEX idx_old INVISIBLE;
          -- Index still maintained, just not used for queries
          -- Monitor query performance, slow query log

  Day 3: No regressions detected in metrics

  Day 7: DROP INDEX idx_old ON orders;
          -- Now actually remove it, reclaim space
```

**Optimizer override**: you can force the optimizer to use an invisible index with
`SET optimizer_switch = 'use_invisible_indexes=on';` — useful for testing.

### 5.7.6 Functional Index (MySQL 8.0+)

Index an expression or function result, not a raw column value. InnoDB implements this by
creating a hidden virtual generated column and indexing that column.

```sql
-- Problem: queries on LOWER(email) can't use index on (email)
SELECT * FROM users WHERE LOWER(email) = 'bob@example.com';
-- Full table scan — applying LOWER() to every row

-- Solution: functional index
CREATE INDEX idx_lower_email ON users((LOWER(email)));
-- InnoDB creates hidden virtual column: _LOWER_email = LOWER(email)
-- B+Tree indexes the virtual column values

-- Now this uses the index:
SELECT * FROM users WHERE LOWER(email) = 'bob@example.com';
-- EXPLAIN: type=ref, key=idx_lower_email
```

```sql
-- More examples:

-- Index on a JSON field:
CREATE INDEX idx_json_name ON documents((CAST(data->>'$.name' AS CHAR(100))));
SELECT * FROM documents WHERE CAST(data->>'$.name' AS CHAR(100)) = 'Bob';

-- Index on date part:
CREATE INDEX idx_order_month ON orders((MONTH(created_at)));
SELECT * FROM orders WHERE MONTH(created_at) = 12;

-- Index on computed value:
CREATE INDEX idx_total ON line_items((quantity * unit_price));
SELECT * FROM line_items WHERE quantity * unit_price > 1000;
```

**Implementation detail**: `SHOW CREATE TABLE` reveals the hidden generated column:

```sql
SHOW CREATE TABLE users\G
-- ...
-- `email` varchar(255),
-- KEY `idx_lower_email` ((lower(`email`)))
-- ...

-- The hidden column is visible in information_schema:
SELECT COLUMN_NAME, GENERATION_EXPRESSION, IS_GENERATED
FROM information_schema.COLUMNS
WHERE TABLE_NAME = 'users' AND IS_GENERATED = 'ALWAYS';
```

>>> Interview: "A query filters on YEAR(created_at) and is doing a full table scan. How do
>>> you fix it without changing the query?" Create a functional index:
>>> `CREATE INDEX idx_year ON t((YEAR(created_at)));`. The optimizer matches the expression
>>> in the WHERE clause to the expression in the index definition. Alternatively, rewrite the
>>> query to use a range: `WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01'`
>>> to use a regular index on (created_at).

---

## 5.8 Index Fragmentation and Maintenance

### 5.8.1 Types of Fragmentation

```
INTERNAL FRAGMENTATION (within pages):

  After random deletes, pages become sparsely filled:

  LEAF PAGE (16 KB):
  [rec1 | DELETED | rec3 | DELETED | DELETED | rec6 | DELETED | rec8 | FREE SPACE]
  
  Utilization: 4 records out of capacity for 8 → 50% wasted space
  The deleted record slots are marked in the page's delete list but space
  is not immediately reclaimed by neighboring records.


EXTERNAL FRAGMENTATION (across pages):

  Logical order:   PAGE A → PAGE B → PAGE C → PAGE D  (linked list)
  Physical order:  PAGE A at offset 0x10000
                   PAGE C at offset 0x14000  ← should be B here
                   PAGE D at offset 0x18000
                   PAGE B at offset 0x1C000  ← out of order

  Impact: sequential scans (range queries) cause random I/O instead of
  sequential reads because physically adjacent pages are not logically adjacent.
  Less impactful on SSDs (no seek penalty) but still hurts prefetching.
```

### 5.8.2 Detecting Fragmentation

```sql
-- Method 1: Compare data size to allocated size
SELECT
    TABLE_NAME,
    TABLE_ROWS,
    DATA_LENGTH,                              -- clustered index size
    INDEX_LENGTH,                             -- secondary indexes total size
    DATA_FREE,                                -- free space in allocated extents
    ROUND(DATA_FREE / (DATA_LENGTH + INDEX_LENGTH) * 100, 1) AS frag_pct
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'mydb'
  AND TABLE_NAME = 'orders';

-- DATA_FREE > 20% of (DATA_LENGTH + INDEX_LENGTH) → consider defrag

-- Method 2: Tablespace file vs actual data (MySQL 8.0+)
SELECT
    NAME,
    FILE_SIZE,                                -- total file size on disk
    ALLOCATED_SIZE,                           -- allocated (sparse file support)
    FS_BLOCK_SIZE
FROM information_schema.INNODB_TABLESPACES
WHERE NAME LIKE '%orders%';

-- Method 3: Per-index statistics
SELECT
    TABLE_NAME,
    INDEX_NAME,
    STAT_NAME,
    STAT_VALUE,
    STAT_DESCRIPTION
FROM mysql.innodb_index_stats
WHERE TABLE_NAME = 'orders'
  AND STAT_NAME IN ('n_leaf_pages', 'n_diff_pfx01', 'size');

-- 'size' = total pages allocated to index
-- 'n_leaf_pages' = actual leaf pages with data
-- size >> n_leaf_pages → fragmentation
```

### 5.8.3 Maintenance Operations

**ANALYZE TABLE** — Update statistics only (fast, non-blocking):

```sql
ANALYZE TABLE orders;
-- What it does:
--   1. Samples index pages (innodb_stats_persistent_sample_pages, default 20)
--   2. Updates cardinality estimates in mysql.innodb_index_stats
--   3. Does NOT rebuild indexes or reclaim space
--   4. Does NOT lock the table (takes a brief metadata lock)
--   5. Takes milliseconds to seconds

-- When to use:
--   - After bulk INSERT/DELETE that skews statistics
--   - When EXPLAIN shows unexpected query plans
--   - After upgrading MySQL (statistics format may change)
```

**OPTIMIZE TABLE** — Full rebuild (blocking before 5.6, online in 8.0):

```sql
OPTIMIZE TABLE orders;
-- Internally equivalent to:
--   ALTER TABLE orders ENGINE=InnoDB;

-- What it does:
--   1. Creates a new .ibd file (temporary tablespace)
--   2. Reads all rows from old clustered index in PK order
--   3. Builds new B+Trees (clustered + all secondary indexes) with optimal page fill
--   4. Swaps old and new files
--   5. Drops old file

-- Properties:
--   - Reclaims fragmented space
--   - Pages become physically contiguous (fixes external fragmentation)
--   - Pages filled to ~15/16 (93.75%) — not 100%, leaves room for future inserts
--   - With innodb_online_alter_log = ON, concurrent DML is allowed (online DDL)
--   - Still requires temporary disk space ≈ table size
```

**ALTER TABLE ... FORCE** — Online DDL rebuild (MySQL 5.6+):

```sql
ALTER TABLE orders FORCE, ALGORITHM=INPLACE, LOCK=NONE;
-- Same as OPTIMIZE TABLE but explicit about:
--   ALGORITHM=INPLACE: uses online DDL (not copy-based)
--   LOCK=NONE: allows concurrent reads AND writes during rebuild

-- Online DDL workflow:
--   1. Start rebuild (build new B+Trees in background)
--   2. Concurrent DML logged to online alter log buffer
--   3. When rebuild reaches current point, apply logged DML
--   4. Brief exclusive metadata lock for swap
--   5. Swap complete, return
```

### 5.8.4 When to Defragment — Decision Framework

```
FRAGMENTATION ASSESSMENT FLOWCHART:

  1. Is query performance degrading over time?
     NO  → Don't defragment (it's working fine)
     YES → Continue

  2. Check DATA_FREE percentage:
     DATA_FREE < 10% of DATA_LENGTH → Fragmentation not the issue
     DATA_FREE > 20% of DATA_LENGTH → Continue

  3. Check index_page_splits metric:
     Low / stable → Internal fragmentation from deletes
     High / growing → PK selection issue (random UUIDs?)
       → Fix the PK choice first, then defragment

  4. Choose approach:
     Table < 10 GB → ALTER TABLE ... FORCE (fast enough)
     Table 10-100 GB → Schedule during maintenance window
                       ALTER TABLE ... FORCE, ALGORITHM=INPLACE, LOCK=NONE
     Table > 100 GB → Consider pt-online-schema-change (Percona Toolkit)
                       or gh-ost (GitHub's Online Schema Change)
                       to avoid replication lag
```

```sql
-- Percona Toolkit alternative for very large tables:
-- pt-online-schema-change creates a shadow table, copies data with chunked
-- inserts, uses triggers to capture concurrent DML, then atomic rename.
--
-- pt-online-schema-change --alter "ENGINE=InnoDB" \
--   --chunk-size 1000 --max-lag 2 \
--   D=mydb,t=orders
```

>>> Interview: "A table with 500M rows is 300 GB on disk but SHOW TABLE STATUS says data is
>>> only 180 GB. What's happening and how do you fix it?" The 120 GB difference is
>>> fragmentation (DATA_FREE + wasted space in half-empty pages from splits/deletes). Fix:
>>> `ALTER TABLE ... FORCE, ALGORITHM=INPLACE, LOCK=NONE` for online rebuild. For tables
>>> this large, use pt-online-schema-change to avoid replication lag. After rebuild, the
>>> .ibd file will shrink to ~190-200 GB (slightly more than data due to page overhead).

---

## 5.9 Putting It All Together — Index Selection Deep Dive

### 5.9.1 How the Optimizer Chooses an Index

The optimizer's index selection logic (in `sql/opt_range.cc` and `sql/sql_optimizer.cc`)
evaluates each candidate index based on estimated cost:

```
COST MODEL (simplified):

  cost(index_scan) = (rows_to_read / pages_in_index) * page_read_cost
                   + rows_to_read * row_evaluate_cost
                   + (if not covering) rows_to_read * bookmark_lookup_cost

  page_read_cost:
    - Buffer pool hit: ~0.25 (in-memory)
    - Disk read: 1.0 (default, tunable per-engine)

  row_evaluate_cost:
    - 0.1 per row (CPU cost of evaluating WHERE conditions)

  bookmark_lookup_cost:
    - Each secondary index match requires one clustered index traversal
    - Estimated as: 1 random I/O per lookup × cost_per_io
    - This is why the optimizer prefers full table scan when > ~20-30% of rows match:
      100K bookmark lookups > sequential scan of entire table

  The optimizer compares costs across:
    1. Full table scan (clustered index scan)
    2. Each applicable secondary index scan
    3. Index merge (combining multiple indexes with AND/OR)
    4. Skip scan (if leading column skippable)
```

### 5.9.2 The Index Merge Problem

```sql
-- Two separate indexes:
CREATE INDEX idx_status ON orders(status);
CREATE INDEX idx_date ON orders(created_at);

-- Query:
SELECT * FROM orders WHERE status = 'active' AND created_at > '2024-01-01';
```

```
INDEX MERGE execution:

  OPTION A: Use idx_status only
    1. Scan idx_status for 'active' → get list of PKs
    2. For each PK, bookmark lookup to clustered index
    3. Apply created_at > '2024-01-01' filter on full rows

  OPTION B: Use idx_date only
    1. Range scan idx_date from '2024-01-01' → get list of PKs
    2. For each PK, bookmark lookup
    3. Apply status = 'active' filter on full rows

  OPTION C: Index merge (intersection)
    1. Scan idx_status for 'active' → get sorted PK list L1
    2. Range scan idx_date from '2024-01-01' → get sorted PK list L2
    3. Intersect L1 ∩ L2 (merge-join on sorted PKs)
    4. Bookmark lookup only for intersected PKs

  OPTION D: Composite index INDEX(status, created_at)
    1. Single index lookup: status = 'active' AND created_at > '2024-01-01'
    2. Bookmark lookup for matching rows
    → Fewer I/Os than any of the above

  BEST: Composite index (Option D) — one B+Tree traversal, no intersection overhead.
  Index merge is a fallback when no composite index exists.
```

>>> Interview: "When should you use separate single-column indexes vs a composite index?"
>>> Almost always composite. Single-column indexes only make sense if the columns are
>>> queried independently in different queries AND you cannot afford the write overhead of
>>> a composite index. Index merge (intersection/union) is a poor substitute for a
>>> proper composite index — it reads two full index ranges and merges them, which is
>>> significantly more I/O.

### 5.9.3 Quick Reference — Index Design Checklist

```
INDEX DESIGN CHECKLIST:

  [ ] Primary Key:
      - BIGINT AUTO_INCREMENT (or INT if < 2 billion rows)
      - UUID v7 / ULID stored as BINARY(16) if distributed ID needed
      - NEVER CHAR(36) UUID — wastes space in PK and every secondary index

  [ ] Secondary Indexes:
      - Design for specific queries, not "just in case"
      - Apply ESR rule for composite indexes
      - Include covering columns if hot query pattern exists
      - Check if existing composite index already covers the query (leftmost prefix)

  [ ] Avoid:
      - Duplicate indexes (INDEX(a) is redundant if INDEX(a, b) exists)
      - Unused indexes (check sys.schema_unused_indexes in Performance Schema)
      - Over-indexing: each index adds write overhead (insert/update/delete must
        maintain every index)

  [ ] Monitor:
      - sys.schema_unused_indexes → drop unused indexes
      - sys.schema_redundant_indexes → drop duplicate indexes
      - information_schema.INNODB_METRICS → page splits, merges
      - EXPLAIN on critical queries → verify index usage
```

```sql
-- Find unused indexes (MySQL 8.0 with Performance Schema enabled):
SELECT * FROM sys.schema_unused_indexes
WHERE object_schema = 'mydb';

-- Find redundant (duplicate/subset) indexes:
SELECT * FROM sys.schema_redundant_indexes
WHERE table_schema = 'mydb';

-- Example output:
-- table_name | redundant_index | redundant_index_columns | dominant_index | dominant_index_columns
-- orders     | idx_status      | status                  | idx_status_date| status, created_at
-- → idx_status is a subset of idx_status_date → safe to drop
```

---

## 5.10 Source Code Reference Map

For readers who want to trace the code paths in MySQL 8.0 source (`github.com/mysql/mysql-server`):

```
B+TREE CORE:
  storage/innobase/btr/btr0btr.cc     — Tree structure: create, split, merge
  storage/innobase/btr/btr0cur.cc     — Cursor operations: search, insert, delete
  storage/innobase/btr/btr0pcur.cc    — Persistent cursor: store/restore position
  storage/innobase/btr/btr0sea.cc     — Adaptive hash index (AHI)

PAGE OPERATIONS:
  storage/innobase/page/page0page.cc  — Page management: create, format
  storage/innobase/page/page0cur.cc   — Page cursor: in-page search (binary search on directory)
  storage/innobase/page/page0zip.cc   — Compressed page operations

INDEX DICTIONARY:
  storage/innobase/dict/dict0dict.cc  — Data dictionary: index metadata
  storage/innobase/dict/dict0mem.cc   — In-memory index structures (dict_index_t)

BUFFER POOL (page access during traversal):
  storage/innobase/buf/buf0buf.cc     — Buffer pool: page fetch, latch management
  storage/innobase/buf/buf0rea.cc     — Read-ahead: prefetching for scans

TABLESPACE (page allocation during splits):
  storage/innobase/fsp/fsp0fsp.cc     — Tablespace: extent and page allocation
  storage/innobase/fsp/fsp0file.cc    — File management

KEY FUNCTIONS IN TRAVERSAL PATH:
  btr_cur_search_to_nth_level()       — Root-to-leaf traversal
  page_cur_search_with_match()        — Binary search within a page
  btr_page_split_and_insert()         — Page split algorithm
  btr_compress()                      — Page merge algorithm
  btr_cur_optimistic_insert()         — Try insert without split
  btr_cur_pessimistic_insert()        — Insert with potential split
  btr_pcur_store_position()           — Save cursor position
  btr_pcur_restore_position()         — Restore cursor after release
```

---

## 5.11 Interview Cheat Sheet — B+Tree and Index Structures

```
RAPID-FIRE ANSWERS:

Q: Why B+Tree over B-Tree?
A: Internal nodes store keys only (no data) → higher fanout → fewer levels → fewer I/Os.
   Leaf linked list enables range scans without re-traversing from root.

Q: How many disk reads for a point query?
A: 3-4 levels total. Root + level 1 always cached → 1-2 actual disk reads.

Q: Clustered vs secondary index?
A: Clustered = row data in leaf pages (one per table). Secondary = (indexed_cols, PK) in
   leaf pages → requires bookmark lookup to get full row.

Q: Why is UUID v4 bad as PK?
A: Random inserts → page splits → 50% page fill → write amplification → bloated
   secondary indexes. Use BIGINT AUTO_INCREMENT or UUID v7.

Q: What is a covering index?
A: Index containing all columns the query needs → no clustered index lookup → "Using index"
   in EXPLAIN.

Q: Explain the leftmost prefix rule.
A: INDEX(a,b,c) is sorted by a, then b, then c. Usable for (a), (a,b), (a,b,c).
   Not directly usable for (b), (c), (b,c) — middle columns cannot be skipped.

Q: What is the ESR rule?
A: Equality columns first, Sort columns next, Range columns last — in composite index
   design. Prevents filesort and maximizes index utilization.

Q: When does a page split happen?
A: When a record is inserted into a full page. 50/50 split for middle inserts,
   asymmetric (nearly 100/0) for rightmost inserts (AUTO_INCREMENT pattern).

Q: How do you detect index fragmentation?
A: DATA_FREE in information_schema.TABLES. Compare index 'size' vs 'n_leaf_pages' in
   innodb_index_stats. Monitor index_page_splits metric.

Q: How do you fix fragmentation?
A: ALTER TABLE ... FORCE, ALGORITHM=INPLACE, LOCK=NONE (online rebuild).
   For very large tables, pt-online-schema-change or gh-ost.

Q: What are invisible indexes?
A: MySQL 8.0 feature. Index maintained but hidden from optimizer. Test impact of
   dropping without actually dropping. ALTER INDEX ... INVISIBLE.

Q: What are functional indexes?
A: MySQL 8.0 feature. Index an expression like LOWER(email). Backed by hidden virtual
   generated column. Query must match the exact expression to use the index.
```

---

*Next: [Chapter 6 — Row Formats and Page Layout](06-row-formats-and-page-layout.md) explores
the byte-level structure of the 16 KB pages that B+Trees are built from — record headers,
the record heap, page directory mechanics, and how COMPACT, DYNAMIC, and COMPRESSED row
formats affect storage and overflow handling.*
