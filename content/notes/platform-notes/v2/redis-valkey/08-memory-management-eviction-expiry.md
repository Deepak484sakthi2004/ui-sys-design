# Chapter 8: Memory Management, Eviction & Expiry

> RAM is the resource Redis spends most carefully. This chapter is about
> three things that look separate but are deeply intertwined: how Redis
> *allocates* memory (jemalloc), how it *forgets* keys when memory is
> tight (eviction), and how it *forgets* keys when their time is up
> (expiry). Get any of the three wrong and you'll page oncall at 3 AM
> with a mysteriously OOM-killed process or an inexplicably stale cache.

---

## 8.1 The Allocator: jemalloc

Redis ships with **jemalloc** (Facebook's allocator) as its memory allocator.
It is *not* glibc's `malloc`. It is *not* tcmalloc. The choice of jemalloc
is load-bearing for Redis's behavior — fragmentation, RSS reporting, and
even active defrag are jemalloc-specific.

### 8.1.1 Why jemalloc

Three properties matter for Redis:

1. **Low fragmentation** for variable-sized allocations. Redis allocates
   millions of small objects (16 bytes – 256 bytes mostly) plus occasional
   big ones (multi-MB lists/hashes). Glibc's `malloc` is OK at this, but
   jemalloc is consistently 10-30% more memory-efficient on this exact
   pattern.
2. **`malloc_usable_size`-style introspection**. jemalloc exposes the
   *actual* size class (e.g., a 100-byte allocation lands in the 112-byte
   size class, so `je_malloc_usable_size` returns 112). Redis uses this
   to track "real" memory usage, not "nominal."
3. **Defragmentation hints** (`je_get_defrag_hint`). For a given pointer,
   jemalloc tells you "this allocation is in a fragmented run; if you copy
   it elsewhere, you might be able to release the run back to the OS." Active
   defrag uses this.

```bash
# Confirm jemalloc is in use:
redis-cli INFO memory | grep mem_allocator
mem_allocator:jemalloc-5.3.0
```

You can build Redis with `make MALLOC=libc` to use glibc, but you lose
defrag and the memory accounting will be slightly off. Don't.

### 8.1.2 Size Classes

jemalloc rounds every allocation up to a fixed size class:

```
Sizes:
  Tiny  (8, 16, 24, 32, 40, 48, 56, 64)
  Small (80, 96, 112, ..., up to ~14 KB in 8% increments)
  Large (16 KB up to chunk size — 4 MB default)
  Huge  (multi-megabyte, allocated via mmap)
```

A 35-byte SDS allocation occupies a 40-byte slot. The 5 bytes of slack are
called **internal fragmentation**. For Redis with millions of small SDS,
this typically adds ~5-10% RSS overhead.

**External fragmentation** is different: free slots that are too small to
satisfy the next allocation. Active defrag attacks this.

### 8.1.3 RSS, Used Memory, Allocator Allocated Memory

Three numbers, all different, all important:

```
> INFO memory
used_memory:1342177280              # 1.25 GB - sum of zmalloc-tracked allocations
used_memory_rss:1610612736          # 1.50 GB - process RSS as reported by /proc
used_memory_peak:1879048192         # 1.75 GB - max used_memory ever
allocator_allocated:1428160512      # 1.33 GB - jemalloc's view of total allocated
allocator_active:1577058304         # 1.47 GB - jemalloc's "active" pages
allocator_resident:1610612736       # 1.50 GB - jemalloc's RSS view (matches RSS)
mem_fragmentation_ratio:1.20        # rss / used_memory
mem_fragmentation_bytes:268435456
allocator_frag_ratio:1.10           # active / allocated
```

The hierarchy:

```
   used_memory  (≤)  allocator_allocated  (≤)  allocator_active  (≤)  allocator_resident == RSS
        |                    |                       |                       |
   what Redis tracks   what jemalloc tracks    pages with at least     pages mapped into
   via zmalloc/zfree                           one live alloc          process address space
```

**`mem_fragmentation_ratio` interpretation**:

- `< 1.0`: RSS is less than used_memory. Either the OS has paged you out
  (bad — you're swapping), or a recent shrink hasn't been reflected.
- `1.0 - 1.5`: Healthy. Some unavoidable internal+external fragmentation.
- `> 1.5`: External fragmentation is high. Consider active defrag.
- `> 2.0`: Genuinely problematic. Active defrag, restart, or memory-bigger
  rebuild.

>>> **Interview insight**: When asked "Redis is using more memory than
>>> `used_memory` says," you walk this ladder. The answer is almost always
>>> "fragmentation" or "process bookkeeping (replication backlog, client
>>> buffers, AOF buffer) not counted in `used_memory`."

### 8.1.4 Active Defragmentation

```
activedefrag yes
active-defrag-ignore-bytes 100mb
active-defrag-threshold-lower 10
active-defrag-threshold-upper 100
active-defrag-cycle-min 5
active-defrag-cycle-max 75
```

The defragger:

1. Wakes up if `mem_fragmentation_ratio` exceeds the lower threshold.
2. Walks the keyspace via SCAN cursor, asking jemalloc for defrag hints.
3. For each "fragmented" allocation: copies it to a fresh allocation,
   updates the dict pointer, frees the old.
4. Throttles itself between `cycle-min` and `cycle-max` percent CPU.

It is **CPU-bound** and runs on the main thread. The CPU spent is real —
expect 5-10% additional CPU during active defrag cycles.

(!) **Production hazard**: active defrag works only with jemalloc. With
  libc, the option is a no-op. Also: it doesn't help with internal
  fragmentation (size class slack). For that, the only fix is "use fewer,
  bigger allocations" (e.g., listpack-encoded hashes instead of many tiny
  string keys).

---

## 8.2 The `maxmemory` Cap

```
maxmemory 4gb
maxmemory-policy allkeys-lru
maxmemory-samples 5
```

`maxmemory` is the cap **on `used_memory` not on RSS**. If `maxmemory` is
4 GB and fragmentation ratio is 1.5, RSS will be ~6 GB. You must size your
machine accordingly — no swap, no OOM-killer.

When `used_memory` would exceed `maxmemory` after a write, Redis applies
the eviction policy.

### 8.2.1 The Eviction Policies

```
noeviction              # default: write commands fail with OOM error
allkeys-lru             # evict any key, approximate LRU
allkeys-lfu             # evict any key, approximate LFU
allkeys-random          # evict any key at random
volatile-lru            # evict only keys with TTL set, approximate LRU
volatile-lfu            # evict only keys with TTL set, approximate LFU
volatile-random         # evict only keys with TTL set, randomly
volatile-ttl            # evict only keys with TTL, smallest TTL first
```

When to use which:

| Policy | Use case |
|--------|----------|
| `noeviction` | You'd rather fail writes than lose data. Use as system-of-record (don't, but if you must). |
| `allkeys-lru` | Cache where every key is equally evictable. Most common production default. |
| `allkeys-lfu` | Cache where access frequency matters more than recency (e.g., long-tail content). |
| `volatile-lru` | Mixed: some keys are "data," others are "cache" (with TTL). |
| `volatile-ttl` | Useful when you intentionally set short TTLs and want them respected first. |
| `*-random` | Almost never. Only if access patterns are uniform random. |

### 8.2.2 Approximate LRU: Why It's "Approximate"

True LRU requires ordering all keys by access time (a doubly-linked list
pinned at access). The pointer overhead is 16 bytes per key — for a billion
keys, 16 GB of overhead. Redis can't afford that.

Instead, **`maxmemory-samples` keys are sampled at random** on each eviction
attempt, and the one with the oldest `lru` field is evicted. With samples=5
(default), the chosen key is "the oldest of 5 random keys" — close enough
to true LRU for cache workloads.

```c
// evict.c
int performEvictions(void) {
    while (mem_to_free > 0) {
        unsigned long bestkey_idle = 0;
        sds bestkey = NULL;

        /* Pick keys to compare */
        for (db = 0..server.dbnum-1) {
            d = (policy is allkeys) ? db->dict : db->expires;
            for (i = 0..maxmemory_samples-1) {
                de = dictGetRandomKey(d);
                key = dictGetKey(de);
                if (lru_idle(key) > bestkey_idle) {
                    bestkey = key;
                    bestkey_idle = lru_idle(key);
                }
            }
        }

        if (bestkey) deleteKey(bestkey);
        mem_to_free -= memoryFreedByDelete;
    }
}
```

**`maxmemory-samples 10` improves precision** at modest CPU cost. For
LRU-sensitive workloads, raise to 10. Beyond 10 there are diminishing
returns.

### 8.2.3 Pool-Based LRU/LFU (Redis 3.0+)

Redis maintains a small **eviction pool** of 16 candidate keys. When sampling
runs, candidates that beat the *worst* in the pool replace it. The pool is
sorted by idle time. Eviction picks the best from the pool.

This means: even if your samples are unlucky on one round, candidates from
prior rounds are still in the pool. It significantly improves the
"approximate LRU is bad on tiny `maxmemory-samples`" complaint.

### 8.2.4 LFU Specifics

LFU has two parts: **counter** and **decay**. The counter increments
(probabilistically) on access; the decay subtracts on the periodic
sweep.

```
lfu-log-factor 10       # higher = slower counter growth
lfu-decay-time 1        # minutes between decay sweeps
```

`lfu-log-factor 0` makes the counter increment every access (saturates fast,
useless). `lfu-log-factor 100` makes it almost-never increment (counter
stays at the initial value, eviction order looks random). The default 10
is a sensible middle.

`lfu-decay-time 0` disables decay entirely (counter only goes up, never
down). Useful for "only ever evict cold keys" semantics.

>>> **Interview insight**: LRU vs LFU mental model:
>>> - LRU: "evict the key not touched recently"
>>> - LFU: "evict the key not touched often"
>>>
>>> A key accessed once an hour for a year is "cold by LRU" (last access was
>>> 60 min ago) but "warm by LFU" (counter is high). For typical caches
>>> where popularity is bimodal (lots of hits on a few keys, very few hits
>>> on most), LFU outperforms LRU on hit rate.

### 8.2.5 Eviction is on the Main Thread

`performEvictions` is called from `processCommand` *before* a write that
would breach maxmemory. The main thread does the work. With
`maxmemory-samples 5` and a hash chain length of ~2, evicting one key takes
~5 µs. Evicting many in a single command (a big `MSET` that adds 100 MB)
can take milliseconds.

This is why **bursty large writes can spike latency**. If memory is at the
edge of `maxmemory`, every write triggers an eviction loop.

---

## 8.3 Expiry: Active and Passive

A key with TTL gets entered into `db->expires` (a separate dict from
`db->dict`). The expires dict maps key SDS to int64 (millisecond unix
timestamp).

```c
// db.c
typedef struct redisDb {
    dict *dict;           // keyspace
    dict *expires;        // ttl per key
    dict *blocking_keys;  // BLPOP, etc.
    dict *ready_keys;
    dict *watched_keys;
    int id;
    long long avg_ttl;
    ...
} redisDb;
```

### 8.3.1 Passive Expiry: Lookup Time

When a key is read or written, Redis checks if it has expired:

```c
robj *lookupKeyRead(redisDb *db, robj *key) {
    if (expireIfNeeded(db, key) == 1) return NULL;     // expired and removed
    return lookupKey(db, key);
}

int expireIfNeeded(redisDb *db, robj *key) {
    long long when = getExpire(db, key);
    if (when < 0) return 0;       // no expire set
    if (when > mstime()) return 0; // not yet
    if (server.lazyfree_lazy_expire)
        dbAsyncDelete(db, key);
    else
        dbSyncDelete(db, key);
    notifyKeyspaceEvent(NOTIFY_EXPIRED, "expired", key, db->id);
    return 1;
}
```

Cheap, O(1), happens on every key access. But: a key never accessed never
gets expired this way. Without active expiry, a Redis dataset could fill
with expired-but-not-deleted keys.

### 8.3.2 Active Expiry: The Background Cycle

`serverCron` runs `activeExpireCycle` every 100 ms. Two modes:

```c
#define ACTIVE_EXPIRE_CYCLE_FAST 1
#define ACTIVE_EXPIRE_CYCLE_SLOW 0

void activeExpireCycle(int type) {
    int timelimit;
    if (type == ACTIVE_EXPIRE_CYCLE_FAST)
        timelimit = ACTIVE_EXPIRE_CYCLE_FAST_DURATION;     // 1000 microseconds
    else
        timelimit = 1000000 * ACTIVE_EXPIRE_CYCLE_SLOW_TIME_PERC / server.hz;
        // SLOW: cap at ~25% of CPU per cron tick

    long long start = ustime();
    do {
        for (db = 0..server.dbnum-1) {
            int expired = 0;
            int sampled = 0;
            // Sample up to 20 keys from db->expires
            for (i = 0..20-1) {
                de = dictGetRandomKey(db->expires);
                if (de && timestamp_expired(de)) {
                    deleteKey(...);
                    expired++;
                }
                sampled++;
            }
            if (expired > sampled / 4) continue;   // try this db again
        }
    } while (ustime() - start < timelimit);
}
```

The loop:

1. Sample 20 random keys from `expires`.
2. Count how many are actually expired.
3. If > 25% are expired, do another round on the same db (otherwise move on).
4. Stop when the time limit is up.

The 25% threshold is the key adaptive feedback: if we're finding lots of
expired keys, the database is "expire-rich" — lean in. If not, move on.

### 8.3.3 The Two Cycle Variants

**FAST** runs in `beforeSleep` for ≤ 1 ms total. Triggered when slow cycle
isn't keeping up.

**SLOW** runs in `serverCron` for up to 25% of `1/hz` seconds. With default
`hz=10`, that's 25 ms per 100 ms tick (max 25% CPU on expiry).

**`hz`** is the responsiveness knob:

| `hz` | Cron tick | Slow cycle budget | Verdict |
|------|-----------|-------------------|---------|
| 10 (default) | 100 ms | 25 ms | OK for most workloads |
| 100 | 10 ms | 2.5 ms | More responsive; more CPU |
| 500 (max) | 2 ms | 0.5 ms | For very-low-latency setups |

>>> **Interview insight**: A common production issue is "expired keys are
>>> still in memory." The diagnosis is almost always: expire rate >
>>> active expire cycle's keep-up rate. Bump `hz`, or `maxmemory` if you
>>> can let eviction handle it, or fix the workload (e.g., set TTLs more
>>> uniformly so the cycle finds them).

### 8.3.4 Expire vs Eviction

Expire = "this key has a TTL and it has now expired."
Eviction = "we're over `maxmemory` and need to drop a key (which may or
may not have a TTL)."

These are independent mechanisms. Both can fire at the same time. A
`volatile-lru` policy *only* evicts keys that have TTL set, blurring the
line.

---

## 8.4 Setting TTL: The Atomic Way

Three patterns:

```
# RACY (don't do):
SET k v
EXPIRE k 60                       # if Redis dies between, k has no TTL forever

# ATOMIC (do):
SET k v EX 60                     # one command, atomic

# Update only the TTL:
EXPIRE k 60                       # set TTL on existing key
EXPIRE k 60 XX                    # only if a TTL is already set
EXPIRE k 60 NX                    # only if no TTL is set
EXPIRE k 60 GT                    # only if new TTL > current
EXPIRE k 60 LT                    # only if new TTL < current

# Persist a key (remove TTL):
PERSIST k

# Inspect:
TTL k                              # in seconds, -1 if no TTL, -2 if no key
PTTL k                             # in milliseconds
EXPIRETIME k                       # absolute unix time (Redis 7+)
```

>>> **Interview insight**: `SET k v EX 60` is *the* canonical way to set a
>>> caching key. Two-command pattern (`SET` then `EXPIRE`) has a window where
>>> the key exists without a TTL. If your cache sets that as a guard against
>>> stampede and the Redis crashes, you wake up with billions of TTL-less
>>> keys filling memory.

---

## 8.5 The OOM Story

What actually happens when memory fills:

### 8.5.1 With `maxmemory 0` (no cap, default)

Redis grows until the OS kills it (`oom_score_adj` makes Redis a likely
target). Catastrophic.

### 8.5.2 With `maxmemory N` set

```
Write arrives -> processCommand checks server.maxmemory & cmd flags
              -> if (CMD_DENYOOM): performEvictions()
              -> if (eviction can't free enough memory):
                 -> with policy=noeviction: -OOM error
                 -> with eviction policy: keep evicting until enough room
                                           or no candidates left
              -> command runs
```

Commands flagged `CMD_DENYOOM` (most writes) trigger eviction. Read-only
commands don't.

```
> CONFIG SET maxmemory 100mb
> CONFIG SET maxmemory-policy noeviction
> ... fill memory ...
> SET k v
(error) OOM command not allowed when used memory > 'maxmemory'.
> GET k
"v"
```

### 8.5.3 OOM with eviction-disqualified policies

If you use `volatile-lru` and *no* keys have TTL set, eviction has nothing
to evict. You get OOM errors as if `noeviction` were set.

### 8.5.4 The "memory cliff"

The eviction loop has a CPU cost. Above ~95% of `maxmemory`, every write
triggers eviction → eviction loops until enough is freed → latency
spikes. The remediation is **don't run at the cliff**. Either:

- Cap workload growth (logical sharding)
- Pre-emptively scale (vertical or horizontal)
- Tune samples down or up to find a CPU/precision balance
- Use `volatile-ttl` and set TTLs liberally so eviction has cheap candidates

---

## 8.6 Memory-Saving Recipes

A starter pack:

### 8.6.1 Use hashes instead of many small keys

```
# Bad: 1M users × 5 keys each = 5M keys
SET user:42:name "alice"
SET user:42:email "alice@example.com"
...

# Good: 1M hashes
HSET user:42 name "alice" email "alice@example.com" ...
```

Saves ~70% on this pattern (Chapter 6 had numbers).

### 8.6.2 Use the right encoding thresholds

Default thresholds (128 entries / 64 bytes) are good. Don't tune them up
unless measured.

### 8.6.3 Prefer integer values

Counter-style keys with values 0..9999 share the global `shared.integers`
pool. Free.

### 8.6.4 Compress before sending

Redis itself doesn't compress. If you're storing 1 KB JSON values, gzip
them client-side. Saves 60-80%, transparent.

### 8.6.5 Use `MEMORY USAGE` and `MEMORY STATS` to find offenders

```
> MEMORY STATS
1) "peak.allocated"
2) (integer) 1879048192
...

> MEMORY DOCTOR
"Sam, I detected a few issues in this Redis instance memory implants: ..."
```

`MEMORY DOCTOR` does a quick scan of the obvious problems (high
fragmentation, big keys, stale RDB child memory). Useful first stop.

### 8.6.6 Find big keys

```
$ redis-cli --bigkeys
$ redis-cli --memkeys                    # rank by memory, not item count
```

This walks the keyspace via SCAN and reports the worst offenders. Don't
run it on a primary at peak — it's read-heavy and can take minutes.

---

## 8.7 The Replication Backlog: A Hidden Memory Eater

Replication keeps a **circular buffer** of recent commands so a disconnected
replica can catch up via partial sync (Chapter 11). The default size is
1 MB but production values are typically 256 MB to several GB.

```
repl-backlog-size 1gb
```

This 1 GB sits **outside `used_memory`** in older versions; in Redis 7+ it's
included. Either way, it's real RSS.

(!) **Production hazard**: doubling `repl-backlog-size` from 256 MB to
  1 GB on a tight 4 GB host suddenly takes 750 MB out of available memory.
  If `maxmemory` was 3 GB and stable, you might OOM after the change.

---

## 8.8 Client Output Buffers: Another Hidden Eater

Each connected client has input + output buffers (Chapter 3). 100K idle
connections cost ~1.6 GB *before any commands fire*. With slow consumers
hammering pub/sub, output buffers can grow to gigabytes per client.

```
> CLIENT LIST
id=12 addr=... obl=8388608 oll=4 omem=33554432 ...
                ^             ^   ^
                output buffer  output queue length, total memory
```

Set `maxmemory-clients` (Redis 7+) to cap this globally.

---

## 8.9 Putting It All Together: Sizing a Redis

A practical sizing exercise: 100 GB working set, mixed reads + writes.

```
   used_memory          ≈ 100 GB    (your actual data)
 + replication backlog  ≈   1 GB    (sized for largest replica drop window)
 + AOF buffer           ≈ 0.5 GB    (in-memory rewrite buffer at peak)
 + client buffers       ≈   2 GB    (10K connections, generous output)
 + jemalloc fragments   ≈  15 GB    (~15% on this size)
 = RSS                  ≈ 119 GB

 + fork() COW peak      ≈  20 GB    (during BGSAVE, 20% of writes touch new pages)
 + OS + monitoring      ≈   2 GB
 = box RAM needed       ≈ 141 GB

 round up               -> 192 GB instance
 maxmemory              -> 100 GB (or 110 GB to leave room for new data)
 maxmemory-policy       -> allkeys-lru
 maxmemory-samples      -> 10
 maxmemory-clients      -> 10% (i.e., 10 GB)
```

Iterate from there.

---

## 8.10 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `evict.c` | Eviction policies, eviction pool, `performEvictions` |
| `expire.c` | `activeExpireCycle`, `expireIfNeeded`, EXPIRE commands |
| `db.c` | `lookupKeyRead/Write`, expire-aware lookups, redisDb |
| `lazyfree.c` | Lazy free / async delete via BIO |
| `defrag.c` | Active defrag using jemalloc hints |
| `zmalloc.c` | Thin wrapper over jemalloc; tracks `used_memory` |

---

## Practice Questions

1. `mem_fragmentation_ratio` is 1.8 on a long-running server. Walk through
   the diagnostic steps — what could cause this and what's the right
   sequence of remediations?
2. You enable `maxmemory 100mb` and `maxmemory-policy allkeys-lru`. The
   working set is 200 MB and growing. Throughput collapses. Why? What's
   the fix?
3. Why does `lfu-decay-time 0` exist? Construct a workload where setting
   it to 0 gives better hit rate than the default.
4. Active expiry uses a 25%-expired feedback threshold. What's the impact
   of changing it to 50%? To 5%?
5. A team complains: "We set TTLs of 60 seconds, but `MEMORY USAGE`
   shows the keys 90 seconds later." Diagnose.
6. `SET k v EX 60` versus `SET k v; EXPIRE k 60`: under what specific
   failure mode do they differ? What's the resulting bug?
7. Your replica has been disconnected for 30 seconds. `repl-backlog-size`
   is 64 MB. Average write rate is 5 MB/sec. Will partial resync work?
   How would you size the backlog for a 5-minute disconnection budget?

(Answers at end of Chapter 22.)
