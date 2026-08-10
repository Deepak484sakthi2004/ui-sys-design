# Chapter 2: The Event Loop & Single-Threaded Architecture

> This is the most important chapter in the book. Every other behavior of Redis —
> latency, throughput, atomicity, why `KEYS *` is dangerous, why I/O threads exist,
> why a slow Lua script melts your service — flows from how this loop is built and
> what it does on each iteration. We will read it the way an engine developer reads
> it: line by line, syscall by syscall.

---

## 2.1 The 50,000-Foot View

Redis is a **Reactor**: one thread, one event loop, multiplexed non-blocking I/O.
The entire server fits in this conceptual diagram:

```
                    +-------------------------------------+
                    |          MAIN THREAD                |
                    |                                     |
                    |   +---------------------------+     |
                    |   |     aeMain() loop         |     |
                    |   |  while (!eventLoop->stop) |     |
                    |   |     aeProcessEvents()     |     |
                    |   +---------------------------+     |
                    |                |                    |
                    |                v                    |
                    |   +---------------------------+     |
                    |   | aeApiPoll(epoll_wait)     |     |
                    |   |  - returns ready fds      |     |
                    |   +---------------------------+     |
                    |                |                    |
                    |                v                    |
                    |   +---------------------------+     |
                    |   | for each ready fd:        |     |
                    |   |   read RESP -> parse      |     |
                    |   |   processCommand()        |     |
                    |   |   addReply()              |     |
                    |   +---------------------------+     |
                    |                |                    |
                    |                v                    |
                    |   +---------------------------+     |
                    |   | run timers (cron, expiry, |     |
                    |   |  client output flushes)   |     |
                    |   +---------------------------+     |
                    +-------------------------------------+

  Background threads (BIO):              Forked child (RDB / AOF rewrite):
  +----------------------+              +----------------------+
  |  - close fd          |              |  - serialize memory  |
  |  - fsync AOF         |              |  - write to disk     |
  |  - lazy free         |              |  - exit              |
  +----------------------+              +----------------------+
```

There is exactly **one thread** that touches the keyspace. Background threads
exist only for things the main thread does not want to wait for: closing TCP
sockets, calling `fsync`, freeing big objects. The forked child for persistence
operates on a *snapshot* of memory and never modifies it.

---

## 2.2 The Anatomy of `aeEventLoop`

The event loop is implemented in `ae.c`. The core data structure is `aeEventLoop`:

```c
// ae.h (abbreviated)
typedef struct aeEventLoop {
    int maxfd;                         // highest fd currently registered
    int setsize;                       // capacity of the events arrays
    long long timeEventNextId;         // monotonically increasing timer id
    aeFileEvent *events;               // registered fd events,  indexed by fd
    aeFiredEvent *fired;               // fds that fired this iteration
    aeTimeEvent *timeEventHead;        // linked list of pending timers
    int stop;                          // set to 1 to break aeMain
    void *apidata;                     // backend-specific (epoll fd, kqueue fd)
    aeBeforeSleepProc *beforesleep;    // called before each epoll_wait
    aeBeforeSleepProc *aftersleep;     // called after each epoll_wait
    int flags;
} aeEventLoop;
```

Two arrays do most of the work:

- `events[fd]` is a **dense** array indexed by file descriptor. Each entry stores
  what kinds of events (READ/WRITE) we want to be notified about on that fd, plus
  the C function pointer to call when one fires. Indexing by raw fd works because
  the OS allocates fds densely from 0 upward (so the array doesn't get sparse).
- `fired` is filled by `aeApiPoll` each iteration with the fds that became
  ready. The main loop walks this list and dispatches handlers.

`apidata` points to the backend-specific state. The same `ae.c` code runs on
top of:

| Backend | File | Used on |
|---------|------|---------|
| `epoll` | `ae_epoll.c` | Linux (default in production) |
| `kqueue` | `ae_kqueue.c` | macOS, FreeBSD |
| `evport` | `ae_evport.c` | Solaris |
| `select` | `ae_select.c` | Fallback only (capped at FD_SETSIZE = 1024) |

`ae.c` knows nothing about which backend it's using. It calls `aeApiPoll(loop, tvp)`
which is dispatched at compile time.

>>> **Interview insight**: This abstraction layer (`ae.c` over `ae_epoll.c`) is
>>> a textbook example of why C programmers reach for `#include`-based polymorphism.
>>> It's not OO, but it gives you the same substitutability with zero runtime cost.
>>> A C++ programmer would write this with a virtual interface; a Java programmer
>>> with an interface; a Go programmer with a `runtime/netpoll` build-tag stack.

### 2.2.1 The Main Loop, Annotated

`ae.c:aeMain()` is fewer than 20 lines:

```c
void aeMain(aeEventLoop *eventLoop) {
    eventLoop->stop = 0;
    while (!eventLoop->stop) {
        aeProcessEvents(eventLoop, AE_ALL_EVENTS |
                                   AE_CALL_BEFORE_SLEEP |
                                   AE_CALL_AFTER_SLEEP);
    }
}
```

Every Redis tick is one call to `aeProcessEvents`. That function does, in order:

1. **Find the next timer deadline.** If there is a timer due in 5 ms, we cap
   the upcoming `epoll_wait` at 5 ms so we wake in time to fire it.
2. **Call `beforeSleep` callback.** The main thread uses this to flush pending
   client outputs, run AOF buffer flushes, handle cluster cron, and trigger
   I/O threads.
3. **Block in `aeApiPoll(epoll_wait)`** until either:
   - One or more fds become ready
   - The timeout expires
   - A signal interrupts (rare)
4. **Call `afterSleep` callback.** Used to bookkeep clock drift and process
   latency events.
5. **Walk the `fired` array** — each ready fd has an associated handler. Call
   it. For client sockets this means `readQueryFromClient` (read) or
   `writeToClient` (write).
6. **Walk the timer list** — anything due gets fired.

Then we loop. That's the entire engine.

### 2.2.2 Timer Events

Timers are a doubly-linked list (`timeEventHead`) sorted by no particular order
— the loop scans the whole list each iteration, which is fine because there
are very few timers in practice (typically just `serverCron`, expiry helpers,
and replication helpers).

The main timer is `server.c:serverCron()`, registered to run every 1/`server.hz`
seconds (default `hz=10` → every 100 ms). It does:

- Expire keys actively (sample, drop expired ones, repeat)
- Resize hash tables when load factor changes
- Trigger background save / AOF rewrite if conditions met
- Flush client output buffers
- Update server statistics
- Kick the cluster bus
- Defrag (if active defrag enabled)

`serverCron` itself is a *huge* function and we will revisit it in chapters
on memory, replication, and cluster. For now: one call every 100 ms by default,
all on the main thread, all bounded in time.

---

## 2.3 The Path of a Single GET Command

Let's trace a `GET foo` from socket bytes to reply bytes. This is the canonical
walk-through every interviewer wants to hear.

### Step 0: Client connects

The listening socket is a registered fd. When TCP `accept()` would return a new
fd, `epoll_wait` reports the listening socket as readable. The handler is
`networking.c:acceptTcpHandler()`, which:

1. Calls `accept4()` to get a new client fd.
2. Sets the new fd non-blocking and `TCP_NODELAY`.
3. Allocates a `client` struct (we call this object `c`).
4. Registers the new fd in the event loop with `aeCreateFileEvent(loop, fd,
   AE_READABLE, readQueryFromClient, c)`.

Memory cost: ~16 KB per idle client (the read buffer + struct). At 100K
connections that's 1.6 GB before any commands fly.

### Step 1: Client writes `*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n` to the socket

The kernel buffers it. Eventually `epoll_wait` reports the client fd as readable.
The main loop calls `readQueryFromClient(loop, fd, c, AE_READABLE)`.

```c
// networking.c (paraphrased)
void readQueryFromClient(aeEventLoop *el, int fd, void *privdata, int mask) {
    client *c = (client*) privdata;
    int nread = read(fd, c->querybuf + sdslen(c->querybuf), readlen);
    if (nread <= 0) {
        // EOF or error -> freeClient
    }
    sdsIncrLen(c->querybuf, nread);
    processInputBuffer(c);
}
```

The bytes are accumulated in `c->querybuf` (an SDS string). Then
`processInputBuffer` parses them.

### Step 2: RESP parsing

The parser is hand-rolled in `networking.c:processMultibulkBuffer()` (and an
`inline` parser for the legacy text protocol). It walks the bytes:

- `*2\r\n` → expect 2 array elements
- `$3\r\n` → next bulk string is 3 bytes
- `GET` + `\r\n`
- `$3\r\n` → another bulk string of 3 bytes
- `foo` + `\r\n`

After parsing, `c->argv = {SDS"GET", SDS"foo"}` and `c->argc = 2`. The parser
then calls `processCommand(c)`.

>>> **Interview insight**: The RESP parser is iterative and stateful — if a
>>> partial command arrives in `read()`, it stores progress in `c->multibulklen`
>>> and `c->bulklen` and *returns immediately*. The next `read()` resumes parsing
>>> where it left off. This is why pipelining works for free: multiple commands
>>> in one `read()` simply call `processCommand` multiple times in a loop.

### Step 3: Command lookup and dispatch

`server.c:processCommand()` is the heart of the dispatch path:

```c
int processCommand(client *c) {
    // 1. Look up the command function
    c->cmd = lookupCommand(c->argv, c->argc);
    if (!c->cmd) { addReplyErrorFormat(c, "unknown command"); return C_OK; }

    // 2. Check arity
    if ((c->cmd->arity > 0 && c->cmd->arity != c->argc) ||
        (c->argc < -c->cmd->arity)) {
        addReplyErrorArity(c); return C_OK;
    }

    // 3. Auth, ACL check
    if (server.requirepass && c->authenticated == 0
            && c->cmd->proc != authCommand) {
        addReplyError(c, "NOAUTH Authentication required."); return C_OK;
    }
    int acl_retval = ACLCheckAllPerm(c, ...);
    if (acl_retval != ACL_OK) { addReplyACLLogDeniedPermission(...); return C_OK; }

    // 4. Cluster slot check (if clustered)
    if (server.cluster_enabled && !mustObeyClient(c)) {
        clusterNode *n = getNodeByQuery(c, c->cmd, c->argv, c->argc, &hashslot, &error_code);
        if (n != server.cluster->myself) {
            // -MOVED or -ASK redirection
            clusterRedirectClient(c, n, hashslot, error_code);
            return C_OK;
        }
    }

    // 5. Memory check, OOM eviction
    if (server.maxmemory && !server.lua_timedout) {
        int out_of_memory = (performEvictions() == EVICT_FAIL);
        if (out_of_memory && (c->cmd->flags & CMD_DENYOOM)) {
            addReplyError(c, "OOM command not allowed when used memory > 'maxmemory'.");
            return C_OK;
        }
    }

    // 6. Execute
    call(c, CMD_CALL_FULL);
    return C_OK;
}
```

`lookupCommand` does an O(1) hashtable lookup in the global command dictionary
(`server.commands`), which is built from a static `redisCommandTable[]` array
at startup. Each `redisCommand` entry has the function pointer, arity, flags
(read-only? write? denyoom? admin?), keyspec (which arguments are keys), and ACL
category bits.

Then `call(c, ...)` actually invokes `c->cmd->proc(c)` — the C function pointer
for that command. For `GET` that's `t_string.c:getCommand()`:

```c
void getCommand(client *c) {
    getGenericCommand(c);
}

int getGenericCommand(client *c) {
    robj *o = lookupKeyReadOrReply(c, c->argv[1], shared.null[c->resp]);
    if (o == NULL) return C_OK;
    if (checkType(c, o, OBJ_STRING)) return C_ERR;
    addReplyBulk(c, o);
    return C_OK;
}
```

`lookupKeyReadOrReply`:

1. Calls `db->dict` lookup with the key. (Chapter 5 details the dict.)
2. If found and not expired, returns the `robj*`.
3. If found and expired, evicts it lazily and returns NULL.
4. If not found, calls `addReply(c, shared.null)` to write the null reply.
5. Updates expiry stats and key access stats (for LFU/LRU tracking).

If we get an `robj`, `addReplyBulk(c, o)` writes the RESP-formatted value to
`c->buf` (the static reply buffer) or, if too big, appends an SDS to
`c->reply` (a linked list of large reply chunks).

### Step 4: Reply queued, not sent

Critically, `addReplyBulk` does NOT call `write()` on the socket. It just queues
bytes. Why?

Because we are inside the main thread, processing a command. Calling `write()`
synchronously could block (if the socket buffer is full). Even if it doesn't
block, calling `write()` for every reply means a syscall per command.

Instead, the reply is buffered. At some later point, two things can flush it:

1. **`beforeSleep`** in the next iteration of the event loop calls
   `handleClientsWithPendingWrites()` → tries to `write()` immediately to all
   clients with queued data. If a single `write()` drains everything, no
   epoll registration needed. If only partial, the client's fd gets registered
   for `AE_WRITABLE`, and on the next iteration when the socket is writable,
   `sendReplyToClient` finishes the job.
2. **I/O threads** (covered in §2.6) can batch-flush replies in parallel.

This deferred-write design is why a syscall-light Redis can do a million ops/s.

### Step 5: Bytes leave the box

`write()` returns. The kernel sends the TCP segment. The client receives
`$5\r\nworld\r\n`. Total elapsed time: ~30-50 µs on localhost.

That is the end-to-end story of one `GET`. Every other command follows the
same skeleton — only the function pointer in step 3 differs.

---

## 2.4 The Single-Thread Bargain: What You Trade Away

The simplicity of the model has a sharp edge: **any command that takes a long
time blocks every other client**. There is no preemption, no time-slicing, no
"yield to another client at command boundaries within a long operation."

Examples of commands you must respect:

| Command | Cost | Why bad |
|---------|------|---------|
| `KEYS pattern` | O(N) where N = total keys | Walks every key in the db |
| `SMEMBERS huge_set` | O(N) where N = set size | Returns all members |
| `LRANGE k 0 -1` | O(N) where N = list length | Returns whole list |
| `HGETALL huge_hash` | O(N) where N = hash size | Returns all fields |
| `SUNIONSTORE dst many_sets` | O(N) over union of sets | Merges full sets |
| `DEL huge_key` | O(N) for compound types | Frees every element |
| `FLUSHDB` (sync) | O(N) over keyspace | Synchronous wipe |
| `DEBUG SLEEP 5` | 5 seconds wall clock | Literal `sleep` |
| `EVAL` of a long Lua | Whatever the script does | No timeout in Lua context |

If you run any of these against a production-sized dataset, the entire server
freezes. Other clients see their commands queue up, and from their point of
view Redis "went down" for the duration.

>>> **Interview insight**: The fix for each of these has the same shape — replace
>>> the bulk operation with an iterative one:
>>> - `KEYS *` → `SCAN cursor MATCH ... COUNT 1000` (iterative, cursor-based)
>>> - `SMEMBERS` → `SSCAN`
>>> - `HGETALL` → `HSCAN`
>>> - `DEL big_key` → `UNLINK big_key` (asynchronous via BIO thread)
>>> - `FLUSHDB` → `FLUSHDB ASYNC`
>>> - Long-running Lua → break into multiple commands with cursor state outside

`SCAN` and friends use a clever stateless cursor that walks the hashtable in a
"reverse-bit" iteration order. Crucially, it returns control to the loop after
~`COUNT` items — never blocking for longer than processing `COUNT` keys takes.
We will dissect SCAN in Chapter 5 because the reverse-bit trick makes the
iteration safe across hashtable rehashes.

### 2.4.1 The Slow Log

Redis tracks every command that exceeds `slowlog-log-slower-than` microseconds
(default 10000 = 10 ms). It's exposed via `SLOWLOG GET`:

```
1) 1) (integer) 1234
   2) (integer) 1700000000
   3) (integer) 53000               -- 53 ms
   4) 1) "KEYS"
      2) "user:*"
   5) "10.0.0.1:55432"
   6) "client-conn-name"
```

This is the single most useful diagnostic in production. If your p99 is bad,
`SLOWLOG GET 100` will almost always show the culprit. We will go deep on it in
Chapter 18.

---

## 2.5 The "Do Less in the Loop" Optimisations

Over the years, Redis has carefully offloaded work that does not need to be
on the critical path:

### 2.5.1 BIO (Background I/O) threads

`bio.c` runs three dedicated background threads, each consuming a separate work
queue:

| Thread | Job | Why offload |
|--------|-----|-------------|
| `BIO_CLOSE_FILE` | `close()` an fd | `close()` can block for seconds if the filesystem is busy |
| `BIO_AOF_FSYNC` | `fsync()` the AOF | `fsync()` is the single slowest syscall on Linux |
| `BIO_LAZY_FREE` | `free()` a big object | Freeing a 10 GB hash byte-by-byte is slow |

When the main thread wants to close a file, it pushes the fd onto the BIO close
queue and moves on. When it wants to free a big object via `UNLINK`, it pushes
the object pointer onto the lazy-free queue.

>>> **Interview insight**: This is the source of the `lazyfree-lazy-*` config
>>> options. `lazyfree-lazy-eviction yes` means "when evicting a key, hand the
>>> object to the BIO thread instead of freeing it inline." The default in modern
>>> Redis is to enable lazy free for eviction, expiry, server delete, and user
>>> delete. It's almost always a win.

### 2.5.2 I/O threads

Added in Redis 6.0. **Important: they do NOT execute commands. They only
parallelise socket reads and writes.**

Architecture:

```
   Main thread                   I/O threads (default: 3, configurable)
   -----------                   --------------------
   accept clients
   processCommand()
   addReply() to per-client buf
   |
   v
   beforeSleep:
     pending writes? --(if io-threads-do-writes yes)--> distribute clients
                                                        across IO threads ->
                                                        each thread write()s
                                                        its assigned clients
                                                        in parallel
     pending reads? -----(if io-threads N>1)----------> distribute clients ->
                                                        each thread read()s and
                                                        parses RESP for its
                                                        assigned clients in
                                                        parallel
   processInputBuffer for each client (single-thread, command exec)
```

The win: at high connection counts the `read()` and `write()` syscalls
themselves are CPU-bound (SSL especially). Spreading them across 4-8 threads
lets the main thread spend more time on actual command logic.

The catch: command execution remains single-threaded. So I/O threads only
help when network/SSL is the bottleneck, not when the bottleneck is data
structure manipulation.

Configuration:
```
io-threads 4
io-threads-do-reads yes        # default: no in older versions, yes in newer
```

>>> **Interview insight**: A common confusion: "Redis 6 is multi-threaded now,
>>> right?" Half-right. Networking is multi-threaded. **Command execution is
>>> still single-threaded.** Atomicity guarantees and ordering semantics are
>>> unchanged.

### 2.5.3 Forked persistence

`fork()` is how Redis takes a consistent snapshot without freezing. The child
inherits a copy of the parent's address space (via copy-on-write). The child
walks the keyspace, serialises to RDB on disk, and exits. The parent keeps
serving traffic.

We will dedicate Chapter 9 to this because the COW interaction with high write
throughput is one of the trickiest production issues in Redis.

### 2.5.4 Lazy freeing of large objects

When you `UNLINK big_key`, Redis:
1. Removes the key from the dict (O(1))
2. Pushes the object pointer onto the BIO lazy-free queue
3. The BIO thread frees memory cell by cell

If you used `DEL big_key` instead, the freeing happens *inline on the main
thread* — and if the value was a 100 MB hash, the main thread blocks for
hundreds of milliseconds. **Always prefer `UNLINK` over `DEL` for compound
types.**

---

## 2.6 The `beforeSleep` Hook: The Hidden Engine

Every iteration of `aeMain` calls `beforeSleep()` between handling events
and blocking on `epoll_wait`. This is where Redis hides a *lot* of work that
must not be on the critical path of any single command.

Reading `server.c:beforeSleep()` is enlightening:

```c
void beforeSleep(struct aeEventLoop *eventLoop) {
    /* Run a fast expire cycle (microseconds) */
    activeExpireCycle(ACTIVE_EXPIRE_CYCLE_FAST);

    /* Send replies to clients that finished commands this iteration */
    handleClientsWithPendingWritesUsingThreads();

    /* Replicate any commands accumulated in this loop iteration */
    replicationFeedSlaves(...);

    /* Apply the AOF write buffer */
    flushAppendOnlyFile(0);

    /* Try connecting to cluster nodes that we lost the link with */
    if (server.cluster_enabled) clusterCron();

    /* Free the objects on the lazy free queue with quota */
    if (use_lazyfree) lazyfreeFreeObjects(...);

    /* ... and many more */
}
```

That's the *quiet* work the loop does between events. If you ever wonder
"how does Redis manage to do X without me asking" — the answer is almost always
"in `beforeSleep` or in `serverCron`."

---

## 2.7 Concurrency Inside Redis: A Complete Inventory

To make the threading model crystal clear, here is the full list of threads
in a running Redis instance:

| Thread | Created in | What it does |
|--------|-----------|--------------|
| Main | Process startup | Event loop, command execution — the only thread that touches the keyspace |
| BIO close | Server init | `close()` fds |
| BIO aof fsync | Server init | `fsync()` AOF |
| BIO lazy free | Server init | Free big objects |
| I/O thread 1..N | Server init (if `io-threads > 1`) | Parallel `read()`/`write()`/RESP parse on assigned clients |
| Module threads | Module-defined | Variable. Modules can spawn threads but must use module-API locking to touch keyspace |

That's it. Every operation against your data goes through the main thread.
This is the source of Redis's atomicity guarantees.

---

## 2.8 Atomicity, Isolation, and the "Synchronized" Promise

Because every command runs on one thread one at a time, Redis automatically
provides:

- **Single-command atomicity**. `INCR`, `LPUSH`, `ZADD` — even ones that touch
  multiple internal structures — are atomic. There is no "half-applied" state.
- **Multi-command atomicity via `MULTI/EXEC`**. The block runs as one
  uninterrupted batch. (Chapter 15 details transactions.)
- **Lua/Function script atomicity**. The entire script runs uninterrupted.
  This is why bad scripts are dangerous — they hold the loop hostage.
- **Single-command isolation**. No client sees a partial state of any command.

What you do **not** get:

- Cross-command isolation across multiple commands without `MULTI/EXEC` or
  scripting. `GET counter; INCR counter` from one client can interleave with
  another client's `SET counter 0`. (Use `INCR` directly to make it atomic.)
- Cross-shard atomicity in a cluster. A `MULTI/EXEC` that touches keys on
  different cluster nodes is rejected.

>>> **Interview insight**: When an interviewer asks "how do you implement an
>>> atomic counter increment?" the answer is `INCR key`. When they push back
>>> with "what if I need to read-modify-write?" the answer is `EVAL "redis.call(...)"`
>>> for in-server logic, or use `WATCH` (optimistic concurrency) for client-side
>>> logic. Chapter 15 has both worked examples.

---

## 2.9 Failure Mode Reference

Here is a table you should print and pin on your wall:

| Symptom | Probable cause in the loop | Fix |
|---------|----------------------------|-----|
| All clients hang for ~seconds, CPU at 100% | Slow command in flight (`KEYS *`, big `LRANGE`, big `DEL`) | `SLOWLOG GET`, replace with `SCAN`/`UNLINK` |
| All clients hang briefly during `BGSAVE` | Fork pause — large RSS or transparent huge pages | Disable THP, monitor `latest_fork_usec` |
| Periodic 50-200 ms p99 spikes | AOF fsync on `everysec` collides with disk slowness | Tune `no-appendfsync-on-rewrite`, faster disk |
| Replica disconnects under high write load | Replica output buffer overflowed | Increase `client-output-buffer-limit slave` |
| Memory grows after `BGSAVE` finishes | COW dirtied many pages, RSS stays high until eviction | Reduce write rate during snapshot, or use diskless |
| Latency monitor reports `aof-write-pending-fsync` | BIO fsync queue backed up | Faster disk, smaller AOF, switch `everysec`→`no` (risky) |

---

## 2.10 Reading Material in the Source

If you want to **see** what we just described, in this order:

1. `ae.h`, `ae.c` — the loop core
2. `ae_epoll.c` — Linux backend
3. `networking.c` — `acceptTcpHandler`, `readQueryFromClient`,
   `processInputBuffer`, `addReply`, `writeToClient`
4. `server.c` — `processCommand`, `call`, `beforeSleep`, `serverCron`
5. `bio.c` — background I/O threads
6. `t_string.c:getCommand` — the simplest end-to-end command path

That is roughly 5,000 lines of well-commented C. Reading it once will do more
for your understanding of Redis than any blog post or course.

---

## Practice Questions

1. A client sends `MGET k1 k2 ... k1000`. Walk through what happens in the
   event loop from byte arrival to reply. Where does the parsing happen? Where
   does the I/O happen?
2. You enable `io-threads 8`. Throughput on a CPU-bound workload doesn't
   improve. Why? Under what workload would `io-threads 8` actually help?
3. `BGSAVE` completes. Five minutes later the resident memory of the parent
   process is still 50% higher than before. Explain.
4. You run `DEL huge_zset` on a 5 GB sorted set. Latency for an unrelated
   `GET` from another client jumps from 50 µs to 800 ms. Explain. What command
   would you have used instead?
5. Why is `epoll` strictly better than `select` for Redis, and why is the
   `select` backend retained at all?
6. In `processCommand`, the order of checks (auth → ACL → cluster → memory →
   execute) matters. What goes wrong if you swap "memory" and "cluster"?

(Answers at end of Chapter 22.)
