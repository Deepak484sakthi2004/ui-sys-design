# Chapter 10: Locking Internals — Why a Range Scan Locks Rows You Didn't Ask For

> Written from the perspective of a MySQL engine developer and systems researcher.
> Source references: MySQL 8.0 / mysql-server (github.com/mysql/mysql-server)
> InnoDB lock subsystem: `storage/innobase/lock/`

---

## 1. InnoDB Lock Types Hierarchy

InnoDB implements a multi-granularity locking protocol. Locks exist at two levels --
table level and row level -- and the two levels are coordinated through intention locks.
Understanding the full hierarchy is the key to explaining every mysterious lock wait
you will ever see.

```
                        InnoDB Lock Hierarchy

                      +-------------------+
                      |   TABLE-LEVEL     |
                      |                   |
                      |  S    X    IS  IX |
                      |  AI (AUTO-INC)    |
                      +--------+----------+
                               |
                               | intention locks bridge
                               | table-level ↔ row-level
                               |
                      +--------v----------+
                      |    ROW-LEVEL      |
                      |                   |
                      |  Record Lock (S/X)|
                      |  Gap Lock         |
                      |  Next-Key Lock    |
                      |  Insert Intention |
                      |  Predicate Lock   |
                      +-------------------+
```

### 1.1 Table-Level Locks

| Lock   | Meaning                                           |
|--------|---------------------------------------------------|
| S      | Shared table lock. Entire table readable, no writes allowed. |
| X      | Exclusive table lock. Full exclusive access.       |
| IS     | Intention Shared. Transaction intends to set S locks on rows. |
| IX     | Intention Exclusive. Transaction intends to set X locks on rows. |
| AI     | AUTO-INC lock. Serializes auto-increment value generation. |

### 1.2 Row-Level Locks

| Lock              | What It Locks                                          |
|-------------------|--------------------------------------------------------|
| Record Lock       | A single index record.                                  |
| Gap Lock          | The gap between two consecutive index records.          |
| Next-Key Lock     | Record Lock + Gap Lock on the gap before that record.   |
| Insert Intention  | A gap lock variant set by INSERT to signal intent.      |
| Predicate Lock    | Used only with spatial indexes (R-Tree). Locks an MBR.  |

### 1.3 Full Compatibility Matrix

The following matrix shows which lock types can coexist on the same resource. A cell
marked `Y` means the two locks are compatible (can be held simultaneously). `N` means
the requesting lock must wait.

**Table-level compatibility:**

```
                     Requested Lock
                 +------+------+------+------+
                 |  IS  |  IX  |   S  |   X  |
      +----------+------+------+------+------+
  H   |    IS    |  Y   |  Y   |  Y   |  N   |
  e   |    IX    |  Y   |  Y   |  N   |  N   |
  l   |     S    |  Y   |  N   |  Y   |  N   |
  d   |     X    |  N   |  N   |  N   |  N   |
      +----------+------+------+------+------+

  Y = Compatible (both granted)
  N = Conflict (requester waits)
```

**Row-level compatibility (on the same index record or gap):**

```
                            Requested Lock
                 +----------+------+----------+--------+
                 | Record-S | Rec-X| Gap Lock | InsInt |
      +----------+----------+------+----------+--------+
  H   | Record-S |    Y     |  N   |    Y     |   Y    |
  e   | Record-X |    N     |  N   |    Y     |   Y    |
  l   | Gap Lock |    Y     |  Y   |    Y     |   N    |
  d   | InsInt   |    Y     |  Y   |    N     |   Y    |
      +----------+----------+------+----------+--------+

  Key insight: gap locks do NOT conflict with each other.
  Gap locks only block insert intention locks.
  Insert intention locks only conflict with gap locks,
  NOT with other insert intention locks.
```

`>>> Interview gold: "Gap locks are compatible with each other. Two transactions can
hold gap locks on the same gap simultaneously. Gap locks only block INSERT operations
(via insert intention lock conflict). This is why gap locks prevent phantoms without
blocking reads or other gap locks."`

---

## 2. Intention Locks

### 2.1 The Problem They Solve

Consider a naive approach: Transaction T1 wants a table-level S lock on `orders`. To
verify no row-level X locks exist, the engine would need to scan every row in the table.
For a table with 100 million rows, this is catastrophic.

Intention locks solve this with a two-step protocol:

```
WITHOUT intention locks:
  T1 wants TABLE S lock on `orders`
  → must check ALL rows for X locks
  → O(N) where N = total rows
  → 100M rows = unacceptable

WITH intention locks:
  T2 acquires IX on `orders` table (instant)
  T2 acquires X record lock on row pk=42
  ...
  T1 wants TABLE S lock on `orders`
  → checks table-level locks only
  → sees IX held by T2
  → IX conflicts with table-level S
  → T1 waits
  → O(1) check
```

### 2.2 IS (Intention Shared)

Acquired automatically when a transaction sets an S lock on any row.

```sql
-- This implicitly acquires IS on the `orders` table first,
-- then S record lock on the matching index entries.
SELECT * FROM orders WHERE id = 5 FOR SHARE;
```

### 2.3 IX (Intention Exclusive)

Acquired automatically when a transaction sets an X lock on any row.

```sql
-- This implicitly acquires IX on the `orders` table first,
-- then X record lock on id=5.
SELECT * FROM orders WHERE id = 5 FOR UPDATE;
```

### 2.4 Coexistence Rules

Intention locks serve only as table-level signals. They never conflict with each other:

- IS + IS = compatible. Multiple transactions can read-lock different rows.
- IS + IX = compatible. One transaction can read-lock rows while another write-locks
  different rows.
- IX + IX = compatible. Multiple transactions can write-lock different rows.

But they do conflict with full table-level locks:

- IS + table X = conflict. A table-level exclusive lock blocks all row-level locking.
- IX + table S = conflict. A table-level shared lock blocks row-level exclusive locking.

```sql
-- This acquires table-level S lock.
-- It will block if ANY transaction holds IX (meaning some row has X lock).
LOCK TABLES orders READ;

-- This acquires table-level X lock.
-- It will block if ANY transaction holds IS or IX.
LOCK TABLES orders WRITE;
```

`>>> "Intention locks are the reason InnoDB can do row-level locking efficiently in the
presence of table-level lock requests. Without them, LOCK TABLES READ would need to
check every row -- intention locks turn an O(N) check into O(1)."`

---

## 3. Record Locks

### 3.1 What Exactly Is Locked

A record lock does not lock a row in the heap/tablespace. It locks an **index record**.
The lock is on the index entry itself, inside the index structure. This is a critical
distinction.

```
B+Tree (Clustered Index):

  Internal:   [  10  |  50  |  90  ]
               /        |        \
  Leaf:   [1,5,9]   [10,30,42]   [50,70,88]
                         ^
                   Record lock here = lock the
                   INDEX ENTRY for pk=42, not
                   a "row" in some abstract sense

Source: lock/lock0lock.cc — lock_rec_lock()
```

Even if a table has no user-defined indexes, InnoDB creates a hidden clustered index
on an internal 6-byte `DB_ROW_ID` column, and record locks are placed on that hidden
index's entries.

### 3.2 S and X Record Locks

| Lock Mode | Acquired By | Blocks |
|-----------|-------------|--------|
| S (Shared) | `SELECT ... FOR SHARE` | X record lock |
| X (Exclusive) | `SELECT ... FOR UPDATE`, `UPDATE`, `DELETE`, `INSERT` | Both S and X record locks |

```sql
-- Transaction T1:
SELECT * FROM orders WHERE id = 42 FOR SHARE;
-- Acquires S record lock on index entry id=42

-- Transaction T2 (concurrent):
SELECT * FROM orders WHERE id = 42 FOR UPDATE;
-- Requests X record lock on id=42 → BLOCKED (S conflicts with X)

-- Transaction T3 (concurrent):
SELECT * FROM orders WHERE id = 42 FOR SHARE;
-- Requests S record lock on id=42 → GRANTED (S compatible with S)
```

### 3.3 Source Code Path

```
lock_rec_lock()                        // lock/lock0lock.cc
  → lock_rec_lock_fast()              // fast path: no conflicting waiters
    → lock_rec_create()               // allocate lock_t, set bits in bitmap
  → lock_rec_lock_slow()              // slow path: check wait-for graph
    → lock_rec_other_has_conflicting() // walk lock list on the record
    → lock_rec_enqueue_waiting()       // add to wait queue, may detect deadlock
```

Each `lock_t` structure contains a bitmap where each bit corresponds to a record on a
page (identified by heap_no). This is why InnoDB can hold locks on individual records
within a page without allocating a separate structure per record.

`>>> "Record locks operate on index entries, not rows. If your table has no index,
InnoDB uses a hidden clustered index. This means every DML on an unindexed column
degrades to a clustered index scan, acquiring locks on every record visited -- which
effectively becomes a table lock."`

---

## 4. Gap Locks

### 4.1 What Is a Gap

A gap is the interval between two consecutive index records, or before the first record,
or after the last record. Gap locks prevent insertions into these intervals.

```
Index records:  [1]  [5]  [10]  [15]  [supremum]

Gaps:
  (-inf, 1)      gap before first record
  (1, 5)         gap between 1 and 5
  (5, 10)        gap between 5 and 10
  (10, 15)       gap between 10 and 15
  (15, +inf)     gap after last record (before supremum pseudo-record)
```

The **supremum** is a pseudo-record that InnoDB places on every index page to represent
"greater than any real key on this page." Gap locks on supremum lock the gap after the
last real record.

### 4.2 Gap Lock Properties

**Property 1: Gap locks do NOT conflict with each other.**

Two transactions can hold gap locks on the identical gap. This is safe because a gap
lock does not protect any existing data -- it only prevents new insertions.

```sql
-- T1:
SELECT * FROM t WHERE id BETWEEN 6 AND 9 FOR UPDATE;
-- Acquires gap lock on (5, 10) if 6-9 don't exist

-- T2 (concurrent):
SELECT * FROM t WHERE id BETWEEN 6 AND 9 FOR SHARE;
-- Also acquires gap lock on (5, 10) → NO CONFLICT, both granted
```

**Property 2: Gap locks only conflict with insert intention locks.**

The gap lock's sole job is to block `INSERT` operations from landing in the gap. An
`INSERT` first acquires an insert intention lock (Section 6), which conflicts with any
held gap lock.

**Property 3: Gap locks are suppressed under READ COMMITTED.**

Under RC isolation, InnoDB releases gap locks immediately after the row-evaluation
step. Under RC, phantoms are allowed by definition, so gap locking is unnecessary.

```sql
-- Under READ COMMITTED, this acquires only record locks, no gap locks:
SET SESSION transaction_isolation = 'READ-COMMITTED';
SELECT * FROM orders WHERE status = 'pending' FOR UPDATE;
```

Gap locks can also be disabled (deprecated approach):

```
innodb_locks_unsafe_for_binlog = ON   -- deprecated in 8.0, removed in 8.0.36
```

### 4.3 Why Gap Locks Exist: Preventing Phantoms

```
Without gap locks (phantom problem):

  T1: SELECT * FROM orders WHERE amount > 100 FOR UPDATE;
      → locks records with amount = 150, 200, 300
      → returns 3 rows

  T2: INSERT INTO orders (amount) VALUES (175);
      → succeeds! no lock blocks this insert

  T1: SELECT * FROM orders WHERE amount > 100 FOR UPDATE;
      → now returns 4 rows — "phantom" row appeared

With gap locks (phantom prevented):

  T1: SELECT * FROM orders WHERE amount > 100 FOR UPDATE;
      → locks records AND gaps between them
      → gap (150, 200) locked, gap (100, 150) locked, etc.

  T2: INSERT INTO orders (amount) VALUES (175);
      → insert intention lock conflicts with gap lock on (150, 200)
      → T2 BLOCKS until T1 commits

  T1: re-reads → same 3 rows → no phantom
```

`>>> "Gap locks only exist under REPEATABLE READ and SERIALIZABLE. Switching to
READ COMMITTED eliminates gap locks entirely -- which reduces contention but allows
phantom reads. This is the most impactful isolation-level tradeoff in InnoDB. Many
production systems use RC for performance and handle phantoms at the application
level."`

---

## 5. Next-Key Locks

### 5.1 Definition

A next-key lock is the combination of a record lock on an index record and a gap lock
on the gap immediately before that record. It locks the half-open interval
`(previous_key, current_key]`.

```
Next-Key Lock = Record Lock + Gap Lock (on the gap BEFORE the record)

Locked interval: (prev_key, current_key]
                  ^^^^^^^^              ^
                  open (excluded)       closed (included)
```

This is InnoDB's default locking unit under REPEATABLE READ isolation.

### 5.2 Next-Key Lock Ranges on an Index

Consider an index with keys `[1, 5, 10, 15]`:

```
Index:  [infimum]   [1]   [5]   [10]   [15]   [supremum]

Next-key lock ranges:

  (-inf, 1]     — gap before 1 + record lock on 1
  (1, 5]        — gap between 1 and 5 + record lock on 5
  (5, 10]       — gap between 5 and 10 + record lock on 10
  (10, 15]      — gap between 10 and 15 + record lock on 15
  (15, +inf)    — gap after 15 (gap lock on supremum, no record lock)

                        the half-open intervals tile the entire key space
```

Note the last range: a gap lock on the supremum pseudo-record locks `(15, +inf)`.
Since supremum is not a real record, there is no record lock component -- just the gap.

### 5.3 How Next-Key Locks Prevent Phantoms

When InnoDB scans an index range, it places next-key locks on every record it visits,
plus the record just beyond the scan boundary. This seals every gap in the scanned
range against insertions.

```
Query: SELECT * FROM t WHERE id BETWEEN 5 AND 10 FOR UPDATE;

Index: [1]  [5]  [10]  [15]

Locks acquired:
  Next-key lock on id=5:   locks (1, 5]
  Next-key lock on id=10:  locks (5, 10]
  Next-key lock on id=15:  locks (10, 15]   ← "one past the end"

Total locked range: (1, 15]

Why lock id=15? Without it, an INSERT of id=12 would succeed (falls in
the gap (10, 15)), and a re-scan would see a phantom row.
```

### 5.4 The "Extra" Lock Problem

This is the core of the chapter title: *why a range scan locks rows you didn't ask for*.

You asked for rows 5 through 10. InnoDB locked the interval `(1, 15]`. Records with
id=1 (via gap) and id=15 (via next-key lock) are now partially locked even though your
query never intended to touch them.

The id=15 record lock specifically means another transaction cannot `UPDATE` or
`DELETE` the row with id=15 while your transaction holds this lock. This is a direct
consequence of next-key locking preventing phantoms.

```
                 your query asks for [5, 10]
                 InnoDB actually locks (1, 15]

     1       5       10      15
     |       |=======|       |
     (-------[=======]-------)
     ^                       ^
     gap before 5            next-key on 15
     blocks INSERT 2,3,4     blocks INSERT 11-14
                             AND locks record 15
```

`>>> "The single most common source of unexpected lock waits in production: next-key
locks extend beyond the query's WHERE clause range. The lock on the 'boundary' record
(id=15 above) is not a bug -- it is the mechanism that prevents phantom reads. To reduce
this: use unique indexes (which eliminate gap locks for equality lookups), reduce
isolation to RC, or restructure queries."`

---

## 6. Insert Intention Locks

### 6.1 What They Are

An insert intention lock is a special type of gap lock acquired by `INSERT` before
placing the actual row. It signals: "I intend to insert a row at position X within
this gap."

### 6.2 Compatibility Rules

Insert intention locks have two critical properties:

**They conflict with gap locks.** If any transaction holds a gap lock on the gap where
the INSERT wants to place a record, the insert intention lock must wait.

**They do NOT conflict with each other.** Two INSERTs targeting different positions
within the same gap can proceed concurrently.

```
Gap (5, 10):

  T1: INSERT id=7 → acquires insert intention lock at position 7
  T2: INSERT id=8 → acquires insert intention lock at position 8
  → Both proceed concurrently! No conflict between insert intention locks.

  But if T3 holds a gap lock on (5, 10):
  T1: INSERT id=7 → insert intention lock conflicts with T3's gap lock → WAITS
  T2: INSERT id=8 → insert intention lock conflicts with T3's gap lock → WAITS
```

### 6.3 The Phantom Prevention Mechanism

The full sequence that prevents phantoms:

```
Step 1: T1 runs SELECT ... WHERE id BETWEEN 5 AND 10 FOR UPDATE
        → acquires next-key locks on (1,5], (5,10], (10,15]
        → this includes gap locks on gaps (1,5), (5,10), (10,15)

Step 2: T2 runs INSERT INTO t (id) VALUES (7)
        → must acquire insert intention lock on gap (5,10)
        → insert intention lock conflicts with T1's gap lock on (5,10)
        → T2 WAITS

Step 3: T1 re-runs the SELECT
        → sees same rows as before → no phantom

Step 4: T1 commits → gap locks released → T2 proceeds with INSERT
```

`>>> "Insert intention locks are the linchpin connecting gap locks to phantom
prevention. The chain is: range scan → next-key locks → gap locks → block insert
intention locks → INSERT waits → phantom prevented. Every link in this chain exists
for a reason."`

---

## 7. Locking by Statement Type — Detailed Analysis

All examples assume REPEATABLE READ isolation unless stated otherwise. The table `t`
has a primary key on `id` (clustered index) and may have secondary indexes as noted.

### 7.1 Unique Index Equality: `SELECT ... WHERE pk = 5 FOR UPDATE`

```
Query:   SELECT * FROM t WHERE id = 5 FOR UPDATE;
Index:   Clustered (unique)
Lookup:  Equality on unique index

Locks acquired:
  1. IX intention lock on table t
  2. X record lock on index entry id=5 (clustered index)

  NO gap lock. InnoDB recognizes that a unique index equality match
  can return at most one row, so phantom prevention via gap lock is
  unnecessary.

Source: lock/lock0lock.cc — lock_rec_lock()
  → if (unique index && equality && record found) → skip gap lock
```

This is the most efficient locking pattern. Design queries to use unique index equality
whenever possible.

### 7.2 Unique Index Range: `SELECT ... WHERE pk BETWEEN 5 AND 10 FOR UPDATE`

```
Query:   SELECT * FROM t WHERE id BETWEEN 5 AND 10 FOR UPDATE;
Index:   Clustered (unique)
Records: [1, 5, 10, 15]

Locks acquired:
  1. IX on table t
  2. Next-key lock on id=5:  locks (1, 5]
  3. Next-key lock on id=10: locks (5, 10]
  4. Next-key lock on id=15: locks (10, 15]   ← boundary lock

Even though the index is unique, a range scan requires next-key locks
to prevent phantom inserts within the range.

Locked range: (1, 15]
```

### 7.3 Non-Unique Index Equality: `SELECT ... WHERE non_unique_idx = 5 FOR UPDATE`

```
Table:   CREATE TABLE t (id INT PK, status INT, INDEX idx_status(status));
Query:   SELECT * FROM t WHERE status = 5 FOR UPDATE;
Records: status index has entries [1, 5, 5, 10]

Locks acquired (two indexes involved):
  1. IX on table t

  Secondary index (idx_status):
  2. Next-key lock on first status=5:   locks (1, 5]
  3. Next-key lock on second status=5:  locks (5, 5]
  4. Gap lock on status=10:             locks (5, 10)
     ^ gap lock only, no record lock on 10

  Clustered index:
  5. X record lock on each matching PK (e.g., id=3 and id=7)
     (no gap lock on clustered index — just record locks)

Why lock the gap (5, 10) on the secondary index? To prevent
another transaction from inserting a new row with status=5.
```

### 7.4 No Index: `SELECT ... WHERE no_index_col = 5 FOR UPDATE`

```
Query:   SELECT * FROM t WHERE unindexed_col = 5 FOR UPDATE;
Index:   No index on unindexed_col

Execution: Full clustered index scan.

Locks acquired:
  1. IX on table t
  2. Next-key lock on EVERY record in the clustered index
  3. Gap lock on supremum

  This is effectively a table lock. Every record and every gap
  is locked. No other transaction can INSERT, UPDATE, or DELETE
  any row in this table.

This is why missing indexes are devastating: not just slow queries,
but catastrophic lock contention.
```

`>>> "A SELECT FOR UPDATE on an unindexed column locks EVERY row in the table, not just
matching rows. This is because InnoDB must scan the entire clustered index and cannot
determine which rows match without examining each one. It places next-key locks as it
scans. The fix is always: add an index. This is the #1 cause of mystery table-wide
lock contention in production."`

### 7.5 UPDATE Statement

```
-- Case 1: UPDATE with unique index equality
UPDATE t SET col = 'x' WHERE id = 5;
Locks: X record lock on id=5 (no gap lock — unique equality)

-- Case 2: UPDATE with range
UPDATE t SET col = 'x' WHERE id BETWEEN 5 AND 10;
Locks: next-key locks on all records in range + boundary record
       (identical to SELECT ... FOR UPDATE with same WHERE)

-- Case 3: UPDATE with no index
UPDATE t SET col = 'x' WHERE unindexed = 5;
Locks: next-key locks on ALL records (full table scan)
```

If the UPDATE modifies a secondary index column, InnoDB also acquires X locks on the
affected secondary index entries (both old and new values).

### 7.6 DELETE Statement

```
DELETE FROM t WHERE id = 5;

Locks:
  1. IX on table t
  2. X record lock on id=5

Note: DELETE on a unique index equality also acquires a gap lock
in some cases. When the record is delete-marked but not yet purged,
InnoDB places a next-key lock because the record is effectively
"not found" from the transaction's perspective.

Source: row/row0sel.cc — row_search_mvcc()
  → if (delete-marked && not visible) → next-key lock
```

### 7.7 INSERT Statement

```
INSERT INTO t (id, col) VALUES (7, 'x');

Locks acquired (in order):
  1. IX on table t
  2. Insert intention lock on the gap where id=7 will be placed
     → if gap lock held by another txn on this gap → WAIT
  3. X record lock on the newly inserted index entry id=7

No gap lock is acquired by INSERT. Only the insert intention lock
(which is a special gap lock that doesn't block other inserts at
different positions).
```

### 7.8 INSERT ... ON DUPLICATE KEY UPDATE

```
INSERT INTO t (id, col) VALUES (5, 'x') ON DUPLICATE KEY UPDATE col = 'y';

Case 1: id=5 does NOT exist
  → insert intention lock + X record lock on new entry (same as plain INSERT)

Case 2: id=5 EXISTS (duplicate key detected)
  → S lock on existing id=5 first (to verify the duplicate)
  → then X lock on id=5 (to perform the update)
  → this S→X upgrade can cause deadlocks with concurrent operations

Deadlock scenario:
  T1: INSERT ... ON DUPLICATE KEY UPDATE (id=5) → acquires S on id=5
  T2: INSERT ... ON DUPLICATE KEY UPDATE (id=5) → acquires S on id=5
  T1: tries to upgrade S → X on id=5 → BLOCKED by T2's S
  T2: tries to upgrade S → X on id=5 → BLOCKED by T1's S
  → DEADLOCK
```

`>>> "INSERT ON DUPLICATE KEY UPDATE with concurrent transactions on the same key is a
classic deadlock source. The S-to-X lock upgrade creates a cycle. Solutions: use
REPLACE INTO (acquires X directly, but does DELETE + INSERT), use application-level
mutex for hot keys, or catch error 1213 and retry."`

### 7.9 Summary Table

```
+-------------------------------------------+-----------------------------+
| Statement                                 | Locks (under RR)            |
+-------------------------------------------+-----------------------------+
| SELECT ... WHERE uk=5 FOR UPDATE          | X record on uk=5            |
| SELECT ... WHERE uk BETWEEN 5 AND 10 FU  | next-key on range + bound.  |
| SELECT ... WHERE non_uk=5 FOR UPDATE      | next-key on sec idx + rec   |
|                                           | locks on clustered idx      |
| SELECT ... WHERE no_idx=5 FOR UPDATE      | next-key on ALL records     |
| UPDATE ... WHERE uk=5                     | X record on uk=5            |
| DELETE ... WHERE uk=5                     | X record on uk=5 (+gap*)    |
| INSERT (id=7)                             | insert intention + X record |
| INSERT ... ON DUP KEY UPDATE              | S then X on dup record      |
+-------------------------------------------+-----------------------------+
  uk = unique key, non_uk = non-unique key, no_idx = no index
  * gap lock if record is delete-marked but not purged
```

---

## 8. Lock Optimization: Reducing Lock Ranges

### 8.1 Unique Index Equality Optimization

InnoDB's most important lock optimization: when a query uses an equality condition on a
unique index and finds a match, the gap lock is suppressed. Only a record lock is placed.

```
-- Gap lock eliminated (unique index + equality + record found):
SELECT * FROM t WHERE pk = 5 FOR UPDATE;   → record lock only

-- Gap lock NOT eliminated (unique index + equality + record NOT found):
SELECT * FROM t WHERE pk = 7 FOR UPDATE;   → gap lock on (5, 10)
  (because if the record doesn't exist, InnoDB must prevent it from
   being inserted by another transaction to maintain serializability)
```

This optimization means PK-based OLTP workloads under RR have nearly the same
locking footprint as under RC.

### 8.2 Semi-Consistent Read (READ COMMITTED)

Under RC, InnoDB performs a "semi-consistent read" for UPDATE statements:

```
UPDATE t SET col = 'x' WHERE unindexed = 5;

Under REPEATABLE READ:
  1. Full index scan
  2. Next-key lock on EVERY record
  3. Evaluate WHERE clause
  4. Update matching rows
  5. Keep ALL locks until commit

Under READ COMMITTED:
  1. Full index scan
  2. Lock each record
  3. Evaluate WHERE clause
  4. If row does NOT match → RELEASE the lock immediately
  5. Keep locks only on matching rows until commit
```

This is a massive reduction in lock contention for wide scans with selective predicates.

Source: `row/row0sel.cc` — `row_search_mvcc()` with `prebuilt->select_lock_type` and
the `did_semi_consistent_read` flag.

### 8.3 SKIP LOCKED and NOWAIT (MySQL 8.0+)

```sql
-- NOWAIT: fail immediately if lock cannot be acquired
SELECT * FROM jobs WHERE status = 'pending' LIMIT 1 FOR UPDATE NOWAIT;
-- If the row is locked → ERROR 3572 immediately (no waiting)

-- SKIP LOCKED: skip rows that are locked by other transactions
SELECT * FROM jobs WHERE status = 'pending' LIMIT 1 FOR UPDATE SKIP LOCKED;
-- If first 'pending' row is locked → skip it, try next → returns unlocked row
```

These are designed for **queue-table patterns** common in Java applications:

```java
// Worker thread: claim a job from the queue
@Transactional
public Job claimJob() {
    // SKIP LOCKED lets multiple workers claim different jobs concurrently
    // without blocking each other
    Job job = em.createNativeQuery(
        "SELECT * FROM jobs WHERE status = 'pending' " +
        "ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
        Job.class
    ).getSingleResult();

    job.setStatus("processing");
    job.setWorker(Thread.currentThread().getName());
    return job;
}
```

`>>> "SKIP LOCKED transforms a contention-heavy queue table into a concurrent-friendly
pattern. Without it, all workers block on the same first pending row. With it, each
worker grabs a different row. This eliminates the need for external queue systems
(Redis, RabbitMQ) for simple job queues if your throughput requirements are moderate
(< 10K jobs/sec)."`

### 8.4 Index Design Directly Affects Lock Coverage

```
Table: orders (id PK, customer_id INT, status VARCHAR, INDEX idx_cust(customer_id))

-- With index on customer_id:
SELECT * FROM orders WHERE customer_id = 42 FOR UPDATE;
→ next-key locks on idx_cust entries for customer_id=42
→ record locks on matching clustered index entries
→ other customers' rows NOT locked

-- Without index on customer_id (drop idx_cust):
SELECT * FROM orders WHERE customer_id = 42 FOR UPDATE;
→ full clustered index scan
→ next-key locks on EVERY row in the table
→ ALL customers blocked

The lock coverage difference between these two scenarios can be the
difference between a system that handles 10,000 TPS and one that
handles 50 TPS.
```

### 8.5 Transaction Size

Locks are held until transaction commit (or rollback). Smaller transactions hold locks
for less time, reducing the window for contention.

```
BAD: Large transaction
  BEGIN;
  UPDATE orders SET status='processed' WHERE batch_id = 42;  -- 10,000 rows locked
  -- external HTTP call (500ms)
  -- another UPDATE
  COMMIT;  -- locks held for entire duration including HTTP call

GOOD: Minimal transaction scope
  // Process in Java, outside transaction
  List<Long> ids = fetchBatchIds(42);

  for (List<Long> chunk : partition(ids, 100)) {
      @Transactional  // new transaction per chunk
      void processChunk(List<Long> chunk) {
          update(chunk);
      }
  }
```

---

## 9. Auto-Increment Locks

### 9.1 The Problem

When multiple transactions INSERT concurrently, each needs a unique auto-increment
value. The question is: how much serialization is necessary to ensure uniqueness and
ordering?

### 9.2 Three Modes: `innodb_autoinc_lock_mode`

```
+------+--------------+----------------------------------------------------+
| Mode | Name         | Behavior                                           |
+------+--------------+----------------------------------------------------+
|  0   | traditional  | Table-level AUTO-INC lock held for ENTIRE INSERT   |
|      |              | statement. Released after statement, not after      |
|      |              | each row. Safe for all replication formats.         |
|      |              | Worst concurrency.                                 |
+------+--------------+----------------------------------------------------+
|  1   | consecutive  | "Simple inserts" (known row count): lightweight     |
|      | (pre-8.0     | mutex, allocate IDs in batch, no table lock.        |
|      |  default)    | "Bulk inserts" (unknown row count): table-level     |
|      |              | AUTO-INC lock. Guarantees consecutive IDs per       |
|      |              | statement. Safe for statement-based replication.    |
+------+--------------+----------------------------------------------------+
|  2   | interleaved  | Never acquires table-level AUTO-INC lock. All       |
|      | (8.0+        | inserts use lightweight mutex. Concurrent inserts   |
|      |  default)    | get interleaved IDs (not consecutive per statement).|
|      |              | Best concurrency. REQUIRES row-based replication.   |
+------+--------------+----------------------------------------------------+
```

### 9.3 Simple vs Bulk Inserts

```
Simple insert (row count known at parse time):
  INSERT INTO t VALUES (NULL, 'a'), (NULL, 'b'), (NULL, 'c');
  → 3 rows → allocate IDs 100, 101, 102 atomically via mutex

Bulk insert (row count unknown):
  INSERT INTO t SELECT ... FROM other_table;
  → unknown number of rows
  → mode 1: holds table-level AUTO-INC lock for duration
  → mode 2: allocates IDs incrementally via mutex, no table lock

Mixed insert (some rows specify ID, some don't):
  INSERT INTO t (id, name) VALUES (NULL, 'a'), (50, 'b'), (NULL, 'c');
  → treated like bulk insert under mode 1
```

### 9.4 Why Mode 2 Is Safe in MySQL 8.0

MySQL 8.0 changed the default `binlog_format` to `ROW`. With row-based replication,
the exact auto-increment values assigned on the primary are replicated directly in the
binlog events. The replica applies the same values, so interleaved ordering does not
matter.

Under STATEMENT-based replication with mode 2, the replica re-executes the INSERT
statements. If two concurrent INSERTs interleave their IDs, the replica (executing
sequentially) would assign different IDs, causing primary-replica divergence.

```
Primary (mode=2, concurrent inserts):
  T1: INSERT → gets IDs 1, 3, 5
  T2: INSERT → gets IDs 2, 4, 6

Replica with STATEMENT replication (sequential replay):
  T1: INSERT → gets IDs 1, 2, 3       ← WRONG! Different from primary
  T2: INSERT → gets IDs 4, 5, 6       ← WRONG!

Replica with ROW replication:
  Applies exact row images with IDs 1,3,5 and 2,4,6 → CORRECT
```

`>>> "If you see AUTO-INC lock contention in production (visible as lock_mode=AUTO-INC
in performance_schema.data_locks), verify innodb_autoinc_lock_mode. Pre-8.0 defaults to
mode 1, which holds table locks for bulk inserts. Upgrading to mode 2 eliminates this
bottleneck but requires ROW binlog format."`

---

## 10. Deadlock Detection and Resolution

### 10.1 Wait-For Graph

InnoDB maintains a directed graph where:
- Each node is a transaction.
- An edge from T1 to T2 means "T1 is waiting for a lock held by T2."

A **cycle** in this graph means deadlock.

```
Normal wait (no deadlock):

  T1 ──waits──→ T2 ──waits──→ T3 (T3 is running, no cycle)

Deadlock (cycle detected):

  T1 ──waits──→ T2
  ^               |
  |               v
  +───waits───── T3

  T1 waits for T2, T2 waits for T3, T3 waits for T1 → CYCLE → DEADLOCK
```

### 10.2 Detection Mechanism

InnoDB checks for deadlocks **on every lock wait**, not periodically. When a transaction
T enters a lock wait, InnoDB immediately performs a depth-first search of the wait-for
graph starting from T to determine if granting the requested lock would create a cycle.

Source: `lock/lock0lock.cc` — `DeadlockChecker::check_and_resolve()`

```
lock_wait_suspend_thread()              // transaction blocks
  → DeadlockChecker::check_and_resolve()
    → search_too_deep() check          // limit DFS depth to avoid O(N^2)
    → DFS from current txn
    → if cycle found:
      → select_victim()
      → victim->lock.was_chosen_as_deadlock_victim = true
      → roll back victim
```

### 10.3 Victim Selection

The victim is the transaction with the smallest **weight**. Weight is defined as:

```
weight = number of undo log records (rows modified)
       + number of locks held

The transaction that has done the least work is rolled back, because:
  1. Less work to redo
  2. Less undo log to process for rollback
  3. Fewer locks to release
```

The victim transaction receives MySQL error 1213:

```
ERROR 1213 (40001): Deadlock found when trying to get lock;
try restarting transaction
```

The application **must** catch this error and retry the entire transaction. InnoDB does
not retry automatically.

### 10.4 Disabling Deadlock Detection

For systems with extremely high concurrency (hundreds of concurrent threads), the
deadlock detection DFS itself becomes a bottleneck -- every lock wait triggers a graph
traversal that must acquire the lock system mutex.

```sql
-- Disable deadlock detection (MySQL 8.0.18+):
SET GLOBAL innodb_deadlock_detect = OFF;

-- Rely on lock wait timeout instead:
SET GLOBAL innodb_lock_wait_timeout = 5;  -- seconds

-- Transaction that waits > 5 seconds gets:
-- ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction
```

The tradeoff: with detection disabled, deadlocked transactions wait the full timeout
period instead of being detected and resolved instantly. Use this only when deadlock
detection overhead exceeds the cost of occasional timeout-based resolution.

### 10.5 Deadlock Example: Classic Cross-Order

```sql
-- T1:                                    -- T2:
BEGIN;                                    BEGIN;
UPDATE t SET c=1 WHERE id=1;              UPDATE t SET c=2 WHERE id=2;
-- T1 holds X lock on id=1                -- T2 holds X lock on id=2

UPDATE t SET c=1 WHERE id=2;              UPDATE t SET c=2 WHERE id=1;
-- T1 waits for X lock on id=2            -- T2 waits for X lock on id=1
-- (held by T2)                           -- (held by T1)

-- DEADLOCK DETECTED
-- T1 or T2 (whichever has less weight) is rolled back
```

Wait-for graph at the moment of deadlock:

```
  +------+          +------+
  |  T1  |---wait-->|  T2  |
  |      |<--wait---|      |
  +------+          +------+
       waits for id=2    waits for id=1

  Cycle: T1 → T2 → T1
  Detected by DFS when second UPDATE enters lock wait.
```

### 10.6 Deadlock Example: Gap Lock + INSERT

```sql
-- Table t: id PK, records [1, 5, 10]

-- T1:                                    -- T2:
BEGIN;                                    BEGIN;
SELECT * FROM t WHERE id = 3              SELECT * FROM t WHERE id = 7
  FOR UPDATE;                               FOR UPDATE;
-- id=3 doesn't exist                    -- id=7 doesn't exist
-- gap lock on (1, 5)                    -- gap lock on (5, 10)

INSERT INTO t VALUES (7, 'x');            INSERT INTO t VALUES (3, 'y');
-- needs insert intention on (5,10)      -- needs insert intention on (1,5)
-- CONFLICTS with T2's gap lock          -- CONFLICTS with T1's gap lock
-- T1 WAITS                             -- T2 WAITS → DEADLOCK
```

```
  +------+                    +------+
  |  T1  |                    |  T2  |
  | holds: gap(1,5)           | holds: gap(5,10)
  | wants: ins.int.(5,10)---->| wants: ins.int.(1,5)
  |      |<-------------------+      |
  +------+                    +------+

  Cycle: T1 → T2 → T1
```

This pattern is extremely common in applications that do "check-then-insert":

```java
// DANGEROUS: gap lock + insert deadlock pattern
@Transactional
public void upsertUser(int userId, String name) {
    User existing = em.createQuery(
        "SELECT u FROM User u WHERE u.externalId = :eid FOR UPDATE")
        .setParameter("eid", userId)
        .getResultStream().findFirst().orElse(null);

    if (existing == null) {
        // INSERT here conflicts with another thread's gap lock
        em.persist(new User(userId, name));
    } else {
        existing.setName(name);
    }
}
```

Fix: use `INSERT ... ON DUPLICATE KEY UPDATE` or `REPLACE INTO` to avoid the
gap lock from the SELECT.

`>>> "Two deadlock patterns cover 90% of production deadlocks: (1) cross-order row
locking -- fix by always acquiring locks in PK order, (2) gap lock + INSERT --
fix by using INSERT ON DUPLICATE KEY UPDATE or reducing isolation to RC. Every
Java developer should know both patterns and their fixes."`

---

## 11. CATS — Contention-Aware Transaction Scheduling (MySQL 8.0.20+)

### 11.1 The Problem: FIFO Priority Inversion

Before CATS, InnoDB granted locks in FIFO order. This can cause priority inversion:

```
Without CATS (FIFO):

  T1 holds lock on row A
  T2 waits for row A          (T2 blocks 50 other transactions)
  T3 waits for row A          (T3 blocks 0 other transactions)

  T1 releases → T2 granted first (FIFO) → 50 txns still blocked
  Better: grant T3 first (unblocks T3 instantly), then grant T2

Wait graph showing priority inversion:

  T4,T5,T6...T53 ──wait──→ T2 ──wait──→ T1 (holds lock)
                            T3 ──wait──→ T1
                            ^
               T3 blocks nobody, but waits behind T2
               which blocks 50 transactions
```

### 11.2 CATS Algorithm

CATS assigns a dynamic **scheduling weight** to each waiting transaction:

```
scheduling_weight(T) = number of transactions transitively blocked by T

T2 blocks 50 transactions → weight = 50
T3 blocks 0 transactions  → weight = 0

CATS grants to T2 first (higher weight), because granting T2's lock
will unblock the most total transactions.
```

Wait -- that seems like CATS would still grant to T2 first. The key insight is more
nuanced: CATS computes the weight as the transitive closure. If granting T3 would
transitively unblock more total transactions (because T3's results are needed by
other high-weight transactions), CATS prefers T3.

In practice, CATS reduces average lock wait time by 30-60% under high contention
workloads. It is completely transparent -- no configuration, no tuning knobs.

Source: `lock/lock0lock.cc` — `lock_grant_cats()`

### 11.3 When CATS Matters

CATS has minimal effect on low-contention workloads (where FIFO and CATS produce
identical schedules). It shines when:

- Many transactions contend on the same rows (hot rows)
- Lock chains are deep (transitive blocking)
- Mixed workloads with different lock footprints

`>>> "CATS is a free performance improvement in MySQL 8.0.20+. If someone asks
'What changed in InnoDB locking in recent versions?', CATS is the answer.
No configuration needed, transparent, reduces lock wait times under contention."`

---

## 12. Lock Monitoring and Debugging

### 12.1 performance_schema.data_locks (MySQL 8.0+)

This view replaces the deprecated `INFORMATION_SCHEMA.INNODB_LOCKS`.

```sql
SELECT
    ENGINE_LOCK_ID,
    ENGINE_TRANSACTION_ID,
    THREAD_ID,
    OBJECT_SCHEMA,
    OBJECT_NAME,
    INDEX_NAME,
    LOCK_TYPE,       -- 'RECORD' or 'TABLE'
    LOCK_MODE,       -- 'S', 'X', 'IS', 'IX', 'S,GAP', 'X,GAP',
                     -- 'S,REC_NOT_GAP', 'X,REC_NOT_GAP',
                     -- 'X,INSERT_INTENTION'
    LOCK_STATUS,     -- 'GRANTED' or 'WAITING'
    LOCK_DATA        -- the locked key value(s)
FROM performance_schema.data_locks
WHERE OBJECT_SCHEMA = 'mydb'
ORDER BY ENGINE_TRANSACTION_ID, LOCK_TYPE;
```

Key `LOCK_MODE` values decoded:

```
+------------------------+-------------------------------------------+
| LOCK_MODE              | Meaning                                   |
+------------------------+-------------------------------------------+
| S                      | Next-key lock (shared): record + gap      |
| X                      | Next-key lock (exclusive): record + gap   |
| S,REC_NOT_GAP          | Record lock only (shared), no gap          |
| X,REC_NOT_GAP          | Record lock only (exclusive), no gap       |
| S,GAP                  | Gap lock only (shared)                     |
| X,GAP                  | Gap lock only (exclusive)                  |
| X,INSERT_INTENTION     | Insert intention lock                      |
| AUTO_INC               | Auto-increment table lock                  |
+------------------------+-------------------------------------------+
```

### 12.2 performance_schema.data_lock_waits

```sql
SELECT
    REQUESTING_ENGINE_LOCK_ID,
    REQUESTING_ENGINE_TRANSACTION_ID,
    REQUESTING_THREAD_ID,
    BLOCKING_ENGINE_LOCK_ID,
    BLOCKING_ENGINE_TRANSACTION_ID,
    BLOCKING_THREAD_ID
FROM performance_schema.data_lock_waits;
```

Join with `data_locks` for full picture:

```sql
SELECT
    r.ENGINE_TRANSACTION_ID  AS waiting_txn,
    r.LOCK_MODE              AS waiting_lock_mode,
    r.LOCK_DATA              AS waiting_lock_data,
    b.ENGINE_TRANSACTION_ID  AS blocking_txn,
    b.LOCK_MODE              AS blocking_lock_mode,
    b.LOCK_DATA              AS blocking_lock_data
FROM performance_schema.data_lock_waits w
JOIN performance_schema.data_locks r
  ON r.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
JOIN performance_schema.data_locks b
  ON b.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID;
```

### 12.3 SHOW ENGINE INNODB STATUS

The "TRANSACTIONS" section shows active transactions and their lock state. The
"LATEST DETECTED DEADLOCK" section shows the most recent deadlock with full details.

```sql
SHOW ENGINE INNODB STATUS\G

-- Key sections to examine:
-- TRANSACTIONS:
--   Shows each active transaction's state, locks held, undo log entries
-- LATEST DETECTED DEADLOCK:
--   Shows both transactions, their held locks, their requested locks,
--   and which transaction was chosen as the victim
```

### 12.4 Configuration Parameters

```
+----------------------------------+---------+------------------------------------------+
| Parameter                        | Default | Purpose                                  |
+----------------------------------+---------+------------------------------------------+
| innodb_lock_wait_timeout         | 50 sec  | Max seconds to wait for a row lock.      |
|                                  |         | Exceeding → ERROR 1205, statement        |
|                                  |         | rolled back (not full transaction).       |
+----------------------------------+---------+------------------------------------------+
| innodb_deadlock_detect           | ON      | Enable deadlock detection. Disable for    |
|                                  |         | extreme concurrency (use timeout instead).|
+----------------------------------+---------+------------------------------------------+
| innodb_print_all_deadlocks       | OFF     | Log ALL deadlocks to error log (not      |
|                                  |         | just the latest). Enable in production.  |
+----------------------------------+---------+------------------------------------------+
| innodb_status_output_locks       | OFF     | Include lock details in SHOW ENGINE      |
|                                  |         | INNODB STATUS. Enable for debugging.     |
+----------------------------------+---------+------------------------------------------+
```

Important detail: `innodb_lock_wait_timeout` rolls back only the **waiting statement**,
not the entire transaction. The transaction remains open with partial work committed.
This means your application must either:
1. Catch error 1205 and explicitly `ROLLBACK` the entire transaction, or
2. Handle the partial state.

Most Java connection pools and Spring `@Transactional` will roll back the full
transaction on any exception, which is the correct behavior.

### 12.5 Common Deadlock Patterns in Java Applications

**Pattern 1: Different Lock Ordering**

```java
// Thread 1:                          // Thread 2:
UPDATE accounts SET bal=bal-100       UPDATE accounts SET bal=bal+50
  WHERE id=1;                           WHERE id=2;
UPDATE accounts SET bal=bal+100       UPDATE accounts SET bal=bal-50
  WHERE id=2;                           WHERE id=1;
// T1 holds X(id=1), waits X(id=2)   // T2 holds X(id=2), waits X(id=1)
// DEADLOCK

// FIX: Always lock in PK order
public void transfer(int from, int to, int amount) {
    int first = Math.min(from, to);
    int second = Math.max(from, to);

    // Always lock lower PK first
    Account a1 = lockForUpdate(first);
    Account a2 = lockForUpdate(second);

    if (from == first) {
        a1.debit(amount);
        a2.credit(amount);
    } else {
        a2.debit(amount);
        a1.credit(amount);
    }
}
```

**Pattern 2: SELECT FOR UPDATE Followed by INSERT**

```java
// DEADLOCK-PRONE:
@Transactional
public void createIfNotExists(String email) {
    User u = em.createQuery("SELECT u FROM User u WHERE email = :e",
                            User.class)
        .setParameter("e", email)
        .setLockMode(LockModeType.PESSIMISTIC_WRITE)  // FOR UPDATE
        .getResultStream().findFirst().orElse(null);

    if (u == null) {
        em.persist(new User(email));  // INSERT → insert intention vs gap lock
    }
}

// FIX: Use INSERT ... ON DUPLICATE KEY UPDATE
@Transactional
public void createIfNotExists(String email) {
    em.createNativeQuery(
        "INSERT INTO users (email) VALUES (:e) " +
        "ON DUPLICATE KEY UPDATE email = email")
        .setParameter("e", email)
        .executeUpdate();
}
```

**Pattern 3: Gap Lock Deadlocks — Reduce Isolation**

```java
// If phantom reads are acceptable for your use case:
@Transactional(isolation = Isolation.READ_COMMITTED)
public void processOrders(String status) {
    // Under RC, no gap locks → no gap-lock deadlocks
    List<Order> orders = orderRepo.findByStatusForUpdate(status);
    orders.forEach(this::process);
}
```

`>>> "In production debugging, enable innodb_print_all_deadlocks = ON permanently.
The SHOW ENGINE INNODB STATUS deadlock section only stores the most recent deadlock
and is overwritten by the next one. With print_all_deadlocks, every deadlock is
captured in the error log with timestamps, making it possible to correlate with
application logs and identify patterns over time."`

---

## 13. Predicate Locks (Spatial Indexes)

Predicate locks are a specialized lock type used only with spatial indexes (R-Tree).
They lock a minimum bounding rectangle (MBR) rather than a key range.

```
Standard B+Tree index: uses next-key locks (key ranges)
Spatial R-Tree index:  uses predicate locks (MBR regions)

Example:
  SELECT * FROM locations
  WHERE MBRContains(
    ST_GeomFromText('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))'),
    geom
  ) FOR UPDATE;

  → predicate lock on the MBR (0,0)-(10,10)
  → prevents INSERT of any point within this rectangle
```

Predicate locks are less commonly encountered in typical OLTP workloads but are
important to know for applications with geospatial queries. The locking principle
is the same: prevent phantom reads by blocking insertions that would match the
query predicate.

---

## 14. Lock Internals: Data Structures and Memory

### 14.1 The lock_t Structure

Each lock in InnoDB is represented by a `lock_t` structure:

```
struct lock_t {
    trx_t*        trx;           // owning transaction
    UT_LIST_NODE  trx_locks;     // list of all locks held by this txn
    lock_mode     mode;          // LOCK_S, LOCK_X, LOCK_IS, etc.
    hash_node_t   hash;          // hash chain for lock_sys hash table

    union {
        lock_table_t  tab_lock;  // for table locks
        lock_rec_t    rec_lock;  // for record locks
    };
};

struct lock_rec_t {
    space_id_t  space;           // tablespace ID
    page_no_t   page_no;         // page number
    uint32_t    n_bits;          // number of bits in bitmap
    byte        bits[];          // bitmap: one bit per record on the page
};
```

The bitmap approach is critical for efficiency: rather than allocating a separate
structure for each locked record, InnoDB uses one bit per heap_no (record slot) on
the page. A 16 KB page with 100 records needs only 13 bytes for the bitmap.

### 14.2 Lock System Hash Table

All record locks are stored in a global hash table, indexed by `(space_id, page_no)`:

```
lock_sys->rec_hash:

  bucket[hash(space=5, page=100)] → lock_t → lock_t → lock_t → NULL
  bucket[hash(space=5, page=101)] → lock_t → NULL
  bucket[hash(space=5, page=102)] → (empty)

When checking for conflicting locks on a record:
  1. Hash (space_id, page_no) → find the bucket
  2. Walk the chain of lock_t structures
  3. For each lock_t, check if the bitmap bit for the target heap_no is set
  4. If set, check mode compatibility
```

In MySQL 8.0, the lock system hash table is sharded into multiple partitions
(`lock_sys->rec_hash` is split into `n_shards` partitions) to reduce mutex contention
under high concurrency.

Source: `lock/lock0lock.cc`, `include/lock0priv.h`

---

## 15. Putting It All Together: A Complete Locking Trace

Let's trace the complete locking sequence for a realistic query under RR isolation:

```sql
-- Schema:
CREATE TABLE orders (
    id        INT PRIMARY KEY,
    cust_id   INT NOT NULL,
    amount    DECIMAL(10,2),
    status    VARCHAR(20),
    INDEX idx_cust (cust_id),
    INDEX idx_status (status)
);

-- Data:
-- id=1, cust_id=10, amount=100, status='shipped'
-- id=2, cust_id=20, amount=200, status='pending'
-- id=3, cust_id=10, amount=300, status='pending'
-- id=4, cust_id=30, amount=150, status='shipped'
-- id=5, cust_id=10, amount=250, status='pending'

-- Query:
BEGIN;
SELECT * FROM orders WHERE cust_id = 10 FOR UPDATE;
```

Step-by-step lock acquisition:

```
Step 1: Table-level intention lock
  → IX lock on table `orders`

Step 2: Secondary index scan on idx_cust
  The index idx_cust contains entries (sorted by cust_id):
    (cust_id=10, pk=1), (cust_id=10, pk=3), (cust_id=10, pk=5),
    (cust_id=20, pk=2), (cust_id=30, pk=4)

  InnoDB scans idx_cust for cust_id=10:

  Lock 1: Next-key lock on (cust_id=10, pk=1)
          → locks gap (min, 10|1] on secondary index

  Lock 2: Next-key lock on (cust_id=10, pk=3)
          → locks gap (10|1, 10|3]

  Lock 3: Next-key lock on (cust_id=10, pk=5)
          → locks gap (10|3, 10|5]

  Lock 4: Gap lock on (cust_id=20, pk=2)
          → locks gap (10|5, 20|2) — "one past the last match"
          → prevents INSERT of new cust_id=10 records

Step 3: Clustered index lookups (for each matching row)
  Lock 5: X record lock (REC_NOT_GAP) on clustered pk=1
  Lock 6: X record lock (REC_NOT_GAP) on clustered pk=3
  Lock 7: X record lock (REC_NOT_GAP) on clustered pk=5

Total locks: 1 table lock + 3 next-key locks on secondary index
           + 1 gap lock on secondary index + 3 record locks on
             clustered index = 8 locks

What's blocked:
  - INSERT of any row with cust_id=10 (gap lock blocks it)
  - UPDATE/DELETE of rows pk=1, pk=3, pk=5 (record locks)
  - INSERT of rows with cust_id between 10 and 20 on the secondary
    index (gap lock on cust_id=20 blocks it)
```

This trace shows why the statement "locks rows you didn't ask for" is accurate: the
gap lock on `cust_id=20` partially affects a row the query never intended to touch.
An INSERT of `cust_id=15` would be blocked, even though the query only asked for
`cust_id=10`.

`>>> "In an interview, if asked 'what exactly happens when InnoDB processes a
SELECT FOR UPDATE on a non-unique index', walk through this sequence: (1) IX on
table, (2) next-key locks on all matching secondary index entries, (3) gap lock on
the entry just past the last match, (4) record locks on corresponding clustered index
entries. The gap lock on the 'next' entry is the part that locks rows you didn't ask
for."`

---

## 16. Summary: Decision Tree for Lock Analysis

When analyzing what locks a statement acquires, follow this tree:

```
                          What isolation level?
                         /                    \
                       RR                      RC
                      /                          \
               Next-key locks               Record locks only
               (record + gap)               (gap locks released
                                             for non-matching rows)
                      |
                What index is used?
               /         |          \
          Unique      Non-unique    No index
          index       index         (full scan)
            |            |              |
        Equality?     Equality?     Next-key on
       /        \        |          ALL records
      Yes       No    Next-key on   (= table lock)
      |          |    sec index +
   Record     Next-key  rec on
   lock only  locks     clustered
   (no gap)
```

```
Lock contention reduction checklist:
  1. Use unique index equality (eliminates gap locks)
  2. Add indexes on WHERE clause columns (prevents full scan)
  3. Consider READ COMMITTED if phantoms acceptable
  4. Use SKIP LOCKED / NOWAIT for queue patterns
  5. Keep transactions short (fewer locks held for less time)
  6. Lock rows in consistent order (prevents cross-order deadlocks)
  7. Prefer INSERT ON DUPLICATE KEY UPDATE over SELECT-then-INSERT
  8. Enable innodb_print_all_deadlocks = ON for debugging
  9. Monitor performance_schema.data_locks and data_lock_waits
```

---

*Next: [Chapter 11 — Thread Architecture and I/O Subsystem](11-thread-architecture-and-io.md)*
