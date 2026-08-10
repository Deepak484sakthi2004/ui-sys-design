# Chapter 20: Valkey — What Changed & Why

> In March 2024, Redis Inc. relicensed Redis from BSD-3-Clause to a
> dual SSPLv1 / RSALv2 source-available license, ending a decade and a
> half of permissive open-source distribution. Within five days, the
> Linux Foundation forked the code and launched **Valkey** under the
> original BSD license, with AWS, Google, Oracle, Ericsson, and (later)
> Snap as core sponsors. This chapter walks through what happened,
> what's actually different in the code, and what the future looks
> like.

---

## 20.1 The License Change Timeline

| Date | Event |
|------|-------|
| 2009-03 | Salvatore Sanfilippo writes the first Redis commits |
| 2015-06 | Redis Labs (later Redis Inc.) takes commercial stewardship |
| 2018-08 | Redis "modules" (RedisJSON, RediSearch) re-licensed to RSAL/Apache 2 (ambiguous) |
| 2019-04 | Modules clarified to Common Clause; criticised |
| 2020-06 | Sanfilippo steps down as project lead |
| 2024-03-20 | Redis Inc. announces dual SSPLv1 / RSALv2 license, dropping BSD |
| 2024-03-28 | Linux Foundation announces Valkey, fork from Redis 7.2.4 |
| 2024-04 | Valkey 7.2.5 release: name change, code identical |
| 2024-09 | Valkey 8.0 release: first version with substantive divergence |
| 2025+ | Continued divergence with shared technical heritage |

---

## 20.2 The Licenses, Plain English

### 20.2.1 BSD-3-Clause (original Redis, current Valkey)

You can use it for anything (commercial, embedded, modified, sold)
as long as you keep the copyright notice and don't use the original
authors' names to endorse your derivative.

**The "permissive" license.** Valkey, FreeBSD, ClickHouse, Postgres,
all use this kind of license.

### 20.2.2 SSPLv1 (Server-Side Public License)

A "copyleft" license written by MongoDB. The key clause:

> If you make the functionality of the Program available to third
> parties as a service, you must release the **Service Source Code**
> under the SSPL.

"Service Source Code" includes management code, monitoring, billing,
provisioning — basically your whole hosting infrastructure.

This is **incompatible** with most commercial cloud services. The
intent is to prevent AWS/GCP/Azure from offering managed Redis
without contributing back (or paying Redis Inc.).

The OSI does **not** classify SSPL as open source.

### 20.2.3 RSALv2 (Redis Source Available License)

A custom Redis Inc. license. Lets you use Redis for any purpose
**except** offering a managed Redis-as-a-Service. Stricter than SSPL
in narrow ways; more permissive in others.

### 20.2.4 What This Means for You

If you're an end user (running Redis for your own application),
nothing practical changes. Both licenses let you run Redis.

If you're a hosting provider (managed services, distros), you must
either:
- Negotiate a commercial license with Redis Inc.
- Switch to Valkey or another permissively-licensed fork.
- Stop offering the service.

The major cloud providers all chose the second option.

---

## 20.3 The Governance Shift

| | Redis (post-2024) | Valkey |
|-|-------------------|--------|
| Ownership | Redis Inc. | Linux Foundation (open governance) |
| Maintainers | Redis Inc. employees | Mix: AWS, Google, Oracle, Ericsson, Snap, individuals |
| Roadmap decisions | Internal to Redis Inc. | Public TSC (Technical Steering Committee) |
| RFC process | Internal | Public on GitHub |
| Trademark | Redis Inc. | Linux Foundation |
| Repository | github.com/redis/redis | github.com/valkey-io/valkey |

For a project that critical infrastructure depends on, Valkey's
governance model is qualitatively different. AWS can't unilaterally
break Valkey because they don't own it. Same for everyone else on
the TSC.

---

## 20.4 What Changed in the Code

For most of 2024, Valkey was **byte-identical** to Redis 7.2 except for:

- Project name in CONTRIBUTING, README, LICENSE
- "redis-server" → "valkey-server" (binary), with a `redis-server` symlink
- Internal struct names containing "Redis" → kept (compatibility)
- Connection greeting still says `Redis 7.2.x` for client compat
- Dropped commercial-only modules (RediSearch, RedisJSON were never in
  Redis core anyway)

The on-the-wire protocol, RDB format, command set, and client libraries
are 100% compatible. Any Redis client works against Valkey unchanged.

### 20.4.1 Valkey 8.0 (released late 2024)

The first Valkey release with substantive technical changes:

- **Async I/O threads**: `io-threads` mode now also offloads command
  parsing, not just network I/O. Up to 2x throughput on multi-CPU boxes
  for read-heavy workloads.
- **Multi-threaded primary** for `O(N)` commands: `SUNIONSTORE`,
  `SINTERSTORE`, `ZUNIONSTORE` can use multiple threads internally
  (similar to KeyDB's approach but limited).
- **Cluster v2 protocol**: improvements to gossip messages reducing
  bandwidth ~30%.
- **Improved replication** with better backpressure on replicas.
- **`CLUSTER SHARDS` / `CLUSTER SLOTS-MAP`** for clearer topology
  introspection.
- **New commands**: `WAITAOF`, `OBJECT FREQ`/`IDLETIME` improvements,
  `CLIENT TRACKING` redirect mode, etc.

### 20.4.2 Valkey 8.1 / 8.2 (2025)

- **Optimised RESP3 paths**: typed reply construction faster.
- **Persistent-memory-friendly** changes: NUMA-aware memory pinning.
- **TLS performance**: less syscall overhead per connection.
- **Per-shard ACL caching**: faster auth for high-throughput multi-tenant
  setups.
- **Object encoding additions**: a new compact encoding for small streams.

### 20.4.3 What's NOT in Valkey

- **Vector search**: Valkey doesn't ship a built-in vector index.
  You'd use a community module or a separate engine (RediSearch's
  fork, Qdrant, pgvector). Redis Inc.'s RediSearch isn't usable in
  Valkey without re-licensing.
- **Time series**: same situation.
- **JSON**: a community-maintained module exists, but the canonical
  RedisJSON stays under Redis Inc.

This is the **commercial pivot**: Redis Inc. positions itself as the
"complete platform" with all modules, while Valkey is the "core engine"
that other tools build on.

---

## 20.5 What Redis 8 Added (post-fork)

Redis Inc. has continued shipping. Redis 8.0 (mid-2024) added:

- **Vector sets**: a new data type, similar to HNSW but specialised
  for KV-style access.
- **Native RedisJSON, RediSearch, RedisBloom, RedisTimeSeries**: bundled
  in core. (This is the "complete platform" story above.)
- **Performance**: continued tuning, particularly on cluster.
- **Continued alignment with Valkey** on most APIs (they share a lot
  of contributor pool informally).

For an end user: pick the license that aligns with your use case. The
APIs and behaviors are converging in spirit while diverging in
implementation.

---

## 20.6 Migration: Redis → Valkey

For most deployments, migration is trivial:

```bash
# 1. Stop the Redis server
systemctl stop redis

# 2. Install valkey
apt install valkey-server         # or build from source

# 3. Start valkey, point at the same dump.rdb / appendonly.aof
valkey-server /etc/valkey/valkey.conf

# 4. Reconfigure clients (just port if same machine; otherwise hostname)
```

Compatibility:
- RDB files: Valkey reads Redis 7.x RDB. Redis 8 reads Valkey 8 RDB
  (the formats are compatible).
- AOF files: same.
- Wire protocol: same RESP2/RESP3.
- Client libraries: same. No code changes.

The two main wrinkles:

1. **Replication primacy**: a Redis primary doesn't directly accept
   Valkey replicas (and vice versa) because the connection greeting
   and a few INFO fields differ. To "migrate," you do a coordinated
   restart, not a chain.
2. **Module compatibility**: modules compiled for Redis 7.2 work in
   both. Modules compiled against newer Redis APIs may not work in
   Valkey if they use APIs Valkey hasn't adopted.

---

## 20.7 The Other Forks

### 20.7.1 KeyDB

Started 2019 as a multi-threaded fork of Redis (under BSD; now under
Snap). Major divergence:
- Multi-threaded *command processing* (not just I/O).
- Active replication (multiple primaries can accept writes; CRDT-style).
- Mostly Redis 6 compatible.

KeyDB has been on slower release cadence since the Snap acquisition.
Its multi-threading is a fundamental architecture difference; not all
Redis modules work.

### 20.7.2 Dragonfly

A 2022 from-scratch rewrite in C++ using:
- Shared-nothing thread-per-CPU architecture (no shared state, no
  locks)
- B+Tree-based hashtable instead of chained hashing
- Compaction-on-the-fly instead of fork-based snapshots

Wire-protocol compatible with Redis 6. The throughput claims (millions
of ops/sec/core) are accurate but workload-dependent. The internal
design is fundamentally different — it's a *Redis-compatible* engine,
not a *Redis fork*.

If you want the Redis API at extreme throughput on big multi-core
boxes, Dragonfly is worth a hard look.

### 20.7.3 Microsoft Garnet

Microsoft Research's open-source Redis-compatible KV store. C#-based,
multi-threaded, with a different storage layer. As of 2025, mature
enough for some production use but ecosystem is small.

---

## 20.8 The Upshot

If you're starting a new Redis project today (2026):

- **Default to Valkey** for the open-source license + community
  governance.
- **Evaluate Redis 8** if you specifically want bundled RedisJSON /
  RediSearch / RedisTimeSeries / vector search and you're OK with the
  source-available license for non-cloud-hosting use cases.
- **Consider Dragonfly** if you have extreme multi-core throughput
  needs and don't depend on Redis modules.

If you have an existing Redis 6 or 7 deployment:

- Migrating to Valkey is essentially zero-cost.
- Migrating to Redis 8 requires reading the new license and confirming
  it fits your use case.
- Continuing on your current Redis version is fine — it's still
  supported by Redis Inc. and (for older versions) by community forks.

The ecosystem is split, but for most practitioners this is a license
question, not a technology question. The engines remain ~95% the same.

---

## 20.9 Source Repositories and Releases

| Project | Repository | Latest (early 2026) |
|---------|-----------|----------------------|
| Valkey | github.com/valkey-io/valkey | 8.2 |
| Redis | github.com/redis/redis | 8.x |
| KeyDB | github.com/Snapchat/KeyDB | 6.3 |
| Dragonfly | github.com/dragonflydb/dragonfly | 1.x |
| Garnet | github.com/microsoft/garnet | 1.x |

For this book, "Redis" refers to the upstream Redis 7.4 baseline;
"Valkey" refers to Valkey 8.x where it diverges. Most of the book
applies to both.

---

## 20.10 What This Means for Your Career

For interviews and senior engineering roles:

- Know the history. "Redis is now SSPL/RSAL; Valkey is its BSD fork
  by the LF" is a 5-second answer that signals you've followed the
  ecosystem.
- Know the technical implications: license affects your hosting and
  CI/CD strategy, not your day-to-day code.
- Recognise the broader pattern: this is the third major "open-source
  to source-available" pivot of the 2020s (after MongoDB → SSPL and
  Elastic → SSPL/Elastic License). Each spawned a major fork
  (DocumentDB and OpenSearch respectively). The pattern is now well
  understood.

The technical contributions of all forks (improved threading,
better cluster, vector search) eventually flow back into the
ecosystem. It's a churn-rich but ultimately healthy time for the KV
store world.

---

## Practice Questions

1. Why does the SSPL license effectively prevent AWS from offering
   managed Redis? Read the SSPL §13 verbatim and explain in your own
   words.
2. The Linux Foundation owns the Valkey trademark. Why does this
   matter compared to a single corporate sponsor?
3. Valkey 8 has multi-threaded command execution for *some* O(N)
   commands. Why isn't all command execution multi-threaded the way
   KeyDB and Dragonfly do it?
4. You manage a 100-node Redis 7.2 cluster. You decide to migrate to
   Valkey 8. Sketch the migration plan with zero downtime.
5. A team chooses Dragonfly because of its throughput claims. What's
   the engineering risk relative to Valkey?
6. Redis 8 has built-in vector search; Valkey doesn't. If your app
   needs vector search and you want the BSD license, what do you do?
7. The fork happened in March 2024. Who controls the Valkey roadmap
   today, and how do major decisions get made?

(Answers at end of Chapter 22.)
