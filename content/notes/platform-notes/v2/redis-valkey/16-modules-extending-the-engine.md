# Chapter 16: Modules — Extending the Engine

> Redis's most underappreciated superpower is the **Modules API**: a stable
> C interface that lets third parties add new commands, new data types,
> and even new threading models, while reusing all of Redis's persistence,
> replication, cluster, and networking machinery. RedisJSON, RediSearch,
> RedisBloom, RedisTimeSeries — all of them are modules. So is Vector
> Search (RediSearch's HNSW index). This chapter walks you through what
> a module can do, how the API works, and why every senior engineer should
> know how to write at least a trivial one.

---

## 16.1 What a Module Can Do

A loaded `.so` file can:

- **Register new commands** (e.g., `JSON.SET`, `FT.SEARCH`, `BF.ADD`).
- **Define new data types** with custom encoding, RDB serialisation,
  AOF rewrite, and digest computation.
- **Block clients** waiting on async work without freezing the event
  loop.
- **Spawn threads** that operate outside the main thread (with
  proper locking).
- **Subscribe to keyspace events** programmatically.
- **Hook server lifecycle events** (loaded, BGSAVE start/end, replication
  state changes).
- **Expose info via `MODULE LIST` and `INFO`**.

What it **cannot** do (without bypass):

- Modify Redis core data structures directly. The module API is the
  contract.
- Run inside transactions in arbitrary ways — there are documented
  rules about MULTI/EXEC interactions.
- Avoid the GIL for keyspace access. If your module thread wants to
  touch keys, it must `RedisModule_HoldGIL()` first.

---

## 16.2 Loading a Module

```
# at startup:
redis-server --loadmodule /path/to/mymod.so [arg1 arg2 ...]

# or in config:
loadmodule /path/to/redisearch.so

# or at runtime:
> MODULE LOAD /path/to/mymod.so
+OK
> MODULE LIST
1) 1) "name"
   2) "mymod"
   3) "ver"
   4) (integer) 10000
> MODULE UNLOAD mymod
+OK
```

(Note: `MODULE UNLOAD` is supported only if the module didn't register
custom data types — once a module's type is in use, you can't unload it
without losing data.)

---

## 16.3 The "Hello World" Module

```c
#include "redismodule.h"

int HelloCommand(RedisModuleCtx *ctx, RedisModuleString **argv, int argc) {
    if (argc != 2) return RedisModule_WrongArity(ctx);
    size_t len;
    const char *name = RedisModule_StringPtrLen(argv[1], &len);
    char buf[256];
    snprintf(buf, sizeof buf, "Hello, %.*s!", (int)len, name);
    RedisModule_ReplyWithSimpleString(ctx, buf);
    return REDISMODULE_OK;
}

int RedisModule_OnLoad(RedisModuleCtx *ctx, RedisModuleString **argv, int argc) {
    if (RedisModule_Init(ctx, "hello", 1, REDISMODULE_APIVER_1) == REDISMODULE_ERR)
        return REDISMODULE_ERR;
    if (RedisModule_CreateCommand(ctx, "HELLO.GREET",
                                  HelloCommand,
                                  "fast",   /* command flags */
                                  0, 0, 0)  /* first key, last key, key step */
        == REDISMODULE_ERR)
        return REDISMODULE_ERR;
    return REDISMODULE_OK;
}
```

Build:

```
gcc -fPIC -shared -o hello.so hello.c
```

Run:

```
redis-server --loadmodule ./hello.so
> HELLO.GREET World
"Hello, World!"
```

The module has:
- An `OnLoad` entry point that registers commands.
- A command function that takes `(ctx, argv, argc)` and replies to the
  client.
- Returns `REDISMODULE_OK` on success.

That's it. ~30 lines of C, full Redis integration: ACLs, replication,
slowlog, INFO stats — all automatic.

---

## 16.4 The API Surface

`redismodule.h` exposes ~400 functions. Major categories:

### 16.4.1 Reply Construction

```c
RedisModule_ReplyWithSimpleString(ctx, "OK");
RedisModule_ReplyWithError(ctx, "ERR something");
RedisModule_ReplyWithLongLong(ctx, 42);
RedisModule_ReplyWithDouble(ctx, 3.14);
RedisModule_ReplyWithStringBuffer(ctx, "bulk", 4);
RedisModule_ReplyWithArray(ctx, REDISMODULE_POSTPONED_LEN);   /* unknown count */
RedisModule_ReplyWithLongLong(ctx, 1);
RedisModule_ReplyWithLongLong(ctx, 2);
RedisModule_ReplySetArrayLength(ctx, 2);                       /* fix it up */
RedisModule_ReplyWithMap(ctx, ...);                             /* RESP3 */
```

Match the RESP types from Chapter 3 one-to-one.

### 16.4.2 Key Access

```c
RedisModuleKey *key = RedisModule_OpenKey(ctx, argv[1], REDISMODULE_READ);
int type = RedisModule_KeyType(key);
if (type == REDISMODULE_KEYTYPE_STRING) {
    size_t len;
    const char *s = RedisModule_StringDMA(key, &len, REDISMODULE_READ);
    /* ... use s ... */
}
RedisModule_CloseKey(key);
```

`RedisModule_StringDMA` returns a direct memory pointer to the string —
zero copy. Modules that operate on raw bytes prefer this.

For compound types (list, hash, set, zset, stream) there are typed
accessors: `RedisModule_HashSet`, `RedisModule_ZsetAdd`, etc.

### 16.4.3 Calling Commands

A module can invoke Redis commands as if it were a client:

```c
RedisModuleCallReply *r = RedisModule_Call(ctx, "GET", "s", argv[1]);
if (RedisModule_CallReplyType(r) == REDISMODULE_REPLY_STRING) {
    size_t len;
    const char *s = RedisModule_CallReplyStringPtr(r, &len);
    /* ... */
}
RedisModule_FreeCallReply(r);
```

Format string: `s` = string, `l` = long, `c` = C-string, `b` = bytes
+ length, `v` = vector of strings.

`RedisModule_Call` lets a module compose new commands from existing
ones.

### 16.4.4 Custom Data Types

A new type is one of the most powerful module features:

```c
RedisModuleType *MyType;

typedef struct {
    int x;
    char *name;
} MyTypeObject;

void *MyTypeRDBLoad(RedisModuleIO *rdb, int encver) {
    MyTypeObject *o = malloc(sizeof(*o));
    o->x = RedisModule_LoadSigned(rdb);
    size_t len;
    o->name = strdup(RedisModule_LoadStringBuffer(rdb, &len));
    return o;
}

void MyTypeRDBSave(RedisModuleIO *rdb, void *value) {
    MyTypeObject *o = value;
    RedisModule_SaveSigned(rdb, o->x);
    RedisModule_SaveStringBuffer(rdb, o->name, strlen(o->name));
}

void MyTypeAOFRewrite(RedisModuleIO *aof, RedisModuleString *key, void *value) {
    MyTypeObject *o = value;
    RedisModule_EmitAOF(aof, "MYTYPE.SET", "sl", key, (long long)o->x);
}

void MyTypeFree(void *value) {
    MyTypeObject *o = value;
    free(o->name);
    free(o);
}

size_t MyTypeMemUsage(const void *value) {
    const MyTypeObject *o = value;
    return sizeof(*o) + (o->name ? strlen(o->name) + 1 : 0);
}

int RedisModule_OnLoad(RedisModuleCtx *ctx, ...) {
    RedisModule_Init(ctx, "mytype", 1, REDISMODULE_APIVER_1);

    RedisModuleTypeMethods tm = {
        .version = REDISMODULE_TYPE_METHOD_VERSION,
        .rdb_load = MyTypeRDBLoad,
        .rdb_save = MyTypeRDBSave,
        .aof_rewrite = MyTypeAOFRewrite,
        .free = MyTypeFree,
        .mem_usage = MyTypeMemUsage,
    };
    MyType = RedisModule_CreateDataType(ctx, "MyType-AB", 0, &tm);
    /* "MyType-AB" is a 9-character globally-unique type name. */
    if (MyType == NULL) return REDISMODULE_ERR;

    /* register commands that use MyType ... */
    return REDISMODULE_OK;
}
```

The 9-character type name is a global identifier in RDB files. Persistence
embeds it; on load, the matching module's `rdb_load` is invoked. If the
module isn't loaded, the keys are skipped (with warnings).

Module-defined types participate in:
- RDB save/load (callbacks above)
- AOF rewrite (callback above)
- Replication (the AOF emission propagates to replicas as commands;
  alternatively, the module registers digest hooks)
- Memory accounting (`mem_usage` callback feeds `MEMORY USAGE`)

### 16.4.5 Blocking Commands

A command that has async work:

```c
int LongRunningCommand(RedisModuleCtx *ctx, RedisModuleString **argv, int argc) {
    /* Block client; pass it to a worker thread */
    RedisModuleBlockedClient *bc =
        RedisModule_BlockClient(ctx, ReplyCallback, TimeoutCallback,
                                FreeDataCallback, 5000 /* timeout ms */);
    /* spawn or queue work that will eventually call
     *   RedisModule_UnblockClient(bc, private_data);
     */
    return REDISMODULE_OK;
}

int ReplyCallback(RedisModuleCtx *ctx, RedisModuleString **argv, int argc) {
    void *data = RedisModule_GetBlockedClientPrivateData(ctx);
    /* construct reply from data */
    return REDISMODULE_OK;
}
```

The client's connection holds, the event loop continues serving other
clients. When the work completes, the worker calls
`RedisModule_UnblockClient`, which schedules the reply callback to run
on the main thread (so it can safely manipulate the client).

This is **how RediSearch handles long FT.SEARCH queries**: it spawns
worker threads, returns an async handle, and unblocks on completion.
Without this, every search would freeze the server.

### 16.4.6 Threading

Modules may need real concurrency (e.g., HNSW vector search). The API
provides:

```c
RedisModule_GetThreadSafeContext(bc);   /* obtain a context for use OUTSIDE main thread */
RedisModule_ThreadSafeContextLock(ctx); /* take the GIL */
/* ... touch keys ... */
RedisModule_ThreadSafeContextUnlock(ctx);
RedisModule_FreeThreadSafeContext(ctx);
```

`ThreadSafeContextLock` is the GIL — the module thread waits for the
main thread to be in `epoll_wait` (idle), takes the lock, does its
keyspace work, releases. The main thread sees a brief pause but then
continues.

For long-running module work: **don't hold the GIL**. Do the heavy
computation outside the lock, only acquire it for brief reads/writes.

---

## 16.5 The Major Modules in the Wild

### 16.5.1 RedisJSON

Adds a `JSON` data type with JSONPath expressions:

```
> JSON.SET user:42 $ '{"name":"alice","age":30,"prefs":{"theme":"dark"}}'
> JSON.GET user:42 $.prefs.theme
"dark"
> JSON.SET user:42 $.age 31
> JSON.NUMINCRBY user:42 $.age 1
[32]
> JSON.ARRAPPEND user:42 $.tags "premium"
```

Internally: a tree of nodes (objects, arrays, primitives) stored as a
custom data type. Operations are O(N) over the path depth.

Use case: when you need partial document updates *and* sub-millisecond
read latency *and* you can't model it as flat keys.

### 16.5.2 RediSearch (a.k.a. Search)

Full-text search, vector search (HNSW), aggregations. Inverted indexes
stored as custom data types.

```
> FT.CREATE idx ON HASH PREFIX 1 user: SCHEMA name TEXT email TAG
> HSET user:1 name "Alice" email "alice@example.com"
> HSET user:2 name "Bob" email "bob@example.com"
> FT.SEARCH idx "@name:Alice"
1) (integer) 1
2) "user:1"
3) 1) "name"
   2) "Alice"
   ...
```

Vector search:

```
> FT.CREATE idx ON HASH SCHEMA embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 1536 DISTANCE_METRIC COSINE
> HSET doc:1 embedding "<1536-float-vector-as-bytes>"
> FT.SEARCH idx "*=>[KNN 10 @embedding $vec]" PARAMS 2 vec "<query-vector>"
```

This is what powers Redis-as-a-vector-database for AI applications.

### 16.5.3 RedisBloom

Bloom filters, Cuckoo filters, Top-K, Count-Min sketches:

```
> BF.ADD likely-spam "user@evil.com"
> BF.EXISTS likely-spam "user@evil.com"
(integer) 1
> CMS.INITBYDIM cms 1000 5      # count-min sketch
> CMS.INCRBY cms event1 1 event2 5
```

For "approximate" data structures with tunable false-positive rates.

### 16.5.4 RedisTimeSeries

Time series database with downsampling, compaction, range aggregations:

```
> TS.CREATE temperature DUPLICATE_POLICY LAST RETENTION 86400000
> TS.ADD temperature * 23.5
> TS.RANGE temperature - + AGGREGATION avg 60000     # 1-minute averages
```

Internally: a chunked array of (timestamp, value) pairs with delta
encoding for compression.

### 16.5.5 RedisGears

Programmable data processing — pipelines that run on data events. Use
it to build CDC, ETL, triggers. (Less popular than the others; many
teams find it overkill.)

---

## 16.6 Modules and Cluster

Modules participate in cluster resharding via standard `MIGRATE`. The
custom type's RDB serialiser (`rdb_save`) is what `DUMP`/`RESTORE` and
`MIGRATE` use. A module that doesn't implement it correctly will fail
to migrate.

In cluster mode, you must `loadmodule` on **every node** and at the same
version. Otherwise, replicas will silently drop module-typed keys.

(!) **Production hazard**: rolling out a module upgrade across a cluster
  must be coordinated. The wire format and the type's `encver` must
  remain compatible across the rollout window.

---

## 16.7 Modules and Replication

A module that defines a custom type chooses one of two replication
strategies:

1. **Effects replication** (preferred): each module command emits its
   primary's effects via `RedisModule_Replicate(ctx, cmd, args, ...)`.
   Replicas re-execute the emitted commands. Easy, deterministic.
2. **Direct value replication**: the module overrides the type's RDB
   serialiser to ship the value as bytes. Faster but requires careful
   versioning.

Most modules use effects replication. RedisJSON and RediSearch both do.

---

## 16.8 Modules and Persistence

A module's custom type:

- **RDB**: callback `rdb_save` writes; `rdb_load` reads.
- **AOF rewrite**: callback `aof_rewrite` emits commands; AOF replays
  them on restart.

If `aof_rewrite` is missing but the type is in RDB-only AOFs (hybrid),
the load works because the RDB preamble has the value. Pure-AOF (no
RDB preamble) requires the rewrite callback.

---

## 16.9 Writing Your Own Module: When To?

Reasons to write a module:

1. **Performance**: a hot operation that requires many round trips
   from a client. Move it server-side.
2. **New data type**: existing types don't model your domain (e.g.,
   you need a CRDT counter, a HyperLogLog++, a probabilistic sketch).
3. **Integration**: pull in a C library for some specialised algorithm
   (e.g., compression, geometry, graph queries).

Reasons NOT to write a module:

1. **It's just business logic**. Use Lua / Functions instead.
2. **Concurrency is the goal**. Modules can spawn threads but the GIL
   dance is non-trivial.
3. **You'll deploy it in a managed Redis service**. Most cloud Redis
   services restrict modules.

The 2024 Redis license change (Chapter 20) added complications for
proprietary modules. Valkey is fully BSD and embraces module ecosystem
diversity.

---

## 16.10 The Module API's Stability Promise

Modules built against `REDISMODULE_APIVER_1` work across Redis versions
(both Redis and Valkey honor this). New API functions are added (with
auto-generated function pointer registration) but old ones are not
removed.

This means a module compiled against Redis 5 still loads in Redis 8.
Important for ecosystem stability.

---

## 16.11 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `module.c` | Massive: all module API implementation (~10K lines) |
| `redismodule.h` | The API header that modules `#include` |

Open both in tabs while writing a module.

---

## Practice Questions

1. RedisJSON exposes `JSON.GET` with a JSONPath. Sketch the data
   structure that backs the value. Why isn't it just an SDS string of
   the JSON text?
2. Your module needs to scan 1M items and return matches. Without
   blocking, how do you implement this?
3. A module defines a custom type. You upgrade the module to v2 and
   change the on-disk format. What's the safe upgrade path?
4. A module thread holds the GIL for 50ms. What does the main thread
   experience?
5. Modules + cluster: walk through what happens when slot 1000 is
   migrated and contains a module-typed key. What can fail?
6. RediSearch performs vector search via HNSW. Why does it need
   threads? What's the GIL story for thread-safe context?
7. Why are most managed Redis services restrictive about which modules
   you can load?

(Answers at end of Chapter 22.)
