# Chapter 6: Row Formats and Page Layout — What a 16 KB Page Looks Like Byte-by-Byte

> Every query you run eventually reads or writes a 16 KB page. This chapter teaches you
> to read those pages like a hex dump — field by field, bit by bit. When you understand
> page structure, you stop guessing about performance and start calculating.

---

## 6.1 InnoDB Page Structure (16 KB)

InnoDB divides all tablespace files (`.ibd`) into a sequence of fixed-size pages.
The default page size is 16,384 bytes (16 KB), configurable at initialization via
`innodb_page_size` (4K, 8K, 16K, 32K, 64K). Once set, it cannot be changed without
reinitializing the data directory.

Every page — whether it holds index data, undo log records, or file space metadata —
shares the same outer envelope: a 38-byte FIL Header at the front and an 8-byte FIL
Trailer at the back. What varies is the payload between them.

For a `FIL_PAGE_INDEX` page (the B+Tree data/index page that holds your actual rows),
the full layout is:

```
+------------------------------------------------------------------+
|  Offset 0       FIL Header              38 bytes                 |
|  +---------+--------+--------+--------+--------+--------+------+ |
|  |checksum |page_no | prev   | next   |  LSN   |pg_type |space | |
|  | 4B      | 4B     | 4B     | 4B     |  8B    | 2B     | 4B   | |
|  +---------+--------+--------+--------+--------+--------+------+ |
|         (+ 4B flush_LSN + 4B space_id_or_checksum = 38B total)   |
+------------------------------------------------------------------+
|  Offset 38      Page Header             56 bytes                 |
|  +------+------+------+------+------+------+------+------+-----+ |
|  |N_DIR |HEAP  |N_HEAP|FREE  |GARB  |LAST  |DIR   |N_DIR |     | |
|  |SLOTS |TOP   |      |      |AGE   |INSERT|ECTION |_RECS|...  | |
|  | 2B   | 2B   | 2B   | 2B   | 2B   | 2B   | 2B   | 2B  |     | |
|  +------+------+------+------+------+------+------+------+-----+ |
|         (+ PAGE_MAX_TRX_ID 8B + PAGE_LEVEL 2B + INDEX_ID 8B     |
|          + seg headers 20B = 56B total)                          |
+------------------------------------------------------------------+
|  Offset 94      Infimum Record          13 bytes                 |
|  +------------------------------------------------------------+ |
|  | 5B record header | "infimum\0" (8 bytes)                    | |
|  +------------------------------------------------------------+ |
+------------------------------------------------------------------+
|  Offset 107     Supremum Record         13 bytes                 |
|  +------------------------------------------------------------+ |
|  | 5B record header | "supremum" (8 bytes, no null terminator) | |
|  +------------------------------------------------------------+ |
+------------------------------------------------------------------+
|  Offset 120     User Records            (variable, grows DOWN)   |
|  +------------------------------------------------------------+ |
|  | record_1 | record_2 | record_3 | ... | record_N             | |
|  +------------------------------------------------------------+ |
|  Each record: [var-len lengths][null bitmap][5B header][cols]    |
+------------------------------------------------------------------+
|                 Free Space              (shrinks from both ends)  |
|  +------------------------------------------------------------+ |
|  |                    (unallocated)                            | |
|  +------------------------------------------------------------+ |
+------------------------------------------------------------------+
|  Offset varies  Page Directory          (variable, grows UP)     |
|  +------------------------------------------------------------+ |
|  | slot_N | ... | slot_2 | slot_1 | slot_0                     | |
|  +------------------------------------------------------------+ |
|  Each slot = 2 bytes (offset to the "owner" record)              |
+------------------------------------------------------------------+
|  Offset 16376   FIL Trailer             8 bytes                  |
|  +------------------------------+                                |
|  | checksum (4B) | LSN low (4B) |                                |
|  +------------------------------+                                |
+------------------------------------------------------------------+
  Total: 38 + 56 + 13 + 13 + user_records + free + directory + 8 = 16384
```

The key insight is that user records grow forward (from offset 120 downward in address
space), while the page directory grows backward from offset 16376. When the two regions
meet, the page is full.

**Source**: `storage/innobase/include/page0page.h`, `storage/innobase/include/fil0fil.h`

### Page Types

The `FIL_PAGE_TYPE` field (2 bytes at offset 24 of the FIL Header) identifies the page:

| Constant                   | Value  | Purpose                                          |
|----------------------------|--------|--------------------------------------------------|
| `FIL_PAGE_INDEX`           | 17855  | B+Tree node (leaf or internal) — your row data   |
| `FIL_PAGE_RTREE`           | 17854  | R-Tree spatial index page                        |
| `FIL_PAGE_UNDO_LOG`        | 2      | Undo log page                                    |
| `FIL_PAGE_INODE`           | 3      | Index node (segment metadata)                    |
| `FIL_PAGE_TYPE_FSP_HDR`    | 8      | File space header (first page of a tablespace)   |
| `FIL_PAGE_TYPE_XDES`       | 9      | Extent descriptor page                           |
| `FIL_PAGE_TYPE_BLOB`       | 10     | Uncompressed BLOB overflow page                  |
| `FIL_PAGE_TYPE_ZBLOB`      | 11     | First page of compressed BLOB                    |
| `FIL_PAGE_TYPE_ALLOCATED`  | 0      | Freshly allocated, not yet used                  |
| `FIL_PAGE_IBUF_BITMAP`     | 5      | Change buffer bitmap                             |
| `FIL_PAGE_TYPE_SYS`        | 6      | System page (data dictionary in pre-8.0)         |
| `FIL_PAGE_SDI`             | 17853  | Serialized Dictionary Info (MySQL 8.0+)          |

>>> Interview insight: "What page types does InnoDB use?" demonstrates you understand that
>>> InnoDB's tablespace is not just data pages. Undo, inode, extent descriptor, FSP header,
>>> and BLOB overflow pages all share the same 16 KB frame with the same FIL Header/Trailer
>>> envelope. The page type field is what tells the buffer pool how to interpret the payload.

---

## 6.2 FIL Header and Trailer

The FIL (file) header and trailer wrap every page regardless of type. They provide
physical addressing, page linkage, and torn-write detection.

### FIL Header — 38 Bytes

```
Offset  Size  Field                    Description
------  ----  -----                    -----------
0       4     FIL_PAGE_SPACE_OR_CHKSUM Checksum of the page (CRC32C by default)
4       4     FIL_PAGE_OFFSET          Page number within this tablespace
8       4     FIL_PAGE_PREV            Previous page in the B+Tree leaf linked list
12      4     FIL_PAGE_NEXT            Next page in the B+Tree leaf linked list
16      8     FIL_PAGE_LSN             Log Sequence Number of most recent modification
24      2     FIL_PAGE_TYPE            Page type (see table above)
26      8     FIL_PAGE_FILE_FLUSH_LSN  Flushed-to LSN (only meaningful in first page of system tablespace)
34      4     FIL_PAGE_ARCH_LOG_NO_OR_SPACE_ID   Space ID of the tablespace
------
Total:  38 bytes
```

### FIL Trailer — 8 Bytes

```
Offset    Size  Field                  Description
------    ----  -----                  -----------
16376     4     FIL_PAGE_END_LSN_OLD_CHKSUM   Old-style checksum or low 4 bytes of CRC32C
16380     4     FIL_PAGE_LSN (low 32 bits)    Low 4 bytes of the page LSN
------
Total:    8 bytes
```

### Checksum Algorithm

The checksum protects against corrupted pages. InnoDB computes it over the entire page
(excluding the checksum fields themselves) and writes it to both the header (first 4
bytes) and the trailer (offset 16376).

`innodb_checksum_algorithm` controls the algorithm:

| Value        | Algorithm    | Notes                                            |
|-------------|-------------|--------------------------------------------------|
| `crc32`     | CRC32C      | Default since MySQL 5.7.7. Hardware-accelerated (SSE 4.2). Fast.  |
| `innodb`    | InnoDB legacy| Pre-5.7 default. Slow, CPU-intensive.            |
| `none`      | No checksum | Fastest, but no corruption detection. Testing only. |
| `strict_crc32` | CRC32C  | Like `crc32` but rejects pages with legacy checksums |

**Source**: `storage/innobase/buf/buf0checksum.cc` — `buf_calc_page_crc32()`

On modern hardware with SSE 4.2, CRC32C checksums add less than 1% CPU overhead.
There is no reason to use `none` in production.

### Prev/Next Page Pointers — Leaf Page Linked List

The `FIL_PAGE_PREV` and `FIL_PAGE_NEXT` fields form a **doubly linked list** that
connects leaf pages of a B+Tree in key order:

```
                    B+Tree internal nodes
                   /         |          \
                  v          v           v
  Leaf Page A  <-->  Leaf Page B  <-->  Leaf Page C  <-->  Leaf Page D
  (PREV=NULL)       (PREV=A)           (PREV=B)           (PREV=C)
  (NEXT=B)          (NEXT=C)           (NEXT=D)           (NEXT=NULL)
```

This linked list enables efficient **range scans**: descend the B+Tree to the starting
key, then follow `NEXT` pointers sequentially. Only leaf pages are doubly linked;
internal pages set PREV/NEXT to `FIL_NULL` (0xFFFFFFFF).

### LSN and Torn Page Detection

The `FIL_PAGE_LSN` in the header (8 bytes) records the LSN of the most recent
modification to this page. The trailer stores the **low 4 bytes** of the same LSN.

On page read, InnoDB verifies `header_LSN[low_32] == trailer_LSN[low_32]` and that
the checksum matches. If either fails, the page is corrupt — likely a **torn write**.
InnoDB recovers it from the **doublewrite buffer**.

>>> Interview insight: "How does InnoDB detect torn writes?" The answer is the
>>> LSN mismatch between header and trailer, backed by the doublewrite buffer for recovery.
>>> The checksum alone catches bit-rot; the LSN split catches partial writes. Together
>>> they provide complete page integrity verification.

**Source**: `storage/innobase/buf/buf0buf.cc` — `buf_page_is_corrupted()`

---

## 6.3 Page Header

The page header occupies bytes 38-93 (56 bytes) and contains metadata specific to
`FIL_PAGE_INDEX` pages. It tracks record counts, free space, and insertion patterns.

```
Offset  Size  Field              Description
------  ----  -----              -----------
38      2     PAGE_N_DIR_SLOTS   Number of slots in the page directory
40      2     PAGE_HEAP_TOP      Byte offset to the end of used space
                                 (i.e., start of free space, relative to page start)
42      2     PAGE_N_HEAP        Bit 15: COMPACT flag (1=COMPACT/DYNAMIC, 0=REDUNDANT)
                                 Bits 0-14: total records in heap including infimum,
                                 supremum, and delete-marked records
44      2     PAGE_FREE          Offset to first record in the free list
                                 (chain of deleted-but-not-yet-purged records)
46      2     PAGE_GARBAGE       Total bytes of delete-marked records (reclaimable space)
48      2     PAGE_LAST_INSERT   Offset of the most recently inserted record
50      2     PAGE_DIRECTION     Direction of last insert:
                                 PAGE_LEFT (1), PAGE_RIGHT (2), PAGE_NO_DIRECTION (5)
52      2     PAGE_N_DIRECTION   Number of consecutive inserts in the same direction
54      2     PAGE_N_RECS        Number of user records (excludes infimum, supremum,
                                 and delete-marked records)
56      8     PAGE_MAX_TRX_ID    Highest transaction ID that modified a record on this
                                 page. Used as MVCC optimization: if PAGE_MAX_TRX_ID
                                 < ReadView's up_limit_id, all records on the page
                                 are guaranteed visible — skip per-row visibility check.
64      2     PAGE_LEVEL         B+Tree level: 0 = leaf page, 1+ = internal pages.
                                 Root page level = tree height - 1.
66      8     PAGE_INDEX_ID      ID of the index this page belongs to
74      10    PAGE_BTR_SEG_LEAF  File segment header for leaf page segment
                                 (only meaningful in root page)
84      10    PAGE_BTR_SEG_TOP   File segment header for non-leaf page segment
                                 (only meaningful in root page)
------
Total:  56 bytes  (offset 94 = start of infimum record)
```

### Field Deep Dives

**PAGE_N_HEAP and the COMPACT flag**: Bit 15 of `PAGE_N_HEAP` is a critical flag.
When set to 1, the page uses COMPACT record format (COMPACT, DYNAMIC, or COMPRESSED
row format). When 0, it uses REDUNDANT format. This single bit determines how InnoDB
parses every record on the page.

```
PAGE_N_HEAP value 0x8005 = binary 1000 0000 0000 0101
                                   ^              ^^^
                                   |              ||| 
                           COMPACT flag=1    5 records in heap
                           (bit 15)         (bits 0-14)
```

**PAGE_FREE — The In-Page Free List**: When a record is delete-marked and subsequently
purged, its space is not immediately returned to the contiguous free space. Instead,
the record is added to a singly linked free list within the page. `PAGE_FREE` points
to the head of this list, and each freed record's `next_record` field points to the
next free record.

```
PAGE_FREE ──→ [deleted rec A] ──→ [deleted rec B] ──→ [deleted rec C] ──→ NULL
                  |                    |                    |
                 (40 bytes)          (35 bytes)          (42 bytes)
                                                    Total PAGE_GARBAGE = 117 bytes
```

When a new record is inserted and a free record of sufficient size exists, InnoDB
**reuses** the space. If no single free record is large enough, InnoDB may
**reorganize** the page (compact all live records, reclaiming all garbage space).
This reorganization is essentially a mini-defragmentation triggered by
`page_cur_insert_rec_low()` in `storage/innobase/page/page0cur.cc`.

**PAGE_DIRECTION and PAGE_N_DIRECTION**: These two fields implement an insertion
optimization. When `PAGE_DIRECTION` is `PAGE_RIGHT` (sequential inserts with
increasing keys, such as AUTO_INCREMENT), InnoDB optimizes the search for the
insertion point by checking the last-inserted position first rather than performing
a full page binary search.

```
AUTO_INCREMENT inserts:
  Insert id=101 → PAGE_LAST_INSERT points to id=101, PAGE_DIRECTION=RIGHT
  Insert id=102 → check PAGE_LAST_INSERT (id=101), key 102 > 101
                   → insert immediately after → no binary search needed
  PAGE_N_DIRECTION increments each consecutive same-direction insert
```

This is why AUTO_INCREMENT primary keys are measurably faster for inserts than random
UUIDs: the page-level insertion optimization short-circuits the search path.

**PAGE_MAX_TRX_ID — MVCC Page-Level Optimization**: This field provides a fast path
for MVCC visibility checks in **secondary index** pages. If a transaction's ReadView
indicates that `PAGE_MAX_TRX_ID` is below the view's `m_up_limit_id`, then every
record on the page was committed before any active transaction, and no per-row
`DB_TRX_ID` check is needed.

This optimization does **not** apply to clustered index pages because `PAGE_MAX_TRX_ID`
is only maintained for secondary indexes. Clustered index pages always require
per-row visibility checks via the undo log chain.

**Source**: `storage/innobase/include/page0page.h` — field offset macros `PAGE_N_DIR_SLOTS` through `PAGE_BTR_SEG_TOP`

**PAGE_LEVEL**: 0 = leaf page, N = tree height - 1 = root. A height-3 B+Tree has root
at level 2, intermediate nodes at level 1, and leaves at level 0.

---

## 6.4 Infimum and Supremum Records

Every index page contains two **virtual boundary records** at fixed positions:

```
Offset 94:   Infimum  — "smaller than any possible user record"
Offset 107:  Supremum — "larger than any possible user record"

Record layout (COMPACT format, 13 bytes each):

Infimum (offset 94):
  +---5 bytes record header---+---8 bytes value---+
  | 01 00 02 00 1C            | "infimum\0"       |
  +---------------------------+-------------------+
    n_owned=1, heap_no=0,        literal string
    record_type=2 (infimum),     (8 bytes with \0)
    next_record → first user record

Supremum (offset 107):
  +---5 bytes record header---+---8 bytes value---+
  | 05 00 03 00 00            | "supremum"        |
  +---------------------------+-------------------+
    n_owned=varies, heap_no=1,   literal string
    record_type=3 (supremum),    (8 bytes, no \0)
    next_record = 0 (end of list)
```

All user records are linked in a **singly linked list** by their `next_record` offsets,
with infimum as the head and supremum as the tail:

```
infimum → rec_1 → rec_2 → rec_3 → ... → rec_N → supremum
  (logical key order, NOT physical order on page)
```

The `next_record` offset is **relative** — it is the signed byte distance from the
current record's `next_record` field to the next record's actual data (past its
record header). This means records can be physically scattered within the user records
area but still logically ordered.

### Why Boundary Records Exist

These are **sentinel nodes** (same pattern as Linux kernel linked lists and
`java.util.LinkedList`). They eliminate special cases: insertion at the beginning just
updates infimum's `next_record`; deletion of the last record leaves supremum as a clean
terminator; the page directory always has well-defined bounds for binary search.

**Source**: `storage/innobase/page/page0page.cc` — `page_create_low()` initializes
infimum and supremum when a new page is allocated.

---

## 6.5 Row Format Variants

InnoDB supports four row formats. The row format is set per table and determines how
each record is physically encoded within a page.

```sql
CREATE TABLE t (...) ROW_FORMAT=DYNAMIC;    -- explicit
ALTER TABLE t ROW_FORMAT=COMPRESSED;         -- change existing
SHOW TABLE STATUS LIKE 't'\G                 -- check current
```

### Comparison Table

| Property              | REDUNDANT       | COMPACT          | DYNAMIC          | COMPRESSED       |
|-----------------------|-----------------|------------------|------------------|------------------|
| Introduced            | Pre-4.1         | 5.0.3            | 5.7.9 (plugin)   | 5.1 (plugin)     |
| Default in            | Never default   | 5.0 - 8.0.26     | 8.0.27+          | Never default    |
| Record header size    | 6 bytes         | 5 bytes          | 5 bytes          | 5 bytes          |
| Null bitmap           | No (stores each NULL column as its defined length of zeros) | Yes (1 bit/nullable col) | Yes | Yes |
| Var-length encoding   | Column lengths stored in offset array (all columns, fixed+variable) | 1-2 byte prefix for variable-length columns only, in reverse order | Same as COMPACT | Same as COMPACT |
| Overflow (long cols)  | First 768B inline + 20B pointer | First 768B inline + 20B pointer | 20B pointer only (all data off-page) | 20B pointer only |
| Page compression      | No              | No               | No               | Yes (zlib)       |
| Recommended           | Legacy only     | Acceptable       | Production default | Rarely          |

### REDUNDANT Format (Legacy)

Predates MySQL 4.1. Uses a 6-byte record header with absolute `next_record` offsets
and a variable-length offset array preceding the header — one entry per column
(including fixed-length columns), storing cumulative end-offsets. NULLs are represented
as zero-filled data with a high bit set in the offset entry. Wasteful by design:
a BIGINT always occupies 8 bytes, yet REDUNDANT still stores its offset.
No production system should use REDUNDANT today.

### COMPACT Format (Pre-8.0.27 Default)

Introduced in MySQL 5.0.3, COMPACT eliminated the wasteful offset array. It stores
length prefixes only for variable-length columns and encodes NULLs as a bitmap.

```
COMPACT record physical layout (on page, in this exact byte order):
                          ← stored in REVERSE column order
+--------------------------------------------------+
| var_len_N | ... | var_len_2 | var_len_1           |  Variable-length field lengths
+--------------------------------------------------+  (1 or 2 bytes each)
| NULL flags bitmap (ceil(nullable_cols / 8) bytes) |  1 bit per nullable column
+--------------------------------------------------+
| 5-byte record header                              |  See Section 6.6
+--------------------------------------------------+
|     RECORD DATA STARTS HERE (read forward)        |
+--------------------------------------------------+
| DB_ROW_ID (6B, only if no explicit PK)            |  Hidden columns
| DB_TRX_ID (6B)                                    |  (see Section 6.7)
| DB_ROLL_PTR (7B)                                  |
+--------------------------------------------------+
| col_1_data | col_2_data | ... | col_N_data        |  User column data
+--------------------------------------------------+
```

**Variable-length field lengths** are encoded as 1 or 2 bytes:
- If the maximum byte length of the column is <= 255 bytes: 1 byte for the actual length
- If the maximum byte length > 255 bytes (e.g., `VARCHAR(100)` in utf8mb4 = 400 max bytes):
  - If actual length <= 127: 1 byte (high bit = 0)
  - If actual length > 127: 2 bytes (high bit of first byte = 1)

These lengths are stored in **reverse column order** — the last variable-length column's
length appears first. This allows the record header (which is at a fixed position) to
scan backward to read lengths.

**Overflow behavior**: When a column value exceeds approximately 768 bytes, COMPACT stores
the first 768 bytes inline in the page and appends a 20-byte pointer to an overflow page
chain. This 768-byte prefix exists so that prefix indexes and short-string comparisons
can often avoid fetching the overflow page.

### DYNAMIC Format (Default Since 8.0.27)

DYNAMIC is almost identical to COMPACT in record header layout. The critical difference
is **overflow behavior**:

```
COMPACT overflow (long VARCHAR/BLOB):
  +--768 bytes inline data--+--20-byte overflow pointer--+
  → wastes in-page space for data that's already off-page

DYNAMIC overflow (long VARCHAR/BLOB):
  +--20-byte overflow pointer ONLY--+
  → all data goes to overflow pages
  → maximizes rows-per-page for tables with large columns
```

Why this matters: a table with a `TEXT` column under COMPACT format stores 768 bytes per
row inline even if the value is 10 KB. With 16 KB pages, that means only ~20 rows per
leaf page. Under DYNAMIC, only 20 bytes are stored inline, allowing potentially hundreds
of rows per page. Higher rows-per-page means higher B+Tree fanout, shallower trees,
and fewer I/O operations.

DYNAMIC still stores short values (those that fit within the page with reasonable
efficiency) inline. The engine decides at write time whether a value goes off-page
based on whether the row fits within half a page.

**Source**: `storage/innobase/row/row0mysql.cc` — `row_mysql_store_col_when_moved_off_page()`

### COMPRESSED Format

COMPRESSED applies zlib compression to the entire page. You specify a target compressed
page size via `KEY_BLOCK_SIZE`:

```sql
CREATE TABLE t (...) ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8;
-- Compressed page target: 8 KB
-- If a page compresses below 8 KB: stored in 8 KB on disk
-- If it doesn't: stored as uncompressed 16 KB (compression failure)
```

**Why COMPRESSED is rarely used**: (1) Buffer pool caches BOTH compressed and
uncompressed copies — effectively halving RAM efficiency. (2) Every read decompresses,
every write recompresses — CPU overhead. (3) A modification log within the compressed
page delays recompression but creates latency spikes when it fills. (4) If a page
doesn't compress to `KEY_BLOCK_SIZE`, InnoDB splits it. Prefer transparent page
compression (`COMPRESSION='zstd'`) with filesystem hole-punch support instead.

>>> Interview insight: "When would you use COMPRESSED row format?" Almost never. Explain
>>> the double-buffering problem: the buffer pool holds both compressed and uncompressed
>>> copies, so you trade disk space for RAM. For cold archival tables that are rarely
>>> queried, it can reduce storage cost. For active OLTP tables, DYNAMIC is strictly better.
>>> If you need compression, use transparent page compression (MySQL 5.7+) with hole-punch
>>> support from the filesystem instead.

---

## 6.6 Record Header (COMPACT/DYNAMIC Format)

In COMPACT and DYNAMIC formats, every record has a 5-byte header immediately before the
record's data. The variable-length field lengths and NULL bitmap precede this header
(growing backward), while the column data follows it (growing forward).

### Byte-Level Layout

```
Bit layout of the 5-byte (40-bit) record header:

Byte 0 (bits 0-7):      Byte 1 (bits 8-15):     Byte 2 (bits 16-23):
+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
|  unused |DM|MR| n_owned  |       heap_no (13 bits)        |  rec_type   |
|  (2b)   |1b|1b|  (4b)    |       (bits 8-20)              |  (3 bits)   |
+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+

Bytes 3-4 (bits 24-39):
+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+
|              next_record (16 bits)              |
|     signed relative offset to next record      |
+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+

Field breakdown:
  Bits 0-1:   (unused, reserved)
  Bit 2:      delete_mark — 0 = active record, 1 = delete-marked
                (purge thread later reclaims this into PAGE_FREE list)
  Bit 3:      min_rec_flag — 1 = minimum record at a non-leaf level
                (the leftmost record in each non-leaf page is flagged)
  Bits 4-7:   n_owned — number of records "owned" by this record in
                the page directory (0 for non-owner records, 1-8 for owners)
  Bits 8-20:  heap_no — physical position in the page heap (13 bits = max 8191 records)
                heap_no 0 = infimum, heap_no 1 = supremum
                user records start at heap_no 2
  Bits 21-23: record_type:
                0 = REC_STATUS_ORDINARY (regular user row)
                1 = REC_STATUS_NODE_PTR (internal B+Tree node pointer)
                2 = REC_STATUS_INFIMUM
                3 = REC_STATUS_SUPREMUM
  Bits 24-39: next_record — signed 16-bit offset from the current record's
                origin (where column data begins) to the next record's origin.
                The origin is the point between the record header and the
                column data. 0 = end of list (supremum's next_record).
```

### Concrete Example

Consider a page with three user records (keys 10, 20, 30):

```
Physical layout in memory (offsets are illustrative):

Offset 94:  [infimum header: next_record=+32] "infimum\0"
Offset 107: [supremum header: next_record=0]  "supremum"
Offset 126: [rec_1 header: heap_no=2, next_record=+38]  key=10, data...
Offset 164: [rec_3 header: heap_no=4, next_record=-38]  key=30, data...  ← inserted 3rd
Offset 202: [rec_2 header: heap_no=3, next_record=-38]  key=20, data...  ← inserted 2nd

Logical linked list (in key order via next_record):
  infimum → rec_1(key=10) → rec_2(key=20) → rec_3(key=30) → supremum
  
Physical order (by heap_no, i.e., insertion order):
  infimum, supremum, rec_1, rec_2, rec_3
```

Notice that **physical order does not match logical (key) order**. Records are appended
to the heap in insertion order, but the `next_record` chain maintains key order. This
is fundamental: InnoDB never moves records within a page to maintain sort order. It
only updates the linked list pointers.

### delete_mark vs. Actual Deletion

When you execute `DELETE FROM t WHERE id = 20`:

1. **Immediate**: The `delete_mark` bit is set to 1. The record remains physically in
   the page and stays in the `next_record` linked list.
2. **Later (purge thread)**: Once no active ReadView can see this version, the purge
   thread removes the record from the linked list and adds it to the `PAGE_FREE` chain.
   `PAGE_GARBAGE` is incremented by the record's size.

This two-phase deletion is necessary for MVCC: other transactions may still need to
see the deleted row.

```
Before DELETE:
  infimum → [10] → [20] → [30] → supremum

After DELETE (delete_mark set, before purge):
  infimum → [10] → [20, DM=1] → [30] → supremum
  (record 20 is still in the linked list — visible to older ReadViews via undo chain)

After purge:
  infimum → [10] → [30] → supremum
  PAGE_FREE → [20's space, available for reuse]
  PAGE_GARBAGE += sizeof(record_20)
```

**Source**: `storage/innobase/include/rem0rec.h` — macros `REC_NEXT`, `REC_N_OWNED`, etc.
`storage/innobase/rem/rem0rec.cc` — `rec_get_next_offs()`, `rec_set_next_offs()`

>>> Interview insight: "Why doesn't DELETE immediately free space?" Two reasons:
>>> (1) MVCC — other transactions may still need the old version. The row is delete-marked
>>> but kept until the purge thread confirms no ReadView references it.
>>> (2) Physical organization — InnoDB never moves records within a page. It uses a free
>>> list (PAGE_FREE) and only reorganizes the page when a new record cannot fit and there
>>> is enough garbage to make room.

---

## 6.7 Hidden System Columns

Every InnoDB row contains system columns that are invisible to SQL queries but physically
present in every record. Their placement and presence depend on the table's primary key
definition.

### Column Layout

```
Case 1: Table has an explicit PRIMARY KEY (most common)

  [var-len lengths][null bitmap][5B header][DB_TRX_ID 6B][DB_ROLL_PTR 7B][col1][col2]...
                                           ^              ^
                                     offset 0 of data   offset 6 of data
  
  DB_ROW_ID is NOT stored — the PK columns serve as the row identifier.
  Total hidden overhead: 13 bytes per row.


Case 2: Table has no explicit PK but has a UNIQUE NOT NULL index

  InnoDB promotes the first UNIQUE NOT NULL index to be the clustered index key.
  Same layout as Case 1 — DB_ROW_ID is NOT stored.
  Total hidden overhead: 13 bytes per row.


Case 3: Table has no PK and no UNIQUE NOT NULL index

  [var-len lengths][null bitmap][5B header][DB_ROW_ID 6B][DB_TRX_ID 6B][DB_ROLL_PTR 7B][col1][col2]...
                                            ^
                                      auto-generated 6-byte row ID
  
  InnoDB generates a monotonically increasing 6-byte row ID from a global counter
  stored in the data dictionary. This counter is shared across ALL tables without
  explicit PKs — a potential contention point under heavy concurrent inserts.
  Total hidden overhead: 19 bytes per row.
```

### Column Details

**DB_TRX_ID (6 bytes)**: The transaction ID that last modified (INSERT or UPDATE) this
row. Used by MVCC ReadView to determine visibility. 6 bytes = 48 bits = max value
2^48 = ~281 trillion transactions. At 100,000 TPS, this takes ~89 years to exhaust.

**DB_ROLL_PTR (7 bytes)**: A 7-byte pointer into the undo log. It contains:
- 1 bit: insert flag (1 = insert undo, 0 = update undo)
- 7 bits: undo log segment ID (rseg_id)
- 32 bits: page number within the undo log tablespace
- 16 bits: byte offset within the undo page

```
DB_ROLL_PTR breakdown (7 bytes = 56 bits):
+----+--------+------------------+------------------+
| IF | RSEG   | UNDO_PAGE_NO     | UNDO_PAGE_OFFSET |
| 1b | 7 bits | 32 bits          | 16 bits          |
+----+--------+------------------+------------------+
  Insert    Rollback    Page number in     Byte offset
  flag?     segment     undo tablespace    within page
```

This pointer is the entry point to the **version chain**: following it leads to the
previous version of this row, which itself has a `DB_ROLL_PTR` pointing to an even
older version, and so on — forming the MVCC undo log chain discussed in Chapter 7.

**DB_ROW_ID (6 bytes)**: Auto-generated only when the table lacks a user-defined
primary key or unique-not-null index. The global counter `dict_sys->row_id` is
incremented atomically for each new row. This counter is flushed to the system
tablespace header periodically (every 256 increments). On crash recovery, InnoDB
rounds up to the next multiple of 256 to avoid reuse.

>>> Interview insight: "What happens if a table has no primary key?" InnoDB generates a
>>> hidden 6-byte DB_ROW_ID as the clustered index key. This is always wrong in production.
>>> The global row ID counter is a contention bottleneck, the hidden PK adds 6 bytes per
>>> row, and every secondary index lookup requires the hidden PK for the bookmark lookup
>>> back to the clustered index. Always define an explicit primary key.

**Source**: `storage/innobase/include/data0type.h` — `DATA_TRX_ID`, `DATA_ROLL_PTR`, `DATA_ROW_ID` column definitions.
`storage/innobase/dict/dict0dict.cc` — `dict_table_add_system_columns()`

---

## 6.8 Overflow Pages (External Storage)

When a column value is too large to fit inline within a page while maintaining a
reasonable number of rows, InnoDB stores the value externally in **overflow pages**
(also called BLOB pages, page type `FIL_PAGE_TYPE_BLOB`).

### Decision Criteria

InnoDB tries to fit at least **two rows per page** (including the page header/trailer
overhead). If a row is too large to satisfy this constraint, the engine selects the
longest columns and moves them off-page until the row fits.

The specific behavior depends on the row format:

```
COMPACT / REDUNDANT:
  +-----------+----------------------------------------------------------+
  | Strategy  | Store first 768 bytes inline + 20-byte pointer to        |
  |           | overflow page chain                                       |
  +-----------+----------------------------------------------------------+
  | Inline    | 768 bytes (the "local prefix")                           |
  | Pointer   | 20 bytes: space_id(4) + page_no(4) + offset(4) +        |
  |           |           length(4) + extra(4)                            |
  | Overflow  | Remaining bytes in linked list of 16 KB overflow pages   |
  +-----------+----------------------------------------------------------+
  
  In-page cost per overflowed column: 768 + 20 = 788 bytes

DYNAMIC / COMPRESSED:
  +-----------+----------------------------------------------------------+
  | Strategy  | Store 20-byte pointer ONLY. All data in overflow pages.  |
  +-----------+----------------------------------------------------------+
  | Inline    | 0 bytes (nothing stored in-page for long columns)        |
  | Pointer   | 20 bytes (same structure as above)                       |
  | Overflow  | ALL bytes in linked list of 16 KB overflow pages         |
  +-----------+----------------------------------------------------------+
  
  In-page cost per overflowed column: 20 bytes
```

### Overflow Page Chain

When a column value spans multiple overflow pages, the pages form a singly linked list:

```
In-page row:  [...other cols...][20-byte overflow ptr: space_id=42, page=1000, len=40000]
                                         |
   Page 1000 (BLOB):  [FIL Hdr 38B][next=1001][16338 bytes data][FIL Trailer 8B]
   Page 1001 (BLOB):  [FIL Hdr 38B][next=1002][16338 bytes data][FIL Trailer 8B]
   Page 1002 (BLOB):  [FIL Hdr 38B][next=NULL][ 7324 bytes data][FIL Trailer 8B]
   
   Usable per overflow page: 16384 - 38 - 8 = 16338 bytes
```

### Impact on B+Tree Performance

The overflow decision has a direct impact on the B+Tree fanout:

```
Example table: CREATE TABLE docs (
  id BIGINT PRIMARY KEY,
  title VARCHAR(200),
  body TEXT            -- average 5 KB per row
);

With COMPACT (768B inline prefix):
  Row size ≈ 5B header + 13B system cols + 8B id + 200B title + 768B body prefix + 20B ptr
           = ~1014 bytes per row
  Rows per leaf page ≈ (16384 - 120 overhead) / 1014 ≈ 16 rows

With DYNAMIC (20B pointer only):
  Row size ≈ 5B header + 13B system cols + 8B id + 200B title + 20B ptr
           = ~246 bytes per row
  Rows per leaf page ≈ (16384 - 120 overhead) / 246 ≈ 66 rows

DYNAMIC packs 4x more rows per page. For a table with 10M rows:
  COMPACT: 10M / 16 = 625,000 leaf pages = ~9.5 GB
  DYNAMIC: 10M / 66 = 151,515 leaf pages = ~2.3 GB

The overflow data is the same size either way — but the B+Tree is 4x smaller,
meaning 4x fewer pages to cache in buffer pool and traverse during scans.
```

>>> Interview insight: "Why is DYNAMIC the default since 8.0.27?" Because it keeps the
>>> B+Tree compact by storing only 20-byte pointers for long columns instead of 768-byte
>>> prefixes. This means more rows per leaf page, higher fanout, shallower trees, and
>>> better buffer pool utilization. The tradeoff is that a SELECT on the BLOB column
>>> always requires following the overflow pointer — but for tables with large columns
>>> that are not always fetched, DYNAMIC is dramatically better.

**Source**: `storage/innobase/row/row0mysql.cc` — `row_mysql_store_blob_ref()`
`storage/innobase/lob/lob0lob.cc` — large object read/write paths

---

## 6.9 Page Directory

The page directory provides a **sparse index** for binary search within a page.
Without it, finding a record in a page with hundreds of rows would require a linear
scan of the entire `next_record` linked list.

### Structure

The page directory is an array of 2-byte slots stored at the end of the page (just
before the FIL Trailer), growing backward. Each slot is a page-relative offset to
an "owner" record. Slot 0 always points to infimum; the last slot always points
to supremum.

### Slot Ownership Rules

Records are grouped into "owned" sets. One record in each group is the **owner** —
the one with the highest key value in the group. The owner's `n_owned` field in the
record header stores the count of records in the group (including itself).

Slot rules enforced by InnoDB:
- **Infimum** always owns exactly **1** record (itself). It is always slot_0.
- **Supremum** owns **1 to 8** records. It is always the last slot.
- **Interior owner records** own **4 to 8** records each.

When an insertion causes a group to exceed 8 records, the group is **split**: the
middle record becomes a new owner, and a new slot is added to the directory.

When a deletion causes a group to fall below 4 records, it is **merged** with a
neighbor.

### Binary Search Within a Page

Finding a record with key `K` on a page:

```
Step 1: Binary search on page directory slots
  ┌──────────────────────────────────────────────────────┐
  │ slot_0    slot_1    slot_2    slot_3    slot_4       │
  │ (infimum) (key=15)  (key=30)  (key=50)  (supremum)  │
  │                                                      │
  │ Looking for key=25:                                  │
  │   low=0, high=4                                      │
  │   mid=2 → key=30 > 25 → high=2                      │
  │   mid=1 → key=15 < 25 → low=1                       │
  │   low=1, high=2 → answer: record is between          │
  │   slot_1 (key=15) and slot_2 (key=30)                │
  └──────────────────────────────────────────────────────┘

Step 2: Linear scan from slot_1's record following next_record links
  ┌──────────────────────────────────────────────────────┐
  │ slot_1 owner (key=15) → [key=18] → [key=22] →       │
  │   [key=25] ← FOUND! → [key=28] → slot_2 (key=30)   │
  │                                                      │
  │ Linear scan of at most 8 records (max group size)    │
  └──────────────────────────────────────────────────────┘
```

**Complexity**: Binary search over `N / 6` slots (average group size ~6) = O(log(N/6)).
Then linear scan of at most 8 records = O(1). Total: O(log N) with a small constant.

For a page holding 500 records: ~83 directory slots. Binary search: ~7 comparisons.
Then linear scan of 4-8 records. Total: ~12 key comparisons to find any record.

### Directory Size

`slots = ceil(PAGE_N_RECS / avg_group_size) + 2` where avg group size is ~5-6.
Directory bytes = slots * 2. For 400 records: ~82 slots = 164 bytes (1% of page).

**Source**: `storage/innobase/page/page0page.cc` — `page_dir_split_slot()`, `page_dir_balance_slot()`
`storage/innobase/page/page0cur.cc` — `page_cur_search_with_match()`

---

## 6.10 Calculating Row and Page Capacity

Understanding row size calculations lets you predict B+Tree height, buffer pool
requirements, and I/O patterns for a given schema.

### Row Size Formula (COMPACT/DYNAMIC)

```
row_size = variable_length_field_lengths
         + null_bitmap
         + record_header (5 bytes)
         + system_columns (DB_TRX_ID + DB_ROLL_PTR [+ DB_ROW_ID])
         + user_column_data
```

### Worked Example

```sql
CREATE TABLE users (
    id       BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name     VARCHAR(100) NOT NULL,
    email    VARCHAR(200),
    age      INT,
    status   TINYINT NOT NULL DEFAULT 1
) ROW_FORMAT=DYNAMIC ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Step-by-step calculation:

```
1. Identify variable-length columns and their max byte length:
   name:  VARCHAR(100) with utf8mb4 → max 400 bytes → needs 2-byte length prefix
   email: VARCHAR(200) with utf8mb4 → max 800 bytes → needs 2-byte length prefix
   
   Variable-length field lengths: 2 + 2 = 4 bytes
   (stored in reverse column order: email_len, name_len)

2. NULL bitmap:
   Nullable columns: email, age (2 nullable columns)
   Bitmap size: ceil(2 / 8) = 1 byte

3. Record header: 5 bytes (fixed for COMPACT/DYNAMIC)

4. System columns:
   DB_ROW_ID: NOT stored (table has explicit PK)
   DB_TRX_ID: 6 bytes
   DB_ROLL_PTR: 7 bytes
   Total: 13 bytes

5. User column data (assume realistic average values):
   id:     BIGINT = 8 bytes (fixed)
   name:   VARCHAR(100), assume avg 20 chars ASCII = 20 bytes
   email:  VARCHAR(200), assume avg 30 chars ASCII = 30 bytes
   age:    INT = 4 bytes (fixed, even if NULL — NULL is free via bitmap,
           but the space is not reserved since it IS variable in practice)
           Actually, INT is fixed-length: 4 bytes always allocated.
           When NULL: data bytes are not stored (COMPACT format skips them).
   status: TINYINT = 1 byte (fixed)

   If age is NOT NULL: 8 + 20 + 30 + 4 + 1 = 63 bytes
   If age IS NULL:     8 + 20 + 30 + 0 + 1 = 59 bytes (INT skipped)

6. Total row size (non-null case):
   4 (var-len lengths) + 1 (null bitmap) + 5 (header) + 13 (system) + 63 (data)
   = 86 bytes per row

   With alignment/overhead, actual is ~88-90 bytes (InnoDB aligns some structures).
```

### Page Capacity Calculation

```
Available space per page:
  Total page:        16384 bytes
  - FIL Header:         38 bytes
  - Page Header:        56 bytes
  - Infimum:            13 bytes
  - Supremum:           13 bytes
  - FIL Trailer:         8 bytes
  ──────────────────────────────
  Subtotal overhead:   128 bytes
  Available:         16256 bytes (for user records + page directory)

Estimating page directory overhead:
  Assume records_per_page ≈ R
  Directory slots ≈ R/5 + 2  (average 5 records per slot)
  Directory bytes ≈ (R/5 + 2) * 2

Solving for R:
  R * 86 + (R/5 + 2) * 2 ≤ 16256
  R * 86 + R * 0.4 + 4 ≤ 16256
  R * 86.4 ≤ 16252
  R ≤ 188

Approximately 188 rows per leaf page for this schema.
```

### B+Tree Height Estimation

```
Given: 10 million rows, 188 rows per leaf page

Leaf pages needed: ceil(10,000,000 / 188) = 53,192 pages

Internal (non-leaf) node pointer record size:
  = PK value (8 bytes for BIGINT) + page_pointer (4 bytes) + record header (5 bytes)
  = 17 bytes per entry in internal node

Internal node fanout:
  = 16256 / 17 ≈ 956 pointers per internal page

B+Tree height:
  Level 0 (leaf):     53,192 pages
  Level 1:            ceil(53,192 / 956) = 56 pages
  Level 2 (root):     ceil(56 / 956) = 1 page

  Height = 3 levels

  Any row lookup: 3 page reads (root → level 1 → leaf)
  Root page is always cached. Level 1 pages (56 of them) likely cached.
  → Effectively 1 disk I/O per point query on a cold leaf page.
```

### Capacity Planning Table

For the `users` table schema above (~86 bytes per row), with DYNAMIC format:

| Row Count    | Leaf Pages | Tree Height | Leaf Data Size | Buffer Pool for Full Cache |
|-------------|------------|-------------|----------------|---------------------------|
| 100,000     | 532        | 2           | 8.3 MB         | ~10 MB                    |
| 1,000,000   | 5,320      | 3           | 83 MB          | ~100 MB                   |
| 10,000,000  | 53,192     | 3           | 830 MB         | ~1 GB                     |
| 100,000,000 | 531,915    | 4           | 8.1 GB         | ~10 GB                    |
| 1,000,000,000| 5,319,149 | 4           | 81 GB          | ~100 GB                   |

The tree stays at height 3 up to ~50M rows with a BIGINT PK. Point queries remain fast
even at hundreds of millions of rows because B+Trees are remarkably shallow.

>>> Interview insight: "How many rows can fit in a 3-level B+Tree?" This depends on row
>>> size and PK size, but for typical OLTP tables with a BIGINT PK and ~100 bytes per row:
>>> ~50 million rows in a 3-level tree. The calculation is: leaf_capacity^1 * fanout^(height-1).
>>> With ~188 rows/leaf and ~956 fanout, height 3 covers 188 * 956 * 956 = ~172 million rows
>>> theoretically (though fill factor reduces this). This is the single most important number
>>> in MySQL capacity planning.

### Effect of Primary Key Size on Fanout

The primary key is duplicated in every secondary index leaf entry and in every internal
B+Tree node of the clustered index. A wider PK reduces fanout at every level:

```
PK type         PK size   Internal node record   Fanout    Max rows at height 3
────────────    ─────────  ────────────────────    ────────  ────────────────────
INT             4 bytes    4+4+5 = 13 bytes       1250      ~293M
BIGINT          8 bytes    8+4+5 = 17 bytes        956      ~172M
UUID (binary)   16 bytes   16+4+5 = 25 bytes       650      ~80M
UUID (char36)   36 bytes   36+4+5 = 45 bytes       361      ~25M
VARCHAR(255)    avg 20B    20+4+5 = 29 bytes       560      ~59M
```

`CHAR(36)` UUID PK reduces fanout by 62% versus BIGINT — more pages, deeper trees,
more I/O. Worse: every secondary index entry carries the full PK, so wider PKs bloat
all indexes.

>>> Interview insight: "Why are UUID primary keys bad for InnoDB?" Three compounding
>>> effects: (1) Random insertion causes page splits instead of sequential append,
>>> (2) 36-byte or 16-byte PK reduces B+Tree fanout versus 8-byte BIGINT,
>>> (3) Every secondary index carries the full PK, multiplying the bloat.
>>> If you must use UUIDs, store them as `BINARY(16)` using `UUID_TO_BIN()` with
>>> the time-reorder flag (MySQL 8.0+), which gives 16 bytes instead of 36 and
>>> partially sequential ordering.

---

## 6.11 Putting It All Together — Anatomy of a Complete Record

Full byte-level anatomy of a single row in a DYNAMIC-format page:

```sql
CREATE TABLE orders (
    id         BIGINT NOT NULL PRIMARY KEY,
    customer   INT NOT NULL,
    amount     DECIMAL(10,2),    -- nullable, but fixed-length internally (5 bytes)
    note       VARCHAR(500)      -- nullable, variable-length
) ROW_FORMAT=DYNAMIC;

INSERT INTO orders VALUES (42, 1001, 99.95, 'Express shipping');
```

Only truly variable-length types (VARCHAR, VARBINARY, BLOB, TEXT) get length prefixes.
DECIMAL is fixed-length in InnoDB's internal representation, so `amount` has no length
prefix despite being a non-integer type.

```
Record for (42, 1001, 99.95, 'Express shipping'):

BEFORE the origin (growing backward from record data start):
  offset -7:   [10]                  ← note var-len = 16 bytes (1 byte, 16 ≤ 127)
  offset -6:   [00]                  ← NULL bitmap: amount(bit 0)=0, note(bit 1)=0
                                        → 0x00 (ceil(2 nullable cols / 8) = 1 byte)
  offset -5:   5-byte record header  ← delete_mark=0, n_owned=0, heap_no=2,
                                        record_type=0 (ordinary), next_record=offset

AT AND AFTER the origin (offset 0 = start of column data):
  offset 0:    [00 00 00 00 00 00 00 2A]  ← id = 42 (BIGINT, 8 bytes big-endian)
  offset 8:    [xx xx xx xx xx xx]        ← DB_TRX_ID (6 bytes)
  offset 14:   [xx xx xx xx xx xx xx]     ← DB_ROLL_PTR (7 bytes)
  offset 21:   [00 00 03 E9]             ← customer = 1001 (INT, 4 bytes)
  offset 25:   [80 00 00 27 0F]          ← amount = 99.95 (DECIMAL(10,2), 5 bytes)
  offset 30:   [45 78 70 72 65 73 73 20   ← "Express shipping" (note, 16 bytes UTF-8)
                73 68 69 70 70 69 6E 67]
  offset 46:   ← end of record

Total record size: 7 (before origin) + 46 (from origin) = 53 bytes
```

Linearized view:

```
+----------+----------+---------+-----+--------+--------+----------+--------+------------------+
| note_len | null_bmp | rec_hdr | id  |TRX_ID  |ROLL_PTR| customer | amount | note             |
| 1B       | 1B       | 5B      | 8B  | 6B     | 7B     | 4B       | 5B     | 16B              |
+----------+----------+---------+-----+--------+--------+----------+--------+------------------+
  ← before origin                | origin →                                       53 bytes total
```

### Inspecting Pages

```bash
# Jeremy Cole's innodb_ruby:
innodb_space -f orders.ibd space-page-type-regions   # page type summary
innodb_space -f orders.ibd -p 3 page-dump            # full page dump
innodb_space -f orders.ibd -p 3 page-records          # record listing

# MySQL 8.0+ built-in:
ibd2sdi orders.ibd                                    # schema metadata from SDI pages

# Raw hex inspection (page 3 starts at offset 49152 = 3 * 16384):
xxd -s 49152 -l 16384 orders.ibd | head -40
# Bytes 24-25: page type 45 BF = 17855 = FIL_PAGE_INDEX
```

---

## 6.13 Summary — Key Numbers to Remember

```
┌──────────────────────────────────────────────────────────────────┐
│  InnoDB Page Layout — Numbers That Matter                        │
├──────────────────────────────────────────────────────────────────┤
│  Page size:              16,384 bytes (16 KB)                    │
│  FIL Header:             38 bytes                                │
│  FIL Trailer:            8 bytes                                 │
│  Page Header:            56 bytes                                │
│  Infimum + Supremum:     26 bytes (13 + 13)                      │
│  Fixed overhead:         128 bytes per page                      │
│  Usable space:           ~16,256 bytes (minus directory)         │
│                                                                  │
│  Record header:          5 bytes (COMPACT/DYNAMIC)               │
│  System columns:         13 bytes (TRX_ID + ROLL_PTR)            │
│  System columns (no PK): 19 bytes (+ ROW_ID)                    │
│                                                                  │
│  Page directory slot:    2 bytes                                  │
│  Records per slot:       4-8 (avg ~5-6)                          │
│                                                                  │
│  Overflow pointer:       20 bytes                                │
│  COMPACT inline prefix:  768 bytes (before overflow)             │
│  DYNAMIC inline prefix:  0 bytes (pointer only)                  │
│                                                                  │
│  Typical BIGINT PK fanout: ~956 per internal node               │
│  Typical leaf capacity:    150-500 rows (depends on row size)    │
│  Height 3 covers:          up to ~50-170M rows (BIGINT PK)       │
│  Height 4 covers:          up to ~50-160B rows (BIGINT PK)       │
└──────────────────────────────────────────────────────────────────┘
```

>>> Final interview insight: Page layout knowledge separates senior engineers from staff
>>> engineers. When someone asks "why is this query slow?", a staff engineer thinks in
>>> pages: How many rows fit per page? What is the tree height? Is the working set in the
>>> buffer pool? Are overflow pages causing extra I/O? Is the page directory search
>>> efficient? These are not abstract concepts — they are byte-counted realities that
>>> directly determine whether your query takes 1ms or 100ms.
