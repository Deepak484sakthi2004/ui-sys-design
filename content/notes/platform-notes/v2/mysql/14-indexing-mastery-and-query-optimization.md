# Chapter 14: Indexing Mastery and Query Optimization

## How to Design Indexes That Make the Optimizer's Job Trivial

---

Part 1 of this book gave you the internal machinery: B+Trees, buffer pool eviction,
cost-based optimization, the iterator executor. Now you wield that knowledge. This
chapter is the bridge between understanding how MySQL works and making it work for
you. Every index design decision here is grounded in the physical structures from
Chapter 5 and the optimizer behavior from Chapter 2. If you internalized those chapters,
the "rules" in this one will feel inevitable rather than arbitrary.

The goal is simple: by the time the optimizer sees your query, the right index
should make the execution plan obvious. No hints. No hacks. Just an index whose
B+Tree structure aligns perfectly with the query's access pattern, so the optimizer's
cost estimates point to the correct plan by a wide margin.

---

## 14.1 Indexing Fundamentals Recap

Before composite index design, make sure the mechanical foundation is airtight.

### 14.1.1 Clustered Index — The Table IS the Index

In InnoDB, the primary key B+Tree IS the table. Leaf pages of the clustered index
contain the full row data — every column, including BLOBs stored inline (up to 768
bytes for DYNAMIC/COMPACT format, with overflow pages for the rest).

```
CLUSTERED INDEX (PRIMARY KEY B+Tree)
═══════════════════════════════════════════════════════════════════

  Internal nodes: [PK value | child page pointer]
  Leaf nodes:     [PK value | trx_id | roll_ptr | col1 | col2 | ... | colN]

  ┌─────────────────────────────────┐
  │        Root Page (level 2)       │
  │   ┌────┬────┬────┬────┐        │
  │   │ 100│ 500│1000│    │        │
  │   └─┬──┴─┬──┴──┬─┴────┘        │
  └─────┼────┼─────┼───────────────┘
        │    │     │
        ▼    ▼     ▼
  ┌─────────┐ ┌─────────┐ ┌─────────┐
  │ Leaf pg  │ │ Leaf pg  │ │ Leaf pg  │
  │ PK 1-99  │ │PK 100-499│ │PK 500-999│
  │          │ │          │ │          │
  │ row data │ │ row data │ │ row data │
  │ (ALL cols)│ │ (ALL cols)│ │ (ALL cols)│
  └─────────┘ └─────────┘ └─────────┘
       ↕            ↕            ↕
   (doubly linked via page header prev/next pointers)
```

Key properties:

- **One per table.** InnoDB requires a clustered index. If you define a PK, that is
  the clustered index. If you don't, InnoDB looks for the first UNIQUE NOT NULL index.
  If none exists, InnoDB creates a hidden 6-byte `GEN_CLUST_INDEX` (row ID).

- **Row order = PK order.** Rows are physically ordered by primary key within each page
  and logically ordered across pages via the doubly-linked leaf page list. A sequential
  PK scan is sequential I/O.

- **PK is implicitly appended to every secondary index.** This is not optional. The PK
  is how a secondary index lookup reaches the actual row data. A wide PK bloats every
  secondary index.

>>> **Interview critical**: "Why should you avoid a UUID primary key in InnoDB?" Three
>>> reasons: (1) Random inserts cause page splits across the entire B+Tree instead of
>>> appending to the rightmost leaf — write amplification. (2) A 16-byte UUID (or 36-byte
>>> string UUID) is appended to every secondary index entry, increasing index size by 2-4x
>>> compared to a 4-byte INT or 8-byte BIGINT. (3) Sequential scans become random I/O because
>>> logically adjacent rows are scattered across pages.

### 14.1.2 Secondary Index — The Detour Through the PK

A secondary index is a separate B+Tree whose leaf entries contain:
`(indexed_column_values, primary_key_value)`.

```
SECONDARY INDEX on (status, category)
═══════════════════════════════════════════════════════════════════

  Leaf entry: [status | category | PK]

  ┌──────────────────────────────────────────────────────────┐
  │  ('active','books',42) → ('active','books',187) →       │
  │  ('active','electronics',5) → ('active','electronics',91)│
  │  → ('inactive','books',33) → ...                         │
  └──────────────────────────────────────────────────────────┘

  To get the full row for PK=42:
  1. Find entry in secondary index leaf: O(log N)
  2. Take PK value (42)
  3. Traverse clustered index with PK=42: O(log N)  ← "bookmark lookup"
  4. Read full row from clustered index leaf
```

This two-step lookup is called a **bookmark lookup** (or "clustered index lookup" or
"table lookup"). It is the primary cost of using a secondary index when the query
needs columns not in the index.

The optimizer makes a critical decision: if the estimated number of rows from the
secondary index is high (typically >15-20% of the table), the cost of all those random
bookmark lookups exceeds the cost of a full clustered index scan. The optimizer
chooses a table scan instead. This is usually the correct decision.

### 14.1.3 Covering Index — Eliminating the Bookmark Lookup

A covering index contains all columns the query needs — in the SELECT list, WHERE
clause, ORDER BY, and GROUP BY. When the optimizer detects this, it never touches
the clustered index at all. EXPLAIN shows `Using index` in the Extra column.

```sql
-- Query
SELECT status, category, COUNT(*) 
FROM products 
WHERE status = 'active' 
GROUP BY status, category;

-- Covering index
CREATE INDEX idx_status_cat ON products(status, category);

-- EXPLAIN Extra: "Using index"
-- The secondary index contains status and category.
-- COUNT(*) only needs to count entries — no row data needed.
-- Zero bookmark lookups. Pure secondary index scan.
```

The performance difference can be dramatic: a covering index scan reads only the
compact secondary index pages (maybe 100 MB), while the bookmark lookup path would
read the full row data from clustered index pages (maybe 10 GB), one random I/O
per row.

### 14.1.4 The Cost of Indexes

Indexes are not free. Every index imposes costs:

```
COST MATRIX FOR EACH SECONDARY INDEX
═══════════════════════════════════════════════════════════════════

  ┌──────────────────┬──────────────────────────────────────────┐
  │ Write amplification │ Every INSERT writes to clustered index │
  │                     │ + one B+Tree insert per secondary idx  │
  │                     │ UPDATE of indexed col: delete + insert │
  │                     │ in the secondary index's B+Tree        │
  │                     │ DELETE: mark for purge in every index  │
  ├──────────────────┼──────────────────────────────────────────┤
  │ Change buffer    │ Secondary index changes on non-unique    │
  │ pressure         │ indexes are buffered in the change buffer│
  │                  │ (in-memory). Merged lazily. But under    │
  │                  │ heavy write load, merges become a        │
  │                  │ bottleneck (change buffer mutex).         │
  ├──────────────────┼──────────────────────────────────────────┤
  │ Storage          │ Each index is a full B+Tree on disk.     │
  │                  │ A table with 5 secondary indexes may     │
  │                  │ have 3x the disk footprint of the table  │
  │                  │ data alone.                              │
  ├──────────────────┼──────────────────────────────────────────┤
  │ Buffer pool      │ Index pages compete with data pages for  │
  │ pressure         │ buffer pool space. More indexes = more   │
  │                  │ pages to cache = more eviction pressure. │
  ├──────────────────┼──────────────────────────────────────────┤
  │ Optimizer cost   │ More indexes = more possible_keys for    │
  │                  │ the optimizer to evaluate. Marginally    │
  │                  │ increases planning time.                 │
  └──────────────────┴──────────────────────────────────────────┘
```

Rule of thumb for high-write OLTP tables: **5-7 secondary indexes maximum**. Every
index beyond that should have a demonstrated query that justifies its maintenance cost.
Read-heavy analytics tables can tolerate more — the write cost is amortized over
fewer writes.

---

## 14.2 Composite Index Design — The ESR Rule

The ESR rule (Equality, Sort, Range) is the single most important heuristic for
composite index design. It emerges directly from B+Tree mechanics.

### 14.2.1 Why Column Order Matters

A composite index `(a, b, c)` sorts entries lexicographically: first by `a`, then
by `b` within each value of `a`, then by `c` within each `(a, b)` pair. This is
identical to how a phone book sorts by last name, then first name, then middle name.

```
COMPOSITE INDEX (status, category, created_at)
═══════════════════════════════════════════════════════════════════

  B+Tree leaf entries are sorted:

  ('active', 'books',      '2024-01-01 00:00:00', PK=42)
  ('active', 'books',      '2024-01-15 12:30:00', PK=187)
  ('active', 'books',      '2024-02-01 08:00:00', PK=5)
  ('active', 'electronics','2024-01-03 09:15:00', PK=91)
  ('active', 'electronics','2024-01-20 14:00:00', PK=300)
  ('active', 'electronics','2024-03-01 11:30:00', PK=88)
  ('inactive','books',     '2023-06-01 00:00:00', PK=33)
  ('inactive','books',     '2024-01-10 16:45:00', PK=201)
  ('inactive','electronics','2023-12-01 00:00:00', PK=77)

  Within status='active' AND category='books':
    → entries are sorted by created_at
    → a range scan or ORDER BY on created_at is FREE
```

The critical insight: **after an equality prefix, the next column in the index is
sorted.** But after a range condition, subsequent columns are NOT sorted from the
B+Tree's perspective.

### 14.2.2 The ESR Rule Explained

**E — Equality columns first**: columns compared with `=` or `IN`. These define the
exact prefix that positions us in the B+Tree. The optimizer can navigate to the exact
starting point.

**S — Sort columns next**: columns in `ORDER BY` (or `GROUP BY`). Because the B+Tree
entries after the equality prefix are already sorted by the next column(s), the
storage engine returns rows in the correct order. No filesort needed.

**R — Range columns last**: columns with `>`, `<`, `>=`, `<=`, `BETWEEN`, `!=`. A
range condition breaks the sort order for subsequent columns. The B+Tree can still
use the range to limit the scan, but any columns after the range column in the index
cannot be used for sorting or further range narrowing.

```
WHY RANGE BREAKS SORT — B+Tree Mechanics
═══════════════════════════════════════════════════════════════════

  INDEX(a, b, c)

  Query: WHERE a = 5 AND b > 10 ORDER BY c

  B+Tree entries where a=5:
    (5, 8,  100)   ← b=8 < 10, skipped by range
    (5, 8,  200)   ← skipped
    (5, 11, 50)    ← b=11 > 10, included. c=50
    (5, 11, 300)   ← included. c=300
    (5, 12, 10)    ← included. c=10
    (5, 12, 150)   ← included. c=150
    (5, 20, 5)     ← included. c=5

  Within the range b > 10, the c values are: 50, 300, 10, 150, 5
  → NOT sorted! The B+Tree sorts by b first, then c within each b.
  → Across different b values, c values are interleaved.
  → MySQL MUST filesort to produce ORDER BY c.

  If the query were ORDER BY b, c — that IS the B+Tree order, no filesort.
```

### 14.2.3 ESR Walkthrough — A Real Query

```sql
SELECT id, name, price 
FROM products
WHERE status = 'active' AND category = 'electronics'
ORDER BY created_at DESC
LIMIT 20;
```

**Step 1 — Classify each clause:**

| Clause | Columns | ESR Role |
|--------|---------|----------|
| `WHERE status = 'active'` | status | E (equality) |
| `WHERE category = 'electronics'` | category | E (equality) |
| `ORDER BY created_at DESC` | created_at | S (sort) |
| `SELECT id, name, price` | id, name, price | Covering candidates |

**Step 2 — Build the index in ESR order:**

```
Equality:  status, category           ← exact B+Tree prefix
Sort:      created_at DESC            ← next in index, no filesort
Range:     (none)                     ← nothing to add
Covering:  price, name, id           ← append for covering index

Final index: (status, category, created_at DESC, price, name, id)
```

Note: `id` is the PK, so InnoDB appends it automatically. You can omit it from the
CREATE INDEX, but including it explicitly does no harm and makes the covering intent
clear.

```sql
CREATE INDEX idx_prod_esr ON products(
    status, category, created_at DESC, price, name
);
```

**Step 3 — Verify with EXPLAIN:**

```
+----+------+------+---------------+--------------+---------+------+------+----------+--------------------------+
| id | type | rows | possible_keys | key          | key_len | ref  | rows | filtered | Extra                    |
+----+------+------+---------------+--------------+---------+------+------+----------+--------------------------+
|  1 | ref  |   20 | idx_prod_esr  | idx_prod_esr | 206     |const,|   20 |   100.00 | Using where; Using index |
|    |      |      |               |              |         |const |      |          | Backward index scan      |
+----+------+------+---------------+--------------+---------+------+------+----------+--------------------------+
```

What this tells us:
- `type = ref`: equality lookup on the index prefix — excellent
- `key_len = 206`: both status and category columns are used (full equality prefix)
- `rows = 20`: optimizer estimates scanning only 20 rows (LIMIT optimization)
- `Using index`: covering index — no clustered index lookups
- `Backward index scan`: scanning DESC on an ASC-ordered part (or vice versa — MySQL 8.0
  supports DESC index columns natively, so with `created_at DESC` in the index definition
  this would disappear)

>>> **Interview critical**: "Explain the ESR rule and why range must come last." The
>>> B+Tree sorts entries lexicographically. Equality columns define an exact prefix — like
>>> turning to the right page in a phone book. Within that prefix, the next column is sorted,
>>> so ORDER BY is free. A range condition (>, <) scans across multiple values of that column,
>>> and within those different values, subsequent columns are NOT in a single sorted order.
>>> So range breaks the sort guarantee for everything after it.

### 14.2.4 DESC Indexes (MySQL 8.0)

Before MySQL 8.0, index column direction was parsed but ignored — all B+Tree entries
were stored in ascending order. A `Backward index scan` was used for DESC ORDER BY,
which reads the B+Tree's doubly-linked leaf list in reverse. This works but is
slightly slower than forward scan (CPU branch prediction penalties, prefetch
direction).

MySQL 8.0 added true DESC index support:

```sql
CREATE INDEX idx_created_desc ON products(status, category, created_at DESC);
```

The B+Tree physically stores `created_at` values in descending order within each
`(status, category)` prefix. A forward scan now produces DESC order directly.

This matters most for multi-column ORDER BY with mixed directions:

```sql
ORDER BY category ASC, created_at DESC

-- Requires: INDEX(category ASC, created_at DESC)
-- Without DESC index support, this always requires filesort.
```

### 14.2.5 When ESR Does Not Apply

**OR conditions:**

```sql
WHERE status = 'active' OR region = 'US'
```

A single composite index cannot serve both sides of an OR. The B+Tree prefix is
`status` or `region`, not both. Options:
- Two separate indexes + index merge (optimizer intersects/unions two index scans)
- Rewrite as `UNION ALL` of two queries, each using its own index
- Index merge is often slower than expected — verify with EXPLAIN ANALYZE

**IN lists with ORDER BY:**

```sql
WHERE status IN ('active', 'pending') ORDER BY created_at
```

With index `(status, created_at)`: the B+Tree has two separate sorted ranges —
one for `status='active'` and one for `status='pending'`. Within each, `created_at`
is sorted. But across both, it is not. MySQL performs a merge of two sorted streams
internally. For small IN lists (2-3 values), this works well. For large IN lists,
the merge cost grows.

```
INDEX(status, created_at):

  ('active',  '2024-01-01') ← sorted within 'active'
  ('active',  '2024-01-15')
  ('active',  '2024-02-01')
  ('pending', '2024-01-03') ← sorted within 'pending'
  ('pending', '2024-01-20')
  ('pending', '2024-03-01')

  Combined ORDER BY created_at:
  → '2024-01-01', '2024-01-03', '2024-01-15', '2024-01-20', ...
  → Requires merging two sorted streams (or filesort)
```

**Functions on indexed columns:**

```sql
WHERE DATE(created_at) = '2024-01-01'
```

The B+Tree stores `created_at` values, not `DATE(created_at)` values. The function
transforms the column, making the index unusable. This is covered in depth in
Section 14.5.

---

## 14.3 Index Selection Methodology

Designing indexes one query at a time produces index bloat. A systematic approach
considers the query workload as a whole.

### 14.3.1 Step 1 — Collect the Top Queries

**Slow query log (traditional):**

```ini
# my.cnf
slow_query_log = ON
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 0.5          # 500ms threshold
log_queries_not_using_indexes = ON
min_examined_row_limit = 100   # skip trivial queries
```

**Performance Schema digest (preferred for production):**

```sql
SELECT 
    DIGEST_TEXT,
    COUNT_STAR AS exec_count,
    ROUND(AVG_TIMER_WAIT / 1e12, 3) AS avg_sec,
    ROUND(SUM_TIMER_WAIT / 1e12, 1) AS total_sec,
    SUM_ROWS_EXAMINED AS total_rows_examined,
    SUM_ROWS_SENT AS total_rows_sent,
    ROUND(SUM_ROWS_EXAMINED / NULLIF(SUM_ROWS_SENT, 0), 0) AS exam_to_sent_ratio
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = 'mydb'
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 20;
```

The `exam_to_sent_ratio` is critical: a query that examines 1,000,000 rows to send
10 rows has a ratio of 100,000 — it is almost certainly missing an index or using
a bad access pattern.

**Aggregate with pt-query-digest:**

```bash
pt-query-digest /var/log/mysql/slow.log \
  --limit=20 \
  --order-by=Query_time:sum

# Output:
# Profile
# Rank Query ID                       Response time   Calls  R/Call
# ==== ============================== =============== ====== ======
#    1 0x1234ABCD select products ... 1542.0000 45.2%   8934 0.1726
#    2 0x5678EFGH select orders j...   832.0000 24.4%   2100 0.3962
#    3 0x9ABC1234 update inventory..   410.0000 12.0%  15200 0.0270
```

### 14.3.2 Step 2 — ESR Analysis Per Query

For each of the top 20 queries, decompose into E, S, R components:

```
Query #1: SELECT id, name, price FROM products
          WHERE status = 'active' AND category = ?
          ORDER BY created_at DESC LIMIT 20

  E: status, category
  S: created_at DESC
  R: (none)
  Cover: price, name
  → INDEX(status, category, created_at DESC, price, name)

Query #2: SELECT o.id, o.total FROM orders o
          JOIN order_items oi ON o.id = oi.order_id
          WHERE o.user_id = ? AND o.created_at > ?
          ORDER BY o.created_at DESC

  orders table:
    E: user_id
    S: created_at DESC
    R: created_at > ? — but created_at is also sort column!
    → When a column is both S and R: put it in the S position.
       The range will limit the scan; the sort comes from index order.
    → INDEX orders(user_id, created_at DESC)

  order_items table:
    E: order_id (join key, eq_ref)
    → INDEX order_items(order_id) — likely already exists as FK
```

### 14.3.3 Step 3 — Merge Similar Indexes

After ESR analysis produces candidate indexes, look for overlap:

```
Candidates:
  INDEX(status, category, created_at DESC)
  INDEX(status, category, created_at DESC, price, name)
  INDEX(status, created_at DESC)

Merge rules:
  - (a, b) is a prefix of (a, b, c) → keep only (a, b, c)
  - (a, c) is NOT a prefix of (a, b, c) → both may be needed

Result:
  INDEX(status, category, created_at DESC, price, name)  ← covers queries 1 & partial
  INDEX(status, created_at DESC)                         ← separate, different prefix
```

### 14.3.4 Step 4 — Remove Redundant Indexes

```sql
-- sys schema (MySQL 8.0)
SELECT * FROM sys.schema_redundant_indexes
WHERE table_schema = 'mydb';

-- Output:
-- table_name | redundant_index    | redundant_index_columns | dominant_index      | dominant_index_columns
-- products   | idx_status         | status                  | idx_status_cat_date | status, category, created_at
```

Or use Percona Toolkit:

```bash
pt-duplicate-key-checker --host=localhost --databases=mydb

# Output:
# products.idx_status is a left-prefix of products.idx_status_cat_date
# Key definitions:
#   idx_status (status)
#   idx_status_cat_date (status, category, created_at)
# → DROP INDEX idx_status ON products;
```

### 14.3.5 Step 5 — Verify with EXPLAIN

Run EXPLAIN (and EXPLAIN ANALYZE for actual timings) on each top query after
creating the new indexes. Check:
- `key` matches the expected index
- `key_len` confirms the expected number of prefix columns are used
- `Extra` shows `Using index` (covering) where expected
- `rows` is reasonable (not scanning the entire table)
- No `Using filesort` or `Using temporary` unless expected

### 14.3.6 Step 6 — Monitor Index Usage

After indexes are in production, monitor which ones are actually used:

```sql
-- Unused indexes (sys schema)
SELECT * FROM sys.schema_unused_indexes
WHERE object_schema = 'mydb';

-- Per-index usage stats (Performance Schema)
SELECT 
    object_schema, object_name, index_name,
    count_read, count_write,
    count_fetch, count_insert, count_update, count_delete
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE object_schema = 'mydb'
  AND index_name IS NOT NULL
ORDER BY count_read ASC;
```

An index with `count_read = 0` and `count_write > 100000` is pure overhead — it is
maintained on every write but never used for reads. Drop it.

**Caveat**: reset Performance Schema statistics before measuring, and measure for at
least one full business cycle (1 week minimum) to catch weekly batch jobs.

---

## 14.4 EXPLAIN Deep Dive

EXPLAIN is the primary diagnostic tool. Every senior engineer must read EXPLAIN
output as fluently as reading a stack trace.

### 14.4.1 EXPLAIN (Traditional Format) — Column by Column

```sql
EXPLAIN SELECT o.id, o.total, c.name
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.status = 'shipped'
  AND o.created_at >= '2024-01-01'
ORDER BY o.created_at DESC
LIMIT 50;
```

```
+----+-------------+-------+--------+-------------------+-----------+---------+-----------+------+----------+------------------------------------------+
| id | select_type | table | type   | possible_keys     | key       | key_len | ref       | rows | filtered | Extra                                    |
+----+-------------+-------+--------+-------------------+-----------+---------+-----------+------+----------+------------------------------------------+
|  1 | SIMPLE      | o     | range  | idx_status_date,  | idx_stat  | 52      | NULL      |  320 |   100.00 | Using index condition; Backward idx scan |
|    |             |       |        | idx_cust          | us_date   |         |           |      |          |                                          |
|  1 | SIMPLE      | c     | eq_ref | PRIMARY           | PRIMARY   | 4       | db.o.cust |    1 |   100.00 | NULL                                     |
|    |             |       |        |                   |           |         | omer_id   |      |          |                                          |
+----+-------------+-------+--------+-------------------+-----------+---------+-----------+------+----------+------------------------------------------+
```

**Column-by-column analysis:**

**`id`** — The SELECT identifier. All rows with `id = 1` belong to the same SELECT.
Subqueries get higher id numbers. In a UNION, each SELECT has its own id.

**`select_type`** — How this SELECT relates to the overall query:

| Value | Meaning |
|-------|---------|
| `SIMPLE` | No subqueries or UNIONs |
| `PRIMARY` | Outermost SELECT in a subquery/UNION |
| `SUBQUERY` | First SELECT in a non-correlated subquery |
| `DEPENDENT SUBQUERY` | Correlated subquery — re-executed per outer row |
| `DERIVED` | Subquery in FROM clause (materialized to temp table) |
| `MATERIALIZED` | Subquery materialized into a temp table for semi-join |
| `UNION` | Second or later SELECT in a UNION |
| `UNION RESULT` | Result of the UNION (reads from temp table) |

**`type`** — The access method. This is the most important column. Listed from best
to worst:

```
ACCESS TYPE HIERARCHY (best to worst)
═══════════════════════════════════════════════════════════════════

  system   → Table has exactly 1 row (system table). Essentially a constant.

  const    → PK or UNIQUE index lookup, at most 1 row. The value is read
             once during optimization and substituted as a constant.
             Example: WHERE id = 42

  eq_ref   → PK or UNIQUE index lookup in a JOIN, exactly 1 row per
             join key. The best possible join type.
             Example: JOIN customers c ON o.customer_id = c.id

  ref      → Non-unique index lookup. Returns all rows matching the
             index prefix. Fast but may return multiple rows.
             Example: WHERE status = 'active' (non-unique index)

  fulltext → Fulltext index lookup.

  ref_or_null → Like ref, but also searches for NULL values.
                Example: WHERE col = 'x' OR col IS NULL

  index_merge → Multiple indexes used, results merged (union/intersect).
                Visible in Extra as "Using intersect(...)" or "Using union(...)".
                Often a sign that a composite index would be better.

  unique_subquery → IN subquery that uses a unique index.

  index_subquery → IN subquery that uses a non-unique index.

  range    → Index range scan using >, <, >=, <=, BETWEEN, IN, LIKE 'prefix%'.
             B+Tree navigates to start point, scans to end point.

  index    → Full index scan. Reads every entry in the secondary index.
             Better than ALL because index is smaller than full table,
             but still O(N). Seen when a covering index exists but no
             WHERE clause limits the scan.

  ALL      → Full table scan. Reads every row in the clustered index.
             The worst access type. Acceptable only for tiny tables or
             when the query genuinely needs all rows.
```

>>> **Interview insight**: "What is the difference between `ref` and `range`?" `ref`
>>> does an equality lookup on an index prefix — it navigates to one exact position in
>>> the B+Tree and reads all matching entries. `range` navigates to a start position
>>> and scans forward/backward to an end position. `ref` is typically faster because the
>>> B+Tree traversal is a single path; `range` may span many leaf pages.

**`possible_keys`** — All indexes the optimizer considered. If this is NULL, no index
covers any part of the WHERE clause.

**`key`** — The index actually chosen. If NULL, no index was used (table scan).

**`key_len`** — Bytes of the chosen index that are used. This is critical for
composite index analysis. See Section 14.4.3.

**`ref`** — What is compared to the index. Constants show as `const`, join columns
show as `db.table.column`, functions show as `func`.

**`rows`** — Estimated rows to examine. This comes from InnoDB's index statistics
(random sample of 20 leaf pages by default, controlled by
`innodb_stats_persistent_sample_pages`). The estimate can be significantly off for
skewed data distributions.

**`filtered`** — Estimated percentage of rows that pass conditions NOT covered by the
index. `rows × filtered / 100` = estimated rows after all WHERE conditions.

If rows = 1000 and filtered = 10%, the optimizer estimates 100 rows will actually
be returned. The remaining 90% are filtered at the SQL layer after the storage engine
returns them.

**`Extra`** — Additional execution details. Decoded in the next section.

### 14.4.2 Extra Column Decoded

Each flag in the Extra column tells you something specific about the execution path.

**`Using index`** — Covering index. The query is satisfied entirely from the secondary
index B+Tree. No clustered index access. This is the gold standard for read performance.

```sql
-- Triggers "Using index"
EXPLAIN SELECT status, category FROM products WHERE status = 'active';
-- With INDEX(status, category): both selected columns are in the index.
```

**`Using index condition`** — Index Condition Pushdown (ICP). The WHERE clause has
conditions on indexed columns that cannot be used for the B+Tree traversal but CAN
be evaluated by the storage engine while scanning the index, before performing the
bookmark lookup. This reduces the number of clustered index lookups.

```sql
-- Example: INDEX(last_name, first_name)
EXPLAIN SELECT * FROM employees
WHERE last_name LIKE 'Sm%' AND first_name LIKE 'J%';

-- Without ICP: 
--   1. Scan index for last_name LIKE 'Sm%' (range condition on first col)
--   2. For EVERY matching entry, do bookmark lookup to get full row
--   3. Apply first_name LIKE 'J%' at SQL layer → most rows discarded
--
-- With ICP:
--   1. Scan index for last_name LIKE 'Sm%'  
--   2. For each index entry, check first_name LIKE 'J%' IN THE ENGINE
--   3. Only do bookmark lookup for entries that pass BOTH conditions
--   → Far fewer clustered index lookups
```

**`Using where`** — Filter applied at the SQL layer. The storage engine returned rows,
and the SQL layer discards those that don't match remaining WHERE conditions. If you
see this without `Using index condition`, it means filtering happens AFTER the
bookmark lookup — the expensive path.

**`Using filesort`** — The result must be sorted, and no index provides the needed
order. MySQL sorts in memory (if the data fits in `sort_buffer_size`, default 256 KB)
or spills to disk. For large result sets, this is expensive.

```sql
-- Triggers "Using filesort"
EXPLAIN SELECT * FROM products WHERE status = 'active' ORDER BY price;
-- INDEX(status): provides the WHERE filter but NOT the ORDER BY.
-- INDEX(status, price): would eliminate filesort.
```

**`Using temporary`** — An intermediate temporary table is needed. Common with
GROUP BY on columns that don't match the index order, DISTINCT with non-indexed
columns, or UNION operations. The temp table lives in memory (TempTable engine,
`temptable_max_ram` default 1 GB in 8.0) or spills to disk.

**`Using join buffer (Block Nested Loop)`** / **`(hash join)`** — No usable index
for the join. Pre-8.0.18: rows are buffered in `join_buffer_size` and batch-scanned.
8.0.18+: replaced by hash join. Either way, this usually means a missing index on
the join column.

**`Using MRR`** — Multi-Range Read optimization. Row IDs from an index scan are
sorted by PK before fetching from the clustered index. Converts random I/O to
sequential I/O. Controlled by `optimizer_switch='mrr=on,mrr_cost_based=on'`.

**`Backward index scan`** — The B+Tree is scanned in reverse order (following
prev-page pointers instead of next-page pointers). Happens when ORDER BY DESC on
an ASC index column. Slightly slower than forward scan. Use DESC index columns
(MySQL 8.0) to avoid this.

### 14.4.3 key_len Analysis — Decoding Composite Index Usage

`key_len` tells you exactly how many columns of a composite index are being used.
This is one of the most underutilized diagnostic tools.

**Byte sizes by column type:**

```
DATA TYPE BYTE SIZES FOR key_len
═══════════════════════════════════════════════════════════════════

  Type                      NOT NULL    NULLable    Notes
  ─────────────────────────────────────────────────────────────────
  TINYINT                   1           2           +1 for null flag
  SMALLINT                  2           3
  MEDIUMINT                 3           4
  INT                       4           5
  BIGINT                    8           9
  FLOAT                     4           5
  DOUBLE                    8           9
  DATE                      3           4
  DATETIME                  5           6           (8.0, no frac sec)
  DATETIME(6)               8           9           (with microseconds)
  TIMESTAMP                 4           5
  CHAR(N) utf8mb4           N × 4      N × 4 + 1   4 bytes per char
  VARCHAR(N) utf8mb4        N × 4 + 2  N × 4 + 3   +2 for length prefix
  VARCHAR(N) latin1         N + 2      N + 3
  VARCHAR(N) utf8           N × 3 + 2  N × 3 + 3   3 bytes per char
```

**Worked example:**

```sql
CREATE TABLE products (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(20) NOT NULL,       -- utf8mb4: 20×4 + 2 = 82 bytes
    category VARCHAR(50) NOT NULL,     -- utf8mb4: 50×4 + 2 = 202 bytes
    created_at DATETIME NOT NULL,      -- 5 bytes
    price DECIMAL(10,2) NOT NULL,      -- 5 bytes
    name VARCHAR(100) NOT NULL         -- utf8mb4: 100×4 + 2 = 402 bytes
);

CREATE INDEX idx_esr ON products(status, category, created_at, price, name);

-- key_len values for different queries:
--
-- WHERE status = 'active'
--   key_len = 82 (only status used)
--
-- WHERE status = 'active' AND category = 'electronics'
--   key_len = 82 + 202 = 284 (status + category)
--
-- WHERE status = 'active' AND category = 'electronics' AND created_at >= '2024-01-01'
--   key_len = 82 + 202 + 5 = 289 (status + category + created_at)
--
-- WHERE status = 'active' AND category = 'electronics' 
--   AND created_at >= '2024-01-01' AND price > 100
--   key_len = 289 (still 289! price is after a range on created_at,
--   so the B+Tree can't use it for further narrowing. price is
--   filtered via ICP or WHERE, not via index traversal.)
```

>>> **Interview critical**: "Given EXPLAIN output with key_len = 284 on an index
>>> (a VARCHAR(20), b VARCHAR(50), c DATETIME, d DECIMAL), how many columns are
>>> used?" Calculate: a = 82, a+b = 284, a+b+c = 289, a+b+c+d = 294. key_len = 284
>>> means exactly columns a and b are used. The optimizer could not use c — likely
>>> because c has a range condition and there is a sort column before it, or c is
>>> not in the WHERE clause at all.

### 14.4.4 EXPLAIN FORMAT=TREE — Iterator Execution Model

MySQL 8.0 introduced tree-format EXPLAIN that shows the actual iterator execution
plan — how rows flow through the system.

```sql
EXPLAIN FORMAT=TREE
SELECT o.id, o.total, c.name
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.status = 'shipped'
  AND o.created_at >= '2024-01-01'
ORDER BY o.created_at DESC
LIMIT 50\G
```

```
-> Limit: 50 row(s)
    -> Nested loop inner join
        -> Index range scan on o using idx_status_date 
           (status = 'shipped' AND created_at >= '2024-01-01'),
           with index condition: (o.status = 'shipped')
           (reverse)  (cost=72.1 rows=320)
        -> Single-row index lookup on c using PRIMARY (id = o.customer_id)
           (cost=0.25 rows=1)
```

This reads bottom-up:
1. Range scan on `orders` using `idx_status_date`, reverse (for DESC order)
2. For each order row, single-row PK lookup on `customers`
3. Nested loop join produces combined rows
4. LIMIT stops after 50 rows

The tree format makes join order, access methods, and data flow visually obvious.

### 14.4.5 EXPLAIN ANALYZE — Actual Execution Metrics

`EXPLAIN ANALYZE` (MySQL 8.0.18+) actually executes the query and reports real
timings, row counts, and loop counts alongside the estimates.

```sql
EXPLAIN ANALYZE
SELECT o.id, o.total, c.name
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.status = 'shipped'
  AND o.created_at >= '2024-01-01'
ORDER BY o.created_at DESC
LIMIT 50\G
```

```
-> Limit: 50 row(s)  (actual time=0.82..1.24 rows=50 loops=1)
    -> Nested loop inner join  (cost=152.3 rows=320)
       (actual time=0.81..1.21 rows=50 loops=1)
        -> Index range scan on o using idx_status_date  (cost=72.1 rows=320)
           (actual time=0.52..0.68 rows=50 loops=1)
        -> Single-row index lookup on c using PRIMARY (id=o.customer_id)
           (cost=0.25 rows=1)
           (actual time=0.008..0.009 rows=1 loops=50)
```

**Reading the output:**

- `actual time=X..Y`: X = time to first row (ms), Y = time to last row (ms). These
  are wall-clock times for this iterator.

- `rows=N`: actual number of rows produced by this iterator (per loop).

- `loops=N`: how many times this iterator was invoked. The customers lookup has
  `loops=50` because it executes once per order row (nested loop join). Total rows
  read from customers = `rows × loops = 1 × 50 = 50`.

- **Estimate vs actual divergence**: if the estimated `rows=320` but actual `rows=50`
  (because LIMIT stopped early), that is expected. If estimated `rows=100` but actual
  `rows=50000`, the index statistics are stale — run `ANALYZE TABLE`.

>>> **Interview insight**: "What is the difference between EXPLAIN and EXPLAIN ANALYZE?"
>>> EXPLAIN shows the optimizer's plan WITHOUT executing the query — estimates only.
>>> EXPLAIN ANALYZE actually executes the query and reports real measurements. Use EXPLAIN
>>> for planning, EXPLAIN ANALYZE for diagnosing why a query is slow. Caution: EXPLAIN
>>> ANALYZE with a mutation (UPDATE/DELETE) WILL execute the mutation. Use in a transaction
>>> with ROLLBACK if needed.

---

## 14.5 Common Query Anti-Patterns and Fixes

These are the patterns that appear in every slow query audit. Each one has a
mechanical explanation rooted in B+Tree and optimizer internals.

### 14.5.1 Function on Indexed Column

```sql
-- BROKEN: function wraps the column → index unusable
SELECT * FROM orders WHERE YEAR(created_at) = 2024;

-- The B+Tree stores created_at values (e.g., '2024-03-15 10:30:00').
-- YEAR(created_at) computes a derived value (2024).
-- The index is sorted by created_at, NOT by YEAR(created_at).
-- The optimizer cannot use the index because it can't map YEAR(2024)
-- back to a range of created_at values (it could, but it doesn't).
-- Result: full table scan.
```

**Fix — convert to a range predicate:**

```sql
SELECT * FROM orders 
WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01';

-- This is a range scan on the index. B+Tree navigates to '2024-01-01',
-- scans forward until '2025-01-01'. Reads only matching rows.
```

MySQL 8.0 introduced **functional indexes** as an alternative:

```sql
CREATE INDEX idx_year ON orders ((YEAR(created_at)));
-- Creates a hidden generated column and indexes it.
-- WHERE YEAR(created_at) = 2024 now uses this index.
-- But the range rewrite is still better for range queries.
```

### 14.5.2 Implicit Type Conversion

```sql
-- BROKEN: varchar column compared to integer literal
SELECT * FROM users WHERE phone_number = 12345678;

-- phone_number is VARCHAR. The literal 12345678 is an integer.
-- MySQL's type conversion rules: when comparing string to int,
-- the STRING is converted to int: CAST(phone_number AS SIGNED).
-- This is a function on the column → index cannot be used.
-- Every row's phone_number is cast to int and compared. Full scan.
```

**Fix — match the types:**

```sql
SELECT * FROM users WHERE phone_number = '12345678';
-- String literal compared to string column. Direct index lookup.
```

The reverse case is safe: comparing an INT column to a string literal `'12345'`
converts the constant, not the column. The index is still usable.

```
TYPE CONVERSION RULES — COLUMN vs LITERAL
═══════════════════════════════════════════════════════════════════

  Column Type | Literal Type | Conversion        | Index Usable?
  ────────────┼──────────────┼───────────────────┼──────────────
  VARCHAR     | INT          | Column → INT      | NO (func on col)
  INT         | VARCHAR      | Literal → INT     | YES (func on const)
  VARCHAR     | VARCHAR      | None              | YES
  INT         | INT          | None              | YES
  DATE        | VARCHAR      | Literal → DATE    | YES (func on const)
```

>>> **Interview critical**: "Why does `WHERE varchar_col = 123` cause a full table
>>> scan?" MySQL converts the varchar column to numeric for comparison (the string-to-int
>>> direction). This applies a function to every row's column value, making the index
>>> unusable. Always match literal types to column types.

### 14.5.3 Charset Mismatch in JOIN

```sql
-- Table t1: col VARCHAR(100) CHARACTER SET utf8mb4
-- Table t2: col VARCHAR(100) CHARACTER SET utf8

SELECT * FROM t1 JOIN t2 ON t1.col = t2.col;

-- utf8mb4 is a superset of utf8. MySQL must convert utf8 to utf8mb4
-- for comparison. This conversion is applied to t2.col (converting
-- the narrower charset to the wider one).
-- The index on t2.col cannot be used — function on column.
-- Result: full table scan of t2 for every row of t1. O(N × M).
```

**Fix — unify character sets:**

```sql
ALTER TABLE t2 MODIFY col VARCHAR(100) CHARACTER SET utf8mb4;
-- After conversion, both columns are utf8mb4. 
-- No implicit conversion in the JOIN. Index on t2.col is usable.
```

This is a silent performance killer. The query returns correct results — just
orders of magnitude slower. It is especially common after database migrations or
when consolidating tables from different application teams.

### 14.5.4 Leading Wildcard LIKE

```sql
-- BROKEN: leading wildcard
SELECT * FROM users WHERE name LIKE '%smith';

-- The B+Tree sorts name values: 'Adams', 'Brown', 'Goldsmith', 'Smith'.
-- A prefix search ('%smith') has no defined starting point in the B+Tree.
-- Every leaf entry must be examined. Full index/table scan.
```

**Fixes:**

```sql
-- Option 1: Trailing wildcard (if semantics allow)
WHERE name LIKE 'smith%'
-- B+Tree navigates to 'smith', scans until values no longer match prefix.

-- Option 2: Full-text index
ALTER TABLE users ADD FULLTEXT INDEX ft_name(name);
SELECT * FROM users WHERE MATCH(name) AGAINST('smith' IN BOOLEAN MODE);

-- Option 3: Reverse column trick (for suffix search)
ALTER TABLE users ADD COLUMN name_reversed VARCHAR(100) AS (REVERSE(name)) STORED;
CREATE INDEX idx_name_rev ON users(name_reversed);
SELECT * FROM users WHERE name_reversed LIKE CONCAT(REVERSE('smith'), '%');
-- Transforms suffix search into prefix search on reversed column.
```

### 14.5.5 OR Conditions

```sql
-- BROKEN: OR across different columns
SELECT * FROM orders WHERE customer_id = 42 OR status = 'failed';

-- No single composite index can serve both sides of the OR.
-- INDEX(customer_id, status) only helps the left side.
-- INDEX(status, customer_id) only helps the right side.
```

**Possible plans:**

```sql
-- Option 1: Index merge (optimizer does this automatically if cost is low)
-- EXPLAIN shows: type=index_merge, Extra: Using union(idx_cust, idx_status)
-- Two index scans, results merged. Often slower than expected due to
-- the merge step and deduplication.

-- Option 2: UNION ALL (explicit, often faster)
SELECT * FROM orders WHERE customer_id = 42
UNION ALL
SELECT * FROM orders WHERE status = 'failed' AND customer_id != 42;
-- Each SELECT uses its own optimal index.
-- The AND customer_id != 42 in the second query prevents duplicates.

-- Option 3: If both columns are low-cardinality, a single table scan
-- may actually be the best plan. The optimizer knows this.
```

### 14.5.6 SELECT *

```sql
-- ANTI-PATTERN
SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC LIMIT 20;

-- Even with INDEX(status, created_at): the query needs ALL columns.
-- For each of the 20 index entries, a bookmark lookup into the
-- clustered index is required.
-- 20 random I/O operations (if pages aren't cached).

-- FIX: select only needed columns
SELECT id, name, price, created_at 
FROM products 
WHERE status = 'active' 
ORDER BY created_at DESC LIMIT 20;

-- With INDEX(status, created_at, price, name): covering index.
-- "Using index" — zero bookmark lookups. Pure index scan.
```

The difference between 20 random I/Os and zero I/Os is the difference between
1-5 ms and < 0.1 ms for a warm cache. For a cold cache (data on SSD), it is
the difference between 2-5 ms and < 0.5 ms. For spinning disks, 20 random I/Os
can take 60-200 ms.

### 14.5.7 NOT IN Subquery

```sql
-- ANTI-PATTERN
SELECT * FROM customers 
WHERE id NOT IN (SELECT customer_id FROM orders WHERE status = 'shipped');

-- MySQL materializes the subquery into a temp table, then for each
-- customer row, probes the temp table. For large tables, this is slow.
-- Also: if the subquery returns any NULL, NOT IN returns UNKNOWN for
-- all rows → empty result set. This is a semantic trap.
```

**Fixes:**

```sql
-- Option 1: NOT EXISTS (usually fastest)
SELECT * FROM customers c
WHERE NOT EXISTS (
    SELECT 1 FROM orders o 
    WHERE o.customer_id = c.id AND o.status = 'shipped'
);
-- Correlated subquery, but the optimizer converts it to an anti-join.
-- With INDEX orders(customer_id, status): single index probe per customer.

-- Option 2: LEFT JOIN with IS NULL
SELECT c.* FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'shipped'
WHERE o.id IS NULL;
-- Explicit anti-join. Same execution plan as NOT EXISTS in MySQL 8.0.
```

### 14.5.8 ORDER BY + LIMIT Without Index

```sql
-- ANTI-PATTERN
SELECT * FROM events ORDER BY created_at DESC LIMIT 10;
-- No index on created_at.
-- MySQL reads EVERY row in the table (say, 50 million rows),
-- sorts them by created_at, and returns the top 10.
-- Even with priority queue optimization (keep top K), it still
-- scans all 50 million rows.

-- FIX
CREATE INDEX idx_created ON events(created_at DESC);
-- Now: backward index scan (or forward with DESC index), read 10 entries, done.
-- 50 million row scan → 10 row index lookup. Three orders of magnitude faster.
```

---

## 14.6 JOIN Optimization

JOINs are where the optimizer earns its keep. The difference between a good and bad
join plan is often 1000x in execution time.

### 14.6.1 Nested Loop Join — The Workhorse

The default join strategy when an index exists on the inner table's join column.

```
NESTED LOOP JOIN: orders (outer) → customers (inner)
═══════════════════════════════════════════════════════════════════

  For each row in orders:                        ← outer loop
      Use orders.customer_id to probe            ← single B+Tree
      customers PRIMARY KEY index                  traversal
      → returns exactly 1 row (eq_ref)           ← inner lookup

  Cost: N × O(log M)
    N = number of order rows after WHERE filter
    M = number of customer rows
    log M = B+Tree height (typically 3-4)

  With N=1000 orders, M=100000 customers:
    1000 × 4 page reads = 4000 logical reads
    Most pages cached → < 5ms total
```

The optimizer chooses join order to minimize total cost. It prefers to put the
table with the most selective WHERE filter as the outer table — this minimizes the
number of inner table probes.

```
JOIN ORDER SELECTION
═══════════════════════════════════════════════════════════════════

  Query: SELECT * FROM A JOIN B ON A.id = B.a_id WHERE A.x = 1 AND B.y = 2

  Plan 1: A (outer, filter x=1) → B (inner, lookup a_id + filter y=2)
    Cost: |A where x=1| × index_lookup_cost(B)

  Plan 2: B (outer, filter y=2) → A (inner, lookup id)
    Cost: |B where y=2| × index_lookup_cost(A)

  If |A where x=1| = 100 and |B where y=2| = 10000:
    Plan 1: 100 × lookup = 100 probes
    Plan 2: 10000 × lookup = 10000 probes
    → Plan 1 wins by 100x

  The optimizer evaluates all possible join orders (up to
  optimizer_search_depth tables, default 62) and picks the
  cheapest. For > ~10 tables, it switches to a greedy heuristic.
```

### 14.6.2 Hash Join (MySQL 8.0.18+)

When no index is available for the join condition, MySQL 8.0.18+ uses a hash join
instead of the slower Block Nested Loop (BNL).

```
HASH JOIN: orders (build) → line_items (probe)
═══════════════════════════════════════════════════════════════════

  Phase 1 — BUILD: scan the smaller table (orders), compute hash
  of join key (order_id), store rows in an in-memory hash table.

  ┌──────────────────────────────────────────┐
  │ Hash Table (in join_buffer_size memory)   │
  │                                          │
  │ bucket[hash(42)]  → {order_id=42, ...}   │
  │ bucket[hash(99)]  → {order_id=99, ...}   │
  │ bucket[hash(187)] → {order_id=187, ...}  │
  │ ...                                      │
  └──────────────────────────────────────────┘

  Phase 2 — PROBE: scan the larger table (line_items), compute
  hash of join key, look up in hash table.

  For each line_item row:
      h = hash(line_item.order_id)
      if bucket[h] contains matching order → emit joined row

  Cost: O(N + M)  — one pass through each table
  Memory: O(min(N, M)) — hash table of smaller table

  If hash table doesn't fit in join_buffer_size:
    → spill to disk (grace hash join with partitioning)
    → each partition pair is processed independently
```

EXPLAIN shows: `Using join buffer (hash join)` in the Extra column, or in tree
format: `-> Hash join`.

**When hash join is used:**
- No usable index on the join column
- Equi-join condition (`=`), not range-based join
- BKA/BNL alternatives are more expensive

**When hash join is NOT used:**
- Non-equi-join (`ON a.x > b.y`) — falls back to nested loop
- Anti-join / semi-join — may use hash join in some cases (8.0.20+)

### 14.6.3 Block Nested Loop (Legacy, Pre-8.0.18)

Before hash join, MySQL used Block Nested Loop for joins without indexes:

```
BLOCK NESTED LOOP
═══════════════════════════════════════════════════════════════════

  Instead of probing inner table for each outer row:
  1. Buffer a batch of outer rows in join_buffer_size (default 256KB)
  2. Full-scan inner table ONCE, checking each inner row against
     ALL buffered outer rows
  3. Repeat until all outer rows are processed

  Without BNL: 1000 outer × full scan of inner = 1000 full scans
  With BNL (100 rows per batch): 10 batches × 1 full scan = 10 full scans
  
  Still O(N × M) but with much better constant factor due to
  reduced I/O (inner table scanned fewer times).
```

In MySQL 8.0.18+, BNL is replaced by hash join. The optimizer no longer generates
BNL plans. You may still see `Using join buffer` but it will say `(hash join)`.

### 14.6.4 Batched Key Access (BKA) and Multi-Range Read (MRR)

These optimizations convert random I/O into sequential I/O for index lookups.

```
BKA + MRR OPTIMIZATION
═══════════════════════════════════════════════════════════════════

  Standard Nested Loop:
  outer row → lookup inner index → get PK → random read from clustered index
                                             ↑ RANDOM I/O for each row

  With BKA:
  1. Collect batch of join keys from outer table
  2. Pass keys to MRR
  3. MRR sorts keys by PK order
  4. Read from clustered index in PK order → SEQUENTIAL I/O

  ┌─────────────────────────────────────────────────────────────┐
  │ Without MRR:                                                │
  │   Read PK=42 (page 100) → PK=187 (page 500) → PK=5 (page 2)│
  │   → 3 random I/O operations                                │
  │                                                             │
  │ With MRR:                                                   │
  │   Sort: PK=5, PK=42, PK=187                                │
  │   Read PK=5 (page 2) → PK=42 (page 100) → PK=187 (page 500)│
  │   → 3 sequential I/O operations (better prefetch, less seek)│
  └─────────────────────────────────────────────────────────────┘
```

Enable BKA:

```sql
SET optimizer_switch = 'mrr=on,mrr_cost_based=on,batched_key_access=on';
```

BKA is off by default because the cost model often prefers the simpler nested loop.
Enable it when you have range scans that produce many bookmark lookups and the data
is on spinning disks or cold buffer pool.

---

## 14.7 Subquery Optimization

MySQL's subquery optimization has improved dramatically from 5.5 to 8.0. Understanding
the strategies helps you write queries the optimizer can transform efficiently.

### 14.7.1 Correlated vs Non-Correlated Subqueries

```sql
-- Non-correlated: subquery is independent of outer query
SELECT * FROM orders WHERE customer_id IN (
    SELECT id FROM customers WHERE region = 'US'
);
-- Subquery can be executed ONCE, result cached.
-- Optimizer materializes or converts to semi-join.

-- Correlated: subquery references outer query columns
SELECT * FROM orders o WHERE EXISTS (
    SELECT 1 FROM order_items oi 
    WHERE oi.order_id = o.id AND oi.quantity > 100
);
-- Conceptually re-executed for each outer row.
-- But the optimizer transforms this into a semi-join in most cases.
```

### 14.7.2 Semi-Join Strategies (MySQL 8.0)

When the optimizer detects a semi-join pattern (`IN (subquery)`, `EXISTS (correlated)`),
it can use several execution strategies:

```
SEMI-JOIN STRATEGIES
═══════════════════════════════════════════════════════════════════

  1. FIRSTMATCH
     ─────────────────────────────────────────
     Execute like a correlated EXISTS: for each outer row, scan
     inner table and stop at first match.
     
     Best when: inner table has index on join key, few outer rows.
     EXPLAIN: Extra shows "FirstMatch(outer_table)"

  2. LOOSESCAN
     ─────────────────────────────────────────
     Scan the inner table's index, skip duplicate values of the
     join key, probe outer table for each unique value.
     
     Best when: inner table has index starting with join key,
     many duplicates in inner table.
     EXPLAIN: Extra shows "LooseScan"

  3. MATERIALIZATION + LOOKUP
     ─────────────────────────────────────────
     Materialize the subquery into a temp table with a unique
     index on the join key. Then for each outer row, probe the
     temp table.
     
     Best when: subquery is non-correlated, result set fits in
     memory, many outer rows (amortize materialization cost).
     EXPLAIN: select_type shows "MATERIALIZED"

  4. DUPLICATE WEEDOUT
     ─────────────────────────────────────────
     Execute as a normal join (may produce duplicates), then
     remove duplicates via a temp table keyed on outer table's PK.
     
     Best when: other strategies can't be used.
     EXPLAIN: Extra shows "Start temporary; End temporary"
```

```sql
-- Example: optimizer choosing Materialization
EXPLAIN SELECT * FROM orders 
WHERE customer_id IN (SELECT id FROM customers WHERE region = 'US');

-- Possible plan:
-- 1. Materialize: SELECT id FROM customers WHERE region = 'US'
--    → temp table with unique index on id
-- 2. For each order: probe temp table with customer_id
-- 
-- Or, the optimizer may convert to a join:
-- SELECT o.* FROM orders o JOIN customers c ON o.customer_id = c.id
-- WHERE c.region = 'US'
-- → Same result, optimized as a regular join.
```

### 14.7.3 Derived Table Optimization

A derived table (subquery in the FROM clause) can be:

1. **Materialized**: executed and stored in a temp table. Subsequent references
   to the derived table read from the temp table. The temp table has NO indexes
   (unless the optimizer creates an auto-key in 8.0).

2. **Merged**: dissolved into the outer query. The derived table's WHERE conditions
   and column references are incorporated into the outer query's plan. This avoids
   the temp table entirely.

```sql
-- Merged (optimizer dissolves the derived table):
SELECT * FROM (
    SELECT id, name FROM products WHERE status = 'active'
) derived WHERE derived.name LIKE 'A%';
-- Equivalent to:
SELECT id, name FROM products WHERE status = 'active' AND name LIKE 'A%';
-- No temp table created.

-- NOT mergeable (forces materialization):
SELECT * FROM (
    SELECT status, COUNT(*) AS cnt FROM products GROUP BY status
) derived WHERE derived.cnt > 100;
-- GROUP BY prevents merging. Result materialized into temp table.
-- Outer WHERE filters the temp table (full scan, no index).
```

Control with `optimizer_switch`:

```sql
SET optimizer_switch = 'derived_merge=on';   -- default: on
SET optimizer_switch = 'derived_merge=off';  -- force materialization
```

### 14.7.4 Subquery-to-Derived Transformation (8.0.21+)

MySQL 8.0.21 introduced `subquery_to_derived`, which transforms correlated
subqueries in the SELECT list or WHERE clause into derived table joins:

```sql
-- Original (correlated subquery, executed per outer row):
SELECT o.id, o.total,
    (SELECT MAX(oi.price) FROM order_items oi WHERE oi.order_id = o.id) AS max_price
FROM orders o;

-- After subquery_to_derived transformation:
SELECT o.id, o.total, derived.max_price
FROM orders o
LEFT JOIN (
    SELECT order_id, MAX(price) AS max_price 
    FROM order_items GROUP BY order_id
) derived ON derived.order_id = o.id;

-- The derived table is materialized ONCE, then joined. 
-- Much better than executing the subquery for each order.
```

---

## 14.8 Window Functions and CTE Performance

### 14.8.1 Window Function Execution

Window functions (`ROW_NUMBER()`, `RANK()`, `SUM() OVER()`, `LAG()`, `LEAD()`)
require sorted data. The optimizer determines whether an index can provide the sort
order or whether a filesort is needed.

```sql
-- Index-ordered window function (no filesort):
SELECT id, customer_id, total,
    ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn
FROM orders;

-- With INDEX(customer_id, created_at DESC):
-- The index provides both the PARTITION BY grouping and ORDER BY sorting.
-- No filesort needed. One pass through the index.

-- Without matching index:
-- MySQL sorts the entire result set by (customer_id, created_at DESC).
-- This is a filesort. For large tables, it spills to disk.
```

Multiple window functions with different `OVER()` clauses require multiple sorts:

```sql
SELECT id, customer_id, total,
    ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn_cust,
    RANK() OVER (ORDER BY total DESC) AS rank_total
FROM orders;

-- Two different sort orders needed:
--   1. (customer_id, created_at DESC) for rn_cust
--   2. (total DESC) for rank_total
-- MySQL performs two filesorts. An index can eliminate at most one.
```

>>> **Interview insight**: "How do you optimize a 'top N per group' query?" Use
>>> `ROW_NUMBER() OVER (PARTITION BY group_col ORDER BY sort_col) AS rn` with a
>>> wrapping `WHERE rn <= N`. Create an index `(group_col, sort_col)` to avoid
>>> filesort. For MySQL, the lateral join approach can be faster for large tables:
>>> ```sql
>>> SELECT c.id, o.* 
>>> FROM customers c, 
>>> LATERAL (SELECT * FROM orders WHERE customer_id = c.id 
>>>          ORDER BY created_at DESC LIMIT 3) o;
>>> ```

### 14.8.2 Common Table Expression (CTE) Performance

CTEs (`WITH ... AS`) are materialized into temporary tables. Unlike derived tables,
they are not merged into the outer query.

```sql
WITH recent_orders AS (
    SELECT customer_id, COUNT(*) AS order_count
    FROM orders
    WHERE created_at >= '2024-01-01'
    GROUP BY customer_id
)
SELECT c.name, ro.order_count
FROM customers c
JOIN recent_orders ro ON c.id = ro.customer_id
WHERE ro.order_count > 5;
```

**Performance characteristics:**

- The CTE is materialized into a temp table with no indexes. The join on
  `c.id = ro.customer_id` requires a full scan of the CTE temp table for each
  customer (or a hash join).

- If the same CTE is referenced multiple times, it is materialized ONCE and read
  multiple times. This is the main advantage over a derived table (which may be
  re-evaluated).

- For single-use CTEs, rewriting as a derived table may be faster because derived
  tables can be merged into the outer query (avoiding materialization entirely).

```sql
-- Rewrite as derived table (can be merged):
SELECT c.name, ro.order_count
FROM customers c
JOIN (
    SELECT customer_id, COUNT(*) AS order_count
    FROM orders
    WHERE created_at >= '2024-01-01'
    GROUP BY customer_id
    HAVING COUNT(*) > 5
) ro ON c.id = ro.customer_id;
-- WITH GROUP BY, this still materializes, but the HAVING filter
-- reduces the temp table size.
```

### 14.8.3 Recursive CTEs

Recursive CTEs iterate until the recursive member produces no new rows:

```sql
WITH RECURSIVE org_tree AS (
    -- Anchor: start at the root
    SELECT id, name, manager_id, 0 AS depth
    FROM employees
    WHERE manager_id IS NULL
    
    UNION ALL
    
    -- Recursive member: join children to current level
    SELECT e.id, e.name, e.manager_id, ot.depth + 1
    FROM employees e
    JOIN org_tree ot ON e.manager_id = ot.id
)
SELECT * FROM org_tree;
```

**Performance considerations:**

- Each iteration materializes new rows into a temp table. For deep trees (depth > 20),
  the cumulative temp table I/O can be significant.

- Index `employees(manager_id)` is critical — the recursive member joins on
  `manager_id` for each iteration. Without this index, each level does a full scan
  of the employees table.

- MySQL has a safety limit: `cte_max_recursion_depth` (default 1000). If your tree
  is deeper, increase this or refactor.

- For wide trees (many children per node), each iteration may produce many rows.
  The temp table grows quickly.

---

## 14.9 Optimizer Hints and Flags

Sometimes the optimizer makes the wrong choice. Hints let you override specific
decisions without changing the global configuration.

### 14.9.1 Statement-Level Hints (MySQL 8.0)

MySQL 8.0 uses C-style comments with `+` prefix that survive through the parser:

```sql
-- Force a specific index
SELECT /*+ INDEX(products idx_status_cat) */ id, name
FROM products WHERE status = 'active';

-- Prevent a specific index
SELECT /*+ NO_INDEX(products idx_status_cat) */ id, name
FROM products WHERE status = 'active';

-- Force join order (tables processed in the specified order)
SELECT /*+ JOIN_ORDER(orders, customers) */ o.id, c.name
FROM orders o JOIN customers c ON o.customer_id = c.id
WHERE o.status = 'shipped';

-- Force hash join for a specific pair
SELECT /*+ HASH_JOIN(t1, t2) */ *
FROM large_table t1 JOIN large_table_2 t2 ON t1.key = t2.key;

-- No hash join
SELECT /*+ NO_HASH_JOIN(t1, t2) */ *
FROM large_table t1 JOIN large_table_2 t2 ON t1.key = t2.key;

-- Set a session variable for this query only
SELECT /*+ SET_VAR(optimizer_search_depth=0) */ *
FROM t1 JOIN t2 ON ... JOIN t3 ON ... JOIN t4 ON ...;
-- optimizer_search_depth=0 means: use the optimizer's auto-detection
-- for search depth. Useful for complex multi-table joins where
-- exhaustive search is too slow.

-- Query timeout (milliseconds)
SELECT /*+ MAX_EXECUTION_TIME(5000) */ *
FROM very_large_table WHERE complex_condition;
-- Query is killed after 5 seconds. Useful for user-facing queries
-- where you'd rather return an error than let the query run forever.

-- Semi-join strategy hints
SELECT /*+ SEMIJOIN(@subq MATERIALIZATION) */ *
FROM orders WHERE customer_id IN (SELECT /*+ QB_NAME(subq) */ id FROM customers);
-- Force the optimizer to use materialization for this specific semi-join.

-- Disable derived table merging for a specific subquery
SELECT /*+ NO_MERGE(derived) */ *
FROM (SELECT * FROM products WHERE status = 'active') derived
WHERE derived.price > 100;
```

### 14.9.2 Legacy Index Hints

These predate the `/*+ */` hint syntax and still work:

```sql
-- Suggest indexes (optimizer may still ignore)
SELECT * FROM orders USE INDEX (idx_status) WHERE status = 'shipped';

-- Force a specific index (optimizer must use it or table scan)
SELECT * FROM orders FORCE INDEX (idx_status) WHERE status = 'shipped';

-- Exclude an index from consideration
SELECT * FROM orders IGNORE INDEX (idx_status) WHERE status = 'shipped';

-- For specific operations:
SELECT * FROM orders USE INDEX FOR ORDER BY (idx_created);
SELECT * FROM orders USE INDEX FOR JOIN (idx_customer);
SELECT * FROM orders USE INDEX FOR GROUP BY (idx_status);
```

`FORCE INDEX` is stronger than `USE INDEX`: with `FORCE INDEX`, the optimizer
considers only the specified index and a full table scan. With `USE INDEX`, the
optimizer considers the specified index(es) and all other access methods.

### 14.9.3 optimizer_switch — Feature Toggles

The `optimizer_switch` system variable is a comma-separated list of feature flags:

```sql
-- View current settings
SELECT @@optimizer_switch\G

-- Key flags:
SET optimizer_switch = 'index_merge=on';              -- Enable index merge
SET optimizer_switch = 'index_merge_intersection=on';  -- Intersect two index scans
SET optimizer_switch = 'index_merge_union=on';         -- Union two index scans
SET optimizer_switch = 'semijoin=on';                  -- Semi-join optimization
SET optimizer_switch = 'materialization=on';           -- Subquery materialization
SET optimizer_switch = 'subquery_to_derived=on';       -- Transform subquery to derived (8.0.21+)
SET optimizer_switch = 'derived_merge=on';             -- Merge derived tables into outer query
SET optimizer_switch = 'batched_key_access=on';        -- BKA for joins
SET optimizer_switch = 'mrr=on';                       -- Multi-Range Read
SET optimizer_switch = 'mrr_cost_based=on';            -- Use cost model for MRR decision
SET optimizer_switch = 'use_invisible_indexes=on';     -- Use invisible indexes (testing)
SET optimizer_switch = 'hypergraph_optimizer=on';      -- New optimizer (8.0.31+, experimental)
```

**Invisible indexes** deserve special mention: you can create an index as INVISIBLE,
meaning the optimizer ignores it. This lets you test the impact of dropping an index
without actually dropping it:

```sql
ALTER TABLE products ALTER INDEX idx_old_unused INVISIBLE;
-- Monitor for regressions. If no query slows down:
DROP INDEX idx_old_unused ON products;
-- If something breaks:
ALTER TABLE products ALTER INDEX idx_old_unused VISIBLE;
```

### 14.9.4 When to Use Hints

Hints should be a last resort, not a first tool:

```
HINT DECISION TREE
═══════════════════════════════════════════════════════════════════

  Query is slow
       │
       ▼
  Run EXPLAIN. Is the plan wrong?
       │
       ├── No → The plan is right, the query is inherently expensive.
       │        Optimize the query structure or schema.
       │
       ├── Yes → Is there a missing index?
       │         │
       │         ├── Yes → ADD THE INDEX. Don't hint around a missing index.
       │         │
       │         └── No → Are index statistics stale?
       │                   │
       │                   ├── Yes → ANALYZE TABLE. Statistics refresh.
       │                   │
       │                   └── No → Optimizer genuinely makes wrong choice.
       │                             │
       │                             ├── Verify with EXPLAIN ANALYZE
       │                             │   (confirm the better plan IS better)
       │                             │
       │                             └── ADD A HINT as temporary fix.
       │                                 File a bug if the optimizer should
       │                                 handle this case.
       │
       └── The plan changes between runs (plan instability):
           → Pin the plan with a hint.
           → Investigate histogram statistics (8.0):
             ANALYZE TABLE t UPDATE HISTOGRAM ON col WITH 100 BUCKETS;
```

>>> **Interview insight**: "When would you use FORCE INDEX?" Only after confirming
>>> (1) the optimizer consistently picks the wrong index, (2) ANALYZE TABLE does not fix
>>> it, (3) histograms do not fix it. Common scenario: the optimizer underestimates
>>> selectivity of a combined condition and chooses a table scan over an obviously
>>> better index. This happens with correlated data distributions that the InnoDB
>>> sampling-based statistics miss. The proper long-term fix is better statistics or
>>> histograms, but FORCE INDEX works as a bridge.

---

## 14.10 Slow Query Analysis Workflow

A repeatable process for finding and fixing slow queries in production.

### 14.10.1 Step 1 — Enable Slow Query Logging

```ini
# my.cnf (or SET GLOBAL for runtime)
slow_query_log = ON
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 1                    # seconds; start at 1, lower to 0.1 for detail
log_queries_not_using_indexes = ON     # catch missing-index queries regardless of time
log_slow_admin_statements = ON         # catch slow DDL (ALTER TABLE, OPTIMIZE)
min_examined_row_limit = 100           # skip trivial queries
log_throttle_queries_not_using_indexes = 60  # max 60 no-index entries per minute
                                             # prevents log flood
```

Performance impact of slow query log: minimal. The overhead is one disk write per
slow query. For a server handling 10,000 QPS with 0.1% slow queries, that is 10
additional writes/sec.

### 14.10.2 Step 2 — Aggregate with pt-query-digest

```bash
pt-query-digest /var/log/mysql/slow.log --limit=20

# Sample output:
# =========================================================================
# Profile
# =========================================================================
# Rank Query ID                       Response time    Calls  R/Call  Item
# ==== ============================== ================ ====== ====== =====
#    1 0xDA56E1B7F71A9FBC35E7AE0F...  425.9130 35.2%    3982 0.1070 SELECT products
#    2 0x2F8B45C93A1E4D7029865F12...  218.4510 18.0%     547 0.3993 SELECT orders JOIN customers
#    3 0x7C91A3E5F2B8D60418A73C95...  142.3200 11.8%   12043 0.0118 UPDATE inventory
#    4 0xE4D8F3A291B5C760538D2F17...   98.7600  8.2%     205 0.4817 SELECT orders JOIN order_items
# =========================================================================
#
# Query 1: 66.37 QPS, 7.10x concurrency, ID 0xDA56E1B7F71A9FBC35E7AE0F...
# Attribute    pct   total     min     max     avg     95%  stddev  median
# ============ ==== ======= ======= ======= ======= ======= ======= =======
# Count          2    3982
# Exec time     35    426s    10ms   2867ms   107ms   389ms   201ms    52ms
# Lock time      1    14ms     1us    95us     3us     5us     4us     3us
# Rows sent     15    79.6k       0      20      20      20    0.00      20
# Rows examine  42   1.98G   3.2k   980.5k  521.3k  961.3k  380.1k  501.2k
# Query size     1  780.4k     196     196     196     196    0.00     196
#
# SELECT id, name, price FROM products
# WHERE status = 'active' AND category = ?
# ORDER BY created_at DESC LIMIT 20\G
```

**What to focus on:**
- **Rows examined vs rows sent**: Query #1 examines 521K rows on average to send 20.
  Ratio = 26,000:1. This is the clearest signal of a missing or suboptimal index.
- **95th percentile execution time**: the average (107ms) hides outliers (2.8s at max).
  The 95th percentile (389ms) is what users actually experience.
- **Frequency**: Query #3 runs 12,043 times but is individually fast (12ms). Its total
  time (142s) is high purely from volume. Optimizing it yields modest per-query gains
  but significant aggregate reduction.

### 14.10.3 Step 3 — Performance Schema Deep Dive

For production systems where you cannot enable slow query log or need real-time data:

```sql
-- Top 20 queries by total execution time
SELECT 
    LEFT(DIGEST_TEXT, 120) AS query_pattern,
    COUNT_STAR AS executions,
    ROUND(SUM_TIMER_WAIT / 1e12, 2) AS total_time_sec,
    ROUND(AVG_TIMER_WAIT / 1e12, 4) AS avg_time_sec,
    ROUND(MAX_TIMER_WAIT / 1e12, 2) AS max_time_sec,
    SUM_ROWS_EXAMINED AS total_rows_examined,
    SUM_ROWS_SENT AS total_rows_sent,
    ROUND(SUM_ROWS_EXAMINED / NULLIF(SUM_ROWS_SENT, 0), 0) AS exam_sent_ratio,
    SUM_NO_INDEX_USED AS no_index_count,
    SUM_NO_GOOD_INDEX_USED AS bad_index_count,
    FIRST_SEEN, LAST_SEEN
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = 'mydb'
  AND DIGEST_TEXT NOT LIKE 'COMMIT%'
  AND DIGEST_TEXT NOT LIKE 'SET%'
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 20;

-- Queries with worst rows_examined/rows_sent ratio
SELECT 
    LEFT(DIGEST_TEXT, 120) AS query_pattern,
    COUNT_STAR AS executions,
    SUM_ROWS_EXAMINED,
    SUM_ROWS_SENT,
    ROUND(SUM_ROWS_EXAMINED / NULLIF(SUM_ROWS_SENT, 0), 0) AS exam_sent_ratio
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = 'mydb'
  AND SUM_ROWS_SENT > 0
  AND COUNT_STAR > 100
ORDER BY SUM_ROWS_EXAMINED / NULLIF(SUM_ROWS_SENT, 0) DESC
LIMIT 20;
```

### 14.10.4 Step 4 — Fix and Verify

For each identified slow query:

```
SLOW QUERY FIX CYCLE
═══════════════════════════════════════════════════════════════════

  1. EXPLAIN the query → identify access type, key, key_len, Extra
  
  2. Diagnose:
     ├── type = ALL → missing index or very wide result set
     ├── Using filesort → index doesn't cover ORDER BY
     ├── Using temporary → GROUP BY mismatch or DISTINCT
     ├── key_len too short → composite index not fully utilized
     ├── rows much larger than result → filter after index, not in index
     └── Using where without Using index condition → filter at SQL layer
  
  3. Apply fix:
     ├── Add or modify index (ESR analysis)
     ├── Rewrite anti-pattern (function on column, type mismatch)
     ├── Restructure query (subquery → join, SELECT * → named cols)
     └── Add hint (last resort)
  
  4. Verify:
     ├── EXPLAIN: confirm new plan uses the index correctly
     ├── EXPLAIN ANALYZE: confirm actual execution time improved
     └── Monitor: check Performance Schema after deployment
  
  5. Clean up:
     ├── Drop redundant indexes made unnecessary by new index
     └── Update sys.schema_unused_indexes monitoring
```

### 14.10.5 Putting It All Together — Full Example

**The problem query** (from pt-query-digest):

```sql
SELECT id, name, price, image_url FROM products
WHERE status = 'active' AND category = 'electronics'
ORDER BY created_at DESC
LIMIT 20;

-- Performance: avg 107ms, examines 521K rows, returns 20
```

**Step 1 — EXPLAIN:**

```
+----+------+------+---------------+------+---------+------+--------+----------+-----------------------------+
| id | type | rows | possible_keys | key  | key_len | ref  | rows   | filtered | Extra                       |
+----+------+------+---------------+------+---------+------+--------+----------+-----------------------------+
|  1 | ALL  | NULL | NULL          | NULL | NULL    | NULL | 982451 |     1.10 | Using where; Using filesort |
+----+------+------+---------------+------+---------+------+--------+----------+-----------------------------+
```

Diagnosis: `type = ALL` (full table scan), no index, `Using filesort` (sorting
982K rows to return 20). Everything is wrong.

**Step 2 — ESR analysis:**

```
E: status = 'active', category = 'electronics'  → equality
S: ORDER BY created_at DESC                      → sort
R: (none)
Cover: id (PK, automatic), name, price, image_url
```

**Step 3 — Create index:**

```sql
CREATE INDEX idx_prod_esr ON products(
    status, category, created_at DESC, name, price, image_url
);
```

Note: `image_url` is likely a VARCHAR(255) — adding it to the index makes the index
entries large. Consider whether covering is worth the index bloat:
- If this query runs 4,000 times/minute, covering saves 4,000 × 20 = 80,000
  bookmark lookups per minute. Worth the index size.
- If it runs 10 times/day, the 20 bookmark lookups per execution are negligible.
  Skip image_url and accept the bookmark lookup.

**Step 4 — Verify:**

```
+----+------+------+---------------+--------------+---------+------+------+----------+--------------------------+
| id | type | rows | possible_keys | key          | key_len | ref  | rows | filtered | Extra                    |
+----+------+------+---------------+--------------+---------+------+------+----------+--------------------------+
|  1 | ref  |   20 | idx_prod_esr  | idx_prod_esr | 284     |const,|   20 |   100.00 | Using where; Using index |
|    |      |      |               |              |         |const |      |          |                          |
+----+------+------+---------------+--------------+---------+------+------+----------+--------------------------+
```

- `type = ref`: equality lookup (was `ALL`)
- `key = idx_prod_esr`: using our new index
- `key_len = 284`: status (82) + category (202) = 284, both equality columns used
- `rows = 20`: LIMIT optimization, scans only 20 entries (was 982K)
- `Using index`: covering index, no bookmark lookups
- No `Using filesort`: ORDER BY served by index

**Step 5 — EXPLAIN ANALYZE confirmation:**

```
-> Limit: 20 row(s)  (actual time=0.08..0.12 rows=20 loops=1)
    -> Covering index lookup on products using idx_prod_esr
       (status='active', category='electronics')
       (actual time=0.07..0.11 rows=20 loops=1)
```

Execution time: 0.12ms (was 107ms). Rows examined: 20 (was 521K).
Improvement: **890x faster, 26,000x fewer rows examined.**

This is what correct index design does.

---

## Summary — Index Design Checklist

```
INDEX DESIGN DECISION FRAMEWORK
═══════════════════════════════════════════════════════════════════

  ┌─────────────────────────────────────────────────────────────┐
  │ 1. COLLECT: Top 20 queries by total time                   │
  │    (pt-query-digest or Performance Schema digest)          │
  │                                                            │
  │ 2. ANALYZE: ESR decomposition for each query               │
  │    E = equality columns   → first in index                 │
  │    S = sort columns       → after equality                 │
  │    R = range columns      → last (breaks sort)             │
  │    + covering columns if query is high-frequency           │
  │                                                            │
  │ 3. MERGE: Consolidate similar indexes                      │
  │    (a,b) is prefix of (a,b,c) → keep only (a,b,c)        │
  │                                                            │
  │ 4. PRUNE: Remove redundant indexes                         │
  │    sys.schema_redundant_indexes / pt-duplicate-key-checker │
  │                                                            │
  │ 5. VERIFY: EXPLAIN + EXPLAIN ANALYZE for each top query    │
  │    Check: type, key, key_len, rows, Extra                  │
  │                                                            │
  │ 6. MONITOR: sys.schema_unused_indexes after deployment     │
  │    Drop indexes with count_read = 0                        │
  │                                                            │
  │ LIMITS:                                                    │
  │    5-7 secondary indexes per high-write table              │
  │    Keep PK narrow (INT/BIGINT, not UUID)                   │
  │    Covering indexes for top 3-5 highest-frequency queries  │
  └─────────────────────────────────────────────────────────────┘

  KEY DIAGNOSTIC SIGNALS:
  ┌─────────────────────────────────────────────────────────────┐
  │ type = ALL              → Missing index (or table too small)│
  │ Using filesort          → ORDER BY not served by index      │
  │ Using temporary         → GROUP BY/DISTINCT mismatch        │
  │ key_len too short       → Composite index partially used    │
  │ rows >> actual result   → Index filter too broad            │
  │ exam/sent ratio > 100   → Wrong index or anti-pattern       │
  │ Using where (alone)     → Filtering after bookmark lookup   │
  │ Using join buffer       → Missing index on join column      │
  └─────────────────────────────────────────────────────────────┘

  Interview-critical numbers:
    B+Tree height for 10M rows: 3-4 levels (3-4 page reads)
    Bookmark lookup cost (warm): ~0.1-0.5ms per row
    Covering index scan: ~0.01ms per row (sequential)
    Filesort threshold: sort_buffer_size = 256KB default
    Hash join memory: join_buffer_size = 256KB default
    Index statistics sample: 20 pages (innodb_stats_persistent_sample_pages)
    key_len for INT NOT NULL: 4 bytes
    key_len for VARCHAR(100) utf8mb4 NOT NULL: 402 bytes
```

---

*Next: Chapter 15 — Connection Pooling and Middleware — explores how HikariCP,
ProxySQL, and MySQL Router manage connections at scale, and why connection
management is the first bottleneck most Java applications hit.*
