# Chapter 21: System Design with Redis/Valkey

> Senior interviews and real engineering both ask the same question:
> "Design system X using Redis." This chapter walks you through the
> classic ones — rate limiter, leaderboard, feed, session store,
> distributed counters, presence service, cache layer in front of an
> RDBMS, geo-spatial proximity — with sizing math, failure analysis,
> and the trade-offs that make the design defensible.

---

## 21.1 Design Principles for Redis-Backed Systems

Before any specific design, four invariants:

1. **Memory is the constraint.** RAM costs ~$5/GB/month at AWS scale.
   Sizing decisions matter. You cannot quietly grow a Redis dataset
   to 2 TB the way you'd grow Postgres.
2. **Single-threaded execution sets a per-key throughput ceiling**
   (~50K ops/s on one key). Hot keys must be sharded.
3. **Async replication = potential data loss on failover.** Don't use
   Redis as a system of record for important data unless you accept
   the risk and have backstops.
4. **Operational simplicity is real value.** Three Redis instances
   replace ZooKeeper + Kafka + Postgres for many workloads. Don't
   discount that.

---

## 21.2 Rate Limiter (10M users × 100 req/min)

**Requirements**: per-user rate limiting at 100 req/min, with user IDs
in the hundreds of millions, p99 < 1 ms decisions, fault tolerant.

### 21.2.1 Sketch

Token bucket per user (Chapter 17):

```
key: rl:<user_id>
fields: {tokens, last_refill}
EVAL: refill, decrement, return allow/deny
```

### 21.2.2 Sizing

```
10M users × ~30 bytes per hash = 300 MB working set
   + dict overhead × 10M ≈ 800 MB
   + key SDS × 10M ≈ 200 MB
   = ~1.3 GB total
```

A 4 GB Redis instance with `maxmemory 3 GB`, `allkeys-lru` policy
fits comfortably with growth headroom.

### 21.2.3 Throughput

Each request = 1 EVAL → ~30 µs server-side. At 100 req/min × 10M users
= ~17K req/s sustained. Easy.

For peak (e.g., 100K req/s): one Redis instance handles it. No need to
shard.

### 21.2.4 Failure Modes

- **Redis down**: rate limiter unavailable. Options:
  - Fail open (allow all): your system is now unprotected.
  - Fail closed (reject all): your service is down.
  - **Local fallback**: client-side leaky bucket as a fallback.
- **TTL expiry edge cases**: a user idle for an hour, then bursts —
  is correctly handled by the EVAL.
- **Clock drift**: Redis's `redis.call('TIME')` is server-side, so
  rate limiting uses one consistent clock.

### 21.2.5 Scaling Beyond One Instance

Hash by user ID across N Redis instances (cluster mode or
application-side). Each instance handles 10M / N users. Trivially
scales.

---

## 21.3 Leaderboard (100M players, top-K queries)

**Requirements**: real-time scoreboard, top-100 visible always, get my
rank, paged "around me" view.

### 21.3.1 Sketch

```
ZADD leaderboard:global score user_id              # update score
ZREVRANGE leaderboard:global 0 99 WITHSCORES        # top 100
ZREVRANK leaderboard:global user_id                  # my rank
ZREVRANGE leaderboard:global <my_rank-50> <my_rank+50> WITHSCORES   # around me
```

### 21.3.2 Sizing

```
100M users × ~40 bytes per zset entry (skiplist overhead) = 4 GB
```

A 16 GB instance handles it with margin. Keep `maxmemory 8 GB`,
`allkeys-lru` (so old inactive players naturally fade if you don't
mind).

### 21.3.3 Throughput

ZADD is O(log N). For N=100M, log N ≈ 27 — ~50 µs/op. ZREVRANGE 0 99
is O(100) ≈ 30 µs.

100K updates/s → 5 sec of CPU per second on one shard. Exceeds capacity.
Shard.

### 21.3.4 Sharding the Leaderboard

Two patterns:

**Pattern A: Sharded by user ID, periodic merge.**

```
ZADD leaderboard:shard:0 score user_id    # if hash(user) % N == 0
...
# Background: every 60s, ZUNIONSTORE leaderboard:global from shards
```

Top-100 query goes against the merged set. Updates are sharded.

Trade-off: top-100 has up-to-60-seconds lag. Acceptable for many use
cases (game leaderboards).

**Pattern B: Bucketed ZADDs.**

Pre-sort scores into discrete tiers, e.g., (0-100), (101-1000), etc.
Top-100 query reads only the highest tier. This works because most
queries are concentrated at the top.

---

## 21.4 Feed (Twitter-style timeline)

**Requirements**: each user sees a reverse-chronological feed of posts
from accounts they follow. Sub-100 ms feed read.

### 21.4.1 Sketch: Fan-Out-on-Write (Push)

When user U posts:

```
for follower in followers_of(U):
    ZADD feed:<follower> <ts> <post_id>
    ZREMRANGEBYRANK feed:<follower> 0 -1001     # cap at 1000
```

Read user's feed:

```
ZREVRANGE feed:<user> 0 19 WITHSCORES         # top 20
```

### 21.4.2 Sizing

100M users × 1000 posts × ~30 bytes = 3 TB. Won't fit in one Redis.

Solutions:
- Cap feed size aggressively (top 100, not 1000) → 300 GB.
- Page on demand (scan and load older).
- Cluster (each user's feed on one shard).

### 21.4.3 The Celebrity Problem

A user with 10M followers. One post = 10M ZADDs = ~5 minutes of work
per shard. Unworkable.

**Hybrid model**:

- Normal users: fan-out-on-write.
- Celebrities: fan-in-on-read. Each user's feed reads their own
  fan-out feed PLUS pulls fresh tweets from celebrities they follow
  ZADDed locally:

```python
def get_feed(user_id):
    own_feed = redis.zrevrange(f"feed:{user_id}", 0, 19, withscores=True)
    celebrities = followed_celebrities(user_id)  # cached locally
    cele_posts = []
    for cid in celebrities:
        recent = redis.zrevrange(f"posts:{cid}", 0, 19, withscores=True)
        cele_posts.extend(recent)
    merged = sorted(own_feed + cele_posts, reverse=True)[:20]
    return merged
```

Twitter and Facebook published variants of this approach.

### 21.4.4 Failure Modes

- **A shard down**: those followers don't get the new post. Solutions:
  - Retry asynchronously.
  - Use a write-ahead log (Kafka or Redis Streams) for durability.
- **Slow shard**: feed reads p99 spike. Use read replicas.

---

## 21.5 Session Store (10M concurrent users)

**Requirements**: store session blob (~5 KB) per active user, sub-ms
reads on every API call, automatic expiry.

### 21.5.1 Sketch

```
HSET sess:<token> user_id 42 csrf_token "..." last_seen <ts>
EXPIRE sess:<token> 86400
HGET sess:<token> user_id            # on every request
EXPIRE sess:<token> 86400              # refresh on activity
```

### 21.5.2 Sizing

10M sessions × 200 bytes (hash overhead + 5 KB compressed) ≈ 2 GB.

A 4 GB Redis with `volatile-ttl` policy works (ttl-set only; ttl-evict
the oldest first when at cap).

### 21.5.3 Replication

Sessions are recoverable (user re-auths) but losing them all is a UX
disaster. Run primary + replica with `WAIT 1 100` after critical
session writes (login, password change).

For best-effort, plain async replication is fine. Session data isn't
high-stakes.

---

## 21.6 Distributed Counter (1B events/day, count by source)

**Requirements**: count requests by API endpoint, source IP, user
agent. ~12K events/sec sustained.

### 21.6.1 Sketch

```
INCR counter:requests:total
INCR counter:endpoint:<name>
INCR counter:source:<ip>
```

### 21.6.2 Sharding Counters

A single counter at 12K incr/s = 12K ops/s on one key. Approaching the
single-key throughput ceiling.

Sharded counter pattern:

```python
def incr_global(client, name):
    shard = random.randint(0, 15)
    client.incr(f"counter:{name}:shard{shard}")

def get_global(client, name):
    return sum(int(client.get(f"counter:{name}:shard{shard}") or 0) 
               for shard in range(16))
```

Read is O(16) instead of O(1) but writes scale 16x.

### 21.6.3 Approximate Counting

For approximate counts at extreme scale, use HyperLogLog:

```
PFADD visitors:today user_id_1 user_id_2 ...
PFCOUNT visitors:today                         # ~12 KB per HLL key
```

Constant 12 KB per HLL regardless of cardinality. Trades exactness
(error ~0.81%) for memory.

---

## 21.7 Presence Service (who's online?)

**Requirements**: track 50M active users; "is user X online?" in <1 ms.

### 21.7.1 Sketch

```
HSET presence user:42 last_ping <ts>
EXPIRE presence:user:42 60                    # gone after 60s of no ping

# Or with sets per region:
SADD region:us-east user:42
EXPIRE region:us-east 60                       # collective expiry won't work; use individual TTLs
```

### 21.7.2 Sketch: Bitmap

```
# Use bitmaps for "anyone in last minute"
SETBIT online:<minute> <user_id> 1
EXPIRE online:<minute> 120

# Is user online?
GETBIT online:<current_minute> <user_id> OR online:<previous_minute> <user_id>
```

50M users × 1 bit = ~6 MB per minute bitmap. Two bitmaps in memory =
12 MB total. **Massively cheaper than per-user keys.**

### 21.7.3 Combining

Use bitmap for "is online" boolean. Use hash for richer per-user
presence (last seen, status, etc.) only for users you actively query.

---

## 21.8 Pub/Sub for Real-Time Notifications

**Requirements**: 1M concurrent WebSocket clients, push notifications
when events fire.

### 21.8.1 Sketch

```
SUBSCRIBE notify:user:<id>           # one channel per user
PUBLISH notify:user:42 "<json>"       # one publish per recipient
```

### 21.8.2 Throughput Constraints

- 1M idle subscribers = 1M client connections to Redis. Each consumes
  ~16 KB; 16 GB just for connection state.
- Cluster: 1M connections, but in cluster mode `PUBLISH` broadcasts
  to all nodes — bad. Use **sharded pub/sub** (`SPUBLISH`).

Better architecture: a fleet of WebSocket gateway servers, each
holding ~100K WebSocket connections. Each gateway subscribes to
Redis channels; Redis only has ~10 connections from gateways.

Gateways fan out to their local WebSocket clients. Gives you:
- Low Redis connection count
- Application-level routing flexibility
- Easier scaling

---

## 21.9 Cache in Front of Postgres (the classic)

**Requirements**: 100K req/s reads, mostly to a "users" table; reduce
Postgres load 95%; sub-2 ms p99 reads.

### 21.9.1 Sketch (Cache-Aside)

```python
def get_user(user_id):
    cached = redis.get(f"user:{user_id}")
    if cached: return json.loads(cached)
    user = pg.fetchone("SELECT * FROM users WHERE id = %s", user_id)
    redis.set(f"user:{user_id}", json.dumps(user), ex=300)
    return user

def update_user(user_id, fields):
    pg.execute("UPDATE users SET ... WHERE id = %s", user_id)
    redis.delete(f"user:{user_id}")
```

### 21.9.2 Stampede Protection

Hot user (e.g., a celebrity profile). Probabilistic early expiration
or single-flight lock.

### 21.9.3 Hit Rate

Aim ≥ 95%. With 100K req/s and 95% hit rate, only 5K req/s reach
Postgres. Compare to an SLO of 50K req/s direct: 10x reduction.

### 21.9.4 Memory Sizing

Active set is the question. If 1M users active per hour, ~1M cache
entries × ~250 bytes = 250 MB. Trivial.

If 100M total users with poisson access: working set is much smaller
than total user count. Use `allkeys-lru` to evict naturally.

### 21.9.5 Failure Modes

- **Redis down**: every read hits Postgres. Postgres melts.
  Mitigation: circuit breaker that fails fast on Redis errors and
  rate-limits Postgres reads.
- **Stale cache after a write fails to invalidate**: TTL backstop
  bounds it.
- **Thundering herd at TTL**: stampede protection.

---

## 21.10 Geo-Spatial Proximity (rideshare driver lookup)

**Requirements**: 1M drivers, "find drivers within 1 km of (lat, lon)"
in <10 ms.

### 21.10.1 Sketch

```
GEOADD drivers <lon> <lat> driver_id
# Update on every driver heartbeat (every ~5 sec):
GEOADD drivers <new_lon> <new_lat> driver_id

# Query:
GEOSEARCH drivers FROMLONLAT <lon> <lat> BYRADIUS 1 KM ASC COUNT 10
```

GEO commands internally use a sorted set with geohash-encoded scores.
Same skiplist, same complexity (O(log N)).

### 21.10.2 Sizing

1M drivers × ~50 bytes/zset entry = 50 MB. Trivial.

Per-second updates: 1M / 5 = 200K writes/s. Approaches single-shard
limit. Shard by region (city-level partitioning).

### 21.10.3 The Score Encoding

Geohash interleaves lat/lon bits into a 52-bit integer (fits in
double's mantissa). Adjacent geohashes are nearby; this enables
efficient range queries.

`GEOSEARCH ... BYRADIUS` queries a small range of geohashes around the
query point and filters precisely.

### 21.10.4 Failure Modes

- **Stale drivers (heartbeat dropped)**: TTL via expire on the zset
  member doesn't exist (zset TTLs are key-level not member-level).
  Use periodic cleanup: `ZRANGEBYSCORE drivers -inf <stale-cutoff>` →
  remove.

---

## 21.11 Job Queue with At-Least-Once Delivery

**Requirements**: workers process jobs reliably; failures are
re-attempted; ordering FIFO per queue.

### 21.11.1 Sketch with Streams

(Covered in Chapter 14; recap.)

```
producer: XADD jobs MAXLEN ~ 1000000 * type "send_email" payload "..."
worker: XREADGROUP GROUP workers consumer-A COUNT 10 BLOCK 5000 STREAMS jobs >
worker on success: XACK jobs workers <id>
watchdog: XAUTOCLAIM jobs workers reaper 60000 0
```

### 21.11.2 Sizing

100M pending jobs × ~200 bytes = 20 GB. Trim aggressively or shard
by queue type.

### 21.11.3 Failure Modes

- Worker crashes mid-job → message stays pending → reaper claims it →
  another worker processes it. **At-least-once.**
- Two workers process the same job (double-claim race) → idempotency
  in the worker logic is essential.
- Stream grows unbounded → trim with `MAXLEN ~`.

---

## 21.12 Putting It All Together: A Reference Architecture

A real production stack might look like:

```
                              [Load balancer]
                                    |
               +--------------------+----------------------+
               |                    |                      |
            Web app            API service             gRPC service
               |                    |                      |
   +-----------+--------------------+----------------------+--+
   |                                                          |
   v                                                          v
+--------+                                              +-----------+
| Redis  |  <-- session store (1 shard, replicated)     |  Redis    |
+--------+                                              |  Cluster  |
                                                        | (sharded  |
+--------+   <-- rate limiter (1 shard)                 |  cache,   |
| Redis  |                                              |  feeds,   |
+--------+                                              |  etc.)    |
                                                        +-----------+
+--------+   <-- pub/sub for invalidation
| Redis  |   <-- a single shard is fine here
+--------+

+-----------+
| Postgres  |  <-- system of record
+-----------+

+-----------+
| Kafka     |  <-- async events / CDC
+-----------+

+-----------+
| ES/Vector |  <-- search
+-----------+
```

Each Redis serves a specific purpose. Right-sizing each independently
beats a "one giant Redis" setup.

---

## 21.13 Sizing Cheat Sheet

For an instance of a given size, what's a reasonable workload?

| RAM | Working set | Throughput | Use case |
|-----|-------------|------------|----------|
| 2 GB | 1 GB | 100K ops/s | Sessions, rate limiter for one app |
| 8 GB | 5 GB | 200K ops/s | Cache for medium app, leaderboard <1M users |
| 32 GB | 24 GB | 500K ops/s | Cache for large app, feeds for normal users |
| 128 GB | 100 GB | 1M ops/s | Aggressive caching layer, fork pause becoming visible |
| 256 GB+ | up to 200 GB | 1M+ ops/s | Big — strongly consider sharding instead |

Single instances above 128 GB get hard to operate (fork pause, RDB
load time, replication catch-up). At that scale, cluster.

---

## 21.14 Final System Design Heuristics

When designing with Redis, ask:

1. **What's the size of the working set?** (Determines RAM.)
2. **What's the per-key throughput required?** (Hot-key sharding.)
3. **What's the durability requirement?** (RDB only? AOF? WAIT?)
4. **What's the failover time you can tolerate?** (Sentinel/Cluster.)
5. **What's the multi-region story?** (Cross-region replication or
   per-region instances.)
6. **What's the cost of being wrong?** (Use Postgres for SoR.)

Answer these explicitly in any system design discussion — in
interviews and in your team's design reviews. The questions are more
important than the specific Redis answer.

---

## Practice Questions

1. Design a "trending hashtags in last 5 minutes" service. Sketch the
   Redis structures, the write path, the read path, and the cost.
2. Design a cross-region session store. The user logs in in US-East
   and may immediately request from EU-West. What architectures fit?
3. A leaderboard at 1B users. Discuss feasibility on Redis Cluster
   and the bottleneck you'd hit first.
4. Sizing: a per-user notification bitmap, 200M users, one bit per
   notification type, 10 types. Estimate memory.
5. Compare Redis Streams vs Kafka for a 100K msg/sec audit trail
   that must be retained for 7 days. Which one and why?
6. Your cache hit rate is 75%. p99 of API calls is 25 ms (mostly
   Postgres). How do you get hit rate to 95%, and what's the expected
   p99?

(Answers at end of Chapter 22.)
