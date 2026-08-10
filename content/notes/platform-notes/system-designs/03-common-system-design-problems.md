# Common System Design Problems — Deep Technical Solutions

> Target: Senior Java/Systems developer, 15yr exp, 40 LPA interviews.
> Every problem solved at production depth with capacity estimates, data models, and architecture decisions.

---

## Table of Contents

1. URL Shortener
2. Distributed Rate Limiter
3. Distributed Cache
4. Notification System
5. Search Autocomplete
6. Consistent Key-Value Store (DynamoDB/Cassandra)
7. Twitter/Instagram Feed

---

## 1. URL Shortener (like bit.ly)

### Requirements Clarification

**Functional:**
- Given a long URL, return a short URL (e.g., `bit.ly/abc123`)
- Given a short URL, redirect to the original long URL
- Custom aliases: optionally allow users to pick the short code
- Expiry: URLs can optionally expire

**Non-functional:**
- 100M new URLs created/day (write)
- 1B redirects/day (read) → 100:1 read-to-write ratio
- Redirect latency < 10ms (this is a hot path)
- Availability: 99.99%

### Capacity Estimation

```
Writes: 100M / 86,400s = ~1,160 URLs/s
Reads:  1B   / 86,400s = ~11,574 redirects/s (peak: 50,000/s)

Storage (5 years):
  100M/day * 365 * 5 = 182.5B URL pairs
  Avg storage/URL:
    - long URL: 150 bytes average
    - short code: 7 bytes
    - metadata (createdAt, userId, expiry): 50 bytes
    Total: ~207 bytes/URL pair
  
  182.5B * 207 bytes = ~37 TB over 5 years

Cache:
  80/20 rule: 20% of URLs = 80% of traffic
  20% of 100M daily creates = 20M URLs
  20M * 207 bytes = ~4 GB (fits in a single Redis cluster easily)
```

### URL Shortening: Hash Function Choice

**Approach 1: MD5 then truncate**
```
MD5(longUrl) → 128-bit hash → take first 43 bits → base62 encode → 7 characters

base62 alphabet: [0-9][a-z][A-Z] = 62 chars
62^7 = 3.5 trillion unique codes (enough for 182B URLs with ~5% collision rate)
```

**Problem with MD5 truncation:** Collisions. MD5 is a 128-bit hash, but you're taking 43 bits. The birthday paradox applies: with N URLs stored, collision probability ≈ N²/(2 * 2^43).

At 100M stored URLs: collision probability ≈ (10^8)² / (2 * 8.8 * 10^12) ≈ 0.06% per new URL — i.e., ~1,160 * 0.06% = ~0.7 collisions/second. Must handle.

**Collision handling:**
```java
String shorten(String longUrl) {
    String hash = md5(longUrl);
    for (int i = 0; i < 3; i++) {
        String candidate = base62(hash.substring(i * 7, i * 7 + 7));
        if (!db.exists(candidate)) {
            db.insert(candidate, longUrl);
            return candidate;
        }
        // Try a different 7-char slice on collision
    }
    // Fallback: append random suffix
    throw new CollisionException("Exhausted attempts");
}
```

**Approach 2: Counter-based (Twitter Snowflake style)**

Generate a globally unique auto-incrementing ID, then base62-encode it:

```
ID = 100,000,000 → base62 = "5lj5"  (4 chars)
ID = 3,521,614,606,208 → base62 = "aaaaaaa" (7 chars)

This is collision-free by design.
```

**ID generation:**
- Single auto-increment DB: bottleneck, single point of failure.
- Multi-master auto-increment: each server starts at offset, increments by N (e.g., server 1: 1,7,13...; server 2: 2,8,14...).
- Snowflake ID: 64-bit = timestamp(41) + datacenter(5) + machine(5) + sequence(12). Twitter's approach.
- Separate key generation service (like Flickr's ticket server).

**Approach 3: Separate Key Generation Service (KGS)**

Pre-generate all possible 7-char base62 strings and store them in a "used_keys" and "available_keys" table.

```
Available pool: pre-populate with 3.5T keys (stored as strings, ~24TB — impractical)
Better: generate keys lazily in batches. Each application server fetches 1000 keys at a time.
```

**Trade-off comparison:**

| Approach | Collision-free | Distributed | Predictable IDs | Complexity |
|----------|---------------|-------------|-----------------|-----------|
| MD5 truncate | No | Yes | No | Low |
| Counter + base62 | Yes | Needs coordination | Yes (enumerable) | Medium |
| Snowflake | Yes | Yes | Partially | Medium |
| KGS | Yes | Yes (with coordination) | No | High |

**Best for interview:** Use Snowflake ID → base62 encode. Justify: no collision, distributed, no external service needed.

### Data Model

```sql
-- Primary table: short_url → long_url mapping
CREATE TABLE url_mapping (
    short_code   VARCHAR(10)  PRIMARY KEY,
    long_url     TEXT         NOT NULL,
    user_id      BIGINT,
    created_at   TIMESTAMP    DEFAULT NOW(),
    expires_at   TIMESTAMP,
    click_count  BIGINT       DEFAULT 0
) WITH (
    FILLFACTOR = 70  -- leave room for updates (click_count)
);

-- Index for cleanup jobs (expired URLs)
CREATE INDEX ON url_mapping (expires_at) WHERE expires_at IS NOT NULL;
```

**Why Cassandra fits well:**
- Key-value lookup: `short_code` → row. Cassandra's partition key = `short_code`. O(1) lookup.
- Write-heavy: Cassandra's LSM-tree excels at writes.
- Geographically distributed: multi-region Cassandra handles global redirects with low latency.
- No complex joins needed.
- Downside: no COUNT, no range queries — but we don't need those for core redirect flow.

**Cassandra schema:**
```cql
CREATE TABLE url_shortener.urls (
    short_code  TEXT PRIMARY KEY,
    long_url    TEXT,
    user_id     UUID,
    created_at  TIMESTAMP,
    expires_at  TIMESTAMP,
    click_count COUNTER  -- Use separate table for counters in Cassandra
);
```

**Note on `COUNTER` in Cassandra:** Cassandra counter columns require their own table and cannot be mixed with regular columns. In practice, use a separate analytics pipeline (Kafka → Flink/Spark → analytics DB) for click counting rather than incrementing in Cassandra on every redirect.

### Cache Strategy

```
80% of redirects come from 20% of URLs.
Hot URLs: top 20M URLs.
Cache these in Redis.

Cache entry: Key = short_code, Value = long_url, TTL = 24h
Cache size: 20M * (10 bytes key + 150 bytes value) ≈ 3.2 GB → fits in 4GB Redis

Cache-aside pattern:
1. Receive short_code
2. Check Redis → if hit: return long_url immediately
3. If miss: query Cassandra → store in Redis → return

Write path (URL creation):
1. Write to Cassandra
2. Write to Redis (warm cache proactively for new URLs)
```

**Cache invalidation on expiry:**
```java
void create(String shortCode, String longUrl, Duration ttl) {
    cassandra.insert(shortCode, longUrl, ttl);
    if (ttl != null) {
        redis.setex(shortCode, ttl.getSeconds(), longUrl);
    } else {
        redis.set(shortCode, longUrl);
        redis.expire(shortCode, 86400);  // 24h default
    }
}
```

### System Architecture

```
[Client]
    |
    | HTTP GET /abc123
    ↓
[CDN / Edge Cache]  ← Cache popular redirects at edge (Cloudflare Workers)
    |               Hit rate: ~60% for viral URLs
    | CDN miss
    ↓
[Load Balancer]
    |
[Redirect Service] ← stateless, 50+ instances
    |
    ├─→ [Redis Cluster] ← 99% of reads served here
    |
    └─→ [Cassandra Cluster] ← fallback for cache misses

[URL Creation Service] → [Cassandra] + [Redis preload]
                      ↑
                [ID Generator] (Snowflake)

[Analytics Pipeline]:
Redirect events → Kafka → Flink → ClickHouse (analytics DB)
```

### Redirect HTTP Response

```
HTTP/1.1 301 Moved Permanently
Location: https://www.original-long-url.com/path

vs.

HTTP/1.1 302 Found
Location: https://www.original-long-url.com/path
```

**301 (Permanent):** Browser caches the redirect. On repeat visits, browser redirects without hitting our servers. Reduces server load but we lose analytics data.

**302 (Temporary):** Browser always hits our servers. We track every redirect. Use 302 for analytics. Use 301 if you want to offload traffic.

---

## 2. Distributed Rate Limiter

### Requirements

- Limit requests per user: e.g., 100 API calls per minute per user
- Work across multiple API gateway instances (distributed)
- Low latency: < 1ms overhead per request
- Handle Redis failures gracefully (fail open or fail closed?)
- Support multiple limit tiers: free tier (100/min), pro tier (1000/min)

### Architecture

```
[Client]
   |
   ↓
[API Gateway Node 1]  [API Gateway Node 2]  [API Gateway Node 3]
      |                      |                      |
      └──────────────────────┼──────────────────────┘
                             |
                    [Redis Cluster]
                 (shared rate limit state)
```

All API gateway nodes share a Redis cluster. Rate limit decisions are global.

### Sliding Window Log in Redis (Exact)

```lua
-- args: userId, windowSizeMs, limit, now(ms)
local key = "rate:" .. KEYS[1]
local window = tonumber(ARGV[1])
local limit  = tonumber(ARGV[2])
local now    = tonumber(ARGV[3])

-- Remove entries older than window
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)

-- Count current
local count = tonumber(redis.call('ZCARD', key))

if count < limit then
    redis.call('ZADD', key, now, now .. math.random())
    redis.call('PEXPIRE', key, window)
    return {1, limit - count - 1}  -- {allowed, remaining}
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local reset_at = tonumber(oldest[2]) + window
    return {0, 0, reset_at}        -- {rejected, remaining, retry_after}
end
```

```java
@Component
public class SlidingWindowRateLimiter {
    private static final String LUA_SCRIPT = /* above script */;

    public RateLimitDecision check(String userId, int limit, int windowMs) {
        long now = System.currentTimeMillis();
        List<String> keys = List.of(userId);
        List<String> args = List.of(
            String.valueOf(windowMs),
            String.valueOf(limit),
            String.valueOf(now)
        );

        try {
            List<Object> result = redis.execute(
                RedisScript.of(LUA_SCRIPT, List.class), keys, args.toArray());
            long allowed = (Long) result.get(0);
            long remaining = (Long) result.get(1);
            return new RateLimitDecision(allowed == 1, remaining);
        } catch (RedisConnectionFailureException e) {
            // Redis down: fail open (allow request) to avoid blocking all traffic
            log.error("Redis unavailable, allowing request: {}", userId);
            return RateLimitDecision.allowed();
        }
    }
}
```

### Handling Redis Failure

**Fail open:** When Redis is down, allow all requests. Protects against complete outage but temporarily disables rate limiting. Appropriate for non-security-critical rate limiting.

**Fail closed:** When Redis is down, reject all requests. Protects against abuse during Redis outage but kills legitimate traffic. Appropriate for security-sensitive APIs (login endpoint brute force protection).

**Local fallback:** When Redis is down, fall back to per-instance in-memory rate limiting. Gives approximate limiting without full correctness. Good middle ground.

```java
private final Map<String, AtomicInteger> localCounters = new ConcurrentHashMap<>();

RateLimitDecision checkWithFallback(String userId, int limit) {
    try {
        return redisCheck(userId, limit);
    } catch (RedisException e) {
        // Fallback: allow 1/N of limit per instance (N = instance count)
        AtomicInteger counter = localCounters.computeIfAbsent(
            userId, k -> new AtomicInteger(0));
        int count = counter.incrementAndGet();
        return count <= (limit / instanceCount)
            ? RateLimitDecision.allowed()
            : RateLimitDecision.rejected();
    }
}
```

### Clock Skew

Different application servers may have different system times. For ARGV[3] (now timestamp), use Redis server time instead:

```lua
local time = redis.call('TIME')  -- returns {seconds, microseconds}
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
-- now use 'now' instead of client-provided ARGV[3]
```

This eliminates clock skew as a factor. All rate limit decisions use Redis's wall clock.

---

## 3. Distributed Cache

### Cache Topology with Consistent Hashing

**Problem with N-mod sharding:**
With 3 cache nodes, key K goes to node `hash(K) % 3`. Add a 4th node → `hash(K) % 4` → almost all keys on different nodes → cache miss tsunami.

**Consistent hashing solution:** Only ~K/N keys remapped when one node is added/removed (covered in 01-distributed-systems-fundamentals.md).

**Redis Cluster:** Uses 16,384 fixed hash slots (not a ring, but conceptually similar). CRC16(key) % 16384 = slot. Slots are distributed across master nodes. Adding/removing nodes: only affected slots' keys migrate.

### Cache-Aside vs Read-Through vs Write-Through vs Write-Behind

#### Cache-Aside (Lazy Loading)

```
Read:
  1. App checks cache → miss
  2. App queries DB
  3. App writes result to cache
  4. App returns data

Write:
  1. App writes to DB
  2. App invalidates (or updates) cache
```

```java
public User getUser(String userId) {
    String cacheKey = "user:" + userId;
    User cached = redis.get(cacheKey, User.class);
    if (cached != null) return cached;

    User user = userRepository.findById(userId)
        .orElseThrow(UserNotFoundException::new);
    redis.set(cacheKey, user, Duration.ofMinutes(30));
    return user;
}

public void updateUser(User user) {
    userRepository.save(user);
    redis.delete("user:" + user.getId());  // invalidate
}
```

**Pros:** Only caches what's actually needed. Cache failure doesn't block reads (falls back to DB).
**Cons:** Cache miss on first access. Risk of stale data between DB write and cache invalidation.

#### Read-Through

The cache itself is responsible for loading from DB on a miss. Application always talks to cache.

```
App → Cache → DB (on miss)
              ↑ cache handles this transparently
```

**Pros:** Simpler application code. Cache and DB stay in sync (managed by cache layer).
**Cons:** First access is slow (cache miss hits DB). Cache failure = application failure.

#### Write-Through

Every write goes through the cache. Cache writes to DB synchronously.

```
App → Cache → DB (synchronously)
```

**Pros:** Cache always consistent with DB. No stale data risk.
**Cons:** Higher write latency (both cache and DB written on every request). Cache failure = write failure.

#### Write-Behind (Write-Back)

App writes to cache only. Cache asynchronously flushes to DB.

```
App → Cache → (async, batched) → DB
```

**Pros:** Very low write latency (just cache write). Batching DB writes reduces DB load.
**Cons:** Data loss if cache dies before flushing. Complex failure recovery. DB may be temporarily stale (inconsistency window).

**Best choice for most web applications:** Cache-aside for reads, invalidate on writes. Simple, reliable, DB is the system of record.

### Cache Stampede / Thundering Herd

**Problem:** A cache entry expires. Multiple concurrent requests all miss the cache simultaneously, all query the DB, all try to write the same value back.

```
t=0: Cache entry for "trending-products" expires
t=1ms: 100 concurrent requests all see cache miss
       100 requests all query DB simultaneously
       DB overwhelmed by sudden spike
       All 100 requests compute same result and write back to cache
```

#### Solution 1: Mutex Lock (Thundering Herd Shield)

Only one request recomputes; others wait.

```java
public String getTrendingProducts() {
    String cached = redis.get("trending-products");
    if (cached != null) return cached;

    // Try to acquire a "recompute" lock
    boolean locked = redis.setIfAbsent(
        "trending-products:lock", "1", Duration.ofSeconds(30));

    if (locked) {
        try {
            String result = db.computeTrendingProducts();  // expensive
            redis.set("trending-products", result, Duration.ofHours(1));
            return result;
        } finally {
            redis.delete("trending-products:lock");
        }
    } else {
        // Another thread is recomputing — wait and retry
        Thread.sleep(100);
        return getTrendingProducts();  // retry; will likely get cached value
    }
}
```

**Problem:** If the computing thread crashes, the lock expires after 30s (TTL). Other threads wait up to 30s. This is the danger of a lock with no owner-release guarantee.

**Better approach:** Exponential backoff on retry + fallback to stale value.

#### Solution 2: Probabilistic Early Expiration (XFetch Algorithm)

Instead of waiting until expiry, probabilistically recompute before expiry:

```
p(recompute at time t) = exp(-delta / (beta * computeTime))

where:
  delta = time until expiry (seconds remaining)
  beta  = tuning parameter (higher β = more eager recomputation)
  computeTime = how long it takes to recompute (seconds)
```

```java
public String getWithXFetch(String key, Duration ttl) {
    CacheEntry entry = redis.getWithMetadata(key); // returns value + TTL remaining + computeTime
    if (entry == null) return recompute(key, ttl);

    double delta = entry.ttlRemainingSeconds();
    double computeTime = entry.lastComputeTimeSeconds();
    double beta = 1.0;

    // Probabilistic early recomputation
    double now = System.currentTimeMillis() / 1000.0;
    if (now - computeTime * beta * Math.log(Math.random()) >= entry.expiryTimestamp()) {
        // Recompute eagerly in background, serve stale value now
        CompletableFuture.runAsync(() -> recompute(key, ttl));
    }

    return entry.value();
}
```

**Effect:** As expiry approaches, probability of recompute increases. Some requests will recompute slightly before expiry, ensuring the cache is refreshed before it expires. Eliminates the spike of simultaneous misses.

---

## 4. Notification System

### Requirements

- Push notifications (mobile: FCM/APNs)
- Email notifications (marketing, transactional)
- SMS notifications
- In-app notifications (real-time)
- Scale: 1B daily notifications

### Fan-Out Strategies: Write vs Read

The core question when a user generates content (tweet, post): when do you update followers' feeds?

#### Fan-Out on Write (Push Model)

When user A posts, immediately write the post to all of A's followers' notification queues.

```
User A posts → Worker → Write to 1000 followers' notification queues
                         ↓ each follower's queue: [postId, ...]
                        (Kafka topic per user OR Redis sorted set per user)

On follower B reads their feed: read from pre-populated queue → O(1)
```

**Pros:** Read is O(1) — just dequeue from follower's inbox.
**Cons:** Write amplification. Celebrity with 100M followers: posting = 100M writes. During the write storm, notifications are delayed.

**Instagram's approach:** Use write fan-out for users with < 1M followers. For celebrities (> 1M followers), use pull fan-out.

#### Fan-Out on Read (Pull Model)

When follower B opens the app, dynamically fetch all posts from people B follows.

```
B opens app → Query: "get recent posts from all users B follows"
             → Fetch posts from each following's timeline
             → Merge and sort by timestamp
             → Return to B
```

**Pros:** Writes are O(1) — no fan-out needed.
**Cons:** Read is expensive O(following_count) — fan-in at read time. Requires scatter-gather across many users.

#### Hybrid Approach (Instagram/Twitter)

```
Users with < 1M followers: write fan-out
  Post → write to all followers' feeds (pre-computed)

Users with > 1M followers (celebrities): no write fan-out
  Post → just stored in their timeline

Follower's feed generation:
  1. Read pre-computed feed entries
  2. Fetch latest posts from followed celebrities
  3. Merge, sort by timestamp, return top K
```

### Push Notification Architecture (FCM/APNs)

```
[Notification Service]
       |
       |── to Android users → [FCM (Firebase Cloud Messaging)] → Android device
       |
       └── to iOS users ────→ [APNs (Apple Push Notification service)] → iPhone
```

**How FCM works:**
1. Android app on device registers with FCM → receives a device registration token.
2. App sends token to your server (`POST /register-device`).
3. Your server stores `{userId, deviceToken, platform}` in DB.
4. When you want to send a notification: call FCM API with the device token.
5. FCM delivers to the device (handles offline delivery, retries, device wake-up).

**FCM delivery flow:**
```
Your Server ──── FCM API (HTTPS POST) ────→ FCM Servers ────→ Device
                                              (Google infra)
                                              handles:
                                              - delivery if device offline
                                              - collapsing duplicate notifications
                                              - delivery receipts
```

**Key FCM concepts:**
- **Notification message:** Handled by FCM SDK, shown by OS even if app is closed.
- **Data message:** Handled by your app code. App must be running (or in background with allowed background processing). More flexible but requires app integration.
- **Collapse key:** FCM can replace older queued notifications with a newer one (e.g., "3 new messages" → update to "5 new messages").

### Notification Pipeline Architecture

```
[Event Sources] ──→ [Kafka] ──→ [Notification Workers] ──→ [Channel Workers]
  Order placed              (consume events,           Email Worker → SES
  Message received          determine who to           SMS Worker → Twilio
  Friend follows            notify and how)            Push Worker → FCM/APNs
                                   |
                            [User Preference DB]
                            (do they want email?
                             quiet hours? blocked?)
```

**User Preference Check (critical for spam prevention):**
```java
@KafkaListener(topics = "user.events")
public void processEvent(UserEvent event) {
    List<String> recipientIds = recipientService.findRecipients(event);

    for (String userId : recipientIds) {
        UserNotificationPrefs prefs = prefsService.getPrefs(userId);

        if (!prefs.isEmailEnabled()) continue;
        if (prefs.isQuietHour(event.getTimestamp())) continue;
        if (prefs.hasUnsubscribed(event.getType())) continue;

        notificationQueue.enqueue(new Notification(
            userId, event.getType(), event.getPayload(), Channel.EMAIL));
    }
}
```

### Email Delivery: Bounce Handling

Every email provider tracks bounces (email addresses that don't exist or refused delivery).

**Types:**
- **Hard bounce:** Permanent failure. Address doesn't exist. Must immediately remove from mailing list or risk being marked as spam sender.
- **Soft bounce:** Temporary. Mailbox full, server temporarily down. Retry 3x over 24h. If still failing, treat as hard bounce.

```java
// AWS SES bounce webhook handler
@PostMapping("/ses/notification")
public void handleSNSNotification(@RequestBody SESNotification notification) {
    if (notification.getNotificationType().equals("Bounce")) {
        BounceNotification bounce = notification.getBounce();
        for (BouncedRecipient recipient : bounce.getBouncedRecipients()) {
            if (bounce.getBounceType().equals("Permanent")) {
                // Hard bounce — mark as undeliverable
                emailAddressRepo.markUndeliverable(recipient.getEmailAddress());
            } else {
                // Soft bounce — increment retry count
                emailAddressRepo.incrementBounceCount(recipient.getEmailAddress());
            }
        }
    }
}
```

---

## 5. Search Autocomplete

### Requirements

- Return top K suggestions as user types
- Low latency: < 100ms for each keystroke
- Scale: 10M DAU, each typing 10 searches = 100M queries/day
- Personalization: suggestions influenced by user's history (bonus)
- Real-time updates: newly trending terms appear within minutes

### Approach 1: Trie

**Data structure:**
```
Prefix tree for: ["apple", "app", "application", "apply", "apt"]

Root
 └── a
      └── p
           ├── p (count: 1, word: "app")
           │    ├── l
           │    │    └── e (count: 1, word: "apple")
           │    │         └── ...
           │    └── l
           │         └── i (...)
           └── t (count: 1, word: "apt")
```

**Autocomplete with Trie:**
1. Navigate to prefix node in O(len(prefix)).
2. DFS/BFS to collect all descendant words.
3. Return top K by frequency/score.

**Problem:** DFS can be expensive for popular prefixes like "a" (millions of completions). 

**Optimization: Cache top-K at each node:**
```
Each node stores: top_k_completions = [(word, score), ...]

"ap" node: top_k = [("apple", 1000), ("apply", 800), ("app", 500), ("application", 200)]
Lookup for "ap" prefix: O(1) — just return the cached list.
```

Update strategy: Recalculate top-K periodically (batch job) rather than on every new search.

**Trie storage:** For 100M unique query terms at avg 10 chars each = ~1 GB trie (in memory, compressed). Java implementation would need ~3–5 GB with object overhead. Store in a distributed way (Cassandra / Elasticsearch) or use a compact binary trie.

### Approach 2: Redis Sorted Set

For autocomplete, model each prefix as a sorted set where score = search frequency.

```
Key: "autocomplete:ap"
Members: {
  "apple":       1000 (score = search count)
  "apply":        800
  "app":          500
  "application":  200
}

ZREVRANGE autocomplete:ap 0 9 → top 10 suggestions for prefix "ap"
```

**Building the sorted sets:**
```python
# For each search query "apple":
for i in range(1, len(query)+1):
    prefix = query[:i]  # "a", "ap", "app", "appl", "apple"
    redis.zincrby("autocomplete:" + prefix, 1, query)
```

**Problem:** 100M unique queries * 10 avg length = 1B Redis sorted set entries. Too expensive.

**Solution: Only keep top N prefixes** (most commonly typed ones). Use a frequency threshold.

**Or:** Use a single sorted set with a lexicographic prefix trick (Antirez's approach):
```
ZADD suggestions 0 "apple:"    ← score=0, lex order used
ZADD suggestions 0 "apply:"
ZADD suggestions 0 "apt:"

ZRANGEBYLEX suggestions "[ap" "[ap\xff" LIMIT 0 10
→ returns all members between "ap" and "ap" + max char
→ returns: "apple:", "apply:", "apt:"
```

Separate sorted set with scores for ranking. This separates prefix indexing from scoring.

### Approach 3: Elasticsearch Completion Suggester

Elasticsearch has a dedicated `completion` field type optimized for autocomplete:

```json
PUT /queries
{
  "mappings": {
    "properties": {
      "suggest": {
        "type": "completion"
      },
      "query_text": {"type": "keyword"},
      "search_count": {"type": "long"}
    }
  }
}
```

**Indexing:**
```json
PUT /queries/_doc/1
{
  "suggest": {
    "input": ["apple", "apple iphone", "apple watch"],
    "weight": 1000  // score/weight
  },
  "query_text": "apple",
  "search_count": 1000
}
```

**Querying:**
```json
POST /queries/_search
{
  "suggest": {
    "text": "ap",
    "autocomplete": {
      "completion": {
        "field": "suggest",
        "size": 10,
        "skip_duplicates": true
      }
    }
  }
}
```

**How Elasticsearch completion works internally:**
- Builds a Finite State Transducer (FST) — a compressed trie stored in the Lucene index.
- FST is loaded into memory (off-heap, via mmap).
- Prefix lookup is O(len(prefix)) with very low constant.
- No JVM GC overhead (off-heap).

**Edge n-gram approach** (alternative — more flexible but uses more storage):
```json
"settings": {
  "analysis": {
    "analyzer": {
      "autocomplete_analyzer": {
        "tokenizer": "autocomplete_tokenizer"
      }
    },
    "tokenizer": {
      "autocomplete_tokenizer": {
        "type": "edge_ngram",
        "min_gram": 1,
        "max_gram": 20,
        "token_chars": ["letter", "digit"]
      }
    }
  }
}
```

"apple" → tokens: "a", "ap", "app", "appl", "apple"

Any standard match query on these tokens achieves autocomplete. More flexible (supports fuzzy, phrase queries) but uses more index storage.

### Architecture for Autocomplete

```
[User keystroke]
      |
      ↓
[CDN Cache / Edge]  ← Cache common prefixes at edge
      |
      | cache miss
      ↓
[Autocomplete Service]
      |
      ├─→ [Redis] ← Top-K cache per prefix (hot prefixes: "the", "how", etc.)
      |
      └─→ [Elasticsearch Cluster] ← Full prefix search

[Trending Updater Job] (runs every 5 minutes):
  Kafka (search events) → Flink (aggregate counts by query) → Elasticsearch (update weights)
                                                             → Redis (update hot prefixes)
```

**Cache warming:** Popular prefixes ("a", "the", "how to") are known in advance. Pre-warm Redis with top suggestions for these on deployment.

**Real-time updates:** Don't update Elasticsearch on every search (too expensive). Batch aggregate search counts with Flink, push updates every 5 minutes.

---

## 6. Consistent Key-Value Store (Like DynamoDB/Cassandra)

This is the "design DynamoDB or Cassandra from scratch" question.

### Data Partitioning: Consistent Hashing

Token ring with virtual nodes (covered in detail in file 01):
```
Physical nodes: N1, N2, N3, N4
Each node gets 256 virtual tokens on a 2^64 ring.
Key K: hash → token position → walk clockwise → responsible node.
```

### Replication: Quorum Reads/Writes

**Quorum configuration:**
- N = total replicas (replication factor)
- W = number of nodes that must acknowledge a write
- R = number of nodes that must respond to a read

**Consistency condition:** `W + R > N`

This ensures the read quorum and write quorum always overlap by at least 1 node.

```
N=3, W=2, R=2: W+R=4 > 3 → consistent
  Write to nodes A, B (2/3 acknowledge)
  Read from nodes B, C (2/3 respond)
  At least node B is in both groups → B has the latest write

N=3, W=1, R=3: W+R=4 > 3 → consistent (but R=3 means read all nodes, expensive)
N=3, W=3, R=1: W+R=4 > 3 → consistent (but W=3 means write must reach all, less available)
N=3, W=2, R=1: W+R=3 = 3 → NOT strictly consistent (possible miss)
N=3, W=1, R=1: W+R=2 < 3 → eventual consistency only
```

**Common configurations:**
- Strong consistency: W=N/2+1, R=N/2+1 (quorum on both sides)
- Eventual consistency: W=1, R=1 (maximum availability, some staleness)
- Write-heavy: W=1, R=N (fast writes, slower reads that guarantee seeing latest)

### Sloppy Quorum and Hinted Handoff

**Normal quorum:** If a required node is down, write fails.

**Sloppy quorum:** If node A is down, write to next available node (node D) with a hint: "this data belongs to A."

When node A recovers, node D forwards the hinted data to A. This is **hinted handoff**.

```
Normal: Key K should go to replicas A, B, C
        A is down → strict quorum fails the write

Sloppy quorum: Write to B, C, D (D is not a permanent home for K)
               D stores {key: K, hint: "send to A when it recovers"}
               A recovers → D sends hint to A → A gets the write
```

**DynamoDB uses sloppy quorum:** Always available, but consistency is temporarily sacrificed during node failures. Data is healed via hinted handoff afterward.

**Cassandra uses sloppy quorum** for `ANY` consistency level. With `QUORUM`, strict quorum is used.

### Write Path (Cassandra-Style)

```
Client → Any node (coordinator)
              |
              |── Hash(partition_key) → finds responsible nodes
              |
              |──→ Node A (replica 1)
              |──→ Node B (replica 2)
              |──→ Node C (replica 3)
              
Each node:
  1. Write to commit log (WAL, sequential write — fast)
  2. Write to memtable (in-memory sorted structure)
  3. Return ACK when both succeed
  
  Background (async):
  4. When memtable reaches threshold → flush to SSTable (disk)
  5. Compaction: merge SSTables, remove tombstones
```

**Why commit log first?** Durability. If the process crashes after writing to commit log but before memtable, the commit log is replayed on startup to reconstruct the memtable.

**Why memtable before SSTable?** SSTables are immutable. You can't update them in place. Writes go to memtable (RAM, sorted), then batched to disk as immutable SSTables. This gives very high write throughput (mostly sequential I/O).

### Read Path

```
Client → Coordinator
           |
           |── Check row cache (optional, per-row)
           |── Check key cache (bloom filter)
           |
           |──→ Node A → check memtable → check SSTable (newest to oldest)
           |──→ Node B → same
           
           Compare versions (using timestamps / vector clocks)
           Return newest version
           
           If read repair: if A returned v1, B returned v2 → send v2 to A (async)
```

**Bloom filters:** Each SSTable has a bloom filter. A bloom filter answers "might this key be in this SSTable?" with zero false negatives. This avoids reading SSTables that definitely don't have the key. Typical false positive rate: 1%.

**Read repair:** During a read, if replicas return different versions, the coordinator:
1. Returns the latest version to the client.
2. Asynchronously sends the latest value to nodes that returned stale values.
3. This is "read repair" — convergence triggered by reads.

### Conflict Resolution: LWW vs Vector Clocks

**Last-Write-Wins (LWW):** Each write tagged with timestamp. Latest timestamp wins on conflict.

- Simple to implement.
- Risk: clock skew causes data loss. Server A's clock is 50ms ahead. Write to B looks "older" even if logically it happened after A's write.
- DynamoDB (in its simplest mode) uses LWW.

**Vector clocks (Riak/Dynamo original):** Detect concurrent writes, resolve by returning both values (siblings) and letting the application reconcile.

- More complex but no data loss on concurrent writes.
- Original Dynamo paper described this. DynamoDB simplified to LWW for ease of use.
- Riak uses vector clocks.

### Anti-Entropy: Merkle Trees

How do nodes reconcile data during network healing? Comparing every key would take forever.

**Merkle tree:** A hash tree where each leaf is the hash of a data block, and each non-leaf is the hash of its children.

```
Root Hash = H(H(H(A,B), H(C,D)), H(H(E,F), H(G,H)))

       [Root]
      /       \
   [H(1-4)]  [H(5-8)]
   /    \     /    \
[H(A,B)][H(C,D)][H(E,F)][H(G,H)]
 / \   / \   / \   / \
A   B C   D E   F G   H
```

**Anti-entropy with Merkle trees:**
1. Node A and Node B each build a Merkle tree of their data.
2. They exchange root hashes.
3. If roots differ, compare subtrees level by level.
4. Find the exact leaf (data range) where they differ.
5. Exchange only the differing data.

This turns a "compare all data" problem into O(log N) comparisons to find divergent sections.

Cassandra uses Merkle trees for its anti-entropy repair operation (`nodetool repair`).

---

## 7. Twitter/Instagram Feed

### Requirements

- Users follow other users
- Timeline: see recent posts from followees, sorted by time
- Scale: 300M DAU, 500M tweets/day
- Timeline load < 100ms
- Celebrity support: users with 100M+ followers

### Fan-Out Strategies (Detailed)

#### Approach: Write Fan-Out (Push Model)

```
User A (10,000 followers) posts tweet T:
  
  1. Store tweet T in tweets table
  2. Fan-out job:
     for each follower of A:
         INSERT INTO user_feed (user_id=follower, tweet_id=T.id, timestamp=T.ts)
  
  10,000 followers * 1 write = 10,000 writes
  Each write: Redis sorted set ZADD (O(log N))
```

**Timeline read:**
```
User B opens timeline:
  1. ZREVRANGE user_feed:B 0 19  ← get 20 most recent tweet IDs
  2. MGET tweets: tweet IDs → fetch tweet content (batch)
  3. Return
```

Read is O(1) — just read pre-computed list.

**Problem:** Celebrity with 10M followers posts → 10M writes immediately. This is a write storm.

Twitter's 2012 post about the Lady Gaga problem: Lady Gaga had 31M followers. A tweet from her triggered 31M feed insertions. At peak: 300,000 writes/second just from one tweet.

#### Approach: Pull Fan-Out (Read Merge)

```
User B opens timeline:
  1. Get list of B's followees from follow table
  2. For each followee: fetch their recent tweets (sorted by time)
  3. Merge N sorted lists into one
  4. Return top 20
```

Write is O(1). Read is O(following_count * tweets_per_followee).

**Problem:** If B follows 2000 people, reading timeline requires 2000 range queries and a merge. Even with caching, this is expensive per-load.

#### Hybrid Approach (Twitter's Production Architecture)

```
Regular users (< 1M followers): write fan-out
  - Tweet stored + pushed to followers' Redis timelines
  - Twitter calls these "user timelines" (pre-computed)
  
Celebrities (> 1M followers, "snowflakes"): NO write fan-out
  - Tweet stored, nothing pushed to followers
  - Called "light users" for the fan-out system
  
Timeline generation for User B:
  1. Fetch B's pre-computed timeline from Redis (fast)
  2. For each celebrity B follows: fetch their recent tweets from their own timeline
  3. Merge the two streams, sort by timestamp
  4. Cache result for B (for ~60 seconds)
```

```java
public List<Tweet> getTimeline(String userId, int page, int pageSize) {
    // Step 1: Get pre-computed timeline (fan-out tweets from regular users)
    List<Long> tweetIds = redis.zrevrange(
        "timeline:" + userId,
        page * pageSize,
        (page + 1) * pageSize - 1
    );

    // Step 2: Get followed celebrities
    List<String> celebrities = followRepository.getCelebrities(userId);

    // Step 3: Fetch recent tweets from celebrities (last 24h)
    List<Tweet> celebrityTweets = tweetRepository.findRecentByUsers(
        celebrities,
        Instant.now().minus(24, HOURS)
    );

    // Step 4: Fetch full tweet objects for pre-computed IDs
    List<Tweet> fanoutTweets = tweetRepository.findByIds(tweetIds);

    // Step 5: Merge and sort
    List<Tweet> merged = Stream.concat(
        fanoutTweets.stream(),
        celebrityTweets.stream()
    )
    .sorted(Comparator.comparing(Tweet::getCreatedAt).reversed())
    .distinct()
    .limit(pageSize)
    .collect(toList());

    return merged;
}
```

### Storage Architecture

#### Tweets Table (Cassandra)

```cql
CREATE TABLE tweets (
    tweet_id    BIGINT PRIMARY KEY,  -- Snowflake ID
    user_id     UUID,
    content     TEXT,
    media_ids   LIST<UUID>,
    created_at  TIMESTAMP,
    like_count  COUNTER,             -- in separate table
    reply_to    BIGINT               -- for threading
);
```

**Partitioning by tweet_id (Snowflake):** Snowflake IDs are time-ordered, but their hash distributes writes across nodes. Works well for Cassandra's consistent hashing.

#### User Timeline (Redis Sorted Set)

```
Key: "timeline:{user_id}"
Value: sorted set of tweet_ids
Score: tweet timestamp (Unix milliseconds)

ZADD timeline:user123 1714500000000 tweet456  (O(log N))
ZREVRANGE timeline:user123 0 49              (O(log N + K))
ZREMRANGEBYRANK timeline:user123 0 -5001    (trim to last 5000 tweets)
```

**Memory:** Each user's timeline is a Redis sorted set. Per entry: ~80 bytes (tweet_id + score + sorted set overhead). 5000 entries * 80 bytes = 400KB per user. 300M DAU * 400KB = 120TB (too large for Redis!).

**Optimization:** Only keep timelines for *active* users in Redis. Users who haven't logged in for 30 days get their timeline evicted. On login, rebuild from scratch by doing a pull fan-out.

#### Follow Graph

```sql
-- High-read, low-write. Denormalize both directions.
CREATE TABLE followers (
    user_id       BIGINT NOT NULL,
    follower_id   BIGINT NOT NULL,
    created_at    TIMESTAMP,
    PRIMARY KEY (user_id, follower_id)  -- compound: look up all followers of user_id
);

CREATE TABLE following (
    user_id       BIGINT NOT NULL,
    following_id  BIGINT NOT NULL,
    PRIMARY KEY (user_id, following_id)  -- look up all users that user_id follows
);
```

For celebrities, the followers table has 100M rows per celebrity. Can't load all at once for fan-out. Use batch processing: chunk followers into groups of 10,000, fan out asynchronously via Kafka.

### Fan-Out Implementation with Kafka

```java
@Service
public class TweetFanOutService {
    
    @KafkaListener(topics = "new-tweets")
    public void fanOut(TweetEvent event) {
        String authorId = event.getUserId();
        
        // Skip fan-out for celebrities (handled at read time)
        if (userService.isCelebrity(authorId)) return;

        // Batch fetch followers (paginated)
        int offset = 0;
        while (true) {
            List<String> followerBatch = followerRepository
                .findFollowers(authorId, offset, 1000);
            
            if (followerBatch.isEmpty()) break;

            // Batch insert into Redis using pipeline
            try (var pipeline = redis.pipelined()) {
                for (String followerId : followerBatch) {
                    pipeline.zadd(
                        "timeline:" + followerId,
                        event.getTimestamp(),
                        event.getTweetId()
                    );
                    // Trim to last 5000 entries
                    pipeline.zremrangeByRank(
                        "timeline:" + followerId, 0, -5001);
                }
                pipeline.sync();
            }

            offset += 1000;
            if (followerBatch.size() < 1000) break;
        }
    }
}
```

**Kafka for fan-out:** The tweet event is published to Kafka. Multiple fan-out consumer instances process different users' tweets in parallel. Natural horizontal scaling.

---

## Design Summary Matrix

| Problem | Key Design Choice | Primary Storage | Cache Layer | Scale Bottleneck |
|---------|------------------|-----------------|-------------|-----------------|
| URL Shortener | Hash/Snowflake ID | Cassandra | Redis (hit rate >99%) | Read throughput |
| Rate Limiter | Sliding window in Lua | Redis | N/A (Redis IS the store) | Redis write throughput |
| Distributed Cache | Consistent hashing | Redis Cluster | CDN for top % | Hot keys |
| Notification | Kafka fan-out | Cassandra (events) | Redis (preferences) | Fan-out for celebrities |
| Autocomplete | Edge n-grams / FST | Elasticsearch | Redis (hot prefixes) | Write (trend updates) |
| Key-Value Store | Sloppy quorum + LSM | SSTable (Cassandra-like) | Row cache / key cache | Write amplification during compaction |
| Feed | Hybrid push/pull | Cassandra (tweets) + Redis (timelines) | Redis sorted sets | Celebrity fan-out |

---

Sources consulted:
- [Consistent Hashing Explained - Algomaster](https://blog.algomaster.io/p/consistent-hashing-explained)
- [Cassandra Dynamo Architecture](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html)
- [Resilience4j CircuitBreaker](https://resilience4j.readme.io/docs/circuitbreaker)
- [Saga Pattern - Microservices.io](https://microservices.io/patterns/data/saga.html)
- [CQRS Pattern - Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
