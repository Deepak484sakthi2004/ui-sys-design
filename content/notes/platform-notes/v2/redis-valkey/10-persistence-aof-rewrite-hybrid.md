# Chapter 10: Persistence II — AOF, Rewrite & Hybrid

> RDB gives you point-in-time snapshots. AOF — Append-Only File — gives you
> a continuous log of every write since the last snapshot. Configured well,
> AOF reduces your worst-case data loss from minutes (RDB only) to one
> second or less. Configured poorly, AOF will tank your write latency and
> bloat your disk. This chapter is the playbook.

---

## 10.1 What AOF Is

AOF is a log of write commands in **RESP format** — the same wire format
clients use. After every successful write, the command is appended to the
AOF file (with all its RESP framing). On restart, Redis replays the file
to rebuild state.

```
*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
*2\r\n$4\r\nINCR\r\n$3\r\ncnt\r\n
*5\r\n$4\r\nHSET\r\n$5\r\npref\r\n$5\r\ntheme\r\n$4\r\ndark\r\n
...
```

That's literally what an AOF file looks like in the simple case. (We'll
get to the "hybrid" mode where the head of the file is RDB-formatted in
§10.5.)

Why store as commands instead of state diffs? Because:

1. **Replay is just running each command**. The same dispatch path as
   handling a client.
2. **Commands self-document**. You can `tail -f appendonly.aof` to debug.
3. **The format never breaks** — RESP is stable, so Redis 8 can read AOFs
   from Redis 4.

---

## 10.2 The Three Durability Levels

The fundamental knob is **when do we `fsync` the AOF file**:

```
appendfsync always       # fsync after every write command
appendfsync everysec     # fsync once per second   <-- default
appendfsync no           # never fsync (let kernel flush)
```

### 10.2.1 `appendfsync always`

Every successful write blocks the main thread until the OS confirms the
data is on stable storage.

| | |
|-|-|
| RPO (worst case data loss) | 0 — every ack means it's on disk |
| Throughput | 200-1000 ops/sec (limited by disk fsync rate) |
| Use case | Financial txns, distributed locks needing durability |

`fsync` on a typical SSD takes 1-5 ms; on spinning disk 5-30 ms. With
single-threaded execution, that's the wall-clock floor on your write
latency.

### 10.2.2 `appendfsync everysec` (default)

Writes go to the OS page cache immediately. Once per second, a BIO thread
calls `fsync` on the AOF.

| | |
|-|-|
| RPO | Up to ~1 second (potentially more if BIO falls behind) |
| Throughput | Near in-memory rates |
| Use case | Most production deployments |

The fsync runs **off the main thread** in a BIO worker (Chapter 2). The
main thread keeps appending writes to the page cache while the BIO thread
is fsyncing. **Mostly.**

(!) **The exception**: if the BIO fsync is taking too long (>2 seconds)
  and the previous fsync is still pending, the main thread will *itself*
  pause appending writes until the previous fsync completes. This is to
  bound the write-buffer-vs-disk-state divergence.

You see this in the latency monitor as `aof-write-pending-fsync` events.
The fix is faster disk or a config change.

### 10.2.3 `appendfsync no`

Writes go to the OS page cache. Redis never fsyncs explicitly. The kernel
flushes when it feels like it (typically every 30 seconds via writeback).

| | |
|-|-|
| RPO | Up to 30+ seconds (kernel-controlled) |
| Throughput | Maximum — equal to RDB-only |
| Use case | When you're OK with substantial loss; or when the disk IS your battery-backed UPS |

Almost never the right choice for production. Use this if you really mean
"AOF as a 'mostly-recent' replay log, not a durability guarantee."

---

## 10.3 The Append Path

Inside the event loop:

```
processCommand
  +
  v
call(cmd)
  +
  v
mutate keyspace
  +
  v
propagate(cmd, args, dbid, flags)
  +
  v
feedAppendOnlyFile(cmd, dbid, argv, argc)
  +
  v
sdscatprintf into server.aof_buf       <-- in-memory buffer
  +
  v
(in beforeSleep) flushAppendOnlyFile(0)
  +
  v
write(aof_fd, aof_buf, len)            <-- append to OS page cache
  +
  v
(periodically, BIO thread) fsync(aof_fd)
```

The buffering: writes accumulate in `server.aof_buf` (an SDS) during the
event-loop iteration. At `beforeSleep`, the buffer is `write()`-ed to the
file descriptor. **Multiple commands in one iteration share one `write()`
syscall** — natural batching.

If `appendfsync always`, the `flushAppendOnlyFile(1)` path additionally
calls `fsync` synchronously inside `beforeSleep` before returning.

### 10.3.1 The aof_buf and aof_pending_bio_fsync

```
   server.aof_buf:
   +-------------------------------------+
   | "*3\r\n$3\r\nSET\r\n..." accumulated|
   |  this iteration of the event loop   |
   +-------------------------------------+
                |
                |  beforeSleep -> flushAppendOnlyFile
                v
   write(aof_fd, ...)
                |
                v
            OS page cache
                |
   appendfsync always -> fsync now (block main thread)
   appendfsync everysec -> queue fsync to BIO if 1s elapsed
   appendfsync no -> done
```

### 10.3.2 What if `write()` fails?

A short write (e.g., disk full and we write 50% of the buffer) is
catastrophic — the AOF is now corrupt mid-command. Redis's behavior:

- Log the error.
- **Truncate** the AOF back to the last full command (Redis tracks the
  position before the partial write).
- Apply `aof-load-truncated` setting on next load: `yes` (default) means
  "load up to last full command and continue;" `no` means "refuse to
  start, manual intervention."

If `write()` fails entirely (e.g., EIO), Redis **returns an error to the
client** and queues the command to be retried on the next iteration. If
the failure persists, writes start failing.

>>> **Interview insight**: "What happens when the AOF disk is full?" Redis
>>> doesn't crash — it returns errors to clients, the AOF stops growing,
>>> and the in-memory state continues until you free space or shed traffic.
>>> A graceful degradation.

---

## 10.4 The AOF Rewrite

A continuously-growing log eventually consumes more disk than the dataset
it represents. AOF rewrite is the compaction mechanism: replace the
verbose log with a minimal log that produces the same final state.

Example: 100M `INCR counter` commands take 100M command lines. The final
state is `counter = 100000000`. The rewrite emits a single `SET counter
100000000`.

### 10.4.1 The Trigger

```
auto-aof-rewrite-percentage 100        # rewrite when AOF is 100% bigger than after last rewrite
auto-aof-rewrite-min-size 64mb         # but not when AOF is < 64 MB
```

`serverCron` checks these every tick. If AOF size > `last_rewrite_size *
(1 + percentage/100)` AND AOF size > min, we trigger `BGREWRITEAOF`.

You can also trigger manually: `BGREWRITEAOF`.

### 10.4.2 The Mechanic

The rewrite is **another fork** (yes, like RDB):

```
BGREWRITEAOF                       (or auto trigger)
  |
  v
fork() -> child
  |
  +--> child:
  |      walk keyspace
  |      emit minimal commands to temp file
  |      (or, in hybrid mode: write RDB header + diff commands)
  |      exit
  |
  v
parent:
  keep serving writes
  any new writes are also written to:
    - active aof file (current one)
    - aof_rewrite_buf_blocks (a list of buffer chunks for the child to merge later)

  also pipe the buffer to the child via socketpair() so the child can
  consume them as they happen instead of waiting for swap

  when child exits:
    - merge any remaining aof_rewrite_buf into the temp file
    - rename temp file to active AOF
    - close old AOF fd, open new one
```

Two file streams during rewrite:

```
   commands flowing in
        |
        +--> append to active AOF  (so existing replay path still works if we crash)
        |
        +--> append to aof_rewrite_buf
                +--> piped to child via socketpair
                       (child reads pipe and merges into its temp file)
```

The pipe-to-child trick (`aof-pipe-fd`) means the child can incorporate
new writes as it goes, so by the time the child finishes, its temp file
is *very* close to the live state — only the last few hundred ms of
writes remain to be appended by the parent in the rename step.

### 10.4.3 What can go wrong

The rewrite **forks**. All the COW concerns from Chapter 9 apply.

`aof-rewrite-incremental-fsync yes` (default): the child fsyncs every
~32 MB while writing instead of one big fsync at the end. Spreads disk
load.

`no-appendfsync-on-rewrite yes`: while a rewrite is in progress, the
parent's `appendfsync everysec` mode skips fsyncs. The intent: don't fight
the disk that the child is hammering. Cost: a crash during rewrite has up
to "duration of rewrite" RPO instead of 1 second. Most production
deployments leave this off (default no) — they'd rather have the disk
contention than the increased data loss.

(!) **Production hazard**: AOF rewrite + RDB save happening simultaneously
  is *two* fork pauses and *two* COW page costs. Redis serialises them
  internally — only one child at a time. But the next-scheduled job waits
  until the current one finishes, which can extend the window where the
  AOF is bloated.

### 10.4.4 The minimal command emitted by rewrite

Each data type has a "produce minimal commands to recreate me" function:

| Type | Emitted command(s) |
|------|---------------------|
| String | `SET key value` |
| List | `RPUSH key e1 e2 ... eN` (chunked at AOF_REWRITE_ITEMS_PER_CMD = 64) |
| Hash | `HSET key f1 v1 f2 v2 ...` (chunked) |
| Set | `SADD key m1 m2 ...` (chunked) |
| Sorted Set | `ZADD key score1 m1 score2 m2 ...` (chunked) |
| Stream | `XADD key id ...` for each entry, plus `XGROUP CREATE` for each group |

If the key has TTL, append `PEXPIREAT key <abs_ms>`.

Source: `aof.c:rewriteAppendOnlyFile()` and per-type helpers in `t_*.c`.

---

## 10.5 Hybrid Persistence (RDB-Preamble AOF)

Default in Redis 7+:

```
aof-use-rdb-preamble yes       # default
```

The AOF rewrite **doesn't** emit minimal commands. Instead, it writes a full
RDB binary dump to the head of the file, then appends new commands as
RESP-formatted text after a marker:

```
   [ RDB binary dump of current state ]
   [ "REDIS0011" ... CRC64 ]
   [ RESP commands for everything since the rewrite started ]
```

Why? Two reasons:

1. **Faster load**: parsing binary RDB is ~10x faster than parsing+executing
   RESP commands. A 10 GB AOF in legacy text mode loads in ~10 minutes;
   in hybrid mode it loads in ~1 minute.
2. **Smaller file**: RDB has compression and integer encoding; pure text AOF
   is ~3-5x larger.

The trade-off: only Redis 4+ can read hybrid AOF. If you might want to
load with an older server, set `aof-use-rdb-preamble no`. Otherwise leave
the default.

```
> tail -c 200 appendonly.aof
   ... binary RDB bytes ...REDIS0011 ... 
   *3
   $3
   SET
   $3
   foo
   $3
   bar
   ...
```

That mid-file binary boundary is the RDB preamble end + RESP begin.

---

## 10.6 Multi-Part AOF (Redis 7.0+)

Redis 7 split the AOF into a **manifest + multiple part files**:

```
   appendonly.aof.manifest                    <-- metadata
   appendonly.aof.1.base.rdb                   <-- RDB-format base
   appendonly.aof.1.incr.aof                   <-- incremental commands since base
   appendonly.aof.2.incr.aof                   <-- next chunk after first incr fills
```

Reasons:

- **Atomic rename of the manifest** instead of the (possibly huge) AOF.
- **Smaller part files** are friendlier to backup tools.
- **Easier rollback**: if a rewrite fails, the manifest still points at the
  old base+incr; the failed temp files are simply orphaned.

Configurable via `appenddirname` (the directory where parts live):

```
appendfilename "appendonly.aof"          # base name
appenddirname "appendonlydir"            # directory containing manifest + parts
```

You may see this in `INFO persistence`:

```
aof_current_base_file:appendonly.aof.1.base.rdb
aof_current_incr_file:appendonly.aof.1.incr.aof
```

Operationally treat the directory as a unit. Don't manually mess with
individual part files.

---

## 10.7 Loading on Startup

If both RDB and AOF exist:

```
> redis-server /etc/redis.conf
1717000000:M * Reading RDB preamble from AOF file...
1717000000:M * RDB preamble loaded, reading the AOF tail...
1717000000:M * DB loaded from append only file: 12.345 seconds
```

When `appendonly yes`, Redis loads from AOF (it's newer and AOF subsumes
RDB). With hybrid AOF it reads the RDB preamble fast, then replays the
text tail.

If only RDB exists, RDB is loaded.

If both exist but AOF is missing the RDB preamble (legacy), AOF wins
anyway because of the `appendonly yes` flag.

### 10.7.1 What if the AOF is corrupt mid-file?

```
aof-load-truncated yes          # default: load up to last good command
aof-timestamp-enabled no        # if yes, AOF includes timestamps for PITR
```

Truncated load: Redis reads commands sequentially until it hits something
malformed, logs a warning, and stops. The data after the corruption is
lost.

If `aof-load-truncated no`, Redis refuses to start. You must fix the AOF
manually:

```bash
redis-check-aof --fix /path/to/appendonly.aof
```

This walks the file, identifies the last valid command boundary, and
truncates the rest. **It is destructive** — make a backup first.

---

## 10.8 Monitoring AOF

```
> INFO persistence
loading:0
aof_enabled:1
aof_rewrite_in_progress:0
aof_rewrite_scheduled:0
aof_last_rewrite_time_sec:5
aof_current_rewrite_time_sec:-1
aof_last_bgrewrite_status:ok
aof_last_write_status:ok
aof_last_cow_size:67108864
aof_current_size:1073741824        # 1 GB
aof_base_size:536870912            # last rewrite produced 512 MB
aof_pending_rewrite:0
aof_buffer_length:0                # in-memory aof_buf size
aof_pending_bio_fsync:0            # BIO fsync queue depth
aof_delayed_fsync:0                # how many times BIO fsync got delayed
```

Watch:

- `aof_last_write_status:err` — disk full or hardware fault.
- `aof_delayed_fsync` climbing — BIO fsync isn't keeping up. Slow disk.
- `aof_pending_bio_fsync` > 0 — fsync queue backed up. Same diagnosis.
- `aof_current_size / aof_base_size` ratio approaching `auto-aof-rewrite-percentage`
  → next rewrite is imminent.

Tied to latency monitor:

```
> LATENCY LATEST
1) 1) "fsync"
   2) (integer) 1717000000
   3) (integer) 350         # 350ms event
   4) (integer) 1500        # max in this window
```

---

## 10.9 Operational Patterns

### 10.9.1 RDB + AOF (most common)

```
save 3600 1
save 300 100
save 60 10000
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
aof-use-rdb-preamble yes
```

RDB for backup snapshots (point-in-time, easy to ship). AOF for durability
(everysec ≤ 1s loss). Hybrid AOF for fast restart.

### 10.9.2 RDB only

For pure caches where any data loss is acceptable. Fast write throughput
with no fsync penalty.

### 10.9.3 AOF only

Possible but rare. You lose the easy "ship the dump.rdb to backup S3"
pattern. The hybrid AOF can serve as a backup, but it's larger and the
manifest is more involved.

### 10.9.4 Neither

For ephemeral caches in K8s with replicas (the replica IS your durability).
Fastest configuration. Lose all data on restart, but if you're using
Redis as a hot-cache layer in front of Postgres, you don't need
persistence.

### 10.9.5 Disable persistence on replicas to reduce fork pressure

It's common to run RDB+AOF on the primary and **nothing** on the replicas.
Reasons:
- Replicas re-sync from primary if they fall behind.
- Replicas don't need to be durable independently — the primary is.
- Avoiding fork on replicas means lower memory headroom needed.

---

## 10.10 The Order of Apply: AOF, Replication, Persistence

A subtle correctness issue:

```
client: SET k v
   |
   v
processCommand: mutate keyspace
   |
   +-> propagate to AOF (appended on success)
   +-> propagate to replicas (sent on success)
   +-> reply to client
```

The client gets the OK *before* the AOF is fsynced (in `everysec` mode) and
*before* the replica acks. Redis is **eventually durable** even with AOF
on. Synchronous durability requires:

- `appendfsync always` — guarantees on-disk before reply.
- `WAIT N timeout` — waits for N replicas to ack before continuing.

The combination `appendfsync always` + `WAIT 1 1000` gives you "synced to
disk on primary AND acked by at least one replica." That's about as
durable as Redis gets — and it costs ~5-30 ms per write.

>>> **Interview insight**: This is the right answer to "how do you make
>>> Redis writes durable?" There is no setting that magically gives you
>>> Postgres-like durability. You opt in piece by piece: fsync, WAIT, and
>>> at the cost of significant latency.

---

## 10.11 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `aof.c` | AOF write path, rewrite, manifest, multi-part AOF |
| `rio.c` | Buffered I/O abstraction used by AOF and RDB |
| `bio.c` | BIO threads for AOF fsync |
| `replication.c` | `WAIT` command |
| `aof-manifest.c` | Multi-part AOF manifest format and orchestration |

`aof.c` is ~3500 lines and covers everything in this chapter; the manifest
file is ~700 lines on top.

---

## Practice Questions

1. Walk through the full path of `SET k v` from `processCommand` to
   on-disk durability under `appendfsync everysec`. Where exactly is the
   acknowledgement to the client emitted relative to fsync?
2. AOF rewrite uses fork. Compare its COW dynamics to BGSAVE — same or
   different?
3. The default `auto-aof-rewrite-percentage 100` triggers rewrite when
   the AOF doubles. Under what workload would this be too eager? Too
   lazy?
4. You're running `appendfsync always` and `auto-aof-rewrite-percentage
   200`. Latency suddenly spikes during rewrite. What's a likely cause
   and what's the fix?
5. After a crash, AOF is truncated mid-command. `aof-load-truncated yes`.
   What state does Redis come up in? What should you check?
6. Hybrid AOF puts an RDB preamble at the head of the file. What load
   speedup does this give you, and why? When would you turn it off?
7. You configured `WAIT 2 100` after every important write. The replica
   set has 1 healthy replica + 1 lagging. What's the behavior? What's
   the latency cost?

(Answers at end of Chapter 22.)
