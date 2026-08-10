# Chapter 15: Building Blocks & Back-of-Envelope

> **Relearning log.** I know all these components from work, but the interview needs them as a
> *vocabulary I can deploy in seconds with the tradeoffs attached* — not as deep operational
> knowledge. My rust: I could run a Kafka cluster but fumbled the crisp one-liner for "why a queue
> here" under time pressure. So this chapter is each building block reduced to **what it's for, the
> one-line tradeoff, and when I reach for it** — plus the estimation numbers I must have memorized
> cold so the math in [Ch 14 step 2](14-system-design-framework.md) takes 90 seconds, not five
> minutes.

---

## 15.1 The numbers to memorize (latency & magnitudes)

**Latency ladder (order-of-magnitude; the relative gaps matter, not exact ns):**

| Operation | ~Latency | Mnemonic |
|-----------|----------|----------|
| L1 cache reference | ~1 ns | |
| Branch mispredict | ~3 ns | |
| L2 cache | ~4 ns | |
| Mutex lock/unlock | ~17 ns | |
| Main memory reference | ~100 ns | RAM is ~100× L1 |
| Compress 1 KB | ~2 µs | |
| Send 1 KB over 1 Gbps network | ~10 µs | |
| SSD random read | ~16–150 µs | |
| Read 1 MB sequentially from memory | ~10 µs | |
| Read 1 MB from SSD | ~200 µs–1 ms | |
| Round trip within a datacenter | ~0.5 ms | |
| Read 1 MB sequentially from disk (HDD) | ~5–20 ms | |
| Disk seek (HDD) | ~10 ms | |
| Round trip CA ↔ Netherlands | ~150 ms | speed of light is real |

> The takeaways I actually use: **memory is ~100 ns, an SSD read is ~100 µs (1000× slower), a
> same-DC RTT is ~0.5 ms, and a cross-continent RTT is ~150 ms.** These justify "cache it" (avoid
> the disk/network hop) and "put it near the user" (avoid the 150 ms).

**Magnitude math (powers, for storage/QPS):**

| Quantity | Value |
|----------|-------|
| Seconds in a day | ~86,400 ≈ **10⁵** |
| Seconds in a month | ~2.5 × 10⁶ |
| 1 KB / 1 MB / 1 GB / 1 TB | 10³ / 10⁶ / 10⁹ / 10¹² bytes |
| 1 char (ASCII) | 1 byte; a UUID | 16 bytes; a typical row | ~hundreds of bytes |

**Reusable estimation pattern:** `writes/sec = daily_events / 10⁵`; `storage/day = events/day ×
bytes/event`; `peak ≈ 2–3× average`. That's 90% of the math.

---

## 15.2 Load balancing

- **What:** spreads requests across servers; the entry point that lets you scale horizontally.
- **L4 vs L7:** L4 (transport, TCP/IP, fast, no payload awareness) vs L7 (application, routes by
  path/header/cookie, can do TLS termination & sticky sessions).
- **Algorithms:** round-robin, least-connections, consistent-hashing (for cache affinity), weighted.
- **Tradeoff one-liner:** "L7 LB gives smart routing and TLS termination at the cost of more CPU per
  request than L4."
- **Reach for it:** the moment you have >1 app server. Pair with **health checks** + **stateless
  servers** so any node can serve any request.

---

## 15.3 Caching

- **What:** keep hot data in fast storage (memory) to avoid recomputation / slow stores.
- **Where:** client → CDN (edge) → app-level (local/Caffeine) → distributed (Redis/Memcached) → DB
  buffer pool. Each layer trades freshness for speed.
- **Patterns:**
  - **Cache-aside (lazy):** app checks cache, on miss reads DB and populates. Most common.
  - **Write-through:** write cache + DB together (consistent, slower writes).
  - **Write-behind:** write cache, async flush to DB (fast, risk of loss).
- **Eviction:** LRU (default mental model), LFU, TTL.
- **The hard parts (say these):** **invalidation** ("there are only two hard problems…"),
  **stampede / thundering herd** on a hot key expiry (mitigate with locks, request coalescing,
  staggered TTL, or refresh-ahead), and **stale reads**.
- **Tradeoff one-liner:** "Cache-aside is simple and resilient but allows a stale window and a
  cold-start miss storm; write-through is consistent but slows writes."
- **Reach for it:** read-heavy access, expensive computation, hot keys. (Read:write ≫ 1.)

---

## 15.4 Databases — choosing the store

| Need | Store type | Examples | Why |
|------|-----------|----------|-----|
| Transactions, joins, strong consistency, flexible queries | **Relational (SQL)** | PostgreSQL, MySQL | ACID, mature, query planner |
| Massive write throughput, simple access by key, tunable consistency | **Wide-column** | Cassandra, ScyllaDB | linear write scaling, no single master |
| Flexible/nested documents, per-document atomicity | **Document** | MongoDB, DynamoDB | schema flexibility, easy sharding |
| Sub-ms reads, counters, ephemeral, pub/sub | **In-memory KV** | Redis, Memcached | RAM speed, rich structures |
| Full-text search, ranking, aggregation | **Search** | Elasticsearch, OpenSearch | inverted index |
| Time-series / metrics | **TSDB** | Prometheus, InfluxDB | time-bucketed, downsampling |
| Relationships, traversals | **Graph** | Neo4j | native edges |
| Append-only event log, replay, decoupling | **Log/stream** | Kafka, Pulsar | durable ordered log |

> The decision is driven by the **access pattern**, not popularity. "I query by primary key at huge
> write volume with eventual consistency tolerable → wide-column (Cassandra). I need
> multi-row transactions → relational." Say *why* in terms of the access pattern.

**SQL vs NoSQL one-liner:** "SQL for relationships, transactions, and ad-hoc queries; NoSQL for
horizontal write scale and flexible schema, trading joins and (often) strong consistency."

---

## 15.5 Replication & consistency (CAP / PACELC)

- **Replication:** copies of data for durability, read-scaling, and failover.
  - **Leader–follower (primary–replica):** writes to leader, reads from followers (read-scaling);
    replicas lag → eventual consistency on reads; failover promotes a follower.
  - **Multi-leader / leaderless (Dynamo-style quorums, `R + W > N`):** higher availability, conflict
    resolution needed (last-write-wins, vector clocks, CRDTs).
- **CAP:** under a network **P**artition, choose **C**onsistency or **A**vailability — can't have
  both. (No partition → you can have both; CAP only bites during partitions.)
- **PACELC:** the fuller statement — under Partition, choose A or C; **E**lse (normal operation),
  choose **L**atency or **C**onsistency. Captures the everyday latency-vs-consistency tradeoff CAP
  ignores.
- **Consistency models to name:** strong (linearizable), eventual, **read-your-writes**, monotonic
  reads, causal.
- **Tradeoff one-liner:** "Synchronous replication gives strong consistency but adds write latency
  and stalls on a slow replica; async replication is fast but can lose recent writes on failover."

> The interview move: **state your consistency choice and its cost explicitly.** "A social feed
> tolerates eventual consistency, so I'll use async replication and read from followers for scale; a
> payment ledger needs strong consistency, so writes go to the leader synchronously."

---

## 15.6 Sharding (partitioning)

- **What:** split data across nodes when it no longer fits / one node can't handle the write load.
- **Shard key choice is everything:** must spread load evenly and match the query pattern.
  - **Hash sharding:** even distribution, but range queries scatter.
  - **Range sharding:** range queries are local, but risks hot ranges (e.g., recent timestamps).
  - **Consistent hashing:** minimizes reshuffling when nodes are added/removed (virtual nodes smooth
    distribution) — the standard answer for "how do you resize?"
- **Hot-shard / celebrity problem:** one key gets disproportionate traffic → mitigate by
  splitting/replicating that key, or special-casing it (see news-feed celebrity fan-out in
  [Ch 16](16-system-design-worked-problems.md)).
- **Tradeoff one-liner:** "Sharding scales writes and storage linearly but loses cross-shard
  transactions and joins, and adds rebalancing complexity."

---

## 15.7 Message queues & async processing

- **What:** decouple producers from consumers; absorb spikes; enable async work and retries.
- **Queue (work distribution, e.g., SQS/RabbitMQ)** vs **log (ordered, replayable, multi-consumer,
  e.g., Kafka)**.
- **Delivery semantics:** at-most-once (may lose), **at-least-once** (may duplicate → needs
  **idempotent consumers**), exactly-once (hard; usually = at-least-once + dedup/idempotency).
- **Why reach for it:** smooth traffic spikes (**backpressure**), decouple services, fan-out
  (notifications, feed), long-running work (media transcoding), retries + **dead-letter queues**.
- **Tradeoff one-liner:** "A queue adds latency and operational surface but buys decoupling,
  spike absorption, and retry/resilience."

> "Make it async with a queue" is one of the highest-leverage moves in a design round. Whenever the
> work doesn't need to block the user's response (notifications, fan-out, indexing, transcoding),
> push it to a queue and process with workers. Always pair at-least-once delivery with **idempotency**.

---

## 15.8 CDN & edge

- **What:** cache static (and increasingly dynamic) content at edge PoPs near users.
- **Why:** kills the ~150 ms cross-continent RTT for static assets; offloads origin.
- **Reach for it:** images/video/JS/CSS, and any geographically distributed read-heavy content.

---

## 15.9 Reliability patterns (the failure-handling vocabulary)

| Pattern | What it does | One-liner |
|---------|--------------|-----------|
| **Retry + exponential backoff + jitter** | reissue failed calls without stampeding | "jitter prevents synchronized retry storms" |
| **Circuit breaker** | stop calling a failing dependency, fail fast | "trips open after N failures, prevents cascading failure" |
| **Bulkhead** | isolate resource pools | "one slow dependency can't drown all threads" |
| **Rate limiting** | cap request rate (token bucket / leaky bucket / sliding window) | "protect the service and ensure fairness" |
| **Idempotency keys** | make retried writes safe | "at-least-once delivery + idempotency = effective exactly-once" |
| **Timeouts** | bound waiting | "no unbounded waits; every remote call has a deadline" |
| **Health checks + auto-scaling** | replace bad nodes, scale to load | "stateless + health checks = self-healing" |

---

## 15.10 Putting numbers to a decision (worked snippet)

"Design a system handling 1 M DAU posting 5 items/day, each ~1 KB, read 50×/day":
- Writes: 5 M/day ÷ 10⁵ ≈ **50 writes/sec** (peak ~150/s) — trivial, single primary handles it.
- Reads: 250 M/day ÷ 10⁵ ≈ **2,500 reads/sec** (peak ~7,500/s) — **read:write = 50:1 → cache.**
- Storage: 5 M × 1 KB = **5 GB/day ≈ 1.8 TB/yr** — fits comfortably; shard only when multi-TB.
- Conclusion the math forces: "single primary + read replicas + Redis cache; revisit sharding past a
  few TB or if writes 10×."

> This is the whole point of estimation: **the numbers pick the architecture and tell you what you
> *don't* need yet.** Not sharding a 50-writes/sec system is as much a signal as sharding a
> 500k-writes/sec one.

## Interview Drills

- **D15.1 [E]** Memory vs SSD vs same-DC RTT vs cross-continent RTT — recite the order-of-magnitude
  for each and one design implication.
- **D15.2 [E]** When do you reach for a message queue? Give three concrete triggers.
- **D15.3 [M]** Explain CAP, then PACELC, then say which a news feed and a payments ledger each pick
  and why.
- **D15.4 [M]** You have a hot shard (a celebrity user). Name two mitigations.
- **D15.5 [M]** Estimate writes/sec, reads/sec, and yearly storage for 10 M DAU, 3 posts/day @ 2 KB,
  read 30×/day.
- **D15.6 [H]** Cache stampede on a hot key TTL expiry — describe three mitigations. *(Lock/single-
  flight, staggered TTL, refresh-ahead.)*

## Key Takeaways

1. **Memorize the latency ladder and magnitude math** so estimation takes 90 seconds and *justifies*
   architecture with numbers.
2. **Each building block = purpose + one-line tradeoff + when to reach for it.** Deploy them as
   vocabulary.
3. **Pick the database by access pattern, not popularity;** say SQL-for-relationships-and-
   transactions vs NoSQL-for-write-scale-and-flexibility.
4. **State your consistency choice and its cost** (CAP under partition, PACELC otherwise);
   feed→eventual, ledger→strong.
5. **"Make it async with a queue" + idempotency** is the highest-leverage scaling/resilience move;
   **consistent hashing** is the standard answer for resizing shards.
