# Chapter 4: Strings — SDS Internals

> Every key in Redis is a string. Most values are strings. The string itself
> is the foundation under every other data type — hash field names, list
> elements, set members, sorted set members are all SDS. Get this layer wrong
> and you compromise the entire engine. The Redis authors did not get it wrong;
> they invented SDS — Simple Dynamic Strings — and threw `char*` in the bin.
> This chapter explains why.

---

## 4.1 What's Wrong with C Strings

C strings are nul-terminated `char*`. Redis cannot use them for three reasons:

### 4.1.1 They are not binary-safe

A C string ends at the first `\0`. Redis values can contain `\0` — they're
arbitrary bytes. Storing a JPEG, a protobuf, or a UTF-16 string in a C string
truncates it.

### 4.1.2 `strlen()` is O(N)

To get the length, you walk to the nul terminator. For Redis to support
constant-time `STRLEN`, the length must be stored explicitly. (Also: length
is needed for almost every operation — bounds checks, RESP serialisation,
appending — so doing O(N) every time is unacceptable.)

### 4.1.3 Append (`strcat`) is O(N+M) and allocates

`strcat(a, b)`:
- Walks `a` to find the end (O(N))
- Copies `b` (O(M))
- Assumes the buffer is big enough — if not, you have a buffer overflow

Redis needs `APPEND key value` and many internal append-style operations to
be amortised O(1). That requires storing both length and capacity, plus a
growth strategy.

---

## 4.2 The SDS Layout

SDS is defined in `sds.h`. The trick is that an `sds` is just a `char *` —
specifically, a pointer to the **first character of the buffer**. The header
sits *before* that pointer in memory, and a one-byte flag immediately before
the buffer tells you which header type was used.

```
   memory layout for sds string of, e.g., 100 bytes content:

          [ header | flags(1) | "hello world..." | '\0' | unused space ]
          ^                    ^
          |                    +-- the sds points here
          +------ header sits behind ------+

   (the trailing '\0' is for compatibility with C string functions like printf
    that don't need binary content — keeps SDS usable as a C string when safe)
```

There are **five header types** to minimise overhead for short strings:

```c
// sds.h
typedef char *sds;

struct __attribute__ ((__packed__)) sdshdr5  { unsigned char flags;                                       char buf[]; };
struct __attribute__ ((__packed__)) sdshdr8  { uint8_t  len; uint8_t  alloc; unsigned char flags; char buf[]; };
struct __attribute__ ((__packed__)) sdshdr16 { uint16_t len; uint16_t alloc; unsigned char flags; char buf[]; };
struct __attribute__ ((__packed__)) sdshdr32 { uint32_t len; uint32_t alloc; unsigned char flags; char buf[]; };
struct __attribute__ ((__packed__)) sdshdr64 { uint64_t len; uint64_t alloc; unsigned char flags; char buf[]; };
```

| Type | When | Header size | `len` field | `alloc` field |
|------|------|-------------|-------------|---------------|
| `sdshdr5` | Up to 31 bytes | 1 byte | 5 bits, packed in flags | none — alloc == len |
| `sdshdr8` | Up to 255 bytes | 3 bytes | uint8 | uint8 |
| `sdshdr16` | Up to 64 KB | 5 bytes | uint16 | uint16 |
| `sdshdr32` | Up to 4 GB | 9 bytes | uint32 | uint32 |
| `sdshdr64` | Beyond | 17 bytes | uint64 | uint64 |

The first byte before `buf` (always) is the flag byte. The lower 3 bits encode
the header type (`SDS_TYPE_5..SDS_TYPE_64`). For `sdshdr5` the upper 5 bits
encode the length (so the length fits inside flags — no separate len field).

>>> **Interview insight**: This 5-tier header design is a textbook example of
>>> trading code complexity for memory efficiency. A 16-byte string carries
>>> only 3 bytes of overhead (header) + 1 byte (terminator) = 4 bytes. Without
>>> tiered headers, every string would carry 17 bytes (uint64 len + uint64
>>> alloc + flags + terminator). On a database with a billion small strings
>>> that saves ~13 GB.

### 4.2.1 Why the sds points to `buf`, not the header

Two reasons:

1. **API compatibility.** An `sds` is a `char*`, so `printf("%s", s)` works,
   `strcmp(s, "foo")` works, `s[0]` works. As long as the content has no embedded
   `\0`, you can pass an SDS to any C function expecting a string.
2. **Cache locality on read.** The first byte you usually want is `buf[0]`.
   Pointing the variable directly at it puts the data in the cache line you'll
   touch next.

To get the header from an `sds`:

```c
// sds.h
#define SDS_HDR(T,s) ((struct sdshdr##T *)((s)-(sizeof(struct sdshdr##T))))

static inline size_t sdslen(const sds s) {
    unsigned char flags = s[-1];                // flag byte sits at s-1
    switch(flags & SDS_TYPE_MASK) {
        case SDS_TYPE_5:  return SDS_TYPE_5_LEN(flags);
        case SDS_TYPE_8:  return SDS_HDR(8,s)->len;
        case SDS_TYPE_16: return SDS_HDR(16,s)->len;
        case SDS_TYPE_32: return SDS_HDR(32,s)->len;
        case SDS_TYPE_64: return SDS_HDR(64,s)->len;
    }
}
```

`s[-1]` reaches one byte behind the buffer, picks up the flags, masks out the
type, computes header offset by macro arithmetic, and reads the length field.
All inlined, no branching after type selection. Roughly the same speed as
`strlen` for any practical size, but **always O(1)**.

### 4.2.2 Why store both `len` and `alloc`

- `len` = number of bytes of *content*.
- `alloc` = total bytes of *buffer* available (excluding header and terminator).
- `alloc - len` = free space, used by `sdsMakeRoomFor` and append operations.

Store both → append is O(1) amortised:

```c
sds sdscat(sds s, const char *t, size_t len) {
    s = sdsMakeRoomFor(s, len);   // grow if needed
    memcpy(s + sdslen(s), t, len);
    sdssetlen(s, sdslen(s) + len);
    s[sdslen(s)] = '\0';
    return s;
}
```

Storing capacity separately means we don't reallocate on every append.

### 4.2.3 The Growth Strategy

`sds.c:sdsMakeRoomFor()` decides how much to allocate when growing:

```c
sds sdsMakeRoomFor(sds s, size_t addlen) {
    size_t avail = sdsavail(s);
    size_t len, newlen, reqlen;
    if (avail >= addlen) return s;       // already enough room

    len = sdslen(s);
    reqlen = newlen = len + addlen;
    if (newlen < SDS_MAX_PREALLOC)
        newlen *= 2;                      // double up to 1 MB
    else
        newlen += SDS_MAX_PREALLOC;       // beyond 1 MB, grow by 1 MB chunks

    // possibly switch header type if newlen needs more bits
    ...
}
```

`SDS_MAX_PREALLOC` = 1 MB. So:
- Small strings double on each grow (amortised O(1) append).
- Beyond 1 MB, grow linearly by 1 MB at a time (avoids wasting RAM on
  multi-gigabyte append operations).

This is the same growth pattern as `std::vector` and Java `ArrayList`, with
a sensible cap.

>>> **Interview insight**: Why the 1 MB cap? Because doubling a 4 GB string
>>> to 8 GB just to append a few bytes is catastrophic. Linear growth above
>>> 1 MB caps the worst-case overhead at ~1 MB per string instead of N bytes.

### 4.2.4 No Reallocation Once Stable

Once a string stops growing, you can call `sdsRemoveFreeSpace(s)` to shrink
the buffer to exactly `len`. Redis does this in some hot code paths to reduce
RAM after long-running APPEND patterns settle.

---

## 4.3 The Public API

The functions you'll see all over the Redis codebase:

```c
sds sdsnew(const char *init);                          // create from C string
sds sdsnewlen(const void *init, size_t initlen);       // create with explicit length (binary safe)
sds sdsempty(void);                                     // create ""
sds sdsdup(const sds s);                               // clone
void sdsfree(sds s);                                    // free (handles header underneath)
sds sdscat(sds s, const char *t, size_t len);          // append bytes
sds sdscatsds(sds s, const sds t);                     // append another sds
sds sdscpy(sds s, const char *t);                      // overwrite content
size_t sdslen(const sds s);                            // O(1) length
size_t sdsavail(const sds s);                          // remaining capacity
int sdscmp(const sds s1, const sds s2);                // memcmp + length compare
sds sdsRemoveFreeSpace(sds s);                          // shrink to fit
sds sdsResize(sds s, size_t size);                     // exact resize
size_t sdsAllocSize(sds s);                             // bytes including header
```

Note that **append/copy operations may return a new pointer**, because they
might need to reallocate. Always reassign:

```c
s = sdscat(s, " world");        // CORRECT
sdscat(s, " world");             // BUG: may leak old s after realloc
```

This pattern (`s = sdsop(s, ...)`) is one of the things you have to internalise
when reading Redis source.

---

## 4.4 SDS Inside `robj`

A Redis value is wrapped in a `redisObject` (`robj`) — covered in detail in
Chapter 7. For strings, the relevant fields are:

```c
typedef struct redisObject {
    unsigned type:4;        // OBJ_STRING
    unsigned encoding:4;    // OBJ_ENCODING_RAW / EMBSTR / INT
    unsigned lru:LRU_BITS;  // 24 bits, last-access time or LFU counter
    int refcount;
    void *ptr;              // points to the SDS (or the integer)
} robj;
```

The `encoding` field controls the in-memory layout:

### 4.4.1 `OBJ_ENCODING_INT`

If the string content can be parsed as a signed 64-bit integer, Redis stores
it as a *raw integer* in the `ptr` field itself (cast to `void*`). No SDS, no
allocation.

```
SET counter 12345
   encoding=int, ptr=(void*)12345
```

This is the fast path for `INCR`, counters, and ID-style keys.

### 4.4.2 `OBJ_ENCODING_EMBSTR`

For strings up to 44 bytes, the SDS header, data, and `robj` are allocated
**in one contiguous block**:

```
   [ robj | sdshdr8 | content (≤44 bytes) | '\0' ]
   ^      ^         ^
   robj   |        sds (== content pointer)
          header

   Total: 16 (robj) + 3 (sdshdr8) + 44 + 1 = 64 bytes
```

64 bytes is exactly **one cache line** on x86-64. This is not coincidence.
EMBSTR strings live in the same cache line as their `robj` — reading length,
encoding, and data is one cache miss.

>>> **Interview insight**: The 44-byte threshold is computed as
>>> `64 - 16 (robj) - 3 (sdshdr8) - 1 (terminator) = 44`. If Redis's cache line
>>> size or `robj` size changed, this constant would change. It's defined as
>>> `OBJ_ENCODING_EMBSTR_SIZE_LIMIT` in `object.c`.

### 4.4.3 `OBJ_ENCODING_RAW`

Strings longer than 44 bytes have the `robj` and SDS in *separate* allocations:

```
   robj  ----ptr---->  SDS (independent allocation)
```

Two cache misses per access, but unavoidable for large strings.

---

## 4.5 The Encoding Transition Rules

| State | Encoding | Trigger to change |
|-------|----------|-------------------|
| Created with `SET k <integer ≤ int64>` | `int` | `APPEND k something` → `embstr`/`raw` |
| Created with `SET k <≤44 bytes>` | `embstr` | Modified in any way → `raw` |
| Created with `SET k <>44 bytes>` | `raw` | Stays `raw` |

EMBSTR is **immutable** internally — modifications convert to RAW. This is
because EMBSTR shares allocation with the `robj` and resizing would require
moving everything.

You can inspect encoding live:

```
> SET k 12345
> OBJECT ENCODING k
"int"
> APPEND k "abc"
> OBJECT ENCODING k
"raw"
```

>>> **Interview insight**: Why does this matter to a user?
>>> 1. **Memory.** Storing 1 million counters as integers uses 16 bytes/key.
>>>    Storing them as raw strings would use ~50 bytes/key.
>>> 2. **CPU.** `INCR` on an int-encoded value is a single addition. On a
>>>    string it's parse → add → re-stringify.
>>> 3. **Hot/cold.** EMBSTR's cache locality means hot small strings perform
>>>    measurably better than cold long strings of the same logical content.

---

## 4.6 Shared Integer Objects

Redis pre-allocates a pool of `robj`s for integers from 0 to 9999 at startup
(`OBJ_SHARED_INTEGERS = 10000`). Every place that would create one of these
gets a pointer to the shared instance instead.

```
   shared.integers[0..9999] = preallocated robj objects with refcount = INT_MAX
```

When you `SET counter 5`:
- The keyspace dict creates a new entry with key `counter`.
- The value pointer is `shared.integers[5]` (refcount left at INT_MAX so we
  never free it).

This saves significant memory for typical workloads with lots of small
integer values (status codes, state machine markers, etc.).

The same idea applies to a handful of common reply strings: `+OK`, `+PONG`,
the empty bulk `$0\r\n\r\n`, common error messages. They live in the
`shared` global.

(!) Caveat: the shared integer optimisation is **disabled when `maxmemory-policy`
  is one of the LRU/LFU policies**, because the LRU/LFU bits inside the `robj`
  must be updated per-access — and they can't be updated on a shared object
  without messing up other keys' bookkeeping.

---

## 4.7 String Commands: Algorithmic Cost

A reference table for string operations:

| Command | Cost | Notes |
|---------|------|-------|
| `GET key` | O(1) | Hash lookup + reply |
| `SET key value` | O(1) | Hash insert + possible eviction |
| `SET key value EX 10` | O(1) | Same + expire entry |
| `SETNX key value` | O(1) | Atomic check-and-set |
| `MGET k1..kN` | O(N) | N hash lookups |
| `MSET k1 v1..kN vN` | O(N) | N hash inserts |
| `INCR / INCRBY / DECR` | O(1) | Integer encoding fast path |
| `INCRBYFLOAT` | O(1) | Always involves string<->double conversion |
| `APPEND key value` | O(1) amortised | sdsMakeRoomFor doubling |
| `STRLEN key` | O(1) | sdslen() on the SDS |
| `GETRANGE key start end` | O(end-start) | Byte slice |
| `SETRANGE key offset value` | O(L) where L = max(strlen(key), offset+len(value)) | May extend with zero-fill |
| `GETSET (deprecated) / SET ... GET` | O(1) | Atomic get-then-set |
| `BITCOUNT key` | O(N) where N = strlen(key) | Hardware-accelerated `popcnt` |
| `BITOP AND/OR/XOR/NOT dst k1..kN` | O(longest input) | Output length = longest input |
| `GETBIT / SETBIT` | O(1) | Random bit access into byte-array |
| `STRALGO LCS k1 k2` | O(N*M) | Longest Common Subsequence — *expensive* |

>>> **Interview insight**: If someone proposes using `STRALGO LCS` on long
>>> strings in a hot path, that's a single-threaded server doing O(N*M) work
>>> while every other client waits. Always benchmark.

---

## 4.8 Bit Operations as a Use-Case Multiplier

Strings double as bit arrays. `SETBIT user:active:2024-05-07 12345 1` sets
bit 12345 of a string at that key. Pre-allocates the byte array if needed
(zero-filled).

```
> SETBIT page 7 1
> GETBIT page 7
1
> BITCOUNT page
1
```

Three patterns this enables:

1. **Daily Active Users (DAU)**. One bit per user, one key per day. Bitmap
   for 100 M users = 12.5 MB. `BITCOUNT` = 12.5 MB scan with hardware popcnt
   = ~5 ms.
2. **Bloom filter** (with module RedisBloom for proper API).
3. **Feature flags**. Bit per user × feature.

Constraints:
- Max string length is 512 MB → max bit index is 2^32 - 1.
- `BITCOUNT` is O(N) over the whole string. For very large bitmaps, range it:
  `BITCOUNT key 0 1023 BYTE`.

We come back to bitmap patterns in Chapter 21.

---

## 4.9 Memory Cost in Practice

What does it actually cost to store a string in Redis? The components:

```
Key memory:
  - dict entry (dictEntry):                       32 bytes
  - key SDS header + content + null term:         ~3 + len + 1 bytes (sdshdr8 if ≤255)
  - jemalloc allocation overhead:                 ~2-15 bytes per allocation

Value memory:
  - robj:                                          16 bytes
  - if int encoding: nothing extra
  - if embstr: same allocation as robj             0 extra alloc
  - if raw: SDS header + content + null term       ~3 + len + 1 bytes + alloc overhead

Plus expire entry if EX/PX set:
  - dict entry in expires dict:                   32 bytes
```

**Empirical rule of thumb (default settings, no expire):**

| Value type | Bytes per key |
|------------|---------------|
| 8-byte integer value | ~50 bytes |
| 32-byte string value | ~80 bytes |
| 200-byte string value | ~250 bytes |

With expire add ~32 bytes. With LFU/LRU tracking add nothing (it's already
in the `robj.lru` field).

You can confirm this for any key with `MEMORY USAGE key`:

```
> SET k "hello"
OK
> MEMORY USAGE k
(integer) 56
```

---

## 4.10 Practical Tips for Working with String Values

1. **Use integer keys when you can.** Cheaper to store, cheaper to compute
   on, encoding fast-path applies.
2. **Use `SET key val EX N` instead of `SET key val; EXPIRE key N`.** The
   single command is atomic (no race where the key exists but the expire
   isn't set). Also one round-trip instead of two.
3. **Use `SETNX` (or `SET NX`) for distributed locks** — but read Chapter 17
   first to understand Redlock's controversies.
4. **Use `INCRBY`, not `GET; n+1; SET`.** The former is atomic and uses the
   integer fast path. The latter is racy and slow.
5. **Compress big values client-side.** Redis doesn't compress. A 1 KB JSON
   value gzipped to 200 bytes saves 80% of memory.
6. **Beware string growth via `APPEND`.** If you append to a string that
   used to be 100 bytes and is now 100 MB, it's still in the keyspace
   slowing down `GET` by a megabyte of memcpy each time.

---

## 4.11 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `sds.h` | Public API, header struct definitions |
| `sds.c` | Implementation: `sdsnewlen`, `sdscat`, `sdsMakeRoomFor`, `sdsfree`, etc. |
| `object.c` | `createStringObject`, `createEmbeddedStringObject`, `tryObjectEncoding`, `objectCommand` |
| `t_string.c` | `getCommand`, `setCommand`, `incrCommand`, `appendCommand`, `bitcountCommand` |

If you read just `sds.c` and `t_string.c`, you understand 90% of the
"strings" surface in Redis.

---

## Practice Questions

1. Why does `OBJECT ENCODING k` matter to an application engineer who isn't
   tuning Redis? Give two scenarios where the answer changes their code.
2. You set a key to a 50-byte value, then `APPEND` 1 byte twice. What's the
   sequence of encoding states? What's the cost of each operation?
3. The encoding transition from `embstr` to `raw` requires a memory copy.
   Why is `embstr` immutable? What would it take to make it mutable, and why
   isn't that worth doing?
4. Estimate: 100 million keys, each with an 8-byte string value with 60-second
   TTL. How much RAM?
5. A service uses Redis bitmaps to track DAU. The team wants to compute "users
   who were active on day A but not on day B" cheaply. Sketch the command
   sequence and its cost.
6. `INCR counter` is faster than `EVAL "redis.call('SET', KEYS[1],
   tonumber(redis.call('GET', KEYS[1])) + 1)"`. By how much? Why?
7. Why does Redis pre-allocate 10,000 shared integer objects but not, say,
   1,000,000?

(Answers at end of Chapter 22.)
