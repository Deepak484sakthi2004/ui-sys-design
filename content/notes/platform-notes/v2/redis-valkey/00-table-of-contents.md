# Redis & Valkey: From Event Loop to Production — A Systems Engineering Deep Dive

> Written from the perspective of an engineer who has worked on the Redis/Valkey internals.
> Target audience: Senior engineers preparing for Staff/Principal-level interviews (40+ LPA).
> Companion volume to the MySQL deep dive (`../mysql/`) — same house style, same depth contract.

---

## Why This Book Exists

Most Redis material treats it as a black box: "It's a key-value store, it's fast, here are
some commands." That mental model collapses the moment you hit production:

- Why does `KEYS *` freeze a 500 ms p99 service?
- Why does an RDB snapshot triple my memory footprint?
- Why does `CLUSTER FAILOVER` sometimes lose 200 ms of writes?
- Why is Redlock controversial — and what should I use instead?
- Why does Valkey exist and is it just "Redis with a friendlier license"?

Every one of these questions has a precise answer, and the answer always lives in the
same place: **the source code, the data structures, and the single-threaded event loop**.
This book takes you there.

---

## Book Structure

### Part 1: The Engine Room — Redis/Valkey Internals

These chapters dissect Redis as if you built it. Each chapter maps source code paths
(`server.c`, `dict.c`, `t_string.c`, ...), explains the data structures chosen and why,
and shows how decisions in the I/O layer ripple all the way up to user-visible latency.

| Ch | Title | Core Question |
|----|-------|---------------|
| 01 | [Introduction & Design Philosophy](01-introduction-and-design-philosophy.md) | Why is the world's fastest database single-threaded? |
| 02 | [The Event Loop & Single-Threaded Architecture](02-event-loop-and-single-threaded-architecture.md) | How does one thread serve a million ops/sec? |
| 03 | [The RESP Protocol & Client Handling](03-resp-protocol-and-client-handling.md) | What actually flows over the wire between a client and Redis? |
| 04 | [Strings — SDS Internals](04-strings-sds-internals.md) | Why didn't they just use `char*`? |
| 05 | [The Dictionary — Incremental Rehashing](05-dictionary-incremental-rehashing.md) | How does Redis grow a hashtable without ever blocking? |
| 06 | [Skiplists, Listpacks & Quicklist](06-skiplists-listpacks-quicklist.md) | Why a skiplist instead of a B-Tree, and what replaced ziplist? |
| 07 | [Object Encoding & Polymorphism](07-object-encoding-and-polymorphism.md) | How does one `SET` command pick between five different in-memory layouts? |
| 08 | [Memory Management, Eviction & Expiry](08-memory-management-eviction-expiry.md) | How does `maxmemory-policy allkeys-lfu` actually decide what to kill? |
| 09 | [Persistence I — RDB and Fork-Based Snapshots](09-persistence-rdb-fork-snapshots.md) | Why does saving an 80 GB dataset use *more* than 80 GB of RAM? |
| 10 | [Persistence II — AOF, Rewrite & Hybrid](10-persistence-aof-rewrite-hybrid.md) | What's the real cost of `appendfsync always`? |
| 11 | [Replication — PSYNC2 & The Backlog](11-replication-psync2-and-backlog.md) | How does a replica reconnect after a 30-second network blip without a full resync? |
| 12 | [Sentinel — Automated Failover](12-sentinel-automated-failover.md) | What does it really mean to have "quorum" of three sentinels? |
| 13 | [Cluster — Sharding, Gossip & Resharding](13-cluster-sharding-gossip-resharding.md) | How do 16,384 hash slots get redistributed live without dropping a single key? |
| 14 | [Pub/Sub & Streams — Messaging in Redis](14-pubsub-and-streams.md) | When is `XADD` a Kafka replacement, and when isn't it? |
| 15 | [Transactions, Scripting & Functions](15-transactions-scripting-functions.md) | Why does Redis have `MULTI/EXEC` but no rollback? |
| 16 | [Modules — Extending the Engine](16-modules-extending-the-engine.md) | How do RedisJSON, RediSearch, and RedisBloom plug into the core? |

### Part 2: The Operator's Manual — Production Redis

These chapters are for the developer who *runs* Redis at scale. Every recommendation is
grounded in the internals from Part 1 — you'll know **why** a config change works, not
just **that** it does.

| Ch | Title | Core Question |
|----|-------|---------------|
| 17 | [Caching Patterns & Distributed Locks](17-caching-patterns-and-distributed-locks.md) | When should you reach for Redlock — and when should you reach for ZooKeeper instead? |
| 18 | [Performance, Latency & Operations](18-performance-latency-and-operations.md) | What dashboards do you watch and what do you change when p99 spikes? |
| 19 | [Security — ACLs, TLS & Hardening](19-security-acls-tls-hardening.md) | How do you stop the next "unauthenticated Redis on the internet" headline? |
| 20 | [Valkey Fork — What Changed & Why](20-valkey-fork-what-changed-and-why.md) | What's actually different in Valkey 7.2 / 8.0 versus Redis 7.4 / 8.0? |

### Part 3: Mastery & Interviews

| Ch | Title | Core Question |
|----|-------|---------------|
| 21 | [System Design with Redis/Valkey](21-system-design-with-redis-valkey.md) | How do you design a 10-million-DAU rate limiter, leaderboard, or feed? |
| 22 | [Interview Question Bank](22-interview-question-bank.md) | The 100 questions Staff-level interviewers actually ask. |

---

## How to Read This Book

**If you've used Redis as a black-box cache and want to understand what's underneath**:
read the chapters in order. The narrative is cumulative — Chapter 7 will assume you
remember why SDS exists from Chapter 4.

**If you're an experienced systems engineer (Postgres, Kafka, JVM)**: jump to
Chapter 02 (event loop), Chapter 09 (RDB/fork), Chapter 11 (PSYNC2), Chapter 13 (cluster
gossip), and Chapter 17 (Redlock). These are where Redis's design philosophy diverges
most from what you already know.

**If you're preparing for Staff/Principal interviews tomorrow**: Chapter 22 is the
question bank. Use the cross-references back into Part 1 when you need depth.

**If you operate Redis at scale and need to debug a fire**: Chapter 18 (latency &
slow log), Chapter 08 (memory), Chapter 11 (replication lag), and Chapter 13 (cluster
failover) are the four chapters you'll keep coming back to.

---

## Conventions

- `source_file.c:function_name()` — References to Redis 7.4 / Valkey 8.0 source
  (github.com/redis/redis, github.com/valkey-io/valkey). When the Valkey diverges
  meaningfully, both are noted.
- `[Redis 7+]` / `[Valkey 8+]` — Version-gated features.
- `[Cluster]` / `[Sentinel]` — Mode-specific behavior.
- `>>>` — Interview-critical insight. Memorize these.
- `(!)` — Production hazard. The kind of footgun that pages oncall.
- ASCII diagrams use fixed-width formatting — view in a monospace font.
- All command examples assume `redis-cli` connected to a live server unless noted.

---

## Source Code You Should Have Open

This book references Redis 7.4 and Valkey 8.0 source. To follow along:

```bash
git clone https://github.com/valkey-io/valkey.git
cd valkey/src
ls *.c | head -20
# ae.c               -- the event loop
# ae_epoll.c         -- Linux epoll backend
# server.c           -- main entry, server init, command dispatch
# networking.c       -- client I/O, RESP parsing
# sds.c              -- Simple Dynamic Strings
# dict.c             -- the hashtable with incremental rehashing
# t_string.c         -- string commands (GET, SET, INCR, ...)
# t_list.c           -- list commands (LPUSH, LRANGE, ...)
# t_hash.c           -- hash commands
# t_set.c            -- set commands
# t_zset.c           -- sorted set commands
# t_stream.c         -- streams
# rdb.c              -- RDB snapshots
# aof.c              -- append-only file
# replication.c      -- master/replica protocol
# cluster.c          -- cluster bus, slot management, gossip
# sentinel.c         -- sentinel binary
```

Every chapter cites these files by name and function. If you can keep one source tree
open as you read, you'll close the book understanding Redis the way its authors do.

---

## A Note on Redis vs Valkey

Throughout the book I use "Redis" to refer to the engine and protocol family that
both Redis (the project from Redis Ltd) and Valkey (the Linux Foundation fork created
in March 2024) share. Where their behavior diverges — license, modules, specific
commands, governance — the chapter calls it out explicitly. Chapter 20 covers the
fork in full.

The internals are 99% identical at time of writing. If you understand Redis 7.x,
you understand Valkey 7.x.

---

> "Latency is the only honest metric. Throughput lies. p50 lies. p99 mostly lies.
>  Watch p99.9 under sustained load and you'll learn what your system actually is."
>
> — paraphrased from Salvatore Sanfilippo's writings on Redis latency
