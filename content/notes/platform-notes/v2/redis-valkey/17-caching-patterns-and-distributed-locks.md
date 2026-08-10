# Chapter 17: Caching Patterns & Distributed Locks

> Most production Redis is a cache. Most production caches share a small
> set of patterns: cache-aside, read-through, write-through, write-behind.
> Each comes with failure modes — stampedes, dogpiles, stale reads —
> that have well-understood mitigations. The other half of this chapter
> is the most-controversial production use case: **distributed locks**.
> Redlock is famous, much critiqued, and still everywhere. We'll cover
> the algorithm, Martin Kleppmann's critique, and the situations where
> Redlock is fine vs where it isn't.

---

## 17.1 The Cache-Aside Pattern

The default. The application owns the cache miss logic.

```python
def get_user(user_id):
    key = f"user:{user_id}"
    cached = redis.get(key)
    if cached:
        return json.loads(cached)
    # Cache miss: load from primary store
    user = postgres.fetchone("SELECT ... WHERE id = %s", user_id)
    redis.set(key, json.dumps(user), ex=300)    # 5-minute TTL
    return user
```

Reads:
1. Check Redis. Hit → return. ~50 µs.
2. Miss → fetch from Postgres. ~5 ms. Populate Redis.

Writes:
1. Update Postgres.
2. Either invalidate (`redis.delete(key)`) or update (`redis.set(key, new)`).

**Always invalidate after writes**, not "update." The reason:

```
T0: client A reads cache miss; starts loading from DB
T1: client B writes to DB; updates cache to new value
T2: client A finishes loading old DB value; overwrites cache with stale
```

If you only invalidate (delete), the next read goes to DB and gets
fresh data. Updating in the cache opens a race window.

>>> **Interview insight**: This race is the **stale-cache race
>>> condition** — invariably comes up in distributed systems interviews.
>>> The textbook fix is "delete on write, repopulate on read miss." The
>>> sophisticated fix involves cache versioning or change-data-capture.

### 17.1.1 Cache Invalidation: Two Hard Things

Phil Karlton's quip — "There are only two hard things in Computer
Science: cache invalidation and naming things" — is real. Three
strategies:

1. **TTL only**: every key has a TTL; staleness is bounded by TTL.
   Simple, robust. Wastes some DB reads after expiry. Most common.
2. **TTL + write-time invalidation**: TTL backstop, plus delete on
   write. Reduces staleness during the TTL window.
3. **Change Data Capture (CDC)**: a separate service watches DB write
   logs and invalidates Redis. Complex, but bounds staleness to CDC lag.

Pick (2) for most apps. (3) when you have strict freshness requirements
*and* infrastructure to run CDC.

---

## 17.2 Read-Through and Write-Through

Variations where the cache library handles cache misses transparently.

```python
class WriteThroughCache:
    def get(self, key):
        cached = redis.get(key)
        if cached: return cached
        value = self.loader(key)
        redis.set(key, value, ex=300)
        return value
    
    def set(self, key, value):
        self.writer(key, value)       # write to DB first
        redis.set(key, value, ex=300) # then update cache
```

The "library" pattern is mostly cosmetic — the underlying race
conditions are the same as cache-aside.

---

## 17.3 Write-Behind (Write-Back)

Writes go to Redis first, then to the DB asynchronously by a worker.

```
client -> SET in Redis -> immediate ack
                          |
                          v
                  +----------------+
                  | write-behind   |
                  | worker queue   |
                  +----------------+
                          |
                          v
                       Postgres
```

Pros:
- Fast writes (Redis latency only).
- Batched DB writes (potentially much higher throughput).

Cons:
- **Lossy**: a Redis crash before the worker drains queue loses writes.
- Requires Redis to be the source of truth between write and persist.
- Complex retry/idempotency story.

Reach for this only with eyes wide open. For most workloads, the
durability cost outweighs the latency benefit.

---

## 17.4 Cache Stampedes (Dogpiles)

A hot key expires. Hundreds of clients miss simultaneously. Each tries
to load from the DB. The DB melts.

```
T0:    cache key "homepage" expires
T0+1:  100K clients query "homepage" simultaneously
T0+2:  100K clients hit cache miss
T0+3:  100K Postgres queries fire
T0+4:  Postgres dies
```

Three mitigations:

### 17.4.1 Probabilistic Early Expiration

Each client computes an "effective" TTL slightly *before* the real one,
based on a random factor. Clients with shorter effective TTLs refresh
the cache before others miss.

```python
def get_with_pee(key, ttl_seconds, beta=1.0):
    cached, expiry, computed_at = redis.hmget(key, "v", "exp", "ct")
    if cached:
        delta = beta * computed_at_in_seconds * math.log(random.random())
        if time.now() - delta < expiry:
            return cached    # likely fresh enough; don't bother re-computing
    return reload_and_set(key, ttl_seconds)
```

The beta factor controls aggressiveness. Beta=1 is standard.
[Reference: "Optimal Probabilistic Cache Stampede Prevention" — Vatlin
et al.]

### 17.4.2 Locking the Recompute

Only one client recomputes; others wait for the result.

```python
def get_with_lock(key, loader, ttl):
    cached = redis.get(key)
    if cached: return cached
    
    lock_key = f"lock:{key}"
    if redis.set(lock_key, "1", nx=True, ex=10):
        try:
            value = loader()
            redis.set(key, value, ex=ttl)
            return value
        finally:
            redis.delete(lock_key)
    else:
        # someone else is recomputing; wait briefly and retry
        time.sleep(0.05)
        return redis.get(key) or loader()  # fallback
```

Single-flight per key. Works well; just don't hold the lock too long.

### 17.4.3 Background Refresh

A worker process refreshes hot keys *before* they expire. Hot keys never
have a real miss.

```
worker pool:
  every 60 sec: for top-100 hot keys, recompute and SET
  
clients: just GET, never miss
```

Use Redis's INFO stats or sliding-window counters to identify hot keys.

---

## 17.5 Negative Caching

Clients cache "this key doesn't exist" to prevent storm-loading missing
keys:

```python
NULL_SENTINEL = "__NULL__"

def get_with_negative_cache(key):
    cached = redis.get(key)
    if cached == NULL_SENTINEL: return None
    if cached: return cached
    value = loader()
    if value is None:
        redis.set(key, NULL_SENTINEL, ex=60)   # short negative TTL
    else:
        redis.set(key, value, ex=600)
    return value
```

Critical for traffic patterns where attackers (or bots) probe
non-existent keys.

---

## 17.6 Distributed Locks: The Honest Story

Locks across processes via Redis. The simplest form:

```python
def acquire(key, value, ttl_ms):
    return redis.set(key, value, nx=True, px=ttl_ms)

def release(key, value):
    # only release if value matches (avoid releasing someone else's lock)
    script = """
    if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
    else
        return 0
    end
    """
    redis.eval(script, 1, key, value)
```

Three properties to want:
- **Mutual exclusion**: at most one holder at a time.
- **Deadlock-free**: even if a holder crashes, eventually someone else
  can take the lock.
- **Fault tolerance**: as long as a quorum of Redis is alive, the lock
  works.

The single-node version (`SET NX EX`) gives the first two but **fails
the third** — a Redis crash drops the lock.

---

## 17.7 Redlock: The Multi-Node Protocol

Antirez (Salvatore) proposed **Redlock** to add fault tolerance: acquire
the lock on **a majority of N independent Redis nodes**.

### 17.7.1 The Algorithm

To acquire:

1. Get current time (T0).
2. Try `SET lock:X random-token NX PX 30000` on each of N independent
   Redis instances, in sequence.
3. Count successes. If ≥ majority AND elapsed time < lock TTL, the lock
   is held.
4. The remaining lock validity time = TTL - (now - T0) - drift.

To release:

5. Run the release Lua script (delete-if-equals) on **all** N instances.

Recommended N=5. With N=5, majority=3. Tolerates 2 dead Redises.

### 17.7.2 The Critique (Kleppmann)

Martin Kleppmann's "[How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)"
(2016) raised three concerns:

1. **Clock drift**: Redlock relies on local clocks for TTL. If a node's
   clock jumps (NTP correction, leap second, VM pause), the lock can be
   held by two clients simultaneously.
2. **GC pauses / process pauses**: a client acquires a lock, then a
   30-second GC pause, then the lock expires, then another client
   acquires it. The first client wakes up, doesn't realize, and proceeds
   with stale belief it holds the lock.
3. **No fencing token**: even if the lock is mutually exclusive at any
   instant, there's no token to prove "I held the lock at THIS time" —
   so a delayed write can corrupt state held by the new lock holder.

Kleppmann's recommendation: use a real consensus system (ZooKeeper,
etcd) and emit a monotonically increasing **fencing token**. Every
write to the protected resource includes the token; the resource
rejects writes with stale tokens.

### 17.7.3 Antirez's Response

Antirez agreed that Redlock has these constraints but argued:

1. The clock drift problem affects *all* time-bounded locking systems
   (including ZooKeeper's session timeouts).
2. Most applications don't need fencing tokens — they just need "no two
   processes do the same thing simultaneously, with eventual safety."
3. Redlock is *correct* under reasonable real-world clock assumptions,
   and *fast* (sub-millisecond locks across LANs).

The pragmatic position: **Redlock is fine for non-critical mutual
exclusion** (rate limiting, debouncing, leader election in a cron-like
setting). It is **not fine for resource integrity** (database writes,
financial transactions, anything where dual-execution corrupts state).

>>> **Interview insight**: When asked "would you use Redis for distributed
>>> locks?" the right answer is "for what?" If it's "make sure only one
>>> instance of a periodic job runs," Redlock is fine. If it's "make sure
>>> only one process writes to a shared file," use ZooKeeper or a lease
>>> service that emits fencing tokens.

### 17.7.4 The Pragmatic Single-Redis Version

Most teams just use a single Redis. The trade-off: a Redis failover
during a held lock is extremely rare in practice, and the alternative
(ZooKeeper) adds operational burden.

```python
def acquire(key, ttl_ms=30000):
    token = uuid4().hex
    if redis.set(f"lock:{key}", token, nx=True, px=ttl_ms):
        return token
    return None

def release(key, token):
    return redis.eval(RELEASE_SCRIPT, 1, f"lock:{key}", token) == 1
```

Combine with `SETNX` and the Lua release pattern, and you have a
"good enough" lock for most cooperative scenarios.

### 17.7.5 Alternatives to Redlock

- **PostgreSQL advisory locks**: `pg_try_advisory_lock`. Same logical
  primitive, with consensus already provided.
- **etcd / ZooKeeper**: stronger consistency, fencing tokens, watches.
  Operational overhead.
- **DynamoDB conditional writes**: cheap, scalable, no operational
  cost. Higher latency.
- **Application-level**: queues, leases, idempotency tokens — often
  better fit than locks.

---

## 17.8 Rate Limiting

A common Redis pattern. Three implementations:

### 17.8.1 Fixed Window Counter

```python
def allow(user_id, max_per_minute=60):
    minute = int(time.time() // 60)
    key = f"rate:{user_id}:{minute}"
    count = redis.incr(key)
    if count == 1:
        redis.expire(key, 70)
    return count <= max_per_minute
```

Cheap. Per-key INCR. **Edge case**: a user can do 60 requests in the
last second of one minute and 60 in the first second of the next —
effectively 120 in 2 seconds.

### 17.8.2 Sliding Window Counter (token bucket)

```lua
-- in EVAL form
local key = KEYS[1]
local now = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local last_refill = tonumber(redis.call('HGET', key, 'last_refill') or '0')
local tokens = tonumber(redis.call('HGET', key, 'tokens') or capacity)

local elapsed = (now - last_refill) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill_rate)

if tokens < cost then return 0 end

tokens = tokens - cost
redis.call('HSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', key, 60)
return 1
```

Token bucket: smooth rate limiting. Each request costs tokens; tokens
regenerate over time. Standard pattern.

### 17.8.3 Sliding Window Log

```python
def allow(user_id, max_per_minute=60):
    now = time.time()
    cutoff = now - 60
    key = f"rate:{user_id}"
    pipe = redis.pipeline()
    pipe.zremrangebyscore(key, "-inf", cutoff)
    pipe.zadd(key, {now: now})
    pipe.zcard(key)
    pipe.expire(key, 70)
    _, _, count, _ = pipe.execute()
    return count <= max_per_minute
```

Stores every request as a sorted set entry. ZREMRANGEBYSCORE drops old
ones. ZCARD counts the window. Most accurate, most memory.

For high-throughput, prefer token bucket via EVAL. For audit-quality
records, sliding window log.

---

## 17.9 Distributed Counters and Idempotency

### 17.9.1 Idempotency Keys

A client sends a unique idempotency key with each operation. Redis
stores the key + result for some TTL:

```python
def perform(idem_key, body, ttl=86400):
    cached = redis.get(f"idem:{idem_key}")
    if cached: return cached     # replay protection
    result = do_actual_work(body)
    redis.set(f"idem:{idem_key}", result, ex=ttl, nx=True)
    return result
```

Used by Stripe, Twilio, every payment API. Prevents double-charges
during client retries.

### 17.9.2 At-Most-Once Per User Per Day Notifications

```python
def maybe_send(user_id, notif_type):
    key = f"sent:{user_id}:{notif_type}:{date.today()}"
    if redis.set(key, "1", nx=True, ex=86400):
        send_notification(user_id, notif_type)
```

`SET NX EX` is the workhorse — atomic check-and-set with TTL.

---

## 17.10 Sessions

Classic use case. Each user session = one Redis key.

```python
session_key = f"sess:{session_token}"
redis.hset(session_key, mapping={
    "user_id": user_id,
    "csrf_token": csrf,
    "last_seen": time.time(),
})
redis.expire(session_key, 86400)   # 1 day
```

**Notes**:
- Hash, not string. Allows partial reads/writes (`HGET sess:X csrf_token`).
- Refresh expiry on every read to extend on activity:
  `redis.expire(session_key, 86400)` after `HGET`.
- Don't store private encryption keys in Redis without TLS — assume
  Redis network is internal but encrypt sensitive fields at the app
  layer.

---

## 17.11 Leaderboards

Sorted sets in their natural habitat:

```python
redis.zadd("leaderboard:global", {user_id: score})
redis.zrevrange("leaderboard:global", 0, 9, withscores=True)   # top 10
redis.zrevrank("leaderboard:global", user_id)                   # my rank
```

For a 100M-user leaderboard:
- Memory: ~50 bytes/user × 100M = 5 GB. Reasonable.
- `ZADD`: O(log N). ~80 µs at 100M.
- Top-K: O(K). 100 µs for K=10.
- Rank: O(log N). ~80 µs.

For multi-region leaderboards, shard by region or use ZUNIONSTORE
periodically for global views.

---

## 17.12 Feed Generation

Reverse-chronological feeds via sorted sets keyed by user with
timestamp scores:

```python
# When user U posts:
for follower in followers_of(U):
    redis.zadd(f"feed:{follower}", {post_id: timestamp})
    redis.zremrangebyrank(f"feed:{follower}", 0, -1001)   # cap at 1000

# When fetching feed:
post_ids = redis.zrevrange(f"feed:{user}", 0, 19, withscores=False)
posts = [load_post(pid) for pid in post_ids]
```

This is **fan-out-on-write**: O(followers) work per post. Bad for
celebrity accounts (1M followers = 1M ZADDs per post).

The **hybrid model**: fan out for normal users, fan in for celebrities
(query their feed at read time). Twitter/Facebook do this.

---

## 17.13 Source Files for This Chapter (Patterns Only)

This chapter doesn't have specific source files in Redis — these are
client-side patterns. Reference reading:

- Redis docs `commands.md` for `SET NX EX` semantics.
- Redis Labs whitepapers on caching patterns.
- Antirez's blog post on Redlock; Kleppmann's response.
- "Designing Data-Intensive Applications" — Chapter 9 on consistency
  and consensus.

---

## Practice Questions

1. The cache-aside pattern has a stale-cache race. Walk through it.
   Why does invalidate-on-write fix it but update-on-write doesn't?
2. A hot key expires; 100K clients dogpile the DB. List three
   mitigations and their trade-offs.
3. You're implementing a "send email if not sent in last 24 hours"
   guard with `SET NX EX`. The Redis primary fails over mid-execution.
   What goes wrong?
4. Redlock requires N=5 instances and majority. Why not just use one
   Redis with `SET NX`? Under what failure mode is the difference
   visible?
5. A client process pauses for 35 seconds during a 30-second-TTL
   distributed lock. Explain what can go wrong even with Redlock.
6. Token bucket vs sliding window log: when do you pick which?
7. You have 100M users. Each has a 30 KB session blob. You hit
   `maxmemory`. List three ways to reduce memory before sharding.
8. A leaderboard has 1B entries. `ZADD` becomes slow. The skiplist's
   complexity is O(log N). What else might be the cause?

(Answers at end of Chapter 22.)
