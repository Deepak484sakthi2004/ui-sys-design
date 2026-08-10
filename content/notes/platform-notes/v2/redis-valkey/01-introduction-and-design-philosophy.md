# Chapter 1: Introduction & Design Philosophy — Why the World's Fastest Database Is Single-Threaded

> Every other database on your résumé spends years building elaborate concurrency
> machinery: MVCC versions, lock managers, read-copy-update, work-stealing schedulers.
> Redis throws all of it in the bin and runs commands one at a time on a single
> CPU core. And then it does a million operations per second. This chapter explains
> the bet that made that possible — and the situations where the bet starts to
> creak.

---

## 1.1 What Redis Actually Is

Strip away the marketing and Redis is three things welded together:

```
   +-----------------------------------------------------------+
   |                          REDIS                            |
   |                                                           |
   |   +-----------------+  +----------------+  +-----------+  |
   |   |   AN IN-MEMORY  |  |  A NETWORKED   |  |   A SET   |  |
   |   |   DATA STRUCTURE|  |  COMMAND       |  |   OF      |  |
   |   |   SERVER        |  |  PROTOCOL      |  |   DATA    |  |
   |   |   (the engine)  |  |  (RESP)        |  |   TYPES   |  |
   |   +-----------------+  +----------------+  +-----------+  |
   +-----------------------------------------------------------+
```

Most users think of it as "a cache." That's like saying Postgres is "a thing that
stores rows." Technically true, fatally incomplete.

Redis is an **in-process data structure server**: the same hash tables, sorted sets,
linked lists, and bit arrays you would write in your own program — but exposed over
a network protocol, with persistence, replication, and clustering bolted on. The
data lives in RAM. Commands operate directly on those data structures. There is no
SQL parser, no query optimizer, no buffer pool, no row format. Latency floor is
**network round trip plus one hash lookup plus one data-structure operation**.

A typical `GET` on localhost: ~30-50 microseconds. Across a datacenter with TLS:
~250-500 microseconds. Across regions: bound by speed of light.

### 1.1.1 The Origin Story

Salvatore Sanfilippo wrote Redis in 2009 to solve one specific problem: his Italian
website analytics platform was bottlenecked by MySQL writes. He needed an in-memory
hash that survived restarts. The first commit was a few thousand lines of C. Twelve
years later it's the most-used in-memory database on Earth and has spawned three
major forks (Valkey, KeyDB, Dragonfly) plus a vendor-controlled fork war that began
in 2024.

The design choices that made all this possible were *not* "we'll be cleverer than
everyone else." They were the opposite: **deliberately do less, in simpler ways, on
fewer cores**.

---

## 1.2 The Six Design Decisions That Define Redis

Every weird or surprising thing about Redis follows from these six choices. Internalise
them and you can predict its behavior without reading the docs.

### Decision 1: Single-threaded command execution

Commands execute one at a time on a single thread. There is no multi-CPU
parallelism inside Redis core for command processing.

```
   client A: GET foo  --+
   client B: SET bar 1 --+--> [ single thread ] --> reply A, reply B, reply C
   client C: INCR n   --+      executes one
                              command at a time
```

**What you get for free**:
- No locks. Ever. Anywhere in core data structures.
- No deadlocks. No priority inversion. No torn reads.
- Atomic multi-key reads and writes (within one command) — automatically.
- Trivial reasoning about ordering. The order of commands in the input stream is
  the order they execute. Period.
- Cache-friendly: one thread, one CPU, one set of L1/L2/L3 caches. No false sharing.

**What you give up**:
- Cannot use more than ~1 CPU core for command execution. A 64-core server runs
  Redis at the same throughput as a 4-core server (for command execution).
- Any single slow command (`KEYS *`, `LRANGE 0 -1` on a million-element list,
  bad Lua script) blocks **every other client**. There is no preemption.
- You scale horizontally (sharding, cluster) instead of vertically.

>>> **Interview insight**: "Why is Redis single-threaded if it's on a 32-core server?"
>>> Because the bottleneck is rarely CPU. For an in-memory hash lookup, the dominant
>>> cost is **memory bandwidth and network I/O**, not arithmetic. Adding threads
>>> means adding mutexes, which adds cache-line contention, which makes everything
>>> slower. Redis offloads what *can* be parallelised (network reads/writes via I/O
>>> threads, persistence via fork, deletion via lazy free) but command logic stays
>>> single-threaded by design.

### Decision 2: Everything in RAM

The working set lives in RAM. There is no concept of a "page in / page out"
buffer pool. There is no bytecode interpreting B-Trees on disk. Disk exists only
for two purposes:

1. **Persistence** (RDB snapshots, AOF logs) — write-side, asynchronous.
2. **Replication initial sync** — staging area when network can't keep up.

If your data doesn't fit in RAM, you have one of two problems:
1. You bought the wrong server. Buy more RAM. Modern boxes do 768 GB without
   exotic hardware.
2. You're using Redis for the wrong workload. Move cold data to a disk-based store.

**What you get for free**:
- O(1) access for any key, with no disk I/O in the hot path.
- Predictable latency. There is no "cold cache" worst case.
- Simple data structures. No need to be friendly to disk's sequential-access bias.

**What you give up**:
- Cost per byte is ~10-100x more than disk-resident databases.
- "Reboot" means "reload from RDB/AOF" which can take minutes for large datasets.
- OOM is fatal. Once you blow `maxmemory`, eviction kicks in (or writes start
  failing) — there is no graceful "spill to disk" mechanism.

### Decision 3: Asynchronous, non-blocking I/O via an event loop

Redis uses a Reactor pattern. One thread runs an event loop. The event loop waits
on `epoll` (Linux), `kqueue` (BSD/macOS), or `select` (fallback). When a socket
becomes readable, the loop reads bytes, parses RESP, executes the command, and
queues the reply. When a socket becomes writable, the loop drains queued replies.

```
   while (server_running) {
       compute_next_timer_deadline();
       events = epoll_wait(timeout);
       for (e in events) {
           if (e.readable) handle_client_input(e.fd);
           if (e.writable) flush_client_output(e.fd);
       }
       run_due_timers();    // expire keys, rehash, cron tasks
   }
```

Chapter 2 dissects this loop line by line. For now, internalise: **everything
Redis does is driven by this loop turning over**. If the loop is stuck on a slow
command, nothing else happens — including replication, expiry, persistence-flush.

### Decision 4: A small, hand-picked set of data structures

Redis exposes ~10 data types: string, list, hash, set, sorted set, stream,
bitmap, hyperloglog, geo, bitfield. Each maps to one of about ~7 internal encodings:
SDS, listpack, quicklist, hashtable, skiplist+hash, intset, radix tree.

Compare to Postgres which exposes ~40 built-in types and supports user-defined ones,
or to a Java collections library with dozens of `Map`/`List`/`Set` variants.

This restraint is a feature. Every one of Redis's structures has been profiled,
optimized, and battle-tested at billion-op scale. Each has well-understood
asymptotic and constant-factor performance. There are no surprises.

>>> **Interview insight**: When you choose `ZADD` over `SADD`, you are making a
>>> precise statement: "I want O(log n) ordered access." When you choose `HSET`
>>> over a string-encoded JSON blob, you are saying "I want O(1) field access
>>> without parsing." The data type is the API contract for both correctness *and*
>>> complexity.

### Decision 5: Persistence is optional and separate from the hot path

Both RDB and AOF persistence happen out-of-band:
- **RDB**: a child process produced by `fork()` snapshots memory to disk.
- **AOF**: command writes are buffered in memory and flushed to disk asynchronously
  (with three configurable durability levels).

The hot path — the event loop — touches disk only when it absolutely has to.
The vast majority of writes never wait on `fsync`.

**Consequence**: Redis's write throughput is decoupled from disk throughput
*on average*, but is constrained by disk throughput *at the point where AOF
rewrite or RDB save runs*. We will see in Chapters 9 and 10 how this asymmetry
shapes operational practice (and failure modes like the "stuck fork" incident).

### Decision 6: Replication is asynchronous by default

A primary acknowledges a write to the client *before* the replica has received
or applied it. Replication is fire-and-forget over a TCP stream from primary to
replica.

**Consequence**: Redis is **not** a strongly-consistent store. If the primary
crashes between acking a write and the replica receiving it, the write is lost.
You can soften this with `WAIT` (synchronous replication) or `min-replicas-to-write`
(refuse writes when not enough replicas are connected), but neither is a true
linearizable consensus protocol like Raft.

This is the single biggest gotcha for engineers coming from Postgres or Kafka.
Chapter 11 (replication) and Chapter 17 (distributed locks) hammer this home.

---

## 1.3 The Mental Model: Redis as One Giant Synchronized Method

If you know Java, the simplest accurate mental model of Redis is:

```java
class Redis {
    private final Map<String, Object> data = new HashMap<>();

    public synchronized Object handle(String[] command) {
        return dispatch(command);   // GET, SET, INCR, ...
    }
}
```

That's it. One thread, one shared map, one synchronized dispatch.

Everything else — RESP, RDB, AOF, replication, sentinel, cluster, streams,
modules — is **plumbing around that core idea**. Once you see Redis this way,
the design becomes inevitable rather than surprising.

The miracle is how fast that one synchronized method can be when you:
- Use the right data structure for each value (encoded, packed, cache-friendly)
- Avoid all syscalls except `epoll_wait`, `read`, `write`
- Use `jemalloc` to skip kernel `brk`/`mmap`
- Pre-allocate, pool, never `free` in the hot path
- Process the protocol with hand-tuned C string scanning

---

## 1.4 Where Redis Fits (and Where It Doesn't)

### Excellent fit
- **Cache** in front of slower stores (RDBMS, search index, ML inference).
- **Session store** for web apps.
- **Real-time leaderboards, counters, rate limiters, feature flags.**
- **Pub/Sub for fan-out** to small numbers of subscribers (chat, presence).
- **Job queues** (BLPOP, Redis Streams with consumer groups).
- **Distributed locks** for cooperative coordination *with relaxed correctness*.
- **Geospatial proximity** queries for "drivers near a rider."

### Workable but watch out
- **Time-series**: works with RedisTimeSeries module, but Prometheus/InfluxDB
  are usually better.
- **Full-text search**: works with RediSearch module, but Elasticsearch/Meilisearch
  cover more of the surface area.
- **JSON document store**: RedisJSON works, but Postgres `jsonb` is often preferable
  if you don't need sub-millisecond reads.
- **Streams as Kafka replacement**: works for low-medium throughput with simple
  consumer-group needs; lacks Kafka's log compaction, exactly-once, partitioning,
  and ecosystem.

### Wrong tool
- **Primary system of record for important data**. Asynchronous replication +
  RAM-resident means you *will* lose data eventually. Use Postgres or DynamoDB.
- **Strong consistency / linearizability across keys**. Use ZooKeeper, etcd, or
  a Raft-based KV like FoundationDB.
- **Large analytical queries**. Single-threaded execution means a `SUNIONSTORE`
  over millions of elements freezes the server.
- **Sub-millisecond multi-region writes with strong consistency**. This problem
  cannot be solved by any database; you have to make a CAP/PACELC trade-off
  explicitly.

---

## 1.5 Redis vs Valkey vs the Forks: A One-Page Summary

In March 2024, Redis Ltd changed Redis's license from BSD-3-Clause to a dual SSPLv1
/ RSALv2 license. The Linux Foundation immediately created **Valkey** as a hard
fork from Redis 7.2.4 under the original BSD license. AWS, Google, Oracle, and
Ericsson are core sponsors. KeyDB (multi-threaded, owned by Snap) and Dragonfly
(rewrite in C++ with shared-nothing threading) are independent projects with
different goals.

| Project | License | Threading | Compatibility | Notable |
|---------|---------|-----------|---------------|---------|
| Redis 7.4 | SSPLv1 / RSALv2 (source-available) | Single + I/O threads | Reference | Owned by Redis Ltd |
| Valkey 8.0 | BSD-3-Clause | Single + I/O threads | 100% Redis 7.2 + new commands | Linux Foundation, AWS, Google, Oracle |
| KeyDB | BSD-3-Clause | Multi-threaded command processing | ~95% Redis 6 | Owned by Snap, less active |
| Dragonfly | BSL 1.1 → Apache after 4 years | Shared-nothing per-CPU | ~Redis 6 wire protocol | Different engine (C++, RCU, B+Tree+hashtable) |

For this book, **Redis and Valkey are interchangeable on the engine and wire
protocol**. Valkey-specific changes (new commands, better cluster coordination,
removed legacy code) are called out in Chapter 20.

---

## 1.6 What "Fast" Actually Means

Redis claims a million ops/sec on a single core. This number is real but heavily
qualified. Here are realistic numbers from a single-core Redis 7.4 on a modern
Intel Xeon (3.5 GHz, DDR4-3200), no TLS, localhost, no persistence:

| Workload | Throughput | p50 | p99 | p99.9 |
|----------|------------|-----|-----|-------|
| `GET` of 100-byte value, hot key | 1.0 M ops/s | 35 µs | 90 µs | 250 µs |
| `SET` of 100-byte value | 950 K ops/s | 40 µs | 100 µs | 300 µs |
| `INCR` | 1.1 M ops/s | 30 µs | 80 µs | 200 µs |
| `LPUSH` to short list | 800 K ops/s | 45 µs | 110 µs | 350 µs |
| `ZADD` to 1 K-element zset | 600 K ops/s | 60 µs | 150 µs | 500 µs |
| `ZADD` to 100 K-element zset | 250 K ops/s | 130 µs | 350 µs | 1.2 ms |
| Pipelined `GET` (100 commands/pipeline) | 5.0 M ops/s | 8 µs amortised | n/a | n/a |
| `LRANGE 0 -1` on 1 K-element list | 50 K ops/s | 600 µs | 2.5 ms | 8 ms |
| `LRANGE 0 -1` on 1 M-element list | 10 ops/s | 50 ms | 250 ms | (server hangs) |

Three things to internalise from this table:

1. **Pipelining is a 5x throughput multiplier for free** — not because Redis
   gets faster, but because you eliminate network round trips. This is in
   Chapter 3.
2. **Throughput collapses with operation size**, not with key count. A million
   tiny keys is fine. One key with a million elements is a footgun.
3. **p99.9 reveals what p99 hides.** A 250 µs p99.9 means "99.9% of requests
   finish in under 250 µs". The remaining 0.1% — driven by AOF fsync, RDB save,
   client buffer flushes, slow Lua scripts — is where production pages come from.

---

## 1.7 Where We Go From Here

The rest of Part 1 follows a deliberate path: we start at the network socket
and work inward.

```
   Wire bytes → Event loop → RESP parser → Command dispatch
                                                  |
                                                  v
                                          Object encoding
                                                  |
                                                  v
                                         Internal data structures
                                                  |
                                                  v
                                         Memory + jemalloc
                                                  |
                                                  v
                                Persistence | Replication | Cluster
```

By Chapter 16 you will be able to read `server.c` and follow the path of any
command from socket to data structure and back. By Chapter 22 you will be able
to walk a Staff-level interviewer through it from memory.

Open `valkey/src` in one window, this book in another, and let's start the loop.

---

## Practice Questions

1. Why does Redis run a `GET` faster than Postgres can run `SELECT col FROM t WHERE
   pk = 1` even when the Postgres row is in the buffer cache?
2. A coworker says "let's use 16 Redis instances per server, each pinned to its own
   core." What do they get right? What goes wrong if they're not careful with
   sharding clients?
3. You issue `LRANGE big_list 0 -1` against a list of 5 million strings. The Redis
   process is at 100% CPU. A separate `GET cache_key` from another client takes
   3 seconds to return. Why?
4. The benchmark shows 1 M ops/s for `GET` but only 5 M ops/s for pipelined `GET`
   (100 commands/pipeline). If pipelining "just" eliminates network RTT, why
   isn't the speedup 100x?
5. What's the precise reason `KEYS *` against a 100 M-key database is dangerous,
   and what's the surgical replacement?

(Answers at end of Chapter 22.)
