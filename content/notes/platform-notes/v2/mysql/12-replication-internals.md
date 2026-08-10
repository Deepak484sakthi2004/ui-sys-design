# Chapter 12: Replication Internals

## How a Byte Written on the Primary Reaches the Replica

---

MySQL replication is the mechanism that turns a single database server into a
distributed data platform. Every read replica, every DR standby, every CDC
pipeline that feeds your Kafka cluster --- they all depend on one foundational
abstraction: the binary log. This chapter dissects replication from the byte
level upward: how the primary records changes, how those changes travel over
the wire, how the replica applies them, and what happens when things go wrong.

We will trace the full lifecycle of a single `UPDATE` statement from the moment
it commits on the primary to the moment the replica's storage engine has the
modified row on disk. Along the way, we will examine every thread, every file,
every protocol message, and every failure mode that a senior engineer must
understand.

---

## 12.1 Binary Log --- The Foundation of Replication

### What Is the Binlog

The binary log (binlog) is an ordered, append-only log of every data-modifying
event on the MySQL server. It lives at the **MySQL server layer** --- above any
storage engine. This is a critical architectural distinction:

```
  ┌─────────────────────────────────────────────────────────┐
  │                    MySQL Server Layer                    │
  │                                                         │
  │   ┌─────────────────────────────────────────────────┐   │
  │   │              Binary Log (binlog)                │   │
  │   │  - Server-level, engine-agnostic                │   │
  │   │  - Records logical changes (SQL or row images)  │   │
  │   │  - Used for: replication, PITR, CDC             │   │
  │   │  - Survives across engine boundaries            │   │
  │   └─────────────────────────────────────────────────┘   │
  │                                                         │
  └──────────────────────────┬──────────────────────────────┘
                             │ Handler API
  ┌──────────────────────────┴──────────────────────────────┐
  │                   InnoDB Storage Engine                   │
  │                                                         │
  │   ┌─────────────────────────────────────────────────┐   │
  │   │                Redo Log (WAL)                    │   │
  │   │  - Engine-internal, InnoDB-specific              │   │
  │   │  - Records physical page changes (byte offsets)  │   │
  │   │  - Used for: crash recovery only                 │   │
  │   │  - Circular, fixed-size, overwritten             │   │
  │   └─────────────────────────────────────────────────┘   │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
```

**>>> "The binlog is a server-layer logical log; the redo log is an engine-layer
physical log. They serve completely different purposes, but they must be kept
in sync via two-phase commit (XA) to guarantee crash consistency. This is one
of the most frequently misunderstood distinctions in MySQL interviews."**

### Binlog vs Redo Log --- Side by Side

| Property              | Binary Log (binlog)                       | InnoDB Redo Log                           |
|-----------------------|-------------------------------------------|-------------------------------------------|
| Layer                 | MySQL server (above storage engine)       | InnoDB storage engine (internal)          |
| Content               | Logical: SQL text or row before/after     | Physical: page number + byte offset + data|
| Scope                 | All storage engines                       | InnoDB only                               |
| Lifetime              | Append-only, rotated, retained for days   | Circular, fixed-size, overwritten         |
| Purpose               | Replication, PITR, CDC                    | Crash recovery                            |
| Sync control          | `sync_binlog`                             | `innodb_flush_log_at_trx_commit`          |
| Can reconstruct data? | Yes (point-in-time replay)                | Only within crash recovery window         |
| Default state (8.0)   | ON (`log_bin = ON`)                       | Always ON                                 |

### Binlog Use Cases

1. **Replication**: the primary streams binlog events to replicas, which replay
   them to maintain synchronized copies of the data.
2. **Point-in-time recovery (PITR)**: restore a full backup, then replay binlog
   events from the backup timestamp to the target timestamp.
3. **Change Data Capture (CDC)**: tools like Debezium, Maxwell, and Canal read
   the binlog as a change stream and emit events to Kafka, Pulsar, or other
   systems.

### Binlog File Structure

```
  ┌─────────────────────────────────────────────────────────┐
  │  Data directory (/var/lib/mysql/)                        │
  │                                                         │
  │  binlog.000001   ← oldest binlog file (may be purged)   │
  │  binlog.000002                                          │
  │  binlog.000003   ← current active binlog file            │
  │  binlog.index    ← text file listing active binlog files │
  └─────────────────────────────────────────────────────────┘

  binlog.index contents:
    /var/lib/mysql/binlog.000001
    /var/lib/mysql/binlog.000002
    /var/lib/mysql/binlog.000003
```

Each binlog file has a 4-byte magic number (`0xfe 0x62 0x69 0x6e` = `"\xfebin"`)
at the very beginning, followed by a `FORMAT_DESCRIPTION_EVENT` that describes
the binlog version and server configuration.

Rotation occurs when:
- The file reaches `max_binlog_size` (default 1 GB)
- The server is restarted
- `FLUSH BINARY LOGS` is executed
- Certain replication events require it

### Binlog Management Commands

```sql
-- List all binlog files with sizes
SHOW BINARY LOGS;
+------------------+-----------+-----------+
| Log_name         | File_size | Encrypted |
+------------------+-----------+-----------+
| binlog.000001    |       178 | No        |
| binlog.000002    |  10485923 | No        |
| binlog.000003    |      4217 | No        |
+------------------+-----------+-----------+

-- View events in a specific binlog file
SHOW BINLOG EVENTS IN 'binlog.000002' LIMIT 20;

-- Purge old binlog files
PURGE BINARY LOGS TO 'binlog.000002';
PURGE BINARY LOGS BEFORE '2025-01-01 00:00:00';

-- Current binlog position
SHOW MASTER STATUS;   -- deprecated name, still works
SHOW BINARY LOG STATUS; -- 8.2+ name
```

Source: `sql/binlog.cc`, `MYSQL_BIN_LOG::open_binlog()`,
`MYSQL_BIN_LOG::new_file_impl()` for rotation logic.

---

## 12.2 Binary Log Event Format

Every entry in the binlog is an **event**. Events are the atoms of replication
--- the smallest unit that the primary produces and the replica consumes.

### Event Header Structure

Every binlog event begins with a fixed 19-byte header (binlog v4, used since
MySQL 5.0):

```
  Offset  Size  Field              Description
  ──────  ────  ─────              ───────────
  0       4     timestamp          UNIX timestamp when event was created
  4       1     type_code          Event type (enum Log_event_type)
  5       4     server_id          Originating server's server_id
  9       4     event_length       Total event size (header + data + checksum)
  13      4     next_position      Offset of next event in binlog file
  17      2     flags              Event flags (LOG_EVENT_BINLOG_IN_USE_F, etc.)
  ──────────────────────────────────────────────────────────────────
  19+     var   event_data         Type-specific payload
  ...     4     checksum           CRC32 checksum (when binlog_checksum = CRC32)
```

Source: `libbinlogevents/include/binlog_event.h`, `Log_event_header` struct.

### Event Types

| Event Type             | type_code | Description                                           |
|------------------------|-----------|-------------------------------------------------------|
| `FORMAT_DESCRIPTION`   | 15        | First event in each binlog file. Binlog version info. |
| `QUERY_EVENT`          | 2         | SQL statement text (STATEMENT format)                 |
| `TABLE_MAP_EVENT`      | 19        | Maps table_id to schema.table for row events          |
| `WRITE_ROWS_EVENT`     | 30        | INSERT (ROW format)                                   |
| `UPDATE_ROWS_EVENT`    | 31        | UPDATE (ROW format) --- before + after images         |
| `DELETE_ROWS_EVENT`    | 32        | DELETE (ROW format) --- before image                  |
| `XID_EVENT`            | 16        | InnoDB XA transaction commit marker                   |
| `GTID_EVENT`           | 33        | GTID for the following transaction                    |
| `PREVIOUS_GTIDS_EVENT` | 35        | Set of all GTIDs in previous binlog files             |
| `ROTATE_EVENT`         | 4         | Pointer to next binlog file (on rotation)             |
| `ANONYMOUS_GTID_EVENT` | 34        | Transaction without GTID (GTID mode OFF)              |

Source: `libbinlogevents/include/binlog_event.h`, enum `Log_event_type`.

### A Complete Transaction in ROW Format

Here is what a single `UPDATE users SET email='x' WHERE id=42` looks like
in the binlog when `binlog_format = ROW`:

```
  binlog.000003, pos 1200:
  ┌──────────────────────────────────────────────────────────────┐
  │ GTID_EVENT                                                   │
  │   GTID: 3E11FA47-71CA-11E1-9E33-C80AA9429562:157            │
  │   flags: COMMITTED                                           │
  ├──────────────────────────────────────────────────────────────┤
  │ QUERY_EVENT                                                  │
  │   "BEGIN"                                                    │
  ├──────────────────────────────────────────────────────────────┤
  │ TABLE_MAP_EVENT                                              │
  │   table_id: 108                                              │
  │   database: myapp                                            │
  │   table: users                                               │
  │   column_types: [LONG, VARCHAR(255), VARCHAR(255), DATETIME] │
  ├──────────────────────────────────────────────────────────────┤
  │ UPDATE_ROWS_EVENT                                            │
  │   table_id: 108                                              │
  │   before_image: {id=42, name="Deepak", email="old@x.com",   │
  │                   created="2024-01-15 10:30:00"}             │
  │   after_image:  {id=42, name="Deepak", email="x",           │
  │                   created="2024-01-15 10:30:00"}             │
  ├──────────────────────────────────────────────────────────────┤
  │ XID_EVENT                                                    │
  │   xid: 9823                                                  │
  │   (marks transaction commit in InnoDB)                       │
  └──────────────────────────────────────────────────────────────┘
```

### Binlog Formats --- STATEMENT, ROW, and MIXED

MySQL supports three binlog formats, controlled by `binlog_format`:

**STATEMENT Format**

Logs the literal SQL text of each statement.

```sql
-- What gets logged:
# at 1200
# 250115 10:30:00 server id 1  end_log_pos 1350
UPDATE users SET email='x' WHERE id=42;
```

Advantages: small binlog size (one entry per statement, regardless of rows
affected). Easy to read.

Problems --- **non-deterministic functions break replication**:

```sql
-- These produce different values on primary vs replica:
INSERT INTO events (id, ts) VALUES (UUID(), NOW());
UPDATE stats SET val = val + RAND();
DELETE FROM logs ORDER BY id LIMIT 1000;  -- order may differ
```

The replica executes the same SQL text, but `UUID()` generates a different
value, `NOW()` returns a different timestamp, and `LIMIT` without a
deterministic `ORDER BY` deletes different rows.

**ROW Format** (default since MySQL 8.0)

Logs the before-image and after-image of each affected row. The SQL text is
never logged --- only the row data.

```
  STATEMENT format:                   ROW format:
  ┌─────────────────────────┐        ┌─────────────────────────────────┐
  │ UPDATE users            │        │ UPDATE_ROWS_EVENT               │
  │ SET email='x'           │        │   before: {42, "Deepak", "old"}│
  │ WHERE id=42;            │        │   after:  {42, "Deepak", "x"}  │
  │                         │        │                                 │
  │ 1 entry regardless of   │        │ 1 entry PER affected row        │
  │ how many rows affected  │        │ UPDATE 10M rows = 10M entries   │
  └─────────────────────────┘        └─────────────────────────────────┘
```

**>>> ROW format is always deterministic. The replica applies exact row images,
so it does not matter what functions were used to compute them. This is why
CDC tools (Debezium, Maxwell) require ROW format --- they need the actual
data values, not the SQL text.**

**`binlog_row_image` --- Controlling Image Size**

| Setting    | Before-image contains         | After-image contains           | Use case                 |
|------------|-------------------------------|--------------------------------|--------------------------|
| `FULL`     | All columns                   | All columns                    | Default. Safe for CDC.   |
| `MINIMAL`  | Only PK / unique key columns  | Only changed columns           | Bandwidth optimization   |
| `NOBLOB`   | All columns except unchanged BLOB/TEXT | All columns except unchanged BLOB/TEXT | Large BLOB optimization |

Example --- `FULL` vs `MINIMAL` for `UPDATE users SET email='x' WHERE id=42`:

```
  FULL:
    before: {id=42, name="Deepak", email="old@x.com", bio=<4KB text>}
    after:  {id=42, name="Deepak", email="x",         bio=<4KB text>}
    Event size: ~8 KB

  MINIMAL:
    before: {id=42}
    after:  {email="x"}
    Event size: ~50 bytes
```

MINIMAL is dramatically smaller, but CDC tools that need the full row state
(e.g., Debezium for Kafka Connect) require FULL images to reconstruct the
complete row.

**MIXED Format**

Uses STATEMENT by default, automatically switches to ROW for statements that
are non-deterministic:

```
  ┌─────────────────────────────────────────────────────────┐
  │  MIXED mode decision tree:                               │
  │                                                         │
  │  Statement uses UUID(), RAND(), NOW(),                  │
  │  user-defined functions, AUTO_INCREMENT with triggers,  │
  │  or other non-deterministic features?                   │
  │    │                                                    │
  │    ├─ YES → log as ROW event                            │
  │    └─ NO  → log as STATEMENT event                      │
  └─────────────────────────────────────────────────────────┘
```

**>>> In practice, ROW format is the industry standard for production MySQL.
STATEMENT is legacy. MIXED is a compromise that still surprises people when
some statements silently switch to ROW. Unless you have a specific reason for
STATEMENT (extreme binlog size constraints), use ROW.**

Source: `sql/binlog.cc`, `THD::decide_logging_format()` --- the function that
chooses STATEMENT vs ROW for each statement in MIXED mode.

---

## 12.3 Binlog Group Commit

### The Performance Problem

With `sync_binlog = 1`, MySQL calls `fsync()` on the binlog file after every
transaction commit. This is the safest setting --- guarantees no committed
transaction is lost even on power failure --- but `fsync()` is expensive:

```
  Enterprise SSD fsync latency:  50-200 μs
  HDD fsync latency:             2-10 ms

  At 100 μs per fsync, sequential commits are limited to:
    1,000,000 / 100 = 10,000 transactions/sec (TPS)

  With concurrent clients, each waiting for its own fsync:
    10 clients × 100 μs fsync = 1,000 μs total I/O time per group
    But if each fsync is independent: 10 × 100 μs serialized = 1 ms
```

### The Solution --- Group Commit

Group commit batches multiple transactions' binlog writes into a single
`fsync()` call. If 50 transactions are ready to commit at roughly the same
time, they all share one `fsync()` --- amortizing the I/O cost across all 50.

MySQL implements group commit as a three-stage pipeline:

```
  ┌────────────────────────────────────────────────────────────────┐
  │              BINLOG GROUP COMMIT PIPELINE                       │
  │                                                                │
  │  Stage 1: FLUSH                                                │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │  First thread to arrive becomes the LEADER.              │  │
  │  │  Leader waits briefly for FOLLOWERS to queue up.          │  │
  │  │  Then writes ALL queued transactions to binlog OS buffer. │  │
  │  │                                                          │  │
  │  │  T1(leader) ──┐                                          │  │
  │  │  T2(follower)─┤  write binlog records                    │  │
  │  │  T3(follower)─┤  to OS page cache                        │  │
  │  │  T4(follower)─┘  (no fsync yet)                          │  │
  │  └──────────────────────────────────────────────────────────┘  │
  │                            │                                    │
  │                            ▼                                    │
  │  Stage 2: SYNC                                                 │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │  Leader calls fsync() ONCE for the entire group.         │  │
  │  │                                                          │  │
  │  │  fsync(binlog_fd)  ← one I/O operation for all 4 txns   │  │
  │  │                                                          │  │
  │  │  This is where the I/O cost is amortized.                │  │
  │  └──────────────────────────────────────────────────────────┘  │
  │                            │                                    │
  │                            ▼                                    │
  │  Stage 3: COMMIT                                               │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │  Leader calls InnoDB commit (ha_commit_low) for each     │  │
  │  │  transaction in the group.                                │  │
  │  │                                                          │  │
  │  │  T1 → engine commit                                      │  │
  │  │  T2 → engine commit                                      │  │
  │  │  T3 → engine commit                                      │  │
  │  │  T4 → engine commit                                      │  │
  │  │                                                          │  │
  │  │  All followers are released. Clients see "commit OK".    │  │
  │  └──────────────────────────────────────────────────────────┘  │
  └────────────────────────────────────────────────────────────────┘
```

Source: `sql/binlog.cc`, `MYSQL_BIN_LOG::ordered_commit()` --- the function
implementing the three-stage pipeline. The queue data structure is
`Commit_order_queue`.

### Tuning Group Commit

| Variable                                  | Default  | Purpose                                             |
|-------------------------------------------|----------|-----------------------------------------------------|
| `binlog_group_commit_sync_delay`          | 0 μs     | Artificial delay: leader waits this long to collect more followers before proceeding to SYNC stage |
| `binlog_group_commit_sync_no_delay_count` | 0        | Short-circuit: if this many transactions are queued, proceed immediately (do not wait for delay) |

Setting `binlog_group_commit_sync_delay = 1000` (1 ms) and
`binlog_group_commit_sync_no_delay_count = 20` means: wait up to 1 ms for
followers, but if 20 transactions queue up before the 1 ms elapses, proceed
immediately.

```
  Without group commit:           With group commit:
  T1: write → fsync → commit     T1: write ─┐
  T2: write → fsync → commit     T2: write ─┤
  T3: write → fsync → commit     T3: write ─┤→ fsync → commit all
  T4: write → fsync → commit     T4: write ─┘
  Total: 4 fsyncs                 Total: 1 fsync
  Latency: 4 × 100μs = 400μs     Latency: 100μs + group wait
```

**>>> Group commit is the single most important optimization for write-heavy
workloads with `sync_binlog = 1`. Without it, you are limited to ~10K TPS on
SSD. With it, you can sustain 50-100K TPS because the fsync cost is amortized.
The `binlog_group_commit_sync_delay` variable is the knob you tune --- increase
it for higher throughput (more transactions per group), at the cost of slightly
higher per-transaction latency.**

### Two-Phase Commit (XA) Coordination

The binlog and the InnoDB redo log are two separate durable logs that must agree
on which transactions are committed. MySQL uses an internal XA (two-phase
commit) protocol to coordinate them:

```
  Transaction commit flow (simplified):
  ┌──────────────────────────────────────────────────────────────┐
  │  Phase 1: PREPARE                                            │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │  InnoDB writes PREPARE record to redo log               │  │
  │  │  (transaction is durable in redo but NOT yet committed) │  │
  │  └────────────────────────────────────────────────────────┘  │
  │                            │                                  │
  │  Phase 2: COMMIT (two sub-steps)                              │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │  Step A: Write + fsync binlog event                     │  │
  │  │          (this is the commit point --- if this succeeds,│  │
  │  │           the transaction is committed)                 │  │
  │  │                                                        │  │
  │  │  Step B: InnoDB writes COMMIT record to redo log        │  │
  │  │          (marks the prepare record as committed)        │  │
  │  └────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────┘
```

**The binlog write is the true commit point.** During crash recovery:
- If a PREPARED transaction is in the redo log but NOT in the binlog → rollback
- If a PREPARED transaction is in both redo log and binlog → commit

This guarantees that the binlog and InnoDB always agree on the set of committed
transactions.

Source: `sql/binlog.cc`, `MYSQL_BIN_LOG::prepare()` and
`MYSQL_BIN_LOG::commit()`.

---

## 12.4 GTID (Global Transaction Identifier)

### The Problem GTIDs Solve

Before GTIDs (MySQL 5.5 and earlier), replication position was tracked by
**binlog filename + byte offset**:

```
  "I am replica-2. I have applied everything in binlog.000003 up to
   position 87423. Send me bytes starting from 87423."
```

This is fragile:
- On failover, the new primary has a **different binlog filename and offset**.
  You must manually compute the equivalent position.
- Circular replication has no way to detect already-applied events.
- Automated failover tools need complex offset translation.

### GTID Format

A GTID is globally unique:

```
  source_uuid : transaction_number
  ─────────────────────────────────
  3E11FA47-71CA-11E1-9E33-C80AA9429562 : 23

  source_uuid = server's @@server_uuid (auto-generated, persisted in auto.cnf)
  transaction_number = monotonically increasing integer on that server
```

A **GTID set** is a compact notation for a range:

```
  3E11FA47-71CA-11E1-9E33-C80AA9429562:1-100
  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  Means: transactions 1 through 100 from this server

  Multi-source example:
  3E11FA47-...:1-100, A1B2C3D4-...:1-50
  ^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^
  100 transactions     50 transactions
  from server A        from server B
```

### GTID Lifecycle

```
  PRIMARY                                 REPLICA
  ┌─────────────────────────────┐        ┌─────────────────────────────┐
  │ 1. Transaction commits      │        │                             │
  │    GTID assigned:           │        │                             │
  │    uuid:157                 │        │                             │
  │                             │        │                             │
  │ 2. GTID_EVENT written to    │        │                             │
  │    binlog, followed by      │───TCP──│ 4. I/O thread receives      │
  │    the transaction events   │        │    events, writes to        │
  │                             │        │    relay log                │
  │ 3. gtid_executed updated:   │        │                             │
  │    uuid:1-157               │        │ 5. SQL thread reads relay   │
  │                             │        │    log, applies transaction │
  │                             │        │                             │
  │                             │        │ 6. gtid_executed updated:   │
  │                             │        │    uuid:1-157               │
  │                             │        │                             │
  │                             │        │ 7. GTID persisted to        │
  │                             │        │    mysql.gtid_executed      │
  │                             │        │    table (batched)          │
  └─────────────────────────────┘        └─────────────────────────────┘
```

### Key GTID Variables

| Variable              | Scope    | Description                                             |
|-----------------------|----------|---------------------------------------------------------|
| `@@gtid_mode`         | Global   | `OFF`, `OFF_PERMISSIVE`, `ON_PERMISSIVE`, `ON`          |
| `@@server_uuid`       | Global   | This server's UUID (from `auto.cnf`)                    |
| `@@gtid_executed`     | Session  | All GTIDs executed on this server                       |
| `@@gtid_purged`       | Global   | GTIDs executed but binlogs have been purged             |
| `@@gtid_next`         | Session  | GTID to assign to the next transaction                  |
| `@@gtid_owned`        | Session  | GTIDs currently owned (in-flight) by threads            |

**gtid_executed vs gtid_purged**:

```
  Timeline of binlog files:
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ binlog.1 │ │ binlog.2 │ │ binlog.3 │ │ binlog.4 │
  │ GTID 1-25│ │ GTID 26- │ │ GTID 76- │ │ GTID 126-│
  │          │ │       75 │ │      125 │ │      157 │
  └──────────┘ └──────────┘ └──────────┘ └──────────┘
       ▲                          ▲
       │                          │
    PURGED                     AVAILABLE
  (files deleted)             (still on disk)

  gtid_executed = uuid:1-157    (all transactions ever executed)
  gtid_purged   = uuid:1-75     (executed, but binlog files gone)

  A new replica can only start from GTID 76+ because 1-75 are not
  in any binlog file. It would need a backup that includes 1-75.
```

### GTID Auto-Positioning

With GTIDs, a replica never sends "give me file X, position Y". Instead:

```
  Replica → Primary:
    "My gtid_executed = uuid:1-150. Send me everything I'm missing."

  Primary computes:
    primary.gtid_executed - replica.gtid_executed = uuid:151-157

  Primary sends events for GTIDs 151 through 157.
```

This makes failover trivial:

```
  BEFORE FAILOVER:                    AFTER FAILOVER:
  ┌─────────┐                         ┌─────────┐
  │ Primary │ ──── uuid:1-157         │ (dead)  │
  │ (dead)  │                         │         │
  └─────────┘                         └─────────┘
       │
       ├──── Replica-A (uuid:1-155)   ┌─────────┐
       │                              │Primary  │ ← promoted
       └──── Replica-B (uuid:1-150)   │(was A)  │
                                      │uuid:1-155│
                                      └────┬────┘
                                           │
                                      ┌────┴────┐
                                      │Replica-B│
                                      │uuid:1-150│
                                      │         │
                                      │ "Send me│
                                      │ 151-155"│
                                      └─────────┘

  Replica-B simply connects to the new primary and says:
  "I have 1-150, send me what I'm missing."
  No binlog offset translation needed.
```

**>>> GTIDs eliminate the single most error-prone aspect of MySQL replication
management: manual binlog position calculation during failover. With GTIDs,
failover becomes a two-step process: (1) promote a replica, (2) point other
replicas to it. Auto-positioning handles the rest. This is why GTID mode is
mandatory for InnoDB Cluster and recommended for all production deployments.**

### GTID Consistency Enforcement

`ENFORCE_GTID_CONSISTENCY = ON` rejects statements that are unsafe with GTIDs:

| Blocked Statement              | Why It Is Unsafe                                          |
|--------------------------------|-----------------------------------------------------------|
| `CREATE TABLE ... SELECT`      | Cannot be atomic --- one GTID but two operations (DDL + DML) |
| `CREATE TEMPORARY TABLE` in tx | Temp table operations cannot be replicated reliably with GTIDs |
| Transaction mixing InnoDB + non-transactional engine | A single GTID cannot represent a partial commit |

Source: `sql/rpl_gtid.h`, `sql/rpl_gtid_execution.cc`.

---

## 12.5 Replication Topology and Threads

### The Full Replication Data Path

```
  PRIMARY                                     REPLICA
  ═══════                                     ═══════

  ┌────────────────────┐
  │  Client Thread     │
  │  (connection_handler│
  │   _per_thread.cc)  │
  │                    │
  │  Executes DML:     │
  │  UPDATE users ...  │
  │                    │
  │  1. Execute in     │
  │     InnoDB         │
  │  2. Write binlog   │
  │     event          │
  │  3. Two-phase      │
  │     commit (XA)    │
  └────────┬───────────┘
           │ writes to
           ▼
  ┌────────────────────┐
  │  Binlog File       │
  │  (binlog.000003)   │
  │                    │               ┌─────────────────────────┐
  │  GTID_EVENT        │               │  I/O Thread             │
  │  QUERY("BEGIN")    │               │  (rpl_replica.cc)       │
  │  TABLE_MAP_EVENT   │               │                         │
  │  UPDATE_ROWS_EVENT │               │  Connects to primary's  │
  │  XID_EVENT         │               │  binlog dump thread.    │
  └────────┬───────────┘               │  Receives events over   │
           │ read by                   │  TCP.                   │
           ▼                           │  Writes to relay log.   │
  ┌────────────────────┐               │                         │
  │  Binlog Dump Thread│               │  Sends ACK for semi-    │
  │  (rpl_binlog_      │               │  sync (if enabled).     │
  │   sender.cc)       │               └────────────┬────────────┘
  │                    │                            │ writes to
  │  One per connected │───────TCP/SSL─────────────>│
  │  replica.          │     (COM_BINLOG_DUMP_GTID) │
  │  Reads binlog,     │                            ▼
  │  sends events.     │               ┌─────────────────────────┐
  │                    │               │  Relay Log              │
  │  Sleeps on binlog  │               │  (relay-bin.000001)     │
  │  condvar when      │               │                         │
  │  caught up.        │               │  Local copy of binlog   │
  │  Wakes on new      │               │  events from primary.   │
  │  event.            │               │  Same format as binlog. │
  └────────────────────┘               │  Purged after apply.    │
                                       └────────────┬────────────┘
                                                    │ read by
                                                    ▼
                                       ┌─────────────────────────┐
                                       │  SQL Thread(s)          │
                                       │  (rpl_rli.cc)           │
                                       │                         │
                                       │  Reads relay log events.│
                                       │  Applies them to local  │
                                       │  InnoDB.                │
                                       │                         │
                                       │  Single-threaded (legacy)│
                                       │  or multi-threaded (MTS)│
                                       │  with parallel workers. │
                                       └─────────────────────────┘
```

### Thread Details

**Binlog Dump Thread** (on primary, source: `sql/rpl_binlog_sender.cc`)

- One per connected replica. If you have 5 replicas, the primary has 5 binlog
  dump threads.
- Uses `COM_BINLOG_DUMP_GTID` protocol command (with GTID auto-positioning) or
  legacy `COM_BINLOG_DUMP` (file + position).
- When the replica is caught up, the dump thread sleeps on a condition variable
  (`MYSQL_BIN_LOG::update_cond`). When a new transaction is written to the
  binlog, the condition is signaled, and the dump thread wakes to send the new
  event.
- Visible in `SHOW PROCESSLIST` as `Binlog Dump` or `Binlog Dump GTID`.

**I/O Thread** (on replica, source: `sql/rpl_replica.cc`)

- A single thread per replication channel (one per primary in multi-source).
- Connects to the primary using standard MySQL protocol, then sends
  `COM_BINLOG_DUMP_GTID`.
- Receives events and writes them to the **relay log** --- a local file that
  mirrors the binlog format.
- Controls: `START REPLICA IO_THREAD`, `STOP REPLICA IO_THREAD`.

**SQL Thread** (on replica, source: `sql/rpl_rli.cc`)

- Reads events from the relay log and executes them against local storage.
- In single-threaded mode (legacy), this is the bottleneck: one thread applying
  all changes sequentially.
- In multi-threaded mode (MTS), the SQL thread becomes a **coordinator** that
  distributes events to worker threads.
- Controls: `START REPLICA SQL_THREAD`, `STOP REPLICA SQL_THREAD`.

### Relay Log

The relay log is a staging area on the replica. It exists because the I/O
thread and SQL thread run asynchronously --- the I/O thread can fetch events
from the primary faster than the SQL thread can apply them.

```
  ┌─────────────────────────────────────────────────────────────┐
  │  Relay Log Files (on replica)                                │
  │                                                             │
  │  relay-bin.000001  ← already applied, pending purge          │
  │  relay-bin.000002  ← SQL thread currently reading from here  │
  │  relay-bin.000003  ← I/O thread currently writing here       │
  │  relay-bin.index   ← list of relay log files                 │
  │                                                             │
  │  Automatic purge: after SQL thread finishes applying a       │
  │  relay log file, it is automatically deleted (unless         │
  │  relay_log_purge = OFF).                                     │
  └─────────────────────────────────────────────────────────────┘
```

**>>> On `SHOW REPLICA STATUS`, the two most important fields are:
`Replica_IO_Running` (I/O thread alive and connected) and `Replica_SQL_Running`
(SQL thread alive and applying). If either is `No`, replication is broken.
The `Last_Error` and `Last_IO_Error` fields tell you why.**

---

## 12.6 Multi-Threaded Replication (MTS / Parallel Applier)

### The Single-Thread Bottleneck

In MySQL's original replication design, one SQL thread applies all events
sequentially. The primary can commit 50,000 transactions/sec using 100
concurrent client threads, but the replica applies them one at a time:

```
  PRIMARY (100 threads, 50K TPS):
  T1 ──┐
  T2 ──┤
  T3 ──┤──→ concurrent commit ──→ binlog
  ...  ┤
  T100─┘

  REPLICA (1 SQL thread):
  T1 → T2 → T3 → ... → T100  (serial apply)

  Result: replica falls behind. Replication lag grows continuously.
```

### Multi-Threaded Applier Architecture

```
  ┌──────────────────────────────────────────────────────────────┐
  │  MULTI-THREADED APPLIER (MTS)                                 │
  │                                                              │
  │  Relay Log                                                    │
  │  ┌────────────────────────────────────────┐                   │
  │  │ T1 │ T2 │ T3 │ T4 │ T5 │ T6 │ T7 │...│                   │
  │  └───────────────┬────────────────────────┘                   │
  │                  │                                            │
  │                  ▼                                            │
  │  ┌──────────────────────────────────┐                         │
  │  │  COORDINATOR THREAD              │                         │
  │  │  (formerly "SQL thread")         │                         │
  │  │                                  │                         │
  │  │  Reads events from relay log.    │                         │
  │  │  Assigns each transaction to a   │                         │
  │  │  worker thread based on the      │                         │
  │  │  parallelization policy.         │                         │
  │  └───────┬──────┬──────┬──────┬─────┘                         │
  │          │      │      │      │                                │
  │          ▼      ▼      ▼      ▼                                │
  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                          │
  │  │ W-0  │ │ W-1  │ │ W-2  │ │ W-3  │  ← Worker threads       │
  │  │      │ │      │ │      │ │      │    (replica_parallel_    │
  │  │ T1   │ │ T2   │ │ T3,T5│ │ T4   │     workers = 4)        │
  │  │ T6   │ │ T7   │ │      │ │      │                          │
  │  └──────┘ └──────┘ └──────┘ └──────┘                          │
  │                                                              │
  │  Each worker applies transactions independently.              │
  └──────────────────────────────────────────────────────────────┘
```

Source: `sql/rpl_rli_pdb.cc` (parallel database applier),
`sql/rpl_mta_submode.cc` (MTS submode logic).

### Parallelization Modes

**`replica_parallel_type = DATABASE`** (legacy)

Transactions affecting different databases can be applied in parallel.
Transactions in the same database are serialized.

```
  Relay log:  T1(db=A)  T2(db=B)  T3(db=A)  T4(db=C)  T5(db=B)

  Worker assignment:
  W-0 (db=A): T1 ──────────────────→ T3
  W-1 (db=B): T2 ──────────────────────────→ T5
  W-2 (db=C): ──────────── T4
```

Limitation: if all writes go to a single database (common in microservices),
this mode provides zero parallelism.

**`replica_parallel_type = LOGICAL_CLOCK`** (default in 8.0.27+)

Transactions that committed in the same **binlog group commit** on the primary
can be applied in parallel on the replica. The reasoning: if they committed in
the same group, they were concurrent on the primary and therefore do not
conflict.

```
  Primary timeline:
  ┌─────────────────────────────────────────────────────┐
  │ Group commit #1:  T1, T2, T3  (committed together)  │
  │ Group commit #2:  T4, T5      (committed together)  │
  │ Group commit #3:  T6          (committed alone)      │
  └─────────────────────────────────────────────────────┘

  Each transaction in the binlog carries two timestamps:
    last_committed  = sequence_number of the last group before this one
    sequence_number = this transaction's own sequence number

  Parallel apply rule:
    Transactions with the same last_committed can run in parallel.

  Relay log events:
  T1: last_committed=0, seq=1
  T2: last_committed=0, seq=2     ← T1,T2,T3 can run in parallel
  T3: last_committed=0, seq=3
  T4: last_committed=3, seq=4     ← T4,T5 can run in parallel
  T5: last_committed=3, seq=5        (but must wait for T1-T3 to finish)
  T6: last_committed=5, seq=6     ← T6 must wait for T4,T5
```

Source: `sql/binlog.cc`, `MYSQL_BIN_LOG::write_transaction()` stamps each
transaction with `last_committed` and `sequence_number`.

### WRITESET-Based Parallelism

`binlog_transaction_dependency_tracking = WRITESET` provides even finer-grained
parallelism. Instead of relying on group commit boundaries, MySQL computes the
**write set** --- the set of row keys modified by each transaction --- and allows
parallel apply for transactions with non-overlapping write sets.

```
  Primary timeline:
  ┌──────────────────────────────────────────────────────────────┐
  │ T1: UPDATE users SET name='X' WHERE id=1     writeset={users:1}│
  │ T2: UPDATE users SET name='Y' WHERE id=2     writeset={users:2}│
  │ T3: UPDATE orders SET qty=5 WHERE id=99      writeset={orders:99}│
  │ T4: UPDATE users SET name='Z' WHERE id=1     writeset={users:1}│
  └──────────────────────────────────────────────────────────────┘

  Without WRITESET (LOGICAL_CLOCK only):
    If T1,T2 were in group commit #1 and T3,T4 in group commit #2,
    then T3 and T4 must wait for T1,T2 to finish.

  With WRITESET:
    T1 and T2 have non-overlapping write sets → parallel
    T3 has non-overlapping with T1,T2 → can start immediately
    T4 overlaps with T1 (both touch users:1) → must wait for T1

  Result: T1, T2, T3 all run in parallel. T4 waits only for T1.
```

Configuration:

```sql
-- Enable WRITESET tracking on the primary
SET GLOBAL binlog_transaction_dependency_tracking = 'WRITESET';
SET GLOBAL transaction_write_set_extraction = 'XXHASH64';

-- On the replica
SET GLOBAL replica_parallel_type = 'LOGICAL_CLOCK';
SET GLOBAL replica_parallel_workers = 8;
```

`transaction_write_set_extraction = XXHASH64` controls the hash function used
to compute the write set. XXHASH64 is the fastest and recommended option.

Source: `sql/rpl_write_set_handler.cc`, `add_pke()` --- constructs the write
set for each transaction by hashing (database, table, PK value) tuples.

### Preserving Commit Order

`replica_preserve_commit_order = ON` (default in 8.0.27+) ensures that
transactions commit on the replica in the same order as on the primary, even
though they are applied in parallel.

```
  Without preserve_commit_order:
    T1, T2, T3 run in parallel.
    T3 finishes first → commits first.
    A reader on the replica sees T3 committed but T1 not yet committed.
    This is inconsistent with the primary's history.

  With preserve_commit_order:
    T1, T2, T3 run in parallel (execution is parallel).
    But commits are serialized: T1 commits first, then T2, then T3.
    A reader always sees a consistent prefix of the primary's history.
```

**>>> For interview purposes: `LOGICAL_CLOCK` + `WRITESET` +
`replica_preserve_commit_order = ON` is the optimal configuration for
multi-threaded replication. WRITESET maximizes parallelism by looking at actual
data dependencies rather than timing accidents (group commit boundaries).
Preserve commit order ensures monotonic read consistency on replicas.**

---

## 12.7 Semi-Synchronous Replication

### The Durability Spectrum

```
  ┌───────────────────────────────────────────────────────────────────┐
  │                    REPLICATION DURABILITY SPECTRUM                  │
  │                                                                   │
  │  ASYNC              SEMI-SYNC             GROUP REPLICATION       │
  │  ◄──────────────────────────────────────────────────────────────► │
  │  Fast, lossy        Balanced               Consensus-based        │
  │                                                                   │
  │  Primary does NOT    Primary waits for      Paxos-based. All      │
  │  wait for replica.   at least 1 replica     members must agree.   │
  │  Replica may be      to ACK receiving.      Strongest guarantee.  │
  │  arbitrarily behind. NOT applying.          Highest latency.      │
  │                                                                   │
  │  Data loss on        Data loss only if      Zero data loss        │
  │  failover: YES       primary + ACK'd        (if majority alive).  │
  │  (up to seconds      replica both fail      Can tolerate f        │
  │  of lag)             simultaneously.        failures in 2f+1      │
  │                                             members.              │
  └───────────────────────────────────────────────────────────────────┘
```

### Asynchronous Replication (Default)

The primary writes to its binlog, commits, and returns "OK" to the client.
It does not wait for any replica to receive or apply the event.

```
  Primary                          Replica
  ┌──────────┐                    ┌──────────┐
  │ COMMIT   │                    │          │
  │ write    │                    │          │
  │ binlog   │                    │          │
  │ fsync    │                    │          │
  │ return   │                    │          │
  │ "OK" to  │──── event ────────>│ receive  │
  │ client   │    (async,         │ apply    │
  │          │     may take ms    │          │
  │          │     to seconds)    │          │
  └──────────┘                    └──────────┘

  If primary crashes AFTER returning OK but BEFORE replica receives
  the event → data loss on failover.
```

### Semi-Synchronous Replication

The primary waits for at least one replica to acknowledge receiving the event
before returning "OK" to the client. Note: the replica ACKs **receiving** (writing
to relay log), not **applying** (executing the event). This is why it is
"semi"-synchronous, not fully synchronous.

There are two modes, distinguished by *when* the primary waits:

**`AFTER_SYNC` (lossless semi-sync, default)**

```
  Primary                                 Replica
  ┌──────────────────────────────┐       ┌──────────────────┐
  │ 1. Write binlog event        │       │                  │
  │ 2. fsync binlog              │       │                  │
  │ 3. WAIT for replica ACK      │──────>│ Receive event    │
  │    (blocks here)             │       │ Write to relay   │
  │                              │<──────│ log              │
  │ 4. Receive ACK               │       │ Send ACK         │
  │ 5. Commit in InnoDB          │       │                  │
  │ 6. Return "OK" to client     │       │ (apply later,    │
  │                              │       │  async)          │
  │ Other sessions CANNOT read   │       │                  │
  │ the committed data until     │       │                  │
  │ step 5 completes.            │       │                  │
  └──────────────────────────────┘       └──────────────────┘
```

Key property: the primary waits **after binlog write, before InnoDB commit**.
If the primary crashes at step 3 (waiting), no client has seen the committed
data (because InnoDB hasn't committed yet). The replica has the event. On
failover, the promoted replica has all data that any client has ever seen.

**`AFTER_COMMIT` (traditional semi-sync)**

```
  Primary                                 Replica
  ┌──────────────────────────────┐       ┌──────────────────┐
  │ 1. Write binlog event        │       │                  │
  │ 2. fsync binlog              │       │                  │
  │ 3. Commit in InnoDB          │       │                  │
  │    (data visible to other    │       │                  │
  │     sessions NOW)            │       │                  │
  │ 4. WAIT for replica ACK      │──────>│ Receive event    │
  │    (blocks here)             │       │ Write relay log  │
  │                              │<──────│ Send ACK         │
  │ 5. Receive ACK               │       │                  │
  │ 6. Return "OK" to client     │       │                  │
  └──────────────────────────────┘       └──────────────────┘
```

The critical difference: at step 3, the data is committed in InnoDB and visible
to other sessions. If the primary crashes between step 3 and step 5, a client
on the primary may have already read the committed data --- but the replica may
not have received it. This creates a phantom read problem on failover.

**>>> AFTER_SYNC (lossless) is strictly superior for data safety. Use AFTER_COMMIT
only if you understand and accept the phantom read risk. In practice, always
configure `rpl_semi_sync_source_wait_point = AFTER_SYNC`.**

### Semi-Sync Configuration

```sql
-- On primary
INSTALL PLUGIN rpl_semi_sync_source SONAME 'semisync_source.so';
SET GLOBAL rpl_semi_sync_source_enabled = ON;
SET GLOBAL rpl_semi_sync_source_wait_for_replica_count = 1;
SET GLOBAL rpl_semi_sync_source_timeout = 1000;  -- ms, fallback to async

-- On replica
INSTALL PLUGIN rpl_semi_sync_replica SONAME 'semisync_replica.so';
SET GLOBAL rpl_semi_sync_replica_enabled = ON;
```

| Variable                                       | Default | Description                                        |
|------------------------------------------------|---------|----------------------------------------------------|
| `rpl_semi_sync_source_enabled`                 | OFF     | Enable semi-sync on primary                        |
| `rpl_semi_sync_source_wait_for_replica_count`  | 1       | Number of replicas that must ACK                   |
| `rpl_semi_sync_source_timeout`                 | 10000   | Timeout (ms) before falling back to async          |
| `rpl_semi_sync_source_wait_point`              | AFTER_SYNC | `AFTER_SYNC` or `AFTER_COMMIT`                 |

**Fallback behavior**: if no replica ACKs within `rpl_semi_sync_source_timeout`,
the primary silently reverts to asynchronous mode. The status variable
`Rpl_semi_sync_source_status` shows `ON` or `OFF` (currently active or
fallen back). Transactions committed during the fallback period are at risk of
loss on failover.

**>>> Semi-sync is not a silver bullet. The primary still falls back to async on
timeout, and the replica ACKs receiving, not applying. For true zero-data-loss
guarantees, you need Group Replication (Paxos-based consensus). Semi-sync is
a pragmatic middle ground --- significantly better than pure async, with
~1-2 ms additional latency per transaction in a same-datacenter setup.**

Source: `plugin/semisync/semisync_source.cc`,
`ReplSemiSyncMaster::commitTrx()`.

---

## 12.8 Group Replication (InnoDB Cluster)

### Architecture Overview

Group Replication (GR) is MySQL's built-in consensus-based replication system.
Unlike traditional replication (point-to-point, leader-follower), GR forms a
**group** of servers that use a Paxos-variant protocol (XCom) to agree on a
total order of transactions.

```
  ┌──────────────────────────────────────────────────────────────────┐
  │               GROUP REPLICATION CLUSTER                           │
  │                                                                  │
  │  ┌──────────┐     ┌──────────┐     ┌──────────┐                 │
  │  │ Member-1 │     │ Member-2 │     │ Member-3 │                 │
  │  │ (PRIMARY)│     │(SECONDARY│     │(SECONDARY│                 │
  │  │          │     │  /RO)    │     │  /RO)    │                 │
  │  │ InnoDB   │     │ InnoDB   │     │ InnoDB   │                 │
  │  │ + GR     │     │ + GR     │     │ + GR     │                 │
  │  │ plugin   │     │ plugin   │     │ plugin   │                 │
  │  └────┬─────┘     └────┬─────┘     └────┬─────┘                 │
  │       │                │                │                        │
  │       └───────┬────────┴────────┬───────┘                        │
  │               │                 │                                │
  │       ┌───────┴─────────────────┴───────┐                        │
  │       │       XCom (Group Communication │                        │
  │       │       System)                    │                        │
  │       │                                 │                        │
  │       │  Paxos-based consensus layer    │                        │
  │       │  - Total order of messages      │                        │
  │       │  - Virtual synchrony            │                        │
  │       │  - Failure detection             │                        │
  │       │  - Group membership management  │                        │
  │       └─────────────────────────────────┘                        │
  │                                                                  │
  │  Fault tolerance: 2f+1 members can tolerate f failures.          │
  │  3 members → tolerate 1 failure                                  │
  │  5 members → tolerate 2 failures                                 │
  └──────────────────────────────────────────────────────────────────┘
```

### Transaction Flow in Group Replication

```
  Client                  Member-1 (Primary)         Member-2          Member-3
    │                          │                         │                 │
    │── INSERT INTO t ──────>  │                         │                 │
    │                          │                         │                 │
    │                    1. Execute locally               │                 │
    │                       (optimistic)                 │                 │
    │                       Write to InnoDB              │                 │
    │                       Compute write set            │                 │
    │                          │                         │                 │
    │                    2. At commit time,              │                 │
    │                       broadcast transaction        │                 │
    │                       + write set to group         │                 │
    │                          │                         │                 │
    │                          │── XCom broadcast ──────>│                 │
    │                          │── XCom broadcast ─────────────────────>   │
    │                          │                         │                 │
    │                    3. XCom delivers to ALL          │                 │
    │                       members in TOTAL ORDER       │                 │
    │                          │                         │                 │
    │                    4. CERTIFICATION (on each member):                │
    │                          │                         │                 │
    │                    ┌─────┴─────┐             ┌─────┴─────┐     ┌────┴────┐
    │                    │ Check:    │             │ Check:    │     │ Check:  │
    │                    │ does this │             │ does this │     │ does    │
    │                    │ write set │             │ write set │     │ this ws │
    │                    │ conflict  │             │ conflict  │     │ conflict│
    │                    │ with any  │             │ with any  │     │ with    │
    │                    │ pending   │             │ pending   │     │ pending │
    │                    │ txn?      │             │ txn?      │     │ txn?    │
    │                    └─────┬─────┘             └─────┬─────┘     └────┬────┘
    │                          │                         │                │
    │                    5a. NO conflict:                 │                │
    │                        COMMIT                      APPLY            APPLY
    │                        (InnoDB commit)             (apply from      (apply from
    │                                                    relay log)       relay log)
    │                    5b. CONFLICT:
    │                        ROLLBACK on originator
    │                        Return error to client
    │                          │
    │<── OK (or ERROR) ────────│
    │                          │
```

### Certification --- The Core of Conflict Detection

Certification is the mechanism by which every member independently decides
whether a transaction can be committed. It is deterministic: given the same
inputs, every member reaches the same decision.

```
  ┌──────────────────────────────────────────────────────────────┐
  │  CERTIFICATION PROCESS                                        │
  │                                                              │
  │  Input:                                                       │
  │    - The incoming transaction's WRITE SET                     │
  │      (set of <db, table, PK_hash> modified)                  │
  │    - The CERTIFICATION INFO database                          │
  │      (map of <db, table, PK_hash> → last_committed_version)  │
  │                                                              │
  │  Algorithm:                                                   │
  │    for each key in incoming_write_set:                        │
  │      if certification_info[key].version > txn.snapshot_version:│
  │        // Another transaction modified this row AFTER our     │
  │        // snapshot was taken → CONFLICT                       │
  │        return NEGATIVE (rollback)                             │
  │    return POSITIVE (commit)                                   │
  │                                                              │
  │  This is essentially optimistic concurrency control (OCC)     │
  │  at the cluster level. The "first committer wins" rule.       │
  └──────────────────────────────────────────────────────────────┘
```

Source: `plugin/group_replication/src/certifier.cc`,
`Certifier::certify()`.

### Single-Primary vs Multi-Primary Mode

| Aspect                | Single-Primary (default)                    | Multi-Primary                              |
|-----------------------|---------------------------------------------|--------------------------------------------|
| Write nodes           | 1 (elected primary)                         | All members                                |
| Read nodes            | All members                                 | All members                                |
| Conflict probability  | Zero (only one writer)                      | Non-zero (concurrent writes may conflict)  |
| Failover              | Automatic primary election                  | No election needed (all can write)         |
| Configuration         | `group_replication_single_primary_mode = ON` | `group_replication_single_primary_mode = OFF` |
| Use case              | Most production deployments                 | Multi-region active-active (with care)     |

**Single-primary mode** is recommended because it eliminates certification
conflicts entirely --- only one node writes, so there can be no write-write
conflicts. The primary is elected automatically on failure.

**Multi-primary mode** allows any node to accept writes, but transactions that
modify overlapping rows concurrently will cause certification failures. The
application must be prepared to retry.

### Write Latency in Group Replication

```
  ┌────────────────────────────────────────────────────────────────┐
  │  WRITE LATENCY BREAKDOWN                                       │
  │                                                                │
  │  Local execution:           ~same as standalone MySQL          │
  │  XCom consensus round-trip: ~1-3 ms (same datacenter)          │
  │                             ~50-200 ms (cross-datacenter)      │
  │  Certification:             ~0.1-0.5 ms                        │
  │  InnoDB commit:             ~same as standalone MySQL          │
  │                                                                │
  │  Total overhead vs standalone: 1-5 ms (same DC)                │
  │  This makes GR impractical for cross-datacenter single-cluster │
  │  deployments (use ClusterSet for multi-DC instead).            │
  └────────────────────────────────────────────────────────────────┘
```

### InnoDB Cluster and ClusterSet

```
  InnoDB Cluster (single datacenter):
  ┌──────────────────────────────────────────────┐
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
  │  │  GR      │  │  GR      │  │  GR      │  │
  │  │ Member-1 │  │ Member-2 │  │ Member-3 │  │
  │  │(PRIMARY) │  │(SECONDARY│  │(SECONDARY│  │
  │  └──────────┘  └──────────┘  └──────────┘  │
  │        ▲                                    │
  │        │  MySQL Router (connection routing) │
  │        │  - R/W to primary                  │
  │        │  - R/O to secondaries              │
  │                                             │
  │  Managed by MySQL Shell (AdminAPI)          │
  └──────────────────────────────────────────────┘

  InnoDB Cluster = Group Replication + MySQL Router + MySQL Shell
```

```
  InnoDB ClusterSet (multi-datacenter):
  ┌────────────────────┐            ┌────────────────────┐
  │  Primary Cluster   │            │  DR Cluster        │
  │  (Datacenter A)    │            │  (Datacenter B)    │
  │                    │            │                    │
  │  ┌────┐ ┌────┐    │   async    │  ┌────┐ ┌────┐    │
  │  │ P  │ │ S  │    │──repl────> │  │ P  │ │ S  │    │
  │  └────┘ └────┘    │            │  └────┘ └────┘    │
  │  ┌────┐            │            │  ┌────┐            │
  │  │ S  │            │            │  │ S  │            │
  │  └────┘            │            │  └────┘            │
  └────────────────────┘            └────────────────────┘

  Within each cluster: synchronous (Paxos)
  Between clusters: asynchronous replication
  Failover: promote DR cluster to primary cluster
```

**>>> Group Replication is MySQL's answer to Galera (MariaDB/Percona) and
PostgreSQL's Patroni. The key difference: GR uses a Paxos-variant (XCom) for
true consensus, while Galera uses a certification-based approach built on
virtual synchrony (Spread/GComm). Both achieve similar results, but GR is
the MySQL-native solution and the foundation of InnoDB Cluster. In interviews,
emphasize that GR provides automatic failover, conflict detection via
write-set certification, and zero data loss within a single cluster.**

---

## 12.9 Replication Lag

### What Is Replication Lag

Replication lag is the time delta between a transaction being committed on the
primary and the same transaction being applied (committed) on the replica. In
async replication, lag is unavoidable under load.

```
  Primary timeline:  T1─────T2─────T3─────T4─────T5──────── now
                                                              │
  Replica timeline:  T1─────T2─────T3──────────────────────── now
                                    ▲                         ▲
                                    │                         │
                              replica is HERE         primary is HERE

  Replication lag = time(primary T5 commit) - time(replica last applied T3)
```

### Measuring Lag

**`Seconds_Behind_Source`** (from `SHOW REPLICA STATUS`):

This field measures the difference between the timestamp in the relay log event
currently being applied and the current wall-clock time. It is notoriously
inaccurate:

```
  Problems with Seconds_Behind_Source:
  ┌──────────────────────────────────────────────────────────┐
  │ 1. Clock skew: primary and replica clocks may differ.    │
  │    SBS uses the event's timestamp (from primary's clock) │
  │    minus the replica's current time.                      │
  │                                                          │
  │ 2. Long-running transactions: a 10-minute ALTER TABLE    │
  │    on the primary generates one event with a timestamp   │
  │    from when it STARTED. While the replica applies it     │
  │    (another 10 minutes), SBS shows 10+ minutes even      │
  │    though the replica isn't truly "behind."               │
  │                                                          │
  │ 3. Idle primary: if the primary has no writes, SBS       │
  │    stays at 0 even if the replica's SQL thread is         │
  │    stopped. SBS = 0 does NOT mean "in sync."              │
  │                                                          │
  │ 4. Multi-threaded applier: SBS is based on the           │
  │    event being processed, not the oldest unapplied event. │
  │    With MTS, multiple events process in parallel, and    │
  │    SBS may underestimate true lag.                       │
  └──────────────────────────────────────────────────────────┘
```

**Better alternatives**:

1. **Heartbeat-based** (`SOURCE_HEARTBEAT_PERIOD`): the primary sends periodic
   heartbeat events. The replica can measure how recently it received one.

2. **pt-heartbeat** (Percona Toolkit): inserts a row with `NOW()` on the
   primary every second. A daemon on the replica reads this row and computes
   the difference. This is the industry standard for accurate lag measurement.

   ```sql
   -- Primary: pt-heartbeat writes
   UPDATE percona.heartbeat SET ts = NOW() WHERE id = 1;

   -- Replica: pt-heartbeat reads
   SELECT NOW() - ts AS lag_seconds FROM percona.heartbeat WHERE id = 1;
   ```

3. **Performance Schema** (8.0.27+):
   ```sql
   SELECT * FROM performance_schema.replication_applier_status_by_worker;
   -- APPLYING_TRANSACTION_ORIGINAL_COMMIT_TIMESTAMP
   -- APPLYING_TRANSACTION_START_APPLY_TIMESTAMP
   ```

### Common Causes of Replication Lag

| Cause                          | Mechanism                                              | Mitigation                                           |
|--------------------------------|--------------------------------------------------------|------------------------------------------------------|
| Single-threaded applier        | SQL thread applies serially                            | Enable MTS (`replica_parallel_workers`)              |
| Large transactions             | Bulk UPDATE/DELETE of millions of rows                 | Chunk operations into batches (1000 rows per txn)    |
| DDL on replica                 | ALTER TABLE blocks all other applies                   | Use pt-online-schema-change or gh-ost                |
| Unindexed row lookups          | ROW format: replica finds rows by PK. No PK? Table scan | Always define a PRIMARY KEY                         |
| Network latency                | I/O thread slow to receive events                      | Co-locate in same datacenter / availability zone     |
| Slow disk on replica           | Relay log writes and InnoDB applies limited by I/O     | SSD, faster storage subsystem                        |
| Lock contention on replica     | Long-running queries on replica block SQL thread       | Set `innodb_lock_wait_timeout` on replica, kill queries |
| Binlog event too large         | Single event exceeds `replica_max_allowed_packet`      | Increase `replica_max_allowed_packet`, avoid huge txns |

**>>> The single most important mitigation for replication lag is multi-threaded
apply with WRITESET dependency tracking. The second most important is avoiding
large transactions. A single `DELETE FROM logs WHERE created < '2020-01-01'`
that deletes 10 million rows creates one enormous transaction in the binlog.
The replica must apply all 10 million row deletions in a single operation,
blocking all other applies. Always chunk: `DELETE ... LIMIT 1000` in a loop.**

### Impact of Replication Lag

```
  ┌──────────────────────────────────────────────────────────────┐
  │  STALE READS                                                  │
  │  Application writes to primary, reads from replica.           │
  │  If replica is 2 seconds behind:                              │
  │    - User creates order (writes to primary)                   │
  │    - User immediately views orders (reads from replica)       │
  │    - Order is missing → user confusion, support tickets       │
  │                                                              │
  │  Mitigations:                                                 │
  │    1. Read-your-writes: route reads to primary for N seconds  │
  │       after a write (application-level or ProxySQL rules)     │
  │    2. Causal consistency: pass GTID from write response,      │
  │       wait for replica to apply that GTID before reading      │
  │       (WAIT_FOR_EXECUTED_GTID_SET function)                   │
  │    3. Accept eventual consistency for non-critical reads      │
  └──────────────────────────────────────────────────────────────┘
```

```sql
-- Causal read on replica (8.0):
-- After writing on primary, capture the GTID:
SELECT @@gtid_executed;  -- returns 'uuid:1-157'

-- On replica, wait until this GTID is applied:
SELECT WAIT_FOR_EXECUTED_GTID_SET('uuid:1-157', 5);
-- Returns 0 = success, 1 = timeout after 5 seconds

-- Now read --- guaranteed to see the write:
SELECT * FROM orders WHERE user_id = 42;
```

---

## 12.10 Crash-Safe Replication

### The Problem

A replica crash mid-apply creates an inconsistency question: which events have
been applied, and which need to be re-applied?

```
  Relay log events:  E1 ✓  E2 ✓  E3 ✓  E4 ?  E5  E6
                                         ▲
                                    CRASH HERE

  Was E4 applied?
  - If partially applied (half the rows committed), we have a corrupt state.
  - If the position file says "applied up to E3" but E4 was actually committed
    in InnoDB, re-applying E4 would duplicate the operation.
```

### Legacy Approach (Fragile)

In MySQL 5.5 and earlier, the replica stored its position in two files:

```
  master.info        ← stores primary connection info + binlog position
  relay-log.info     ← stores relay log file + position (last applied event)

  These are plain text files, updated by simple write+sync.
  The problem: the relay-log.info update and the InnoDB transaction commit
  are NOT atomic. If the replica crashes between the InnoDB commit and the
  relay-log.info update, the position file is stale.
```

### Crash-Safe Approach (MySQL 8.0 Default)

```
  ┌──────────────────────────────────────────────────────────────┐
  │  CRASH-SAFE REPLICATION CONFIGURATION                         │
  │                                                              │
  │  relay_log_info_repository = TABLE  (default in 8.0)         │
  │  ┌────────────────────────────────────────────────────┐      │
  │  │ mysql.slave_relay_log_info (InnoDB table)           │      │
  │  │                                                    │      │
  │  │ The replica stores its apply position in this       │      │
  │  │ table. The position update is part of the SAME      │      │
  │  │ InnoDB transaction as the applied event.            │      │
  │  │                                                    │      │
  │  │ BEGIN;                                              │      │
  │  │   -- apply the binlog event (DML)                   │      │
  │  │   UPDATE slave_relay_log_info SET position = ...;   │      │
  │  │ COMMIT;                                             │      │
  │  │                                                    │      │
  │  │ Atomicity guaranteed: either both the event and     │      │
  │  │ the position update are committed, or neither is.   │      │
  │  └────────────────────────────────────────────────────┘      │
  │                                                              │
  │  relay_log_recovery = ON                                      │
  │  ┌────────────────────────────────────────────────────┐      │
  │  │ On restart after crash:                             │      │
  │  │ 1. Discard all relay log files (may be incomplete)  │      │
  │  │ 2. Read last applied position from InnoDB table     │      │
  │  │ 3. Re-fetch events from primary starting at that    │      │
  │  │    position (using GTID auto-positioning)           │      │
  │  └────────────────────────────────────────────────────┘      │
  └──────────────────────────────────────────────────────────────┘
```

Source: `sql/rpl_rli.cc`, `Relay_log_info::commit_positions()` --- updates
the position table within the same transaction.

### GTID Makes Crash Recovery Simpler

With GTIDs, the replica's `gtid_executed` set is persisted in the InnoDB table
`mysql.gtid_executed`. On crash recovery:

```
  1. Read gtid_executed from mysql.gtid_executed table
  2. Connect to primary with GTID auto-positioning
  3. Primary sends: gtid_executed(primary) - gtid_executed(replica)
  4. Replay begins from exactly the right point

  No need to calculate binlog file/offset.
  No need to inspect relay logs (they may be corrupt from the crash).
```

**>>> Crash-safe replication in MySQL 8.0 is essentially automatic when you use
GTIDs + TABLE-based info repositories (both defaults). The key insight for
interviews: the position update and the data change are in the same InnoDB
transaction, providing atomicity. Combined with GTID auto-positioning and
relay_log_recovery = ON, the replica can always reconstruct the correct state
after a crash without manual intervention.**

Configuration summary for crash-safe replication:

```sql
-- All defaults in MySQL 8.0, but verify:
[mysqld]
gtid_mode                    = ON
enforce_gtid_consistency     = ON
relay_log_info_repository    = TABLE   -- default in 8.0
relay_log_recovery           = ON
replica_preserve_commit_order = ON
```

---

## 12.11 Binary Log and CDC (Change Data Capture)

### CDC Architecture

Change Data Capture reads the MySQL binlog as a real-time change stream and
emits events to downstream systems (Kafka, data warehouses, search indices).
The binlog effectively becomes a **database changelog API**.

```
  ┌───────────┐     ┌──────────────┐     ┌───────────────────────┐
  │  MySQL    │     │  CDC Tool     │     │  Downstream Systems   │
  │  Primary  │     │              │     │                       │
  │           │     │  ┌────────┐  │     │  ┌───────────────┐    │
  │  binlog  ──────>│  │Debezium│──────>│  │ Kafka         │    │
  │  (ROW     │     │  │Maxwell │  │     │  │ Elasticsearch │    │
  │   format) │     │  │Canal   │  │     │  │ Data Lake     │    │
  │           │     │  └────────┘  │     │  │ Redis         │    │
  │           │     │              │     │  └───────────────┘    │
  └───────────┘     └──────────────┘     └───────────────────────┘

  The CDC tool acts like a replica:
  - Connects to primary's binlog dump thread
  - Receives binlog events over MySQL replication protocol
  - Parses ROW events into structured change records
  - Emits change records to downstream systems
```

### CDC Tools Compared

| Tool                | Author   | Output               | Key Feature                        |
|---------------------|----------|----------------------|------------------------------------|
| **Debezium**        | Red Hat  | Kafka Connect        | Full CDC platform, schema registry, snapshot capability |
| **Maxwell**         | Zendesk  | Kafka/Kinesis/stdout | Lightweight, simple JSON output    |
| **Canal**           | Alibaba  | Custom/Kafka/RocketMQ| High performance, widely used in China |
| **mysql-binlog-connector-java** | OSS | Java library | Embed binlog parsing in your Java app |

### Debezium Deep Dive

Debezium is the most widely adopted MySQL CDC tool. It runs as a Kafka Connect
source connector and emits one Kafka message per binlog row event:

```
  Debezium output for UPDATE users SET email='x' WHERE id=42:

  Key:   {"id": 42}
  Value: {
    "before": {"id": 42, "name": "Deepak", "email": "old@x.com"},
    "after":  {"id": 42, "name": "Deepak", "email": "x"},
    "source": {
      "version": "2.5.0",
      "connector": "mysql",
      "name": "prod-mysql",
      "server_id": 1,
      "ts_ms": 1706234567000,
      "gtid": "3E11FA47-...:157",
      "file": "binlog.000003",
      "pos": 1200,
      "db": "myapp",
      "table": "users"
    },
    "op": "u",           // c=create, u=update, d=delete, r=read(snapshot)
    "ts_ms": 1706234567500
  }
```

### Binlog Requirements for CDC

| Setting                         | Required Value     | Reason                                           |
|---------------------------------|--------------------|--------------------------------------------------|
| `binlog_format`                 | `ROW`              | CDC needs row data, not SQL text                 |
| `binlog_row_image`              | `FULL` (preferred) | Full before/after images for complete change record |
| `binlog_expire_logs_seconds`    | Adequate retention | CDC tool must not fall behind retention window    |
| `gtid_mode`                     | `ON` (recommended) | Reliable positioning after connector restart     |
| `log_slave_updates`             | `ON` (if reading from replica) | Replica must write applied events to its own binlog |

**`binlog_expire_logs_seconds`** (default: 2592000 = 30 days):

```
  If your CDC tool is down for 2 days and your binlog retention is 1 day:
    The CDC tool has missed events. It cannot catch up.
    It must perform a full re-snapshot of the affected tables.

  Rule of thumb: set binlog retention to at least 3x your maximum expected
  CDC downtime. If the CDC tool might be down for 1 day (maintenance,
  Kafka outage), set retention to at least 3 days.
```

### CDC Considerations

**Schema evolution**: when you `ALTER TABLE` to add/remove/rename columns, the
CDC tool must handle the schema change. Debezium detects DDL events in the binlog
and updates its in-memory schema model. The downstream consumer must also handle
schema changes (Kafka Schema Registry + Avro helps).

**Handling DDL events**: DDL statements (`ALTER TABLE`, `CREATE INDEX`, etc.)
appear as `QUERY_EVENT` in the binlog, even in ROW mode. CDC tools must parse
these to maintain their schema cache.

**Initial snapshot**: when a CDC tool first starts, it must capture the current
state of all tables (not just future changes). Debezium performs a consistent
snapshot using `START TRANSACTION WITH CONSISTENT SNAPSHOT` + table scan, then
switches to binlog streaming.

```
  Debezium startup sequence:
  ┌──────────────────────────────────────────────────────────────┐
  │ 1. Connect to MySQL, acquire global read lock (brief)        │
  │ 2. Read current binlog position / GTID                       │
  │ 3. Read table schemas (SHOW CREATE TABLE)                    │
  │ 4. Release global lock                                       │
  │ 5. START TRANSACTION WITH CONSISTENT SNAPSHOT                │
  │ 6. Scan all tables, emit snapshot events (op=r)              │
  │ 7. COMMIT snapshot transaction                               │
  │ 8. Switch to binlog streaming from step 2's position         │
  │                                                              │
  │ Result: zero data loss, no duplicates (exactly-once semantics│
  │ for the initial load, at-least-once for ongoing streaming)   │
  └──────────────────────────────────────────────────────────────┘
```

**>>> CDC on MySQL's binlog is the foundation of event-driven architectures
at scale. Uber, LinkedIn, Netflix, and Airbnb all use binlog-based CDC to
propagate database changes to Kafka. The critical configuration trifecta:
ROW format + FULL binlog_row_image + GTID mode ON. For Java engineers:
Debezium is the de facto standard --- it runs as a Kafka Connect connector
and handles schema evolution, snapshot, and exactly-once delivery.**

Source: Debezium source code (github.com/debezium/debezium),
`io.debezium.connector.mysql.MySqlStreamingChangeEventSource`.

---

## 12.12 Putting It All Together --- A Byte's Journey

Let us trace the complete path of a single committed row change from primary to
replica, hitting every component discussed in this chapter:

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │  THE FULL JOURNEY OF A WRITE                                         │
  │                                                                      │
  │  PRIMARY:                                                            │
  │  ~~~~~~~~                                                            │
  │  1. Client thread executes: UPDATE users SET email='x' WHERE id=42   │
  │     └─> InnoDB modifies row in buffer pool (in-memory)               │
  │     └─> InnoDB writes redo log record (WAL)                          │
  │     └─> InnoDB writes undo log record (for MVCC)                     │
  │                                                                      │
  │  2. At COMMIT:                                                       │
  │     └─> XA PREPARE: InnoDB writes PREPARE to redo log                │
  │     └─> Binlog group commit FLUSH stage:                             │
  │         - Thread joins commit queue                                  │
  │         - Leader writes binlog events:                               │
  │           [GTID_EVENT][QUERY("BEGIN")][TABLE_MAP][UPDATE_ROWS][XID]  │
  │     └─> Binlog group commit SYNC stage:                              │
  │         - Leader calls fsync() on binlog file                        │
  │     └─> (Semi-sync: wait for replica ACK if AFTER_SYNC)              │
  │     └─> Binlog group commit COMMIT stage:                            │
  │         - InnoDB commit (marks redo PREPARE as committed)            │
  │     └─> Return "OK" to client                                        │
  │                                                                      │
  │  3. Binlog dump thread:                                              │
  │     └─> Wakes on binlog condvar                                      │
  │     └─> Reads new events from binlog file                            │
  │     └─> Sends events over TCP to replica's I/O thread                │
  │                                                                      │
  │  REPLICA:                                                            │
  │  ~~~~~~~~                                                            │
  │  4. I/O thread:                                                      │
  │     └─> Receives events over TCP                                     │
  │     └─> Writes events to relay log file                              │
  │     └─> (Semi-sync: sends ACK back to primary)                       │
  │                                                                      │
  │  5. SQL coordinator thread (MTS):                                    │
  │     └─> Reads events from relay log                                  │
  │     └─> Checks WRITESET dependencies                                 │
  │     └─> Assigns transaction to a worker thread                       │
  │                                                                      │
  │  6. Worker thread:                                                   │
  │     └─> Reads UPDATE_ROWS_EVENT                                      │
  │     └─> Finds row id=42 in InnoDB (by PK lookup)                     │
  │     └─> Applies the row change                                       │
  │     └─> Updates slave_relay_log_info position (same InnoDB txn)      │
  │     └─> COMMIT                                                       │
  │                                                                      │
  │  7. gtid_executed on replica updated: uuid:1-157                     │
  │                                                                      │
  │  Total latency (same datacenter):                                    │
  │    Async:    1-100 ms (depends on load and applier speed)            │
  │    Semi-sync: 1-5 ms (consensus round-trip)                          │
  │    Group Rep: 2-10 ms (Paxos round-trip + certification)             │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## 12.13 Production Configuration Reference

### Recommended Replication Configuration (MySQL 8.0.27+)

```ini
# ── Primary Configuration ──────────────────────────────────
[mysqld]
server_id                        = 1
log_bin                          = binlog
binlog_format                    = ROW
binlog_row_image                 = FULL
sync_binlog                      = 1
innodb_flush_log_at_trx_commit   = 1

# GTID
gtid_mode                        = ON
enforce_gtid_consistency         = ON

# Group commit tuning
binlog_group_commit_sync_delay   = 1000     # μs, tune based on workload
binlog_group_commit_sync_no_delay_count = 20

# WRITESET dependency tracking (improves replica parallelism)
binlog_transaction_dependency_tracking = WRITESET
transaction_write_set_extraction       = XXHASH64

# Binlog retention
binlog_expire_logs_seconds       = 604800   # 7 days

# Semi-sync (if using)
# plugin_load = "rpl_semi_sync_source=semisync_source.so"
# rpl_semi_sync_source_enabled   = ON
# rpl_semi_sync_source_wait_point = AFTER_SYNC
# rpl_semi_sync_source_timeout   = 1000
```

```ini
# ── Replica Configuration ──────────────────────────────────
[mysqld]
server_id                        = 2
log_bin                          = binlog      # needed if replica is also a source
relay_log                        = relay-bin
log_replica_updates              = ON          # write applied events to own binlog

# GTID
gtid_mode                        = ON
enforce_gtid_consistency         = ON

# Crash-safe replication
relay_log_info_repository        = TABLE       # default in 8.0
relay_log_recovery               = ON

# Multi-threaded applier
replica_parallel_workers         = 8           # tune based on cores
replica_parallel_type            = LOGICAL_CLOCK
replica_preserve_commit_order    = ON

# Semi-sync (if using)
# plugin_load = "rpl_semi_sync_replica=semisync_replica.so"
# rpl_semi_sync_replica_enabled  = ON
```

### Key Monitoring Queries

```sql
-- Replication status overview
SHOW REPLICA STATUS\G

-- Key fields to monitor:
-- Replica_IO_Running:  Yes
-- Replica_SQL_Running: Yes
-- Seconds_Behind_Source: 0
-- Last_Errno: 0
-- Retrieved_Gtid_Set: uuid:1-157
-- Executed_Gtid_Set:  uuid:1-157

-- Performance Schema replication tables (8.0)
SELECT * FROM performance_schema.replication_connection_status;
SELECT * FROM performance_schema.replication_applier_status;
SELECT * FROM performance_schema.replication_applier_status_by_coordinator;
SELECT * FROM performance_schema.replication_applier_status_by_worker;

-- GTID gap detection
SELECT @@gtid_executed;
SELECT @@gtid_purged;

-- Binlog disk usage
SHOW BINARY LOGS;
SELECT SUM(file_size) / 1024 / 1024 AS binlog_mb FROM performance_schema.binary_log_status;
```

---

## 12.14 Interview Question Bank

**Q: What is the difference between the binlog and the redo log?**
The binlog is a server-layer logical log recording all data-modifying events for
replication and PITR. The redo log is an InnoDB-internal physical log recording
page-level changes for crash recovery. They are coordinated via internal
two-phase commit (XA), where the binlog write is the true commit point.

**Q: Why is ROW format preferred over STATEMENT format?**
ROW format logs exact row images (before/after), making replication deterministic
regardless of the SQL used. STATEMENT format logs SQL text, which can produce
different results on the replica for non-deterministic functions (UUID, RAND,
NOW, LIMIT without ORDER BY). ROW format is also required by CDC tools.

**Q: How does group commit improve performance?**
Group commit batches multiple transactions' binlog writes into a single fsync()
call via a three-stage pipeline (FLUSH, SYNC, COMMIT). Instead of N fsyncs for
N concurrent transactions, only one fsync is performed for the entire group,
amortizing the I/O cost.

**Q: What problem do GTIDs solve?**
GTIDs eliminate manual binlog file/offset tracking during failover. Each
transaction has a globally unique ID. Replicas use auto-positioning: they tell
the new primary their gtid_executed set, and the primary sends only the missing
transactions. No offset calculation needed.

**Q: Explain semi-synchronous replication. What does "semi" mean?**
Semi-sync means the primary waits for at least one replica to acknowledge
*receiving* the event (writing to relay log), but does NOT wait for the replica
to *apply* it. AFTER_SYNC mode waits before InnoDB commit (lossless). AFTER_COMMIT
waits after (phantom read risk). The "semi" refers to the fact that receiving
is not applying --- there is still a window where the replica has the event in
its relay log but has not yet executed it.

**Q: How does multi-threaded replication work?**
A coordinator thread reads relay log events and distributes them to worker
threads. LOGICAL_CLOCK mode allows transactions from the same group commit to
run in parallel. WRITESET mode allows transactions with non-overlapping write
sets to run in parallel regardless of group commit boundaries, providing the
highest parallelism.

**Q: What makes replication crash-safe in MySQL 8.0?**
Three mechanisms: (1) relay_log_info_repository = TABLE stores the apply
position in an InnoDB table, updated atomically with the applied event.
(2) relay_log_recovery = ON discards relay logs on restart and re-fetches
from primary. (3) GTID auto-positioning ensures the replica requests exactly
the events it is missing, without relying on potentially corrupt relay logs.

**Q: How does Group Replication differ from traditional async replication?**
Group Replication uses Paxos-based consensus (XCom) for total ordering and
conflict detection via write-set certification. Traditional replication is
point-to-point with no conflict detection. GR provides automatic failover,
zero data loss (within the group), and multi-primary capability. The tradeoff
is write latency (1-5 ms consensus overhead in same datacenter).

**Q: How would you set up MySQL CDC to Kafka?**
Use Debezium as a Kafka Connect source connector. Configure MySQL with ROW
binlog format, FULL binlog_row_image, GTID mode ON. Debezium connects as a
replication client, reads binlog events, performs an initial snapshot of all
tables, then streams ongoing changes as Kafka messages with before/after row
images plus metadata (GTID, source position, timestamp).

---

## Summary

```
  ┌────────────────────────────────────────────────────────────────┐
  │  CHAPTER 12 KEY CONCEPTS                                       │
  │                                                                │
  │  Binlog:      Server-layer logical log. ROW format. Group      │
  │               commit for performance. XA with redo log.        │
  │                                                                │
  │  GTID:        Globally unique transaction ID. Auto-positioning.│
  │               Enables trivial failover.                        │
  │                                                                │
  │  Threads:     Dump thread (primary) → I/O thread (replica) →   │
  │               SQL/coordinator thread → worker threads.         │
  │                                                                │
  │  MTS:         Parallel apply. LOGICAL_CLOCK + WRITESET for     │
  │               maximum parallelism. Preserve commit order.      │
  │                                                                │
  │  Semi-sync:   Primary waits for ACK. AFTER_SYNC = lossless.   │
  │               Falls back to async on timeout.                  │
  │                                                                │
  │  Group Rep:   Paxos consensus. Certification. Auto-failover.  │
  │               InnoDB Cluster = GR + Router + Shell.            │
  │                                                                │
  │  Crash-safe:  TABLE repository + relay_log_recovery + GTID.   │
  │                                                                │
  │  CDC:         Binlog = change stream. Debezium/Maxwell/Canal.  │
  │               ROW + FULL + GTID = production CDC config.       │
  └────────────────────────────────────────────────────────────────┘
```

The binary log is arguably MySQL's most important architectural feature after
the storage engine itself. It transforms a single-server database into a
distributed data platform. Every replica, every failover operation, every CDC
pipeline, every point-in-time recovery --- they all flow through the binlog.
Understanding its internals, from event format to group commit to GTID lifecycle,
is what separates an engineer who *uses* MySQL from one who *understands* it.

---

*Next: Chapter 13 — Schema Design for Scale. How do data type choices ripple
through B+Trees, buffer pool, and replication?*
