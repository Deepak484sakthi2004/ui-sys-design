# Chapter 8: Write-Ahead Logging — Redo Log and Crash Recovery

> How does InnoDB survive a power failure mid-write?
>
> This chapter traces the path of a redo log record from its birth inside a
> mini-transaction, through the log buffer, to stable storage, and finally
> through crash recovery replay. Every data structure, every LSN watermark,
> and every background thread is examined at the level of the engine source.

---

## 1. The WAL Protocol — Why Write-Ahead Logging Exists

### 1.1 The Fundamental Problem

InnoDB keeps hot pages in the buffer pool (RAM). A `UPDATE accounts SET balance = balance - 100 WHERE id = 7` modifies the page in memory, marking it **dirty** — its in-RAM content diverges from the on-disk copy. If the server process crashes or power is cut before that dirty page is flushed to the `.ibd` file, the modification vanishes. The transaction committed, the client received `OK`, and the data is gone.

The naive fix — flush every modified page to its data file at commit time — is catastrophically slow. A single 16 KB page write to a random location on an SSD takes ~50-100 us. A transaction that touches 200 pages across 30 indexes would need 200 random writes before returning `COMMIT OK`. Throughput collapses.

### 1.2 The WAL Guarantee

Write-Ahead Logging introduces a single, inviolable rule:

```
BEFORE any dirty page is written to its data file on disk,
ALL redo log records describing modifications to that page
MUST already be durable on stable storage.
```

This is the **WAL rule** (also called the **write-ahead property**). It decouples the question "is the modification durable?" from the question "has the data file page been updated?"

Why this works: redo log writes are **sequential appends** to a small set of dedicated files. Modern storage can sustain 200,000+ sequential IOPS versus 20,000-50,000 random IOPS. A single `fsync` of a 4 KB redo log block can durably commit the effect of modifications spanning hundreds of scattered data pages.

```
Without WAL:
  COMMIT → flush page-1 (random) → flush page-2 (random) → ... → flush page-N → OK
  Cost: N random writes, each ~50-100 us

With WAL:
  COMMIT → append redo records to log buffer → fsync log (sequential) → OK
  Background: lazily flush dirty pages later
  Cost: 1 sequential write, ~10-20 us for group commit batch
```

### 1.3 Force-at-Commit

Durability requires one additional rule: the redo log records for a committed transaction must be **forced to stable storage at commit time** (with `innodb_flush_log_at_trx_commit = 1`). If the log records sit only in the OS page cache when the machine loses power, they are lost and the committed transaction's effects disappear.

This is called the **force-at-commit** policy. InnoDB implements it via `fsync()` (or `fdatasync()`, or `O_DIRECT` depending on `innodb_flush_method`) at transaction commit.

### 1.4 Steal / No-Force Policy

Database buffer management is characterized by two orthogonal choices:

```
                     FORCE                    NO-FORCE
              (flush dirty pages at     (don't force page flush
               commit time)              at commit; flush lazily)
  +-----------+------------------------+------------------------+
  | STEAL     | STEAL + FORCE          | STEAL + NO-FORCE       |
  | (can flush| Pages always current   | InnoDB's policy.       |
  |  uncommit-| on disk. No redo       | Redo log needed for    |
  |  ted pages| needed. Undo needed    | committed-but-unflushed|
  |  to disk) | for rollback.          | pages. Undo needed for |
  |           |                        | uncommitted-but-flushed|
  +-----------+------------------------+------------------------+
  | NO-STEAL  | NO-STEAL + FORCE       | NO-STEAL + NO-FORCE    |
  | (never    | Simplest: no redo, no  | Redo needed; no undo   |
  |  flush    | undo. But requires     | needed. Impractical    |
  |  uncommit-| pinning all dirty      | (memory pressure).     |
  |  ted)     | pages in RAM.          |                        |
  +-----------+------------------------+------------------------+
```

InnoDB uses **STEAL + NO-FORCE**:

- **STEAL**: a dirty page belonging to an uncommitted transaction CAN be evicted from the buffer pool and written to disk. This is essential — you cannot pin every dirty page in RAM indefinitely. If the transaction later rolls back, the undo log reverses the changes.
- **NO-FORCE**: dirty pages are NOT forced to their data files at commit time. Only redo log records are forced. Pages are flushed lazily by the page cleaner threads.

This combination demands both redo log (for crash recovery of committed-but-unflushed data) and undo log (for rollback of uncommitted-but-already-flushed data).

>>> **Interview insight**: "Why does InnoDB need both redo and undo logs?" is a frequent question. The answer flows directly from the STEAL + NO-FORCE policy. STEAL means an uncommitted transaction's page changes can reach disk (requiring undo to roll back on crash). NO-FORCE means a committed transaction's page changes might NOT be on disk yet (requiring redo to replay on crash). Neither log alone is sufficient.

---

## 2. Redo Log Record Format

### 2.1 Physical vs. Logical Logging

InnoDB uses **physical logging**: each redo record describes a physical modification to a specific byte range within a specific page. It does NOT log the SQL statement or even the logical operation ("insert row with key 42"). Instead, it logs something like "at page (space=5, page_no=1037), offset 184, write these 23 bytes."

Why physical logging:
- **Simpler recovery**: replay is a blind byte-copy. No need to re-evaluate SQL, check constraints, or acquire locks.
- **Idempotent**: applying the same physical redo record twice produces the same result. This eliminates the need for complex "was this already applied?" tracking during recovery.
- **Deterministic size**: the redo record size depends on the physical change, not on the complexity of the SQL.

Source: `storage/innobase/include/mtr0types.h` defines all record types.

### 2.2 Record Types

Each redo record begins with a 1-byte type field. Key types:

```
Type Constant              Value  Meaning
---------------------------------------------------------------------
MLOG_1BYTE                  1    Write 1 byte at given offset
MLOG_2BYTES                 2    Write 2 bytes at given offset
MLOG_4BYTES                 4    Write 4 bytes at given offset
MLOG_8BYTES                 8    Write 8 bytes at given offset
MLOG_WRITE_STRING          30    Write N bytes at given offset
MLOG_COMP_REC_INSERT       38    Insert a compact-format record
MLOG_COMP_REC_DELETE       42    Delete a compact-format record
MLOG_COMP_PAGE_CREATE      58    Create a new compact page
MLOG_COMP_REC_UPDATE_IN_PLACE  56  Update record in place
MLOG_UNDO_INSERT           18    Insert undo log record
MLOG_INIT_FILE_PAGE2       51    Initialize a data file page
MLOG_MULTI_REC_END         31    End of multi-record group
MLOG_COMP_LIST_START_DELETE 44   Delete multiple consecutive records
MLOG_COMP_LIST_END_DELETE   43   End of range delete
```

### 2.3 Record Structure

```
+------+------------+------------+------------------+
| type | space_id   | page_no    | body             |
| 1B   | compressed | compressed | variable length  |
+------+------------+------------+------------------+
```

- **type**: 1-byte record type from the table above
- **space_id**: tablespace identifier, compressed using InnoDB's variable-length integer encoding (1-5 bytes)
- **page_no**: page number within the tablespace, also compressed (1-5 bytes)
- **body**: type-specific payload. For `MLOG_WRITE_STRING`: offset (2 bytes) + length (2 bytes) + data (N bytes). For `MLOG_COMP_REC_INSERT`: compressed record metadata + record bytes.

Source: `mtr0log.cc:mlog_write_initial_log_record_fast()` writes the header; type-specific functions append the body.

### 2.4 Mini-Transactions (mtr) and Record Groups

A single user-level operation (e.g., inserting a row) may modify multiple pages atomically — the leaf page, possibly a parent internal page if a page split occurs, the undo log page, etc. InnoDB groups these related modifications into a **mini-transaction (mtr)**.

An mtr collects redo records in a local buffer (`mtr_t::m_log`). When the mtr commits, the entire batch is copied to the global log buffer atomically and terminated with `MLOG_MULTI_REC_END` (if there are multiple records) or has a special flag set in the type byte (if there is only one record).

```
Single mtr → multiple redo records → single atomic group in log buffer:

  +---------+---------+---------+---------------------+
  | record1 | record2 | record3 | MLOG_MULTI_REC_END  |
  +---------+---------+---------+---------------------+
  <---- one mtr, applied atomically during recovery ---->
```

During crash recovery, InnoDB only replays complete mtr groups. If the log ends mid-group (torn write), the partial group is discarded. This guarantees atomic page-level modifications.

Source: `mtr0mtr.cc:mtr_t::Command::execute()` handles the commit logic.

>>> **Interview insight**: "What is the unit of atomicity in InnoDB's redo log?" The answer is the mini-transaction (mtr), not the user transaction. A single `INSERT` may generate multiple mtrs (one for the clustered index insert, one for each secondary index insert, one for the undo log record). Each mtr is independently atomic in the redo log.

---

## 3. Log Buffer

### 3.1 Structure

The log buffer is a contiguous in-memory region where redo records are staged before being written to redo log files on disk.

```
innodb_log_buffer_size = 16 MB  (default; tunable)
```

Internal structure (simplified):

```
log_sys->buf (log buffer start)
  |
  v
  +================================================================+
  |  already written  |  pending records   |    free space          |
  |  to disk          |  from active mtrs  |                       |
  +================================================================+
  ^                   ^                    ^                        ^
  |                   |                    |                        |
  buf_start       write position       buf_free                 buf_end
                  (log.write_lsn)    (next write pos)
```

- **`log_sys->buf`**: base pointer to the allocated buffer
- **`log_sys->buf_free`**: byte offset of the next free position (where the next mtr will copy its records)
- Written regions are flushed to disk by the log writer thread

### 3.2 Concurrent Access

Multiple transactions execute concurrently, each generating redo records from their mtrs. When an mtr commits, it must copy its local redo buffer into the global log buffer.

**Pre-8.0.30**: the `log_sys->mutex` serializes access. Each mtr commit:
1. Acquires `log_sys->mutex`
2. Reserves space: advances `log_sys->buf_free` by the mtr's log size
3. Copies mtr log records into the reserved region
4. Releases `log_sys->mutex`

This mutex becomes a scalability bottleneck under high concurrency.

**MySQL 8.0.30+**: lock-free log buffer writes using **atomic reservation**:
1. `log_sys->sn` (sequence number) is atomically incremented by the mtr's log size using `fetch_add`
2. The returned old value tells the mtr exactly where to write
3. Multiple mtrs copy their records in parallel to non-overlapping regions
4. A `recent_written` link-buf tracks which regions are complete, so the log writer knows how far it can safely write to disk

Source: `log0buf.cc:log_buffer_reserve()`, `log0write.cc:log_writer_write_buffer()`

```
Lock-free log buffer (8.0.30+):

Thread A:  atomic_fetch_add(sn, 200) → got offset 1000
Thread B:  atomic_fetch_add(sn, 150) → got offset 1200
Thread C:  atomic_fetch_add(sn, 300) → got offset 1350

Each thread copies to its slot independently:
  +============+=========+=============+---------+
  | ...written | A: 200B | B: 150B     | C: 300B |
  +============+=========+=============+---------+
  1000         1200      1350          1650

recent_written link-buf tracks completion:
  A done? yes  B done? yes  C done? no → writer can flush up to 1350
  C done? yes → writer can now flush up to 1650
```

### 3.3 When the Log Buffer Flushes

The log buffer is flushed to redo log files in these situations:
1. **Transaction commit** (with `innodb_flush_log_at_trx_commit = 1`)
2. **Log buffer half full**: background flush to prevent overflow
3. **Every second**: the log writer thread flushes at least once per second regardless
4. **Checkpoint advance**: requires flushed redo log up to the checkpoint LSN
5. **Dirty page flush**: WAL rule requires the page's redo records to be on disk before the page itself

---

## 4. LSN (Log Sequence Number)

### 4.1 Definition

The LSN is a **monotonically increasing 64-bit integer** representing a byte offset into the abstract, infinite redo log stream. It never wraps — even though the physical redo log files are circular, the LSN marches forward indefinitely.

When InnoDB starts for the first time, the LSN begins at a fixed value (typically `LOG_START_LSN = 16 * 512 = 8192` to account for log file headers). Every byte of redo log data consumed advances the LSN by one.

Source: `log0types.h` defines `lsn_t` as `uint64_t`.

### 4.2 Key LSN Watermarks

```
LSN Timeline (increasing →)
|                                                              |
|    checkpoint_lsn      write_lsn    flushed_to_disk_lsn  current_lsn
|         |                  |               |                  |
v         v                  v               v                  v
+---------+------------------+---------------+------------------+
| Already | Dirty pages      | Written to OS | In log buffer,   |
| flushed | flushed, redo    | page cache,   | not yet written  |
| to data | log reclaimable  | not yet       | to OS            |
| files   | after this point | fsynced       |                  |
+---------+------------------+---------------+------------------+
          ^                                                     ^
          |                                                     |
   Redo log space before         Redo log space after
   here can be overwritten       here is active / needed
```

| LSN Watermark | Variable | Meaning |
|---------------|----------|---------|
| `checkpoint_lsn` | `log.last_checkpoint_lsn` | All dirty pages with `oldest_modification <= checkpoint_lsn` have been flushed to data files. Redo log before this point can be overwritten. |
| `write_lsn` | `log.write_lsn` | Redo records up to this LSN have been written to OS (via `write()`), but not necessarily `fsync()`-ed. Survives MySQL crash but not OS crash. |
| `flushed_to_disk_lsn` | `log.flushed_to_disk_lsn` | Redo records up to this LSN have been `fsync()`-ed to stable storage. Survives any crash. |
| `current_lsn` | `log.current_lsn` (or `log_sys->lsn`) | The LSN of the most recently added redo record. May still be in log buffer only. |

### 4.3 Page-Level LSNs

Every buffer pool page carries two LSN values:

- **`oldest_modification` (also `oldest_lsn`)**: the LSN of the **first** modification to this page since it was last clean (read from disk or flushed). This determines the page's position in the flush list (sorted by `oldest_modification`).
- **`newest_modification`**: the LSN of the **most recent** modification. Stored in the page header on disk as `FIL_PAGE_LSN`. During recovery, InnoDB compares the page's on-disk `FIL_PAGE_LSN` with the redo record's LSN — if the page's LSN >= the record's LSN, the record is skipped (already applied).

```
Page lifecycle:

  Read from disk (clean)    First modification      More modifications
  oldest_modification = 0   oldest_modification =   newest_modification
  newest_modification =     LSN_100                 advances to LSN_250
  on_disk_LSN                                       
       |                         |                        |
       v                         v                        v
  +--------+              +--------+                +--------+
  | clean  |  -------->   | dirty  |  -------->     | dirty  |
  | page   |   INSERT     | page   |   UPDATE       | page   |
  +--------+              +--------+                +--------+
                          added to flush             stays in flush
                          list at LSN_100            list at same position
```

### 4.4 LSN Arithmetic

Since the LSN is a byte offset into the log stream but the physical log files have headers and block structure, InnoDB maintains two parallel counters:

- **`sn` (sequence number)**: counts only user payload bytes (no headers/trailers)
- **`lsn`**: counts all bytes including log block headers (12 bytes) and trailers (4 bytes) per 512-byte block

Conversion: `log_translate_sn_to_lsn(sn)` accounts for the overhead of block headers/trailers. For every 496 bytes of payload, the LSN advances by 512 bytes.

```
One log block (512 bytes):
+------------------+----------------------------+-------------------+
| Block Header     |       Payload              |  Block Trailer    |
|   12 bytes       |       496 bytes            |    4 bytes        |
+------------------+----------------------------+-------------------+

sn advances by 496 for this block
lsn advances by 512 for this block
```

---

## 5. Flushing — innodb_flush_log_at_trx_commit

### 5.1 The Most Important Durability Knob

This single parameter controls the tradeoff between durability and performance for every transaction:

```
+-------+----------------------------+--------------------+---------------------+
| Value | Behavior at COMMIT         | Survives           | Potential Data Loss |
+-------+----------------------------+--------------------+---------------------+
|   1   | write() + fsync() to       | MySQL crash,       | None (full ACID)    |
|       | redo log file              | OS crash, power    |                     |
|       |                            | failure            |                     |
+-------+----------------------------+--------------------+---------------------+
|   2   | write() to OS page cache   | MySQL crash         | Up to 1 second of  |
|       | fsync() once per second    | (NOT OS crash,     | committed txns on   |
|       |                            | NOT power failure) | OS crash/power loss |
+-------+----------------------------+--------------------+---------------------+
|   0   | Don't even write() to OS   | Nothing guaranteed | Up to 1 second of   |
|       | Buffer in log buffer only  |                    | committed txns on   |
|       | write()+fsync() once/sec   |                    | any crash           |
+-------+----------------------------+--------------------+---------------------+
```

Source: `trx0trx.cc:trx_commit_complete_for_mysql()` checks `srv_flush_log_at_trx_commit` and calls the appropriate flush function.

### 5.2 Performance Impact

With `innodb_flush_log_at_trx_commit = 1` and no group commit optimization, each transaction requires its own `fsync()`. A high-end NVMe SSD can sustain ~50,000 fsync/s. That caps throughput at ~50,000 TPS for serial single-row transactions. On spinning disk: ~200 fsync/s = ~200 TPS.

This is why group commit is critical.

### 5.3 Group Commit

Even with `= 1`, InnoDB batches multiple transactions' redo records into a single `fsync()`. The mechanism:

1. Transaction T1 finishes writing redo records and wants to commit
2. T1 becomes the **group leader** and prepares to fsync
3. While T1 prepares, T2 and T3 also finish writing redo records
4. T1's fsync covers all redo data up to `current_lsn`, which includes T2 and T3
5. T2 and T3 wake up, see that `flushed_to_disk_lsn >= their commit_lsn`, and return success without issuing their own fsync

```
Timeline:
  T1: write redo ─────── fsync() ─────── done
  T2:    write redo ──── (waits) ─────── sees flushed_lsn >= own → done
  T3:       write redo ─ (waits) ─────── sees flushed_lsn >= own → done
                         ^
                    single fsync covers T1+T2+T3
```

In MySQL 8.0.30+, dedicated threads handle this:
- **Log writer thread**: calls `write()` to transfer log buffer to OS page cache
- **Log flusher thread**: calls `fsync()` to force OS page cache to stable storage
- **Log write notifier**: wakes transactions waiting for `write_lsn` to advance
- **Log flush notifier**: wakes transactions waiting for `flushed_to_disk_lsn` to advance

Source: `log0write.cc:log_writer()`, `log0write.cc:log_flusher()`

### 5.4 sync_binlog Interaction

For replication, MySQL writes both the InnoDB redo log and the binary log. The **two-phase commit** (internal XA) coordinates them:

```
Phase 1 (PREPARE):
  1. InnoDB writes redo records for the transaction
  2. InnoDB marks transaction as PREPARED in redo log
  3. Flush redo log to disk (fsync)

Phase 2 (COMMIT):
  4. MySQL server writes transaction to binary log
  5. fsync binary log (if sync_binlog = 1)
  6. InnoDB marks transaction as COMMITTED in redo log
```

The interaction of `innodb_flush_log_at_trx_commit` and `sync_binlog`:

```
+---------+-------------+-------------------------------------------+
| flush.. | sync_binlog | Effect                                    |
+---------+-------------+-------------------------------------------+
|    1    |      1      | Maximum durability. Two fsyncs per group   |
|         |             | commit (redo log + binlog). The "gold      |
|         |             | standard" for primaries with replicas.     |
+---------+-------------+-------------------------------------------+
|    1    |      0      | Redo log durable, but binlog may lag.      |
|         |             | On crash: redo recovery works, but         |
|         |             | replica may be ahead of recovered primary. |
+---------+-------------+-------------------------------------------+
|    2    |      1      | Binlog durable, redo log may lose 1s.      |
|         |             | Inconsistent — avoid.                      |
+---------+-------------+-------------------------------------------+
|    0    |      0      | Maximum performance, minimum durability.   |
|         |             | Acceptable only for throw-away data.       |
+---------+-------------+-------------------------------------------+
```

>>> **Interview insight**: "What settings would you use for a financial application's MySQL primary?" The answer is `innodb_flush_log_at_trx_commit = 1` AND `sync_binlog = 1`. Then explain why: this ensures both the redo log and binary log are durable at commit. On crash, the internal XA recovery can reconcile the two logs. Without both, you risk data committed in one log but not the other, leaving replication in an inconsistent state.

---

## 6. Redo Log File Structure (Pre-8.0.30)

### 6.1 Circular Ring of Files

The redo log is stored as a set of fixed-size files that together form a circular buffer:

```
innodb_log_file_size = 1G              (size of each file)
innodb_log_files_in_group = 2          (number of files; default 2)
Total redo log capacity = 2 GB

File layout on disk:
  ib_logfile0 (1 GB)     ib_logfile1 (1 GB)
  +------------------+   +------------------+
  |  header (2 KB)   |   |  header (2 KB)   |
  |  log blocks...   |   |  log blocks...   |
  |                  |   |                  |
  +------------------+   +------------------+

Logical ring:
  +-----------+-----------+
  |ib_logfile0|ib_logfile1|-------> wraps back to ib_logfile0
  +-----------+-----------+
```

The write position wraps around: after filling `ib_logfile1`, writes continue at the beginning of `ib_logfile0` (skipping the header). This is safe only because redo log space behind the `checkpoint_lsn` is no longer needed.

### 6.2 Log File Header

Each redo log file begins with a 2 KB header consisting of 4 blocks of 512 bytes each:

```
Offset  Size   Field
------  ----   -----
Block 0 (512 bytes): Log File Header
  0       4    LOG_HEADER_FORMAT (format version; 1 = 5.7, 8 = 8.0)
  4       4    LOG_HEADER_PAD1
  8       8    LOG_HEADER_START_LSN (LSN of first log block after header)
  16     32    LOG_HEADER_CREATOR (string: "MySQL 8.0.30" or similar)
  48      4    LOG_HEADER_FLAGS
  ...rest padding to 512 bytes...

Block 1 (512 bytes): Checkpoint Field 1
  0       8    checkpoint_no (alternating counter)
  8       8    checkpoint_lsn
  16      8    checkpoint_offset (byte offset in log files)
  24      8    checkpoint_log_buf_size
  ...
  508     4    LOG_BLOCK_CHECKSUM

Block 2 (512 bytes): Empty / reserved

Block 3 (512 bytes): Checkpoint Field 2
  (same structure as Block 1, alternating writes)
```

### 6.3 Two Checkpoint Fields

InnoDB maintains two checkpoint fields and alternates writes between them. Each checkpoint write includes a `checkpoint_no` (monotonically increasing). On recovery, InnoDB reads both and uses the one with the higher `checkpoint_no`.

Why two fields: if the system crashes mid-write of a checkpoint record, the other field still holds a valid, older checkpoint. At least one checkpoint is always consistent.

```
Checkpoint write alternation:

  Time →    t1        t2        t3        t4
  Field 1:  CP#10     CP#10     CP#12     CP#12
  Field 2:  CP#9      CP#11     CP#11     CP#13
                ^writes here     ^writes here
```

Source: `log0chkp.cc:log_files_write_checkpoint()`

### 6.4 Log Block Structure

The redo log is organized in 512-byte blocks (matching traditional disk sector size for atomic writes):

```
Log Block (512 bytes = OS_FILE_LOG_BLOCK_SIZE):
+-------------------------------------------------------------------+
| Block Header (12 bytes)                                           |
|   +--------------------+--------+-----------+-------------------+ |
|   | LOG_BLOCK_HDR_NO   | ..._   | HDR_DATA  | FIRST_REC_GROUP   | |
|   | (4 bytes)          | FLUSH  | _LEN (2B) | (2 bytes)         | |
|   | block number +     | (bit)  | bytes used| offset of first   | |
|   | flush flag         |        | in block  | mtr group start   | |
|   +--------------------+--------+-----------+-------------------+ |
+-------------------------------------------------------------------+
| Payload (496 bytes)                                               |
|   Redo log records (may span multiple blocks)                     |
+-------------------------------------------------------------------+
| Block Trailer (4 bytes)                                           |
|   LOG_BLOCK_CHECKSUM: CRC-32C of the entire block                 |
+-------------------------------------------------------------------+
```

- **`LOG_BLOCK_HDR_NO`**: block sequence number. The highest bit is the **flush flag** — set to 1 for the first block of a write batch (used to detect boundaries during recovery).
- **`LOG_BLOCK_HDR_DATA_LEN`**: how many bytes of this block contain valid data. A block may be partially filled if it's the last block written.
- **`LOG_BLOCK_FIRST_REC_GROUP`**: byte offset within the block where the first mtr group boundary falls. Used during recovery to find the start of an mtr group that begins in this block.
- **`LOG_BLOCK_CHECKSUM`**: CRC-32C checksum for integrity verification.

Redo records are packed contiguously across blocks without alignment padding. A single record can span two blocks.

```
Block N                          Block N+1
+-------+-----+--------+        +-------+--+------------+--------+
| hdr   | rec | rec    |        | hdr   |  | rec3       | trailer|
|       | 1   | 2 (part|------->|       |2 |            |        |
|       |     |  1)    |        |       |pt|            |        |
+-------+-----+--------+        +-------+2-+------------+--------+
               ^  rec2 spans two blocks
```

---

## 7. Redo Log Architecture (MySQL 8.0.30+)

### 7.1 What Changed

MySQL 8.0.30 overhauled the redo log subsystem. The key differences:

| Aspect | Pre-8.0.30 | 8.0.30+ |
|--------|-----------|---------|
| Configuration | `innodb_log_file_size` + `innodb_log_files_in_group` | Single: `innodb_redo_log_capacity` |
| File location | Data directory (`ib_logfile0`, `ib_logfile1`) | `#innodb_redo/` subdirectory |
| File management | Fixed files, manual sizing | InnoDB auto-manages files |
| Resizing | Requires restart | Dynamic, no restart |
| File naming | `ib_logfile0`, `ib_logfile1` | `#ib_redo0`, `#ib_redo1`, ..., `#ib_redo31` |
| Spare files | None | Pre-created spare files for fast rotation |
| Writer threads | Single log writer | Multiple dedicated threads |

### 7.2 File Management

```
#innodb_redo/ directory:

  #ib_redo0    (active, being written to)
  #ib_redo1    (active, filled, waiting for checkpoint to reclaim)
  #ib_redo2    (active, filled)
  #ib_redo3_tmp  (spare file, pre-created, renamed to active when needed)
  #ib_redo4_tmp  (spare file)
```

Files with `_tmp` suffix are **spare files** pre-allocated by InnoDB. When the current active file is full, a spare file is instantly renamed (dropping the `_tmp` suffix) and becomes the new write target. This avoids the latency of allocating and formatting a new file.

Files behind the checkpoint (fully flushed to data files) are renamed back to `_tmp` suffix and recycled as spares.

```
File lifecycle:

  spare (_tmp) ──rename──> active (write target) ──filled──> active (waiting)
       ^                                                          |
       |                                                          | checkpoint
       +──────────────── rename back to _tmp ─────────────────────+
```

### 7.3 Dedicated Log Threads (8.0.30+)

The redo log subsystem uses five dedicated threads, each with a single responsibility:

```
mtr commit
    |
    v
  [Log Buffer]  ───────>  log_writer  ───write()──>  OS page cache
                                                         |
                                                    log_flusher  ───fsync()──>  disk
                                                         |
                                            log_write_notifier (wakes txns
                                              waiting for write_lsn)
                                                         |
                                            log_flush_notifier (wakes txns
                                              waiting for flushed_to_disk_lsn)
                                                         |
                                            log_checkpointer (advances
                                              checkpoint_lsn periodically)
```

| Thread | Responsibility | Wakes when |
|--------|---------------|------------|
| `log_writer` | Copies from log buffer to OS via `write()` | New data in log buffer (via `recent_written` link-buf) |
| `log_flusher` | Calls `fsync()` on redo log files | `write_lsn` advances beyond `flushed_to_disk_lsn` |
| `log_write_notifier` | Wakes user threads waiting for `write_lsn >= X` | `write_lsn` advances |
| `log_flush_notifier` | Wakes user threads waiting for `flushed_to_disk_lsn >= X` | `flushed_to_disk_lsn` advances |
| `log_checkpointer` | Computes new checkpoint LSN, writes checkpoint | Periodic or when redo log space runs low |

This thread-per-responsibility design eliminates contention. The log writer and log flusher never compete for the same lock. User threads never call `write()` or `fsync()` themselves — they simply wait on LSN notifications.

Source: `log0write.cc` contains all five thread entry points.

### 7.4 Dynamic Resizing

```sql
-- Resize redo log capacity online (no restart required):
SET GLOBAL innodb_redo_log_capacity = 4294967296;  -- 4 GB

-- Monitor resize progress:
SELECT * FROM performance_schema.innodb_redo_log;
SHOW STATUS LIKE 'Innodb_redo_log_capacity_resized';
```

InnoDB handles resizing by adjusting the number and size of managed files within `#innodb_redo/`. Growing is immediate (create new spare files). Shrinking waits for checkpoint to advance past the excess files before reclaiming them.

---

## 8. Checkpoint Mechanism

### 8.1 What Is a Checkpoint

A checkpoint is a recorded assertion: "all dirty pages whose `oldest_modification <= checkpoint_lsn` have been flushed to their data files on disk." After a checkpoint, redo log records before `checkpoint_lsn` are no longer needed for recovery and the corresponding log file space can be overwritten.

The checkpoint is recorded by writing `checkpoint_lsn` (and associated metadata) into one of the two checkpoint fields in the redo log file header.

### 8.2 Why Checkpoints Are Necessary

The redo log is a circular buffer of finite size. Without checkpoints advancing and reclaiming old log space, the log would fill up and InnoDB could no longer write new redo records. Writes would stall completely.

```
Redo Log Circular Buffer:

           checkpoint_lsn              current_lsn
                |                           |
                v                           v
  +-------+----+===========================+--------+
  |RECLAIMD|    |  ACTIVE REDO LOG SPACE   |  FREE  |
  |  (can  |    |  (needed for recovery)   |        |
  |overwrite)   |                           |        |
  +-------+----+===========================+--------+
  <-- old -->   <--- checkpoint_age ------->
                = current_lsn - checkpoint_lsn
```

**Checkpoint age** = `current_lsn - checkpoint_lsn` = the amount of redo log that would need to be replayed on crash. This directly determines:
1. **Recovery time**: larger checkpoint age = more log to replay = longer recovery
2. **Usable log space**: if checkpoint age approaches total redo log capacity, InnoDB stalls

### 8.3 Sharp vs. Fuzzy Checkpoint

**Sharp Checkpoint** (only at clean shutdown):
- Flush ALL dirty pages from the buffer pool to data files
- Advance `checkpoint_lsn` to `current_lsn`
- Write checkpoint record
- After sharp checkpoint, no redo replay is needed on next startup
- Triggered by `innodb_fast_shutdown = 0` (clean, slow shutdown)

**Fuzzy Checkpoint** (normal operation):
- Continuously flush dirty pages in the background
- Periodically advance `checkpoint_lsn` to the `oldest_modification` of the oldest dirty page still in the flush list
- The "fuzzy" name: at any given moment, some pages after `checkpoint_lsn` may already be flushed while some before the new checkpoint target may still be in transit

```
Fuzzy checkpoint operation:

  Flush list (sorted by oldest_modification):

  oldest_modification:  LSN_50  LSN_80  LSN_120  LSN_200  LSN_350
                          |       |        |        |        |
  Pages:                 [P_a]   [P_b]   [P_c]    [P_d]    [P_e]

  Current checkpoint_lsn = LSN_50

  Page cleaner flushes P_a to disk:
    → flush list removes P_a
    → oldest dirty page is now P_b (LSN_80)
    → checkpoint can advance to LSN_80

  Page cleaner flushes P_b:
    → oldest dirty page is now P_c (LSN_120)
    → checkpoint can advance to LSN_120
```

Source: `log0chkp.cc:log_checkpoint()`, `buf0flu.cc:buf_flush_page_cleaner_coordinator()`

### 8.4 Async and Sync Flush Watermarks

InnoDB defines watermarks on the checkpoint age to control flushing urgency:

```
Total redo log capacity = innodb_redo_log_capacity (e.g., 2 GB)

Watermark             Threshold               Action
-----------           ---------               ------
Normal                age < async_watermark    Page cleaner flushes at normal rate
                      (~76% of capacity)       based on adaptive flushing heuristics

Async flush           async_watermark <=       Page cleaner increases flush rate
                      age < sync_watermark     aggressively. More dirty pages flushed
                      (~80% of capacity)       per batch. User threads NOT blocked.

Sync flush            age >= sync_watermark    CRITICAL: user threads performing
                      (~90% of capacity)       modifications are BLOCKED until
                                               checkpoint advances. Severe
                                               throughput collapse.

Log full              age == capacity          Complete stall. No new redo records
                                               can be generated. System is frozen
                                               until page cleaner flushes pages and
                                               checkpoint advances.
```

```
  0%        76%    80%         90%       100%
  +---------+------+-----------+---------+
  | Normal  | Warn | Async     | Sync    |
  | flushing| zone | aggressive| stall!  |
  +---------+------+-----------+---------+
             ^      ^           ^
             |      |           |
        adaptive  increased   user threads
        flushing  urgency     blocked
```

The **adaptive flushing** algorithm (`buf0flu.cc:af_get_pct_for_dirty()` and `af_get_pct_for_lsn()`) dynamically adjusts the page cleaner's flush rate based on:
- Current checkpoint age relative to the watermarks
- Rate of redo log generation (LSN velocity)
- Percentage of dirty pages in the buffer pool

>>> **Interview insight**: "What causes sudden performance drops in MySQL under heavy write load?" One major cause is hitting the async/sync flush watermarks. The redo log fills up because the page cleaner cannot flush dirty pages fast enough. When checkpoint age crosses the sync watermark, user threads stall on every write operation. The fix: increase `innodb_redo_log_capacity`, ensure sufficient I/O bandwidth for the page cleaner, and verify `innodb_io_capacity` / `innodb_io_capacity_max` are set appropriately for your storage.

---

## 9. Crash Recovery — The Complete Process

### 9.1 Overview

When InnoDB starts after an unclean shutdown (crash, kill -9, power loss), it performs crash recovery to restore the database to a transaction-consistent state. The process has two phases: **REDO** (replay committed changes) and **UNDO** (roll back uncommitted changes).

```
Crash Recovery Flow:

  +------------------+
  | InnoDB Startup   |
  +--------+---------+
           |
  +--------v---------+
  | Read checkpoint   |
  | fields from redo  |
  | log file header   |
  +--------+---------+
           |
  +--------v---------+
  | Pick checkpoint   |
  | with highest      |
  | checkpoint_no     |
  +--------+---------+
           |
  +--------v--------------------+
  | REDO PHASE                  |
  | Scan redo log from          |
  | checkpoint_lsn → end of    |
  | valid records.              |
  | Apply each record to its    |
  | target page (read from disk |
  | if not in buffer pool).     |
  +--------+--------------------+
           |
  +--------v--------------------+
  | UNDO PHASE                  |
  | Read undo log tablespace.   |
  | Find transactions in        |
  | ACTIVE or PREPARED state.   |
  |                             |
  | ACTIVE → rollback via undo  |
  | PREPARED → check binlog:    |
  |   binlog has txn → commit   |
  |   binlog missing → rollback |
  +--------+--------------------+
           |
  +--------v---------+
  | Recovery complete |
  | Buffer pool is    |
  | crash-consistent  |
  +------------------+
```

### 9.2 Step 1: Read Checkpoint

InnoDB opens the redo log files and reads both checkpoint fields from the file header. It selects the checkpoint with the higher `checkpoint_no` as the valid starting point.

```c
/* Simplified from log0recv.cc */
checkpoint_no_1 = mach_read_from_8(buf + LOG_CHECKPOINT_NO);  /* field 1 */
checkpoint_no_2 = mach_read_from_8(buf + LOG_CHECKPOINT_NO);  /* field 2 */

if (checkpoint_no_1 > checkpoint_no_2) {
    recovery_start_lsn = checkpoint_lsn_1;
} else {
    recovery_start_lsn = checkpoint_lsn_2;
}
```

If both checkpoint fields are corrupt (checksum mismatch), recovery fails and the database cannot start. This is extremely rare — the dual-field design exists precisely to prevent this.

### 9.3 Step 2: REDO Phase — Log Scanning and Parsing

Starting from `checkpoint_lsn`, InnoDB reads redo log blocks sequentially. For each block:

1. Verify `LOG_BLOCK_CHECKSUM` (CRC-32C). If invalid, this is the end of valid log — stop scanning.
2. Parse redo records from the block payload.
3. Group records by mtr boundaries (`MLOG_MULTI_REC_END` or single-record flag).
4. Discard incomplete mtr groups at the end of the log (partial writes from the crash).

Source: `log0recv.cc:recv_scan_log_recs()`, `log0recv.cc:recv_parse_log_recs()`

### 9.4 Step 3: REDO Phase — Hash-Based Batch Apply

Rather than applying each redo record immediately (which would cause massive random I/O as each record targets a different page), InnoDB uses a **hash table** to batch records by `(space_id, page_no)`:

```
Hash table: recv_sys->addr_hash

Key: (space_id, page_no) ──> linked list of redo records for that page
                              sorted by LSN (ascending)

  (5, 1037) → [LSN 100: MLOG_WRITE_STRING] → [LSN 250: MLOG_4BYTES] → ...
  (5, 1038) → [LSN 150: MLOG_COMP_REC_INSERT] → ...
  (7, 2044) → [LSN 200: MLOG_COMP_REC_DELETE] → ...
```

Once scanning is complete (or when the hash table reaches its memory limit), InnoDB applies records page by page:

1. For each `(space_id, page_no)` in the hash table:
   a. Read the page from the data file into the buffer pool
   b. Check the page's `FIL_PAGE_LSN` (the LSN stored in the page header on disk)
   c. For each redo record in the linked list (LSN order):
      - If record's LSN <= page's `FIL_PAGE_LSN`: **skip** (already applied before crash)
      - If record's LSN > page's `FIL_PAGE_LSN`: **apply** the physical modification
   d. After applying all records, the page is now up-to-date

```
Page on disk has FIL_PAGE_LSN = 200

Redo records for this page:
  LSN 150: MLOG_WRITE_STRING  → SKIP (150 <= 200, already on disk)
  LSN 200: MLOG_4BYTES        → SKIP (200 <= 200, already on disk)
  LSN 350: MLOG_COMP_REC_INSERT → APPLY (350 > 200, not yet on disk)
  LSN 500: MLOG_WRITE_STRING  → APPLY (500 > 200, not yet on disk)

After recovery: page's FIL_PAGE_LSN = 500
```

**Idempotency**: applying a redo record that was already reflected on the page is harmless — the physical write overwrites identical bytes. But the LSN comparison makes this unnecessary in practice.

**Memory constraint**: if the hash table grows too large, InnoDB applies accumulated records in batches, clears the hash table, and continues scanning. This bounds memory usage during recovery of very large redo logs.

Source: `log0recv.cc:recv_apply_hashed_log_recs()`, `log0recv.cc:recv_recover_page_func()`

### 9.5 Step 4: UNDO Phase — Rolling Back Uncommitted Transactions

After redo replay, the buffer pool contains pages that reflect all modifications (both committed and uncommitted) up to the crash point. Now InnoDB must identify and roll back uncommitted transactions.

1. **Read the undo log tablespace**: scan the rollback segments to find transaction undo records.
2. **Classify transactions by state**:

```
Transaction State    Action
-----------------    ------
COMMITTED            Nothing to do (already committed)

ACTIVE               Never committed. Roll back using undo log records:
                     - For each modification (newest first), apply the
                       inverse operation from the undo record
                     - INSERT → delete the row
                     - DELETE → re-insert the row
                     - UPDATE → restore the old column values

PREPARED (XA)        Check the binary log:
                     - If binlog contains this XA transaction → COMMIT
                       (the transaction was committed in binlog but InnoDB
                       hadn't written the commit record before crash)
                     - If binlog does NOT contain it → ROLLBACK
                       (transaction was prepared but never committed)
```

PREPARED transaction resolution is the **internal XA recovery** mechanism. It ensures consistency between the InnoDB redo log and the binary log.

Source: `trx0roll.cc:trx_rollback_active()`, `ha_innodb.cc:innobase_xa_recover()`

### 9.6 Step 5: Post-Recovery

After both phases complete:
- The buffer pool contains a **transaction-consistent** snapshot of the database
- All committed transactions' effects are present
- All uncommitted transactions' effects are rolled back
- InnoDB writes a new checkpoint at the current LSN
- Normal operation begins

### 9.7 Recovery Time

Recovery time is determined by two factors:

1. **Redo log volume**: `current_lsn - checkpoint_lsn` at crash time. This is the checkpoint age — the amount of redo log that must be scanned and applied.
2. **Random I/O for page reads**: each unique `(space_id, page_no)` in the redo log requires reading a page from disk (if not already in memory). The hash-based batching helps, but the dominant cost is still random reads.

```
Recovery time ≈ (redo_log_bytes_to_scan / sequential_read_speed)
              + (unique_pages_touched × random_read_latency)
              + (undo_rollback_time for uncommitted transactions)

Example:
  checkpoint_age = 1 GB of redo log
  Sequential scan: 1 GB / 500 MB/s = 2 seconds
  Unique pages: 500,000 × 0.1 ms (SSD random read) = 50 seconds
  Undo rollback: typically small unless long-running transaction crashed

  Total ≈ ~1 minute
```

>>> **Interview insight**: "How would you reduce MySQL crash recovery time?" Three approaches: (1) Decrease `innodb_redo_log_capacity` to force more frequent checkpoints (tradeoff: increased flush I/O during normal operation). (2) Increase `innodb_io_capacity` and `innodb_io_capacity_max` so page cleaners flush dirty pages faster, reducing checkpoint age. (3) Use faster storage (NVMe) to accelerate the random page reads during recovery. Also note that `innodb_fast_shutdown = 0` performs a sharp checkpoint at shutdown, making the next startup instant — useful for planned maintenance.

---

## 10. Redo Log Sizing — The Engineering Tradeoff

### 10.1 The Tension

```
          Too Small                            Too Large
  +---------------------------+    +---------------------------+
  | Frequent checkpoints      |    | Infrequent checkpoints    |
  | More page cleaner I/O     |    | Less flush overhead       |
  | Risk of sync flush stalls |    | Better sustained write    |
  | Short recovery time       |    | throughput                |
  |                           |    | LONGER recovery time      |
  +---------------------------+    +---------------------------+
            |                                    |
            +---------- sweet spot --------------+
              Size for 1-2 hours of peak writes
```

### 10.2 How to Calculate the Right Size

**Step 1**: Measure redo log generation rate during peak write load.

```sql
-- Sample LSN every 60 seconds during peak:
SHOW ENGINE INNODB STATUS\G
-- Look for: "Log sequence number  XXXXXXXX"
-- Or use performance_schema:
SELECT * FROM performance_schema.innodb_redo_log;

-- Better: use status variables
SHOW GLOBAL STATUS LIKE 'Innodb_redo_log_current_lsn';
-- Wait 60 seconds
SHOW GLOBAL STATUS LIKE 'Innodb_redo_log_current_lsn';

-- redo_bytes_per_second = (lsn_2 - lsn_1) / 60
```

**Step 2**: Calculate target size for 1-2 hours of writes.

```
redo_bytes_per_second = 5,000,000  (5 MB/s — moderate write load)
target_hours = 1.5

innodb_redo_log_capacity = 5,000,000 × 3600 × 1.5
                         = 27,000,000,000 (27 GB)

Round up to: 32 GB (SET GLOBAL innodb_redo_log_capacity = 34359738368)
```

**Step 3**: Verify checkpoint age stays well below watermarks during operation.

```sql
-- Monitor checkpoint age:
SELECT
  (SELECT variable_value FROM performance_schema.global_status
   WHERE variable_name = 'Innodb_redo_log_current_lsn') -
  (SELECT variable_value FROM performance_schema.global_status
   WHERE variable_name = 'Innodb_redo_log_checkpoint_lsn')
  AS checkpoint_age_bytes;
```

### 10.3 Signs the Redo Log Is Too Small

| Symptom | What's happening |
|---------|-----------------|
| `Innodb_log_waits > 0` (increasing) | Transactions waiting for log buffer space because the log buffer couldn't be flushed fast enough |
| Periodic throughput drops | Page cleaner forced into aggressive flushing at async watermark |
| `SHOW ENGINE INNODB STATUS` shows "log sequence number - last checkpoint" near redo log capacity | Checkpoint age dangerously close to capacity |
| `Innodb_redo_log_resize_status` stuck | Dynamic resize waiting for checkpoint to advance |

### 10.4 Signs the Redo Log Is Too Large

| Symptom | What's happening |
|---------|-----------------|
| Crash recovery takes 10+ minutes | Large checkpoint age means massive redo replay |
| Disk space pressure | Multiple GB of redo log files consuming valuable SSD space |
| For HA setups: unacceptable RTO | Recovery time violates SLA for failover |

### 10.5 Rules of Thumb

```
Workload Type          Recommended Redo Log Size
--------------         -------------------------
Low-write (read-heavy) 1-2 GB (default is often fine)
Moderate OLTP          4-8 GB
Heavy OLTP (e-commerce) 16-32 GB
Bulk loading / ETL     64-128 GB (temporary; reduce after load)
```

>>> **Interview insight**: "How would you size the redo log for a new production MySQL instance?" Walk through the calculation: measure LSN advance rate under expected peak load (or estimate from benchmarks), multiply by 1-2 hours. Then validate by monitoring checkpoint age. Mention the tradeoff between write performance and recovery time. For HA clusters with automatic failover, factor in the RTO requirement — a 60-second recovery may be acceptable where a 10-minute recovery is not.

---

## 11. Redo Log Archiving and Backup

### 11.1 The Backup Problem

Online backup tools (MySQL Enterprise Backup, Percona XtraBackup) work by:
1. Copying `.ibd` data files while the server is running
2. Capturing redo log records generated during the copy
3. During restore: apply captured redo records to bring data files to a consistent point

The problem: while the backup tool is copying data files (which takes time — minutes to hours for large databases), InnoDB continues writing redo log records. If the redo log is circular and wraps around during the copy, the backup tool loses redo records it hasn't captured yet and the backup is invalid.

```
Time →
  |---- backup copy starts ----|---- backup copy ends ----|
  |                             |                          |
  Redo log:
  [==========|checkpoint|===========|==================]
              ^                      ^
              |                      | redo log wraps!
              backup tool            records overwritten
              started capturing      before tool read them
              here                   → backup fails
```

### 11.2 Redo Log Archiving (MySQL 8.0.17+)

Redo log archiving solves this by copying redo log records to a separate archive directory as they are generated, independent of the circular redo log files.

```sql
-- Configure archive directory (in my.cnf or SET PERSIST):
-- The server_label is an arbitrary label for this server
SET GLOBAL innodb_redo_log_archive_dirs = 'label1:/backup/redo_archive';

-- Backup tool calls this stored procedure to start archiving:
-- (typically invoked by the backup tool, not manually)
DO innodb_redo_log_archive_start('label1', 'subdir_name');

-- ... backup tool copies .ibd files ...

-- Stop archiving:
DO innodb_redo_log_archive_stop();
```

The archive mechanism:
1. A dedicated archiver thread reads redo log blocks as they are written
2. Copies them to sequential files in the archive directory
3. Archive files are NOT circular — they grow linearly
4. The backup tool reads from archive files instead of the redo log files directly

```
Normal redo log (circular):         Archive (linear, grows):
+---+---+---+---+                  +---+---+---+---+---+---+---+
|blk|blk|blk|blk| → wraps         |blk|blk|blk|blk|blk|blk|blk| → appends
+---+---+---+---+                  +---+---+---+---+---+---+---+
    ^ overwrites old                    ^ never overwrites
```

### 11.3 Backup Without Archiving

Without redo log archiving, the backup tool must:
- Monitor the redo log consumption rate
- Complete the data file copy before the redo log wraps
- If the log wraps: the backup is inconsistent and must be restarted

For large databases with small redo logs, this creates a constraint: either the backup must complete very quickly, or the redo log must be sized large enough to not wrap during the backup window.

With archiving enabled, the redo log size can be optimized purely for runtime performance without worrying about backup windows.

### 11.4 Backup and Recovery Flow

```
Online Backup Process:

  1. START BACKUP
     ├── Begin capturing redo log (or start archiving)
     ├── Copy all .ibd files (tablespace data files)
     │   (these are crash-inconsistent copies — different pages
     │    were copied at different points in time)
     └── Stop capturing redo log

  2. PREPARE BACKUP
     ├── Read captured redo log records
     ├── Apply redo records to the copied .ibd files
     │   (brings all pages to a single consistent point in time)
     └── Roll back uncommitted transactions (undo phase)
     Result: backup is now crash-consistent

  3. RESTORE
     ├── Copy prepared .ibd files to target server's data directory
     ├── Copy redo log files (or let InnoDB create fresh ones)
     └── Start MySQL — InnoDB performs normal recovery (should be near-instant)
```

>>> **Interview insight**: "How does a hot backup of MySQL work without locking tables?" Explain the redo log capture approach: data files are copied in a crash-inconsistent state (different pages from different points in time), then redo log records captured during the copy are applied to bring all pages to the same consistent LSN. This is essentially a mini crash-recovery performed on the backup files. Mention that the `FLUSH TABLES WITH READ LOCK` (or backup locks) is only needed briefly to capture the binary log position for replication consistency, not for the data files themselves.

---

## 12. Putting It All Together — The Write Path

To solidify understanding, trace a single `UPDATE` from execution to crash recovery:

```
1. USER THREAD executes: UPDATE accounts SET balance = 500 WHERE id = 7

2. BUFFER POOL: page containing id=7 is read into buffer pool (if not present)

3. UNDO LOG: InnoDB writes an undo record (old value of balance) to the
   undo log page. This is itself an mtr that generates redo records for the
   undo page modification.

4. DATA MODIFICATION: InnoDB modifies the row in the buffer pool page.
   The mtr generates redo records describing the physical page change.
   Page is marked dirty. oldest_modification set to this mtr's start LSN.

5. MTR COMMIT: redo records from step 3 and 4 are copied to the log buffer.
   Each mtr group is terminated with MLOG_MULTI_REC_END.

6. TRANSACTION COMMIT:
   a. Write COMMIT record to redo log buffer
   b. Log writer thread writes log buffer to OS page cache (write())
   c. Log flusher thread fsyncs redo log to disk
   d. Log flush notifier wakes user thread
   e. User thread returns OK to client
   → At this point, the modification is DURABLE even though the buffer pool
     page has NOT been written to the .ibd file

7. BACKGROUND (minutes to hours later):
   a. Page cleaner thread flushes the dirty page to the .ibd file
   b. WAL check: page's redo records are already on disk (step 6c) → safe
   c. Doublewrite buffer: page is written to doublewrite buffer first, then
      to the .ibd file (protects against torn page writes)
   d. Page is marked clean, removed from flush list
   e. Checkpoint advances past this page's oldest_modification LSN

8. CRASH SCENARIO (if crash occurs between step 6 and step 7):
   a. InnoDB starts, reads checkpoint from redo log header
   b. REDO: scans from checkpoint_lsn, finds the redo records from step 5
   c. Reads page from .ibd file (old version, balance != 500)
   d. Applies redo records → page now has balance = 500
   e. Transaction was COMMITTED → no undo needed
   f. Database is consistent: the committed UPDATE is preserved

9. CRASH SCENARIO (if crash occurs between step 4 and step 6e):
   a. Transaction never committed (no COMMIT record in redo log)
   b. REDO: may or may not replay the page modification (depends on whether
      redo records made it to the log file before crash)
   c. UNDO: if redo replay applied the uncommitted modification, the
      transaction is found in ACTIVE state → rolled back using undo records
   d. balance is restored to its pre-UPDATE value
   e. Database is consistent: the uncommitted UPDATE is properly reversed
```

---

## 13. Source Code Map and Configuration Reference

Key source files in `storage/innobase/`: `log/log0buf.cc` (log buffer, lock-free reservation), `log/log0write.cc` (writer/flusher/notifier threads), `log/log0chkp.cc` (checkpoint logic), `log/log0recv.cc` (crash recovery: scan, parse, apply), `include/mtr0types.h` (MLOG_* constants), `mtr/mtr0mtr.cc` (mtr commit), `buf/buf0flu.cc` (page cleaner, adaptive flushing), `trx/trx0trx.cc` (commit, flush-at-commit), `trx/trx0roll.cc` (undo rollback), `ha/ha_innodb.cc` (XA recovery).

### 13.1 Redo Log Parameters

| Parameter | Default | Recommendation |
|-----------|---------|---------------|
| `innodb_redo_log_capacity` (8.0.30+) | 100 MB | 4-32 GB for production OLTP |
| `innodb_log_file_size` (pre-8.0.30) | 48 MB | 1-4 GB per file |
| `innodb_log_files_in_group` (pre-8.0.30) | 2 | 2 (rarely need more) |
| `innodb_log_buffer_size` | 16 MB | 16-64 MB (increase for large transactions) |
| `innodb_flush_log_at_trx_commit` | 1 | 1 for durability, 2 for performance |
| `innodb_flush_method` | `fsync` | `O_DIRECT` on Linux avoids double-buffering |
| `innodb_io_capacity` / `_max` | 200 / 2000 | Set to 50% / 100% of device IOPS |
| `innodb_page_cleaners` | 4 | Match buffer pool instances |
| `innodb_fast_shutdown` | 1 | 0 = sharp checkpoint, 1 = skip purge, 2 = log only |
| `sync_binlog` | 1 | 1 for crash-safe replication |

### 13.2 Key Monitoring Queries

```sql
-- Checkpoint age (8.0.30+):
SELECT
  (SELECT variable_value FROM performance_schema.global_status
   WHERE variable_name = 'Innodb_redo_log_current_lsn') -
  (SELECT variable_value FROM performance_schema.global_status
   WHERE variable_name = 'Innodb_redo_log_checkpoint_lsn') AS checkpoint_age;

-- Log waits (redo log too small if increasing):
SHOW GLOBAL STATUS LIKE 'Innodb_log_waits';

-- Comprehensive view:
SHOW ENGINE INNODB STATUS\G  -- Sections: "LOG", "BUFFER POOL AND MEMORY"
```

---

*Next: Chapter 9 — Undo Log, Purge, and Doublewrite Buffer*
