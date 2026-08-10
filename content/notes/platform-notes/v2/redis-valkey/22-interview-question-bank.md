# Chapter 22: Interview Question Bank

> 100+ Staff/Principal-level questions with answers. Organized by topic.
> Cross-references back into Part 1 chapters where you should reread for
> depth. The "boundary" between memorizable factoid and load-bearing
> insight is signaled by `[BANK]` (the recallable answer) and `[DEPTH]`
> (the follow-up that separates senior from staff).

---

## Section A: Architecture & Event Loop (Ch 1-2)

**A1. Why is Redis single-threaded? Doesn't multi-core hardware make this
silly?**

[BANK] Single-threaded means no locks, no context switches in the data
path, perfect predictability. Multi-core helps networking (I/O threads
since 6.0) and persistence (forked child) but command execution stays
single-threaded.

[DEPTH] The bottleneck for in-memory hash lookups is **memory bandwidth
and cache coherency**, not arithmetic. Adding threads adds cache-line
contention and lock overhead, which makes everything slower per-op.
Redis offloads what *can* be parallelized cheaply (network I/O, fork-based
persistence, lazy free) and keeps command logic single-threaded by
design. Compare to KeyDB and Dragonfly — both went multi-threaded at
the cost of architectural complexity.

**A2. Walk through the path of `GET foo` from socket bytes to reply
bytes.**

[BANK] (Chapter 2 §2.3.) `epoll_wait` returns the client fd. `readQueryFromClient` reads bytes
into `c->querybuf`. RESP parser (`processMultibulkBuffer`) extracts
`["GET", "foo"]`. `processCommand` does auth, ACL, cluster slot, memory
checks, then calls `getCommand` which calls `lookupKeyReadOrReply`,
which does `dictFind(server.db[N].dict, "foo")` and replies via
`addReplyBulk`. Reply queues to `c->buf`; `beforeSleep` flushes it via
`write`.

[DEPTH] Critical: the reply is not sent inline. It's buffered, batched
with other replies in the same loop iteration, and flushed in
`beforeSleep`. This is why pipelining is so cheap on the server side —
many commands in one read = many replies in one write.

**A3. What is `beforeSleep` and why does it matter?**

`beforeSleep` is the callback invoked once per event-loop iteration,
between processing fired events and blocking on `epoll_wait`. It's
where Redis hides "must-be-done-but-not-on-critical-path" work: flushing
pending writes, fast expire cycle, AOF buffer flush, replication feed,
cluster cron. If you wonder "how did Redis manage to do X without me
asking" — it's almost always in `beforeSleep` or `serverCron`.

**A4. `KEYS *` and a 100M-key DB. Why is this dangerous?**

[BANK] O(N) over all keys, single-threaded — freezes the server for
many seconds. Other clients see their commands queued up. Looks like
"Redis went down."

[DEPTH] Replace with `SCAN 0 MATCH ... COUNT 1000` — cursor-based,
returns control after ~COUNT keys. The reverse-bit cursor (Chapter 5)
makes it safe across hashtable rehashes.

**A5. I/O threads — what do they actually parallelise?**

[BANK] Reading from sockets, writing to sockets, RESP parsing.
**Command execution remains single-threaded.** Atomicity guarantees
unchanged.

[DEPTH] I/O threads help when network/SSL/parsing is the bottleneck
(many small commands, TLS, lots of clients). They don't help when
the bottleneck is data structure manipulation. So a workload doing
1M `INCR` ops/sec on one key gets no benefit. A workload of 100K
small TLS GETs/sec gets a real win.

**A6. BIO threads — what are the three of them?**

`BIO_CLOSE_FILE` (close fds), `BIO_AOF_FSYNC` (fsync the AOF),
`BIO_LAZY_FREE` (free big objects on `UNLINK`/lazy eviction). All
three offload syscalls/work that could block the main thread.

**A7. Why is `DEL hugeset` bad and what's the fix?**

`DEL` of a compound type frees every element synchronously on the main
thread. A 5 GB sorted set takes hundreds of ms to free. Use `UNLINK`
instead — it removes the dict entry on the main thread (O(1)) and hands
the object to BIO lazy free.

**A8. `latest_fork_usec` is climbing — what does that mean?**

Fork time grows with **virtual memory size**, not data size, because
the kernel must duplicate page tables. At 80 GB RSS, fork takes ~300 ms;
at 200 GB, multiple seconds. The main thread is paused during fork. As
the dataset grows, fork pause becomes user-visible. Plan to shard
before fork pause exceeds your latency SLO.

---

## Section B: RESP & Networking (Ch 3)

**B1. What's RESP2 vs RESP3?**

[BANK] RESP2: 5 types (simple string, error, integer, bulk string,
array). RESP3: adds null, double, boolean, big number, map, set,
attribute, push, verbatim string. Switch to RESP3 with `HELLO 3`.

[DEPTH] RESP3 push (`>` prefix) lets the server send messages
out-of-band on the same connection — used for client-side cache
invalidation, pub/sub messages without the awkward subscribed-connection
lockout. RESP2 returns `HGETALL` as alternating `[k, v, k, v]` array;
RESP3 returns it as a map.

**B2. Why does pipelining give 5x throughput when it "just" eliminates
RTTs?**

Two reasons: (1) one TCP read on the server side processes N commands
(amortising the syscall and parser entry); (2) one TCP write returns N
replies. Both server and client sides save syscalls + scheduler
overhead. RTT elimination is the headline; syscall amortisation is the
hidden bonus.

**B3. Pipelining vs transactions — same thing?**

No. Pipelining = "send many independent commands in one batch for
performance." Transactions (MULTI/EXEC) = "execute multiple commands
atomically as a unit." You can pipeline a transaction (and most clients
do).

**B4. Client output buffer hit `client-output-buffer-limit`. What happens?**

The server forcibly disconnects the client. Default for `replica` is
256mb hard / 64mb soft for 60s. For `pubsub` 32mb / 8mb / 60s. For
`normal` 0/0/0 (unlimited — protected only by `maxmemory-clients` if
set).

**B5. A subscriber goes silent and the buffer balloons. What did the
designers do for this?**

`maxmemory-clients` (Redis 7+) caps total client buffer memory. On
overflow, evict the biggest-buffered clients. A safety net for the
"`client-output-buffer-limit normal 0 0 0`" gotcha.

**B6. Inline RESP — what is it and should you use it?**

The legacy plain-text protocol (`SET foo bar\r\n`). Detected when the
first byte isn't `*`. Useful for telnet sessions, **never in production
clients** because it's not binary-safe.

---

## Section C: Strings, SDS (Ch 4)

**C1. Why didn't Redis just use `char*`?**

Three reasons: (1) C strings end at first NUL byte → not binary-safe;
(2) `strlen` is O(N) → constant-time STRLEN impossible; (3) `strcat`
needs a separate length variable to be safe.

**C2. The five SDS header types — why?**

To minimize per-string overhead. `sdshdr5` (1-byte header for ≤31 byte
strings), `sdshdr8`, `16`, `32`, `64`. A 16-byte string carries 4 bytes
of overhead, not 17. Across millions of small strings, billions of
bytes saved.

**C3. EMBSTR vs RAW — what's the difference?**

EMBSTR: `robj` and SDS allocated in one 64-byte block (cache-line
sized). For strings ≤ 44 bytes. Immutable — modifications convert to
RAW. RAW: `robj` and SDS in separate allocations; for longer strings.

**C4. Why is the 44-byte EMBSTR threshold what it is?**

`64 (cache line) - 16 (robj) - 3 (sdshdr8) - 1 (terminator) = 44`. It's
defined as `OBJ_ENCODING_EMBSTR_SIZE_LIMIT` in `object.c`.

**C5. Shared integer objects — why and what's the limit?**

Pre-allocated `robj`s for integers 0..9999 (`OBJ_SHARED_INTEGERS`).
Saves memory on counter-style keys. Disabled when LRU/LFU policies are
active (because shared `robj`s can't have meaningful per-key
access bookkeeping).

**C6. APPEND on a 100-byte SDS three times. Cost profile?**

`sdsMakeRoomFor` doubles capacity below 1 MB; each append is O(N + M)
amortised O(1). Once stable, you can call `sdsRemoveFreeSpace` to
shrink to fit. **Pathological case**: APPEND to a string repeatedly
keeps both real data + free space; over time RSS grows even as
"useful" data doesn't.

---

## Section D: Dictionary & Rehashing (Ch 5)

**D1. Walk through incremental rehashing.**

[BANK] When the load factor crosses ≥1, Redis allocates a new
`ht_table[1]` of double size. From then on, every `dictAddRaw`,
`dictFind`, `dictGenericDelete` calls `_dictRehashStep`, which migrates
**one bucket** from `ht[0]` to `ht[1]`. Plus `serverCron` runs
`dictRehashMilliseconds(d, 1)` for up to 1 ms per tick. When `ht_used[0]
== 0`, free `ht[0]`, swap `ht[1]` into `ht[0]`, set `rehashidx = -1`.

[DEPTH] During rehash, **inserts go directly to `ht[1]`** (so `ht[0]`
shrinks monotonically). Lookups check `ht[0]` then `ht[1]`. Cost of
each lookup during rehash is at most 2x non-rehash. Background
catchup ensures progress even on idle dicts.

**D2. Why does Redis use SipHash and not MurmurHash?**

SipHash is **keyed** (the seed is generated at startup from
`/dev/urandom`). Without SipHash, an attacker could craft keys that
all hash to one bucket → O(N²) lookups → DoS. MurmurHash is faster
but unkeyed and reversible. For a public-facing Redis, this is a real
attack.

**D3. What's the SCAN cursor? Why is it so weird?**

The cursor uses **reverse-bit binary counting**. Visiting buckets in
the order their bit-reversed indices are 0, 1, 2, 3, ... means that
when the dict doubles, bucket `i` splits into buckets `i` and `i +
size/2` — and those are *consecutive* in reverse-bit order. Result:
SCAN never misses or duplicates keys across rehashes.

[DEPTH] SCAN guarantees: every key present for the entire scan is
returned at least once (and exactly once unless the dict shrunk
mid-scan). Keys added during the scan may or may not be returned. The
client must dedupe.

**D4. Why is `dict_can_resize = 0` during BGSAVE?**

To minimize copy-on-write dirtying in the parent. Resizing means
moving entries between buckets, which writes to memory and dirties
COW pages. The parent's RSS grows proportionally. Forced resize at
load factor 5 still happens (otherwise lookups become O(N)).

---

## Section E: Skiplists, Listpacks, Quicklist (Ch 6)

**E1. Why a skiplist for sorted sets, not a B-Tree?**

[BANK] Same O(log n) expected performance, simpler implementation
(~300 lines), supports range queries trivially (level 0 is a sorted
linked list), less memory overhead.

[DEPTH] The `span` field at each level is the magic that gives O(log n)
rank queries. Without it, `ZRANK` would be O(n). For multi-version
concurrency (which Redis doesn't need), skiplists are also easier to
make lock-free than B-Trees.

**E2. What replaced ziplist and why?**

Listpack. Ziplist's `prevlen` field could trigger cascading updates
(insertion grows one entry past 254 bytes → next entry's prevlen field
grows from 1 to 5 bytes → may push it past 254 → cascading). Listpack
stores each entry's **own** length at the entry's tail (`backlen`), not
the previous entry's length. No cascading.

**E3. When does a hash convert from listpack to hashtable?**

When fields exceed `hash-max-listpack-entries` (default 128) OR any
field/value exceeds `hash-max-listpack-value` (default 64 bytes).
One-way conversion — no auto-downgrade on shrink.

**E4. Sets have three encodings — when each?**

- All values are int64 AND ≤ `set-max-intset-entries` (default 512) →
  `intset` (sorted array of fixed-width ints; binary search).
- General with small members → `listpack`.
- Beyond either threshold → `hashtable`.

**E5. Quicklist — why?**

A doubly-linked list of listpacks. Linked list at the macro level
gives cheap LPUSH/RPUSH/LPOP/RPOP. Listpack at the micro level gives
cache-friendly packed storage. Each node holds many elements; the list
has few nodes.

`list-compress-depth N` enables LZF compression on inner nodes (for
"queue with cold middle" workloads).

---

## Section F: Object Encoding (Ch 7)

**F1. The `redisObject` struct — what fields does it have?**

```
unsigned type:4
unsigned encoding:4
unsigned lru:24
int refcount
void *ptr
```

16 bytes total on 64-bit.

**F2. `OBJ_ENCODING_INT` — when does it apply?**

When a string's value is an integer in [0..9999] (using shared int
pool) or any integer fitting in `long`. The `ptr` field directly
stores the integer cast to `void*` — no SDS allocation.

**F3. Why does setting `maxmemory-policy allkeys-lfu` cost a few
percent more memory than `noeviction`?**

LFU disables shared-integer-object sharing (because the LFU counter
is per-`robj`, and shared `robj`s can't have meaningful per-key
counters). Each integer counter now gets its own `robj`+SDS instead
of pointing at `shared.integers[N]`.

---

## Section G: Memory & Eviction (Ch 8)

**G1. `mem_fragmentation_ratio` is 1.8. What does that mean and what
do you do?**

Ratio of RSS / used_memory. 1.8 means RSS is 80% larger than the
data — significant external fragmentation. Steps: enable
`activedefrag yes` (jemalloc-only), tune thresholds, monitor for
improvement. If the workload churns small allocations this is normal;
if it's a long-running server, defrag should help.

**G2. Approximate LRU vs true LRU — what's the trade-off?**

True LRU needs a doubly-linked list pinned at every access, ~16 bytes
per key — 16 GB for a billion keys. Redis samples `maxmemory-samples`
random keys and evicts the oldest. With samples=5, the chosen key is
"oldest of 5 random keys" — close enough for cache workloads.

**G3. LRU vs LFU — when each?**

LRU = "evict the key not touched recently." LFU = "evict the key not
touched often." For caches with long-tail access patterns (lots of hits
on a few keys, very few hits on most), LFU wins on hit rate. For
recency-sensitive caches (newest is hottest), LRU wins.

**G4. The LFU counter is 8 bits. How does it represent millions of
hits?**

Probabilistic increment (Morris-style). With `lfu-log-factor 10`, going
from counter=100 to 101 takes ~100 hits. The 8 bits represent **rank
ordering** of access frequency, not absolute count.

**G5. Active expiry — how does it work?**

`serverCron` runs `activeExpireCycle` every 100 ms. Samples 20 random
keys from `db->expires`; expires those that are due. If >25% were
expired, repeat on the same db. Stops at the time budget (default 25 ms
per cycle for slow mode). FAST mode runs in `beforeSleep` for ≤1 ms
total.

**G6. `SET k v EX 60` vs `SET k v; EXPIRE k 60` — same?**

Atomicity differs. The two-command pattern has a window where the key
exists without TTL. If Redis crashes, the key has no expire forever.
Always use `EX` / `PX` / `EXAT` / `PXAT` arguments to `SET`.

---

## Section H: Persistence (Ch 9-10)

**H1. RDB vs AOF — when each?**

RDB: periodic binary snapshots; fast restart, compact, easy to back
up. RPO = save interval (minutes). AOF: continuous command log;
RPO ≤ 1 second with `appendfsync everysec`. Most production: both.

**H2. Walk through what fork() does for BGSAVE.**

[BANK] Parent calls `fork()`. Kernel allocates new process with
**page tables copied** (data pages shared, marked read-only). Child
walks the keyspace and serializes to RDB. Parent keeps serving traffic;
on writes, COW kicks in: kernel allocates fresh page, copies original,
maps it writable into parent. Child exits. Parent's RSS may have
grown by the count of dirtied pages.

[DEPTH] Page table copy itself takes O(virtual memory size) and is on
the **main thread** — fork pause grows with dataset. Linux's
Transparent Huge Pages magnify COW dirtying by 512x (2 MB pages
instead of 4 KB). Disable THP.

**H3. Why do we sometimes OOM during BGSAVE?**

COW dirtying. If a write hits a previously-shared page, the kernel
allocates a fresh page → parent RSS grows. With high write rate during
fork, RSS can grow significantly. Combined with existing data, it can
exceed `maxmemory` or even box RAM.

**H4. `appendfsync` levels — performance and durability?**

- `always`: fsync after every write. RPO=0. ~200-1000 ops/sec.
- `everysec` (default): BIO fsyncs once per second. RPO≤1s. Near
  in-memory throughput.
- `no`: kernel decides. RPO ~30s. Maximum throughput.

**H5. AOF rewrite — why does it fork too?**

Same reason as RDB: produce a consistent snapshot without freezing.
The rewrite emits a minimal command set (or hybrid: RDB preamble +
diff). All COW concerns apply.

**H6. Hybrid AOF (`aof-use-rdb-preamble yes`) — what is it?**

The AOF file's head is an RDB binary dump; its tail is RESP commands
since the rewrite started. Loading is much faster (RDB parser is ~10x
faster than RESP replay) and the file is ~3-5x smaller.

**H7. AOF is corrupt mid-command after a crash. What happens?**

If `aof-load-truncated yes` (default), Redis loads up to the last
valid command and continues. Otherwise, it refuses to start; you must
`redis-check-aof --fix`.

**H8. `WAIT N timeout` does what?**

Blocks the calling client until N replicas confirm receipt of the
client's last write OR `timeout` ms elapses. Returns the count of
replicas confirmed. Doesn't make replication synchronous —
acknowledges *after* the fact. Combined with `appendfsync always`,
gives durable-on-disk + propagated semantics at high latency.

---

## Section I: Replication (Ch 11)

**I1. PSYNC2 — what's the protocol?**

Replica reconnects with `PSYNC <last_replid> <last_offset+1>`. Primary
checks: matching replid + offset within `repl_backlog_size` → return
`+CONTINUE` and stream missing bytes. Otherwise → `+FULLRESYNC` with
new replid, then full RDB transfer.

**I2. The replication backlog — what is it?**

A circular buffer (default 1 MB; production typically 256 MB to
several GB) holding the last N bytes of the replication stream. Lets
disconnected replicas catch up via partial resync instead of full
sync. Sized as `(peak_write_rate × max_disconnect_window)`.

**I3. What's `replid2`?**

When a replica is promoted (after failover), it inherits the old
primary's replid as **replid2**. Other replicas at the old replid +
similar offset can partial-resync via replid2. Without this, every
failover would force every replica to do full resync.

**I4. Diskless sync — what is it?**

`repl-diskless-sync yes` makes the primary stream RDB bytes from the
forked child directly to the replica's socket, without writing to
local disk. Useful when disk is slow or you have multiple replicas
syncing simultaneously.

**I5. `min-replicas-to-write 1, min-replicas-max-lag 10` — what
does it do?**

Refuse writes unless ≥1 replica is connected and lagging ≤10s.
Fail-stop safety against split-brain. If both replicas die, primary
returns errors to clients.

---

## Section J: Sentinel (Ch 12)

**J1. SDOWN vs ODOWN.**

SDOWN (subjective): one sentinel hasn't heard a valid reply in
`down-after-milliseconds`. ODOWN (objective): a quorum of sentinels
agree SDOWN. Failover begins on ODOWN.

**J2. The leader election in Sentinel.**

When a sentinel sees ODOWN, it increments its epoch and asks other
sentinels for votes. Each sentinel votes once per epoch. Whoever gets
majority is leader. Leader picks the new primary (best replica by
priority, offset, runid).

**J3. Why an odd number of sentinels?**

To make majority deterministic. With even N, you can hit split-vote
scenarios. 3 sentinels (quorum=2) is the minimum; 5 (quorum=3) is
better.

**J4. The split-brain scenario.**

Network partition: primary on side A with one sentinel; majority of
sentinels on side B. Side B promotes a replica. Both primaries accept
writes. When partition heals, old primary becomes replica → its writes
during the split are lost.

Mitigation: `min-replicas-to-write` so the old primary stops accepting
writes when it loses replicas.

---

## Section K: Cluster (Ch 13)

**K1. Why 16,384 slots?**

`16384 = 2^14`. Each node's slot bitmap fits in 2,048 bytes — small
enough to send unconditionally in every gossip message. Granular enough
for 1000+ node clusters.

**K2. Hash tags — what and why?**

Anything between `{` and `}` in a key determines the slot. So
`{user:42}.profile`, `{user:42}.session`, `{user:42}.cart` all hash to
the same slot, allowing multi-key operations. Without hash tags, every
key is on its own slot/node and `MGET k1 k2` typically fails with
`CROSSSLOT`.

**K3. MOVED vs ASK redirect.**

MOVED: persistent — "this slot is now owned by that node, update your
slot map permanently." ASK: transient — "for this query only, ask the
other node." ASK is used during in-flight slot migration; the client
must send `ASKING` then the command.

**K4. Resharding — how does it work without losing keys?**

Source marks slot `MIGRATING`, dest marks `IMPORTING`. Migrate keys in
batches via `MIGRATE`. During migration:
- Key on source: served normally.
- Key already on dest: source returns `-ASK`, client follows up to
  dest with `ASKING`.
- Source slot empty: finalize, both nodes mark slot as belonging to
  dest, configEpoch bumps.

**K5. Cluster failover — how does it differ from Sentinel?**

Replicas of the failed primary race to become new primary, weighted by
replication offset. Election is by **other primaries**, not all nodes
(replicas of OTHER primaries don't vote). configEpoch bumps; gossip
propagates the new map.

**K6. `cluster-require-full-coverage yes` — meaning?**

Default behavior. If any slot has no live owner, the cluster refuses
**all** writes and (by default) reads. Set to `no` to keep serving the
slots that ARE covered. Less safe; sometimes operationally necessary.

---

## Section L: Pub/Sub & Streams (Ch 14)

**L1. PUBLISH cost?**

O(N + M) where N = subscribers to that channel, M = total pattern
subscribers (every pattern is checked against the channel name). Lots
of pattern subscribers = expensive PUBLISHes.

**L2. Why doesn't Pub/Sub persist messages?**

By design — fire-and-forget. Subscribers not connected at PUBLISH time
miss the message. Slow subscribers may be dropped (output buffer
limit). For durable messaging, use Streams.

**L3. Sharded Pub/Sub.**

`SPUBLISH`/`SSUBSCRIBE` route by channel hash slot. Channel only lives
on one cluster node. Avoids the all-nodes-broadcast cost of regular
PUBLISH in cluster mode.

**L4. Stream consumer groups — what's the PEL?**

Pending Entries List. Per-consumer-group state of "messages delivered
but not yet ACKed." Enables at-least-once delivery: if a consumer
crashes, `XCLAIM`/`XAUTOCLAIM` can transfer those pending messages to
a healthy consumer.

**L5. Streams vs Kafka — when each?**

Streams: low-medium throughput, sub-millisecond latency, operational
simplicity, KV co-located. Kafka: high throughput (100K+ msg/sec
sustained per partition), exactly-once with idempotence, log
compaction, multi-region replication, ecosystem.

---

## Section M: Transactions, Scripting (Ch 15)

**M1. Why no rollback in MULTI/EXEC?**

[BANK] Programming errors should be caught at dev time, not silently
rolled back at runtime. Rollback would require undo logs, adding cost
to every command. Single-thread execution provides atomicity for free.

[DEPTH] Errors split into queue-time (abort the whole transaction) and
execution-time (the one command fails, others continue). Use WATCH for
optimistic concurrency control.

**M2. WATCH — how does it work?**

`WATCH k1 k2` adds the keys to `db->watched_keys` mapped to the
current client. Any other client modifying those keys sets
`CLIENT_DIRTY_CAS` on watching clients. At EXEC time, if the flag is
set, EXEC returns nil (transaction aborted; client must retry).

**M3. EVAL vs MULTI/EXEC — when each?**

EVAL: complex logic with conditional branches, multiple operations
deciding based on intermediate results. Single round trip. MULTI/EXEC:
when WATCH is the right concurrency primitive, or for simple
"command grouping."

**M4. Lua script timeout — what happens?**

After `lua-time-limit` ms (default 5 sec), the server starts processing
only `SCRIPT KILL` (kills the script if no writes have happened) and
`SHUTDOWN NOSAVE`. Other clients see their commands queue up. **Don't
write infinite loops.**

**M5. Functions vs EVAL — when each?**

Functions: persistent (in dataset, replicated), named, version-controlled
"stored procedures." EVAL/EVALSHA: ad-hoc, cached by hash. Use Functions
for stable code paths, EVAL for one-off operations.

---

## Section N: Caching Patterns (Ch 17)

**N1. Cache stampede — what's the right mitigation?**

Probabilistic early expiration (each client decides to refresh slightly
before TTL based on randomness), or single-flight locks (one client
refreshes; others wait), or background refresh (a worker keeps hot keys
fresh).

**N2. Cache-aside vs write-through?**

Cache-aside: app reads cache, falls back to DB on miss, writes to DB
and **invalidates** cache on update. Write-through: cache library
intercepts and handles fallback transparently. Mostly the same race
conditions.

**N3. Why is the stale-cache race a problem and how to fix?**

Client A reads (miss), starts loading from DB. Client B writes to DB,
invalidates cache. Client A finishes loading old DB value, populates
cache with stale data. Fix: invalidate-only-on-write (delete, not set);
use TTL backstop; consider versioned keys.

**N4. Redlock — should I use it?**

For cooperative mutual exclusion (debouncing, leader-election in
cron-like contexts) — fine. For resource integrity (only one process
writes to a database row) — use a system with fencing tokens
(ZooKeeper, etcd, DB advisory lock).

**N5. Distributed counter scaling.**

Single-key INCR caps at ~50K ops/sec on one Redis. For higher,
shard: increment a random shard `counter:N:shard{0..15}`; sum across
shards on read.

**N6. HyperLogLog — when?**

For cardinality estimation at scale. 12 KB per key regardless of true
cardinality, ~0.81% error. PFADD many users; PFCOUNT estimates unique
count. PFMERGE combines HLLs across keys (e.g., merge daily HLLs to
get a weekly DAU estimate).

---

## Section O: Performance & Operations (Ch 18)

**O1. p99 latency tripled overnight. Where do you start?**

`SLOWLOG GET 100`. 90% of incidents are explained by a new slow
command. `INFO commandstats` for `usec_per_call`. Look for new top
entries (often a new admin endpoint with `KEYS`).

**O2. Big keys — how to find them?**

`redis-cli --bigkeys` (counts elements) or `--memkeys` (counts bytes).
SCAN-based, safe but slow. Don't run on a primary at peak.

**O3. Hot keys — how to find them?**

`redis-cli --hotkeys` (requires `*-lfu` policy and uses OBJECT FREQ),
or sample with `MONITOR | sort | uniq -c | sort -rn`.

**O4. `aof_pending_bio_fsync` is 50. Meaning?**

The BIO fsync queue depth. fsync isn't keeping up with writes.
Probably slow disk; could also be storage temporarily stalled. Check
disk health and queue depths.

**O5. Replicas keep disconnecting — what's the typical loop?**

Replica falls behind → output buffer hits
`client-output-buffer-limit replica` → primary disconnects → replica
reconnects → backlog window exceeded → full resync → during sync,
output buffer fills again → cycle. Fix: bump output buffer limit
**and** repl-backlog-size **and** investigate replica I/O bottleneck.

---

## Section P: Security (Ch 19)

**P1. Why was unauthenticated Redis on the internet such a problem?**

Default config bound to all interfaces (pre-2015), no password, allowed
`CONFIG SET dir ; CONFIG SET dbfilename ; BGSAVE` to write
`/etc/cron.d/...` or `~/.ssh/authorized_keys`. Easy RCE.

**P2. Protected mode does what?**

Refuses non-loopback connections if no password is set. Acts as a
"forgot to configure" backstop.

**P3. ACL example: a backup script that runs `BGSAVE` and `INFO`?**

```
ACL SETUSER backup on >password ~* +bgsave +info
```

`backup` user can do `BGSAVE` and `INFO`, nothing else.

**P4. Should I enable TLS?**

Yes in production, even on private networks. Defense in depth. Costs
~10-30% CPU; I/O threads help mitigate.

---

## Section Q: Valkey Fork (Ch 20)

**Q1. Why did the fork happen?**

Redis Inc. relicensed from BSD to dual SSPL/RSAL in March 2024 to
prevent cloud providers from offering managed Redis without
contributing back. Linux Foundation immediately forked under BSD =
Valkey, sponsored by AWS, Google, Oracle, Ericsson, Snap.

**Q2. Are Redis and Valkey compatible?**

Wire protocol: yes. RDB/AOF formats: yes. Client libraries: yes. The
engines diverge over time at the source level (Valkey 8 has
multi-threaded primary execution for some commands; new commands; etc.)
but APIs remain compatible.

**Q3. Should I use Redis 8 or Valkey 8?**

If you need built-in modules (RedisJSON, RediSearch, etc.) → Redis 8.
If you need permissive license + community governance → Valkey 8.
Otherwise it's a coin flip; the engines are 95% the same.

---

## Practice Question Answers

(Selected — many questions in earlier chapters benefit from re-reading
the chapter rather than a one-line answer here.)

**Ch 1 Q1**: Postgres SELECT goes through the parser, optimizer,
plan tree, executor, page cache lookup with locking, MVCC visibility
check, then format the row. Redis GET is one hash lookup + one
RESP-encode + one `addReplyBulk`. The plan/optimize/MVCC layers cost
real time even on cached data. (Plus Redis avoids syscalls except
`epoll_wait`, `read`, `write`.)

**Ch 1 Q2**: They get sharding for free. They lose memory efficiency
(per-process overhead × 16 = lots of waste); they need a sharding
client library; they lose unified `INFO`/monitoring; cluster is
usually better.

**Ch 1 Q3**: The single-threaded server is processing the LRANGE
inline. The `GET` from another client is queued. Server processes one
command at a time.

**Ch 5 Q1**: SCAN walks every bucket once. Cost = O(total buckets) +
matching cost. With COUNT=1000, you get back ~1000 keys per call
(rough; actual count varies). Only the keys returned to the client
are filtered against MATCH. So 100M keys → ~100K SCAN calls; per-call
cost ~30 µs server-side; total ~3 seconds spread across many calls
without blocking.

**Ch 9 Q1**: `fork()` allocates a new process, copies the parent's
**page table** (not data pages). At 80 GB RSS = 20M page table entries
× 8 bytes = ~160 MB to copy. Takes ~200-500 ms. The main thread is
paused during fork.

**Ch 11 Q1**: 90 seconds × 10 MB/s = 900 MB needed; backlog is 256 MB.
Partial resync fails; full resync triggers.

**Ch 12 Q1**: SDOWN on sentinel1; not enough for ODOWN. No failover.

**Ch 13 Q1**: 16,384 = 2^14, fits in 14 bits. Bitmap is 2,048 bytes —
small enough to gossip every PING. Granular enough for 1000+ node
clusters.

**Ch 15 Q1**: Safe atomically (no other commands interleave). NOT safe
in any multi-Redis sense (replica may lag; primary fail-over may lose
the write). For real bank-grade atomicity, use Postgres + Redis cache,
not Redis as the system of record.

**Ch 17 Q1**: Cache miss → load → write cached value. Concurrent write
to DB → invalidate cache. Original load races and writes back stale.
Fix: delete-only-on-write + TTL backstop.

**Ch 18 Q1**: `SLOWLOG GET 100`. `INFO commandstats`. `INFO memory`.
`INFO replication`. `LATENCY DOCTOR`. Look at deploy diff for new code
paths. Look at replica lag, fork events, eviction rate.

---

## Final Words

If you read every chapter and worked the practice questions, you can
probably now talk about Redis the way its authors do. The engine is
not magic — it's a small set of simple ideas (single thread + RAM +
event loop + hand-tuned data structures) executed with extraordinary
care. The same pattern shows up in every subsystem: pick the simplest
algorithm that works, profile, optimize, repeat.

The two most important takeaways:

1. **Redis is a programming model**, not just a database. It rewards
   knowing the data structures, the commands, and the cost model.
   Senior engineers who know when to reach for it produce systems that
   are 10x simpler than those that don't.

2. **Single-threaded execution is the bargain.** Everything else —
   atomicity, predictability, simplicity — flows from it. The cost is
   per-key throughput ceilings and slow-command sensitivity. Plan for
   both.

Now go open `valkey/src/server.c` and read it for the third time.

---

> "Anyone can build a fast database. Building one that is fast,
>  obviously correct, and easy to operate is the rare achievement."
>
> — paraphrased; in the spirit of the Redis project's two decades of
>   careful work
