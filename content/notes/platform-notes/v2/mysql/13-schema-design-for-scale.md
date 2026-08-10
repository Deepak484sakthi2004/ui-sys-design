# Chapter 13: Schema Design for Scale

## How Data Type Choices Ripple Through B+Trees, Buffer Pool, and Replication

---

This is the first chapter of Part 2. Everything in Part 1 was about how MySQL
works internally — B+Trees, buffer pool eviction, MVCC versioning, redo log
flushing, lock escalation. Part 2 asks: given that you understand the engine,
how do you design schemas, indexes, and operations that work *with* the engine
rather than against it?

Schema design is the highest-leverage activity in database engineering. A poor
data type choice made on day one compounds through every B+Tree node, every
buffer pool page, every binlog event, every replica, for the lifetime of the
table. This chapter treats schema design as a systems engineering problem:
every decision has a storage cost, an I/O cost, a replication cost, and a
locking cost. We quantify all of them.

---

## 13.1 Data Type Selection — Every Byte Matters at Scale

A table with 1 billion rows and 5 secondary indexes: saving 4 bytes per row
saves 4 GB in the clustered index and 20 GB across secondary indexes. That is
24 GB less buffer pool pressure, 24 GB less replication traffic, 24 GB less
backup time. Data type selection is not about aesthetics — it is about I/O
budgets.

### 13.1.1 Comprehensive Data Type Reference

| Type | Storage | Range | InnoDB Notes |
|------|---------|-------|--------------|
| TINYINT | 1 B | -128 to 127 (signed) / 0 to 255 (unsigned) | Booleans, status flags, small enumerations |
| SMALLINT | 2 B | -32,768 to 32,767 | Rarely used in practice; consider when INT is wasteful |
| MEDIUMINT | 3 B | -8,388,608 to 8,388,607 | Underused — saves 1 B vs INT per row. For user_age, quantity, etc. |
| INT | 4 B | -2,147,483,648 to 2,147,483,647 | Default integer choice for most columns |
| BIGINT | 8 B | -9.2 x 10^18 to 9.2 x 10^18 | Primary keys at scale, epoch timestamps in milliseconds |
| FLOAT | 4 B | ~7 decimal digits precision | Approximate. Never use for money. IEEE 754 rounding |
| DOUBLE | 8 B | ~15 decimal digits precision | Scientific/statistical. Still approximate |
| DECIMAL(M,D) | ~4 B per 9 digits | Exact decimal | Financial data. DECIMAL(10,2) = 5 B. Arithmetic in software, slower than INT |
| DATE | 3 B | 1000-01-01 to 9999-12-31 | Date only, no time component |
| DATETIME | 5 B (MySQL 8.0) | 1000-01-01 00:00:00 to 9999-12-31 23:59:59 | No timezone conversion. Stored as-is. Was 8 B in 5.5 |
| TIMESTAMP | 4 B | 1970-01-01 00:00:01 to 2038-01-19 03:14:07 | Stored as UTC epoch seconds, converted on read per session tz |
| CHAR(N) | N x char_width | Fixed length | Padded with 0x20 (space). N x 1 for latin1, N x 4 for utf8mb4 max |
| VARCHAR(N) | 1-2 B prefix + data | Variable length | 1 B length prefix if N <= 255, 2 B if N > 255. Most common string type |
| TINYTEXT | 1 B prefix + data | Max 255 B | Prefer VARCHAR(255) — equivalent but VARCHAR can be indexed fully |
| TEXT | 2 B prefix + data | Max 64 KB | Stored off-page (DYNAMIC format) if large. Cannot have default value |
| MEDIUMTEXT | 3 B prefix + data | Max 16 MB | Same off-page behavior. Avoid unless truly needed |
| LONGTEXT | 4 B prefix + data | Max 4 GB | Rarely needed in OLTP tables |
| BLOB variants | Same as TEXT | Same sizes | Binary, no character set. Same off-page storage rules |
| JSON | Binary format | Max ~1 GB | Parsed at write, stored as binary doc. Partial updates in 8.0.3+ |
| ENUM | 1-2 B | Up to 65,535 values | Stored as integer internally. 1 B if <= 255 values, 2 B otherwise |
| SET | 1-8 B | Up to 64 members | Bitmask storage. Rarely used in modern schemas |

### 13.1.2 How Data Types Affect B+Tree Height

Recall from Chapter 5: an InnoDB B+Tree page is 16 KB. The number of rows that
fit on a leaf page is determined by row size. The number of records per page
directly controls tree height, and tree height controls I/O per lookup.

```
  Scenario: 100 million rows, INT PK (4 B) vs BIGINT PK (8 B)
  Assume average row size = 200 B with INT, 204 B with BIGINT
  (Row overhead: ~20 B per row for trx_id, roll_ptr, null bitmap, field offsets)

  Rows per leaf page (16 KB usable ~ 15 KB after page header/trailer):
    INT PK:    15,000 / 200 = ~75 rows/page
    BIGINT PK: 15,000 / 204 = ~73 rows/page       ← minimal difference in leaf

  BUT — internal (non-leaf) pages store (key, child_ptr) pairs:
    INT PK:    15,000 / (4 + 6) = 1,500 pointers/page
    BIGINT PK: 15,000 / (8 + 6) = 1,071 pointers/page

  Tree height for 100M rows:
    INT PK:    Level 0: 1,500 * 1,500 = 2.25M → need 3 levels
               Root(1) → 67 internal pages → 1,333,333 leaf pages
    BIGINT PK: Level 0: 1,071 * 1,071 = 1.14M → need 3 levels
               Root(1) → 94 internal pages → 1,369,863 leaf pages

  At 1 billion rows, BIGINT needs 4 levels while INT still fits in 3.
  Each extra level = 1 additional random I/O per point lookup.
```

**>>> The PK data type affects B+Tree fanout. At billions of rows, the difference
between a 4-byte and 16-byte PK can add an extra tree level — that is one
additional disk read on every single point query. This is why PK size is not a
micro-optimization; it is an architectural decision.**

### 13.1.3 BIGINT for Primary Keys — Why INT Is Not Enough

INT UNSIGNED maxes out at 4,294,967,295 (~4.3 billion). That sounds like
plenty, but consider:

- **Auto-increment gaps**: InnoDB reserves blocks of auto-increment values
  (`innodb_autoinc_lock_mode = 2` in 8.0 default). Bulk inserts, rollbacks,
  and server restarts all create gaps. A table with 500M logical rows might
  have consumed 2B of ID space.

- **Soft deletes**: rows are marked deleted but not physically removed. The
  auto-increment counter never resets. A table that churns 10M rows/day
  through a soft-delete pattern consumes IDs at the insert rate, not the
  net-growth rate.

- **Sharding ranges**: if you pre-allocate ID ranges per shard (e.g., shard 0
  gets 1-1B, shard 1 gets 1B-2B), INT gives you only 4 shards. BIGINT gives
  you effectively unlimited range partitioning.

- **Table rebuilds**: `ALTER TABLE ... ENGINE=InnoDB` (table optimization) does
  not reset auto-increment. The counter only grows.

**Rule**: use BIGINT UNSIGNED for every primary key in any table that might
exceed a few million rows. The 4-byte cost per row is trivial insurance against
a catastrophic ID exhaustion that requires a full table rebuild to fix.

### 13.1.4 TIMESTAMP vs DATETIME

| Aspect | TIMESTAMP | DATETIME |
|--------|-----------|----------|
| Storage | 4 bytes | 5 bytes (8.0), was 8 bytes (5.5) |
| Range | 1970-01-01 to 2038-01-19 | 1000-01-01 to 9999-12-31 |
| Timezone | Stored as UTC epoch, converted to session tz on read | Stored as-is, no conversion |
| NULL default | `DEFAULT CURRENT_TIMESTAMP` implicit in some modes | Must be explicit |
| Fractional seconds | +0 to 3 bytes (0-6 digits) | +0 to 3 bytes (0-6 digits) |
| 2038 problem | Yes — wraps or errors after 2038-01-19 03:14:07 UTC | No |
| Index size | 4 bytes (smaller) | 5 bytes |

**The 2038 problem is real**: any TIMESTAMP column in a table that will exist
past January 2038 must be migrated to DATETIME. MySQL 8.0 does not solve this —
TIMESTAMP is still a 32-bit unsigned epoch. Migration of a billion-row table's
TIMESTAMP column to DATETIME is a multi-hour online DDL operation.

**>>> In interviews, if asked about temporal data types: "TIMESTAMP saves 1 byte
and auto-converts timezones, but has a hard ceiling at 2038. For new schemas,
DATETIME(3) — 3 digits of fractional seconds — is the safer default. The 1-byte
savings rarely justifies the 2038 migration risk."**

### 13.1.5 DECIMAL Storage Details

DECIMAL uses a packed binary format. Each group of 9 decimal digits occupies 4
bytes. Leftover digits use proportionally less:

| Leftover Digits | Bytes |
|-----------------|-------|
| 0 | 0 |
| 1-2 | 1 |
| 3-4 | 2 |
| 5-6 | 3 |
| 7-9 | 4 |

Example: `DECIMAL(19,4)` — 15 integer digits + 4 fractional digits.
- Integer part: 15 digits = 1 group of 9 (4 B) + 6 leftover (3 B) = 7 B
- Fractional part: 4 digits = 2 B
- Total: 9 B per value

For financial systems, DECIMAL is non-negotiable. FLOAT/DOUBLE introduce IEEE
754 rounding errors that accumulate across aggregations. A SUM of 1 million
FLOAT values can drift by several dollars.

---

## 13.2 Primary Key Design — The Most Consequential Schema Decision

The primary key in InnoDB is not just an identifier — it is the physical
ordering of data on disk. InnoDB uses a clustered index: the B+Tree leaf pages
of the primary key contain the actual row data. Every secondary index entry
contains a copy of the PK value as its row pointer. This means:

1. **PK size multiplies across every secondary index**
2. **PK ordering determines insert patterns and page splits**
3. **PK determines physical locality of related rows**

### 13.2.1 AUTO_INCREMENT BIGINT — The Default Choice

Sequential inserts append to the rightmost leaf page of the B+Tree. This
produces the optimal access pattern:

```
  AUTO_INCREMENT insert pattern:

  Time →
  Insert ID=1001, 1002, 1003, 1004 ...

  B+Tree leaf pages fill left-to-right:
  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
  │ Page 5         │  │ Page 6         │  │ Page 7         │
  │ [801..900]     │  │ [901..1000]    │  │ [1001..1004 _] │
  │ FULL           │  │ FULL           │  │ FILLING ←───── │
  └────────────────┘  └────────────────┘  └────────────────┘

  Properties:
  - One page split when a page fills → allocate new page, continue appending
  - Pages are ~95-100% full (minimal wasted space)
  - The "hot" page (rightmost) fits in buffer pool; rest rarely evicted
  - No random I/O for inserts — always sequential
  - Binlog events are small (just the new row, predictable PK)
```

### 13.2.2 Random UUID v4 — The Worst Case

UUID v4 is 128 bits of randomness. When used as a PK, inserts land at random
positions throughout the B+Tree:

```
  UUID v4 insert pattern:

  Insert UUIDs: a3f2..., 17bc..., e891..., 5c44..., 82ab...

  B+Tree leaf pages — random insertion:
  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
  │ Page 5         │  │ Page 6         │  │ Page 7         │
  │ [17bc, ?, ?, ?]│  │ [5c44, ?, 82ab]│  │ [a3f2, ?, e891]│
  │ 40% full       │  │ 55% full       │  │ 50% full       │
  └────────────────┘  └────────────────┘  └────────────────┘
            │                                     │
            └── PAGE SPLIT when 17bc's page is ───┘
                full and a new UUID hashes nearby

  Page split mechanics:
  ┌────────────────┐         ┌────────────┐  ┌────────────┐
  │ Page 5 (FULL)  │   →     │ Page 5     │  │ Page 5a    │
  │ [17bc...3a91]  │         │ [17bc..28f]│  │ [290..3a91]│
  │ 100% → split   │         │ ~50% full  │  │ ~50% full  │
  └────────────────┘         └────────────┘  └────────────┘
                              Wasted space!   New page allocated

  Result after billions of inserts:
  - Pages are ~50-65% full on average (vs ~95% for sequential)
  - B+Tree is 1.5-2x larger than necessary → more buffer pool pressure
  - Every insert touches a random page → random I/O (cache miss if not in pool)
  - Page splits generate extra redo log writes
  - Insert throughput drops 3-5x compared to AUTO_INCREMENT
```

### 13.2.3 UUID v7 / ULID — Time-Ordered Compromise

UUID v7 (RFC 9562) encodes a millisecond timestamp in the most significant 48
bits, followed by random bits. ULID is a similar concept: 48 bits of
millisecond timestamp + 80 bits of randomness, encoded as a 26-character
Crockford Base32 string (or stored as BINARY(16)).

```
  UUID v7 structure (128 bits):
  ┌──────────────────────────────────────────────────────────┐
  │ 48 bits: unix_ts_ms │ 4: ver │ 12: rand_a │ 2: var │ 62: rand_b │
  └──────────────────────────────────────────────────────────┘
  │<── time-ordered ──>│        │<── random within ms ────────>│

  Insert pattern (much better):
  - Within the same millisecond: random order among ~4096 values
  - Across milliseconds: monotonically increasing prefix
  - Result: nearly sequential inserts with minor jitter within 1ms windows

  B+Tree behavior:
  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
  │ Page N         │  │ Page N+1       │  │ Page N+2       │
  │ [ts=1000ms...] │  │ [ts=1001ms...] │  │ [ts=1002ms ←─] │
  │ ~90% full      │  │ ~90% full      │  │ FILLING        │
  └────────────────┘  └────────────────┘  └────────────────┘

  - Pages fill ~85-95% (vs ~50-65% for UUID v4)
  - Inserts are mostly append-like with occasional out-of-order within 1ms
  - Compatible with distributed systems (no central coordinator)
  - 16 bytes storage — still 2x larger than BIGINT
```

### 13.2.4 Snowflake IDs — 64-Bit, Time-Ordered, Globally Unique

Twitter's Snowflake format packs global uniqueness into 64 bits (BIGINT):

```
  Snowflake ID structure (64 bits):
  ┌───────────────────────────────────────────────────────┐
  │ 1: sign │ 41: timestamp_ms │ 10: worker_id │ 12: seq │
  └───────────────────────────────────────────────────────┘

  - 41 bits timestamp: ~69 years from custom epoch
  - 10 bits worker ID: 1024 workers (shards/nodes)
  - 12 bits sequence: 4096 IDs per millisecond per worker
  - Total capacity: 4096 * 1000 * 1024 = ~4.2 billion IDs/second globally

  Advantages over UUID v7:
  - 8 bytes (BIGINT) instead of 16 bytes (BINARY(16))
  - Native integer comparison — faster than binary comparison
  - Time-ordered → sequential insert pattern
  - Encodes shard/worker ID → built-in routing information

  Disadvantage:
  - Requires a Snowflake ID generator service (or library)
  - 69-year lifespan from custom epoch (still ample for most systems)
  - Worker ID assignment needs coordination
```

### 13.2.5 PK Size Impact on Secondary Indexes

This is the single most under-appreciated fact about InnoDB schema design:

```
  Table: orders
  - PK: id (BIGINT = 8 bytes vs UUID = 16 bytes)
  - Secondary indexes: 5 (on status, user_id, created_at, amount, region)

  Every secondary index leaf entry = index_columns + PK_value

  With BIGINT PK (8 B):
    Each secondary index entry includes 8 B for the PK
    5 indexes × 8 B × 1 billion rows = 40 GB of PK copies

  With UUID PK (16 B):
    Each secondary index entry includes 16 B for the PK
    5 indexes × 16 B × 1 billion rows = 80 GB of PK copies

  Difference: 40 GB extra storage, buffer pool pressure, replication traffic,
  and backup time — just from the PK type choice.

  With a composite natural PK (user_id BIGINT + created_at DATETIME = 13 B):
    5 indexes × 13 B × 1 billion rows = 65 GB of PK copies
    AND every secondary index lookup returns composite PK values that
    must be used for the clustered index lookup — wider entries slow
    the secondary index scan itself.
```

**>>> "PK size directly multiplies every secondary index. A 16-byte UUID PK in a
table with 5 secondary indexes: 80 extra bytes per row in secondary indexes
alone. At a billion rows, that is 80 GB of avoidable I/O. This is why Snowflake
IDs (8 bytes, time-ordered, globally unique) are the industry preference over
UUID for high-scale InnoDB tables."**

### 13.2.6 PK Strategy Decision Matrix

| Strategy | Size | Ordered | Global Unique | Distributed | InnoDB Fit | When to Use |
|----------|------|---------|---------------|-------------|------------|-------------|
| AUTO_INCREMENT BIGINT | 8 B | Yes | No (per-table) | No (single writer) | Optimal | Single-master, most OLTP |
| UUID v4 | 16 B | No | Yes | Yes | Worst | Never for InnoDB PKs |
| UUID v7 / ULID | 16 B | Yes (ms) | Yes | Yes | Good | Distributed, need standard UUID format |
| Snowflake ID | 8 B | Yes (ms) | Yes | Yes | Optimal | Distributed systems, sharded MySQL |
| Natural composite | Varies | Depends | Depends | N/A | Poor-OK | Join/bridge tables only |

### 13.2.7 Missing AUTO_INCREMENT PK — The Hidden Contention

If you create a table without an explicit primary key, InnoDB generates a
hidden 6-byte `ROW_ID` column. This ROW_ID is allocated from a global counter
protected by `dict_sys->mutex`. On a server with many tables lacking explicit
PKs, this single mutex becomes a serialization point for all inserts across
all such tables.

```
  Source: storage/innobase/dict/dict0dict.cc — dict_table_get_next_table_sess_row_id()

  Impact:
  - Global mutex contention across ALL tables without explicit PK
  - ROW_ID is 6 bytes — no space savings vs BIGINT (8 bytes)
  - ROW_ID is not exposed to SQL — cannot be used in WHERE clauses
  - ROW_ID wraps at 2^48 — lower than BIGINT UNSIGNED

  Rule: EVERY table must have an explicit PRIMARY KEY. No exceptions.
```

---

## 13.3 Normalization vs Denormalization

Normalization (3NF) is the correct starting point. Denormalization is a
performance optimization applied selectively after measuring. The common mistake
is either dogmatic 3NF adherence at the cost of latency or premature
denormalization that creates update anomalies.

### 13.3.1 Third Normal Form — Advantages

- **Less storage**: each fact stored once. A customer name appears in the
  `customers` table, not duplicated in every `orders` row.
- **Single source of truth**: updating a customer name requires one UPDATE
  statement, not scanning every table that references the customer.
- **Simpler writes**: INSERT/UPDATE/DELETE operations touch fewer columns and
  pages. Less redo log, less replication traffic.
- **Smaller indexes**: fewer columns per table means secondary indexes are
  narrower and shorter.

### 13.3.2 Third Normal Form — Disadvantages at Scale

- **More JOINs**: a typical e-commerce order page might require JOINing orders,
  order_items, products, customers, addresses, payments — 6+ tables. Each
  JOIN is a nested-loop or hash join with its own I/O pattern.
- **Lock contention**: multi-table JOINs under REPEATABLE READ acquire shared
  locks on rows across multiple tables. Concurrent writes to those tables
  wait on those locks.
- **Higher latency**: each JOIN adds latency. A 6-table JOIN with cold buffer
  pool can require 6+ random I/O operations per row in the result set.
- **Harder to cache**: the result of a 6-table JOIN cannot be trivially cached
  because invalidation requires tracking changes in all 6 tables.
- **Replication lag sensitivity**: reads on a replica that lag by even 1 second
  can return inconsistent data across JOINed tables (e.g., order row from
  t=now, customer name from t=now-1s).

### 13.3.3 Denormalization Patterns

**Pattern 1: Precomputed Aggregates (Materialized Counters)**

```sql
-- Instead of:  SELECT COUNT(*) FROM posts WHERE user_id = 42;
-- (Full index scan on idx_user_id every time)

-- Maintain a counter column:
ALTER TABLE users ADD COLUMN post_count INT UNSIGNED NOT NULL DEFAULT 0;

-- Increment on insert:
UPDATE users SET post_count = post_count + 1 WHERE id = 42;

-- Read is a single-row PK lookup:
SELECT post_count FROM users WHERE id = 42;
```

Trade-off: every INSERT into `posts` now also requires an UPDATE on `users`.
This adds a write to a second table, potentially a second page, a second redo
log entry. But for a counter read 1000x more often than it is written, the
trade-off is strongly favorable.

**Pattern 2: Embedded JSON for Flexible Attributes**

```sql
CREATE TABLE products (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    category_id INT UNSIGNED NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    attributes JSON NOT NULL DEFAULT ('{}'),
    -- e.g., {"color": "red", "weight_kg": 2.5, "material": "steel"}
    INDEX idx_category (category_id)
);

-- Functional index on a JSON path (MySQL 8.0.13+):
ALTER TABLE products ADD INDEX idx_color ((CAST(attributes->>'$.color' AS CHAR(50))));
```

This avoids EAV tables (see section 13.7.3) while keeping relational columns
for frequently queried/filtered/joined fields.

**Pattern 3: Copy Columns to Avoid JOINs**

```sql
-- Normalized: order_items references products.name via product_id FK
-- Problem: every order display requires JOIN to products

-- Denormalized: copy the product name at order time
ALTER TABLE order_items ADD COLUMN product_name VARCHAR(200) NOT NULL;

-- This is a snapshot — if the product name changes later, old orders
-- retain the original name (which is often the correct business behavior)
```

**Pattern 4: Summary Tables (Hourly/Daily Aggregates)**

```sql
CREATE TABLE daily_sales_summary (
    summary_date DATE NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    total_quantity INT UNSIGNED NOT NULL DEFAULT 0,
    total_revenue DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    order_count INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (summary_date, product_id),
    INDEX idx_product (product_id, summary_date)
);

-- Populated by a periodic job (or trigger/event):
INSERT INTO daily_sales_summary (summary_date, product_id, total_quantity, total_revenue, order_count)
SELECT DATE(created_at), product_id, SUM(quantity), SUM(quantity * unit_price), COUNT(*)
FROM order_items
WHERE created_at >= CURDATE() AND created_at < CURDATE() + INTERVAL 1 DAY
GROUP BY DATE(created_at), product_id
ON DUPLICATE KEY UPDATE
    total_quantity = VALUES(total_quantity),
    total_revenue = VALUES(total_revenue),
    order_count = VALUES(order_count);
```

### 13.3.4 When to Denormalize — Decision Framework

| Signal | Action |
|--------|--------|
| A query JOINs 4+ tables on every page load | Measure latency; if >50ms, consider copy columns |
| A COUNT/SUM/AVG is computed on every request | Materialize as a counter/summary column |
| Query pattern is fixed and well-known | Safe to denormalize for that specific pattern |
| Data is append-only (logs, events) | Denormalize aggressively; no update anomalies |
| Data changes frequently and is referenced everywhere | Keep normalized; denormalization creates update cascades |
| You have not measured the actual bottleneck | Do not denormalize. Premature denormalization is debt |

**>>> "Start normalized. Profile. Denormalize the specific query paths that are
measured bottlenecks. Every denormalization is a trade: you are buying read
speed and paying with write complexity, storage, and the risk of
inconsistency."**

---

## 13.4 NULL Handling — The Subtle Performance Tax

### 13.4.1 Storage: The Null Bitmap

InnoDB stores a null bitmap in every row. Each nullable column occupies 1 bit
in this bitmap, rounded up to the nearest byte.

```
  Row format (COMPACT/DYNAMIC) — null bitmap:
  ┌──────────────────────────────────────────────────────────────┐
  │ Variable-length field lengths (reverse) │ NULL bitmap │ ...  │
  └──────────────────────────────────────────────────────────────┘

  Table with 9 nullable columns:
    Null bitmap = ceil(9/8) = 2 bytes per row

  Table with 0 nullable columns:
    Null bitmap = 0 bytes (no bitmap stored at all)

  At 1 billion rows:
    9 nullable columns → 2 GB just for the null bitmap
    0 nullable columns → 0 GB

  If those 9 columns are mostly NOT NULL in practice,
  the bitmap is wasted space storing "not null" bits.
```

### 13.4.2 Indexes and NULL

Unlike some databases (Oracle does not index all-NULL entries in B-Tree indexes),
**InnoDB indexes NULL values**. This means:

- `WHERE col IS NULL` can use an index on `col` — InnoDB stores NULLs at the
  start of the index's B+Tree order.
- `WHERE col IS NOT NULL` can use a range scan on the index.
- The cost: NULL values occupy space in every index that includes the column.

### 13.4.3 NULL Comparison Gotchas

```sql
-- Table: users (status VARCHAR(20) NULL)
-- Data: ('active'), ('inactive'), (NULL)

SELECT * FROM users WHERE status != 'active';
-- Returns: ('inactive')
-- Does NOT return: (NULL)
-- Reason: NULL != 'active' evaluates to NULL, not TRUE

-- To include NULLs:
SELECT * FROM users WHERE status != 'active' OR status IS NULL;
-- Returns: ('inactive'), (NULL)

-- Or use NULL-safe equality:
SELECT * FROM users WHERE NOT (status <=> 'active');
-- Returns: ('inactive'), (NULL)
-- The <=> operator treats NULL = NULL as TRUE
```

This is a source of production bugs. Any WHERE clause with `!=`, `NOT IN`, or
`NOT LIKE` silently excludes NULL rows unless explicitly handled.

### 13.4.4 Composite Unique Indexes with NULL

```sql
CREATE TABLE user_preferences (
    user_id BIGINT UNSIGNED NOT NULL,
    preference_key VARCHAR(100) NOT NULL,
    workspace_id BIGINT UNSIGNED NULL,
    value TEXT,
    UNIQUE KEY uk_user_pref_ws (user_id, preference_key, workspace_id)
);

-- These two inserts BOTH succeed:
INSERT INTO user_preferences (user_id, preference_key, workspace_id, value)
VALUES (1, 'theme', NULL, 'dark');
INSERT INTO user_preferences (user_id, preference_key, workspace_id, value)
VALUES (1, 'theme', NULL, 'light');

-- Result: two rows with (1, 'theme', NULL) — the unique constraint is NOT violated
-- Reason: NULL != NULL, so (1, 'theme', NULL) is never "equal" to (1, 'theme', NULL)
```

This is per the SQL standard, but it surprises many developers. If you need
unique enforcement including NULLs, use a sentinel value (e.g., 0 for "no
workspace") instead of NULL.

### 13.4.5 The NOT NULL Rule

**Rule**: make every column NOT NULL with a sensible default unless there is a
genuine semantic difference between "not set" and "empty/zero."

- `NOT NULL DEFAULT ''` for optional strings
- `NOT NULL DEFAULT 0` for optional numbers
- `NOT NULL DEFAULT '1970-01-01 00:00:00'` or `NOT NULL DEFAULT CURRENT_TIMESTAMP`
  for timestamps (choose based on semantics)

Benefits:
- Eliminates null bitmap overhead
- Simplifies WHERE clauses (no `IS NULL` edge cases)
- Avoids NULL-comparison bugs in application code
- Slightly smaller index entries

**>>> "Make columns NOT NULL unless NULL carries distinct business meaning. 'I
don't know this user's age' (NULL) is semantically different from 'this user's
age is 0.' If the distinction matters, use NULL. If not, use NOT NULL DEFAULT 0
and save the bitmap overhead."**

---

## 13.5 Character Sets and Collations — The Hidden Multiplier

### 13.5.1 Character Set Storage Costs

| Character Set | Bytes per Character | Characters Supported | MySQL 8.0 Status |
|---------------|--------------------:|----------------------|------------------|
| latin1 | 1 | Western European (ISO 8859-1) | Supported, not recommended |
| utf8mb3 (alias: utf8) | 1-3 | Basic Multilingual Plane only | Deprecated in 8.0, removed in future |
| utf8mb4 | 1-4 | Full Unicode (incl. emoji, CJK-B) | Default since 8.0. Use this |
| binary | 1 | Raw bytes | No character semantics |
| ascii | 1 | US-ASCII (0-127) | Subset of utf8mb4 |

**The utf8mb3 trap**: MySQL's historical `utf8` charset is actually `utf8mb3` —
it uses at most 3 bytes per character and cannot store characters outside the
Basic Multilingual Plane. This includes emoji (U+1F600+), some CJK characters,
and musical symbols. `utf8mb4` is the real UTF-8. MySQL 8.0 defaults to
`utf8mb4`; older installations often have `utf8mb3` tables that silently
corrupt emoji.

### 13.5.2 VARCHAR Storage Implications

`VARCHAR(N)` means N *characters*, not N bytes. The maximum byte length depends
on the character set:

```
  VARCHAR(255) with utf8mb4:
    Max bytes = 255 × 4 = 1,020 bytes
    Length prefix = 2 bytes (because 1,020 > 255)

  VARCHAR(255) with latin1:
    Max bytes = 255 × 1 = 255 bytes
    Length prefix = 1 byte (because 255 ≤ 255)

  Impact on sort buffers and temp tables:
  MySQL allocates sort buffers based on MAXIMUM possible row size.
  A VARCHAR(255) utf8mb4 column → MySQL reserves 1,020 bytes in the
  sort buffer for that column, even if the actual data is 10 bytes.

  A query sorting by 3 such columns: 3 × 1,020 = 3,060 bytes per row
  in the sort buffer, even though actual data might be 30 bytes/row.

  This is why VARCHAR(255) should not be the default for every string column.
  Size your VARCHARs to actual expected maximum data length:
    email → VARCHAR(320)     -- RFC 5321 maximum
    username → VARCHAR(50)   -- your application's limit
    country_code → CHAR(2)   -- fixed length, use CHAR
    phone → VARCHAR(20)      -- E.164 maximum is 15 digits + formatting
```

### 13.5.3 Collation Impact on Indexes and Queries

A collation defines the sort order and comparison rules for strings. It
directly affects index behavior:

```
  utf8mb4_0900_ai_ci (default in MySQL 8.0):
    - ai = accent-insensitive: 'café' = 'cafe'
    - ci = case-insensitive: 'ABC' = 'abc'
    - Based on UCA 9.0.0 standard
    - Index lookup: WHERE name = 'José' matches 'jose', 'JOSE', 'José'

  utf8mb4_bin:
    - Binary comparison: byte-by-byte
    - Case-sensitive: 'ABC' != 'abc'
    - Accent-sensitive: 'café' != 'cafe'
    - Fastest comparison (no collation weight lookup)

  utf8mb4_0900_as_cs:
    - Accent-sensitive, case-sensitive
    - 'café' != 'cafe', 'ABC' != 'abc'
    - Useful when exact matching is required but you still want
      proper Unicode normalization (unlike _bin which compares bytes)
```

### 13.5.4 Character Set Mismatch — The Silent Index Killer

```sql
-- Table A: users (name VARCHAR(100) CHARACTER SET utf8mb4)
-- Table B: orders (customer_name VARCHAR(100) CHARACTER SET latin1)

SELECT * FROM users u
JOIN orders o ON u.name = o.customer_name;

-- InnoDB CANNOT use an index on o.customer_name for this join.
-- Reason: implicit charset conversion on every comparison.
-- The EXPLAIN will show "Using where" with no index usage on orders.

-- Fix: ensure both columns use the same character set.
ALTER TABLE orders MODIFY customer_name VARCHAR(100) CHARACTER SET utf8mb4;
```

**>>> "Character set mismatch between columns in a JOIN prevents index usage.
MySQL performs an implicit conversion (CONVERT()) on every row comparison,
which forces a full table scan. This is one of the most common hidden
performance killers in legacy schemas. Always verify `SHOW CREATE TABLE` for
charset consistency across joined columns."**

### 13.5.5 Collation Mismatch — Same Problem, Different Cause

Even with the same character set, differing collations prevent index use:

```sql
-- Column A: utf8mb4_0900_ai_ci (default 8.0)
-- Column B: utf8mb4_general_ci (common in upgraded-from-5.7 tables)

-- JOIN on these columns → implicit collation conversion → no index

-- Fix: standardize collation across all tables, or use COLLATE in the query:
SELECT * FROM a JOIN b ON a.col COLLATE utf8mb4_0900_ai_ci = b.col;
-- But COLLATE on the indexed column side prevents index usage.
-- Always COLLATE on the non-indexed side, or better, fix the schema.
```

---

## 13.6 Online DDL — Schema Changes Without Downtime

In production, the only thing more dangerous than a schema that needs changing
is the act of changing it. InnoDB online DDL, pt-online-schema-change, and
gh-ost represent three generations of solutions to this problem.

### 13.6.1 MySQL 8.0 Native Online DDL

MySQL 8.0 supports three DDL algorithms:

| Algorithm | Description | Lock | Copy? |
|-----------|-------------|------|-------|
| INSTANT | Metadata-only change | None | No |
| INPLACE | Done in InnoDB engine, no table copy | Usually NONE | No (mostly) |
| COPY | Create temp table, copy all rows, swap | SHARED or EXCLUSIVE | Yes |

You specify the desired algorithm and lock level:
```sql
ALTER TABLE orders ADD COLUMN notes VARCHAR(500) DEFAULT NULL,
    ALGORITHM=INPLACE, LOCK=NONE;
```

If the operation cannot be performed with the requested algorithm, MySQL
returns an error rather than silently falling back to COPY.

### 13.6.2 Online DDL Capabilities Matrix

| Operation | Algorithm | Lock | Rebuild Table? | Notes |
|-----------|-----------|------|----------------|-------|
| Add column (at end) | INSTANT (8.0.12+) | None | No | Metadata only. Fastest DDL possible |
| Add column (in middle) | INSTANT (8.0.29+) | None | No | Was INPLACE before 8.0.29 |
| Drop column | INSTANT (8.0.29+) | None | No | Metadata only; space reclaimed on next page rewrite |
| Rename column | INSTANT | None | No | Metadata only |
| Change column default | INSTANT | None | No | Default stored in data dictionary, not in rows |
| Add secondary index | INPLACE | None* | No | *Brief exclusive lock at start/end for metadata |
| Drop secondary index | INPLACE | None | No | B+Tree deallocated |
| Change VARCHAR size (increase, within prefix limit) | INPLACE | None | No | Only if new max bytes <= old length-prefix capacity |
| Add/change ENUM/SET values (at end) | INSTANT | None | No | Metadata only, no data change |
| Change column type (e.g., INT→BIGINT) | COPY | Shared | Yes | Full table rebuild required |
| Change PK | COPY | Exclusive | Yes | Rebuilds clustered index — most expensive DDL |
| Convert charset | COPY | Shared | Yes | Re-encodes every row |
| Add FULLTEXT index | INPLACE | None* | No | *Exclusive lock at start for metadata |
| Add spatial index | INPLACE | None* | No | Similar to FULLTEXT |
| Optimize table | INPLACE | None | Yes | Rebuilds table in-place, reclaims space |

### 13.6.3 The Brief Metadata Lock Problem

Even "online" DDL operations require a brief exclusive metadata lock (MDL) at
the start and end. During this window, all queries on the table wait. If there
is a long-running query holding a shared MDL on the table, the ALTER blocks on
that query, and all subsequent queries pile up behind the ALTER's exclusive MDL
request.

```
  Timeline of an "online" ALTER TABLE:

  ──────────────────────────────────────────────────────────────────────
  │ Phase 1: Acquire exclusive MDL (brief)                             │
  │   → Blocked by any running SELECT/DML holding shared MDL           │
  │   → While waiting, all new SELECT/DML also blocked                 │
  │                                                                    │
  │ Phase 2: Build index / modify data (long, LOCK=NONE)               │
  │   → DML can proceed concurrently                                   │
  │   → Changes tracked in online redo log                             │
  │                                                                    │
  │ Phase 3: Acquire exclusive MDL again (brief)                       │
  │   → Apply tracked changes, finalize, update data dictionary        │
  │   → Same blocking risk as Phase 1                                  │
  ──────────────────────────────────────────────────────────────────────

  Mitigation:
  - Kill long-running queries before starting ALTER
  - Set lock_wait_timeout to a short value (e.g., 5 seconds)
  - Use pt-online-schema-change or gh-ost for zero-risk operations
```

### 13.6.4 pt-online-schema-change (Percona Toolkit)

Percona's tool predates MySQL's native online DDL and works for any DDL
operation, regardless of whether InnoDB supports it online:

```
  pt-online-schema-change workflow:

  1. Create shadow table: CREATE TABLE _orders_new LIKE orders;
  2. Apply DDL to shadow: ALTER TABLE _orders_new ADD COLUMN notes VARCHAR(500);
  3. Create triggers on original table:
       AFTER INSERT → INSERT INTO _orders_new
       AFTER UPDATE → REPLACE INTO _orders_new
       AFTER DELETE → DELETE FROM _orders_new
  4. Copy data in chunks: INSERT INTO _orders_new SELECT ... LIMIT chunk_size
     (with throttling based on replication lag and server load)
  5. Swap tables: RENAME TABLE orders TO _orders_old, _orders_new TO orders;
     (Atomic metadata swap — instantaneous)
  6. Drop old table and triggers

  Advantages:
  - Works for any DDL operation (even PK changes)
  - Throttling based on replica lag (--max-lag)
  - Chunk-based copying — can be paused/resumed
  - Battle-tested at Percona, Booking.com, etc.

  Disadvantages:
  - Triggers add overhead to every DML on the original table
  - Trigger-based approach can cause deadlocks under high write load
  - Cannot be used if the table already has triggers (MySQL limit:
    only one trigger per action per table, relaxed in some 8.0 versions)
  - The RENAME TABLE swap requires a brief exclusive lock
```

### 13.6.5 gh-ost (GitHub Online Schema Migration)

gh-ost takes a fundamentally different approach: instead of triggers, it reads
the binary log to capture DML changes during the migration.

```
  gh-ost workflow:

  1. Create shadow table: CREATE TABLE _orders_gho LIKE orders;
  2. Apply DDL to shadow: ALTER TABLE _orders_gho ADD COLUMN notes VARCHAR(500);
  3. Connect to binlog stream (on replica or primary):
       - Read binlog events for the original table
       - Apply equivalent DML to the shadow table
  4. Copy existing rows in chunks (from replica, to avoid primary load):
       INSERT INTO _orders_gho SELECT ... WHERE pk BETWEEN ... AND ...
       (Uses a range-based copy strategy with configurable chunk size)
  5. When copy is complete and binlog is caught up:
       - Perform cut-over: atomic RENAME or lock-based swap
       - gh-ost uses a custom cut-over algorithm to minimize lock time
  6. Drop old table

  Advantages over pt-online-schema-change:
  - No triggers — zero impact on DML performance during migration
  - Reads binlog from replica — primary only sees the chunk SELECTs
  - Can be paused, throttled, and even rolled back mid-migration
  - Supports postponing the cut-over to a maintenance window
  - Interactive control via Unix socket during migration

  Disadvantages:
  - Requires ROW-based binlog format (standard since MySQL 5.7)
  - More complex setup (binlog access, replication topology awareness)
  - Foreign keys not supported (same as pt-osc)
  - Cut-over requires a brief period where the table is locked
```

**>>> "gh-ost is the industry standard for zero-downtime schema changes at scale.
It eliminates the trigger overhead of pt-osc by reading the binlog stream
instead. Key interview detail: gh-ost performs the copy from a replica but
applies changes to the primary's shadow table, minimizing primary I/O."**

### 13.6.6 Comparison: Native DDL vs pt-osc vs gh-ost

| Aspect | Native Online DDL | pt-online-schema-change | gh-ost |
|--------|-------------------|-------------------------|--------|
| DML impact during migration | None (INPLACE/INSTANT) or full table copy (COPY) | Trigger overhead on every DML | None (binlog-based) |
| Works for all DDL operations | No (some require COPY) | Yes | Yes |
| Replication-aware throttling | No | Yes (--max-lag) | Yes (built-in) |
| Pausable/resumable | No | Limited | Yes (Unix socket control) |
| Rollback | No (must re-ALTER) | Drop shadow table | Drop shadow table |
| Foreign key support | Yes | Limited | No |
| Requires binlog | No | No | Yes (ROW format) |
| Requires triggers | No | Yes | No |
| Primary load | Full (for COPY algo) | Moderate (triggers + copy) | Low (only chunk reads) |
| Metadata lock risk | Yes (brief exclusive MDL) | Yes (RENAME TABLE) | Yes (cut-over lock) |
| Recommended for | Small tables, INSTANT ops | Legacy setups, trigger-OK workloads | Large tables, high-write workloads |

---

## 13.7 Schema Design Patterns for Common Use Cases

### 13.7.1 Soft Deletes

```sql
CREATE TABLE users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(320) NOT NULL,
    name VARCHAR(100) NOT NULL,
    deleted_at TIMESTAMP NULL DEFAULT NULL,
    -- NULL = active, non-NULL = soft-deleted

    UNIQUE KEY uk_email (email),  -- Problem: deleted users block new signups
    INDEX idx_deleted (deleted_at)
);
```

**The unique constraint problem**: if user@example.com soft-deletes and a new
user signs up with the same email, the unique index blocks it. Solutions:

```sql
-- Solution 1: Composite unique index with a "deleted" discriminator
ALTER TABLE users DROP INDEX uk_email;
ALTER TABLE users ADD COLUMN deleted_id BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE users ADD UNIQUE KEY uk_email_deleted (email, deleted_id);
-- On soft delete: SET deleted_id = id, deleted_at = NOW()
-- Active users have deleted_id = 0, so uk_email_deleted is effectively unique on email

-- Solution 2: Functional index (MySQL 8.0.13+)
ALTER TABLE users ADD UNIQUE INDEX uk_active_email
    ((CASE WHEN deleted_at IS NULL THEN email ELSE NULL END));
-- NULL values in unique index are not enforced (multiple NULLs allowed)
-- Only non-deleted (active) users are constrained
```

**Performance implications**:
- Every query must include `WHERE deleted_at IS NULL` — forgetting this leaks
  deleted data. Use views or ORM scopes to enforce this.
- The `deleted_at` index grows with deleted rows — eventually, most of the
  index is "deleted" entries. Periodic archival to a `users_archive` table
  keeps the active table lean.
- AUTO_INCREMENT never resets — soft deletes accelerate ID exhaustion (see
  section 13.1.3).

### 13.7.2 Polymorphic Associations (Anti-Pattern)

```sql
-- Anti-pattern: polymorphic foreign key
CREATE TABLE comments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    commentable_type ENUM('post', 'photo', 'video') NOT NULL,
    commentable_id BIGINT UNSIGNED NOT NULL,
    body TEXT NOT NULL,
    INDEX idx_commentable (commentable_type, commentable_id)
);
-- commentable_id points to posts.id, photos.id, or videos.id
-- depending on commentable_type

-- Problems:
-- 1. Cannot enforce FK constraint (no single parent table)
-- 2. JOIN requires CASE or UNION: SELECT ... FROM comments
--    LEFT JOIN posts ON type='post' AND id=commentable_id
--    LEFT JOIN photos ON type='photo' AND id=commentable_id ...
-- 3. Index on (type, id) is less selective than a dedicated FK index
```

**Better alternative**: separate join tables:

```sql
CREATE TABLE post_comments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT UNSIGNED NOT NULL,
    body TEXT NOT NULL,
    INDEX idx_post (post_id)
    -- FK constraint possible: FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE TABLE photo_comments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    photo_id BIGINT UNSIGNED NOT NULL,
    body TEXT NOT NULL,
    INDEX idx_photo (photo_id)
);
-- Each table has a real FK, proper index, and simple JOINs
```

### 13.7.3 EAV — Entity-Attribute-Value (Anti-Pattern)

```sql
-- Anti-pattern: EAV table for flexible attributes
CREATE TABLE product_attributes (
    product_id BIGINT UNSIGNED NOT NULL,
    attribute_name VARCHAR(100) NOT NULL,
    attribute_value VARCHAR(500),
    PRIMARY KEY (product_id, attribute_name)
);

-- Problems at scale:
-- 1. Querying "all red products that weigh > 5kg":
--    SELECT p.* FROM products p
--    JOIN product_attributes a1 ON p.id = a1.product_id
--        AND a1.attribute_name = 'color' AND a1.attribute_value = 'red'
--    JOIN product_attributes a2 ON p.id = a2.product_id
--        AND a2.attribute_name = 'weight_kg' AND CAST(a2.attribute_value AS DECIMAL) > 5;
--    → N self-joins for N attributes. Optimizer cannot push predicates efficiently.
--
-- 2. No type safety: all values are VARCHAR. Comparisons on numbers/dates
--    require CAST(), which prevents index usage.
--
-- 3. Reporting is a nightmare: every pivot requires dynamic SQL or application code.
```

**Better alternative**: JSON column with functional indexes (MySQL 8.0):

```sql
CREATE TABLE products (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    attributes JSON NOT NULL DEFAULT ('{}'),
    INDEX idx_color ((CAST(attributes->>'$.color' AS CHAR(50)))),
    INDEX idx_weight ((CAST(attributes->>'$.weight_kg' AS DECIMAL(8,2))))
);

-- Query:
SELECT * FROM products
WHERE attributes->>'$.color' = 'red'
  AND CAST(attributes->>'$.weight_kg' AS DECIMAL(8,2)) > 5;
-- Both predicates can use functional indexes
```

### 13.7.4 Temporal Tables — Bitemporal Design

```sql
CREATE TABLE product_prices (
    product_id BIGINT UNSIGNED NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    valid_from DATETIME(3) NOT NULL,
    valid_to DATETIME(3) NOT NULL DEFAULT '9999-12-31 23:59:59.999',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (product_id, valid_from),
    INDEX idx_product_range (product_id, valid_to, valid_from)
);

-- Current price:
SELECT price FROM product_prices
WHERE product_id = 42
  AND valid_from <= NOW(3)
  AND valid_to > NOW(3);

-- Price at a specific historical point:
SELECT price FROM product_prices
WHERE product_id = 42
  AND valid_from <= '2025-06-15 10:00:00'
  AND valid_to > '2025-06-15 10:00:00';

-- To change price: close current period, open new one
UPDATE product_prices SET valid_to = NOW(3)
WHERE product_id = 42 AND valid_to = '9999-12-31 23:59:59.999';
INSERT INTO product_prices (product_id, price, valid_from)
VALUES (42, 29.99, NOW(3));
```

The index on `(product_id, valid_to, valid_from)` supports the "current price"
query efficiently: seek to product_id, then the `valid_to = '9999-12-31...'`
row is the current price (a single index seek).

### 13.7.5 Audit Log Pattern

```sql
CREATE TABLE audit_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(64) NOT NULL,
    row_id BIGINT UNSIGNED NOT NULL,
    action ENUM('INSERT', 'UPDATE', 'DELETE') NOT NULL,
    old_values JSON NULL,
    new_values JSON NULL,
    changed_by BIGINT UNSIGNED NOT NULL,
    changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_table_row (table_name, row_id, changed_at),
    INDEX idx_changed_at (changed_at)
) ENGINE=InnoDB
  PARTITION BY RANGE (UNIX_TIMESTAMP(changed_at)) (
    PARTITION p2025_q1 VALUES LESS THAN (UNIX_TIMESTAMP('2025-04-01')),
    PARTITION p2025_q2 VALUES LESS THAN (UNIX_TIMESTAMP('2025-07-01')),
    PARTITION p2025_q3 VALUES LESS THAN (UNIX_TIMESTAMP('2025-10-01')),
    PARTITION p2025_q4 VALUES LESS THAN (UNIX_TIMESTAMP('2026-01-01')),
    PARTITION p_future  VALUES LESS THAN MAXVALUE
);

-- Properties:
-- INSERT-only: never UPDATE or DELETE (append-only workload)
-- Partitioned by time: DROP PARTITION for archival (instant, no row-by-row DELETE)
-- JSON for old/new values: flexible schema, no ALTER TABLE when source tables change
-- Partition pruning: queries with changed_at range hit only relevant partitions
```

### 13.7.6 Multi-Tenant Schema Strategies

**Strategy 1: Shared Table with `tenant_id` Column**

```sql
CREATE TABLE orders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT UNSIGNED NOT NULL,
    customer_id BIGINT UNSIGNED NOT NULL,
    total DECIMAL(12,2) NOT NULL,
    status ENUM('pending','confirmed','shipped','delivered') NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    -- tenant_id MUST be the leading column in every index
    INDEX idx_tenant_customer (tenant_id, customer_id),
    INDEX idx_tenant_status (tenant_id, status, created_at),
    INDEX idx_tenant_created (tenant_id, created_at)
);

-- Every query MUST include tenant_id in WHERE clause
-- Missing tenant_id → cross-tenant data leak AND full index scan
```

```
  Multi-tenant B+Tree structure (shared table):

  Clustered index (by auto_increment id):
  ┌───────────────────────────────────────────────┐
  │ [id=1,t=A] [id=2,t=B] [id=3,t=A] [id=4,t=C] │ ← mixed tenants per page
  └───────────────────────────────────────────────┘

  Secondary index (tenant_id, status, created_at):
  ┌─────────────────────────────────────────────────┐
  │ [t=A,pending,ts1] [t=A,pending,ts2] [t=A,...]  │ ← tenant A contiguous
  ├─────────────────────────────────────────────────┤
  │ [t=B,pending,ts1] [t=B,confirmed,ts3] [t=B,...] │ ← tenant B contiguous
  └─────────────────────────────────────────────────┘

  The secondary index naturally clusters by tenant_id (leading column),
  giving each tenant good locality even in a shared table.
```

| Aspect | Shared Table | Schema per Tenant | Database per Tenant |
|--------|-------------|-------------------|---------------------|
| Isolation level | Logical (WHERE clause) | Namespace | Full (separate files) |
| Cross-tenant risk | High (missing WHERE) | Low | None |
| Operational complexity | Low | Medium | High |
| Schema migration | One ALTER TABLE | N ALTER TABLE ops | N ALTER TABLE ops |
| Connection pooling | One pool | One pool, USE db | N pools or router |
| Buffer pool efficiency | Shared (hot tenants benefit) | Shared | Partitioned (cold waste) |
| Max tenants | Unlimited | ~thousands (file descriptors) | ~hundreds (resource limits) |
| Backup/restore per tenant | Impossible (without logical dump + filter) | Possible (mysqldump --databases) | Easy (physical copy) |
| Best for | SaaS with many small tenants | Medium tenants, regulatory needs | Large tenants, strict isolation |

**>>> "For multi-tenant schemas with shared tables, tenant_id must be the
leading column in every composite index. This gives each tenant contiguous
ranges in the B+Tree, enabling efficient range scans per tenant. The most
common multi-tenant bug: a query missing the tenant_id filter, causing a full
index scan and cross-tenant data exposure."**

---

## 13.8 JSON Column Best Practices (MySQL 8.0)

### 13.8.1 Binary JSON Storage Format

MySQL 8.0 stores JSON in an optimized binary format, not as a text string.
The binary format is parsed and validated at write time:

```
  INSERT INTO t (doc) VALUES ('{"name": "Alice", "age": 30}');

  What MySQL stores (conceptual binary layout):
  ┌──────────────────────────────────────────────────────────────┐
  │ Header: type=object, element_count=2, size=...               │
  │ Key entry[0]: offset=..., length=4 ("name")                  │
  │ Key entry[1]: offset=..., length=3 ("age")                   │
  │ Value entry[0]: type=string, offset=...                      │
  │ Value entry[1]: type=int16, value=30 (inlined)               │
  │ Key data: "name" "age"                                       │
  │ Value data: "Alice"                                          │
  └──────────────────────────────────────────────────────────────┘

  Benefits:
  - Key lookup is O(log N) via binary search on sorted key entries
  - Small integers are inlined (no pointer dereference)
  - No re-parsing on read — already in traversable format
  - Validation at write time catches malformed JSON early
```

### 13.8.2 Partial Updates (MySQL 8.0.3+)

Before 8.0.3, any JSON modification rewrote the entire document. Since 8.0.3,
`JSON_SET()`, `JSON_REPLACE()`, and `JSON_REMOVE()` can perform partial (in-place)
updates under these conditions:

1. The column being updated is of JSON type
2. The `UPDATE` uses `JSON_SET()`, `JSON_REPLACE()`, or `JSON_REMOVE()`
3. The update does not increase the storage size of the document
4. `binlog_row_value_options = PARTIAL_JSON` is enabled

```sql
-- Partial update (in-place):
UPDATE products SET attributes = JSON_SET(attributes, '$.stock', 42)
WHERE id = 100;
-- Only the bytes for the "stock" value are modified in the page
-- Binlog records only the partial diff, not the full JSON document

-- Full rewrite (NOT partial):
UPDATE products SET attributes = CONCAT('{"stock": 42, ', SUBSTRING(attributes, 2))
WHERE id = 100;
-- Any non-JSON function on the column forces a full rewrite
```

Partial updates reduce redo log volume, binlog size, and buffer pool dirty page
writes — critical at scale with large JSON documents.

### 13.8.3 Functional Indexes on JSON Paths

```sql
-- Index a specific JSON field:
ALTER TABLE products
    ADD INDEX idx_brand ((CAST(attributes->>'$.brand' AS CHAR(100))));

-- Query uses the functional index:
EXPLAIN SELECT * FROM products WHERE attributes->>'$.brand' = 'Acme';
-- type: ref, key: idx_brand

-- Multi-valued index on a JSON array (MySQL 8.0.17+):
ALTER TABLE products
    ADD INDEX idx_tags ((CAST(attributes->'$.tags' AS CHAR(50) ARRAY)));

-- Query:
SELECT * FROM products
WHERE JSON_CONTAINS(attributes->'$.tags', '"electronics"');
-- Or:
SELECT * FROM products
WHERE 'electronics' MEMBER OF (attributes->'$.tags');
-- Both can use the multi-valued index
```

### 13.8.4 JSON vs Proper Columns — Decision Guide

| Factor | Use JSON Column | Use Proper Column |
|--------|----------------|-------------------|
| Query frequency | Rarely filtered/sorted | Frequently in WHERE/ORDER BY |
| Schema stability | Changes frequently | Stable |
| Type safety | Not critical | Important (FK, CHECK constraints) |
| Indexing needs | Occasional functional index | Full B+Tree index |
| JOIN participation | Never/rarely | Frequently |
| Application pattern | Flexible attributes, config, metadata | Core business data |
| Reporting | Ad hoc, rare | Regular, SLA-bound |

**>>> "JSON columns are for flexible, semi-structured data that is written more
than it is queried. If you find yourself adding functional indexes to more
than 2-3 JSON paths, those paths should be proper columns. JSON is not a
substitute for schema design — it is an escape hatch for genuinely variable
attributes."**

---

## 13.9 Schema Anti-Patterns That Kill Performance

### 13.9.1 Too Many Indexes

Every secondary index is a separate B+Tree that must be maintained on every
INSERT, UPDATE (if indexed columns change), and DELETE. The cost is not just
storage — it is write amplification.

```
  Table with 10 secondary indexes, 1 million inserts/day:

  Each INSERT:
  - 1 write to clustered index (the row itself)
  - 10 writes to secondary index B+Trees (one entry per index)
  - 11 redo log entries
  - 11 potential page splits
  - Total: ~11x write amplification

  Binlog:
  - ROW format records the full row once, but the applier on the replica
    must also maintain all 10 secondary indexes → replica CPU bottleneck

  Buffer pool:
  - 10 secondary indexes × N pages each = 10N pages competing for pool space
  - Index pages for rarely-used indexes evict hot data pages

  Rule of thumb: 5-7 secondary indexes per table maximum.
  Each additional index beyond that must justify its existence with
  a specific, measured query improvement.
```

### 13.9.2 Too-Wide Rows

```
  Row size vs B+Tree height (16 KB pages):

  Row size   Rows/page   Pages for 10M rows   B+Tree levels
  ─────────────────────────────────────────────────────────
  100 B      ~150        66,667               2-3
  500 B      ~30         333,333              3
  2,000 B    ~7          1,428,571            4
  8,000 B    ~1-2        5,000,000+           5

  Wider rows → fewer rows per page → taller tree → more I/O per query.

  A table scan that reads 10M rows:
    100 B rows: read ~67K pages = ~1 GB of I/O
    2 KB rows:  read ~1.4M pages = ~22 GB of I/O
```

### 13.9.3 TEXT/BLOB Mixed with Small Columns

When a row contains both frequently-accessed small columns (status, created_at,
user_id) and rarely-accessed large columns (description TEXT, profile_photo
BLOB), the large columns cause problems:

```
  DYNAMIC row format (default in 8.0):
  - Columns <= 768 bytes: stored inline on the page
  - Columns > 768 bytes (or entire row > ~8KB): stored off-page
    with a 20-byte pointer in the row

  Problem: even with off-page storage, the 20-byte pointer per overflow
  column is inline. And if the TEXT column is small enough to be inline
  (e.g., a 500-byte TEXT value), it wastes space on pages that are
  frequently scanned for the small columns.

  Solution: vertical table split
```

```sql
-- Before: one wide table
CREATE TABLE products (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    status TINYINT UNSIGNED NOT NULL,
    description TEXT,             -- rarely read in list views
    specifications TEXT,          -- rarely read in list views
    manual_pdf MEDIUMBLOB         -- almost never read
);

-- After: split into hot and cold tables
CREATE TABLE products (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    status TINYINT UNSIGNED NOT NULL,
    INDEX idx_status (status, price)
);

CREATE TABLE product_details (
    product_id BIGINT UNSIGNED PRIMARY KEY,  -- FK to products.id
    description TEXT,
    specifications TEXT,
    manual_pdf MEDIUMBLOB
);

-- List view: SELECT id, name, price, status FROM products WHERE status = 1;
-- (Fast: narrow rows, more rows per page, better buffer pool utilization)
--
-- Detail view: SELECT p.*, d.* FROM products p
--              JOIN product_details d ON d.product_id = p.id WHERE p.id = 42;
-- (One extra JOIN, but only for single-row detail views)
```

### 13.9.4 ENUM for Frequently Changing Values

```sql
-- ENUM is stored as a 1-2 byte integer internally
CREATE TABLE tickets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    status ENUM('open', 'in_progress', 'resolved', 'closed') NOT NULL
);

-- Adding a new value at the end (MySQL 8.0):
ALTER TABLE tickets MODIFY status
    ENUM('open', 'in_progress', 'resolved', 'closed', 'reopened');
-- This is an INSTANT operation in 8.0 — metadata-only change.
-- But in 5.7: full table copy.

-- However: reordering or removing values requires a full table rebuild.
-- And: application code must handle the mapping (integer ↔ string).

-- Alternative: TINYINT with application-level enum mapping
-- More flexible, no ALTER TABLE for new values, same 1-byte storage
```

### 13.9.5 Missing AUTO_INCREMENT PK (The Hidden Mutex)

As discussed in section 13.2.7, tables without an explicit PK use a global
ROW_ID counter. But there is a second, more subtle problem:

```
  Without explicit PK, InnoDB uses the first UNIQUE NOT NULL index as the
  clustered index. If no such index exists, InnoDB uses the hidden ROW_ID.

  Problem with UNIQUE NOT NULL as implicit PK:
  - The chosen column (e.g., email VARCHAR(320)) becomes the clustered index
  - All secondary indexes store this value (320 bytes max!) as the row locator
  - Inserts are ordered by email, not by time → random insert pattern
  - This combines the worst of both worlds: random inserts AND wide PKs

  Rule: always define an explicit BIGINT AUTO_INCREMENT PRIMARY KEY,
  even on tables that have a natural unique key. Add the natural key
  as a separate UNIQUE index.
```

### 13.9.6 Foreign Keys at Scale

Foreign keys provide referential integrity at the database level, but at scale
they introduce significant costs:

```
  Foreign key check mechanics:

  INSERT INTO orders (customer_id, ...) VALUES (42, ...);
  Before inserting, InnoDB:
  1. Acquires a shared lock on customers.id = 42
  2. Verifies the row exists
  3. Holds the shared lock until the INSERT transaction commits

  DELETE FROM customers WHERE id = 42;
  Before deleting, InnoDB:
  1. Acquires an exclusive lock on customers.id = 42
  2. Checks all child tables (orders, addresses, payments, ...)
     for rows referencing customer_id = 42
  3. If ON DELETE CASCADE: acquires exclusive locks on all child rows
     and deletes them — potentially cascading to grandchild tables

  Costs at scale:
  - Shared locks on parent table for every child INSERT → contention
  - CASCADE deletes can lock hundreds of rows across multiple tables
  - Each FK check is an additional index lookup (even if the child table
    is large and the FK index is cold in the buffer pool)
  - Replication: CASCADE operations generate additional binlog events
    on the primary, increasing binlog volume and replica lag
  - Online schema changes: gh-ost and pt-osc do not support FK
    (the shadow table cannot have FKs pointing to/from other tables)
```

```
  FK cascade lock amplification:

  DELETE FROM customers WHERE id = 42
  │
  ├── CASCADE → DELETE FROM orders WHERE customer_id = 42
  │   │          (acquires X-locks on all matching order rows)
  │   │
  │   ├── CASCADE → DELETE FROM order_items WHERE order_id IN (...)
  │   │              (acquires X-locks on all matching item rows)
  │   │
  │   └── CASCADE → DELETE FROM payments WHERE order_id IN (...)
  │                  (acquires X-locks on all matching payment rows)
  │
  └── CASCADE → DELETE FROM addresses WHERE customer_id = 42
                 (acquires X-locks on all matching address rows)

  A single DELETE on the parent can cascade into hundreds or thousands
  of exclusive locks across 4+ tables — in one transaction.
  If any of those rows are concurrently locked by another transaction
  → deadlock or extended lock-wait timeout.
```

**Recommendation at scale**: enforce referential integrity in the application
layer (or via async consistency checks) and drop foreign key constraints in the
database. This is the approach used by virtually all large-scale MySQL
deployments (Facebook, Uber, Shopify, GitHub).

**>>> "Foreign keys are correct in theory but costly at scale. CASCADE deletes
cause lock amplification across tables, replication lag from extra binlog
events, and block gh-ost/pt-osc schema migrations. The industry consensus for
high-scale MySQL: enforce referential integrity in application code, run
periodic consistency checks, and skip FK constraints in the schema."**

---

## 13.10 Putting It All Together — A Schema Design Checklist

Before every `CREATE TABLE`, run through this checklist:

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                    SCHEMA DESIGN CHECKLIST                         │
  ├─────────────────────────────────────────────────────────────────────┤
  │                                                                     │
  │  PRIMARY KEY                                                        │
  │  [ ] Explicit BIGINT UNSIGNED AUTO_INCREMENT                        │
  │  [ ] Or Snowflake/ULID if distributed                               │
  │  [ ] Never UUID v4                                                  │
  │  [ ] Never composite natural PK (unless bridge/join table)          │
  │                                                                     │
  │  DATA TYPES                                                         │
  │  [ ] Smallest type that fits: TINYINT before INT before BIGINT      │
  │  [ ] DECIMAL for money, never FLOAT/DOUBLE                          │
  │  [ ] DATETIME(3) instead of TIMESTAMP for new columns               │
  │  [ ] VARCHAR sized to actual max, not default 255                   │
  │  [ ] utf8mb4 character set, consistent across all tables            │
  │                                                                     │
  │  NULLABILITY                                                        │
  │  [ ] Every column NOT NULL unless NULL has semantic meaning          │
  │  [ ] No nullable columns in unique indexes (unless intentional)     │
  │  [ ] Sentinels (0, '', '1970-01-01') instead of NULL when possible  │
  │                                                                     │
  │  INDEXES                                                            │
  │  [ ] Maximum 5-7 secondary indexes per table                        │
  │  [ ] Multi-tenant: tenant_id is leading column in every index       │
  │  [ ] No redundant indexes (a is redundant if (a,b) exists)          │
  │  [ ] No unused indexes (check sys.schema_unused_indexes)            │
  │                                                                     │
  │  LARGE COLUMNS                                                      │
  │  [ ] TEXT/BLOB in separate table if not needed in list queries       │
  │  [ ] JSON for flexible attributes with functional indexes           │
  │  [ ] No TEXT/BLOB in composite indexes                              │
  │                                                                     │
  │  REFERENTIAL INTEGRITY                                              │
  │  [ ] Application-level enforcement at scale (no FK constraints)     │
  │  [ ] Periodic async consistency checks                              │
  │  [ ] Soft delete with proper index design                           │
  │                                                                     │
  │  FUTURE-PROOFING                                                    │
  │  [ ] Schema changes possible via gh-ost (no FK, ROW binlog)         │
  │  [ ] ENUM values only for truly stable sets (use TINYINT otherwise) │
  │  [ ] Partition strategy for time-series/audit tables                │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## 13.11 Interview Quick-Reference

| Topic | Key Point | Depth |
|-------|-----------|-------|
| PK type | BIGINT AUTO_INCREMENT (single master) or Snowflake (distributed). Never UUID v4 | PK is the clustered index; 16B UUID → 2x secondary index overhead vs 8B BIGINT |
| PK size ripple | PK appended to every secondary index entry | 5 indexes × (16B - 8B) × 1B rows = 40 GB extra I/O |
| UUID v4 problem | Random inserts → page splits → 50-65% page fill → taller B+Tree | Explain the page split diagram |
| TIMESTAMP vs DATETIME | TIMESTAMP: 4B, UTC, 2038 limit. DATETIME: 5B, no tz, no limit | DATETIME(3) is the safe default |
| NULL | Indexed in InnoDB, bitmap overhead, != ignores NULLs, composite unique allows duplicates | Make columns NOT NULL unless semantic NULL required |
| utf8mb4 | 4 bytes/char max. Sort buffers allocated by max size. Charset mismatch kills index usage | Always verify charset consistency in JOINs |
| Online DDL | INSTANT (metadata) > INPLACE > COPY. MDL lock risk in all modes | gh-ost for large tables: binlog-based, no triggers, pausable |
| Denormalization | Trade write complexity for read speed. Precomputed aggregates, copy columns, summary tables | Start normalized, denormalize measured bottlenecks |
| FK at scale | CASCADE → lock amplification across tables. Blocks gh-ost. Industry drops FKs | Enforce in application code, async consistency checks |
| JSON | Binary format, partial updates (8.0.3+), functional indexes, multi-valued indexes (8.0.17+) | Use for flexible attributes; if >2-3 functional indexes, promote to columns |
| Multi-tenant | tenant_id as leading index column. Shared table for small tenants, DB-per-tenant for large | Missing tenant_id in WHERE = data leak + full scan |
| Soft delete | deleted_at NULL = active. Unique constraint problem. ID exhaustion acceleration | Periodic archival, composite unique with discriminator |
| Vertical split | Separate hot (narrow, frequent) from cold (wide, rare) columns | Reduces rows/page penalty, improves buffer pool hit ratio |

---

## Summary

Schema design is where database theory meets physical reality. The decisions
in this chapter — data types, primary keys, normalization, NULL handling,
character sets — are not academic preferences. They are engineering constraints
that determine B+Tree height, buffer pool efficiency, replication throughput,
and operational flexibility for schema changes.

The key insight of this chapter: **every byte in a row is amplified**. It is
amplified across the clustered index, across every secondary index, across
every page in the buffer pool, across every binlog event, across every replica,
across every backup. A 4-byte savings per row in a billion-row table with 5
secondary indexes saves 24 GB of I/O surface area. Schema design is the
highest-leverage optimization because it multiplies through every layer of the
system we studied in Part 1.

The next chapter (Chapter 14: Indexing Mastery and Query Optimization) builds
on this foundation. With the right schema in place, we turn to the problem of
designing indexes that make the optimizer's job trivial — covering indexes,
index condition pushdown, and the art of reading EXPLAIN output.

---
