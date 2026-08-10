# Chapter 6: Skiplists, Listpacks & Quicklist

> Beyond the hashtable, Redis lives or dies on three less-famous structures:
> the **skiplist** (powering sorted sets), the **listpack** (the cache-friendly
> packed array that replaced ziplist), and the **quicklist** (a linked list
> of listpacks, powering Redis lists). All three exist because the obvious
> answers — B-Tree, doubly-linked list, big array — were measurably worse.
> This chapter walks through each one, why it exists, and when its encoding
> kicks in.

---

## 6.1 Skiplist: The Sorted Set's Backbone

Sorted sets (`ZADD`, `ZRANGE`, `ZRANGEBYSCORE`, `ZRANGEBYLEX`) need:

- **O(log n) insert / delete / lookup by score**
- **O(log n) rank queries** ("what's the rank of element X?")
- **O(log n + m) range queries** by score or rank, returning m results in order

Redis chose a **skiplist** instead of a B-Tree or a balanced binary tree.
Why? Because a skiplist:

1. Is simpler to implement and audit (~300 lines of C vs ~1000 for a robust
   B-Tree).
2. Has the same O(log n) expected performance.
3. Supports range queries trivially (the bottom level *is* a sorted linked
   list).
4. Has less memory overhead per element than a B-Tree (no internal pages).
5. Is simpler to make concurrent (we don't need this here, but it's a known
   property — Java's `ConcurrentSkipListMap` exists for the same reason).

The skiplist was invented by William Pugh in 1990 for exactly these reasons.

### 6.1.1 The Structure

```c
// server.h
#define ZSKIPLIST_MAXLEVEL 32
#define ZSKIPLIST_P 0.25

typedef struct zskiplistNode {
    sds ele;
    double score;
    struct zskiplistNode *backward;
    struct zskiplistLevel {
        struct zskiplistNode *forward;
        unsigned long span;        // number of nodes between this and forward
    } level[];                      // flexible array, 1..ZSKIPLIST_MAXLEVEL
} zskiplistNode;

typedef struct zskiplist {
    struct zskiplistNode *header, *tail;
    unsigned long length;
    int level;                      // max level currently used
} zskiplist;
```

A skiplist is a stack of sorted linked lists. The bottom (level 0) contains
every element. Each higher level is a sparser sample of the level below it.
A node is "tall" with probability (1/4)^k for level k.

```
   level 4:  H -------------------------------------------> T
   level 3:  H ---------------> 5 -------------> 11 ------> T
   level 2:  H -------> 2 ----> 5 ----> 8 -----> 11 ------> T
   level 1:  H -> 1 -> 2 ----> 5 -> 7 -> 8 -> 9 -> 11 ----> T
   level 0:  H -> 1 -> 2 -> 3 -> 5 -> 7 -> 8 -> 9 -> 11 -> T
                                            (sorted by score, then ele)
                                                 each node has a `backward` ptr
                                                 (only at level 0)
                                                 to support reverse iteration
```

To find element X with score s:
1. Start at the highest level of the head sentinel.
2. Walk forward while next node's score is < s (or score == s and ele < X).
3. When you can't go forward anymore, drop down a level.
4. Repeat until you're at level 0.
5. Either you hit X, or X isn't there.

Expected time: O(log n). Expected space: O(n) total (with average ~1.33
forward pointers per node at p=0.25).

### 6.1.2 The Level Distribution

```c
int zslRandomLevel(void) {
    int level = 1;
    while ((random() & 0xFFFF) < (ZSKIPLIST_P * 0xFFFF))
        level++;
    return (level < ZSKIPLIST_MAXLEVEL) ? level : ZSKIPLIST_MAXLEVEL;
}
```

`ZSKIPLIST_P = 0.25` means each node has a 25% chance of being promoted to
the next level. Expected levels per node: 1 + 0.25 + 0.25² + ... = 1.33.

`ZSKIPLIST_MAXLEVEL = 32` caps the height. With p=0.25 and max=32, the
skiplist supports up to 4^32 ≈ 1.8 × 10^19 elements before the level
distribution breaks down — astronomically more than any sorted set we'd
ever store in RAM.

>>> **Interview insight**: "Why p = 0.25 and not 0.5?" Lower p → fewer
>>> forward pointers per node → less memory. Higher p → fewer levels needed
>>> to traverse → fewer cache misses per search. Pugh's original paper used
>>> 0.5; Redis empirically found 0.25 was a better balance for typical
>>> workload sizes and CPU caches.

### 6.1.3 The `span` Field: Rank in O(log n)

`level[k].span` is the number of bottom-level nodes between this node and
its forward neighbor at level k. This is the secret that lets `ZRANK` and
`ZREVRANK` be O(log n):

```
   level 2 with spans:    H[span=4] -> N5[span=3] -> N11[span=∞] -> T
   level 0:               H -> N1 -> N2 -> N5 -> N7 -> N8 -> N11 -> T
```

To compute the rank of N7: walk down the same way as a search, **summing
the spans you pass over**. Sum them up; that's the rank.

Without `span`, you'd have to count nodes by walking level 0 — O(n).

### 6.1.4 The Sorted Set Combo: Skiplist + Hashtable

Sorted sets need O(1) score lookup by member (e.g., `ZSCORE`) and O(log n)
ranking. A skiplist gives you ranking; a hashtable gives you score lookup.
Redis uses **both, in tandem**:

```c
typedef struct zset {
    dict *dict;            // member -> *score
    zskiplist *zsl;        // sorted by score, then by member
} zset;
```

Every entry exists in both. They share the SDS for `member` (refcount based)
to avoid duplication. When you `ZADD member score`:

1. Hash table lookup to see if member exists.
2. If yes and score changed: remove old skiplist entry, insert new skiplist entry, update score in hashtable.
3. If no: insert into both.

Total cost: O(log n) for insert/update. O(1) for score lookup. O(log n + m)
for range queries.

>>> **Interview insight**: When asked "how would you implement a leaderboard
>>> with rank?" the answer is "use a Redis sorted set." The skiplist+hash
>>> dual gives you O(log n) for `ZADD` and `ZRANK`, O(log n + m) for
>>> `ZREVRANGE` to get the top-N. We dive into leaderboard sizing in Chapter 21.

### 6.1.5 Where the Encoding Switches: Listpack → Skiplist

Small sorted sets (≤ `zset-max-listpack-entries`, default 128, with
all elements ≤ `zset-max-listpack-value`, default 64 bytes) use a **listpack**
instead of a skiplist+hash. We get to listpacks in §6.3.

Once *either* threshold is exceeded, the sorted set converts to skiplist+hash.
The conversion is a one-way trip — Redis does not downgrade encoding even
if entries are deleted.

---

## 6.2 The Old `ziplist`, the New `listpack`

Before listpack there was **ziplist**. Both are "compact arrays of variable-length
entries packed into a contiguous buffer." Listpack is the v2: simpler, faster,
fixed two long-standing bugs, and is fully replacing ziplist across all data
types.

### 6.2.1 Why Pack at All?

Imagine storing a small Redis hash with 5 fields. Three options:

1. **A `dict`**: 5 entries × ~32 bytes/entry + bucket array + dict struct =
   ~250 bytes. Plus jemalloc overhead per entry.
2. **A `linkedList`**: 5 nodes × 24 bytes + payload pointers + payloads = ~150 bytes.
3. **A packed array**: 5 length-prefixed values in one allocation, walked
   sequentially = ~80 bytes total.

For small collections (≤128 entries), the packed array wins on memory by
~2-5x and on cache locality (one allocation, one cache line walk). The cost
is O(N) operations, but for N=5..128 that's faster than the cache misses
of a chained hashtable.

This is the same reason Java has `ArrayList` vs `LinkedList`, or why
specialised "small-vector" types like `SmallVec`/`InlineVec` exist in
embedded code.

### 6.2.2 Ziplist (deprecated): The Original

Ziplist's layout was:

```
   <zlbytes(4)> <zltail(4)> <zllen(2)> <entry0> <entry1> ... <entryN-1> <zlend(0xff)>

   each entry:
     <prevlen(1 or 5 bytes)> <encoding(1-5 bytes)> <data(variable)>
```

`prevlen` was the killer feature **and** the wart: it stored the length of the
preceding entry, encoded as 1 byte (if < 254) or 5 bytes. This let you walk
backward from the tail. But it had a cascading-update bug: if you inserted/grew
an entry to length 254, *the next entry's prevlen field grew from 1 to 5
bytes*, which could itself push past 254, and so on. In the pathological case,
a single insert triggered O(N²) updates.

This is the "**cascading update**" bug. It was theoretically O(N²) and
practically rare, but enough to motivate replacement.

### 6.2.3 Listpack: The Replacement

Listpack uses **forward+backward length encoding inside each entry** instead
of "previous entry length":

```
   <total_bytes(4)> <num_elements(2)> <entry0> <entry1> ... <entryN-1> <listpack_end(0xff)>

   each entry:
     <encoding+data(variable)> <backlen(1-5 bytes encoding length-of-this-entry)>
```

Each entry stores its **own** total length at the end (`backlen`), not the
length of its predecessor. To walk backward from position P you read the
last few bytes before P (they encode `backlen`), subtract that, and you're
at the start of the previous entry. **No cascading updates.**

The encoding byte distinguishes:

| First-byte pattern | Type | Range |
|--------------------|------|-------|
| `0xxxxxxx` (1 byte) | 7-bit unsigned int | 0..127 |
| `10xxxxxx` (1 byte + len bytes) | small string | up to 63 bytes |
| `110xxxxx xxxxxxxx` (2 bytes) | 13-bit signed int | -4096..4095 |
| `1110xxxx xxxxxxxx` (2 bytes + len bytes) | medium string | up to 4095 bytes |
| `11110000` + 4-byte len | large string | up to 4 GB |
| `11110001` (3 bytes) | 16-bit signed int | -32768..32767 |
| `11110010` (4 bytes) | 24-bit signed int | |
| `11110011` (5 bytes) | 32-bit signed int | |
| `11110100` (9 bytes) | 64-bit signed int | |

Tiny ints fit in one byte, small strings have minimal header. A list of 100
small integers packs into ~120 bytes. Compare to a skiplist of 100 ints:
~6000 bytes.

Source: `listpack.c` — concise (~1500 lines), heavily commented.

>>> **Interview insight**: "When would you choose a listpack over a real
>>> data structure?" When the collection is small AND elements are small.
>>> The break-even with skiplist/dict is around 64-128 entries. Above that,
>>> the O(N) operations dominate the cache benefits.

### 6.2.4 Listpack Operations Are All O(N)

`lpFirst`, `lpNext`, `lpPrev` are O(1). `lpInsert`, `lpDelete`, `lpFind`,
`lpReplace` are O(N) because they may need to memmove the rest of the buffer.
This is fine for small collections (a memmove of <2 KB is faster than a hash
lookup) but pathological for large ones.

Hence the encoding switch.

---

## 6.3 The Conversion Thresholds

Each compound type has two thresholds: max entries and max element size.
Cross either one and Redis converts to the "real" structure.

```
hash-max-listpack-entries 128       (was hash-max-ziplist-entries)
hash-max-listpack-value 64

list-max-listpack-size -2           (special encoding, see §6.4.2)
list-compress-depth 0

set-max-listpack-entries 128
set-max-listpack-value 64
set-max-intset-entries 512

zset-max-listpack-entries 128
zset-max-listpack-value 64
```

| Type | Small encoding | Large encoding | Trigger |
|------|----------------|----------------|---------|
| Hash | listpack | hashtable | > 128 fields OR any field/value > 64 bytes |
| List | listpack (in quicklist nodes) | quicklist | always quicklist; list-max-listpack-size controls per-node |
| Set | listpack OR intset | hashtable | > 128 entries / non-int / large element |
| Sorted Set | listpack | skiplist+hash | > 128 entries OR element > 64 bytes |

(!) **Production hazard**: tuning these thresholds upward saves memory (more
  listpack stickiness) but costs CPU (O(N) insert in larger packs). Default
  128 is the sweet spot for most workloads. **Never raise them beyond ~512
  without measuring.**

### 6.3.1 No Auto-Downgrade

Once a hash converts from listpack to hashtable, it stays that way even if
you delete fields. If memory matters, you must `DEL` the key and recreate.

---

## 6.4 The List: A Quicklist of Listpacks

Redis lists (`LPUSH`, `RPUSH`, `LPOP`, `RPOP`, `LRANGE`) need:

- O(1) push/pop on either end (queue/deque)
- O(N) iteration (acceptable)
- Compact memory layout (lists are often big)
- Resilience to "head and tail are popular, middle is slow" patterns

The 2009-era answer was a **doubly linked list of values**. Cheap to push/pop
but each node is a `(prev, next, payload_ptr)` triple — 24 bytes of overhead
per element. For a list of small integers, overhead dominated.

The 2014 answer was a **ziplist for small lists, linked list for big**.
Two encodings, an explicit conversion. Cumbersome.

The current answer (Redis 3.2+) is **quicklist**: a doubly linked list whose
**nodes are listpacks**. Each node holds many elements; the list has few
nodes. Best of both.

```
   quicklist (head -> ... -> tail):

      +-----+      +-----+      +-----+
      | N0  | <--> | N1  | <--> | N2  |  (linked list of nodes)
      +-----+      +-----+      +-----+
        |             |            |
        v             v            v
      [a b c d e]   [f g h i j]  [k l m n]   (each is a listpack)
```

```c
// quicklist.h
typedef struct quicklist {
    quicklistNode *head;
    quicklistNode *tail;
    unsigned long count;       // total elements
    unsigned long len;         // number of nodes
    signed int fill : 16;      // -2 (8KB) by default; or positive entry-count
    unsigned int compress : 16;
} quicklist;

typedef struct quicklistNode {
    struct quicklistNode *prev;
    struct quicklistNode *next;
    unsigned char *entry;      // pointer to listpack OR LZF-compressed buffer
    size_t sz;
    unsigned int count : 16;       // listpack entries in this node
    unsigned int encoding : 2;     // RAW or LZF
    unsigned int container : 2;    // PLAIN (single big element) or PACKED (listpack)
    unsigned int recompress : 1;
    ...
} quicklistNode;
```

### 6.4.1 The Per-Node Fill Limit

`list-max-listpack-size` controls how big each listpack node can be:

| Value | Meaning |
|-------|---------|
| `-1` | Each node max 4 KB |
| `-2` | Each node max 8 KB **(default)** |
| `-3` | Each node max 16 KB |
| `-4` | Each node max 32 KB |
| `-5` | Each node max 64 KB |
| Positive (e.g., `128`) | Each node max N entries |

Negative defaults trade off: bigger nodes = better compression, fewer pointer
hops, slower per-operation insert. -2 (8 KB) is a sweet spot for typical
queue workloads.

### 6.4.2 The PLAIN Container

If a single element is larger than the configured fill size (e.g., a 100 KB
JSON blob in a list), it gets its own node with `container = PLAIN` —
just a raw allocation, not a listpack. This prevents one giant element from
dominating a listpack and slowing down other operations on the same node.

### 6.4.3 LZF Compression on the Middle

`list-compress-depth N` enables LZF compression on inner nodes:

| Value | Behavior |
|-------|----------|
| `0` | No compression (default) |
| `1` | Compress all nodes except the head and tail |
| `2` | Compress all except head, tail, and 1 node in from each side |
| `N` | Compress all except the N nearest each end |

Use case: a queue. Producers push to one end, consumers pop from the other.
Most operations only touch the ends. The middle of a 10 GB list — entries
that have been pushed but not consumed for hours — are cold. Compressing them
saves significant memory at minimal CPU cost (decompression only happens when
the cold node is touched).

### 6.4.4 LPUSH / RPUSH / LPOP / RPOP at O(1)

```c
void quicklistPushHead(quicklist *quicklist, void *value, size_t sz) {
    quicklistNode *orig_head = quicklist->head;
    if (likely(_quicklistNodeAllowInsert(orig_head, quicklist->fill, sz))) {
        quicklist->head->entry = lpPrepend(quicklist->head->entry, value, sz);
        quicklistNodeUpdateSz(quicklist->head);
    } else {
        quicklistNode *node = quicklistCreateNode();
        node->entry = lpPrepend(lpNew(0), value, sz);
        _quicklistInsertNodeBefore(quicklist, orig_head, node);
    }
    quicklist->count++;
    quicklist->head->count++;
}
```

If the head listpack has room, prepend to it (O(N) inside the listpack but
N is small — typically <100 entries). Otherwise allocate a new head node
and link it.

### 6.4.5 LRANGE Is Where It Hurts

`LRANGE k 0 -1` walks the whole quicklist, decompressing as it goes,
copying every element to the reply buffer. For a 1M-element list this is a
multi-second blocking operation. **Don't do this on big lists.** Use
`LRANGE k 0 99` to page.

>>> **Interview insight**: Quicklist's design is a perfect example of "two
>>> levels of indirection bought us flexibility." Linked list at the macro
>>> level → cheap push/pop; listpack at the micro level → cache-friendly
>>> packing. Redis hides both behind one user-facing type.

---

## 6.5 The Set: intset, listpack, hashtable

Sets have THREE possible encodings:

### 6.5.1 `intset` — All Integer Sets

If every member is a 64-bit integer and there are ≤ `set-max-intset-entries`
(default 512), Redis uses an **intset**: a *sorted* array of integers,
in a fixed-width format that grows as needed.

```c
typedef struct intset {
    uint32_t encoding;   // INTSET_ENC_INT16, INT32, or INT64
    uint32_t length;
    int8_t contents[];   // packed array of fixed-width ints
} intset;
```

If all values fit in int16, encoding=INT16 (2 bytes/element). Otherwise INT32
or INT64. Adding a value larger than the current encoding upgrades the whole
array (rare but happens).

Lookup is binary search on the sorted array — O(log n). Memory is rock-bottom:
~2-8 bytes per element plus 8-byte header.

>>> **Interview insight**: Why a sorted array and not a hashtable for small
>>> integer sets? Cache locality. Binary search over a 50-element int16 array
>>> is two cache lines. A hashtable lookup is one cache line for the bucket
>>> + one for the entry. The math is similar, but the array uses 1/3 the
>>> memory.

### 6.5.2 `listpack` — Small General Sets

If the set has non-integer elements but stays small (≤ 128 entries, each
≤ 64 bytes), it uses a listpack.

### 6.5.3 `hashtable` — General Case

Beyond either threshold, the set is a `dict` with NULL values (we only care
about key presence).

### 6.5.4 The Encoding Choice At a Glance

```
   SADD myset 1 2 3                  -> intset (3 small ints)
   SADD myset 4 5 ... 600            -> intset → hashtable (>512 entries)
   SADD myset "hello"                -> intset → listpack (non-integer)
   SADD myset "string longer than 64 bytes ..."  -> listpack → hashtable
```

`OBJECT ENCODING myset` shows the live encoding.

---

## 6.6 The Hash: listpack and hashtable

Same idea as sets:

- ≤ `hash-max-listpack-entries` AND every key+value ≤ `hash-max-listpack-value`
  → **listpack** (alternating key, value, key, value, ...)
- Either threshold exceeded → **hashtable** (`dict` with SDS fields and `robj`
  values, although values are flattened into SDS strings inline if they're
  pure strings).

A small hash with 10 fields fits in ~150 bytes total; the same data as
separate keys would cost ~1500 bytes. **Always prefer Redis hashes over
many tiny keys with a shared prefix** (e.g., `user:42:name`, `user:42:email`,
... versus `HSET user:42 name "..." email "..."`).

This is sometimes called the "hash trick" for memory savings:

```
   1 million users × 5 string fields, separate keys:    ~250 MB
   1 million users × 5 string fields, hash per user:    ~70 MB
                                                  (3.5x improvement)
```

The trade-off: you can't TTL individual fields. Hash-level TTL only.

(Redis 7.4 added per-field TTL with `HEXPIRE`/`HEXPIREAT`/`HEXPIRETIME` but
the field encoding requires the hash to be in `listpack-ex` or `hashtable-ex`
encoding — and the savings disappear because we now store an extra timestamp
per field. Use sparingly.)

---

## 6.7 Streams: The Radix Tree (Brief Mention)

Streams (`XADD`, `XREAD`) use a **radix tree (rax)** keyed by the entry ID
(a 128-bit value: `<ms>-<seq>`). Each rax leaf stores a listpack of entries
that share an ID prefix.

A radix tree is a trie that compresses sequences of single-child internal
nodes. For monotonically-increasing IDs (which stream IDs are), the tree is
near-perfectly balanced and lookups are O(log n) in practice.

We come back to streams in Chapter 14.

---

## 6.8 Memory Cost Cheat Sheet

For the same data, here's the rough memory ratio between encodings:

| Data | listpack | "real" | Speedup of "real" beyond N |
|------|----------|--------|---------------------------|
| Hash with N small fields | ~16 bytes/field | ~80 bytes/field | N > ~50 |
| Sorted set with N small elements | ~24 bytes/element | ~80 bytes/element | N > ~100 |
| Set with N small ints | ~4 bytes (intset) | ~80 bytes (hashtable) | N > ~500 |
| List with N small elements | ~16 bytes (in quicklist listpack) | n/a (always quicklist) | n/a |

The "real" encoding starts winning on operations *beyond* the N break-even.
For heavily-modified small collections, listpack often wins on both memory
*and* CPU.

---

## 6.9 A Worked Example: Picking Encoding

Suppose you're modelling per-user notification preferences:

```
   {
     email: true,
     sms: false,
     push: true,
     digest_freq: "weekly",
     timezone: "America/New_York"
   }
```

Five small string/bool fields per user, 100 million users.

### Option A: 5 keys per user

```
   SET user:42:email true
   SET user:42:sms false
   SET user:42:push true
   SET user:42:digest_freq weekly
   SET user:42:timezone "America/New_York"
```

Memory: ~250 bytes/user × 100M = 25 GB.

### Option B: One hash per user (listpack-encoded)

```
   HSET user:42 email true sms false push true digest_freq weekly timezone "America/New_York"
```

Memory: ~150 bytes/user × 100M = 15 GB. **40% savings**, single round trip
to load all preferences, atomic update.

### Option C: One JSON string per user

```
   SET user:42 '{"email":true,"sms":false,...}'
```

Memory: ~100 bytes/user × 100M = 10 GB. Most compact. But: no field-level
update, must parse client-side, no `HGET user:42 email`. Bad for hot fields.

### Option D: RedisJSON module

```
   JSON.SET user:42 $ '{...}'
   JSON.GET user:42 $.email
```

Memory: ~120 bytes/user × 100M = 12 GB. Field-level `JSON.GET` and `JSON.SET`.
Module-only.

>>> **Interview insight**: "Reasonable defaults" depend on access patterns:
>>> - Hot fields, partial reads → Option B (hash)
>>> - Whole-document reads, rare updates → Option C (JSON string)
>>> - Document with deep nested structure → Option D (RedisJSON)
>>> - Pure key-value, every field independently TTL'd → Option A

---

## 6.10 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `t_zset.c` | Sorted set commands, skiplist algorithms |
| `listpack.h`, `listpack.c` | Listpack encoding/decoding |
| `quicklist.h`, `quicklist.c` | Quicklist node management |
| `intset.h`, `intset.c` | Integer set |
| `t_set.c` | Set commands (intset / listpack / hashtable encoding switches) |
| `t_hash.c` | Hash commands |
| `t_list.c` | List commands |
| `rax.h`, `rax.c` | Radix tree (used by streams and ACL parsing) |

`t_zset.c` is required reading for understanding skiplist + dict cooperation.

---

## Practice Questions

1. You're storing a leaderboard with 10 million users. Each `ZADD` call
   updates a score. What's the expected per-op cost? What if you swap to
   a hash with `HSET user:42 score 1234` instead?
2. The default `zset-max-listpack-entries` is 128. For a sorted set that
   grows to exactly 128 entries, what happens on the 129th `ZADD`? How much
   does it cost?
3. Why does Redis use a probabilistic skiplist instead of a deterministic
   balanced BST? What's lost?
4. A user reports that their list `LPUSH` performance gradually degrades.
   They have `list-compress-depth 1` and a list of ~2 million entries.
   Diagnose.
5. Listpack fixed ziplist's "cascading update" bug. What was that bug,
   in your own words? Why was it dangerous in practice?
6. Your hash has 50 fields. You set `hash-max-listpack-entries 1000` to
   keep it as a listpack and save memory. What goes wrong as the hash
   grows?
7. The skiplist's `span` field is an unsigned long (8 bytes per pointer
   per level). For a 10M-element zset with average 1.33 levels, estimate
   the skiplist memory overhead.

(Answers at end of Chapter 22.)
