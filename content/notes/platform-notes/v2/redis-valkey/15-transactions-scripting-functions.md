# Chapter 15: Transactions, Scripting & Functions

> Redis offers three ways to execute multiple commands atomically: the
> classical `MULTI/EXEC` transaction, server-side `EVAL` Lua scripts,
> and (since Redis 7) named `Functions`. Each has a different cost
> profile, a different guarantee about atomicity, and a different story
> for how it interacts with replication and persistence. Choosing
> correctly between them — and knowing why MULTI/EXEC has no rollback —
> is one of the most useful pieces of Redis knowledge.

---

## 15.1 The Atomicity You Already Have for Free

Every individual Redis command is atomic. There is no "torn" state during
a `INCR`, `LPUSH`, `ZADD`. This is a consequence of single-threaded
execution (Chapter 2): no other command can interleave inside one.

For most use cases, this is enough:

- Counter? `INCR`.
- Atomic check-and-set? `SET k v NX`.
- Atomic add-if-greater? `ZADD k GT score member`.
- Atomic compute-and-store? Many built-in commands.

Reach for transactions, EVAL, or Functions only when **multiple commands
must execute as a unit**.

---

## 15.2 Transactions: MULTI / EXEC / DISCARD / WATCH

### 15.2.1 The Basic Mechanic

```
> MULTI
+OK
> INCR counter
+QUEUED
> SET last "now"
+QUEUED
> EXEC
*2
:42
+OK
```

Between `MULTI` and `EXEC`:

1. The server queues commands in the client's `client.mstate`. They are
   parsed and validated for arity, but not executed.
2. The server replies `+QUEUED` for each.
3. On `EXEC`, the server runs the entire queue **as one atomic unit
   on the main thread**. No other client's command interleaves.

If you `DISCARD`, the queue is dropped without execution.

### 15.2.2 No Rollback

This is the famous gotcha:

```
> MULTI
> SET k "good"            # good
> LPUSH k whatever        # WRONGTYPE error: k is a string
> SET k "still works"     # this also runs
> EXEC
*3
+OK
-WRONGTYPE Operation against a key holding the wrong kind of value
+OK
```

The `LPUSH` errors at execution time. The transaction continues. Other
commands still run.

**Why no rollback?** Three reasons (per Salvatore's design rationale):

1. **Programming errors should be caught at development time**, not
   silently rolled back at runtime. A WRONGTYPE in production means a bug
   in your code.
2. **Performance**: rollback requires undo logs. Redis's atomicity is
   "free" because the single-threaded execution prevents interleaving;
   adding undo logs would add real cost to every command.
3. **Simplicity**: rollback semantics get complex (what does it mean to
   roll back a `PUBLISH`? a `BLPOP`? a `WAIT`?).

>>> **Interview insight**: "Redis transactions don't have rollback" is a
>>> red flag for interviewers — they're checking if you know it, and if
>>> you understand the implications. The implication: **MULTI/EXEC is
>>> for grouping, not for safety**. Use it when you need a sequence to
>>> run uninterrupted (e.g., balanced read+write); don't use it as a
>>> Postgres-style transaction.

### 15.2.3 Pre-EXEC Errors Abort the Transaction

There IS one error case that aborts the whole thing: a command queued
inside MULTI/EXEC that the server rejects at queue time (unknown
command, wrong number of args):

```
> MULTI
> SET k v
+QUEUED
> NOSUCHCOMMAND foo
-ERR unknown command 'NOSUCHCOMMAND'
> EXEC
-EXECABORT Transaction discarded because of previous errors.
```

So errors split into:

- **Queue-time error** (`-ERR ...`): transaction is aborted on EXEC.
- **Execution-time error** (`-WRONGTYPE`): transaction continues, but
  that one command fails.

### 15.2.4 WATCH: Optimistic Concurrency

Sometimes you want compare-and-set semantics across multiple commands:
"read, decide, write — fail if anything changed in between." Use `WATCH`:

```
> WATCH counter
+OK
> GET counter
$2\r\n10
# now decide what to do based on counter==10
> MULTI
> INCR counter
+QUEUED
> EXEC
*1
:11                                # success
```

If, between `WATCH counter` and `EXEC`, **another client modified
`counter`**, EXEC returns nil:

```
> EXEC
*-1                                 # nil; transaction not executed
```

The application is expected to retry — read again, retry the transaction.

### 15.2.5 How WATCH Works

Each `redisDb` has a `watched_keys` dict mapping watched key → list of
clients watching it. When a key is modified by *any* client, the server
sets the `CLIENT_DIRTY_CAS` flag on every client in that list.

At EXEC time, if the client has `CLIENT_DIRTY_CAS`, EXEC returns nil and
clears the watches.

Cost: one dict operation per modified key (usually no clients are
watching it, so O(1) lookup with no work). Negligible overhead.

>>> **Interview insight**: WATCH gives you optimistic concurrency
>>> control. Combined with MULTI/EXEC, it implements safe
>>> read-modify-write patterns that the simpler `INCR` can't handle (e.g.,
>>> "decrement only if balance > N"). EVAL is often a cleaner alternative.

### 15.2.6 What MULTI/EXEC Doesn't Do

- **Doesn't isolate.** Other clients' READS during the queue see the
  pre-EXEC state. Their reads after EXEC see the post-EXEC state. There's
  no "snapshot" view because the queue isn't executed yet.
- **Doesn't span shards.** In cluster mode, all keys touched in
  MULTI/EXEC must hash to the same slot. Use hash tags.
- **Doesn't support EVAL inside.** You can't `EVAL` from inside a
  transaction. (You can `EVAL` standalone, but the script itself runs
  atomically.)

---

## 15.3 Lua Scripting: EVAL and EVALSHA

A Lua script runs as a single, indivisible operation on the main thread.
The whole script is the atomic unit.

```
> EVAL "return redis.call('GET', KEYS[1])" 1 mykey
"hello"
```

Args:
- The script text
- The number of keys (`numkeys`)
- Then `numkeys` key arguments
- Then any number of additional argv

Inside the script, `KEYS[1..N]` are the keys, `ARGV[1..M]` are the rest.

### 15.3.1 The Atomicity

While the script runs, **no other command from any client executes**.
You have full read-modify-write control across as many keys as you want,
as long as they're all on the same node (cluster mode constraint).

### 15.3.2 redis.call vs redis.pcall

```lua
local v = redis.call('GET', KEYS[1])    -- raises Lua error on Redis error
local v = redis.pcall('GET', KEYS[1])   -- returns table {err="..."} on Redis error
```

`pcall` catches errors so the script can handle them. `call` propagates
errors (which become the script's error reply).

### 15.3.3 Why Lua

Two reasons:

1. **Embeddable**: Lua's interpreter is tiny (~150 KB), and Redis
   embeds it directly. No subprocess, no IPC.
2. **Fast**: Lua is among the fastest dynamic languages. Compiled to
   bytecode, runs near-natively.

The Lua context is sandboxed: no filesystem, no network, no `os.execute`,
limited library surface. Only Redis commands and pure-data Lua libraries.

### 15.3.4 Caching: EVALSHA

Sending the script body on every call is wasteful (especially in tight
loops). The fix:

```
> SCRIPT LOAD "return redis.call('GET', KEYS[1])"
"6b1bf486c81ceb7151c3...d9"
> EVALSHA 6b1bf486c81ceb7151c3...d9 1 mykey
"hello"
```

`SCRIPT LOAD` returns a SHA1 hash. `EVALSHA` references the script by
hash. The server caches scripts by hash; if it doesn't have the hash, it
returns `-NOSCRIPT` and the client falls back to `EVAL` to load it.

Most client libraries handle this automatically.

(!) **Production hazard**: scripts are flushed on `SCRIPT FLUSH`,
  `FLUSHALL`, server restart, and after `DEBUG RELOAD`. Always handle
  `-NOSCRIPT` errors with a re-EVAL.

### 15.3.5 Script Replication

Two modes:

```
redis.set_repl(redis.REPL_ALL)         # default in older Redis: replicate the EVAL itself
redis.set_repl(redis.REPL_SCRIPT_EFFECTS)  # replicate the effects (each redis.call as a separate command)
```

Default in Redis 5+ is **effects replication**: each `redis.call` inside
the script is replicated to AOF and replicas as a normal command. This
lets the replica replay deterministic state without re-running the
script.

Pre-5: scripts had to be **pure deterministic** because they were
replicated as a whole script and replicas re-ran them. Non-deterministic
scripts (e.g., using `math.random()` without seeding) caused divergence
between primary and replica.

### 15.3.6 Determinism Constraints (Pre-Effects Replication)

If you set `redis.set_repl(redis.REPL_NONE)` or use a Redis < 5, the
script must be deterministic:

- No `math.random()` without seed.
- No reliance on key iteration order (which depends on hash seed).
- No system time except via `redis.call('TIME')`.

Effects replication relaxes all of this.

### 15.3.7 The Script Timeout

Scripts can hang the server (single-threaded). The protection:

```
lua-time-limit 5000          # ms; default 5 seconds
busy-reply-threshold 5000    # how long a script must run before SCRIPT KILL works
```

If a script runs longer than `lua-time-limit`, the server starts
processing **only `SCRIPT KILL`** (kills the script, returns error to
client) and `SHUTDOWN NOSAVE` (graceful shutdown without saving).

```
client A: EVAL "while true do end" 0    # infinite loop
client B: SCRIPT KILL                    # kills A's script
```

If the script has already done writes when `SCRIPT KILL` is issued,
it's rejected (because the writes can't be safely undone). You must
`SHUTDOWN NOSAVE` and accept the partial state — which is bad. **Don't
write infinite loops.**

---

## 15.4 Functions: Named, Persistent Scripts (Redis 7+)

`Functions` are like `EVAL` but:

- **Named**, not hash-addressed.
- **Persistent**: stored in the dataset (RDB and AOF).
- **Replicated** like data.
- **Loaded once** at server startup; survive across restarts and
  failovers.

Definition file (`mylib.lua`):

```lua
#!lua name=mylib

redis.register_function('myfunc', function(keys, args)
    return redis.call('GET', keys[1])
end)
```

Loading and calling:

```
> FUNCTION LOAD "$( cat mylib.lua )"
"mylib"
> FCALL myfunc 1 mykey
"hello"
```

Compare to EVAL:

| | EVAL/EVALSHA | FUNCTION/FCALL |
|-|-------------|-----------------|
| Identifier | SHA1 of script | Library + function name |
| Lifetime | Cached, flushable | Persistent in dataset |
| Replication | Effects per-call | Library replicated |
| Loading | Per-call or SCRIPT LOAD | FUNCTION LOAD |
| Cluster mode | Each node loads independently | Each node loads independently |

Functions are the recommended option for "stored procedures" you want to
keep around. EVAL is fine for ad-hoc scripts.

---

## 15.5 Server-Assisted Client-Side Caching (Aside)

A scripting-adjacent feature: **client-side cache invalidation**. When a
client `CLIENT TRACKING ON`, the server tracks which keys the client has
read and pushes invalidations when those keys change.

This isn't strictly transactions or scripting, but it's atomic in the
same single-threaded sense: the invalidation is generated as part of the
write that triggers it.

We covered this in Chapter 3. It's the fastest way to keep a local
client-side cache coherent with Redis.

---

## 15.6 Worked Example: Atomic Decrement-If-Sufficient

Classic banking-flavored example:

```
"Subtract X from balance:N if balance:N >= X. Return new balance, or -1 if insufficient."
```

### 15.6.1 With WATCH/MULTI/EXEC

```python
def safe_decr(client, key, amount):
    while True:
        client.watch(key)
        balance = int(client.get(key) or 0)
        if balance < amount:
            client.unwatch()
            return -1
        pipe = client.pipeline(transaction=True)
        pipe.decrby(key, amount)
        result = pipe.execute()
        if result is not None:
            return balance - amount
        # else: someone modified, retry
```

Contention can cause many retries. OK for low-contention.

### 15.6.2 With EVAL

```python
LUA_DECR_IF_GE = """
local balance = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if balance < amount then
    return -1
end
local new_balance = balance - amount
redis.call('SET', KEYS[1], new_balance)
return new_balance
"""

def safe_decr(client, key, amount):
    return client.eval(LUA_DECR_IF_GE, 1, key, amount)
```

Single round trip, no retries, no contention. Almost always faster than
the WATCH variant.

### 15.6.3 With Functions

```lua
#!lua name=banking

redis.register_function('decr_if_ge', function(keys, args)
    local balance = tonumber(redis.call('GET', keys[1]) or '0')
    local amount = tonumber(args[1])
    if balance < amount then return -1 end
    local new = balance - amount
    redis.call('SET', keys[1], new)
    return new
end)
```

```
> FUNCTION LOAD "$(cat banking.lua)"
> FCALL decr_if_ge 1 balance:42 100
```

Best of both worlds for stable codepaths.

---

## 15.7 The Hidden Cost: Long Scripts Block Everyone

A 100ms Lua script means **all other clients wait 100ms**. The single-
threaded model has no escape hatch.

Symptoms:
- p99 latency tracks script duration.
- During a slow-script incident, `INFO commandstats` shows EVAL/EVALSHA
  with high `usec_per_call`.

Mitigations:
- **Bound script work**. If iterating, cap to a few hundred items per
  call, return a continuation cursor to the client.
- **Move work out**. Use scripts for *atomic decisions*, not *bulk data
  processing*.
- **Profile**: `LATENCY GRAPH script` shows script-induced latency.

>>> **Interview insight**: "A Lua script that touches 10K keys takes
>>> 50ms. Fix it." Two answers: (1) split into multiple smaller scripts
>>> with cursor state in the client; (2) consider a module if the
>>> operation is genuinely too complex for client-side iteration. Don't
>>> just leave the slow script.

---

## 15.8 Pipelining + Transactions

You can pipeline a transaction:

```python
pipe = client.pipeline(transaction=True)
pipe.incr("counter")
pipe.incr("counter")
pipe.execute()
```

The client library sends:

```
MULTI
INCR counter
INCR counter
EXEC
```

— in one TCP write. The server responds with one `*N` array. **Faster
than one-at-a-time** by eliminating round trips.

---

## 15.9 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `multi.c` | MULTI/EXEC/WATCH/DISCARD |
| `eval.c`, `script.c`, `script_lua.c` | Lua scripting infrastructure |
| `function.c`, `functions.c` | Functions API |
| `commands.def` | Command flags including `MULTI`/`SCRIPT` interactions |

`script.c` and `function.c` are tightly coupled. Both go through a
common Lua sandbox setup.

---

## Practice Questions

1. A bank runs `MULTI; DECR balance; EXEC`. Is this safe? What edge
   cases need handling that MULTI/EXEC alone doesn't cover?
2. WATCH gives optimistic concurrency. Under what contention level does
   WATCH + retry start performing worse than EVAL?
3. Inside an EVAL script, you call `redis.call('GET', ...)` 100 times.
   Are these 100 round trips? Why or why not?
4. `EVAL` runs atomically. What happens to other clients' commands
   that arrive during the script? What about replication of the
   commands the script issues?
5. Why does `MULTI/EXEC` not have rollback? What if you really need it?
6. A Lua script has been running for 6 seconds. `lua-time-limit` is
   5000. What state is the server in? What can clients do?
7. Functions vs EVAL: when do you pick which? List two specific
   scenarios for each.
8. `CLIENT TRACKING ON` plus `EVAL`: if the script reads key K, does
   the client get tracked for K?

(Answers at end of Chapter 22.)
