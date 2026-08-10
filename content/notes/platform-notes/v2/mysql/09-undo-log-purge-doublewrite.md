# Chapter 9: Undo Log, Purge System, and Doublewrite Buffer

> How are old row versions managed and torn pages prevented?

The redo log (Chapter 8) guarantees that committed changes survive a crash. But two
critical questions remain: how does InnoDB undo changes that should not have happened,
and how does it prevent half-written pages from corrupting the entire tablespace? This
chapter answers both. We trace the lifecycle of an undo log record from creation through
MVCC service to eventual purge, then dissect the doublewrite buffer that protects every
page write against torn-page corruption. The chapter closes by stitching the entire write
path together — undo, redo, doublewrite, and flush — into a single end-to-end trace.

---

## 9.1 Undo Log — Purpose and Dual Role

The undo log stores the **before-image** of every row modification. It serves two
independent purposes that happen to share the same physical data structure.

### Role 1: Transaction Rollback

When a transaction executes `ROLLBACK`, or when crash recovery discovers an uncommitted
transaction, InnoDB must reverse every change that transaction made. The undo log
provides the blueprint: each undo record contains enough information to restore the
row to its prior state.

```
Transaction T1:
  UPDATE accounts SET balance = 500 WHERE id = 7;   -- balance was 1000
  UPDATE accounts SET balance = 200 WHERE id = 7;   -- balance was 500

Undo chain for row id=7 (newest → oldest):
  [undo_rec_2: before-image balance=500] → [undo_rec_1: before-image balance=1000]

ROLLBACK T1:
  1. Apply undo_rec_2 → restore balance to 500
  2. Apply undo_rec_1 → restore balance to 1000
```

Rollback walks the undo chain in reverse order (newest first), applying each before-image
until the row is restored to its pre-transaction state. The traversal follows the
`DB_ROLL_PTR` pointer embedded in each row header.

Source: `trx0roll.cc:trx_rollback_active()` initiates rollback; `row0undo.cc:row_undo_step()`
processes individual undo records.

### Role 2: MVCC — Consistent Reads

When a `SELECT` under REPEATABLE READ encounters a row whose `DB_TRX_ID` is not visible
to the current ReadView, InnoDB follows the `DB_ROLL_PTR` chain into the undo log to
find an older version that IS visible. This is the version-chain traversal described in
Chapter 7.

```
Row in clustered index (current version):
  id=7, balance=200, DB_TRX_ID=T1, DB_ROLL_PTR → undo_rec_2

T2 starts a consistent read (ReadView says T1 is not yet committed):
  1. Read row id=7 → DB_TRX_ID=T1 → not visible
  2. Follow DB_ROLL_PTR → undo_rec_2 → balance=500, DB_TRX_ID=T1 → still not visible
  3. Follow chain → undo_rec_1 → balance=1000, DB_TRX_ID=T0 → visible!
  4. Return balance=1000 to T2
```

Without the undo log, MVCC would be impossible. The undo log IS the version store.

### Contrast with PostgreSQL

PostgreSQL takes a fundamentally different approach: old row versions live directly in
the heap (table data files). Each UPDATE creates a new tuple in-place, and the old tuple
remains until VACUUM removes it. This means:

| Aspect | InnoDB | PostgreSQL |
|--------|--------|------------|
| Old versions stored | Undo tablespace (separate) | Heap pages (in-place) |
| Cleanup mechanism | Purge threads | VACUUM |
| Table bloat from old versions | No (undo space bloats instead) | Yes (heap bloats) |
| Version chain direction | Backward (current row → undo → older undo) | Forward (old tuple → new tuple via `t_ctid`) |
| Index impact | Indexes always point to current version | Indexes may point to dead tuples (HOT helps) |
| Read overhead for old versions | Must traverse undo chain | Direct heap access (but visibility check) |

>>> **Interview insight**: "InnoDB separates current data from old versions. PostgreSQL
>>> co-locates them. InnoDB's approach avoids heap bloat but introduces undo tablespace
>>> growth. PostgreSQL's approach avoids undo traversal but requires VACUUM to reclaim
>>> space. Neither is universally better — the trade-off is where bloat accumulates."

---

## 9.2 Undo Log Types

InnoDB distinguishes two undo log types because their lifecycle requirements differ
fundamentally.

### Insert Undo Log (`TRX_UNDO_INSERT`)

Records the information needed to undo an `INSERT`: essentially the primary key of the
newly inserted row. Rolling back an INSERT means deleting the row.

```
INSERT INTO orders (id, amount) VALUES (42, 99.99);

Insert undo record:
  +----------------------------------------------------+
  | type: TRX_UNDO_INSERT_REC                          |
  | table_id: 15                                       |
  | primary_key: id=42                                 |
  | (no old column values — row did not exist before)  |
  +----------------------------------------------------+

ROLLBACK → DELETE FROM orders WHERE id = 42
```

**Key property**: insert undo records are **never needed for MVCC**. Before the INSERT,
the row did not exist. No other transaction's ReadView can ever reference a "before version"
of a row that never existed. Therefore:

- Insert undo logs are freed **immediately after the transaction commits** (or rolls back).
- They are never added to the history list.
- They impose zero long-term storage cost.

Source: `trx0undo.h` defines `TRX_UNDO_INSERT` type. `trx0purge.cc` skips insert undo
logs during purge — they are already freed at commit time by `trx_undo_insert_cleanup()`.

### Update Undo Log (`TRX_UNDO_UPDATE`)

Records the before-image of an `UPDATE` or the full row image of a `DELETE` mark
operation. This is the undo type that fuels MVCC.

```
UPDATE orders SET amount = 150.00 WHERE id = 42;   -- amount was 99.99

Update undo record:
  +----------------------------------------------------+
  | type: TRX_UNDO_UPD_EXIST_REC                      |
  | undo_no: 2                                         |
  | table_id: 15                                       |
  | primary_key: id=42                                 |
  | old_trx_id: T_prev                                |
  | old_roll_ptr: (points to even older undo record)   |
  | changed columns: [amount = 99.99]                  |
  +----------------------------------------------------+

DELETE FROM orders WHERE id = 42;

Update undo record (delete-mark):
  +----------------------------------------------------+
  | type: TRX_UNDO_DEL_MARK_REC                       |
  | undo_no: 3                                         |
  | table_id: 15                                       |
  | primary_key: id=42                                 |
  | old_trx_id: T_prev                                |
  | old_roll_ptr: (points to previous undo record)     |
  | full row image: all columns                        |
  +----------------------------------------------------+
```

**Lifecycle**: update undo records are **not freed at commit**. Instead, they are placed
on the **history list** and remain there until the purge system determines that no active
ReadView references them. This can be seconds, minutes, or hours — depending on the oldest
active transaction in the system.

>>> **Interview insight**: "Why does InnoDB have two undo log types? Because insert undo
>>> records have no MVCC consumers — no transaction can ask 'show me the version of this
>>> row before it was inserted,' because it did not exist. This distinction lets InnoDB
>>> free insert undo space immediately at commit, reducing undo tablespace pressure. Update
>>> undo records, by contrast, must survive until the last interested ReadView is closed."

---

## 9.3 Undo Log Physical Structure

The physical organization of undo logs is a four-level hierarchy. Understanding it
explains the concurrency limits on write transactions.

### Hierarchy

```
Undo Tablespace (.undo file)
  └── Rollback Segment (128 per tablespace by default)
        └── Undo Log Slot (1024 per rollback segment)
              └── Undo Log (one per active transaction)
                    └── Undo Log Records (linked list of before-images)
```

### ASCII Diagram: Full Physical Layout

```
+------------------------------------------------------------------+
|                    Undo Tablespace (undo_001)                     |
|                                                                  |
|  +-------------------+  +-------------------+      +-----------+ |
|  | Rollback Seg 0    |  | Rollback Seg 1    | ...  | Rseg 127  | |
|  |                   |  |                   |      |           | |
|  | Slot 0 → Undo Log |  | Slot 0 → Undo Log|      |           | |
|  | Slot 1 → Undo Log |  | Slot 1 → NULL    |      |           | |
|  | Slot 2 → NULL     |  | Slot 2 → Undo Log|      |           | |
|  | ...               |  | ...               |      |           | |
|  | Slot 1023 → NULL  |  | Slot 1023 → NULL |      |           | |
|  +-------------------+  +-------------------+      +-----------+ |
|                                                                  |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
|                    Undo Tablespace (undo_002)                     |
|  (same structure — 128 rollback segments × 1024 slots each)      |
+------------------------------------------------------------------+

Each Undo Log (one slot, one transaction):
  +----------+    +----------+    +----------+
  | Undo Rec |───>| Undo Rec |───>| Undo Rec |───> ...
  | (newest) |    | (middle) |    | (oldest) |
  +----------+    +----------+    +----------+
  Linked list via page-internal pointers within undo log pages
```

### Configuration Parameters

| Parameter | Default (MySQL 8.0) | Meaning |
|-----------|-------------------|---------|
| `innodb_undo_tablespaces` | 2 | Number of undo tablespace files |
| `innodb_rollback_segments` | 128 | Rollback segments per undo tablespace |
| (fixed) | 1024 | Undo log slots per rollback segment |

### Maximum Concurrent Write Transactions

Each active write transaction requires one undo log slot. A read-only transaction
(`SELECT` without `FOR UPDATE`) does NOT consume a slot — it only creates a ReadView.

```
Max concurrent write transactions =
    innodb_undo_tablespaces × innodb_rollback_segments × 1024

Default: 2 × 128 × 1024 = 262,144 concurrent write transactions
```

In practice, this is far more than any single MySQL instance handles. The limit exists
because of the fixed-size rollback segment header page format (each header page has
exactly 1024 slot entries, each being a 4-byte page number).

Source: `trx0rseg.h` — `TRX_RSEG_N_SLOTS = 1024`. The rollback segment header page
(`TRX_RSEG` page type) contains an array of 1024 slot entries at offset `TRX_RSEG_UNDO_SLOTS`.

### Undo Tablespace Files on Disk

```
$DATADIR/
  ├── undo_001          # undo tablespace 1
  ├── undo_002          # undo tablespace 2
  ├── ibdata1           # system tablespace (pre-8.0 undo lived here)
  └── ...
```

Pre-MySQL 8.0, undo logs lived inside the system tablespace (`ibdata1`). This was
catastrophic for operations because `ibdata1` cannot shrink — once undo log growth
inflated it to 100 GB, that space was permanently consumed even after purge cleaned up.
MySQL 8.0 moved undo to separate files that support truncation.

>>> **Interview insight**: "Ask about undo tablespace sizing. Each undo tablespace can
>>> grow dynamically, but the key constraint is `innodb_rollback_segments` — at 128 per
>>> tablespace with 1024 slots each, you get 131,072 concurrent write transactions per
>>> undo tablespace. The real operational concern is not slot exhaustion but tablespace
>>> growth from long-running transactions that block purge."

---

## 9.4 Undo Log Record Format

Each undo log record is a variable-length structure that contains enough information to
either reconstruct the previous row version (for MVCC) or reverse the modification (for
rollback).

### Record Fields

```
+---------------------------------------------------------------+
| Undo Log Record                                               |
+---------------------------------------------------------------+
| undo_no        | Undo record sequence number within the txn   |
| table_id       | Internal table identifier                     |
| type           | TRX_UNDO_INSERT_REC / TRX_UNDO_UPD_EXIST_REC|
|                | / TRX_UNDO_UPD_DEL_REC / TRX_UNDO_DEL_MARK  |
| info_bits      | Delete-mark flag, min-rec flag                |
| old_trx_id     | DB_TRX_ID of the previous row version         |
| old_roll_ptr   | DB_ROLL_PTR of the previous row version       |
| primary_key    | PK column values (to locate the row)          |
| old_cols       | Changed column values (before-image)           |
| index_cols     | Secondary index column values (for purge)      |
+---------------------------------------------------------------+
```

### Partial vs Full Before-Image

**For UPDATE**: InnoDB stores only the **changed columns** in the undo record (partial
before-image). If you update 2 columns out of 20, the undo record contains only those 2
old values. This is a space optimization — storing the full row for every update would
bloat the undo tablespace unnecessarily.

**For DELETE (delete-mark)**: InnoDB stores the **full row image**. The reason is that
a delete-marked row will eventually be physically removed by the purge system, and any
MVCC reader that needs the old version must be able to reconstruct the complete row from
the undo record alone.

### The DB_ROLL_PTR Chain

The `DB_ROLL_PTR` field in each row header is a 7-byte pointer that encodes:

```
DB_ROLL_PTR (7 bytes = 56 bits):
  +--------+--------+--------------------+
  | is_ins | rseg_id| page_no + offset   |
  | 1 bit  | 7 bits | 48 bits            |
  +--------+--------+--------------------+

  is_ins:   1 = insert undo record, 0 = update undo record
  rseg_id:  rollback segment ID (0–127)
  page_no:  undo log page number within the undo tablespace
  offset:   byte offset of the undo record within that page
```

This pointer chains row versions together through the undo log:

```
Clustered Index Row (current):
  [id=42, amount=200, DB_TRX_ID=T3, DB_ROLL_PTR ──┐
                                                    │
Undo Log:                                           │
  ┌─────────────────────────────────────────────────┘
  ▼
  [undo_rec: amount=150, old_trx_id=T2, old_roll_ptr ──┐
                                                        │
  ┌─────────────────────────────────────────────────────┘
  ▼
  [undo_rec: amount=99.99, old_trx_id=T1, old_roll_ptr ──┐
                                                          │
  ┌───────────────────────────────────────────────────────┘
  ▼
  [undo_rec: INSERT undo — chain terminates here]
```

Source: `trx0rec.cc:trx_undo_page_report_modify()` writes update undo records.
`trx0rec.cc:trx_undo_page_report_insert()` writes insert undo records. The
`DB_ROLL_PTR` encoding is defined in `trx0types.h`.

>>> **Interview insight**: "The DB_ROLL_PTR is only 7 bytes but encodes the rollback
>>> segment ID, page number, and byte offset — enough to locate any undo record in the
>>> undo tablespace without an index lookup. This makes version-chain traversal a direct
>>> pointer chase: O(chain_length), no B+Tree traversal needed."

---

## 9.5 Purge System

The purge system is the garbage collector for undo logs. Without it, the undo tablespace
would grow without bound.

### What Purge Does

Purge performs two distinct operations:

**1. Physical removal of delete-marked rows.**
When you execute `DELETE FROM orders WHERE id = 42`, InnoDB does NOT physically remove
the row. It sets the delete-mark flag (`info_bits`) in the row header and writes an
update undo record. The row remains in the clustered index (and secondary indexes) as a
"ghost row." The purge system later performs the actual physical delete — removing the
row from the clustered index page and all secondary index pages.

```
DELETE Statement:
  1. Set delete-mark flag on row       ← happens at DML time
  2. Write undo record (before-image)  ← happens at DML time
  3. Physical row removal              ← deferred to PURGE
  4. Secondary index entry removal     ← deferred to PURGE
```

Why defer? Because other transactions may still need to see the row through MVCC. The
row cannot be removed until no active ReadView references it.

**2. Freeing update undo log records.**
Once an undo record is older than the oldest active ReadView (meaning no transaction
can possibly need this version for a consistent read), the purge system frees the undo
log pages occupied by that record.

### Purge Threads

```
innodb_purge_threads = 4    (default, MySQL 8.0)
```

The purge subsystem uses a coordinator thread and worker threads:

- **Purge coordinator** (`srv_purge_coordinator_thread`): reads undo records from the
  history list in transaction-commit order, batches them, and dispatches work to workers.
- **Purge workers** (`srv_worker_thread`): execute the physical deletes and index
  cleanups in parallel.

Source: `srv0srv.cc:srv_purge_coordinator_thread()` orchestrates purge.
`row0purge.cc:row_purge_step()` handles individual record purge.

### Purge Batch Size

```
innodb_purge_batch_size = 300    (default)
```

Each purge iteration processes up to `innodb_purge_batch_size` undo log pages from the
history list. Too small → purge cannot keep up with DML. Too large → purge holds resources
longer, potentially impacting foreground queries.

### History List Length — The Critical Metric

The **history list length** is the number of committed update undo log records waiting
for purge. It is the single most important metric for undo log health.

```sql
SHOW ENGINE INNODB STATUS\G

-- Output (TRANSACTIONS section):
-- Trx id counter 12345678
-- Purge done for trx's n:o < 12345600 undo n:o < 0
-- History list length 1543
--                     ^^^^
--                     This number. It should stay small (< 10000 typically).
```

Alternative monitoring:

```sql
SELECT count FROM information_schema.INNODB_METRICS
WHERE name = 'trx_rseg_history_len';
```

**Interpretation**:

| History List Length | Status | Action |
|--------------------|--------|--------|
| < 1,000 | Healthy | Normal operation |
| 1,000 - 10,000 | Elevated | Monitor, check for long transactions |
| 10,000 - 100,000 | Warning | Find and kill blocking transaction |
| > 100,000 | Critical | Performance degradation in progress |

### Purge Lag Throttling

When purge falls behind, InnoDB can throttle DML to let purge catch up:

```
innodb_max_purge_lag = 0              (default: disabled)
innodb_max_purge_lag_delay = 0        (default: no cap on delay)
```

When `innodb_max_purge_lag > 0` and the history list length exceeds this value, InnoDB
adds an artificial delay (in microseconds) to each DML statement:

```
delay = (history_list_length - innodb_max_purge_lag) × 10 / innodb_max_purge_lag

Capped by innodb_max_purge_lag_delay (microseconds).
```

In practice, most operators prefer to alert on history list length and investigate the
root cause rather than silently throttle application DML. Setting `innodb_max_purge_lag`
is a safety net, not a primary control.

### The Purge View

The purge system maintains its own ReadView — the **purge view** — which represents the
oldest active ReadView across all sessions. Any undo record with a `trx_id` older than
the purge view's `m_low_limit_id` is safe to purge: no active transaction can possibly
reference it.

```
Active ReadViews (oldest → newest):
  ReadView_A: m_low_limit_id = 100     (session A, started 2 hours ago)
  ReadView_B: m_low_limit_id = 500     (session B, started 5 minutes ago)
  ReadView_C: m_low_limit_id = 900     (session C, started 1 second ago)

Purge view = min(m_low_limit_id) across all active ReadViews = 100

  Undo records with trx_id < 100:  SAFE TO PURGE  ✓
  Undo records with trx_id >= 100: CANNOT PURGE   ✗ (ReadView_A might need them)
```

This is why a single long-running transaction blocks ALL purge progress. Even if 99% of
the undo records are referenced by no one, the purge view cannot advance past the oldest
ReadView.

Source: `trx0purge.cc:trx_purge_attach_undo_recs()` fetches records.
`read0read.cc:MVCC::clone_oldest_view()` creates the purge ReadView.

### Purge Flow — ASCII Diagram

```
                    ┌─────────────────────────────┐
                    │       History List           │
                    │  (committed undo records     │
                    │   in transaction-commit      │
                    │   order, oldest first)       │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │     Purge Coordinator        │
                    │  1. Compute purge view       │
                    │  2. Read batch from history  │
                    │  3. Skip if trx_id >= view   │
                    │  4. Dispatch to workers      │
                    └──────────────┬──────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
    │ Purge Worker 0│    │ Purge Worker 1│    │ Purge Worker 2│
    │              │    │              │    │              │
    │ - Remove     │    │ - Remove     │    │ - Remove     │
    │   delete-    │    │   delete-    │    │   delete-    │
    │   marked row │    │   marked row │    │   marked row │
    │ - Remove     │    │ - Remove     │    │ - Remove     │
    │   secondary  │    │   secondary  │    │   secondary  │
    │   index      │    │   index      │    │   index      │
    │   entries    │    │   entries    │    │   entries    │
    │ - Free undo  │    │ - Free undo  │    │ - Free undo  │
    │   pages      │    │   pages      │    │   pages      │
    └──────────────┘    └──────────────┘    └──────────────┘
```

>>> **Interview insight**: "DELETE in InnoDB is a two-phase operation: the user thread
>>> sets the delete-mark and writes an undo record (Phase 1), and the purge thread later
>>> performs the physical removal (Phase 2). This deferred-delete design is essential for
>>> MVCC — you cannot physically remove a row that another transaction might still read.
>>> The consequence is that high-DELETE workloads depend heavily on purge throughput. If
>>> purge falls behind, the clustered index accumulates ghost rows, secondary indexes
>>> grow with dead entries, and range scans slow down."

---

## 9.6 Undo Tablespace Truncation

### The Growth Problem

Undo tablespaces grow dynamically as transactions generate undo records. Under normal
load, purge keeps up and freed pages are reused internally. But during a burst — a large
batch DELETE, a runaway analytics query holding a ReadView for hours — the undo
tablespace can balloon from 100 MB to 50 GB.

The problem: even after purge cleans up all the undo records, the tablespace file does
not shrink. The space is free internally (InnoDB can reuse the pages) but the file system
footprint remains. On disk-constrained systems, this is unacceptable.

### Undo Tablespace Truncation (MySQL 8.0)

```
innodb_undo_log_truncate = ON          (default since MySQL 8.0.2)
innodb_max_undo_log_size = 1073741824  (1 GB default)
```

When an undo tablespace exceeds `innodb_max_undo_log_size` AND all undo records in it
have been purged, InnoDB can truncate it — replacing the file with a fresh, empty one.

### Truncation Process

```
Step 1: Select a candidate undo tablespace that exceeds max_undo_log_size
        AND has all undo records purged (no active transactions reference it)

Step 2: Mark the tablespace INACTIVE
        → No new transactions will be assigned rollback segments from this tablespace
        → All new transactions use the other undo tablespace(s)

Step 3: Wait for existing transactions using this tablespace to complete

Step 4: Truncate the file — create a new, empty undo tablespace file

Step 5: Mark the tablespace ACTIVE again
        → New transactions can use it

  Time ─────────────────────────────────────────────────────────>
  undo_001: [ACTIVE]─────[INACTIVE]─────[TRUNCATE]─[ACTIVE]────
  undo_002: [ACTIVE]─────[ACTIVE]───────[ACTIVE]───[ACTIVE]────
                          ↑ takes over all new transactions
```

### Requirements

1. **At least 2 undo tablespaces** (`innodb_undo_tablespaces >= 2`). One must remain
   active while the other is being truncated. This is why the default is 2.

2. **All undo records in the candidate must be purged**. If even one long-running
   transaction holds a ReadView that references an undo record in the tablespace, the
   truncation is deferred.

### Monitoring Truncation

```sql
-- Check undo tablespace state
SELECT tablespace_name, file_name, autoextend_size
FROM information_schema.FILES
WHERE file_type = 'UNDO LOG';

-- Check if a tablespace is being truncated
SELECT name, state FROM information_schema.INNODB_TABLESPACES
WHERE space_type = 'Undo';
-- state: 'active' or 'inactive' (being truncated)
```

>>> **Interview insight**: "Why does MySQL 8.0 default to 2 undo tablespaces? Because
>>> truncation requires taking a tablespace offline. With only 1, truncation would block
>>> all write transactions. With 2, one serves traffic while the other is truncated and
>>> rebuilt. The minimum is 2, but production systems under heavy write load may benefit
>>> from 3-4 to reduce the frequency of truncation pauses on any individual tablespace."

---

## 9.7 The Long-Running Transaction Problem

This is the single most common undo-related production incident. Understanding the full
impact chain is essential for both operations and interviews.

### Scenario

A developer opens a transaction at 10:00 AM:

```sql
START TRANSACTION;
SELECT * FROM orders WHERE id = 1;   -- creates ReadView at 10:00 AM
-- developer goes to lunch, transaction stays open until 12:00 PM
```

Meanwhile, the application processes 500,000 orders between 10:00 and 12:00.

### Impact Chain

```
Step 1: ReadView holds m_low_limit_id from 10:00 AM
        │
Step 2: Purge view = min(all ReadViews) = 10:00 AM ReadView
        │  → Purge CANNOT clean any undo record from the last 2 hours
        │
Step 3: History list grows: 0 → 50,000 → 200,000 → 500,000
        │
Step 4: Undo tablespace grows on disk: 50 MB → 500 MB → 2 GB
        │
Step 5: MVCC queries on hot rows must traverse longer version chains
        │  → Row id=1000 has 50 versions → consistent read must walk
        │    50 undo records to find the version visible to a new txn
        │
Step 6: Buffer pool fills with undo pages
        │  → Less room for data pages → more disk reads → slower queries
        │
Step 7: Undo tablespace cannot be truncated
           → Disk usage grows indefinitely
```

### Detection

```sql
-- Find long-running transactions
SELECT trx_id, trx_started, trx_state,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_seconds,
       trx_rows_modified, trx_rows_locked,
       trx_mysql_thread_id
FROM information_schema.INNODB_TRX
ORDER BY trx_started ASC;

-- The oldest transaction is the one blocking purge
-- Check its thread to see what it's doing:
SELECT * FROM performance_schema.threads
WHERE processlist_id = <trx_mysql_thread_id>;
```

### Prevention

| Strategy | Implementation |
|----------|---------------|
| Query timeout | `SET GLOBAL MAX_EXECUTION_TIME = 30000;` (30s, per-SELECT hint) |
| Connection timeout | `wait_timeout = 300` (5 min, kill idle connections) |
| Interactive timeout | `interactive_timeout = 300` |
| Application timeout | HikariCP `maxLifetime`, JDBC `socketTimeout` |
| Kill long transactions | `pt-kill` (Percona Toolkit) — automated long-txn killer |
| Code review | Enforce: never hold a transaction across user interaction or network I/O |

### Kill

```sql
-- Identify the thread_id from INNODB_TRX output above
KILL <trx_mysql_thread_id>;
-- Forces rollback of the transaction and closes the connection
```

After killing:
1. The ReadView is released
2. Purge view advances to the next oldest ReadView
3. Purge resumes at full speed, cleaning up accumulated undo records
4. History list length decreases back toward normal

>>> **Interview insight**: "Name the single most dangerous thing a developer can do to
>>> a MySQL instance. Answer: open a transaction and not close it. A single forgotten
>>> `START TRANSACTION` without `COMMIT`/`ROLLBACK` can cascade through the undo system,
>>> degrade buffer pool efficiency, slow down every MVCC read, and bloat disk. The
>>> monitoring response: alert on `information_schema.INNODB_TRX` where `trx_started`
>>> is more than N minutes ago. The architectural response: never hold transactions
>>> across network round-trips."

---

## 9.8 Doublewrite Buffer — Preventing Torn Pages

We now shift from undo (which handles logical correctness) to doublewrite (which handles
physical integrity). This is a crash-safety mechanism at the page level.

### The Torn Page Problem

InnoDB operates in 16 KB pages. The file system and disk hardware operate in smaller
atomic units — typically 4 KB (filesystem block) or 512 bytes (disk sector).

When InnoDB writes a dirty 16 KB page to its data file, the operating system breaks this
into four 4 KB writes. If power fails after the first two 4 KB blocks are written but
before the remaining two complete:

```
InnoDB page (16 KB) being written to disk:

Before crash:
  [4KB block 1: NEW] [4KB block 2: NEW] [4KB block 3: OLD] [4KB block 4: OLD]
       written ✓         written ✓         NOT written ✗      NOT written ✗

Result: page is CORRUPT — half new data, half old data.
This is a "torn page" or "partial write."
```

### Why Redo Log Cannot Fix Torn Pages

You might think: "The redo log records all changes. On recovery, just replay the redo log
over the torn page and reconstruct it." This does NOT work, and the reason is fundamental.

Redo log records are **physiological**: they describe changes relative to a specific page
state. A redo record says "at offset X of page P, write these bytes." If the page is
torn — containing a mixture of old and new data at unpredictable offsets — applying the
redo record produces garbage: the offsets no longer correspond to meaningful positions.

```
Correct page state  +  Redo record  →  Correct result  ✓
Torn (corrupt) page +  Redo record  →  Garbage          ✗
```

The redo log assumes it is being applied to a **correct prior version** of the page (either
the old version before the write, or the new version after a complete write). A torn page
is neither — it is a Frankenstein of two states.

### The Doublewrite Solution

The doublewrite buffer provides a redundant copy of every page before it is written to its
final location. The write path becomes:

```
Step 1: Dirty pages in buffer pool ready for flush

Step 2: Copy pages sequentially to doublewrite buffer region
        (sequential write — fast even on HDD)

Step 3: fsync() the doublewrite buffer
        → Pages are durably on disk in doublewrite buffer

Step 4: Write pages to their actual data file locations
        (random I/O — each page goes to its home location)

Step 5: fsync() the data files
```

### Crash Recovery with Doublewrite

On crash recovery, InnoDB checks each page in the data files for corruption (using the
page checksum stored in the page header). If a page is corrupt (torn):

```
Recovery:
  1. Read page P from data file → checksum mismatch → PAGE IS TORN
  2. Read page P from doublewrite buffer → checksum matches → GOOD COPY
  3. Overwrite torn page in data file with good copy from doublewrite
  4. Now apply redo log records to the restored page → consistent state
```

If the crash happened during Step 2 (writing to doublewrite buffer), the doublewrite
copy is incomplete — but the original page in the data file is still intact (it hasn't
been overwritten yet). Either way, InnoDB has at least one good copy.

```
Crash during Step 2 (writing to doublewrite):
  → Data file page: OLD but INTACT    ← use this + apply redo
  → Doublewrite page: CORRUPT         ← discard

Crash during Step 4 (writing to data file):
  → Data file page: TORN (corrupt)    ← discard
  → Doublewrite page: GOOD            ← restore from this + apply redo
```

### ASCII Diagram: Doublewrite Write Flow

```
 Buffer Pool          Doublewrite Buffer            Data Files
 +----------+         +------------------+
 | Page A   |───┐     |                  |
 | Page B   |───┼────>| [A] [B] [C]     |──fsync──> DURABLE
 | Page C   |───┘     +--------┬---------+
                               │
                               └──> Write pages to actual locations
                                    Page A → tablespace @loc_A
                                    Page B → tablespace @loc_B
                                    Page C → tablespace @loc_C
                                    ──fsync──> DURABLE
```

### Write Amplification

Every page is written twice: doublewrite buffer + data file = 2x write amplification.
But the actual overhead is **5-10%**, not 100%, because the doublewrite write is sequential
(one contiguous I/O for a batch of pages) while the data file writes are already random.
The sequential overhead is negligible relative to N scattered random writes.

### Doublewrite Buffer Location

**Pre-MySQL 8.0.20**: the doublewrite buffer was a 2 MB region (128 pages) within the
system tablespace (`ibdata1`), at a fixed location. This created contention: all page
flushes from all buffer pool instances competed for the same doublewrite region.

```
ibdata1:
  [...system pages...][DOUBLEWRITE 64 pages][DOUBLEWRITE 64 pages][...data...]
                        batch 1                batch 2
```

**MySQL 8.0.20+**: the doublewrite buffer moved to separate files in the data directory.
Each buffer pool instance gets its own doublewrite file, eliminating cross-instance
contention.

```
$DATADIR/
  ├── #ib_16384_0.dblwr     # doublewrite file for batch writes
  ├── #ib_16384_1.dblwr     # doublewrite file for single-page flushes
  └── ...
```

The file names encode the page size (`16384` = 16 KB) and the file purpose (batch flush
vs single-page flush).

### Configuration

```
innodb_doublewrite = ON    (default — NEVER disable unless you know your storage is safe)
```

Disabling the doublewrite buffer saves ~5-10% of write I/O but exposes the database to
torn-page corruption. The ONLY safe reason to disable it is when the storage layer
guarantees atomic 16 KB writes (see next section).

Source: `buf0dblwr.cc:buf_dblwr_write_block_to_datafile()` — the core doublewrite write
path. `buf0dblwr.cc:buf_dblwr_process()` — crash recovery, restoring torn pages from
the doublewrite buffer.

>>> **Interview insight**: "The doublewrite buffer solves a problem that the redo log
>>> cannot: a torn page is neither the old state nor the new state, so redo (which records
>>> deltas from a known state) cannot reconstruct it. The doublewrite buffer provides a
>>> physically intact copy. The write-amplification cost is low because the doublewrite
>>> is sequential. This is one of the most elegant engineering trade-offs in InnoDB."

---

## 9.9 Doublewrite Buffer and SSDs

### The Atomic Write Question

SSDs have a different atomic write unit than HDDs. The key question: can the storage layer
guarantee that a 16 KB write is atomic — either fully committed or not written at all?

| Storage | Typical Atomic Write Unit | 16 KB Atomic? |
|---------|--------------------------|---------------|
| HDD (512-byte sector) | 512 bytes | No |
| SSD (SATA/NVMe, typical) | 4 KB | No |
| SSD (some enterprise NVMe) | 4 KB - 16 KB | Maybe |
| FusionIO / non-volatile memory | 16 KB+ | Yes |
| ZFS (with `recordsize=16k`) | 16 KB | Yes (at ZFS level) |

### When to Disable Doublewrite

You can safely disable the doublewrite buffer only when ALL of the following hold:

1. The storage hardware guarantees atomic writes >= 16 KB.
2. The filesystem does not break the write into smaller blocks.
3. The OS I/O scheduler does not split the write.

In practice, this is rare. Even SSDs that support 16 KB atomic writes may have the
guarantee broken by the filesystem (ext4 journaling, XFS log) or the kernel I/O stack.

### `innodb_doublewrite = DETECT_AND_RECOVER` (MySQL 8.0.30+)

MySQL 8.0.30 introduced a third option:

```
innodb_doublewrite = DETECT_AND_RECOVER
```

This mode still writes pages to the doublewrite buffer, but skips the fsync of the
doublewrite buffer before writing to data files. The doublewrite data is used ONLY for
torn-page detection during crash recovery, not as a guaranteed-good copy.

This provides a middle ground:
- Less write I/O than full doublewrite (no extra fsync)
- Still detects torn pages on recovery
- But cannot always recover from them (if doublewrite copy is also torn)

Use case: storage that provides near-atomic writes (some torn pages possible but rare).

### Cloud Storage Considerations

| Cloud Storage | Atomic Page Writes? | Recommendation |
|---------------|--------------------|----|
| AWS EBS (gp3, io2) | Not guaranteed at 16 KB | Keep doublewrite ON |
| GCE Persistent Disk | Not guaranteed at 16 KB | Keep doublewrite ON |
| Azure Managed Disk | Not guaranteed at 16 KB | Keep doublewrite ON |
| AWS Aurora | Not applicable | Aurora replaces InnoDB I/O entirely |
| Local NVMe (i3/i3en) | Check device spec | May support, verify first |

For cloud-managed MySQL services (RDS, Cloud SQL, Azure Database), the provider handles
doublewrite configuration — you typically cannot change it.

>>> **Interview insight**: "Should you disable the doublewrite buffer on SSDs? Almost
>>> never. SSDs guarantee 4 KB atomic writes, but InnoDB pages are 16 KB. A torn page
>>> is still possible unless the SSD explicitly supports 16 KB atomic writes AND the
>>> filesystem preserves this guarantee. The ~5% I/O overhead of doublewrite is almost
>>> always worth the safety. The only validated exceptions are FusionIO-style hardware
>>> with application-level atomic write APIs."

---

## 9.10 Putting It All Together — The Write Path

This section traces a single `UPDATE` statement from SQL parsing to final durability
on disk. Every component covered in Chapters 8 and 9 appears in this trace.

### The Complete Write Path for an UPDATE

```sql
UPDATE accounts SET balance = 500 WHERE id = 42;
-- Assume: current balance = 1000, row is in buffer pool, transaction already started
```

**Step 1: Parse, Optimize, Acquire Locks**

The SQL layer parses the statement, the optimizer chooses a clustered index lookup on
`id = 42`, and the execution layer requests an X (exclusive) lock on the index record.

Source: `sql_parse.cc → sql_optimizer.cc → ha_innobase::write_row()`

**Step 2: Read Current Row from Buffer Pool**

InnoDB locates page containing `id=42` in the buffer pool (or reads it from disk into
the buffer pool if not cached). The current row values are read:

```
Current row: id=42, balance=1000, DB_TRX_ID=T_old, DB_ROLL_PTR=old_ptr
```

**Step 3: Write Undo Log Record**

Before modifying the row, InnoDB writes an **update undo log record** to an undo log page
in the buffer pool. This records the before-image:

```
Undo record:
  type: TRX_UNDO_UPD_EXIST_REC
  table_id: <accounts>
  primary_key: id=42
  old_trx_id: T_old
  old_roll_ptr: old_ptr
  changed_columns: [balance = 1000]     ← the OLD value
```

The undo log page is a buffer pool page backed by the undo tablespace. At this point, the
undo record exists only in memory (the undo page is dirty).

**Step 4: Modify Row in Buffer Pool**

InnoDB modifies the row in-place in the clustered index page (also in buffer pool):

```
Updated row: id=42, balance=500, DB_TRX_ID=T_current, DB_ROLL_PTR=new_undo_ptr
                                  ^^^^^^^^^            ^^^^^^^^^^^^^^
                                  set to current txn   points to the undo record
                                                       written in Step 3
```

The data page is now dirty.

**Step 5: Generate Redo Log Records**

InnoDB generates redo log records in the log buffer for BOTH modifications:

```
Redo record 1: "On undo page X, at offset Y, write these bytes" (the undo record)
Redo record 2: "On data page P, at offset Q, write these bytes" (the row update)
```

Both redo records are appended to the log buffer (`log_buffer`). Note: the redo log
protects BOTH the undo log pages and the data pages. If the server crashes after Step 5,
recovery will replay both redo records, restoring both the undo record and the row update.

**Step 6: COMMIT — Flush Redo Log**

When the transaction commits, InnoDB flushes the redo log based on `innodb_flush_log_at_trx_commit`:

| Setting | Behavior | Durability |
|---------|----------|------------|
| 1 (default) | Write + fsync redo log at each commit | Full ACID |
| 2 | Write redo log at commit, fsync once/sec | OS crash can lose ~1s |
| 0 | Write + fsync once/sec | Crash can lose ~1s |

After the redo log is fsynced, the transaction is durable. The dirty data page and dirty
undo page are still only in the buffer pool — they have NOT been written to their data files
yet. This is safe because the redo log can reconstruct them on crash recovery.

The update undo record is added to the **history list** for eventual purge.
The insert undo log (if any) is freed immediately.

**Step 7: Page Cleaner Flushes Dirty Pages (Background)**

Minutes later (or when the buffer pool needs free pages), the page cleaner threads
flush dirty pages to disk through the doublewrite buffer:

```
Page Cleaner Thread:
  1. Collect batch of dirty pages
  2. Write batch to doublewrite buffer (sequential)
  3. fsync doublewrite buffer
  4. Write each page to its data file location (random I/O)
  5. fsync data files
  6. Advance checkpoint LSN (this log space can be reclaimed)
```

Both the undo log pages and the data pages go through this same doublewrite → data file
path.

**Step 8: Purge Cleans Up Undo Records (Background)**

Eventually, the purge coordinator checks the purge view and determines that no active
ReadView references the undo record from Step 3. The purge worker frees the undo log
pages, and the history list length decreases by one.

### ASCII Diagram: Complete Write Path

```
 UPDATE accounts SET balance=500 WHERE id=42;
    │
    ▼
 [1. Parse/Optimize/Lock] → [2. Read row from Buffer Pool]
    │
    ▼
 [3. Write UNDO (before-image) to undo page in BP]
    │
    ▼
 [4. Modify row in data page in BP (set TRX_ID, ROLL_PTR)]
    │
    ▼
 [5. Generate REDO records in Log Buffer (for undo + data pages)]
    │
    ▼
 [6. COMMIT: fsync redo log → DURABLE]
    │                              undo record → history list
    │
    ├──────────────────────────────┐
    ▼ (background)                ▼ (background)
 [7. Page Cleaner]             [8. Purge System]
    │                              │
    ▼                           Check purge view:
 Doublewrite Buffer             no reader? → free undo pages
 (sequential + fsync)           still needed? → keep
    │
    ▼
 Data File (random I/O)
    │
    ▼
 Checkpoint advances
```

### Timing Summary

| Step | When | What becomes durable |
|------|------|---------------------|
| Steps 1-5 | During statement execution | Nothing on disk yet (all in buffer pool + log buffer) |
| Step 6 | At COMMIT | Redo log on disk — transaction is durable |
| Step 7 | Background (seconds to minutes later) | Data pages and undo pages on disk |
| Step 8 | Background (seconds to hours later) | Undo records freed |

The key insight: **the transaction is durable the instant the redo log is fsynced** (Step 6).
The actual data pages may not reach disk for minutes. This is safe because crash recovery
replays the redo log to reconstruct any dirty pages that were lost from the buffer pool.

### The Four Safety Nets

```
┌──────────────────────────────────────────────────────────────┐
│                    InnoDB Safety Stack                        │
│                                                              │
│  Layer 4: APPLICATION     Transaction isolation (MVCC)       │
│           ▲                via ReadView + Undo Log           │
│           │                                                  │
│  Layer 3: LOGICAL         Undo Log provides rollback         │
│           ▲                + version history                 │
│           │                                                  │
│  Layer 2: PHYSICAL-LOG    Redo Log guarantees durability     │
│           ▲                of committed transactions         │
│           │                                                  │
│  Layer 1: PHYSICAL-PAGE   Doublewrite Buffer prevents        │
│                            torn-page corruption              │
└──────────────────────────────────────────────────────────────┘

Each layer protects against a different failure mode:
  Layer 1: Power failure mid-page-write   → doublewrite
  Layer 2: Crash after commit             → redo log replay
  Layer 3: Transaction abort / MVCC       → undo log
  Layer 4: Concurrent access              → ReadView + undo log
```

>>> **Interview insight**: "Walk me through what happens when you UPDATE a row in InnoDB."
>>> Answer: (1) Acquire X-lock on the index record. (2) Write the before-image as an undo
>>> record in a buffer pool undo page. (3) Modify the row in-place in the buffer pool data
>>> page, setting DB_TRX_ID and DB_ROLL_PTR. (4) Generate redo records for both the undo
>>> page change and the data page change. (5) At commit, fsync the redo log — the transaction
>>> is now durable. (6) Background: page cleaner writes dirty pages via the doublewrite buffer.
>>> (7) Background: purge eventually frees the undo record when no ReadView needs it. The
>>> critical point: the data page is NOT written to disk at commit time — only the redo log is."

---

## 9.11 Practical Operations Reference

### Essential Monitoring

```sql
-- History list length (most important undo metric)
SHOW ENGINE INNODB STATUS\G   -- TRANSACTIONS section: "History list length NNNN"

-- Long-running transactions blocking purge
SELECT trx_id, trx_started,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_sec,
       trx_rows_modified, trx_mysql_thread_id
FROM information_schema.INNODB_TRX ORDER BY trx_started;

-- Undo tablespace size on disk
SELECT file_name, ROUND(total_extents * extent_size / 1024 / 1024, 2) AS size_mb
FROM information_schema.FILES WHERE file_type = 'UNDO LOG';

-- Doublewrite activity
SHOW STATUS LIKE 'Innodb_dblwr%';
```

### Configuration Quick Reference

| Parameter | Default | Notes |
|-----------|---------|-------|
| `innodb_undo_tablespaces` | 2 | Minimum 2 (for truncation) |
| `innodb_rollback_segments` | 128 | Per undo tablespace |
| `innodb_undo_log_truncate` | ON | Auto-truncate when exceeds max size |
| `innodb_max_undo_log_size` | 1 GB | Truncation threshold |
| `innodb_purge_threads` | 4 | Coordinator + workers |
| `innodb_purge_batch_size` | 300 | Undo pages per purge iteration |
| `innodb_max_purge_lag` | 0 | DML throttle threshold (0 = off) |
| `innodb_doublewrite` | ON | Never disable without atomic-write storage |

>>> **Interview insight**: "You get paged at 3 AM: MySQL queries are slow and disk usage
>>> is climbing. Where do you look first?" Answer: `SHOW ENGINE INNODB STATUS` --
>>> TRANSACTIONS section -- history list length. If it is large and growing, find the oldest
>>> transaction in `INNODB_TRX`, kill it, and watch the history list drain. Then investigate
>>> why the transaction was held open."

---

## Summary: Key Concepts Map

```
┌─────────────────────────────────────────────────────────────────┐
│                   Chapter 9 Concept Map                         │
│                                                                 │
│  UNDO LOG                                                       │
│  ├── Insert Undo: rollback only, freed at commit                │
│  ├── Update Undo: rollback + MVCC, freed by purge              │
│  ├── Physical: tablespace → rseg → slot → records              │
│  ├── Record: before-image, chained via DB_ROLL_PTR             │
│  └── Max concurrency: tablespaces × 128 × 1024                 │
│                                                                 │
│  PURGE SYSTEM                                                   │
│  ├── Removes delete-marked rows (physical delete)               │
│  ├── Frees update undo records past purge view                  │
│  ├── Purge view = oldest active ReadView                        │
│  ├── History list length = key health metric                    │
│  └── Long-running txn = purge blocker = cascading degradation   │
│                                                                 │
│  DOUBLEWRITE BUFFER                                             │
│  ├── Prevents torn pages (16KB page vs 4KB filesystem block)    │
│  ├── Redo cannot fix torn pages (physiological records)         │
│  ├── Write twice: doublewrite (seq) → data file (random)        │
│  ├── ~5-10% overhead, not 100%                                  │
│  └── Disable only with verified atomic-write storage            │
│                                                                 │
│  WRITE PATH (end-to-end)                                        │
│  ├── Lock → Undo → Modify → Redo → Commit(fsync redo)          │
│  ├── Background: page cleaner → doublewrite → data file         │
│  └── Background: purge → free undo records                      │
└─────────────────────────────────────────────────────────────────┘
```

---

*Next: [Chapter 10 — Locking Internals](10-locking-internals.md) — why a range scan
locks rows you never asked for, and how gap locks prevent phantom reads.*
