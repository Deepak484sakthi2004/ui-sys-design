# Chapter 7: Object Encoding & Polymorphism

> Every value in Redis lives behind a tiny 16-byte struct called `redisObject`.
> That struct is the entire dispatch mechanism for "what kind of value is
> this and how is it laid out in memory?" Five high-level types (string, list,
> hash, set, sorted set, plus stream) × seven internal encodings = a polymorphism
> system implemented in two integers and a `void*`. This chapter shows you
> how that machinery works, when encodings switch, and why the abstraction is
> so thin.

---

## 7.1 The `redisObject` Struct

```c
// server.h
#define LRU_BITS 24

typedef struct redisObject {
    unsigned type:4;        // OBJ_STRING, OBJ_LIST, OBJ_SET, OBJ_ZSET, OBJ_HASH, OBJ_STREAM, OBJ_MODULE
    unsigned encoding:4;    // OBJ_ENCODING_*
    unsigned lru:LRU_BITS;  // last access time (LRU) or counter+age (LFU)
    int refcount;
    void *ptr;              // points to the actual data
} robj;
```

That's 16 bytes on a 64-bit system (4-bit packed type + 4-bit packed encoding +
24-bit lru in one word, then 4 bytes refcount, then 8 bytes ptr). Cache-line
friendly: an `embstr` lays the SDS *immediately after* the robj in the same
allocation, so reading the type and the data is one cache line.

```
   robj memory layout (16 bytes):

   +---------+---------+----------+----------+----------+----------+
   | type(4) | enc(4)  | lru(24)  | refcount(32)         | ptr(64)  |
   +---------+---------+----------+----------+----------+----------+
   |   bit-packed in one 32-bit word         | 4 bytes  | 8 bytes  |
```

Note: `refcount` is full 32-bit, not packed. Reference counting is hot — packing
would slow it down.

### 7.1.1 The Type Field (4 bits → 16 possible types)

```c
#define OBJ_STRING 0
#define OBJ_LIST   1
#define OBJ_SET    2
#define OBJ_ZSET   3
#define OBJ_HASH   4
#define OBJ_STREAM 6
#define OBJ_MODULE 5
```

Six standard types + module-defined. Used by every command for type checking.
`TYPE foo` returns the human name.

### 7.1.2 The Encoding Field (4 bits → 16 possible encodings)

```c
#define OBJ_ENCODING_RAW       0     // raw SDS
#define OBJ_ENCODING_INT       1     // shared int / encoded int in ptr
#define OBJ_ENCODING_HT        2     // hashtable (dict)
#define OBJ_ENCODING_ZIPMAP    3     // deprecated, never seen anymore
#define OBJ_ENCODING_LINKEDLIST 4    // deprecated (replaced by quicklist)
#define OBJ_ENCODING_ZIPLIST   5     // deprecated (replaced by listpack)
#define OBJ_ENCODING_INTSET    6
#define OBJ_ENCODING_SKIPLIST  7
#define OBJ_ENCODING_EMBSTR    8
#define OBJ_ENCODING_QUICKLIST 9
#define OBJ_ENCODING_STREAM    10
#define OBJ_ENCODING_LISTPACK  11
#define OBJ_ENCODING_LISTPACK_EX 12  // listpack with field TTL (Redis 7.4+)
```

The 4-bit field has room for 16; 7 are actively used today. Old encodings
(ziplist, linkedlist, zipmap) remain only for RDB backwards-compat — they're
loaded but never produced.

### 7.1.3 The Type → Encoding Matrix

| Type | Possible encodings | Common case |
|------|---------------------|-------------|
| String (`OBJ_STRING`) | INT, EMBSTR, RAW | EMBSTR for short, INT for numeric, RAW for big |
| List (`OBJ_LIST`) | LISTPACK, QUICKLIST | LISTPACK if small, QUICKLIST otherwise |
| Hash (`OBJ_HASH`) | LISTPACK, LISTPACK_EX, HT | LISTPACK if small, HT if big |
| Set (`OBJ_SET`) | INTSET, LISTPACK, HT | INTSET if all-int, LISTPACK if small mixed, HT otherwise |
| Sorted Set (`OBJ_ZSET`) | LISTPACK, SKIPLIST | LISTPACK if small, SKIPLIST + dict otherwise |
| Stream (`OBJ_STREAM`) | STREAM | always (rax tree of listpacks) |

`OBJECT ENCODING key` returns the encoding name as a string for any key.

```
> SET k 42
> OBJECT ENCODING k
"int"

> SET k "hello"
> OBJECT ENCODING k
"embstr"

> RPUSH l a b c
> OBJECT ENCODING l
"listpack"

> RPUSH l (... 200 more elements ...)
> OBJECT ENCODING l
"quicklist"
```

---

## 7.2 The LRU/LFU Field: Memory Aware Eviction Bookkeeping

The 24-bit `lru` field stores per-object information used by eviction policies.
Its meaning depends on `maxmemory-policy`:

### 7.2.1 LRU Mode (24-bit Truncated Time)

For `allkeys-lru`, `volatile-lru`:

```
   lru = (now_in_seconds & 0x00FFFFFF)    // 24-bit wraparound
```

That's 16,777,216 seconds = ~194 days before wraparound. The eviction
algorithm samples a few keys, picks the one with the smallest `lru`, evicts it.
Wraparound just means "very old keys look very fresh again" — handled by
the sampling logic (which wouldn't evict them anyway because there's almost
certainly something older to compare against in the next sample).

### 7.2.2 LFU Mode (8-bit Counter + 16-bit Time)

For `allkeys-lfu`, `volatile-lfu`:

```
   lru = decay_time(16) << 8 | counter(8)
   //      ^                       ^
   //   minutes since last decay   probabilistic counter
```

The 8-bit counter saturates at 255. Increments are *probabilistic* (Morris's
algorithm-style):

```c
double r = (double)rand()/RAND_MAX;
double baseval = counter - LFU_INIT_VAL;
if (baseval < 0) baseval = 0;
double p = 1.0/(baseval*server.lfu_log_factor+1);
if (r < p) counter++;
```

With `lfu-log-factor 10` (default), the counter rises slowly: ~10 hits
to go from 5→6, ~100 hits to go from 100→101. This compresses the count of
actual access frequency into 8 bits while preserving meaningful ordering
between hot and cold keys.

The decay subtracts a fixed amount from the counter periodically, so a
once-popular key doesn't stay popular forever. Controlled by
`lfu-decay-time` (default 1 minute).

We dive deeper into eviction policy comparison in Chapter 8.

---

## 7.3 The `refcount` Field: Lightweight Reference Counting

Refcount lets multiple `dict` entries (and other places) share an `robj`
without copying.

```c
robj *makeObjectShared(robj *o) {
    serverAssert(o->refcount == 1);
    o->refcount = OBJ_SHARED_REFCOUNT;     // INT_MAX
    return o;
}

void incrRefCount(robj *o) {
    if (o->refcount != OBJ_SHARED_REFCOUNT) o->refcount++;
}

void decrRefCount(robj *o) {
    if (o->refcount == 1) {
        switch (o->type) { ... type-specific destructor ... }
        zfree(o);
    } else if (o->refcount != OBJ_SHARED_REFCOUNT) {
        o->refcount--;
    }
}
```

### 7.3.1 Where refcounting matters

- **Shared integers**: `shared.integers[0..9999]` have `refcount == OBJ_SHARED_REFCOUNT`,
  so they're never freed. Many dict entries point to them.
- **Shared replies**: `+OK\r\n`, `+PONG\r\n`, common error messages are
  shared `robj`s reused across all clients.
- **Streams XADD**: stream entries hold refcounts on field/value SDS that
  can be shared across entries.

### 7.3.2 Where it's bypassed

- **Strings inside dict entries**: Most string values inside a hash/set/zset
  don't go through robj — they're stored as raw SDS in listpack/hashtable
  buckets. Refcount only applies to top-level keyspace values.
- **EMBSTR objects**: same allocation as the robj, freed when refcount hits 0.

>>> **Interview insight**: Why does Redis use refcounting and not garbage
>>> collection? Because GC introduces non-deterministic latency spikes that
>>> would destroy p99. Refcount frees instantly on the last reference,
>>> with no global pause.

(!) **Production hazard**: Refcounting is **not thread-safe**. The single-thread
  invariant relies on this. If you write a module with a worker thread and
  share `robj`s with the main thread without proper synchronisation, you'll
  see use-after-free crashes. The module API has explicit thread-safety
  helpers (`RedisModule_HoldGIL`).

---

## 7.4 Lifecycle: Create → Encode → Convert → Destroy

### 7.4.1 Creation

`object.c` provides factory functions:

```c
robj *createStringObject(const char *ptr, size_t len);
robj *createEmbeddedStringObject(const char *ptr, size_t len);
robj *createRawStringObject(const char *ptr, size_t len);
robj *createStringObjectFromLongLong(long long value);
robj *createStringObjectFromLongDouble(long double value, int humanfriendly);
robj *createListObject(void);          // returns empty listpack
robj *createQuicklistObject(void);
robj *createSetObject(void);            // listpack
robj *createIntsetObject(void);
robj *createHashObject(void);           // listpack
robj *createZsetObject(void);           // skiplist+dict
robj *createZsetListpackObject(void);
robj *createStreamObject(void);
```

`createStringObject` picks EMBSTR or RAW based on size (44-byte threshold).

### 7.4.2 Encoding Transitions

After every mutating command, the data type's command implementation
calls `<type>TryConversion`:

```c
// t_hash.c
void hashTypeConvertListpack(robj *o, int enc) {
    if (enc == OBJ_ENCODING_LISTPACK) {
        // already listpack
    } else if (enc == OBJ_ENCODING_HT) {
        // walk listpack, build dict, swap encoding
    }
}

void hashTypeTryConversion(robj *o, robj **argv, int start, int end) {
    if (o->encoding != OBJ_ENCODING_LISTPACK) return;
    size_t sum = 0;
    for (i = start; i <= end; i++) {
        if (sdslen(argv[i]->ptr) > server.hash_max_listpack_value) {
            hashTypeConvertListpack(o, OBJ_ENCODING_HT);
            return;
        }
        sum += sdslen(argv[i]->ptr);
    }
    if (lpSafeToAdd(o->ptr, sum) == 0)
        hashTypeConvertListpack(o, OBJ_ENCODING_HT);
}
```

The pattern: **on every mutation, check if encoding limits are still
satisfied**. If not, convert.

Conversion is one-way. There's a small symmetric counterpart for the very
specific case of "the dataset shrunk back below threshold" but it's
deliberately not aggressive — flapping conversion would be a CPU pit.

### 7.4.3 Destruction

When the last reference is dropped:

```c
void freeStringObject(robj *o) {
    if (o->encoding == OBJ_ENCODING_RAW) sdsfree(o->ptr);
}

void freeListObject(robj *o) {
    switch (o->encoding) {
        case OBJ_ENCODING_QUICKLIST: quicklistRelease(o->ptr); break;
        case OBJ_ENCODING_LISTPACK:  zfree(o->ptr); break;
    }
}

void freeHashObject(robj *o) {
    switch (o->encoding) {
        case OBJ_ENCODING_HT:       dictRelease((dict*) o->ptr); break;
        case OBJ_ENCODING_LISTPACK: zfree(o->ptr); break;
    }
}
```

For big compound types, `decrRefCount` is hideously expensive (free every
entry). This is why `UNLINK` exists: hand the object to a BIO thread instead
of freeing inline.

---

## 7.5 Type Checks at Command Entry

Every type-specific command starts with a type check:

```c
// t_string.c
void getCommand(client *c) {
    getGenericCommand(c);
}

int getGenericCommand(client *c) {
    robj *o = lookupKeyReadOrReply(c, c->argv[1], shared.null[c->resp]);
    if (o == NULL) return C_OK;
    if (checkType(c, o, OBJ_STRING)) return C_ERR;     // <--- type check
    addReplyBulk(c, o);
    return C_OK;
}
```

`checkType` returns 1 (and replies with `-WRONGTYPE`) if the object's type
doesn't match. This is why:

```
> SET k "hello"
> LPUSH k world
(error) WRONGTYPE Operation against a key holding the wrong kind of value
```

One key, one type. Forever (until `DEL` and recreate).

The single check is one bit-mask compare — essentially free.

---

## 7.6 The Encoding-Specific Dispatch Inside Commands

Within a command, code must handle every encoding the type can have. The
typical pattern:

```c
// t_hash.c (paraphrased)
void hsetCommand(client *c) {
    robj *o = lookupKeyWrite(c->db, c->argv[1]);
    if (o == NULL) {
        o = createHashObject();          // starts as listpack
        dbAdd(c->db, c->argv[1], o);
    } else if (o->type != OBJ_HASH) {
        addReplyError(c, "WRONGTYPE ...");
        return;
    }

    hashTypeTryConversion(o, c->argv, 2, c->argc - 1);     // may convert lp -> ht

    int updates = 0;
    for (int i = 2; i < c->argc; i += 2) {
        updates += hashTypeSet(o, c->argv[i]->ptr, c->argv[i+1]->ptr,
                               HASH_SET_COPY);
    }
    addReplyLongLong(c, updates);
    notifyKeyspaceEvent(NOTIFY_HASH, "hset", c->argv[1], c->db->id);
}

int hashTypeSet(robj *o, sds field, sds value, int flags) {
    if (o->encoding == OBJ_ENCODING_LISTPACK) {
        // find field via lpFind, replace or append
        ...
    } else if (o->encoding == OBJ_ENCODING_HT) {
        // dictAdd / dictReplace
        ...
    }
}
```

Two encoding cases, two implementations behind a single `hashTypeSet`.

>>> **Interview insight**: This is the entire "polymorphism" story for a C
>>> codebase. No vtable lookup, no virtual call. The encoding field is a
>>> small switch the compiler can sometimes inline. Branch prediction nails
>>> it after a few iterations because most operations on a given key have
>>> the same encoding.

---

## 7.7 OBJ_ENCODING_INT and Shared Integers Revisited

Because the integer encoding is so important — billions of counter-style
keys — let's pin down its mechanics.

When you `SET k 42`:

1. `setCommand` → `setGenericCommand` → `setKey`
2. The value `"42"` is parsed: `string2ll("42", 2, &value)` → `value = 42`.
3. We try to encode: `tryObjectEncoding(robj)`:

```c
robj *tryObjectEncoding(robj *o) {
    if (o->encoding != OBJ_ENCODING_RAW && o->encoding != OBJ_ENCODING_EMBSTR)
        return o;
    if (o->refcount > 1) return o;
    long value;
    char *s = o->ptr;
    if (sdslen(s) > 20 || !string2l(s, sdslen(s), &value)) return o;

    if (server.maxmemory == 0 ||
        !(server.maxmemory_policy & MAXMEMORY_FLAG_NO_SHARED_INTEGERS)) {
        if (value >= 0 && value < OBJ_SHARED_INTEGERS) {
            decrRefCount(o);
            incrRefCount(shared.integers[value]);
            return shared.integers[value];
        }
    }
    o->encoding = OBJ_ENCODING_INT;
    sdsfree(o->ptr);
    o->ptr = (void*) value;
    return o;
}
```

If the value parses as integer AND fits in 0..9999 AND we can use shared
ints (no LRU/LFU policy active), return the shared object. Otherwise convert
in-place: free the SDS, store the integer cast as `void*` in `ptr`,
encoding=INT.

(!) **Production hazard**: `MAXMEMORY_FLAG_NO_SHARED_INTEGERS` is set when
  any LRU/LFU policy is active. Why? Because the LRU/LFU bits live inside
  the `robj`, and a shared `robj` can't have meaningful per-key access
  bookkeeping. So enabling LFU **disables shared int sharing**, which can
  unexpectedly increase memory by a few percent.

---

## 7.8 Type-Encoding Concrete Examples

### 7.8.1 A small hash, then a big hash

```
> HSET prefs:42 theme dark lang en
(integer) 2
> OBJECT ENCODING prefs:42
"listpack"
> MEMORY USAGE prefs:42
(integer) 96

> for i in 1..200: HSET prefs:42 field${i} value${i}
> OBJECT ENCODING prefs:42
"hashtable"
> MEMORY USAGE prefs:42
(integer) 18564
```

Conversion happened around field 130 (when count exceeded 128).
Memory jumped from ~96 bytes to ~18 KB — roughly 90 bytes/entry on hashtable
versus 16 bytes/entry on listpack.

### 7.8.2 Sorted set demoting from listpack

```
> ZADD top 1 a 2 b 3 c
> OBJECT ENCODING top
"listpack"

> ZADD top 4 (... 200 more elements ...)
> OBJECT ENCODING top
"skiplist"
```

Once the threshold is crossed, the next operation will allocate the
skiplist+dict, copy each listpack entry across, and free the listpack.
This is a one-time O(N) cost — but for the *N* that just triggered it,
N is at most `zset-max-listpack-entries+1` (= 129 by default), so the cost
is bounded and small.

### 7.8.3 An intset upgraded by a non-int

```
> SADD nums 1 2 3 4 5
> OBJECT ENCODING nums
"intset"

> SADD nums "hello"
> OBJECT ENCODING nums
"listpack"
```

(One non-int value forces conversion.)

```
> SADD nums (... 600 more ints ...)
> OBJECT ENCODING nums
"hashtable"
```

(Past `set-max-listpack-entries` → hashtable.)

---

## 7.9 The Cost of `OBJECT` Commands

You can introspect freely:

| Command | Cost | What it returns |
|---------|------|-----------------|
| `OBJECT ENCODING k` | O(1) | Encoding name |
| `OBJECT REFCOUNT k` | O(1) | refcount field |
| `OBJECT IDLETIME k` | O(1) | seconds since last access (LRU only) |
| `OBJECT FREQ k` | O(1) | LFU counter |
| `OBJECT HELP` | O(1) | Help text |
| `MEMORY USAGE k` | O(N) for compound types | Sum of bytes including overhead |
| `DEBUG OBJECT k` | O(1) | Internal dump |

`MEMORY USAGE` walks the structure, so it's O(N). On a 1M-element list it
takes about a millisecond — fine for occasional debugging, harmful in a
loop over a million keys.

---

## 7.10 Why Polymorphism This Way?

Other systems do polymorphism differently:

| System | Mechanism | Cost |
|--------|-----------|------|
| Java collections | Interface dispatch (`Map<K,V>`) | One vtable lookup per call |
| C++ STL | Templates (compile-time monomorphisation) | Zero runtime cost, large binary |
| Postgres types | `pg_type` lookup on every query | Significant: per-query type resolution |
| Redis | 4-bit field + switch | Effectively zero (branch prediction handles it) |

Redis's polymorphism is **type-erased** in the data structure layer (everything
is a `void* ptr`) but **type-checked at the command boundary**. Once we know
"this is a hash with HT encoding," we go straight to the HT-specific code path
without indirection.

The cost of that simplicity: every encoding-aware function has to switch.
There are roughly 200 such switches across the codebase. They're all small
and consistent, so they're maintainable, but adding a new encoding means
touching every one of them. **This is why new encodings are added rarely
and after a *lot* of design discussion.**

---

## 7.11 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `object.c` | `redisObject` factory functions, `tryObjectEncoding`, refcount, `OBJECT` command |
| `server.h` | `redisObject` struct, encoding constants, type constants |
| `t_string.c`, `t_list.c`, `t_hash.c`, `t_set.c`, `t_zset.c`, `t_stream.c` | Per-type command files; each has a `<type>TryConversion` |
| `db.c` | `lookupKey*`, type checking |

---

## Practice Questions

1. The `lru` field is 24 bits. What's the wraparound period at 1-second
   resolution? Why doesn't this matter to the eviction algorithm?
2. Setting `maxmemory-policy allkeys-lfu` disables shared integer sharing.
   What changes in memory consumption for a workload of 100M counters?
3. You inspect a key and see `OBJECT ENCODING k = "raw"`. Without
   re-reading the docs, can you tell whether this string was created via
   `SET`, `APPEND`, or `SETRANGE`? What's the practical implication?
4. The encoding field is 4 bits (16 possible values). The codebase defines
   13. What design constraint does that 16-value cap put on the future of
   Redis?
5. In the `tryObjectEncoding` snippet, the function may free `o->ptr` and
   replace it with the integer cast as `void*`. Why is this safe given
   refcount semantics?
6. A user writes a module that creates a hash, stashes a pointer to its
   `dict`, then mutates the hash via the standard API. The user's pointer
   becomes invalid after a `HSET`. Why?
7. Why is there no `DOWNGRADE_ENCODING` command to convert a hashtable
   back to listpack after deletes shrink the hash?

(Answers at end of Chapter 22.)
