# Redis & Elasticsearch Internals — Deep Technical Reference

> Target: Senior Java/systems engineer. 40 LPA system design interviews.

---

# PART 1 — REDIS

---

## 1. Data Structure Internals

### 1.1 SDS — Simple Dynamic String

Redis never uses C's null-terminated `char*` for strings. Instead, it uses **SDS (Simple Dynamic String)**:

```c
struct sdshdr {
    int len;      // actual string length (O(1) STRLEN)
    int free;     // unused allocated space
    char buf[];   // actual bytes (+ null terminator for C compat)
};
```

**Why SDS**:
- O(1) `STRLEN` — `len` field (vs O(N) strlen in C)
- Binary safe — can store arbitrary bytes including `\0` (vs C strings)
- No buffer overflow — SDS tracks allocation, auto-expands
- Amortized O(1) append — `free` space avoids realloc on every append

Every Redis key and string value is an SDS.

### 1.2 String Encoding — 3 Internal Types

```
SET mykey 12345
→ ENCODING = OBJ_ENCODING_INT (stores as long, not SDS, if value fits in long)

SET mykey "hello"   (len <= 44 bytes)
→ ENCODING = OBJ_ENCODING_EMBSTR (SDS + robj in single allocation, no pointer follow)

SET mykey "long string > 44 chars..."
→ ENCODING = OBJ_ENCODING_RAW (separate robj + SDS allocation)
```

`OBJECT ENCODING mykey` → inspect current encoding.

### 1.3 List — Quicklist

A list is a **quicklist**: a doubly-linked list of **listpack** (formerly ziplist) nodes.

```
quicklist node 1       quicklist node 2      quicklist node 3
[listpack: e1,e2,e3] <-> [listpack: e4,e5,e6] <-> [listpack: e7]
```

**Listpack** (Redis 7.0 replacement for ziplist): a flat memory blob encoding elements contiguously. Each entry has a back-length field for O(1) backward traversal. Very cache-friendly for small sets of items.

Config: `list-max-listpack-size 128` (max elements per quicklist node). When node exceeds limit, it's split.

### 1.4 Hash — Listpack or Hashtable

**Small hash** (default: <= 128 fields, each field/value <= 64 bytes):
```
→ OBJ_ENCODING_LISTPACK: flat listpack encoding [k1,v1,k2,v2,k3,v3,...]
   Memory: O(N), no per-key overhead; very compact
```

**Large hash** (exceeds thresholds):
```
→ OBJ_ENCODING_HT: standard hash table (chaining)
   Memory: 64 bytes per entry minimum + SDS overhead
```

Transition is automatic and irreversible (once converted to HT, stays HT even if elements removed below threshold).

### 1.5 Set — Intset, Listpack, or Hashtable

```
Small set of integers: OBJ_ENCODING_INTSET
  → sorted array of int64, binary searchable, ultra compact

Small set of mixed types (≤128 members, each ≤64B): OBJ_ENCODING_LISTPACK

Large set: OBJ_ENCODING_HT (hashtable with dummy values)
```

**Intset** stores integers sorted → supports O(log N) lookup via binary search. Dramatically smaller than a hashtable for integer sets.

### 1.6 Sorted Set (ZSet) — Skiplist + Hashtable

The most complex data structure in Redis. Uses **dual encoding**:

**Small ZSet** (≤128 members, each ≤64B):
```
OBJ_ENCODING_LISTPACK: sorted by score, flat encoding
```

**Large ZSet**:
```
OBJ_ENCODING_SKIPLIST: two structures maintained together

1. Skip list — for O(log N) score-ordered operations:
   ZRANGE, ZRANGEBYSCORE, ZRANK (by score traversal)

2. Hashtable — for O(1) member operations:
   ZSCORE, ZRANK (by member lookup), ZADD (check existing member)
```

**Why dual?** Skiplist alone: O(N) for member lookup. Hashtable alone: O(N) for range by score. Together: O(1) member ops + O(log N) score-ordered ops.

### 1.7 Skip List Structure

```
Level 4: [HEAD] -----------------------------------------> [TAIL]
Level 3: [HEAD] ---------> [score:30] -----------------> [TAIL]
Level 2: [HEAD] -> [s:10] -> [s:30] -> [s:50] ---------> [TAIL]
Level 1: [HEAD] -> [s:10] -> [s:20] -> [s:30] -> [s:40] -> [s:50] -> [TAIL]
```

Each node has:
- `double score` — sort key
- `sds element` — member name (SDS)
- `struct skiplistNode *backward` — pointer to previous node at level 0
- `struct skiplistLevel { forward pointer, span }[]` — per level

**Span**: number of nodes skipped by a forward pointer at this level. Used to calculate `ZRANK` in O(log N): traverse levels, sum spans.

**Level assignment**: probabilistic (p=0.25 in Redis). Each level L has `ZSKIPLIST_MAXLEVEL = 64` maximum. On insertion, a random level is chosen.

**Why skiplist instead of balanced BST (AVL/Red-Black)?**
- Redis author's reasoning: simpler to implement, similar O(log N) performance, cache-friendlier in practice for the range operations Redis needs
- ZRANGEBYSCORE is O(log N + M) on a skiplist; similar on a BST but skiplist's level-0 traversal is a simple forward linked list scan

### 1.8 HyperLogLog

Estimates the cardinality (unique element count) of a set using O(1) memory (~12KB per HLL, regardless of data set size).

```
PFADD visits "user1" "user2" "user3" ...
PFCOUNT visits
→ Returns estimated unique count with ~0.81% standard error
```

**Algorithm** (HyperLogLog++): hash each element → observe longest run of leading zeros in hash → use as estimator of total unique count. Multiple hash registers reduce variance. Merge registers from multiple nodes: `PFMERGE`.

**Use cases**: unique visitor counts, A/B test reach, approximate analytics — where you accept 1% error for 1000x memory savings over a Set.

---

## 2. Memory Encoding Optimizations

Automatic encoding transitions — Redis silently upgrades encoding when thresholds are exceeded:

```
hash-max-listpack-entries 128   → encode as listpack up to 128 fields
hash-max-listpack-value    64   → encode as listpack if all values ≤ 64 bytes
zset-max-listpack-entries 128
zset-max-listpack-value    64
set-max-intset-entries    512   → intset up to 512 integers
set-max-listpack-entries  128
list-max-listpack-size    128
```

**Memory impact is dramatic**: a hash with 100 small fields stored as a listpack uses ~1KB; as a hashtable it uses ~10-20KB. Encoding-aware data modeling can reduce Redis RAM by 5-10x.

```
# Check encoding
OBJECT ENCODING mykey

# Memory usage
MEMORY USAGE mykey   → bytes including key, value, and all overhead
```

---

## 3. Persistence

### 3.1 RDB — Redis DataBase Snapshot

Point-in-time snapshot of the entire dataset written to disk.

**BGSAVE process**:
1. `fork()` creates a child process (copy-on-write semantics)
2. Parent continues serving requests
3. Child writes entire dataset to a temp `.rdb` file
4. On completion, atomic rename replaces the old `.rdb`

**Copy-on-write**: parent and child share the same memory pages after fork. When parent writes a page (serving a request), the OS copies that page for the child. In write-heavy workloads, BGSAVE can double memory usage temporarily (child keeps all original pages).

```
save 900 1       # save if at least 1 key changed in 900 seconds
save 300 10      # save if at least 10 keys changed in 300 seconds
save 60 10000    # save if at least 10000 keys changed in 60 seconds
dbfilename dump.rdb
```

**RDB advantages**: compact file, fast restart, good for backups.
**RDB disadvantages**: data between last snapshot and crash is lost (RPO = snapshot interval).

### 3.2 AOF — Append-Only File

Log every write command:
```
*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
```

**fsync strategies** (`appendfsync`):
| Strategy | Durability | Performance |
|----------|-----------|-------------|
| `always` | Every write fsynced | Maximum durability; very slow (disk-bound) |
| `everysec` | fsync every second | At most 1 second data loss on crash; recommended |
| `no` | OS decides when to flush | Fastest; unpredictable data loss |

**AOF rewrite**: over time, AOF grows large (many SET + DEL for same key). `BGREWRITEAOF` forks a child that writes a compact new AOF (current state only), then atomically replaces the old AOF.

```
auto-aof-rewrite-percentage 100    # rewrite when AOF doubles in size
auto-aof-rewrite-min-size 64mb     # minimum AOF size before considering rewrite
```

**AOF advantages**: better durability (max 1s loss with `everysec`); human-readable; resilient to corruption (partial writes can be truncated and replayed).
**AOF disadvantages**: larger files; slower restart (replay all commands).

### 3.3 Hybrid Persistence (Redis 4.0+)

```
aof-use-rdb-preamble yes
```

AOF file starts with an RDB snapshot (for fast load), followed by incremental AOF commands since the snapshot. Best of both worlds: fast restart + near-zero data loss.

---

## 4. Replication

### 4.1 Full Resync

1. Replica connects to master, sends `PSYNC <replication_id> <offset>`
2. If master doesn't recognize replication_id (new replica or after failover):
   - Master forks, creates RDB snapshot (BGSAVE)
   - Buffers new write commands in **replication backlog buffer** while RDB is being created
   - Sends RDB to replica → replica loads it
   - Sends buffered commands to replica

### 4.2 Partial Resync (PSYNC)

If replica reconnects after a brief disconnect:
1. Replica sends `PSYNC <replication_id> <last_offset>`
2. Master checks if `last_offset` is still in replication backlog (circular buffer)
3. If yes: send only the delta → **partial resync** (avoids full RDB transfer)
4. If no (backlog overflowed): full resync required

```
repl-backlog-size 1mb      # Increase if replicas frequently lag and require full sync
repl-backlog-ttl 3600       # Release backlog memory after this many seconds with no replicas
```

**Replication backlog too small** = frequent full resyncs = high bandwidth + master CPU spikes. Size it to cover `lag_time × write_rate`.

### 4.3 Replication Topology

```
Master → Replica 1 (can itself be a master to Replica 1.1, 1.2 — cascading)
       → Replica 2
       → Replica 3
```

Redis replicas are **async** by default — no built-in sync replication. `WAIT n_replicas timeout_ms` blocks until N replicas acknowledge a write.

---

## 5. Redis Cluster

### 5.1 Hash Slots

```
16384 total hash slots (not consistent hashing ring)

HASH_SLOT = CRC16(key) mod 16384
```

**Why 16384 (not 65536 or larger)?**
- Cluster heartbeat messages contain a bitmap of slot ownership: 16384 slots = 2KB bitmap (fits in a packet); 65536 slots = 8KB bitmap (too large for heartbeats)
- 16384 slots is sufficient for ~1000 master nodes (practical limit)

```
Node A: slots 0-5460
Node B: slots 5461-10922
Node C: slots 10923-16383
```

### 5.2 Hash Tags for Multi-Key Operations

Problem: `MSET user:1:name "Alice" user:1:email "alice@example.com"` — the two keys may hash to different slots on different nodes → cross-slot operation → error in cluster mode.

**Hash tags**: `{...}` in key name → only the bracketed part is hashed:
```
{user:1}:name  → CRC16("user:1") mod 16384 → always same slot
{user:1}:email → CRC16("user:1") mod 16384 → same slot as above
```

Now both keys are on the same node. Atomic operations (MULTI/EXEC, Lua scripts) work across keys in the same slot.

### 5.3 Cluster Bus — Gossip Protocol

Each node maintains a **cluster bus** (separate TCP port: `data_port + 10000`). Used for:
- Heartbeats (PING/PONG every second between random node pairs)
- Failure detection (if a node doesn't respond to PING within `cluster-node-timeout`, it's marked PFAIL)
- Configuration propagation (slot ownership, epoch changes)
- Pub/Sub forwarding across cluster

Gossip is **eventually consistent** — configuration changes propagate gradually.

### 5.4 Failover

1. Primary node stops responding → other nodes mark it PFAIL
2. When majority marks it PFAIL → it becomes FAIL
3. A replica of the failed primary calls for an election:
   - Replica sends `FAILOVER_AUTH_REQUEST` to all primaries
   - Primaries vote (only one replica per primary wins; highest replication offset wins tie-break)
   - Replica with majority votes promotes itself to primary, increments config epoch
4. Cluster topology updated via gossip

**Limitations of Redis Cluster**:
- Multi-key operations only work if all keys are in the same hash slot
- No cross-slot transactions
- Lua scripts must target keys in the same slot (`KEYS` list must declare all accessed keys)
- Maximum of ~1000 master nodes (practical guideline, not hard limit)

---

## 6. Lua Scripting

### 6.1 Atomicity Guarantee

`EVAL script numkeys key [key ...] arg [arg ...]` executes atomically. Redis is single-threaded for command processing — a Lua script runs to completion without any other commands interleaved.

```
EVAL "
  local current = redis.call('GET', KEYS[1])
  if current == false or tonumber(current) < tonumber(ARGV[1]) then
    redis.call('SET', KEYS[1], ARGV[1])
    return 1
  end
  return 0
" 1 mykey 100
```

**Why EVAL is atomic**: Redis event loop processes one command at a time. During EVAL execution, the event loop is blocked. No other client can execute commands until the script finishes.

**Caveats**: a long-running Lua script blocks all other clients. `lua-time-limit` (5000ms) kills the script if exceeded.

### 6.2 EVALSHA — Script Caching

`SCRIPT LOAD` uploads script and returns SHA1. `EVALSHA sha1 numkeys ...` runs without re-sending the script body. Saves bandwidth for large scripts.

---

## 7. Redis as a Queue

### 7.1 List-Based Queue (Simple)

```
Producer: LPUSH queue job1 job2 job3
Consumer: BRPOP queue 30   (blocking pop, 30s timeout)
```

**BRPOP**: blocking right pop — consumer blocks until an item is available or timeout expires. No busy-waiting.

**Reliability problem**: if consumer crashes after BRPOP but before processing, the job is lost. Solution: reliable queue pattern using `RPOPLPUSH`:
```
BRPOPLPUSH queue processing_list 30  (atomic: pop from queue, push to processing list)
// On crash recovery: items in processing_list are in-flight; can be requeued
```

### 7.2 Redis Streams (XADD/XREAD)

Redis Streams (5.0+) provide persistent, consumer-group-aware message streams.

```
XADD mystream * field1 value1 field2 value2
→ Returns message-id: "1673000000000-0" (milliseconds-sequencenum)

XREAD COUNT 100 STREAMS mystream 0    (read from beginning)
XREAD BLOCK 0 STREAMS mystream $      (block for new messages)

// Consumer groups:
XGROUP CREATE mystream mygroup $ MKSTREAM
XREADGROUP GROUP mygroup consumer1 COUNT 10 STREAMS mystream >
XACK mystream mygroup messageId         (acknowledge processing)
```

**Consumer groups** provide at-least-once delivery with acknowledgment. Unacknowledged messages stay in the PEL (Pending Entry List) and can be re-claimed.

**Streams vs Lists**:
| | List | Stream |
|--|------|--------|
| Fan-out | No | Yes (multiple consumer groups) |
| Message history | Lost after pop | Retained (configurable `MAXLEN`) |
| Consumer groups | No | Yes |
| Ordering | FIFO | Ordered by ID |
| Persistence | Via AOF/RDB | Via AOF/RDB |

---

## 8. Common Patterns

### 8.1 Cache-Aside (Lazy Loading)

```java
String value = redis.get(key);
if (value == null) {
    value = db.query(key);      // cache miss: load from DB
    redis.setex(key, ttl, value); // populate cache
}
return value;
```

**Read: cache miss → DB hit → populate cache → serve**
**Write: update DB, then delete/update cache key**

**Thundering herd**: many cache misses for same key simultaneously → many DB queries. Fix: mutex/semaphore on cache miss, or probabilistic early expiry (`PER` algorithm).

### 8.2 Write-Through Cache

Every DB write also writes to cache atomically:
```java
db.update(key, value);
redis.set(key, value);   // always up-to-date cache
```

**Advantage**: cache always fresh. **Disadvantage**: every write hits both DB and cache; cache fills with data that may never be read.

### 8.3 Write-Behind (Write-Back)

Write to cache → async flush to DB later. Lower write latency but risk of data loss on cache failure before flush.

### 8.4 Distributed Locking — Redlock and Controversies

**Single-node Redis lock**:
```
SET lock_key lock_value NX PX 30000   (atomic: SET if not exists, expire in 30s)
// On release (only if we own the lock):
if GET lock_key == lock_value:
    DEL lock_key
// Must use Lua script for atomic check-and-delete:
EVAL "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" 1 lock_key lock_value
```

**Redlock** (for HA with multiple Redis nodes):
1. Get current time T1
2. Try to acquire lock on N/2+1 out of N Redis nodes (with timeout)
3. Lock valid only if acquired on majority AND elapsed time < lock TTL
4. On release: release lock on all nodes

**Controversies** (Martin Kleppmann vs Salvatore Sanfilippo debate):
- **Kleppmann argues**: Redlock does not guarantee safety under clock skew. If clock on a Redis node jumps forward, the lock may expire prematurely on that node even if other nodes still hold it. Additionally, GC pauses in the lock-holding process can exceed the lock TTL silently.
- **Sanfilippo argues**: In practice, clock skew is bounded and GC pauses are rare; Redlock is sufficient for most use cases.
- **Conclusion for interviews**: Redlock is "good enough" for efficiency-based locks (prevent duplicate work), NOT for correctness-based locks (prevent data corruption). For correctness, use fencing tokens (database-level versioning) in addition.

### 8.5 Rate Limiting

```lua
-- Sliding window rate limiter using sorted set
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])   -- seconds
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window * 1000)
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
    redis.call('ZADD', KEYS[1], now, now)
    redis.call('EXPIRE', KEYS[1], window)
    return 1  -- allowed
end
return 0  -- rate limited
```

**Token bucket** using Redis (simpler): store last_refill_time + current_tokens, update atomically with Lua.

---

# PART 2 — ELASTICSEARCH

---

## 9. Inverted Index

### 9.1 Text Analysis Pipeline

Before indexing, text goes through an **analyzer**:

```
Input: "The Quick Brown Fox Jumps Over The Lazy Dog"

Tokenizer: ["The", "Quick", "Brown", "Fox", "Jumps", "Over", "The", "Lazy", "Dog"]
Token filters:
  lowercase: ["the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog"]
  stopwords: ["quick", "brown", "fox", "jumps", "lazy", "dog"]
  stemmer: ["quick", "brown", "fox", "jump", "lazi", "dog"]

Result stored in inverted index: ["quick","brown","fox","jump","lazi","dog"]
```

Custom analyzers:
```json
{
  "analysis": {
    "analyzer": {
      "my_analyzer": {
        "tokenizer": "standard",
        "filter": ["lowercase", "stop", "snowball"]
      }
    }
  }
}
```

### 9.2 Inverted Index Structure

```
Term Dictionary (B-Tree, sorted):
  "brown"   → Postings: [(doc1, tf=1, pos=[3]), (doc5, tf=2, pos=[1,7])]
  "fox"     → Postings: [(doc1, tf=1), (doc3, tf=1)]
  "jump"    → Postings: [(doc1, tf=1), (doc2, tf=3)]

  Also stored per term: df (document frequency) for IDF calculation
```

**Term dictionary**: sorted, enables prefix/range queries. Backed by an FST (Finite State Transducer) in Lucene — extremely compact.

**Postings list**: for each term, sorted list of (docID, term_frequency, [positions]). Positions enable phrase queries (`"quick brown fox"`).

**Doc values**: column-oriented storage for aggregations and sorting on keyword/numeric fields. Separate from the inverted index. Think of it as a transposed index: `(docID → field_value)` instead of `(term → docID list)`.

---

## 10. Lucene Segments

### 10.1 Immutability

A Lucene **segment** is an immutable, self-contained inverted index. Once written, it is never modified.

```
Index:
  Segment 1 (from yesterday): docs 1-1000
  Segment 2 (from this morning): docs 1001-2000
  Segment 3 (just created on refresh): docs 2001-2100
```

**Immutability enables**:
- No locking on reads (no writer can modify segment being read)
- OS page cache efficiency (immutable files → always cacheable)
- Simple merge semantics (take two segments, write one merged segment)

**Deletions**: stored in a `.del` file (bitset of deleted doc IDs). Docs are "soft-deleted" — not actually removed from segment until merge. Queries check the deletion bitset and skip deleted docs.

**Updates**: implemented as delete + reindex in a new segment. No in-place update.

### 10.2 Segment Merging

Over time, many small segments accumulate → many segments to search → slower queries (must check every segment).

Background merge process:
1. Tier-based merge policy selects segments to merge (similar-size tiers)
2. Write merged segment (reads all source segments, merges sorted doc lists)
3. Atomically switch to merged segment
4. Delete source segments

**merge.scheduler**: default is `ConcurrentMergeScheduler` (background threads). On write-heavy indexing, merges can saturate I/O. `index.merge.scheduler.max_thread_count` controls concurrency.

### 10.3 Refresh → New Segment Becomes Searchable

```
Index Request → Index Buffer (in-memory Lucene buffer)
                     ↓ (refresh every 1 second by default)
            New immutable segment on disk
                     ↓ (becomes searchable)
            Query returns this segment's documents
```

`index.refresh_interval = 1s` (default). Near-real-time search: documents searchable within ~1 second of indexing.

**Disable refresh for bulk indexing**: `PUT /index/_settings {"index.refresh_interval": "-1"}` → documents not searchable until refresh is re-enabled. Dramatically faster bulk loading (avoids creating many tiny segments).

---

## 11. Shards and Replicas

### 11.1 Primary Shards

An Elasticsearch index is divided into `number_of_shards` primary shards (default 1 since 7.0, previously 5). Each primary shard is a complete Lucene index.

**Shard sizing guidelines**:
- Target 20-50 GB per shard (up to 100 GB is OK for search-heavy; smaller for logging)
- Too many small shards: overhead per shard (heap, file handles) dominates
- Too few large shards: queries on one shard can't parallelize further

```json
PUT /orders
{
  "settings": {
    "number_of_shards": 5,
    "number_of_replicas": 1
  }
}
```

Primary shard count is **immutable after index creation**. If you need more shards later: `_reindex` to a new index or use the Split/Shrink API.

### 11.2 Replica Shards

Each primary shard can have 0+ replica shards. Replicas:
- Provide **read scaling** (search requests distributed across primaries and replicas)
- Provide **fault tolerance** (replica can be promoted to primary on node failure)
- Are maintained in sync: every index operation sent to primary is replicated to replicas

```
node1: primary shard 0, replica shard 1, replica shard 2
node2: primary shard 1, replica shard 0, replica shard 2
node3: primary shard 2, replica shard 0, replica shard 1
```

### 11.3 Routing

```
shard_num = hash(routing_value) % number_of_shards
```

Default `routing_value = document._id`. Custom routing (`?routing=user_id`) enables targeting a specific shard.

---

## 12. Indexing Pipeline

### 12.1 Ingest Nodes

Ingest nodes pre-process documents before indexing:
```json
PUT /_ingest/pipeline/my_pipeline
{
  "processors": [
    {"grok": {"field": "message", "patterns": ["%{IP:client_ip} ..."]}}
    {"date": {"field": "timestamp", "formats": ["ISO8601"]}},
    {"remove": {"field": "_ingest"}}
  ]
}

PUT /logs/_doc/1?pipeline=my_pipeline
{"message": "192.168.1.1 GET /api/v1 200 123ms", "timestamp": "2024-01-01T00:00:00Z"}
```

### 12.2 Mapping and Dynamic Mapping Pitfalls

**Dynamic mapping**: ES auto-detects field types. Pitfalls:
- A field appearing as a number in one doc, as a string in another → mapping conflict → indexing failure
- Large number of dynamically created fields → **mapping explosion** (thousands of fields → memory issues)

```json
// Disable dynamic mapping for strict schemas
PUT /orders
{
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "order_id": {"type": "keyword"},
      "amount": {"type": "double"},
      "created_at": {"type": "date"}
    }
  }
}
```

**`text` vs `keyword`**:
- `text`: analyzed (tokenized); supports full-text search with `match`; no exact match or aggregations
- `keyword`: not analyzed; exact match only; supports aggregations, sorting, terms queries

Common mistake: map a field that needs both as:
```json
"status": {
  "type": "text",
  "fields": {"keyword": {"type": "keyword"}}
}
// status.keyword for exact match/aggregation, status for full-text
```

---

## 13. Search — Query vs Filter, BM25, Aggregations

### 13.1 Query Context vs Filter Context

| | Query context | Filter context |
|--|---------------|----------------|
| Calculates score? | Yes | No |
| Result cached? | No | Yes (filter cache) |
| Use for | Full-text search, relevance | Exact match, ranges, existence checks |
| Performance | Slower (score calculation) | Faster + cached |

```json
GET /orders/_search
{
  "query": {
    "bool": {
      "must": [
        {"match": {"description": "urgent order"}}   // query context: affects score
      ],
      "filter": [
        {"term": {"status": "active"}},              // filter context: cached, no score
        {"range": {"amount": {"gte": 100}}}          // filter context: cached
      ]
    }
  }
}
```

**Best practice**: use `filter` for all exact/range conditions; use `query` only for full-text fields that need relevance scoring.

### 13.2 BM25 — Scoring Algorithm

BM25 (Best Matching 25) is the default relevance scorer since ES 5.0 (replaced TF-IDF):

```
BM25(q, d) = Σ IDF(qi) × (tf(qi,d) × (k1 + 1)) / (tf(qi,d) + k1 × (1 - b + b × |d| / avgdl))

where:
  IDF(qi) = log(1 + (N - n(qi) + 0.5) / (n(qi) + 0.5))
  tf(qi,d) = frequency of term qi in document d
  |d|       = length of document d (in tokens)
  avgdl     = average document length in corpus
  k1        = 1.2 (term frequency saturation — diminishing returns for high TF)
  b         = 0.75 (length normalization — longer docs penalized)
  N         = total documents
  n(qi)     = documents containing term qi
```

**Key insight**: BM25 caps the TF contribution (unlike TF-IDF where TF grows unbounded). A term appearing 100x vs 10x in a document barely differs in BM25 score — prevents very long documents from dominating.

**Tuning**:
```json
PUT /orders
{
  "settings": {
    "similarity": {
      "my_bm25": {
        "type": "BM25",
        "k1": 1.5,   // increase TF sensitivity
        "b": 0.5     // reduce length normalization (good for variable-length descriptions)
      }
    }
  }
}
```

### 13.3 Aggregations

```json
GET /orders/_search
{
  "size": 0,          // don't return documents, only aggregation results
  "aggs": {
    "by_status": {
      "terms": {"field": "status.keyword", "size": 10},
      "aggs": {
        "total_amount": {"sum": {"field": "amount"}},
        "avg_amount": {"avg": {"field": "amount"}}
      }
    },
    "amount_histogram": {
      "histogram": {"field": "amount", "interval": 100}
    }
  }
}
```

**Aggregation internals**: `terms` aggregation uses doc values (column-oriented storage). `cardinality` aggregation uses HyperLogLog. Aggregations on `text` fields require `fielddata: true` (expensive, loads terms into heap) — always use `keyword` sub-field for aggregations.

---

## 14. Near-Real-Time Search

### 14.1 Why the 1-Second Delay

Refresh cycle:
```
Document indexed → written to in-memory buffer (Lucene IndexWriter buffer)
                ↓ (every refresh_interval, default 1s)
        Buffer flushed → new Lucene segment created on-disk (NOT fsync'd yet)
                ↓ (searchable)
        Segment opened by IndexReader → document now queryable
                ↓ (every 30s or on flush)
        fsync to disk (translog flushed, durable)
```

**Translog**: like a WAL for Elasticsearch. Every indexed document is written to the translog before acknowledgment. On crash between refresh and fsync, documents are recovered from translog.

### 14.2 Controlling Refresh

```json
// Force immediate refresh for specific index (use sparingly)
POST /orders/_refresh

// Refresh after each write (for testing/latency-sensitive writes)
PUT /orders/_doc/1?refresh=true
{"order_id": "abc"}

// Wait until document is searchable
PUT /orders/_doc/1?refresh=wait_for
{"order_id": "abc"}
```

**Production**: use `refresh=wait_for` only for critical consistency requirements (adds latency). Default `refresh_interval=1s` is appropriate for most use cases.

---

## Interview Quick-Fire Reference

### Redis

| Question | Key Answer |
|----------|-----------|
| How does ZSet work internally? | Skiplist (score-ordered ops O(log N)) + hashtable (member lookup O(1)) |
| Why does EVAL guarantee atomicity? | Redis is single-threaded; Lua runs to completion; no other commands interleave |
| What is copy-on-write in RDB? | fork() shares pages; parent's writes copy pages; child writes original data to RDB |
| Why 16384 hash slots? | Gossip heartbeat bitmap fits in 2KB packet vs 8KB for 65536 |
| Redlock controversy | Not safe under clock skew or GC pauses for correctness locks; OK for efficiency |
| listpack vs hashtable for Hash | listpack: compact, O(N) lookup but cache-friendly for small N; hashtable: O(1) lookup |
| PSYNC vs full sync | PSYNC: send delta from backlog; full sync: entire RDB transfer on new replica/backlog overflow |

### Elasticsearch

| Question | Key Answer |
|----------|-----------|
| Why are Lucene segments immutable? | No read locks needed; cache-friendly; simple merge semantics |
| Query vs filter context | Filter: no scoring, cached; Query: scores, not cached; always filter for exact/range conditions |
| Why 1-second delay in ES search? | Refresh creates new Lucene segment (not fsync); segment opened by reader → searchable |
| BM25 vs TF-IDF | BM25 caps TF contribution (saturation with k1); adjusts for document length (b); more robust |
| Dynamic mapping pitfall | Mapping explosion (thousands of auto-created fields); type conflicts; use strict mapping |
| How to size shards | 20-50 GB per shard; too many small shards = heap/file handle overhead; primary count immutable |
| text vs keyword | text: analyzed, full-text search; keyword: exact match, aggregation, sorting |
