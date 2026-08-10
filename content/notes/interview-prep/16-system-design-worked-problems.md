# Chapter 16: System Design — Worked Problems

> **Relearning log.** Reading frameworks isn't enough; I had to *run the script end-to-end* on real
> problems out loud and time myself. The pattern I noticed across my first attempts: I'd nail
> requirements and then sprint past estimation straight into a diagram. So these worked problems
> deliberately show the **estimation → decision** link every time, and each ends with the **L5
> follow-up** the interviewer actually asks ("now make it global / handle the celebrity / guarantee
> ordering"). I apply the [7-step framework (Ch 14)](14-system-design-framework.md) and the
> [building blocks (Ch 15)](15-building-blocks-and-back-of-envelope.md) throughout.

Each problem below is compressed to its decisions; in a real round I'd narrate every step.

---

## 16.1 URL shortener (the warm-up everyone gets)

**Requirements.** Functional: shorten a long URL → short code; redirect short → long. Non-functional:
redirect latency low (< 50 ms), high availability, read-heavy. Out of scope: analytics, custom
aliases (mention).

**Estimate.** 100 M new URLs/day → ~1,200 writes/sec; read:write ≈ 100:1 → ~120 k reads/sec. Storage:
100 M/day × ~500 bytes × 5 yr ≈ ~90 TB. **Decisions forced:** heavy caching for reads; the write
volume is modest; storage needs sharding over years.

**API.** `POST /shorten {url} → {shortCode}`; `GET /{shortCode} → 301/302 redirect`.

**Key design decision — generating the short code:**
- **Counter + base62:** a globally unique incrementing ID encoded base62 (`[0-9a-zA-Z]`). 7 chars =
  62⁷ ≈ 3.5 trillion. Distribute ID generation with a **range-allocator** (each app server grabs a
  block of IDs) or a Snowflake-style ID. Avoids coordination per request.
- **Hash (MD5/SHA) + take first 7 chars:** simple but needs collision handling (check-and-retry).
- *Pick counter+base62*, tradeoff: needs a coordinated ID source, but guarantees no collisions and
  short codes.

**Data model.** `code → longUrl` — pure key lookup, no relations → KV store or a sharded table keyed
by `code`. Cache-aside in Redis for the hot codes (redirects).

**Flow.** Read: `GET /{code}` → check Redis → on miss read DB, populate cache → 302 redirect.
Write: allocate ID → base62 → store → return.

**L5 follow-ups:**
- *Custom aliases?* check uniqueness, separate namespace.
- *Expiry / cleanup?* TTL column + background sweeper.
- *Analytics (click counts)?* don't do it synchronously — emit an event to Kafka, aggregate async.
- *302 vs 301?* 301 is cached by browsers (fewer hits, but no analytics); 302 keeps control.

---

## 16.2 Rate limiter

**Requirements.** Limit each client to N requests/window; low added latency; distributed (works
across many API servers); fail-open vs fail-closed decision.

**Algorithms (know the tradeoffs):**

| Algorithm | Behavior | Tradeoff |
|-----------|----------|----------|
| **Fixed window** | count per clock window | simple; allows 2× burst at window edges |
| **Sliding window log** | timestamps of each request | exact; memory-heavy |
| **Sliding window counter** | weighted blend of two windows | good approximation, cheap |
| **Token bucket** | tokens refill at rate r, burst up to capacity | allows controlled bursts; the usual pick |
| **Leaky bucket** | requests drain at fixed rate | smooths output; queues/drops excess |

**Distributed design.** Counters in **Redis** keyed by `clientId:window`, with atomic
`INCR`+`EXPIRE` (or a Lua script for token-bucket atomicity). App servers are stateless; Redis is the
shared state.

> The L5 nuances: **atomicity** (use a Lua script / `INCR` so concurrent requests don't race),
> **clock skew** across servers (use Redis time or token-bucket math), and **fail-open vs
> fail-closed** when Redis is down (fail-open for availability, fail-closed for abuse-sensitive
> endpoints — state the choice).

**L5 follow-ups:** per-user vs per-IP vs per-API-key tiers; return `429` + `Retry-After`; sliding
window to avoid the fixed-window burst.

---

## 16.3 News feed (Twitter/Instagram timeline) — the fan-out classic

**Requirements.** Post; view home timeline (posts from people you follow, newest-first). Read-heavy,
eventual consistency OK, low timeline latency. Scale: 150 M DAU (from
[Ch 14 estimate](14-system-design-framework.md)), read:write ≈ 100:1.

**The central decision — fan-out on write vs on read:**

| Approach | How | Good for | Bad for |
|----------|-----|----------|---------|
| **Fan-out on write (push)** | on post, write the post id into every follower's precomputed timeline (Redis list) | fast reads (just read your list) | celebrities (millions of writes per post) |
| **Fan-out on read (pull)** | on read, gather recent posts from everyone you follow & merge | cheap writes | slow reads, heavy at read time |
| **Hybrid (the real answer)** | push for normal users; for celebrities, **pull** their posts at read time and merge | balances both | more complex |

> The celebrity/hot-key problem is the whole point of this question. The senior answer is the
> **hybrid**: precompute timelines for the common case, but special-case high-fan-out accounts by
> merging their posts at read time. This is the same hot-shard mitigation from
> [Ch 15](15-building-blocks-and-back-of-envelope.md), applied to a feed.

**Components.** Post service → write to DB (source of truth) + emit to a **fan-out queue** → workers
push post-ids into followers' Redis timeline lists. Timeline service reads the Redis list (+ merges
celebrity posts) → hydrates post content from cache/DB.

**L5 follow-ups:** ranking (chronological vs ML-ranked — add a ranking service); pagination by
cursor; handling a new follow (backfill); media (store in blob/CDN, feed holds references).

---

## 16.4 Chat / messaging (WhatsApp-style 1:1)

**Requirements.** Send/receive 1:1 messages; delivery + read receipts; online presence; message
ordering per conversation; offline delivery. Low latency, durable (don't lose messages).

**Connection layer.** Persistent **WebSocket** connections (not request/response polling) to a fleet
of **gateway servers**. A **session registry** (Redis) maps `userId → gatewayServer` so we can route
a message to the right connection.

**Send flow.** A→gateway→**message service**: persist the message (durability!), then look up B's
gateway via the registry and push over B's socket; if B is offline, store and deliver on reconnect
(+ optional push notification). ACK back to A (sent → delivered → read state machine).

**Storage.** Messages keyed by `conversationId` + time-sorted → wide-column (Cassandra) for write
volume and time-range reads. Per-conversation ordering via a sequence number assigned by the message
service.

**L5 follow-ups:** **ordering** (monotonic per-conversation sequence; clients sort by it); group
chat (fan-out to N members, same hybrid concerns); **exactly-once display** (idempotent message ids
+ client dedup); end-to-end encryption (keys, server stores ciphertext); presence at scale (heartbeat
+ TTL, gossip).

---

## 16.5 Nearby / geo (Yelp / find drivers / nearby friends)

**Requirements.** Given a location, return entities within radius R, ranked by distance; updates as
things move (for live drivers). Read-heavy for search; write-heavy for live location.

**The core technique — spatial indexing:**
- **Geohash:** encode lat/long into a string prefix; nearby points share prefixes → range-query a
  prefix and its 8 neighbors. Simple, works with any KV/SQL store.
- **Quadtree:** recursively subdivide space; adaptive to density (dense cities → finer cells).
- **S2 / H3:** production-grade cell systems (Google S2, Uber H3) — hexagonal/spherical cells.

**Static search (Yelp):** index places by geohash in the DB; query the cell + neighbors; filter by
exact distance; cache popular areas. **Live (drivers):** drivers publish location every few seconds
to a **geo-index in Redis** (`GEOADD`/`GEOSEARCH`); riders query nearby — accept staleness of a few
seconds.

**L5 follow-ups:** boundary problem (entities just across a cell edge → always query neighbor cells);
hot cities (finer cells / quadtree); write amplification from frequent location updates (sample,
batch, or only update on meaningful movement).

---

## 16.6 Top-K / trending (most viewed in the last hour)

**Requirements.** Approximate top-K frequent items over a stream (trending hashtags, top products),
sliding time window, at high event volume. Exact is too expensive; **approximate is acceptable** —
say this.

**Technique.** **Count-Min Sketch** (probabilistic frequency counter, fixed memory, slight
overcount) feeding a **min-heap of size K** (from [Ch 10](10-pattern-heaps-intervals-greedy.md));
time-windowed by bucketing counts per time slice and aging out old buckets. Pre-aggregate per shard,
then merge (map-reduce style).

**L5 follow-ups:** exact vs approximate tradeoff (sketch error bounds vs memory); the sliding window
(ring of per-minute buckets); hot-key skew; serving (precompute top-K periodically, cache it).

---

## 16.7 Distributed cache / key-value store (design Redis-like)

**Requirements.** `get/put` with sub-ms latency, scale beyond one node's memory, tolerate node
failure, tunable consistency.

**Design.** **Consistent hashing** to map keys → nodes (virtual nodes for even distribution and
minimal reshuffle on membership change). **Replication factor N** with quorum reads/writes (`R + W >
N` → strong-ish; `R=W=1` → fast, eventually consistent). **LRU eviction** per node; **gossip** for
membership/failure detection. Client- or proxy-side routing.

**L5 follow-ups:** hot keys (replicate the key, client-side caching); consistency knobs (quorum
tuning, read-repair, hinted handoff); persistence (snapshot + append-only log for durability);
rebalancing when adding nodes (consistent hashing minimizes movement).

---

## 16.8 The pattern across all of them

> Every one of these reduces to the same moves: **estimate to find the read:write ratio → cache the
> reads → make the heavy/non-blocking work async via a queue → shard the data by an access-pattern-
> aligned key → name the hot-key/celebrity problem and solve it with a hybrid/special-case → state
> the consistency choice and its cost.** If I run that checklist, I can drive a design for a system
> I've never seen before.

## Interview Drills

- **D16.1 [E]** Design a URL shortener end-to-end in 20 minutes, out loud, with the estimation step.
- **D16.2 [M]** Design a distributed rate limiter; defend token bucket vs sliding window, and the
  Redis atomicity concern.
- **D16.3 [M]** Design a news feed; the interviewer says "user X has 50 M followers" — walk the
  hybrid fan-out.
- **D16.4 [H]** Design WhatsApp; the follow-up is "guarantee per-conversation message ordering and
  no duplicate display."
- **D16.5 [H]** Design "find nearby drivers"; handle frequent location updates and the cell-boundary
  problem.
- **D16.6 [H]** Design trending hashtags over the last hour at 1 M events/sec; defend approximate vs
  exact.

## Key Takeaways

1. **Always show the estimation → decision link;** the read:write ratio dictates caching and
   fan-out strategy.
2. **News feed = fan-out tradeoff;** the senior answer is the **hybrid** (push for normal users, pull
   for celebrities) — the hot-key problem generalized.
3. **Chat = persistent WebSockets + session registry + durable per-conversation ordering**, async
   offline delivery.
4. **Geo = spatial index (geohash/quadtree/S2);** always query neighbor cells; accept staleness for
   live location.
5. **Top-K = Count-Min Sketch + heap + time buckets;** name approximate-vs-exact explicitly.
6. **One reusable checklist** (estimate → cache → async queue → shard by access pattern → solve the
   hot key → state consistency cost) drives any unseen design.
