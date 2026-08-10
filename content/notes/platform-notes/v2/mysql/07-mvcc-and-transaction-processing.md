# Chapter 7: MVCC and Transaction Processing

## How Concurrent Readers and Writers Avoid Blocking Each Other

> *"The fundamental insight of MVCC is that readers should never block writers and
> writers should never block readers. InnoDB keeps old row versions alive in the undo
> log so a reader can always find a version it is allowed to see, without waiting for
> any lock. The entire mechanism pivots on one small structure: the ReadView."*

---

## 7.1 Transaction Fundamentals in InnoDB

### 7.1.1 ACID — How InnoDB Implements Each Guarantee

```
+------------------------------------------------------------------+
|                        ACID in InnoDB                             |
+------------------------------------------------------------------+
|  Atomicity ──────── Undo Log                                     |
|    INSERT → undo stores PK (for delete-on-rollback)              |
|    UPDATE → undo stores old column values                        |
|    DELETE → undo stores entire old row (mark-delete; purge later)|
|    ROLLBACK = walk undo chain in reverse, apply inverse ops      |
|                                                                  |
|  Consistency ────── Constraints + Crash Recovery                  |
|    FK, NOT NULL, CHECK enforced at DML time. After crash, redo   |
|    replay + undo rollback of uncommitted txns → consistent state |
|                                                                  |
|  Isolation ──────── MVCC + Locking                                |
|    Readers: ReadView (snapshot). Writers: row-level locks.        |
|                                                                  |
|  Durability ─────── Redo Log + Doublewrite Buffer                 |
|    WAL discipline: redo must hit disk before dirty data pages.   |
|    Doublewrite prevents torn 16 KB pages on 4 KB-sector disks.   |
+------------------------------------------------------------------+
```

`innodb_flush_log_at_trx_commit` controls redo fsync aggressiveness:
- `= 1` (default): fsync on every commit. Full ACID durability.
- `= 2`: write to OS buffer per commit, fsync once/sec. Survives MySQL crash, not OS crash.
- `= 0`: write+fsync once/sec. Up to 1 second of committed data can be lost.

>>> **Interview insight**: "How does InnoDB guarantee durability?" Not just "redo log."
>>> It is the WAL protocol (redo hits disk before dirty pages) combined with the
>>> doublewrite buffer (prevents torn 16 KB pages on ext4/XFS with 4 KB atomic write
>>> granularity). These two mechanisms together make crash recovery possible.

### 7.1.2 Transaction Lifecycle

```
  Application                       InnoDB Engine
  ───────────                       ─────────────
  BEGIN (or autocommit)
       ├───► Allocate trx_t (state = ACTIVE)
       │     No trx_id yet (read-only optimization)
  INSERT/UPDATE/DELETE
       ├───► First write → assign trx_id from trx_sys->max_trx_id
       │     Acquire row locks, write undo record, write redo record
  SELECT (consistent read)
       ├───► Create ReadView (if first consistent read under RR)
       │     Walk version chain via DB_ROLL_PTR. No locks acquired.
  COMMIT
       ├───► Flush redo log to disk (WAL), release all locks
       │     Mark undo for purge. state → COMMITTED_IN_MEMORY
  ROLLBACK
       └───► Walk undo chain in reverse, apply inverse operations
             Release all locks. state → NOT_STARTED
```

**Autocommit** (default ON): every standalone statement is an implicit `BEGIN → stmt → COMMIT`.
This means 1000 individual INSERTs = 1000 fsyncs. Wrapping in a single `BEGIN...COMMIT` = 1 fsync.

### 7.1.3 The `trx_t` Structure

Defined in `storage/innobase/include/trx0trx.h`:

```
struct trx_t {
    trx_id_t    id;            // 0 until first write (read-only optimization)
    trx_state_t state;         // NOT_STARTED, ACTIVE, PREPARED, COMMITTED_IN_MEMORY
    ReadView*   read_view;     // NULL until first consistent read
    trx_undo_t* insert_undo;  // Undo log for INSERTs
    trx_undo_t* update_undo;  // Undo log for UPDATE/DELETE
    lock_list   trx_locks;    // All locks held by this transaction
    undo_no_t   undo_no;      // Number of undo records written
    bool        read_only;    // True if no writes yet
    bool        auto_commit;  // True if single-statement autocommit txn
};
```

**Source**: `storage/innobase/trx/trx0trx.cc` — `trx_start_low()`, `trx_commit()`, `trx_rollback_active()`.

---

## 7.2 Transaction ID Assignment

### 7.2.1 The Global Counter

InnoDB maintains `trx_sys->max_trx_id`, a monotonically increasing counter. A transaction
gets an ID only at its first write (INSERT/UPDATE/DELETE), not at BEGIN.

```
T1: BEGIN → SELECT → INSERT (first write)
                        └─► T1.id = atomic_fetch_add(trx_sys->max_trx_id)

T2: BEGIN → UPDATE (first write)
               └─► T2.id = atomic_fetch_add(trx_sys->max_trx_id)
```

The counter is persisted to the TRX_SYS page every 256 increments (`TRX_SYS_TRX_ID_WRITE_MARGIN`).
On recovery, InnoDB may skip up to 256 IDs — harmless gaps.

### 7.2.2 Read-Only Transaction Optimization (5.6+)

Before 5.6, every transaction got a trx_id at BEGIN time → severe contention on `trx_sys->mutex`
under high concurrency. The optimization:

```
  Transaction starts
       │
       ├─── No writes yet?
       │    • No trx_id assigned
       │    • Not in rw_trx_ids list
       │    • trx_sys mutex NOT acquired
       │    • Lightweight ReadView creation
       │
       └─── First write?
            • Assign trx_id, add to rw_trx_ids
            • Acquire trx_sys mutex
```

**Explicit declaration**: `START TRANSACTION READ ONLY` — InnoDB skips undo log segment
pre-allocation entirely. Auto-detection also works: just `BEGIN` + only SELECTs.

>>> **Interview insight**: "How does MySQL handle 10K concurrent read-only connections
>>> without mutex contention?" Read-only transactions skip the trx_sys mutex entirely.
>>> They never get a transaction ID, never appear in rw_trx_ids, and their ReadView
>>> creation uses a lighter code path. This optimization (5.6+) is critical for
>>> high-concurrency OLTP with many read-only requests.

---

## 7.3 MVCC — The Version Chain

### 7.3.1 Hidden System Columns

Every InnoDB row carries three hidden columns:

| Column | Size | Purpose |
|--------|------|---------|
| `DB_TRX_ID` | 6 bytes | Transaction ID of last INSERT/UPDATE |
| `DB_ROLL_PTR` | 7 bytes | Pointer to previous version in undo log |
| `DB_ROW_ID` | 6 bytes | Auto-generated row ID (only if no explicit PK) |

### 7.3.2 How the Version Chain Forms

When a row is updated, InnoDB does NOT discard the old value. It:
1. Copies old column values into an **undo log record**.
2. Updates the row in the B+Tree leaf page with new values.
3. Sets `DB_TRX_ID` to the current transaction's ID.
4. Sets `DB_ROLL_PTR` to point to the undo record from step 1.

Each undo record itself has a `DB_ROLL_PTR` to an even older version:

```
   B+Tree Leaf Page                    Undo Tablespace
  ┌──────────────────┐
  │ Row (current)    │
  │ DB_TRX_ID = 1005 │
  │ DB_ROLL_PTR ──────────┐
  │ balance = 300    │    │
  └──────────────────┘    │
                          ▼
             ┌─────────────────────┐
             │ Undo Record (v2)    │
             │ trx_id = 1003      │
             │ DB_ROLL_PTR ────────────┐
             │ balance = 200      │    │
             └─────────────────────┘    │
                                        ▼
                           ┌─────────────────────┐
                           │ Undo Record (v1)    │
                           │ trx_id = 1001      │
                           │ DB_ROLL_PTR = NULL  │
                           │ balance = 100      │
                           └─────────────────────┘

   Timeline: v1 (trx 1001) → v2 (trx 1003) → v3 (trx 1005, current)
```

InnoDB walks this chain backward from the current row until it finds a version
visible to the reader's ReadView, or exhausts the chain (row did not exist yet).

### 7.3.3 The Cost of Long Version Chains

A long-running transaction holds an old ReadView → purge thread cannot clean undo records
that might still be needed → version chains grow:

```
  Long-running txn (ReadView from trx_id 900)
  + 10,000 concurrent updates to same rows
  = version chains 10,000 records deep
  = every new reader walks 10,000 undo records for a simple PK lookup

  Symptoms: CPU spikes, undo tablespace growth, buffer pool pollution,
            query latency explosion
```

Monitor with `SHOW ENGINE INNODB STATUS` → `History list length`. Healthy: < few thousand.
Growing to millions = find and kill the long-running transaction:

```sql
SELECT trx_id, trx_started, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_sec
FROM information_schema.innodb_trx ORDER BY trx_started LIMIT 5;
```

>>> **Interview insight**: "What happens if a developer opens a transaction and goes to
>>> lunch?" Cascading disaster: old ReadView blocks purge → undo grows → version chains
>>> lengthen → every query slows down. In Spring/JDBC, ensure `@Transactional` methods
>>> are short-lived and never call external APIs within a transaction boundary.

---

## 7.4 ReadView — The Visibility Snapshot

### 7.4.1 Structure

Defined in `storage/innobase/include/read0types.h`:

```
struct ReadView {
    trx_id_t  m_creator_trx_id;  // Transaction that created this ReadView
    ids_t     m_ids;             // Sorted active R/W transaction IDs at creation time
    trx_id_t  m_up_limit_id;    // min(m_ids) — oldest active txn (low water mark)
    trx_id_t  m_low_limit_id;   // trx_sys->max_trx_id at creation — next to be
                                 //   assigned (high water mark)
};
```

**Naming confusion warning**: InnoDB's names are counterintuitive. `m_low_limit_id` is the
HIGH boundary; `m_up_limit_id` is the LOW boundary:

```
  Transaction ID number line:
  0 ──────────────────────────────────────────────────► ∞
       committed         active window         future
       (visible)         (check m_ids)         (invisible)
              │                        │
        m_up_limit_id           m_low_limit_id
        (oldest active)         (next to assign)
```

### 7.4.2 The Visibility Algorithm

```
is_visible(row_trx_id, ReadView rv):

  1. if row_trx_id == rv.m_creator_trx_id → VISIBLE (own changes)
  2. if row_trx_id < rv.m_up_limit_id    → VISIBLE (committed before any active txn)
  3. if row_trx_id >= rv.m_low_limit_id  → NOT VISIBLE (started after snapshot)
  4. if binary_search(rv.m_ids, row_trx_id) FOUND → NOT VISIBLE (was active at snapshot)
  5. else → VISIBLE (committed before snapshot, not in active list)
```

Step 4 uses binary search on sorted `m_ids[]` — O(log n) where n = number of concurrent
R/W transactions (typically tens to hundreds in OLTP).

**Source**: `ReadView::changes_visible()` in `storage/innobase/read/read0read.cc`.

### 7.4.3 Visibility Walk — Complete Example

```
SELECT * FROM accounts WHERE id = 42;

  ReadView: m_creator_trx_id=1010, m_ids=[1003,1007,1009],
            m_up_limit_id=1003, m_low_limit_id=1011

  Step 1: Current row → DB_TRX_ID=1009, balance=300
          1009 != 1010, 1009 >= 1003, 1009 < 1011, 1009 IN m_ids → NOT VISIBLE

  Step 2: Follow DB_ROLL_PTR → undo record, trx_id=1005, balance=200
          1005 != 1010, 1005 >= 1003, 1005 < 1011, 1005 NOT IN m_ids → VISIBLE ✓

  Result: balance=200
```

---

## 7.5 Isolation Levels — ReadView Lifetime

### 7.5.1 The Four Levels

| Level | ReadView behavior | Lock behavior |
|-------|-------------------|---------------|
| **READ UNCOMMITTED** | No ReadView; read latest version directly (dirty reads) | No row locks on reads |
| **READ COMMITTED** | New ReadView per **statement** | Record locks only (no gap locks) |
| **REPEATABLE READ** | One ReadView per **transaction** (at first consistent read) | Next-key locks (record + gap) |
| **SERIALIZABLE** | Same as RR, but plain SELECT → `SELECT ... FOR SHARE` | S locks on all reads |

### 7.5.2 RC vs RR — Side-by-Side Timeline

```
Timeline:    T0       T1       T2       T3       T4
             ──────────────────────────────────────────

  Txn A:     BEGIN    SELECT①           SELECT②    COMMIT
  Txn B:              BEGIN    UPDATE+COMMIT

  ──── READ COMMITTED ────
  SELECT①: ReadView_1 → m_ids has Txn B → sees OLD value
  SELECT②: ReadView_2 → m_ids lacks Txn B (committed) → sees NEW value
  Result: SELECT① ≠ SELECT② (non-repeatable read)

  ──── REPEATABLE READ ────
  SELECT①: ReadView_1 → m_ids has Txn B → sees OLD value
  SELECT②: REUSES ReadView_1 → m_ids still has Txn B → sees OLD value
  Result: SELECT① = SELECT② (repeatable ✓)
```

**Subtlety**: under RR, the ReadView is created at the first consistent read, NOT at BEGIN:

```sql
BEGIN;
UPDATE accounts SET balance = 500 WHERE id = 99;  -- no ReadView created
SELECT balance FROM accounts WHERE id = 1;         -- NOW ReadView created
```

To force snapshot at BEGIN time: `START TRANSACTION WITH CONSISTENT SNAPSHOT`.

>>> **Interview insight**: "What is the difference between RC and RR at the implementation
>>> level?" One sentence: RC creates a new ReadView per statement; RR creates one per
>>> transaction. Same visibility algorithm, different ReadView lifetime.

### 7.5.3 SERIALIZABLE Details

All plain SELECTs become `SELECT ... FOR SHARE`. Readers acquire S locks → writers blocked.
Writers acquire X locks → readers blocked. No MVCC benefit — pure two-phase locking (S2PL).

InnoDB does **not** implement SSI (Serializable Snapshot Isolation) like PostgreSQL 9.1+.
InnoDB's SERIALIZABLE is pessimistic (lock everything), not optimistic (detect conflicts
at commit time).

---

## 7.6 Consistent Non-Locking Reads vs Locking Reads

### 7.6.1 Consistent Read (Plain SELECT)

Uses ReadView, walks version chain, **never acquires any row lock**. This is the foundation
of "readers don't block writers":

```
row_search_mvcc() path:
  1. Traverse B+Tree to find row
  2. Check DB_TRX_ID against ReadView
  3. If not visible → follow DB_ROLL_PTR to undo log → reconstruct older version → repeat
  4. Return visible version. No lock acquired, no lock released.
```

### 7.6.2 Locking Reads

| Syntax | Lock type | Concurrency |
|--------|-----------|-------------|
| `SELECT ... FOR SHARE` | Shared (S) on matching rows | Other S locks OK; X locks blocked |
| `SELECT ... FOR UPDATE` | Exclusive (X) on matching rows | All other locks blocked |
| `SELECT ... FOR UPDATE SKIP LOCKED` | X lock, skip locked rows | Non-blocking queue pattern |
| `SELECT ... FOR UPDATE NOWAIT` | X lock, error if row locked | Fail-fast pattern |

**SKIP LOCKED** (8.0) — queue processing:
```sql
-- Worker 1:
SELECT * FROM tasks WHERE status='pending' LIMIT 1 FOR UPDATE SKIP LOCKED;
-- Gets task #101, locks it

-- Worker 2 (concurrent):
SELECT * FROM tasks WHERE status='pending' LIMIT 1 FOR UPDATE SKIP LOCKED;
-- Skips #101 (locked), gets task #102
```

### 7.6.3 When to Use Locking Reads: The Lost Update Problem

```
WRONG (lost update under RR):
  BEGIN;
  SELECT balance FROM accounts WHERE id=1;           -- snapshot: 1000
  UPDATE accounts SET balance = 900 WHERE id=1;      -- uses stale value
  COMMIT;
  -- Concurrent txn may have changed balance between SELECT and UPDATE

RIGHT:
  BEGIN;
  SELECT balance FROM accounts WHERE id=1 FOR UPDATE; -- current: locks row
  UPDATE accounts SET balance = 900 WHERE id=1;
  COMMIT;

ALSO RIGHT (atomic update, no read needed):
  UPDATE accounts SET balance = balance - 100 WHERE id=1;
```

>>> **Interview insight**: "Under RR, can you have a lost update?" Yes — if you use a
>>> plain SELECT then UPDATE based on the read value. The SELECT sees a snapshot, but
>>> UPDATE modifies the current version. Fix: `SELECT ... FOR UPDATE` or atomic
>>> `UPDATE ... SET col = col - N`.

---

## 7.7 Write Conflict Handling

### 7.7.1 First-Updater-Wins

InnoDB uses first-updater-wins (lock-based). Conflict detected at lock acquisition time,
not at commit time. Contrast with PostgreSQL SSI's first-committer-wins for serializable.

### 7.7.2 Concurrent Update — Step by Step

```
T1                                    T2
──────                                ──────
BEGIN;                                BEGIN;
UPDATE accounts SET balance=900
  WHERE id=1;
  ├── X lock on id=1 ✓
  ├── Write undo (old balance=1000)
  └── Update row: balance=900
                                      UPDATE accounts SET balance=1050
                                        WHERE id=1;
                                        ├── Try X lock on id=1
                                        └── BLOCKED ← waits for T1

COMMIT; → release X lock
                                      ├── X lock acquired ✓
                                      ├── Read CURRENT row: balance=900
                                      │   (not snapshot value!)
                                      ├── Update: balance=950
                                      └── ...
                                      COMMIT;
```

**Critical**: when T2 unblocks, it reads the CURRENT version (900), not its snapshot.
Under RC this is natural (new ReadView). Under RR, InnoDB performs a special re-read
for UPDATE/DELETE — the update operates on the current row, not the snapshot.

---

## 7.8 Phantom Reads and How InnoDB Prevents Them

### 7.8.1 InnoDB's Two-Layer Defense Under RR

**Layer 1: Consistent reads** — ReadView makes phantom rows invisible. A row inserted
by a concurrent transaction has a `DB_TRX_ID >= m_low_limit_id` or is in `m_ids` →
NOT VISIBLE. Phantom naturally prevented.

**Layer 2: Locking reads** — next-key locks prevent INSERTs into scanned ranges.
Locking reads bypass the ReadView and see current committed data, so MVCC alone
cannot prevent phantoms. Instead:

```
  T1: SELECT * FROM orders WHERE status='pending' FOR UPDATE;
      → Record locks on matching rows + gap locks between them
      → Prevents INSERT of new 'pending' rows

  T2: INSERT INTO orders (status) VALUES ('pending');
      → BLOCKED by gap lock from T1
```

### 7.8.2 InnoDB RR vs SQL Standard

```
  SQL Standard:   RR allows phantom reads
  InnoDB RR:      Prevents phantoms (consistent reads via ReadView,
                  locking reads via next-key locks)

  ┌───────────────────┬────────┬──────────┬─────────┐
  │ Isolation         │ Dirty  │ Non-Rep  │ Phantom │
  ├───────────────────┼────────┼──────────┼─────────┤
  │ SQL Standard RR   │ no     │ no       │ ALLOWED │
  │ InnoDB RR         │ no     │ no       │ NO *    │
  └───────────────────┴────────┴──────────┴─────────┘
  * Both consistent reads and locking reads are phantom-free
```

>>> **Interview insight**: "Does REPEATABLE READ prevent phantom reads?" In the SQL
>>> standard: no. In InnoDB: yes. Be precise: "InnoDB's RR prevents phantoms, which
>>> exceeds the SQL standard guarantee." This is a distinguishing InnoDB feature and
>>> a frequent interview topic.

---

## 7.9 Write Skew Anomaly

### 7.9.1 The Classic Example

```
Constraint: at least one doctor must be on call.
State: doctor A on_call=true, doctor B on_call=true.

T1 (Doctor A)                     T2 (Doctor B)
──────────────                    ──────────────
SELECT COUNT(*) FROM doctors      SELECT COUNT(*) FROM doctors
  WHERE on_call=true;               WHERE on_call=true;
  → 2                               → 2

UPDATE doctors SET on_call=false  UPDATE doctors SET on_call=false
  WHERE name='A';                   WHERE name='B';
  (X lock on row A)                 (X lock on row B — no conflict!)

COMMIT;                           COMMIT;

Result: BOTH doctors off call. Constraint violated.
```

**Why InnoDB RR fails here**: consistent reads acquire no locks. T1 locks only row A,
T2 locks only row B. No row-level conflict. No predicate locking on consistent reads.

### 7.9.2 Solutions

**1. Materialize the conflict with `FOR UPDATE`**:
```sql
SELECT COUNT(*) FROM doctors WHERE on_call=true FOR UPDATE;
-- X locks ALL on-call rows → T2 blocks until T1 commits
-- After T1 commits, T2 re-reads: count=1 → skips update
```

**2. SERIALIZABLE isolation**: all SELECTs acquire S locks. T2's UPDATE needs X lock on
row B but is blocked by T1's S lock.

**3. Application-level re-check**: after UPDATE, re-query with `FOR UPDATE`; ROLLBACK if
constraint violated.

### 7.9.3 PostgreSQL Comparison

PostgreSQL 9.1+ implements **SSI (Serializable Snapshot Isolation)** — detects write skew
automatically at SERIALIZABLE by tracking read dependencies and detecting dangerous
structures in the dependency graph. InnoDB's SERIALIZABLE uses S2PL instead: more
conservative (locks on every read) but avoids the complexity of dependency tracking.

>>> **Interview insight**: "How would you prevent write skew in MySQL?" (1) `SELECT ...
>>> FOR UPDATE` to materialize the conflict — the practical production answer.
>>> (2) SERIALIZABLE — works but kills concurrency. (3) Schema redesign. Bonus:
>>> compare with PostgreSQL's SSI which handles this automatically.

---

## 7.10 Two-Phase Commit (Internal XA)

### 7.10.1 The Two-Log Problem

InnoDB has its own redo log; MySQL Server has the binary log. A COMMIT must write to
both atomically. A crash between the two = inconsistency (redo says committed, binlog
says not → primary/replica diverge).

### 7.10.2 Internal XA Protocol

```
  Phase 1: PREPARE
  ┌─────────────────────────────────┐
  │ InnoDB: write PREPARE record    │──► fsync redo log
  │ to redo log (XID=<internal_id>) │
  └─────────────────────────────────┘
                   │
  Phase 2a: BINLOG WRITE
  ┌─────────────────────────────────┐
  │ MySQL: write transaction events │──► fsync binary log
  │ to binlog with same XID         │
  └─────────────────────────────────┘
                   │
  Phase 2b: ENGINE COMMIT
  ┌─────────────────────────────────┐
  │ InnoDB: write COMMIT record     │   (may be batched)
  │ to redo log                     │
  └─────────────────────────────────┘
```

### 7.10.3 Crash Recovery Decision Matrix

```
  ┌──────────────────┬────────────────┬────────────────────┐
  │ Redo Log State   │ Binlog State   │ Action             │
  ├──────────────────┼────────────────┼────────────────────┤
  │ No PREPARE       │ N/A            │ Nothing to do      │
  │ PREPARE only     │ No binlog entry│ ROLLBACK           │
  │ PREPARE only     │ Binlog present │ COMMIT (re-commit) │
  │ COMMIT           │ Binlog present │ Already consistent │
  └──────────────────┴────────────────┴────────────────────┘
```

**Key insight**: the binary log is the arbiter of truth. If the transaction made it to the
binlog, it is committed (replicas may have received it). Matching via XID: each internal XA
transaction gets a unique XID in both redo PREPARE and binlog event.

### 7.10.4 Durability Configuration

```
  ┌─────────────────────────────────────────────────────────────────┐
  │ innodb_flush_log_at_trx_commit   sync_binlog    Result         │
  ├─────────────────────────────────────────────────────────────────┤
  │ = 1                              = 1            FULL ACID      │
  │                                                 2 fsyncs/commit│
  │ = 1                              = 0            Redo durable,  │
  │                                                 binlog may lose│
  │ = 2                              = 1            Binlog durable,│
  │                                                 redo OS-buffer │
  │ = 0                              = 0            Max perf, up to│
  │                                                 1s data loss   │
  └─────────────────────────────────────────────────────────────────┘
```

>>> **Interview insight**: "What settings give full ACID durability in MySQL?"
>>> `innodb_flush_log_at_trx_commit=1` AND `sync_binlog=1`. Both must be 1. This costs
>>> two fsyncs per commit, mitigated by group commit. Know this cold.

---

## 7.11 Group Commit

### 7.11.1 The fsync Bottleneck

With full durability (`flush=1, sync_binlog=1`), every commit = two fsyncs. A typical SSD
handles ~10K-50K fsyncs/sec. Without batching: throughput capped at ~5K-25K TPS. On spinning
disk: ~200 TPS.

### 7.11.2 The Solution: Batch Multiple Transactions into One fsync

```
Without group commit:
  T1: [redo fsync] [binlog fsync]
  T2:              [redo fsync] [binlog fsync]    ← serialized on fsync
  T3:                           [redo fsync] ...

With group commit:
  T1,T2,T3,T4,T5 ready concurrently:
  Leader: [write all 5 redo] [ONE fsync] [write all 5 binlog] [ONE fsync]
  5 transactions, 2 fsyncs total instead of 10
```

### 7.11.3 Three-Stage Pipeline

```
  ┌───────────────────────────────────────────────────────┐
  │            Binary Log Group Commit Pipeline           │
  │                                                       │
  │  FLUSH stage:  Leader collects followers,             │
  │                writes all binlog events (no fsync)    │
  │                        │                              │
  │  SYNC stage:   Leader collects new arrivals,          │
  │                ONE fsync for entire batch              │
  │                        │                              │
  │  COMMIT stage: Mark all transactions committed        │
  │                in InnoDB redo (batched fsync)          │
  └───────────────────────────────────────────────────────┘
```

**Tuning knobs**:
```sql
binlog_group_commit_sync_delay = 1000;        -- wait up to 1ms for more txns
binlog_group_commit_sync_no_delay_count = 10; -- or until 10 txns accumulated
```

Trade-off: higher delay → larger groups → better throughput → higher per-txn latency.

### 7.11.4 Group Commit Enables Parallel Replication

Transactions group-committed together on the primary are guaranteed non-conflicting. The
replica can apply them in parallel. Larger commit groups → more replica parallelism → lower
replica lag.

Binlog records commit group membership via `last_committed` and `sequence_number` in GTID events.
Paradoxically, increasing `binlog_group_commit_sync_delay` can improve replica performance.

>>> **Interview insight**: "How does MySQL achieve high TPS despite fsync-per-commit?"
>>> Group commit: multiple transactions batched into one fsync via a three-stage pipeline
>>> (FLUSH → SYNC → COMMIT). Bonus: group commit enables parallel replication because
>>> co-committed transactions are known non-conflicting.

---

## 7.12 Savepoints and Nested Transactions

### 7.12.1 Savepoint Mechanics

MySQL does not support true nested transactions. Savepoints provide partial rollback:

```sql
BEGIN;
INSERT INTO orders (id, status) VALUES (1, 'new');
SAVEPOINT sp1;
INSERT INTO order_items (order_id, product_id) VALUES (1, 999);  -- fails
ROLLBACK TO sp1;   -- undoes order_items INSERT, keeps orders INSERT
INSERT INTO order_items (order_id, product_id) VALUES (1, 200);  -- retry
COMMIT;            -- commits orders + order_items(1,200)
```

### 7.12.2 Implementation

A savepoint records the current undo log position (`undo_no`):

```
  Undo log: [INSERT orders] → [INSERT items(999)]
                            ↑                     ↑
                         SAVEPOINT sp1         current (undo_no=2)

  ROLLBACK TO sp1:
    Walk undo from undo_no=2 back to undo_no=1
    Apply inverse operations → delete items(999)

  After rollback: [INSERT orders]
                               ↑ current (undo_no=1)
```

**Important**: locks acquired after the savepoint are NOT released on `ROLLBACK TO SAVEPOINT`.
Only data changes are undone. Releasing locks would violate two-phase locking.

### 7.12.3 Spring Framework Integration

```java
@Transactional(propagation = Propagation.NESTED)
public void reserveStock(Order order) {
    // Runs within a savepoint of the outer transaction
    // If this throws → ROLLBACK TO SAVEPOINT (outer txn continues)
}
```

Spring issues `Connection.setSavepoint()` before calling the nested method and
`ROLLBACK TO SAVEPOINT` on exception. Key distinction:

```
  NESTED:       Same physical transaction. Savepoint. Shares locks.
  REQUIRES_NEW: New physical transaction. Separate locks. Separate commit.
```

>>> **Interview insight**: "How does Spring's NESTED propagation work with MySQL?"
>>> JDBC savepoints. The database issues SAVEPOINT, and on failure ROLLBACK TO SAVEPOINT
>>> undoes only the nested portion. Locks acquired within the savepoint are NOT released
>>> — only data changes are undone. Distinct from REQUIRES_NEW which suspends the outer
>>> transaction entirely.

---

## 7.13 Source Code Reference Map

```
Transaction lifecycle:
  storage/innobase/trx/trx0trx.cc     — trx_start_low(), trx_commit(), trx_rollback_active()

ReadView and MVCC:
  storage/innobase/read/read0read.cc   — MVCC::view_open(), ReadView::changes_visible()
  storage/innobase/include/read0types.h — struct ReadView

Version chain traversal:
  storage/innobase/row/row0sel.cc      — row_search_mvcc(), row_sel_build_prev_vers()

Undo log:
  storage/innobase/trx/trx0undo.cc    — trx_undo_prev_version_build()

Two-phase commit:
  sql/binlog.cc                        — MYSQL_BIN_LOG::ordered_commit() (3-stage pipeline)
  storage/innobase/handler/ha_innodb.cc — innobase_xa_prepare(), innobase_commit()

Transaction system:
  storage/innobase/include/trx0sys.h   — trx_sys_t, max_trx_id, rw_trx_ids
```

---

## 7.14 Summary

```
┌──────────────────────────────────────────────────────────────────┐
│                   The Five Laws of InnoDB Concurrency            │
├──────────────────────────────────────────────────────────────────┤
│ 1. Readers never block writers (ReadView, not locks)             │
│ 2. Writers never block readers (old versions in undo log)        │
│ 3. Writers block writers on same row (X lock exclusivity)        │
│ 4. Version chain length ∝ longest active ReadView                │
│ 5. Group commit converts N fsyncs → 1, multiplying throughput    │
└──────────────────────────────────────────────────────────────────┘
```

---

*Next chapter: [Chapter 8 — Write-Ahead Logging: Redo Log and Crash Recovery](08-redo-log-and-crash-recovery.md)*
