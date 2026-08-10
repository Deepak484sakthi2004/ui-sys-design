# Chapter 11: Thread Architecture and I/O Subsystem

> How MySQL uses OS threads, memory, and disk I/O. This chapter treats mysqld as a
> systems program: you will see exactly which pthreads exist inside a running server,
> what memory each one touches, and how bytes travel from buffer pool pages to
> spinning or flash media.

---

## 1. Process Model --- Threads vs Processes

### 1.1 MySQL: Single-Process, Multi-Threaded

mysqld is a single operating-system process. Every connection, every background task,
every I/O operation runs as a POSIX thread (`pthread`) inside that one process. All
threads share a single virtual address space, a single heap, and a single set of file
descriptors.

```
                          PID 31042  (mysqld)
  ┌───────────────────────────────────────────────────────────┐
  │                    Shared Address Space                    │
  │                                                           │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
  │  │ Conn #1  │ │ Conn #2  │ │ Conn #3  │ │ Conn #N  │    │
  │  │ (thread) │ │ (thread) │ │ (thread) │ │ (thread) │    │
  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘    │
  │       │            │            │             │           │
  │  ┌────┴────────────┴────────────┴─────────────┴────┐     │
  │  │              InnoDB Buffer Pool (shared)         │     │
  │  │              Redo Log Buffer (shared)            │     │
  │  │              Data Dictionary Cache (shared)      │     │
  │  └──────────────────────────────────────────────────┘     │
  │                                                           │
  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      │
  │  │ Page Cleaner │ │ Purge Thread │ │ I/O Threads  │      │
  │  │  (bg thread) │ │  (bg thread) │ │ (bg threads) │      │
  │  └──────────────┘ └──────────────┘ └──────────────┘      │
  │                                                           │
  └───────────────────────────────────────────────────────────┘
```

Consequence: when any thread corrupts the heap (buffer overflow, use-after-free), the
entire server process is compromised. There is no OS-level isolation between a
connection handling a simple `SELECT 1` and a background thread flushing dirty pages.

### 1.2 PostgreSQL: Multi-Process

PostgreSQL forks a new process for each client connection. The processes share data
through explicit shared memory regions (`shared_buffers`, `pg_xact`, etc.) mapped via
`mmap()` or System V shared memory.

```
  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │  postmaster  │──►│  backend #1  │   │  backend #2  │
  │  PID 5000    │   │  PID 5001    │   │  PID 5002    │
  └──────────────┘   └──────┬───────┘   └──────┬───────┘
                            │                  │
                     ┌──────┴──────────────────┴──────┐
                     │   shared_buffers (mmap/shm)    │
                     │   WAL buffers (mmap/shm)       │
                     │   pg_xact (mmap/shm)           │
                     └────────────────────────────────┘
```

Each backend has its own private heap, its own `work_mem` allocation, its own sort
buffers. A crash in one backend is caught by the postmaster, which terminates all
backends, runs crash recovery, and restarts --- disruptive, but the postmaster itself
survives.

### 1.3 Tradeoffs Table

| Aspect | MySQL (Threads) | PostgreSQL (Processes) |
|--------|----------------|----------------------|
| Context switch cost | Lower --- same address space, no TLB flush | Higher --- full TLB flush, page table switch |
| Memory sharing | Free --- all threads see shared heap | Explicit --- data shared via `shared_buffers`, SysV/mmap |
| Fault isolation | None --- one thread crash = server crash | Contained --- postmaster catches backend crash |
| Connection overhead | ~1 MB per thread (stack + THD object) | ~5-10 MB per process (private heap, `work_mem`) |
| Max connections practical | Thousands feasible | Hundreds practical without `pgbouncer` |
| Cache coherence | Single buffer pool, no duplication | Shared buffers + per-process OS page cache = duplication risk |
| Signal handling | Complex (signals to threads) | Standard UNIX process signals |
| Debugging | One process, many threads (gdb thread apply) | Each backend is a separate `gdb` target |

>>> **Interview insight**: "Why does MySQL use threads instead of processes?"
>>> Answer: MySQL chose threads for lower per-connection overhead and free memory
>>> sharing (the buffer pool is directly accessible by all connection threads). The
>>> downside is fault isolation --- a corrupted thread can crash the entire server.
>>> PostgreSQL chose processes for robustness and simpler crash containment, at the
>>> cost of higher per-connection memory and the need for explicit shared memory.

---

## 2. Connection Handling --- Thread Per Connection

### 2.1 Connection Lifecycle

When a client opens a TCP connection to port 3306, the main listener thread (the
acceptor) picks it up and assigns a worker thread to handle it:

```
Client          mysqld (acceptor)           Worker Thread
  │                    │                         │
  ├──TCP SYN──────────►│                         │
  │                    ├──create/reuse thread────►│
  │                    │                         │
  │◄──────────────────Handshake packet───────────┤
  ├──Auth response────►│                         │
  │                    │         ┌────────────────┤
  │                    │         │ Authenticate   │
  │                    │         │ (mysql.user)   │
  │                    │         └────────────────┤
  │◄──────────────────OK / ERR───────────────────┤
  │                    │                         │
  │  ┌─── Command Loop ──────────────────────────┤
  │  │  COM_QUERY  ──────────────────────────────►│
  │  │                    │         ┌─────────────┤
  │  │                    │         │ Parse        │
  │  │                    │         │ Optimize     │
  │  │                    │         │ Execute      │
  │  │                    │         │ handler::*   │
  │  │                    │         └─────────────┤
  │  │◄──────────────Result set──────────────────┤
  │  │                                            │
  │  │  COM_QUIT  ───────────────────────────────►│
  │  └────────────────────────────────────────────┤
  │                    │         ┌────────────────┤
  │                    │         │ Cleanup THD    │
  │                    │         │ Return to      │
  │                    │         │ thread cache   │
  │                    │         └────────────────┤
  │◄──TCP FIN─────────────────────────────────────┤
```

### 2.2 Thread Allocation and THD

Every connection is represented internally by a `THD` object (`sql/sql_class.h`), which
holds:

- Current database, user, host, privileges
- Parser state, current statement text
- Pointer to the current query's execution plan
- Per-session variables (copies of global defaults that can be overridden per session)
- Diagnostics area (warnings, errors)
- NET structure (socket file descriptor, read/write buffers)

The `THD` is allocated on the heap, not on the thread stack. Stack space is controlled
by `thread_stack` (default 1 MB on 64-bit Linux). The actual memory footprint of a THD
object is roughly 10-50 KB; total per-connection overhead including stack is ~1 MB when
idle.

### 2.3 Thread Cache

Creating and destroying OS threads is expensive: `pthread_create()` allocates stack
space, sets up TLS, and makes kernel calls. MySQL maintains a **thread cache** to avoid
this cost for short-lived connections.

```
┌──────────────────────────────────────────┐
│            Thread Cache                  │
│                                          │
│  ┌────────┐ ┌────────┐ ┌────────┐       │
│  │ idle   │ │ idle   │ │ idle   │ ...   │
│  │ thread │ │ thread │ │ thread │       │
│  └────────┘ └────────┘ └────────┘       │
│                                          │
│  thread_cache_size (auto-sized)          │
│  = 8 + max_connections / 100            │
│  (capped at 100)                         │
└──────────────────────────────────────────┘

New connection arrives:
  IF thread_cache not empty:
    pop idle thread → assign to connection         [fast path]
  ELSE:
    pthread_create() → new thread → assign         [slow path]

Connection closes:
  IF thread_cache.size < thread_cache_size:
    return thread to cache (thread blocks on condvar) [reuse]
  ELSE:
    pthread_exit() → thread destroyed              [destroy]
```

Monitor thread cache effectiveness:

```sql
SHOW GLOBAL STATUS LIKE 'Threads_%';
-- Threads_cached:    8    (idle threads in cache)
-- Threads_connected: 42   (active connections)
-- Threads_created:   150  (total threads ever created since startup)
-- Threads_running:   5    (threads currently executing a query)

-- If Threads_created grows fast, increase thread_cache_size
```

### 2.4 max_connections and Limits

```sql
SET GLOBAL max_connections = 500;   -- default 151
```

- Hard limit: `max_connections` concurrent client connections
- +1 reserved slot: for users with `SUPER` (pre-8.0) or `CONNECTION_ADMIN` (8.0+) privilege --- this allows an admin to connect even when all slots are full to diagnose problems
- When exceeded: client gets `ERROR 1040 (HY000): Too many connections`

OS-level limits that constrain max_connections:

```
# File descriptors (each connection needs at least 1 fd for the socket)
ulimit -n                          # per-process limit (default 1024 on many Linux)
sysctl fs.file-max                 # system-wide limit

# MySQL also uses fds for table files, logs, etc.
# Rule of thumb: ulimit -n >= max_connections + table_open_cache + 50

# Thread limit (kernel)
cat /proc/sys/kernel/threads-max   # system-wide max threads
cat /proc/sys/vm/max_map_count     # memory map areas per process (affects thread stacks)
```

### 2.5 Thread-Per-Connection Execution Flow

Each connection thread runs a command dispatch loop. For `COM_QUERY`, the full path:

```
Connection Thread Execution (COM_QUERY):

  dispatch_command()
       │
       ├─► mysql_parse()           -- lexer + parser → AST
       │       │
       │       └─► mysql_execute_command()
       │               │
       │               ├─► Sql_cmd_select::execute()
       │               │       │
       │               │       ├─► JOIN::optimize()    -- cost-based optimizer
       │               │       │       │
       │               │       │       └─► choose access paths, join order
       │               │       │
       │               │       └─► JOIN::exec()        -- iterator-based execution
       │               │               │
       │               │               └─► handler::ha_rnd_next() / ha_index_read()
       │               │                       │
       │               │                       └─► InnoDB: row_search_mvcc()
       │               │                               │
       │               │                               └─► buffer pool page access
       │               │
       │               └─► send results to client via NET
       │
       └─► return to command loop (wait for next packet)
```

>>> **Interview insight**: "What happens when max_connections is hit?"
>>> The server refuses new connections with error 1040. But one extra slot is
>>> reserved for `SUPER`/`CONNECTION_ADMIN`. In production, the real fix is
>>> connection pooling (ProxySQL, HikariCP), not raising max_connections blindly ---
>>> each connection consumes ~1 MB idle, and thousands of threads cause scheduling
>>> overhead even if most are sleeping.

---

## 3. Thread Pool (Enterprise / Percona / MariaDB)

### 3.1 The Problem

Thread-per-connection scales poorly beyond a few hundred active connections. When 2000
connections simultaneously execute queries, you have 2000 OS threads competing for CPU.
The kernel scheduler burns significant time on context switches, and the CPU cache
(L1/L2/L3) gets thrashed as each thread loads its own working set.

```
Thread-Per-Connection at High Concurrency:

  CPU Cores: 32
  Active Threads: 2000

  Ratio: 62.5 threads per core
  Context switches: tens of thousands per second
  Cache hit rate: drops because working sets don't fit in L1/L2

  Result: throughput DECREASES as connections increase beyond ~4x CPU count
```

Throughput curve:

```
  Throughput (QPS)
       │
       │        ╱╲
       │       ╱  ╲_________
       │      ╱              ╲___
       │     ╱                    ╲___
       │    ╱                          ╲___
       │   ╱
       │  ╱
       │ ╱
       └──────────────────────────────────► Connections
        0    64   256   512  1024  2048

  Peak throughput at ~2-4x CPU cores
  After that: context switch overhead dominates
```

### 3.2 Thread Pool Architecture

The thread pool decouples connections from threads. A fixed (or bounded) pool of worker
threads services all connections. Connections are divided into **thread groups**.

```
┌───────────────────────────────────────────────────────────────┐
│                     Thread Pool                               │
│                                                               │
│  Thread Group 0          Thread Group 1        Thread Group N │
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────┐│
│  │ Connections:     │   │ Connections:     │   │             ││
│  │   C0, C4, C8...  │   │   C1, C5, C9...  │   │   ...       ││
│  │                  │   │                  │   │             ││
│  │ Listener thread  │   │ Listener thread  │   │ Listener    ││
│  │  (epoll/kqueue)  │   │  (epoll/kqueue)  │   │  thread     ││
│  │                  │   │                  │   │             ││
│  │ Worker threads:  │   │ Worker threads:  │   │ Worker      ││
│  │  W0, W1          │   │  W2, W3          │   │  threads    ││
│  └─────────────────┘   └─────────────────┘   └─────────────┘│
│                                                               │
│  thread_pool_size = number of groups (default = CPU count)    │
└───────────────────────────────────────────────────────────────┘

Flow:
  1. Connection assigned to group = connection_id % thread_pool_size
  2. Listener thread in each group: epoll_wait() on all connections in the group
  3. When data arrives on a connection's socket:
     - Listener wakes up
     - Hands the connection to an available worker thread
  4. Worker thread:
     - Reads the query from the socket
     - Executes the query (parse → optimize → execute)
     - Sends result back
     - Returns the connection to the group's epoll set
  5. Worker thread picks up the next ready connection (or blocks)
```

### 3.3 Oversubscription and Stall Detection

Two critical controls prevent the thread pool from starving:

**`thread_pool_oversubscribe`** (default 3): maximum number of threads actively running
queries simultaneously within a single thread group. If a worker is already running and
another connection becomes ready, the listener checks if `active_threads < 1 + oversubscribe`.
If exceeded, the connection waits in the queue.

**Stall detection** (`thread_pool_stall_limit`, default 60 ms): a timer thread checks
each group periodically. If a group has connections waiting in the queue but its worker
has been running for longer than `stall_limit`, the thread pool creates an **additional
worker** for that group. This prevents a long-running query (e.g., a 5-second
aggregation) from blocking all other connections in the group.

```
Stall Detection:

  Timer thread (runs every thread_pool_stall_limit ms):
    FOR each thread group:
      IF queue is non-empty AND active_worker_runtime > stall_limit:
        create_additional_worker(group)
        // now the waiting connection can be served
```

### 3.4 Availability

| Server Variant | Thread Pool | License |
|---------------|-------------|---------|
| MySQL Community (Oracle) | No | GPL |
| MySQL Enterprise (Oracle) | Yes | Commercial |
| Percona Server | Yes (`thread_handling = pool-of-threads`) | GPL |
| MariaDB | Yes (different implementation, uses `pool-of-threads`) | GPL |

Percona's implementation uses `epoll` on Linux and is widely deployed in production
environments. MariaDB's thread pool uses a similar group-based design with some
differences in stall detection and priority handling (high-priority queue for
transactions already holding locks).

>>> **Interview insight**: "When would you use a thread pool?"
>>> When you have 500+ connections but most are idle or executing short queries.
>>> The thread pool keeps the number of OS threads proportional to CPU cores, not
>>> connections. It dramatically improves throughput under high concurrency by
>>> reducing context switches and cache thrashing. Not necessary if you already
>>> use connection pooling (ProxySQL/HikariCP) to keep active connections < 4x
>>> CPU cores.

---

## 4. Background Threads

A running InnoDB instance has 20-50+ background threads depending on configuration.
Here is the complete map:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    InnoDB Background Threads                        │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Master Thread (srv_master_thread)                          │   │
│  │  - 1-second loop: flush log buffer, merge change buffer     │   │
│  │  - 10-second loop: flush dirty pages, purge, checkpoint     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐                        │
│  │ Page Cleaner      │  │ Purge Threads     │                       │
│  │  Coordinator (1)  │  │  Coordinator (1)  │                       │
│  │  Workers (N-1)    │  │  Workers (N-1)    │                       │
│  │  innodb_page_     │  │  innodb_purge_    │                       │
│  │  cleaners = 4     │  │  threads = 4      │                       │
│  └──────────────────┘  └──────────────────┘                        │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐                        │
│  │ Read I/O Threads │  │ Write I/O Threads│                        │
│  │  (default 4)      │  │  (default 4)      │                       │
│  │  innodb_read_     │  │  innodb_write_    │                       │
│  │  io_threads       │  │  io_threads       │                       │
│  └──────────────────┘  └──────────────────┘                        │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Log Threads [8.0.22+]                                      │   │
│  │  log_writer        - writes log buffer → log files           │   │
│  │  log_flusher       - fsyncs log files to durable storage     │   │
│  │  log_write_notifier - wakes txns waiting for log write       │   │
│  │  log_flush_notifier - wakes txns waiting for log fsync       │   │
│  │  log_checkpointer  - advances checkpoint LSN                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐                        │
│  │ Error Monitor     │  │ Lock Timeout     │                        │
│  │  Thread           │  │  Thread           │                       │
│  └──────────────────┘  └──────────────────┘                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.1 Master Thread (`srv_master_thread`)

The master thread is InnoDB's central coordinator. It runs a loop with two timing
intervals:

**Every ~1 second**:
1. Flush the redo log buffer to disk (ensures durability even if no commits)
2. Merge change buffer entries (if server is idle --- fewer than `innodb_io_capacity`
   I/Os occurred in the last second)
3. Perform adaptive checkpoint if needed

**Every ~10 seconds**:
1. Flush up to `innodb_io_capacity_max` dirty pages
2. Flush redo log buffer
3. Purge undo records (in older versions; now delegated to purge threads)
4. Merge change buffer
5. Full checkpoint if needed

In MySQL 8.0, many of these duties have been offloaded to dedicated threads (page
cleaners, log threads), but the master thread still orchestrates periodic tasks.

### 4.2 Page Cleaner Threads

Controlled by `innodb_page_cleaners` (default 4). One coordinator thread distributes
dirty page flush work across worker threads.

```
Page Cleaner Architecture:

  Coordinator Thread
       │
       ├─ Determines flush target:
       │    - How many dirty pages to flush this cycle?
       │    - Which buffer pool instances to target?
       │    - Uses adaptive flushing algorithm:
       │        flush_rate = f(redo_log_generation_rate, dirty_page_pct, io_capacity)
       │
       ├─ Distributes work:
       │    Each worker assigned a buffer pool instance
       │
       ├──► Worker 0: flush dirty pages from BP instance 0
       ├──► Worker 1: flush dirty pages from BP instance 1
       ├──► Worker 2: flush dirty pages from BP instance 2
       └──► Worker 3: flush dirty pages from BP instance 3
```

**Adaptive flushing** (`innodb_adaptive_flushing = ON`, default): InnoDB monitors the
rate of redo log generation and the percentage of dirty pages. If the redo log is
filling up fast, flushing accelerates. If dirty pages exceed
`innodb_max_dirty_pages_pct` (default 90), aggressive flushing kicks in.

The target flush rate is bounded by:
- `innodb_io_capacity` (default 200): normal I/O budget (IOPS) for background flushing
- `innodb_io_capacity_max` (default 2000): maximum I/O budget during urgent flushing

For SSDs, set these higher: `innodb_io_capacity = 2000`, `innodb_io_capacity_max = 10000`.

### 4.3 Purge Threads

Controlled by `innodb_purge_threads` (default 4). Purge performs two tasks:

1. **Delete-mark removal**: rows marked for deletion by `DELETE` statements are not
   physically removed immediately. Purge scans the undo log history list and physically
   removes rows whose delete-marks are no longer visible to any active ReadView.

2. **Undo log truncation**: after purging, the undo log records themselves are freed.

```
Purge Thread Architecture:

  Purge Coordinator
       │
       ├─ Reads undo log history list (oldest → newest)
       │    - Finds undo records for committed transactions
       │    - Checks: is any active ReadView still referencing this version?
       │    - If no: mark for physical deletion
       │
       ├─ Distributes purge work:
       │    Each worker thread handles a batch of undo records
       │
       ├──► Worker 0: physically delete rows from table/index pages
       ├──► Worker 1: physically delete rows from table/index pages
       └──► Worker 2: physically delete rows from table/index pages
```

`innodb_purge_batch_size` (default 300): number of undo log pages to process per purge
call. `innodb_max_purge_lag` (default 0, disabled): if the purge history length exceeds
this value, InnoDB delays DML operations to let purge catch up.

Monitor purge lag:

```sql
SHOW ENGINE INNODB STATUS\G
-- Look for: "History list length" in TRANSACTIONS section
-- This is the number of unpurged undo log records
-- If growing: long-running transaction is blocking purge
```

### 4.4 Log Threads (MySQL 8.0.22+)

Before 8.0.22, redo log writing was done by the committing user thread itself. This
caused contention: under high concurrency, many threads competed to write to the log
buffer and fsync the log file.

MySQL 8.0.22 introduced **dedicated log threads** that decouple log writing from user
threads:

```
User Thread                Log Threads                  Disk
    │                          │                          │
    ├─ write redo record ──►   │                          │
    │  to log buffer           │                          │
    │                          │                          │
    ├─ wait on event ──────►   │                          │
    │  (log_write_notifier)    │                          │
    │                          │                          │
    │                   log_writer:                        │
    │                   ├─ collect log buffer ────────────►│ write()
    │                   │  contents                       │
    │                          │                          │
    │                   log_flusher:                       │
    │                   ├─ fsync() ──────────────────────►│ fsync()
    │                   │                                 │
    │                   log_flush_notifier:                │
    │                   ├─ wake waiting user ──────────►  │
    │◄─ notified ──────┤  threads                        │
    │                          │                          │
    │                   log_checkpointer:                  │
    │                   └─ advance checkpoint LSN          │
```

This design implements **log write-ahead** as a producer-consumer pattern:
- **User threads** (producers): append redo records to the in-memory log buffer
- **log_writer** (consumer): batches writes from the log buffer to log files via `write()`
- **log_flusher**: calls `fsync()` to make writes durable
- **log_write_notifier / log_flush_notifier**: wake up user threads waiting for their
  LSN to be written/fsynced

The benefit is **group commit amplification**: one `fsync()` can make hundreds of
transactions durable simultaneously.

### 4.5 Other Background Threads

| Thread | Purpose |
|--------|---------|
| Error monitor | Watches for I/O errors, tablespace corruption signals |
| Lock timeout (`srv_lock_timeout_thread`) | Scans the lock wait queue every second; if a thread has waited > `innodb_lock_wait_timeout` (default 50s), rolls back the waiting statement |
| Buffer pool dump/load | `innodb_buffer_pool_dump_at_shutdown`, `innodb_buffer_pool_load_at_startup`: saves/restores the list of pages in the buffer pool (warmup) |
| Event scheduler | Runs scheduled events (`CREATE EVENT`) if `event_scheduler = ON` |
| Signal handler thread | Dedicated thread to handle UNIX signals (`SIGHUP`, `SIGTERM`) |

>>> **Interview insight**: "What happens if the purge thread falls behind?"
>>> The undo history length grows, the undo tablespace balloons, and old row
>>> versions accumulate. This degrades read performance (longer version chains
>>> to traverse) and wastes storage. The root cause is almost always a
>>> long-running transaction holding an old ReadView. Fix: kill the long
>>> transaction. Prevent: set `innodb_max_purge_lag` to throttle DML when
>>> history length is excessive.

---

## 5. I/O Subsystem

### 5.1 I/O Thread Architecture

InnoDB uses dedicated I/O threads for asynchronous read and write operations:

```
┌─────────────────────────────────────────────────────────────┐
│                    I/O Thread Pool                           │
│                                                             │
│  Read I/O Threads (innodb_read_io_threads = 4)             │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │
│  │ Read-0 │ │ Read-1 │ │ Read-2 │ │ Read-3 │              │
│  │ pages  │ │ pages  │ │ pages  │ │ pages  │              │
│  │ 0-N/4  │ │ N/4-   │ │ N/2-   │ │ 3N/4- │              │
│  │        │ │   N/2  │ │  3N/4  │ │    N   │              │
│  └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘              │
│       │          │          │          │                    │
│       └──────────┴──────────┴──────────┘                   │
│                      │                                      │
│              io_submit() / io_getevents()                   │
│              (Linux native AIO via libaio)                  │
│                      │                                      │
│  Write I/O Threads (innodb_write_io_threads = 4)           │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │
│  │Write-0 │ │Write-1 │ │Write-2 │ │Write-3 │              │
│  └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘              │
│       │          │          │          │                    │
│       └──────────┴──────────┴──────────┘                   │
│                      │                                      │
│              io_submit() / io_getevents()                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Each I/O thread is responsible for a range of tablespace pages. When a page needs to be
read (buffer pool miss) or written (dirty page flush), the request is dispatched to the
appropriate I/O thread based on the page's tablespace and offset.

For read-heavy workloads (OLTP with many random reads), increase `innodb_read_io_threads`
to 8 or 16. For write-heavy workloads, increase `innodb_write_io_threads` similarly.

### 5.2 Native AIO (Linux)

When `innodb_use_native_aio = ON` (default on Linux), InnoDB uses the kernel's
asynchronous I/O interface:

```
Native AIO Flow:

  InnoDB Thread                 Kernel AIO                    Disk
       │                           │                           │
       ├─ io_setup()              │                           │
       │  (create AIO context)     │                           │
       │                           │                           │
       ├─ io_submit(iocb[])  ─────►│                           │
       │  (submit batch of         │                           │
       │   read/write requests)    │                           │
       │                           ├─ DMA transfer ──────────►│
       │                           │   (kernel handles I/O     │
       │                           │    without blocking       │
       │                           │    the calling thread)    │
       │                           │                           │
       ├─ io_getevents() ◄────────┤                           │
       │  (wait for completions)   │                           │
       │                           │                           │
       ├─ process completed        │                           │
       │  pages (update buffer     │                           │
       │  pool, wake waiters)      │                           │
```

**Why native AIO matters**: without it, InnoDB must simulate async I/O by having each
I/O thread call `pread()`/`pwrite()` synchronously in a loop. Native AIO allows the
kernel to execute multiple I/O operations concurrently, fully utilizing the disk's
command queue (especially important for SSDs with high queue depth).

**Requirement**: the `libaio` library must be installed (`libaio-devel` / `libaio1`).
If not available, InnoDB falls back to simulated AIO automatically.

### 5.3 Simulated AIO

On systems without native AIO (macOS, older BSDs, some container environments where
`io_setup()` fails):

```
Simulated AIO:

  Each I/O thread runs a loop:
    WHILE running:
      request = dequeue from I/O request queue  (blocking if empty)
      pread(fd, buf, count, offset)             (synchronous read)
      OR pwrite(fd, buf, count, offset)         (synchronous write)
      signal completion to waiting thread
```

This is functionally correct but cannot overlap I/O operations within a single thread.
Parallelism comes only from having multiple I/O threads.

### 5.4 Read-Ahead

InnoDB performs two types of read-ahead to prefetch pages before they are needed:

**Linear read-ahead** (`innodb_read_ahead_threshold`, default 56):
If 56 out of 64 pages in an extent (1 MB) are accessed sequentially, InnoDB
asynchronously reads the next extent. Useful for table scans.

**Random read-ahead** (`innodb_random_read_ahead`, default OFF):
If 13 consecutive pages from the same extent are found in the buffer pool (regardless
of access order), read the remaining pages in that extent. Usually disabled because it
causes unnecessary I/O.

```sql
SHOW ENGINE INNODB STATUS\G
-- "Pages read ahead" and "evicted without access" in BUFFER POOL AND MEMORY section
-- If "evicted without access" is high: read-ahead is too aggressive
```

---

## 6. innodb_flush_method --- Data and Log File I/O Paths

### 6.1 The Core Problem

InnoDB has its own buffer pool. The OS also has a page cache. If InnoDB writes through
the OS page cache, every data page is cached **twice**: once in the buffer pool and once
in the OS page cache. This wastes RAM.

```
Double Buffering Problem:

  Application (mysqld)          OS Kernel              Disk
  ┌──────────────────┐     ┌──────────────┐     ┌──────────┐
  │  Buffer Pool     │────►│  Page Cache   │────►│  .ibd    │
  │  (16 KB pages)   │     │  (4 KB pages) │     │  files   │
  │  64 GB allocated │     │  eats another │     │          │
  │                  │     │  64 GB of RAM │     │          │
  └──────────────────┘     └──────────────┘     └──────────┘

  Total RAM used for the same data: 128 GB
  Useful RAM: 64 GB
  Wasted: 64 GB
```

### 6.2 Flush Method Options

| Value | Data files open | Data files flush | Log files open | Log files flush | Notes |
|-------|----------------|-----------------|----------------|----------------|-------|
| `fsync` (default pre-8.0.26) | `O_RDWR` | `fsync()` | `O_RDWR` | `fsync()` | Double buffering; OS page cache active for both data and log |
| `O_DIRECT` (recommended for Linux) | `O_RDWR \| O_DIRECT` | `fsync()` | `O_RDWR` | `fsync()` | Bypasses OS cache for data; log still goes through OS cache |
| `O_DIRECT_NO_FSYNC` | `O_RDWR \| O_DIRECT` | (no fsync) | `O_RDWR` | (no fsync) | Skips fsync entirely; only safe with battery-backed RAID controller |
| `O_DSYNC` | `O_RDWR` | `fsync()` | `O_RDWR \| O_DSYNC` | (implicit sync on write) | Sync log writes immediately; data still double-buffered |
| `unbuffered` (Windows) | No OS cache | N/A | No OS cache | N/A | Windows equivalent of O_DIRECT |

Default changed in MySQL 8.0.26+: `O_DIRECT_NO_FSYNC` became the default on Linux when
`innodb_flush_method` was mapped to the new unified `innodb_extend_and_initialize`
behavior (but for most explicit configurations, `fsync` remains the historical default).

### 6.3 I/O Path Diagrams

**With `fsync` (default)**:

```
  Buffer Pool Page (dirty)
       │
       ├─ write() ──────────► OS Page Cache ──────────► Disk
       │                      (data cached here too)
       │
       └─ fsync(fd) ─────────► forces OS page cache
                                to flush to disk
```

**With `O_DIRECT`**:

```
  Buffer Pool Page (dirty)
       │
       ├─ write() with O_DIRECT ──────────────────────► Disk
       │   (bypasses OS page cache entirely)
       │   (requires memory alignment: 512B or 4K)
       │
       └─ fsync(fd) ──────► ensures device cache is flushed
                             (still needed for on-device write cache)
```

**With `O_DIRECT_NO_FSYNC`**:

```
  Buffer Pool Page (dirty)
       │
       └─ write() with O_DIRECT ──────────────────────► Disk
          (bypasses OS page cache)
          (no fsync() call)
          (safe ONLY if RAID controller has battery-backed write cache
           that guarantees durability)
```

### 6.4 Production Recommendations

For production Linux deployments:

```
innodb_flush_method = O_DIRECT
```

Always. No exceptions unless you have a specific reason (e.g., ZFS which handles
caching internally, or a RAID controller where `O_DIRECT_NO_FSYNC` is safe).

Rationale:
- Eliminates double buffering (data in both buffer pool and OS page cache)
- Gives InnoDB full control over its memory budget
- Prevents the OS from evicting hot pages under memory pressure
- On SSDs, O_DIRECT is fully efficient (no seek penalty, direct DMA transfer)

---

## 7. O_DIRECT Deep Dive

### 7.1 What O_DIRECT Does

`O_DIRECT` is a flag on `open()` that tells the kernel: "do not cache this file's data
in the page cache. Transfer directly between my user-space buffer and the block device."

```
Normal I/O (without O_DIRECT):

  User buffer ──copy──► Kernel page cache ──DMA──► Disk

  - Two copies: user → kernel, kernel → disk
  - Kernel caches the data (useful for general-purpose applications)
  - Kernel handles alignment, buffering, read-ahead

O_DIRECT I/O:

  User buffer ──────────────────────DMA──────────► Disk

  - One copy: user buffer directly to disk via DMA
  - No kernel caching (the application manages its own cache)
  - Strict alignment requirements
```

### 7.2 Alignment Requirements

O_DIRECT requires:
- **Buffer address**: must be aligned to the logical block size (typically 512 bytes or
  4096 bytes for 4K-native drives)
- **Transfer size**: must be a multiple of the logical block size
- **File offset**: must be a multiple of the logical block size

InnoDB handles all of these internally:
- Buffer pool pages are allocated with `posix_memalign()` or `aligned_alloc()` at 16 KB
  boundaries (which satisfies any 512-byte or 4K alignment requirement)
- Page size (16 KB) is a multiple of any standard block size
- Pages are read/written at page-aligned offsets

### 7.3 O_DIRECT with SSD vs HDD

**SSD**: O_DIRECT is ideal. SSDs have no seek penalty, and their internal controller
handles command queuing. Eliminating the OS page cache frees RAM for the buffer pool.
The SSD's own internal DRAM cache provides short-term buffering.

**HDD**: O_DIRECT is essential for large databases. Without it, the OS page cache
competes with the buffer pool. Under memory pressure, the kernel might evict buffer pool
pages (swapping) to make room for page cache copies of the same data. With O_DIRECT,
InnoDB is the sole manager of database page caching.

### 7.4 When NOT to Use O_DIRECT

- **ZFS**: ZFS has its own ARC (Adaptive Replacement Cache). Use `fsync` and let ZFS
  manage caching. O_DIRECT on ZFS is either ignored or degrades performance.
- **NFS**: O_DIRECT over NFS is poorly supported and can silently fall back to buffered
  I/O. If you must use NFS for MySQL data, use `fsync`.
- **Very small databases**: if the entire database fits in OS page cache AND you have
  no buffer pool tuning, buffered I/O can be acceptable (but O_DIRECT is still better
  practice).

>>> **Interview insight**: "Why is O_DIRECT recommended for InnoDB on Linux?"
>>> InnoDB has its own buffer pool with an LRU tailored for database access
>>> patterns (young/old sublist). The OS page cache uses a generic LRU that
>>> wastes RAM by caching the same pages a second time. O_DIRECT eliminates
>>> this double buffering, ensuring all available RAM goes to the buffer pool
>>> where InnoDB can manage it intelligently. You still need fsync() for
>>> durability because O_DIRECT bypasses the page cache, not the device's
>>> volatile write cache.

---

## 8. Per-Session Memory Allocation

### 8.1 Memory Consumers Per Connection

Each connection thread allocates private memory for query execution. These buffers are
allocated on demand (not at connection time) and freed when the query completes.

```
Per-Session Memory Layout (during active query):

  ┌─────────────────────────────────────────────┐
  │              Connection Thread               │
  │                                             │
  │  ┌─────────────────────────────────────┐    │
  │  │  THD object (~10-50 KB)             │    │
  │  │  - session variables                │    │
  │  │  - security context                 │    │
  │  │  - diagnostics area                 │    │
  │  └─────────────────────────────────────┘    │
  │                                             │
  │  ┌─────────────────────────────────────┐    │
  │  │  Thread stack (thread_stack = 1 MB) │    │
  │  │  - function call frames             │    │
  │  │  - local variables                  │    │
  │  └─────────────────────────────────────┘    │
  │                                             │
  │  ┌──────────────────┐ ┌──────────────────┐  │
  │  │  sort_buffer      │ │  join_buffer      │  │
  │  │  256 KB           │ │  256 KB           │  │
  │  └──────────────────┘ └──────────────────┘  │
  │                                             │
  │  ┌──────────────────┐ ┌──────────────────┐  │
  │  │  read_buffer      │ │  read_rnd_buffer │  │
  │  │  128 KB           │ │  256 KB           │  │
  │  └──────────────────┘ └──────────────────┘  │
  │                                             │
  │  ┌─────────────────────────────────────┐    │
  │  │  tmp_table (in-memory, up to 16 MB) │    │
  │  └─────────────────────────────────────┘    │
  │                                             │
  │  ┌─────────────────────────────────────┐    │
  │  │  net_buffer (16 KB)                 │    │
  │  └─────────────────────────────────────┘    │
  │                                             │
  │  Idle:  ~1 MB (stack + THD)                 │
  │  Active: ~2-10 MB (depends on query)        │
  │  Worst case: ~16+ MB (large sorts + temps)  │
  └─────────────────────────────────────────────┘
```

### 8.2 Buffer Details

**`sort_buffer_size`** (default 256 KB):
Allocated per `ORDER BY`, `GROUP BY`, or `DISTINCT` that requires sorting. If the data
to sort exceeds this buffer, InnoDB does an **external sort** (filesort): sorts chunks
in memory, writes sorted runs to temp files, then merges them. Increasing this
reduces filesort I/O but wastes memory if set too high per-connection.

```
Sort algorithm decision:

  Data to sort <= sort_buffer_size?
    YES → single-pass in-memory quicksort → done
    NO  → external merge sort:
          1. Fill sort_buffer, sort it, write to temp file (sorted run)
          2. Repeat until all data processed
          3. Merge sorted runs from temp files → final result
```

**`join_buffer_size`** (default 256 KB):
Used when a join cannot use an index. In MySQL 8.0.18+, the executor uses **hash join**
for equi-joins without indexes (replacing the old Block Nested Loop). The join buffer
holds the build side of the hash table.

```
Hash Join (MySQL 8.0.18+):

  Build phase:
    Read smaller table → hash rows into join_buffer
    If join_buffer overflows → spill to disk (grace hash join)

  Probe phase:
    Read larger table → probe hash table for matches
```

**`read_buffer_size`** (default 128 KB):
Buffer for sequential table scans. When doing a full table scan, InnoDB reads pages
into this buffer in chunks. Larger values reduce the number of read system calls.

**`read_rnd_buffer_size`** (default 256 KB):
Used by Multi-Range Read (MRR) optimization. After reading index rows, MRR sorts the
primary key values and reads data pages in PK order (converting random I/O to
sequential I/O). This buffer holds the sorted PK values.

**`tmp_table_size` / `max_heap_table_size`** (default 16 MB each):
Maximum size of an in-memory temporary table. The effective limit is
`MIN(tmp_table_size, max_heap_table_size)`. When exceeded, the temp table spills to
disk (using TempTable engine mmap or InnoDB on-disk temp tablespace in MySQL 8.0).

**`net_buffer_length`** (default 16 KB):
Initial size of the per-connection network buffer for client-server communication.
Grows dynamically up to `max_allowed_packet` (default 64 MB) for large result sets or
large INSERT payloads.

### 8.3 The Danger of Per-Session Overallocation

```
Example: Overtuning session buffers

  sort_buffer_size  = 4 MB    (was 256 KB)
  join_buffer_size  = 4 MB    (was 256 KB)
  read_buffer_size  = 2 MB    (was 128 KB)
  tmp_table_size    = 64 MB   (was 16 MB)
  max_connections   = 1000

  Worst case per connection: 4 + 4 + 2 + 64 = 74 MB
  Total for 1000 connections: 74 GB
  Plus buffer pool: 64 GB
  Total: 138 GB on a 128 GB server → OOM killer

  Don't do this. Keep per-session buffers at defaults.
  Tune them per-session for specific queries if needed:
  SET SESSION sort_buffer_size = 4 * 1024 * 1024;  -- just for this session
```

>>> **Interview insight**: "How do you estimate MySQL's total memory usage?"
>>> `total = innodb_buffer_pool_size + innodb_log_buffer_size +
>>> key_buffer_size + (max_connections * per_session_max) + table_cache_overhead
>>> + performance_schema + temptable_max_ram`. In practice: buffer pool is 70-80%
>>> of RAM, and the rest must fit in the remaining 20-30%. The mistake everyone
>>> makes is raising per-session buffers globally rather than per-query.

---

## 9. Global Memory Allocation

### 9.1 Memory Map

```
Total MySQL Memory Budget:

  ┌─────────────────────────────────────────────────────────────┐
  │                    System RAM (128 GB)                       │
  │                                                             │
  │  ┌───────────────────────────────────────────────────┐      │
  │  │       InnoDB Buffer Pool (100 GB)                 │      │
  │  │       innodb_buffer_pool_size                     │      │
  │  │       (70-80% of RAM for dedicated MySQL server)  │      │
  │  └───────────────────────────────────────────────────┘      │
  │                                                             │
  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │
  │  │ Log Buffer   │ │ TempTable    │ │ Table Cache      │    │
  │  │   16 MB      │ │ Pool  1 GB   │ │  ~100 MB         │    │
  │  │ innodb_log_  │ │ temptable_   │ │ table_open_cache │    │
  │  │ buffer_size  │ │ max_ram      │ │ = 4000           │    │
  │  └──────────────┘ └──────────────┘ └──────────────────┘    │
  │                                                             │
  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │
  │  │ Perf Schema  │ │ Key Buffer   │ │ Data Dictionary  │    │
  │  │  ~400 MB     │ │   8 MB       │ │ Cache ~100 MB    │    │
  │  │ (default     │ │ key_buffer_  │ │ table_definition │    │
  │  │  instruments)│ │ size         │ │ _cache           │    │
  │  └──────────────┘ └──────────────┘ └──────────────────┘    │
  │                                                             │
  │  ┌───────────────────────────────────────────────────┐      │
  │  │    Per-Session Memory (max_connections * ~2 MB)    │      │
  │  │    1000 * 2 MB = ~2 GB                            │      │
  │  └───────────────────────────────────────────────────┘      │
  │                                                             │
  │  ┌──────────────────────────────────────┐                   │
  │  │    OS / Filesystem: ~10 GB reserved  │                   │
  │  └──────────────────────────────────────┘                   │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

### 9.2 Key Global Buffers

**`innodb_buffer_pool_size`**: the single most important MySQL configuration parameter.
It caches data pages, index pages, adaptive hash index entries, change buffer pages,
and undo log pages. For a dedicated MySQL server: set to 70-80% of total RAM.

```sql
-- Dynamic resize (MySQL 5.7.5+, in chunks of innodb_buffer_pool_chunk_size = 128 MB)
SET GLOBAL innodb_buffer_pool_size = 100 * 1024 * 1024 * 1024;  -- 100 GB

-- Monitor buffer pool
SHOW ENGINE INNODB STATUS\G   -- BUFFER POOL AND MEMORY section
SELECT * FROM information_schema.INNODB_BUFFER_POOL_STATS;
```

**`innodb_log_buffer_size`** (default 16 MB): staging area for redo log records before
they are written to log files. Larger values reduce the frequency of log writes for
transactions that generate a lot of redo (e.g., bulk inserts). Rarely needs tuning above
64 MB.

**`key_buffer_size`** (default 8 MB): MyISAM key cache. If your workload is 100% InnoDB
(it should be), set this to 8 MB or 1 MB --- the minimum. Do not waste RAM on it.

**`table_open_cache`** (default 4000): caches opened table file descriptors and
associated metadata. Each entry holds an `open()` file descriptor for the `.ibd` file.
If you have 10,000 tables, set this to at least 10,000 to avoid repeated open/close
cycles.

**`table_definition_cache`**: caches table definitions (column types, indexes, foreign
keys) parsed from the data dictionary. Auto-sized based on `table_open_cache` in
MySQL 8.0. Rarely needs manual tuning.

### 9.3 Memory Formula

```
Total MySQL Memory (worst case) ≈

    innodb_buffer_pool_size                            [fixed, largest]
  + innodb_log_buffer_size                             [fixed, 16 MB default]
  + key_buffer_size                                    [fixed, 8 MB default]
  + temptable_max_ram                                  [shared pool, 1 GB default]
  + performance_schema memory                          [~200-400 MB]
  + (max_connections × per_session_worst_case)         [variable]
  + table_open_cache × ~10 KB                          [fd + metadata per table]
  + OS/kernel overhead                                 [~2-5 GB]

Practical example (128 GB server, 1000 connections):

    100 GB  (buffer pool)
  +  16 MB  (log buffer)
  +   8 MB  (key buffer)
  +   1 GB  (temptable)
  + 400 MB  (perf schema)
  +   2 GB  (1000 × 2 MB sessions)
  + 200 MB  (table cache)
  +  10 GB  (OS/kernel)
  ─────────
  ~114 GB  ← leaves ~14 GB headroom

  If per-session buffers are cranked up, this overflows.
```

---

## 10. TempTable Engine (MySQL 8.0)

### 10.1 Why TempTable Replaced MEMORY

Before MySQL 8.0, internal temporary tables used the **MEMORY** storage engine. MEMORY
has a critical flaw: it uses fixed-length rows. A `VARCHAR(255)` column always allocates
255 bytes (times the character set max bytes) regardless of actual content.

```
MEMORY engine row for VARCHAR(255) utf8mb4:

  Allocated: 255 × 4 = 1020 bytes per column
  Actual data: "hello" = 5 × 4 = 20 bytes
  Wasted: 1000 bytes (98% waste)

TempTable engine:

  Allocated: 20 bytes + small overhead
  Actual data: "hello" = 20 bytes
  Waste: near zero
```

The TempTable engine (MySQL 8.0) uses **variable-length rows**, dramatically reducing
memory usage for temporary tables with VARCHAR/VARBINARY columns.

### 10.2 TempTable Memory Management

TempTable uses a shared memory pool across all sessions, not a per-session allocation:

```
TempTable Memory Hierarchy:

  ┌─────────────────────────────────────────────┐
  │  Level 1: TempTable RAM Pool                │
  │  temptable_max_ram = 1 GB (shared)          │
  │                                             │
  │  Session 1: temp table A (50 MB)            │
  │  Session 2: temp table B (200 MB)           │
  │  Session 3: temp table C (100 MB)           │
  │  ...                                        │
  │  Total used: 350 MB / 1 GB                  │
  └─────────────────────┬───────────────────────┘
                        │ overflow
                        ▼
  ┌─────────────────────────────────────────────┐
  │  Level 2: TempTable mmap files              │
  │  temptable_max_mmap = 1 GB                  │
  │  temptable_use_mmap = ON (default)          │
  │                                             │
  │  Memory-mapped temp files in tmpdir          │
  │  Still variable-length rows                 │
  │  OS manages paging to/from disk             │
  └─────────────────────┬───────────────────────┘
                        │ overflow
                        ▼
  ┌─────────────────────────────────────────────┐
  │  Level 3: InnoDB on-disk temp tablespace    │
  │  ibtmp1 (session temp tablespace)           │
  │                                             │
  │  Full InnoDB pages, B+Tree structure        │
  │  Significantly slower than Level 1/2        │
  └─────────────────────────────────────────────┘
```

### 10.3 Configuration

```sql
-- Check current settings
SHOW VARIABLES LIKE 'temptable%';
-- temptable_max_ram   = 1073741824  (1 GB)
-- temptable_max_mmap  = 1073741824  (1 GB)
-- temptable_use_mmap  = ON

-- Check which engine is used for internal temp tables
SHOW VARIABLES LIKE 'internal_tmp_mem_storage_engine';
-- TempTable (default in 8.0)

-- Monitor temp table usage
SHOW GLOBAL STATUS LIKE 'Created_tmp%';
-- Created_tmp_tables:     12345   (total internal temp tables created)
-- Created_tmp_disk_tables: 456   (temp tables that spilled to disk)
-- Ratio: 456/12345 = 3.7% disk spill rate (aim for < 5%)
```

### 10.4 Temp Table Spill Chain

Understanding when each level kicks in is critical for performance tuning:

```
Query: SELECT department, AVG(salary) FROM employees GROUP BY department

  1. Executor creates internal temp table for GROUP BY aggregation
  2. Storage engine = TempTable (in RAM pool)

  IF sum of all sessions' TempTable RAM usage > temptable_max_ram:
     3a. IF temptable_use_mmap = ON AND mmap usage < temptable_max_mmap:
         → switch to mmap-backed TempTable
         → OS pages data in/out transparently
     3b. ELSE:
         → convert to InnoDB on-disk temp table (ibtmp1)
         → full B+Tree structure, much slower

  4. Query completes → temp table dropped → memory/mmap/disk freed
```

>>> **Interview insight**: "How does MySQL 8.0 handle temporary tables differently
>>> from 5.7?"
>>> MySQL 8.0 introduced the TempTable engine, which uses variable-length rows
>>> instead of fixed-length (MEMORY engine). This reduces memory waste for VARCHAR
>>> columns dramatically. The spill chain is: TempTable RAM (shared pool up to
>>> `temptable_max_ram`) -> mmap temp files (up to `temptable_max_mmap`) -> InnoDB
>>> on-disk temp tablespace. In 5.7, it was: MEMORY (fixed-length, per-session
>>> limit) -> MyISAM on-disk temp table.

---

## 11. Performance Schema Memory Instrumentation

### 11.1 Tracking Memory Usage

The Performance Schema instruments memory allocations across all MySQL components.
This is the authoritative way to understand where memory is going at runtime.

```sql
-- Total tracked memory
SELECT * FROM sys.memory_global_total;
-- +-------------------+
-- | total_allocated   |
-- +-------------------+
-- | 107.42 GiB        |
-- +-------------------+

-- Top memory consumers by component
SELECT
    event_name,
    current_alloc AS current_bytes,
    sys.format_bytes(current_alloc) AS current_formatted
FROM sys.memory_global_by_current_bytes
ORDER BY current_alloc DESC
LIMIT 10;

-- Result:
-- memory/innodb/buf_buf_pool                     100.00 GiB
-- memory/temptable/physical_ram                    512.00 MiB
-- memory/performance_schema/events_statements      256.00 MiB
-- memory/innodb/log_buffer_memory                   16.00 MiB
-- memory/sql/THD                                    12.50 MiB
-- memory/innodb/hash0hash                           10.00 MiB
-- ...
```

### 11.2 Per-Thread Memory Tracking

Find memory-hungry connections:

```sql
-- Memory usage per thread
SELECT
    thread_id,
    user,
    current_allocated AS bytes,
    sys.format_bytes(current_allocated) AS formatted
FROM sys.memory_by_thread_by_current_bytes
ORDER BY current_allocated DESC
LIMIT 10;

-- Drill into a specific thread
SELECT
    event_name,
    current_alloc,
    sys.format_bytes(current_alloc) AS formatted
FROM performance_schema.memory_summary_by_thread_by_event_name
WHERE thread_id = 42
  AND current_alloc > 0
ORDER BY current_alloc DESC;
```

### 11.3 Key Memory Instruments

| Instrument | What It Tracks |
|-----------|---------------|
| `memory/innodb/buf_buf_pool` | Buffer pool pages (the bulk of MySQL memory) |
| `memory/sql/THD` | THD objects (one per connection) |
| `memory/sql/THD::main_mem_root` | Per-session memory root (query plan trees, etc.) |
| `memory/temptable/physical_ram` | TempTable engine RAM pool |
| `memory/temptable/physical_disk` | TempTable engine mmap usage |
| `memory/innodb/log_buffer_memory` | Redo log buffer |
| `memory/performance_schema/*` | Performance Schema's own memory usage |
| `memory/sql/Filesort` | Memory used by filesort operations |
| `memory/sql/JOIN` | Memory used by join buffers |
| `memory/innodb/hash0hash` | Adaptive hash index memory |

### 11.4 Detecting Memory Leaks and Bloat

```sql
-- Compare current allocation vs high-water mark
SELECT
    event_name,
    sys.format_bytes(current_alloc) AS current,
    sys.format_bytes(high_alloc) AS high_water
FROM sys.memory_global_by_current_bytes
WHERE high_alloc > current_alloc * 2
ORDER BY high_alloc DESC
LIMIT 10;
-- If high_water >> current: memory was allocated and freed (normal for temp tables)
-- If high_water == current and growing: possible leak or unbounded growth

-- Monitor over time using performance_schema digest
-- Track sys.memory_global_total periodically
```

### 11.5 Performance Schema Overhead

Performance Schema consumes memory for its own instrumentation tables (statement
history, wait events, memory summaries, etc.). Typical overhead: 200-400 MB with default
settings. You can reduce it:

```sql
-- Reduce perf schema memory (at the cost of less history)
-- In my.cnf:
performance_schema_max_digest_length = 1024          -- default 1024
performance_schema_events_statements_history_size = 10  -- default 10
performance_schema_events_waits_history_size = 10       -- default 10
performance_schema_max_table_instances = 1000            -- default -1 (auto)
```

In production, keep Performance Schema enabled (it is ON by default in MySQL 8.0) ---
the overhead is minimal relative to the diagnostic value.

---

## 12. Putting It All Together --- I/O Flow for a Single Query

This diagram traces the full I/O path for a simple `SELECT * FROM orders WHERE id = 42`:

```
Client                    mysqld (Connection Thread)                   Disk
  │                              │                                      │
  ├─ COM_QUERY ─────────────────►│                                      │
  │  "SELECT * FROM orders       │                                      │
  │   WHERE id = 42"             │                                      │
  │                              │                                      │
  │                    ┌─────────┤                                      │
  │                    │ Parse   │                                      │
  │                    │ → AST   │                                      │
  │                    ├─────────┤                                      │
  │                    │Optimize │                                      │
  │                    │→ PK lookup (index dive, cost=1.0)              │
  │                    ├─────────┤                                      │
  │                    │Execute  │                                      │
  │                    │         │                                      │
  │                    │ ha_innobase::index_read()                      │
  │                    │         │                                      │
  │                    │ Search B+Tree root page                        │
  │                    │    Buffer pool lookup:                         │
  │                    │      page in pool? ─── YES ──► read from RAM  │
  │                    │           │                                    │
  │                    │          NO                                    │
  │                    │           │                                    │
  │                    │    Submit async read request                   │
  │                    │    to read I/O thread                         │
  │                    │           │                                    │
  │                    │           ├─ io_submit() ─────────────────────►│
  │                    │           │  (native AIO, O_DIRECT)           │
  │                    │           │                                    │
  │                    │           │◄─ io_getevents() ◄────────────────┤
  │                    │           │  (page 16 KB DMA to buffer pool)  │
  │                    │           │                                    │
  │                    │    Page loaded into buffer pool               │
  │                    │    (old sublist, midpoint insertion)           │
  │                    │         │                                      │
  │                    │ Traverse B+Tree:                               │
  │                    │   root → internal → leaf page                  │
  │                    │   (subsequent pages likely in pool             │
  │                    │    or read-ahead prefetched)                   │
  │                    │         │                                      │
  │                    │ MVCC visibility check:                         │
  │                    │   row.DB_TRX_ID vs current ReadView            │
  │                    │         │                                      │
  │                    │ Row visible → copy to result set               │
  │                    │         │                                      │
  │                    └─────────┤                                      │
  │                              │                                      │
  │◄─ Result packet ─────────────┤                                      │
  │  (via net_buffer, TCP)       │                                      │
```

### I/O Path Summary Table

| Stage | Component | Thread | Memory Region |
|-------|-----------|--------|---------------|
| Parse + Optimize | SQL layer | Connection thread | THD mem root |
| B+Tree traversal | InnoDB handler | Connection thread | Buffer pool pages |
| Page miss → disk read | I/O subsystem | Read I/O thread | Aligned I/O buffer → buffer pool |
| MVCC check | InnoDB MVCC | Connection thread | ReadView (session), undo log (buffer pool) |
| Result send | SQL layer | Connection thread | net_buffer (session) |
| Redo log (for writes) | Log subsystem | log_writer thread | Log buffer → log files |
| Dirty page flush | Page cleaner | Page cleaner thread | Buffer pool → data files |
| Undo purge | Purge subsystem | Purge threads | Undo tablespace pages |

---

## 13. Diagnostic Queries

### 13.1 Thread Status

```sql
-- All threads and what they are doing
SELECT
    t.THREAD_ID,
    t.NAME,
    t.TYPE,                          -- FOREGROUND (connection) or BACKGROUND
    t.PROCESSLIST_STATE,
    t.PROCESSLIST_INFO               -- current SQL statement
FROM performance_schema.threads t
ORDER BY t.TYPE, t.NAME;

-- Background threads specifically
SELECT NAME, THREAD_ID
FROM performance_schema.threads
WHERE TYPE = 'BACKGROUND'
ORDER BY NAME;
-- thread/innodb/buf_dump_thread
-- thread/innodb/io_ibuf_thread
-- thread/innodb/io_read_thread    (× innodb_read_io_threads)
-- thread/innodb/io_write_thread   (× innodb_write_io_threads)
-- thread/innodb/log_checkpointer_thread
-- thread/innodb/log_flush_notifier_thread
-- thread/innodb/log_flusher_thread
-- thread/innodb/log_write_notifier_thread
-- thread/innodb/log_writer_thread
-- thread/innodb/page_cleaner_thread
-- thread/innodb/srv_lock_timeout_thread
-- thread/innodb/srv_master_thread
-- thread/innodb/srv_purge_thread  (× innodb_purge_threads)
-- thread/sql/event_scheduler
-- thread/sql/signal_handler
```

### 13.2 I/O Status

```sql
-- InnoDB I/O stats
SHOW ENGINE INNODB STATUS\G
-- Look for "FILE I/O" section:
--   Pending normal aio reads: 0, aio writes: 0
--   ibuf aio reads: 0, log i/o's: 0, sync i/o's: 0
--   Pending flushes (fsync) log: 0; buffer pool: 0
--   OS file reads, OS file writes, OS fsyncs

-- I/O thread status
SELECT
    NAME,
    THREAD_ID,
    PROCESSLIST_STATE
FROM performance_schema.threads
WHERE NAME LIKE 'thread/innodb/io_%';
```

### 13.3 Connection and Thread Monitoring

```sql
-- Thread cache utilization
SHOW GLOBAL STATUS LIKE 'Threads_%';

-- Connection rate
SHOW GLOBAL STATUS LIKE 'Connections';      -- total connections since startup
SHOW GLOBAL STATUS LIKE 'Max_used_connections';  -- peak concurrent

-- Aborted connections (auth failures, protocol errors, timeout)
SHOW GLOBAL STATUS LIKE 'Aborted_%';
-- Aborted_clients:   disconnected without COM_QUIT (client crash, timeout)
-- Aborted_connects:  failed authentication attempts
```

### 13.4 Memory Monitoring

```sql
-- Quick memory overview
SELECT * FROM sys.memory_global_total;

-- Per-component breakdown
SELECT * FROM sys.memory_global_by_current_bytes LIMIT 15;

-- Per-thread breakdown (find memory-hungry sessions)
SELECT * FROM sys.memory_by_thread_by_current_bytes LIMIT 10;

-- Temp table statistics
SHOW GLOBAL STATUS LIKE 'Created_tmp%';
SELECT * FROM sys.schema_tables_with_full_table_scans LIMIT 10;
```

---

## 14. Configuration Reference

### 14.1 Thread and Connection Parameters

| Parameter | Default | Scope | Recommendation |
|-----------|---------|-------|---------------|
| `max_connections` | 151 | Global | Set to actual need + 20% headroom. Use connection pooling. |
| `thread_cache_size` | auto (8 + max_connections/100) | Global | Auto-sizing is usually correct |
| `thread_stack` | 1 MB (64-bit) | Global | Rarely needs changing |
| `thread_handling` | `one-thread-per-connection` | Global | `pool-of-threads` for Percona/MariaDB thread pool |
| `thread_pool_size` | CPU count | Global | Number of thread groups (Percona/MariaDB) |
| `thread_pool_stall_limit` | 60 ms | Global | Lower = more responsive but more thread creation |
| `thread_pool_oversubscribe` | 3 | Global | Max concurrent workers per group above 1 |

### 14.2 I/O Parameters

| Parameter | Default | Scope | Recommendation |
|-----------|---------|-------|---------------|
| `innodb_flush_method` | `fsync` | Global | `O_DIRECT` for Linux production |
| `innodb_use_native_aio` | ON | Global | Keep ON (Linux). Disable only if io_setup() fails |
| `innodb_read_io_threads` | 4 | Global | 8-16 for read-heavy or SSD |
| `innodb_write_io_threads` | 4 | Global | 8-16 for write-heavy or SSD |
| `innodb_io_capacity` | 200 | Global | 200 for HDD, 2000-5000 for SSD |
| `innodb_io_capacity_max` | 2000 | Global | 2× io_capacity for HDD, 10000+ for SSD |
| `innodb_read_ahead_threshold` | 56 | Global | Lower (32) for scan-heavy workloads |

### 14.3 Memory Parameters

| Parameter | Default | Scope | Recommendation |
|-----------|---------|-------|---------------|
| `innodb_buffer_pool_size` | 128 MB | Global | 70-80% of RAM on dedicated server |
| `innodb_buffer_pool_instances` | 8 (or 1 if < 1 GB) | Global | 1 instance per GB of buffer pool |
| `innodb_log_buffer_size` | 16 MB | Global | 64 MB for bulk load workloads |
| `sort_buffer_size` | 256 KB | Session | Keep default; increase per-session if needed |
| `join_buffer_size` | 256 KB | Session | Keep default; increase per-session if needed |
| `read_buffer_size` | 128 KB | Session | Keep default |
| `read_rnd_buffer_size` | 256 KB | Session | Keep default |
| `tmp_table_size` | 16 MB | Session | Keep default; increase per-session for complex GROUP BY |
| `max_heap_table_size` | 16 MB | Session | Must match tmp_table_size |
| `temptable_max_ram` | 1 GB | Global | Shared pool; monitor actual usage |
| `temptable_max_mmap` | 1 GB | Global | Monitor disk spill rate |
| `key_buffer_size` | 8 MB | Global | 1-8 MB (InnoDB-only workloads) |
| `table_open_cache` | 4000 | Global | >= number of tables |

---

## 15. Common Interview Questions

### Q1: "MySQL uses threads. How does that affect crash safety?"

A thread crash (SIGSEGV, stack overflow, heap corruption) terminates the entire mysqld
process. There is no OS-level isolation between connections. This is why InnoDB's crash
recovery (redo log replay) exists: it assumes the entire process can die at any instant
and reconstructs consistent state on restart. The architecture trades isolation for
performance (cheaper context switches, free memory sharing).

### Q2: "How would you handle 10,000 concurrent database connections?"

You would not use 10,000 MySQL threads. Instead:
1. **Connection pooling** (HikariCP in Java, ProxySQL as middleware): maintain 50-200
   actual MySQL connections, multiplex 10,000 application connections over them
2. **Thread pool** (Percona/MariaDB): if you cannot pool at the app layer, the server-side
   thread pool keeps OS threads = CPU cores, not connections
3. **max_connections**: set to the pool size (200-500), not 10,000

### Q3: "What is the difference between innodb_io_capacity and innodb_io_capacity_max?"

`innodb_io_capacity` is the normal-state I/O budget for background operations (page
flushing, change buffer merging). `innodb_io_capacity_max` is the emergency budget when
the redo log or dirty page ratio is dangerously high. Setting io_capacity too low on
an SSD means InnoDB under-utilizes the disk and dirty pages accumulate; setting it too
high on an HDD means background flushing saturates the disk and starves foreground
queries.

### Q4: "Explain the TempTable spill chain."

Level 1: TempTable engine in shared RAM pool (`temptable_max_ram`, default 1 GB).
Variable-length rows, fast.
Level 2: TempTable mmap to temp files (`temptable_max_mmap`, default 1 GB). OS handles
paging. Still variable-length rows.
Level 3: InnoDB on-disk temp tablespace (`ibtmp1`). Full B+Tree structure, significantly
slower. This is the last resort.

### Q5: "You see 'Created_tmp_disk_tables' growing rapidly. What do you investigate?"

1. Check `SHOW GLOBAL STATUS LIKE 'Created_tmp%'` --- what percentage goes to disk?
2. Check queries with `EXPLAIN`: look for `Using temporary; Using filesort`
3. Common causes: temp tables with TEXT/BLOB columns (cannot use TempTable in RAM),
   or `temptable_max_ram` exhausted by concurrent sessions
4. Fix: optimize queries to avoid temp tables, add indexes for GROUP BY columns,
   increase `temptable_max_ram` if RAM allows, or split complex queries

>>> **Interview insight**: "What is the single most impactful tuning parameter in MySQL?"
>>> `innodb_buffer_pool_size`. Period. It controls how much of your data lives in
>>> RAM. A buffer pool that is too small causes constant disk reads. Set it to
>>> 70-80% of RAM on a dedicated server. Second most impactful:
>>> `innodb_flush_method = O_DIRECT` to eliminate double buffering. Everything
>>> else is secondary tuning.

---

## Summary

```
MySQL Thread and I/O Architecture --- Key Numbers

  Process model:        Single process, multi-threaded (pthreads)
  Connection model:     Thread-per-connection (or thread pool)
  Thread overhead:      ~1 MB idle (stack + THD), ~2-10 MB active
  Background threads:   20-50+ (page cleaners, purge, I/O, log, master)
  I/O model:            Native AIO (io_submit/io_getevents) on Linux
  Flush method:         O_DIRECT recommended (bypass OS page cache)
  Buffer pool:          70-80% of RAM (single largest memory consumer)
  TempTable pool:       1 GB shared (variable-length rows, 8.0+)
  Per-session buffers:  256 KB sort + 256 KB join + 128 KB read + 16 KB net
  Memory formula:       buffer_pool + global_buffers + (connections × session_buffers)
```

The thread architecture and I/O subsystem are where MySQL's design philosophy becomes
most visible: trade process isolation for thread efficiency, manage your own buffer pool
rather than trusting the OS, and use dedicated background threads for I/O so that
connection threads spend their time on query execution, not waiting for disk.
