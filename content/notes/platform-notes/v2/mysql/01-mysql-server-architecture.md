# Chapter 1: MySQL Server Architecture

## How a SQL Statement Travels from TCP Socket to Disk and Back

---

MySQL is a single-process, multi-threaded relational database. Every connection,
every background flush, every replication thread lives inside one OS process.
This chapter traces the full path of a SQL statement — from TCP SYN to result
set bytes leaving the NIC.

---

## 1.1 Process Model — Threads, Not Forks

### The Design Decision

MySQL runs as **one OS process** with many threads sharing a single virtual address
space. This is a deliberate architectural choice, not an accident. Contrast this
with PostgreSQL, which forks a new process per connection.

```
MySQL                                  PostgreSQL
┌─────────────────────┐                ┌──────────────────┐
│   mysqld (PID 1234) │                │ postmaster (1234)│
│                     │                │                  │
│  ┌──────┐ ┌──────┐ │                │  fork()          │
│  │ Thr1 │ │ Thr2 │ │                │  ├─> backend(1235)
│  │(conn)│ │(conn)│ │                │  ├─> backend(1236)
│  └──────┘ └──────┘ │                │  ├─> backend(1237)
│  ┌──────┐ ┌──────┐ │                │  └─> backend(1238)
│  │ Thr3 │ │ Thr4 │ │                │                  │
│  │(IO)  │ │(purge│ │                │  Each process has │
│  └──────┘ └──────┘ │                │  own address space│
│                     │                │                  │
│  SHARED ADDRESS     │                │  IPC via shared  │
│  SPACE              │                │  memory segments  │
└─────────────────────┘                └──────────────────┘
```

### Why MySQL Chose Threads

| Factor                  | Threads (MySQL)                      | Processes (PostgreSQL)               |
|-------------------------|--------------------------------------|--------------------------------------|
| Context switch cost     | ~1-3 μs (no TLB flush)              | ~5-15 μs (TLB flush, page table)    |
| Memory overhead/conn    | ~256 KB - 2 MB (stack + buffers)     | ~5-10 MB (full process image)        |
| Data sharing            | Direct pointer access                | Shared memory segments + IPC         |
| Buffer pool access      | Direct read from shared heap         | Shared memory mapped into each proc  |
| Cache coherence         | CPU cache coherence protocol (MESI)  | Explicit invalidation messages       |
| Crash isolation         | One thread crash kills the server    | One backend crash can be isolated    |
| Max connections (practical) | 1,000-5,000 (thread stack limits)| 200-500 (process overhead)           |
| Lock contention         | Mutexes in shared memory (fast path) | LWLocks in shared memory             |

**>>> The tradeoff is memory efficiency and data-sharing speed (threads) vs crash
isolation and OS-level resource control (processes). MySQL bets that the server
code is correct enough that crash isolation is less important than the 5-10x
memory savings per connection.**

### Shared Memory Implications

Because all threads share one address space:

- The **buffer pool** is a single large allocation. Any thread can read any cached
  page without IPC. This is why InnoDB's buffer pool can be so efficient — there
  is no serialization cost to access cached data beyond the buffer pool mutex
  (which uses a sharded rw-lock in 8.0).

- **Global mutexes** become the primary bottleneck. The old query cache (removed in
  8.0) had a single global mutex (`LOCK_query_cache`) that serialized every
  cache lookup and invalidation. Under high concurrency, threads stalled waiting
  for this mutex.

- A **stack overflow or segfault in any thread** kills `mysqld`. This is why MySQL
  has strict stack depth checks (`thread_stack` variable, default 1 MB on 64-bit).

- **Memory accounting** requires explicit instrumentation. MySQL's Performance Schema
  tracks per-thread memory via `memory/sql/*` instruments because the OS only
  sees one process's total RSS.

---

## 1.2 The Three-Layer Architecture

MySQL's internal architecture is a strict three-layer pipeline. This layering is
why MySQL supports pluggable storage engines — the SQL layer does not know or
care how data is physically stored.

```
   ┌───────────────────────────────────────────────────────────────────┐
   │                     CLIENT APPLICATION                            │
   │              (mysql CLI / JDBC / Connector/C)                     │
   └───────────────────────┬───────────────────────────────────────────┘
                           │ TCP 3306 / Unix socket / Shared Memory
                           ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  LAYER 1: CONNECTION HANDLING LAYER                               │
   │                                                                   │
   │  ┌─────────┐  ┌──────────────┐  ┌─────────────┐  ┌───────────┐  │
   │  │ Network │  │Authenticator │  │ Thread Mgr  │  │  SSL/TLS  │  │
   │  │Listener │  │(native/LDAP/ │  │ (per-conn / │  │ Handshake │  │
   │  │         │  │ PAM/Kerberos)│  │  pool)      │  │           │  │
   │  └────┬────┘  └──────┬───────┘  └──────┬──────┘  └─────┬─────┘  │
   │       └──────────────┴─────────────────┴──────────────┘         │
   └───────────────────────┬───────────────────────────────────────────┘
                           │ THD object (per-connection state)
                           ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  LAYER 2: SQL LAYER (Server Core)                                 │
   │                                                                   │
   │  ┌────────┐ ┌────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐  │
   │  │ Parser │→│Resolver│→│ Optimizer │→│Plan Gen  │→│ Executor │  │
   │  │(Bison) │ │(name/  │ │(cost-based│ │(Iterator │ │(row-by-  │  │
   │  │        │ │ type)  │ │ + rules)  │ │  tree)   │ │ row)     │  │
   │  └────────┘ └────────┘ └───────────┘ └──────────┘ └────┬─────┘  │
   │                                                         │        │
   │  Also: Query Rewrite plugins, Audit plugins, ACL checks │        │
   └─────────────────────────────────────────────────────────┼────────┘
                           │ Handler API calls                │
                           ▼                                  │
   ┌───────────────────────────────────────────────────────────────────┐
   │  LAYER 3: STORAGE ENGINE LAYER                                    │
   │                                                                   │
   │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
   │  │  InnoDB  │  │ MyISAM   │  │  MEMORY  │  │  NDB Cluster     │ │
   │  │          │  │          │  │  (HEAP)  │  │                  │ │
   │  │ B+Tree   │  │ B-Tree   │  │ Hash/    │  │  Distributed     │ │
   │  │ MVCC     │  │ Table    │  │ B-Tree   │  │  shared-nothing  │ │
   │  │ Redo/Undo│  │ locks    │  │ No disk  │  │                  │ │
   │  │ Tablespce│  │ .MYD/.MYI│  │ persist  │  │                  │ │
   │  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘ │
   │                                                                   │
   │  Each engine implements the handler interface (handler.h)         │
   └───────────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  OS / File   │
                    │  System /    │
                    │  Raw Device  │
                    └──────────────┘
```

### Layer Responsibilities Summary

| Layer              | Owns                                           | Does NOT own                        |
|--------------------|-------------------------------------------------|-------------------------------------|
| Connection Layer   | Auth, SSL, thread lifecycle, protocol decode     | SQL parsing, data storage           |
| SQL Layer          | Parse, optimize, execute, ACL, rewrite, cache    | Physical row storage, crash recovery|
| Storage Engine     | B+Tree, row format, MVCC, redo/undo, tablespace | SQL syntax, join algorithms         |

**>>> "MySQL's pluggable storage engine architecture means the SQL layer is
engine-agnostic. This is both its greatest strength (flexibility) and its
greatest weakness (the SQL layer cannot exploit engine-specific features like
InnoDB's clustered index without breaking the abstraction)."**

---

## 1.3 Connection Handling Layer

### 1.3.1 Thread-Per-Connection Model (Default)

In MySQL Community Edition, each client connection gets a dedicated OS thread.
The lifecycle:

```
  Client                    mysqld
    │                         │
    │── TCP SYN ─────────────>│  (1) OS accept() on port 3306
    │<─ SYN-ACK ─────────────│
    │── ACK ─────────────────>│
    │                         │
    │<─ Handshake Packet ─────│  (2) Server sends protocol version,
    │   (protocol v10,        │      salt for auth, capability flags
    │    server version,      │      Source: sql/auth/sql_authentication.cc
    │    auth salt)           │
    │                         │
    │── Auth Response ───────>│  (3) Client sends username, auth data,
    │   (user, scramble,      │      desired database, client flags
    │    db, client_flags)    │
    │                         │
    │                         │  (4) Server checks mysql.user table,
    │                         │      validates password hash (caching_sha2)
    │                         │      Source: sql/auth/sql_auth_cache.cc
    │                         │
    │                         │  (5) Assign thread from cache or create new
    │                         │      - Check thread_cache first
    │                         │      - If empty, pthread_create()
    │                         │      - Create THD object (session state)
    │                         │      Source: sql/conn_handler/
    │                         │                connection_handler_per_thread.cc
    │                         │
    │<─ OK Packet ────────────│  (6) Connection established
    │                         │
    │── COM_QUERY ───────────>│  (7) Query loop begins
    │   "SELECT 1"            │      dispatch_command() in sql_parse.cc
    │                         │
    │<─ Result Set ───────────│  (8) Results sent as protocol packets
    │                         │
    │── COM_QUIT ────────────>│  (9) Client disconnects
    │                         │      Thread returned to cache or destroyed
    │                         │
```

**The THD Object** (`sql/sql_class.h:class THD`)

Every connection gets a `THD` (Thread Descriptor) object. This is the single
most important data structure in MySQL's SQL layer. It holds:

- Current database name
- Current user and privileges (cached from ACL tables)
- Statement parse tree (the current `LEX` object)
- Diagnostics area (warnings, errors)
- Transaction state and savepoints
- Per-session variables (`@@session.*`)
- Memory allocator (`MEM_ROOT` for the current statement)
- NET structure (socket I/O buffers)
- Pointer to the current open tables list

A THD is roughly 30-50 KB in practice, but the per-session buffers it triggers
(sort buffer, join buffer, tmp tables) can push per-connection memory to megabytes.

### 1.3.2 Thread Cache

Creating and destroying OS threads is expensive (~20-50 μs for `pthread_create` on
Linux, plus stack allocation). MySQL maintains a thread cache to recycle threads:

```
  ┌──────────────────────────────────────────────────────────┐
  │  THREAD CACHE  (thread_cache_size, default 9 in 8.0)    │
  │  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐                    │
  │  │ Thr │  │ Thr │  │ Thr │  │ Thr │  ... (idle threads) │
  │  └─────┘  └─────┘  └─────┘  └─────┘                     │
  │  Connect:  cached > 0 ? wake idle thread : pthread_create│
  │  Disconnect: cached < cache_size ? sleep on condvar      │
  │              else pthread_exit()                          │
  │  Monitor: Threads_cached, Threads_created (should be low)│
  └──────────────────────────────────────────────────────────┘
```

**>>> If `Threads_created` is climbing rapidly during steady state, your
`thread_cache_size` is too small. Each thread creation costs a `pthread_create()`
plus stack allocation (default `thread_stack` = 1 MB). On a server handling
1,000 short-lived connections/sec, this matters.**

### 1.3.3 Thread Pool (Enterprise / Percona)

The thread-per-connection model breaks down at high connection counts (10,000+):

- Each idle thread holds ~1 MB of stack space
- Context switching overhead grows with thread count
- Thundering herd on mutex wakeups

The thread pool solves this by **decoupling connections from threads**:

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  THREAD POOL                                                     │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │  Thread Group 0          Thread Group 1         ...  N-1 │   │
  │  │  ┌───────────────┐      ┌───────────────┐              │   │
  │  │  │ Listener Thr  │      │ Listener Thr  │              │   │
  │  │  │ (epoll_wait)  │      │ (epoll_wait)  │              │   │
  │  │  └───────┬───────┘      └───────┬───────┘              │   │
  │  │          ▼                      ▼                       │   │
  │  │  ┌─────────────┐       ┌─────────────┐                 │   │
  │  │  │ Work Queue  │       │ Work Queue  │                 │   │
  │  │  │ (conn A,B,C)│       │ (conn D,E,F)│                 │   │
  │  │  └──────┬──────┘       └──────┬──────┘                 │   │
  │  │         ▼                     ▼                         │   │
  │  │  ┌────────────┐       ┌────────────┐                   │   │
  │  │  │Worker Thr 1│       │Worker Thr 1│                   │   │
  │  │  │Worker Thr 2│       │Worker Thr 2│                   │   │
  │  │  └────────────┘       └────────────┘                   │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │  group_id = connection_id % thread_pool_size                     │
  │  Key insight: N connections served by M threads where M << N     │
  └─────────────────────────────────────────────────────────────────┘
```

| Parameter                    | Default   | Purpose                                                |
|------------------------------|-----------|--------------------------------------------------------|
| `thread_pool_size`           | #CPUs     | Number of thread groups                                |
| `thread_pool_oversubscribe`  | 3         | Max active workers per group before queueing           |
| `thread_pool_stall_limit`    | 60 ms     | If no progress in this time, start a new worker        |
| `thread_pool_max_threads`    | 100000    | Absolute ceiling                                       |

**>>> In interviews, contrast the thread-per-connection model (simple, high memory
at scale) with the thread pool (complex, handles 10K+ connections). Mention
that the thread pool is not in Community Edition — Percona Server includes it
as open source.**

### 1.3.4 max_connections and OS Limits

`max_connections` (default 151) controls how many client connections MySQL accepts.
But the actual limit is the **minimum** of several factors:

```
  Effective max connections = min(
      max_connections setting,                     ← MySQL config
      (open_files_limit - files_for_tables) / 1,   ← file descriptor budget
      available_memory / per_connection_memory,     ← RAM budget
      OS thread limit (ulimit -u)                   ← kernel limit
  )
  
  Per connection: 1 fd (socket). Per table open: 1 fd (.ibd) or 2 fds (.MYD+.MYI).
  open_files_limit should be >= max_connections + (table_open_cache * 2)
  Default in 8.0: max(5000, max_connections * 5 + table_open_cache * 2)
```

MySQL reserves one extra connection for `SUPER`/`CONNECTION_ADMIN` users (the
"+1" connection) so DBAs can connect even when `max_connections` is exhausted.
In 8.0.14+, `admin_address` and `admin_port` provide a dedicated admin interface.

---

## 1.4 SQL Layer Deep Dive

The SQL layer turns text into a physical execution plan. The pipeline:

```
  SQL Text
    │
    ▼
  ┌──────────────────────────────────┐
  │ LEXER (sql/sql_lex.cc)           │
  │ Tokenize into symbols:           │
  │ SELECT → keyword                 │
  │ *      → STAR                    │
  │ FROM   → keyword                 │
  │ users  → IDENT                   │
  │ WHERE  → keyword                 │
  │ id     → IDENT                   │
  │ =      → EQ                      │
  │ 5      → NUM                     │
  └──────────┬───────────────────────┘
             │ Token stream
             ▼
  ┌──────────────────────────────────┐
  │ PARSER (sql/sql_yacc.yy)         │
  │ Bison LALR(1) grammar            │
  │ Produces parse tree (LEX)        │
  │ ~17,000 lines of grammar rules   │
  └──────────┬───────────────────────┘
             │ Parse tree (LEX/Query_block)
             ▼
  ┌──────────────────────────────────┐
  │ RESOLVER                          │
  │ (sql/sql_resolver.cc)            │
  │ - Name resolution: find tables,  │
  │   columns in schema              │
  │ - Type checking and coercion     │
  │ - View expansion                  │
  │ - Privilege checks               │
  └──────────┬───────────────────────┘
             │ Resolved AST
             ▼
  ┌──────────────────────────────────┐
  │ QUERY TRANSFORMER                 │
  │ (sql/sql_optimizer.cc,           │
  │  sql/sql_select.cc)              │
  │ - Subquery flattening            │
  │   (IN → semi-join)               │
  │ - Derived table merging          │
  │ - Outer join simplification      │
  │ - Constant folding               │
  │ - Predicate pushdown             │
  └──────────┬───────────────────────┘
             │ Transformed AST
             ▼
  ┌──────────────────────────────────┐
  │ COST-BASED OPTIMIZER             │
  │ (sql/sql_optimizer.cc,           │
  │  sql/opt_range.cc,               │
  │  sql/sql_planner.cc)             │
  │ - Access path enumeration        │
  │ - Join order permutation         │
  │ - Index selection                │
  │ - Cost estimation                │
  │   (engine statistics +           │
  │    server cost model)            │
  │ - Produces execution plan        │
  └──────────┬───────────────────────┘
             │ Execution plan (JOIN / AccessPath)
             ▼
  ┌──────────────────────────────────┐
  │ EXECUTOR                          │
  │ (sql/sql_executor.cc,            │
  │  sql/iterators/*)                │
  │ - Iterator model (8.0+)          │
  │ - Pull-based: root calls         │
  │   Read() → child calls Read()    │
  │ - Returns rows to client via     │
  │   protocol layer                 │
  └──────────────────────────────────┘
```

### 1.4.1 Lexer and Parser

**The Lexer** (`sql/sql_lex.cc`, `sql/sql_lex.h`)

MySQL's lexer is hand-written C++ (not Lex/Flex-generated). A hand-written lexer
handles MySQL's context-sensitive tokenization (identifier vs reserved word
disambiguation, backtick-quoted identifiers).

Key functions:
- `MYSQLlex()` — the main entry point called by the Bison parser
- `lex_one_token()` — scans one token from the input stream
- Character set handling: the lexer must handle multi-byte character sets
  (`utf8mb4`) correctly, meaning a single "character" can be 1-4 bytes

**The Parser** (`sql/sql_yacc.yy`)

GNU Bison generates an LALR(1) parser from `sql_yacc.yy` — one of the largest
Bison grammars in any open-source project:

```
  sql_yacc.yy statistics (MySQL 8.0):
  ┌────────────────────────────┬──────────┐
  │ Metric                     │ Value    │
  ├────────────────────────────┼──────────┤
  │ Lines of grammar           │ ~17,000  │
  │ Production rules           │ ~7,000   │
  │ Terminal symbols           │ ~900     │
  │ Nonterminal symbols        │ ~3,500   │
  │ Generated C file size      │ ~800 KB  │
  │ Parse states               │ ~12,000  │
  └────────────────────────────┴──────────┘
```

The parser outputs a `LEX` structure (`sql/sql_lex.h`) containing:
- `Query_block` objects (one per SELECT, including subqueries)
- `Table_ref` list (tables referenced)
- `Item` tree (expression hierarchy: columns, functions, operators)
- Statement type (`SQLCOM_SELECT`, `SQLCOM_INSERT`, etc.)

**>>> "MySQL's parser is Bison-generated LALR(1), which means it cannot handle
ambiguous grammars. This is why MySQL sometimes rejects syntactically valid-looking
SQL — the grammar has to be unambiguous. PostgreSQL uses a similar approach but
with a more carefully curated grammar."**

### 1.4.2 Name Resolution and Type Checking

After parsing, the resolver (`sql/sql_resolver.cc`) does:

1. **Table resolution**: Match each table name to a real table in the schema.
   Open the table definition from the data dictionary.
   Source: `sql/sql_base.cc:open_tables()`

2. **Column resolution**: Match each column reference to its table.
   Handle ambiguous column names (error if column exists in multiple tables
   without qualification). Source: `sql/item.cc:Item_field::fix_fields()`

3. **Type checking**: Determine the result type of each expression.
   Insert implicit type coercions (e.g., comparing VARCHAR to INT triggers
   string-to-number conversion). Source: `sql/item.cc:Item::fix_fields()`

4. **View expansion**: Replace view references with the underlying query block.

5. **Privilege checks**: Verify the user has SELECT/INSERT/UPDATE/DELETE on
   the resolved tables and columns.

### 1.4.3 Query Rewriting and Transformations

Before cost-based optimization, MySQL applies logical transformations:

| Transformation               | What it does                                     | Source file                     |
|------------------------------|--------------------------------------------------|---------------------------------|
| Subquery to semi-join        | `IN (SELECT ...)` → semi-join                    | `sql/sql_resolver.cc`           |
| Derived table merging        | Inline simple subqueries in FROM clause          | `sql/sql_resolver.cc`           |
| Outer join → Inner join      | If WHERE filters nulls, OUTER JOIN is redundant  | `sql/sql_optimizer.cc`          |
| Constant folding             | `WHERE 1=1 AND x=5` → `WHERE x=5`               | `sql/sql_optimizer.cc`          |
| Predicate pushdown           | Push WHERE conditions into joined tables         | `sql/sql_optimizer.cc`          |
| Equality propagation         | `a=b AND b=5` → `a=5 AND b=5`                   | `sql/sql_optimizer.cc`          |
| Impossible WHERE detection   | `WHERE 1=0` → return empty result immediately    | `sql/sql_optimizer.cc`          |

**>>> Subquery flattening is one of MySQL's most important optimizations. In MySQL
5.5 and earlier, correlated subqueries were executed row-by-row (O(N*M) disaster).
MySQL 5.6+ converts many IN/EXISTS subqueries to semi-joins, enabling hash joins
and reducing complexity to O(N+M). If an interviewer asks about MySQL subquery
performance, this transformation is the answer.**

### 1.4.4 Cost-Based Optimizer (Overview)

The optimizer evaluates physical plans and picks the cheapest one. Key concepts:

- **Cost model**: Two-component — `io_cost` (page reads) + `cpu_cost` (row evaluations)
- **Statistics source**: `mysql.innodb_table_stats` and `mysql.innodb_index_stats`
  (persistent statistics, sampled from 20 random pages by default)
- **Join enumeration**: Greedy/exhaustive search depending on table count
  (`optimizer_search_depth`, default 62 — effectively exhaustive for ≤ 7 tables)
- **Access paths**: table scan, index scan, range scan, ref lookup, eq_ref, const

The optimizer is covered in depth in Chapter 2.

### 1.4.5 Executor: Old Model vs New Iterator Model

**Pre-8.0: "Item + handler" model**

The old executor was deeply coupled to the optimizer. It used a `JOIN::exec()`
function that directly called handler methods in a nested-loop pattern. The
execution plan was encoded as a series of `QEP_TAB` objects (Query Execution Plan
Tabs) wired together implicitly.

**MySQL 8.0+: Iterator Model (Volcano Model)**

MySQL 8.0 introduced a proper iterator-based executor. Each operation is an
`RowIterator` subclass with a uniform interface:

```cpp
// sql/iterators/row_iterator.h (simplified)
class RowIterator {
 public:
  virtual bool Init() = 0;       // Initialize/reset
  virtual int Read() = 0;        // Return next row, or -1 for EOF
  virtual ~RowIterator() = default;
  
  // Read() returns:
  //   0  = row available in the record buffer
  //  -1  = no more rows (EOF)
  //   1  = error
};
```

Iterator types in MySQL 8.0:

```
  TableScanIterator          ← full table scan via ha_rnd_next()
  IndexScanIterator          ← ordered index scan via ha_index_next()
  IndexRangeScanIterator     ← range scan via handler::multi_range_read
  RefIterator                ← index lookup via ha_index_read()
  NestedLoopIterator         ← nested loop join
  HashJoinIterator           ← hash join (new in 8.0.18)
  SortingIterator            ← sort via filesort
  AggregateIterator          ← GROUP BY aggregation
  FilterIterator             ← WHERE/HAVING condition evaluation
  LimitOffsetIterator        ← LIMIT/OFFSET enforcement
  MaterializeIterator        ← materialize subquery/CTE to temp table
  StreamingIterator          ← streaming access (no materialization)
  WindowIterator             ← window function evaluation
```

Example iterator tree for `SELECT * FROM t1 JOIN t2 ON t1.a = t2.b WHERE t1.x > 10`:

```
  LimitOffsetIterator (LIMIT)
    │
    FilterIterator (WHERE t1.x > 10)
    │
    NestedLoopIterator (JOIN)
    ├── TableScanIterator (t1)
    └── RefIterator (t2, index on t2.b)
```

**>>> The shift to the iterator model in 8.0 is architecturally significant. It
enabled hash joins (impossible in the old model), cleaner EXPLAIN ANALYZE output,
and laid the groundwork for parallel query execution in future versions. In
interviews, knowing that MySQL only got hash joins in 8.0.18 shows deep awareness
of MySQL's evolution.**

### 1.4.6 Query Cache — A Cautionary Tale

The query cache was removed entirely in MySQL 8.0.0. Understanding why teaches
fundamental concurrency lessons.

**How it worked:**
- Cache key: exact SQL text (byte-for-byte, including whitespace and case)
- Cache value: complete result set
- On any write to a table, ALL cached queries referencing that table were
  invalidated — even if the write didn't affect the cached rows

**Why it was removed:**

```
  Problem 1: Global Mutex (LOCK_query_cache)
    Every lookup, store, and invalidation acquires this single mutex.
    At >32 cores, threads spend more time waiting than executing.
    Throughput DECREASES with more cores.

  Problem 2: Invalidation Storms
    INSERT INTO orders → invalidate ALL cached queries touching `orders`.
    If 10,000 queries cached for `orders`, each removed under the global mutex.
    One INSERT can stall the entire server for milliseconds.

  Problem 3: Byte-exact matching
    "SELECT * FROM users WHERE id = 1" and "select * from users where id = 1"
    are DIFFERENT cache entries. Hit rate typically < 20% in real workloads.
```

**>>> Interviewers ask "Why was MySQL's query cache removed?" to test understanding
of mutex contention at scale. The answer: a single global mutex serialized all
reads and writes to the cache, making it a scalability bottleneck on multi-core
systems. The fix was not to shard the mutex — it was to remove the cache entirely
because the invalidation model was fundamentally flawed for write-heavy workloads.**

---

## 1.5 Storage Engine API (Handler Interface)

### 1.5.1 The `handler` Abstract Class

The handler interface is MySQL's abstraction boundary between SQL and storage.
Defined in `sql/handler.h`, the `handler` class is abstract — each storage engine
subclasses it:

```
  handler (abstract base)                   Source: sql/handler.h
    │
    ├── ha_innobase (InnoDB)                Source: storage/innobase/handler/ha_innodb.cc
    │
    ├── ha_myisam (MyISAM)                  Source: storage/myisam/ha_myisam.cc
    │
    ├── ha_heap (MEMORY/HEAP)               Source: storage/heap/ha_heap.cc
    │
    ├── ha_temptable (TempTable engine, 8.0) Source: storage/temptable/src/handler.cc
    │
    ├── ha_archive (Archive)                Source: storage/archive/ha_archive.cc
    │
    └── ha_ndbcluster (NDB Cluster)         Source: storage/ndb/src/ndbapi/
```

### 1.5.2 Key Handler Methods

The SQL layer calls these methods on the handler. The handler translates them
into engine-specific operations.

```
  ┌─────────────────────────────┬────────────────────┬──────────────────┐
  │  HANDLER METHOD             │ PURPOSE            │ InnoDB impl      │
  ├─────────────────────────────┼────────────────────┼──────────────────┤
  │  ha_open()                  │ Open a table       │ Opens .ibd       │
  │  ha_close()                 │ Close a table      │ Releases latches │
  │  ha_create()                │ CREATE TABLE       │ Creates tablespc │
  │  ha_write_row(uchar *buf)   │ INSERT             │ B+Tree insert    │
  │  ha_update_row(old, new)    │ UPDATE             │ In-place/del+ins │
  │  ha_delete_row(uchar *buf)  │ DELETE             │ Mark deleted     │
  │  ha_rnd_init(bool scan)     │ Init table scan    │ Cursor→first leaf│
  │  ha_rnd_next(uchar *buf)    │ Next row (scan)    │ Walk leaf chain  │
  │  ha_rnd_end()               │ End table scan     │ Release cursor   │
  │  ha_index_init(uint idx)    │ Open index cursor  │ Position at root │
  │  ha_index_read(buf,key,..)  │ Seek to key        │ B+Tree→leaf      │
  │  ha_index_next(buf)         │ Next in idx order  │ Next leaf entry  │
  │  ha_index_prev(buf)         │ Prev in idx order  │ Walk backward    │
  │  ha_index_end()             │ Close idx cursor   │ Release cursor   │
  │  ha_start_consistent_snap() │ Begin snapshot     │ MVCC read view   │
  │  ha_commit_or_rollback()    │ Commit/rollback    │ Flush redo, unlk │
  │  ha_records()               │ Row count estimate │ Persistent stats │
  │  ha_info(uint flag)         │ Table stats        │ File lengths     │
  └─────────────────────────────┴────────────────────┴──────────────────┘
```

### 1.5.3 How a Table Scan Works Through the Handler

When the executor does a full table scan:

```
  Executor                          InnoDB (ha_innobase)
    │                                │
    │  ha_rnd_init(true)            │
    │──────────────────────────────>│  Position cursor at first user record
    │                                │  in clustered index (leftmost leaf page)
    │                                │
    │  ha_rnd_next(buf)             │
    │──────────────────────────────>│  1. Read row from current position
    │  ◄───── 0 (success) ─────────│  2. Check MVCC visibility (is this row
    │  (row data in buf)            │     visible to current transaction?)
    │                                │  3. Advance cursor to next record
    │  ha_rnd_next(buf)             │  4. If page not in buffer pool,
    │──────────────────────────────>│     read from disk (I/O)
    │  ◄───── 0 (success) ─────────│
    │                                │
    │  ... (repeat for each row)    │
    │                                │
    │  ha_rnd_next(buf)             │
    │──────────────────────────────>│  Reached end of leaf chain
    │  ◄───── HA_ERR_END_OF_FILE ──│
    │                                │
    │  ha_rnd_end()                 │
    │──────────────────────────────>│  Release cursor, release page latches
    │                                │
```

### 1.5.4 Plugin Architecture

Storage engines are plugins. The relevant source files:

- `sql/sql_plugin.cc` — Plugin loading infrastructure
- `sql/handler.h` — `handlerton` struct (engine descriptor)

Each engine registers a `handlerton`:

```cpp
// Simplified from storage/innobase/handler/ha_innodb.cc
static handlerton *innodb_hton;

static int innodb_init(MYSQL_PLUGIN p) {
    innodb_hton = (handlerton *)p;
    innodb_hton->create = innobase_create_handler;  // factory method
    innodb_hton->commit = innobase_commit;
    innodb_hton->rollback = innobase_rollback;
    innodb_hton->start_consistent_snapshot = innobase_start_trx_and_assign_read_view;
    innodb_hton->flush_logs = innobase_flush_logs;
    // ... dozens more function pointers
    return 0;
}
```

Administrative commands:

```sql
SHOW ENGINES;                         -- List available engines and their status
INSTALL PLUGIN myengine SONAME 'ha_myengine.so';   -- Load an engine plugin
SELECT * FROM information_schema.ENGINES;           -- Same, via I_S
```

### 1.5.5 Why This Abstraction Exists

**>>> The handler abstraction allows MySQL to have a single, stable SQL layer
while swapping storage engines underneath. This is MySQL's defining architectural
differentiator from PostgreSQL (which has a tightly integrated heap+WAL+MVCC
model). The cost of this abstraction is that the SQL layer cannot exploit
engine-specific features without adding special-case code (e.g., the optimizer
has InnoDB-specific code paths for clustered index detection and adaptive hash
index hints).**

The abstraction also means:
- You can have different tables in the same database use different engines
- Third parties can write engines without modifying the SQL layer
- Testing the SQL layer against a simulated engine (MOCK) is feasible

The downside:
- The handler API was designed for row-at-a-time access. Batch/vectorized
  processing requires changes to both sides of the interface.
- Cross-engine transactions require two-phase commit coordination, which
  MySQL implements in `sql/tc_log.cc` and `sql/binlog.cc`.

---

## 1.6 Memory Architecture

### 1.6.1 Global vs Per-Session Memory

MySQL's memory divides into two categories:

```
  GLOBAL MEMORY (shared across all connections):
  ┌──────────────────────────────────┬───────────────────────┐
  │ innodb_buffer_pool_size          │ 128M-128G (70-80% RAM)│
  │ innodb_log_buffer_size           │ 16 MB default         │
  │ key_buffer_size (MyISAM only)    │ 8 MB default          │
  │ table_open_cache                 │ 4000 entries (~4KB ea)│
  │ table_definition_cache           │ 2000 entries          │
  │ Performance Schema               │ ~100-400 MB auto-sized│
  └──────────────────────────────────┴───────────────────────┘

  PER-SESSION MEMORY (× max_connections, allocated ON DEMAND):
  ┌──────────────────────────────────┬──────────────┐
  │ sort_buffer_size                 │ 256 KB       │
  │ join_buffer_size                 │ 256 KB       │
  │ read_buffer_size                 │ 128 KB       │
  │ read_rnd_buffer_size             │ 256 KB       │
  │ net_buffer_length                │ 16 KB        │
  │ thread_stack                     │ 1 MB (64-bit)│
  │ binlog_cache_size                │ 32 KB        │
  │ tmp_table_size (per query)       │ 16 MB        │
  └──────────────────────────────────┴──────────────┘
```

### 1.6.2 MEM_ROOT Allocator — Arena-Style Allocation

MySQL uses an arena allocator called `MEM_ROOT` (defined in `include/my_alloc.h`)
for parse trees, resolved ASTs, and other per-statement memory:

```
  MEM_ROOT: [Block1 4K FULL] → [Block2 8K FULL] → [Block3 16K <<<free>>>]
                                                     ↑ bump pointer (current)
  Alloc: O(1) bump pointer forward. Dealloc: free ALL blocks at statement end.
  No individual free(). Block sizes grow exponentially: 4K → 8K → 16K → 32K.
```

**>>> MEM_ROOT is an arena allocator. You can only allocate from it, not free
individual objects. The entire arena is freed at once (typically at statement end).
This makes allocation O(1) (pointer bump) and deallocation O(n-blocks) instead
of O(n-allocations). It eliminates fragmentation within a statement's lifetime.
This is a common pattern in database engines and compilers.**

Key MEM_ROOT usage:
- Each `THD` has a `MEM_ROOT` for the current statement (`thd->mem_root`)
- A separate `MEM_ROOT` for persistent per-connection allocations
- Parse tree nodes (`Item`, `Table_ref`) are allocated on the statement MEM_ROOT
- When the statement finishes, the MEM_ROOT is reset (blocks returned to free list)

### 1.6.3 Per-Session Buffer Details

| Buffer                     | When Allocated                        | How Used                                         |
|----------------------------|---------------------------------------|--------------------------------------------------|
| `sort_buffer_size`         | When filesort is needed               | In-memory sort workspace. If data exceeds this, multi-pass external merge sort on disk. |
| `join_buffer_size`         | Per join (BNL/BKA/hash join)          | Block Nested Loop: accumulate outer rows, then scan inner. Hash join: build hash table. |
| `read_buffer_size`        | Sequential scan of MyISAM tables      | Read-ahead buffer for sequential reads. Less relevant for InnoDB (has its own read-ahead). |
| `read_rnd_buffer_size`    | After sort, for reading sorted rows   | Multi-Range Read buffer — read rows in PK order to reduce random I/O. |
| `tmp_table_size`           | When internal temp table is needed    | Max size of in-memory temp table before converting to on-disk (InnoDB or TempTable engine). |
| `max_heap_table_size`      | Limits in-memory temp table size      | The effective temp table limit is `MIN(tmp_table_size, max_heap_table_size)`. |

### 1.6.4 When Internal Temp Tables Spill to Disk

MySQL creates internal temporary tables for:
- `GROUP BY` when no index covers the grouping
- `DISTINCT` when no index covers the dedup
- `UNION` (always, for deduplication)
- `ORDER BY` + `GROUP BY` on different columns
- Certain subquery materializations

Spill decision flow:

```
  Fits in memory? → TempTable engine [8.0] (temptable_max_ram=1G, var-length rows)
                    or MEMORY engine [5.7]. Overflow → mmap files or on-disk InnoDB.
  Exceeds limit?  → On-disk InnoDB temp table (ibtmp1/#innodb_temp/). Much slower.
  FORCED to disk:   TEXT/BLOB in MEMORY engine (TempTable handles these in 8.0),
                    row size > 64KB.
```

**>>> Check `Created_tmp_disk_tables` / `Created_tmp_tables` ratio. If disk
temp tables are > 10% of total, investigate: either increase
`tmp_table_size`/`max_heap_table_size`, or refactor queries to avoid temp tables
(add covering indexes for GROUP BY, avoid UNION when UNION ALL suffices).**

### 1.6.5 Total Memory Estimation Formula

```
  Total MySQL Memory (worst case) ≈

    innodb_buffer_pool_size                           (biggest component)
  + innodb_log_buffer_size                            (16 MB default)
  + key_buffer_size                                   (MyISAM index cache)
  + performance_schema memory                         (auto-sized, ~100-400 MB)
  + table_open_cache × per_entry_overhead             (~4 KB/entry)
  + table_definition_cache × per_entry_overhead       (~4 KB/entry)
  + max_connections × (
      thread_stack                                    (1 MB)
    + net_buffer_length                               (16 KB, grows to max_allowed_packet)
    + sort_buffer_size                                (256 KB, if sorting)
    + join_buffer_size                                (256 KB, per join)
    + read_buffer_size                                (128 KB)
    + read_rnd_buffer_size                            (256 KB)
    + binlog_cache_size                               (32 KB)
    + MIN(tmp_table_size, max_heap_table_size)        (16 MB, per query)
  )

  Example (64 GB RAM): BP=44G + log_buf=64M + P_S=400M + caches=24M
    + 500 conns × ~3MB = 1.5G + OS=2G ≈ 48G → ~16G for OS page cache
  Note: per-session buffers allocated ON DEMAND, not upfront.
```

**>>> In production sizing: set `innodb_buffer_pool_size` to 70-80% of
available RAM. Leave at least 2-4 GB for the OS page cache (needed for
doublewrite buffer, redo log writes, and binary log reads during replication).
The per-session memory is your swing factor — with connection pooling (HikariCP
at 20-50 connections), the per-session total is modest. Without pooling
(1,000+ connections), per-session memory can eat your buffer pool budget.**

---

## 1.7 System Databases and Metadata

MySQL 8.0 has four system schemas and a transactional data dictionary.

### 1.7.1 The `mysql` Schema

Contains server operational tables:

| Table Category       | Key Tables                                          | Purpose                           |
|----------------------|-----------------------------------------------------|-----------------------------------|
| Authentication       | `user`, `db`, `tables_priv`, `columns_priv`,        | ACL: who can do what              |
|                      | `procs_priv`, `proxies_priv`, `role_edges`          |                                   |
| Server config        | `global_grants`, `default_roles`, `password_history`| 8.0 fine-grained privileges       |
| Replication          | `slave_relay_log_info`, `slave_master_info`,        | Crash-safe replication metadata   |
|                      | `gtid_executed`                                     |                                   |
| Optimizer            | `innodb_table_stats`, `innodb_index_stats`,         | Persistent statistics             |
|                      | `server_cost`, `engine_cost`                        | Cost model parameters             |
| Components           | `component`                                         | Installed components              |
| Time zone            | `time_zone`, `time_zone_name`, `time_zone_transition`| TZ data for CONVERT_TZ()         |
| Help                 | `help_topic`, `help_category`, `help_relation`      | HELP command data                 |

### 1.7.2 `information_schema` — Metadata Views

`information_schema` provides SQL-standard metadata access. Key behavioral detail:

Pre-8.0: scanned .frm files + opened each table for stats. Extremely slow for
thousands of tables, could hold locks and block DDL.

8.0: views over InnoDB data dictionary (cached). No table opens needed. Orders
of magnitude faster. Statistics read from `innodb_table_stats` (cached, not live).
For live stats: `SET information_schema_stats_expiry = 0;` (default 86400s / 24h).

Key information_schema tables:

| View                 | Source                    | Notes                                     |
|----------------------|---------------------------|--------------------------------------------|
| `TABLES`             | Data dictionary           | Row counts are ESTIMATED (from stats)      |
| `COLUMNS`            | Data dictionary           | Column metadata, collation, defaults       |
| `STATISTICS`         | Data dictionary + stats   | Index cardinality, nullable                |
| `INNODB_TRX`         | InnoDB trx sys            | Active transactions                        |
| `INNODB_LOCKS`       | InnoDB lock sys           | Current lock waits (removed in 8.0,        |
|                      |                           | replaced by performance_schema.data_locks) |
| `INNODB_BUFFER_PAGE` | Buffer pool               | Per-page contents — EXPENSIVE, locks BP    |
| `PROCESSLIST`        | THD list                  | Active connections (prefer P_S version)    |

### 1.7.3 `performance_schema` — Runtime Instrumentation

Performance Schema is an in-memory storage engine (`PERFORMANCE_SCHEMA`) that
provides runtime instrumentation with minimal overhead.

```
  Architecture:
  ┌──────────────────────────────────────────────────────────────────┐
  │  PERFORMANCE SCHEMA                                              │
  │                                                                  │
  │  Instruments: wait/synch/mutex/*, wait/io/file/*,                │
  │    statement/sql/*, stage/sql/*, transaction, memory/sql/*       │
  │                                                                  │
  │  Storage: fixed-size pre-allocated arrays, no disk I/O,          │
  │    no transactions, ring buffer history, full scan only           │
  │                                                                  │
  │  Key tables:                                                     │
  │    events_statements_current / _history / _history_long          │
  │    events_statements_summary_by_digest  ← aggregated stats       │
  │    events_waits_current                 ← current wait events    │
  │    data_locks / data_lock_waits         ← lock status + graph    │
  │    memory_summary_by_thread_by_event_name ← per-thread memory   │
  │    metadata_locks                       ← MDL lock status        │
  │                                                                  │
  │  Overhead: ~3-5% CPU (atomic counter increments per instrument)  │
  └──────────────────────────────────────────────────────────────────┘
```

**>>> performance_schema.events_statements_summary_by_digest is the single most
important table for production query analysis. It aggregates execution counts,
latencies, rows examined, rows sent, tmp tables, and full scans BY query
digest (normalized query pattern). This is the P_S equivalent of pg_stat_statements.**

### 1.7.4 `sys` Schema

The `sys` schema is a collection of views, functions, and procedures built on
top of performance_schema. It makes P_S data human-readable:

| sys view                              | Purpose                                              |
|---------------------------------------|------------------------------------------------------|
| `sys.statement_analysis`              | Top queries by total latency (from P_S digest)       |
| `sys.innodb_buffer_stats_by_table`    | Buffer pool usage per table                          |
| `sys.schema_table_statistics`         | I/O and latency per table                            |
| `sys.schema_redundant_indexes`        | Indexes that are prefixes of other indexes           |
| `sys.schema_unused_indexes`           | Indexes never used since server start                |
| `sys.memory_by_thread_by_current_bytes`| Memory usage per connection                         |
| `sys.host_summary`                    | Latency, connections, I/O by client host             |
| `sys.user_summary`                    | Same, grouped by user                                |
| `sys.wait_classes_global_by_avg_latency`| Top wait classes (I/O, lock, etc.)                 |

### 1.7.5 Data Dictionary (MySQL 8.0)

MySQL 8.0 replaced the old file-based metadata system with a transactional,
InnoDB-based data dictionary:

```
  Pre-8.0: .frm/.par/.TRG/.db.opt files → NOT transactional, no crash recovery
  8.0:     InnoDB system tables (mysql.ibd) → transactional, atomic DDL, no .frm
```

Key data dictionary tables (hidden, not directly queryable):

- `dd_tables` — table definitions
- `dd_columns` — column definitions
- `dd_indexes` — index definitions
- `dd_tablespaces` — tablespace metadata
- `dd_foreign_keys` — FK constraints

**>>> MySQL 8.0's atomic DDL is a direct consequence of the transactional data
dictionary. A `DROP TABLE` that crashes mid-way will either complete or roll
back — no more orphaned .frm files without data or data without .frm files.
This also means `ALTER TABLE` crash safety improved dramatically. When an
interviewer asks "what changed in MySQL 8.0?", the transactional data dictionary
and atomic DDL should be in your top-3 answer.**

---

## 1.8 Lifecycle of a Query — End-to-End Trace

Let us trace the complete execution of:

```sql
SELECT * FROM users WHERE id = 5;
```

Assumptions: `users` table has a PRIMARY KEY on `id`, InnoDB engine, buffer pool
is warm (page is cached), autocommit=ON, client connected over TCP.

```
  PHASE 0: NETWORK RECEIVE     [sql/conn_handler/connection_handler_per_thread.cc]
  Thread blocks on vio_read() (wrapper around recv()). COM_QUERY packet arrives:
    Bytes 0-3: packet length + seq#  |  Byte 4: 0x03 (COM_QUERY)
    Byte 5+: "SELECT * FROM users WHERE id = 5"

  PHASE 1: COMMAND DISPATCH     [sql/sql_parse.cc:dispatch_command()]
  dispatch_command() reads command byte (COM_QUERY), updates Com_select++,
  sets up statement MEM_ROOT, sets thd->set_query(...), calls mysql_parse().

  PHASE 2: LEXING AND PARSING   [sql/sql_lex.cc + sql/sql_yacc.yy]
  Lexer: SELECT_SYM → * → FROM → IDENT("users") → WHERE → IDENT("id") → EQ → NUM("5")
  Parser (Bison) → LEX object:
    sql_command = SQLCOM_SELECT
    Query_block: Item_field("*"), Table_ref("users"),
                 Item_func_eq(Item_field("id"), Item_int(5))
  All nodes on thd->mem_root. Parse time: ~5-20 μs.

  PHASE 3: PRIVILEGE CHECK      [sql/auth/sql_authorization.cc]
  Coarse check: does user have SELECT on any table? (mysql.user, mysql.db)
  Fine-grained column-level check deferred to after name resolution.
```

```
  PHASE 4: TABLE OPEN AND NAME RESOLUTION
  ════════════════════════════════════════
  Source: sql/sql_base.cc:open_tables_for_query()
          sql/sql_resolver.cc:Query_block::prepare()

  4a. Open the table:
      - Look up "users" in the data dictionary (dd_tables)
      - Check table_open_cache (keyed by db+table+thread)
      - If not cached: open the .ibd file, read table metadata
      - Acquire a Metadata Lock (MDL) in SHARED_READ mode
        (prevents concurrent DDL from dropping the table)
      - Create a TABLE object with column definitions loaded

  4b. Resolve names:
      - Item_field("*") → expand to all columns of `users`
        (id, name, email, created_at, ...)
      - Item_field("id") in WHERE → resolve to users.id (column #0)
      - Item_int(5) → type is LONGLONG

  4c. Type checking:
      - WHERE condition: id (INT) = 5 (INT) → type-compatible, no coercion needed
```

```
  PHASE 5: QUERY OPTIMIZATION
  ═══════════════════════════
  Source: sql/sql_optimizer.cc:JOIN::optimize()
          sql/opt_range.cc (range analysis)
          sql/sql_planner.cc (join planning)

  5a. Logical transformations:
      - Single table, no joins to reorder
      - WHERE id = 5 → constant equality on PRIMARY KEY
      - Optimizer recognizes this as a "const" table (at most one row)

  5b. Access path selection:
      - PRIMARY KEY exact lookup (eq_ref on clustered index)
      - Cost: 1 page read (estimated), CPU for 1 row evaluation
      - This is the cheapest possible access path

  5c. Plan generated:
      - Access type: const (system table, at most one row)
      - Key: PRIMARY
      - Key length: 4 (INT)
      - Rows examined (estimate): 1

  EXPLAIN output would show:
  ┌────┬────────────┬───────┬──────┬──────────┬─────────┬─────────┬──────┐
  │ id │ select_type│ table │ type │ possible │ key     │ key_len │ rows │
  │    │            │       │      │ keys     │         │         │      │
  ├────┼────────────┼───────┼──────┼──────────┼─────────┼─────────┼──────┤
  │  1 │ SIMPLE     │ users │ const│ PRIMARY  │ PRIMARY │ 4       │ 1    │
  └────┴────────────┴───────┴──────┴──────────┴─────────┴─────────┴──────┘

  Optimization time: ~10-30 μs for simple queries.
```

```
  PHASE 6: EXECUTION (Iterator Model, 8.0)
  ════════════════════════════════════════
  Source: sql/sql_executor.cc
          sql/iterators/ref_row_iterators.cc

  For a "const" access, the optimizer actually reads the row DURING optimization
  (since it can be at most one row, it's evaluated early and stored in the
  record buffer).

  But conceptually, the iterator tree is:

    ConstIterator (reads the single matching row)
      └── calls handler: ha_innobase::ha_index_read_map()

  6a. Handler call chain:
      ha_index_read_map(buf, key=5, keypart_map, HA_READ_KEY_EXACT)
        └── InnoDB: row_search_mvcc()
              ├── btr_cur_search_to_nth_level()   ← B+Tree descent
              │     ├── Read root page of PRIMARY index from buffer pool
              │     ├── Binary search within page for key = 5
              │     ├── Follow child pointer to leaf page
              │     └── Binary search in leaf page for key = 5
              ├── Check MVCC visibility (read view vs row trx_id)
              │     └── Row trx_id < read view low_limit → VISIBLE
              └── Copy row data into MySQL record buffer (buf)

  6b. Buffer pool interaction:
      - The B+Tree root page is almost certainly in the buffer pool
        (hot pages stay cached via LRU with midpoint insertion)
      - Leaf page containing id=5: if table is actively queried,
        likely in buffer pool. If not → disk read (~100 μs SSD, ~5 ms HDD)
      - Buffer pool latch: acquire hash_lock for the page's bucket
        (sharded across 1024+ partitions in 8.0 to reduce contention)

  6c. Row format:
      - InnoDB stores rows in COMPACT or DYNAMIC format
      - Row is read from the 16 KB page, field offsets decoded from
        the variable-length field length list
      - NULL bitmap checked for NULL columns
      - Data copied into MySQL's internal record format (TABLE::record[0])
```

```
  PHASE 7: RESULT SET TRANSMISSION  [sql/protocol_classic.cc, sql/net_serv.cc]
  Send: [ColCount:5][ColDef:id][ColDef:name]...[EOF][Row:5|"alice"|...][OK]
  Column definitions include catalog, schema, table, name, charset, type, flags.
  Row data: each field as length-encoded string, NULLs in bitmap.
  OK packet: affected_rows, status flags (AUTOCOMMIT), warnings count.

  PHASE 8: CLEANUP               [sql/sql_parse.cc, sql/sql_class.cc]
  - Reset MEM_ROOT (free arena blocks for this statement)
  - Close tables not needed (TABLE objects may stay in table_open_cache)
  - Release MDL_SHARED_READ on `users`
  - Update: slow query log, performance_schema, status vars (Handler_read_key++)
  - Thread returns to vio_read(), blocks for next command
  - If idle > wait_timeout (default 28800s=8h), connection is closed
```

### Full Timing Breakdown (Typical, Warm Buffer Pool, SSD)

```
  ┌───────────────────────────────────┬─────────────┬──────────────┐
  │ Phase                             │ Time (μs)   │ % of Total   │
  ├───────────────────────────────────┼─────────────┼──────────────┤
  │ Network receive (read packet)     │ 5-20        │ 3-10%        │
  │ Command dispatch                  │ 1-2         │ <1%          │
  │ Lexing + Parsing                  │ 10-25       │ 5-15%        │
  │ Name resolution + table open      │ 10-30       │ 5-15%        │
  │ Optimization                      │ 10-30       │ 5-15%        │
  │ Execution (BP hit, PK lookup)     │ 5-15        │ 3-10%        │
  │ Result serialization + send       │ 5-15        │ 3-10%        │
  │ Cleanup                           │ 3-10        │ 2-5%         │
  ├───────────────────────────────────┼─────────────┼──────────────┤
  │ TOTAL (warm, PK lookup)           │ 50-150      │ 100%         │
  │ TOTAL (cold, disk read needed)    │ 200-5000    │ + disk I/O   │
  └───────────────────────────────────┴─────────────┴──────────────┘
  
  Key insight: for a simple PK lookup on a warm buffer pool,
  the SQL layer overhead (parse + resolve + optimize) is often
  50-70% of total time. The actual data retrieval is fast.
  
  This is why prepared statements matter for OLTP:
    Prepared statement skips lexing + parsing + optimization on re-execute.
    COM_STMT_EXECUTE goes straight to execution → ~30-50 μs saved per call.
```

### Source File Map — Key Files Touched in This Query

| File | Role |
|------|------|
| `sql/conn_handler/connection_handler_per_thread.cc` | Thread-per-conn loop |
| `sql/sql_parse.cc` | dispatch_command(), mysql_parse(), mysql_execute_command() |
| `sql/sql_lex.cc` | Lexer (MYSQLlex) |
| `sql/sql_yacc.yy` → `sql/sql_yacc.cc` | Parser (Bison-generated) |
| `sql/sql_resolver.cc` | Name/type resolution |
| `sql/sql_base.cc` | Table open/close |
| `sql/auth/sql_authorization.cc` | Privilege checks |
| `sql/sql_optimizer.cc` | Query optimization |
| `sql/opt_range.cc` | Range/index analysis |
| `sql/sql_planner.cc` | Join planning |
| `sql/sql_executor.cc` | Iterator tree execution |
| `sql/iterators/ref_row_iterators.cc` | Index lookup iterator |
| `sql/handler.cc` / `sql/handler.h` | Handler API dispatch / abstract class |
| `storage/innobase/handler/ha_innodb.cc` | InnoDB handler implementation |
| `storage/innobase/row/row0sel.cc` | row_search_mvcc() |
| `storage/innobase/btr/btr0cur.cc` | B+Tree cursor operations |
| `storage/innobase/buf/buf0buf.cc` | Buffer pool page access |
| `sql/protocol_classic.cc` | Result set wire format |
| `sql/net_serv.cc` | Network packet send/recv |

---

## Summary — Architecture at a Glance

| Architectural Property | Detail |
|------------------------|--------|
| Single process, multi-threaded | Shared address space. Fast data sharing, no crash isolation. |
| Three-layer pipeline | Connection → SQL → Storage Engine. Clean separation. |
| Pluggable engines | `handler.h` contract. InnoDB, MyISAM, MEMORY, etc. |
| Arena allocation | MEM_ROOT: O(1) alloc, bulk free at statement end. |
| Data dictionary (8.0) | Transactional InnoDB-based. Atomic DDL. No .frm files. |

**Interview-critical numbers:**
- Thread context switch: ~1-3 us
- Simple PK lookup (warm): 50-150 us end-to-end
- Parse time: 10-25 us
- Per-connection memory: ~1-3 MB (stack + on-demand buffers)
- Buffer pool: 70-80% of available RAM
- max_connections default: 151
- Thread pool break-even: ~200+ connections

---

*Next: Chapter 2 — The SQL Layer: Parser, Optimizer, Executor — dives deep into
cost-based optimization, join algorithms, the new hash join implementation, and
how EXPLAIN ANALYZE traces real execution costs.*
