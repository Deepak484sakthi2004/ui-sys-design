# Chapter 9: Persistence I — RDB and Fork-Based Snapshots

> Redis lives in RAM. Persistence is the bridge between RAM and disk that
> keeps your data alive across restarts. RDB is the older, simpler option:
> a binary memory dump produced by a forked child while the parent keeps
> serving traffic. The fork-and-dump pattern is brilliant in concept and
> hostile in production — it underlies the trickiest operational issues
> you'll ever debug. This chapter takes you from the on-disk byte format
> all the way to the OS kernel's copy-on-write machinery.

---

## 9.1 Why RDB Exists

Redis needs three things from a persistence layer:

1. **Restart with state.** After a crash or planned restart, load the
   most recent state.
2. **Backup-friendliness.** Hand a coherent file to your backup system.
3. **Replication bootstrap.** When a replica connects fresh, ship it a
   complete state in one go (Chapter 11 details this).

RDB does all three with one mechanism: a periodic snapshot of the entire
keyspace serialised to a single binary file.

The trade-off vs AOF (Chapter 10):

| Feature | RDB | AOF |
|---------|-----|-----|
| Recovery RTO | Fast (seconds-minutes) | Slow (replay all writes) |
| Recovery RPO (data loss window) | Up to last snapshot interval | Up to last fsync |
| File size | Compact (binary) | Larger (textual commands) |
| CPU during persist | Periodic spike (fork + serialise) | Steady (write to buffer + fsync) |
| Suitable for backups | Yes | Less so |

Most production deployments run **both**. RDB for backups and replica
bootstrap; AOF for durability between snapshots.

---

## 9.2 The High-Level Flow: BGSAVE

```
client: BGSAVE         (or automatic save trigger)
   |
   v
parent: rdbSaveBackground()
   |
   +--------> fork()
   |              |
   |              v
   |          child: rdbSave() to temp file
   |              |
   |              v
   |          child: rename(temp, dump.rdb)
   |              |
   |              v
   |          child: exit(0)
   v
parent: keep serving traffic; SIGCHLD wakes
        backgroundSaveDoneHandler()
        which logs success and updates server.dirty
```

Three things to internalise:

1. The **parent never writes to disk**. Only the child does.
2. The **child sees an immutable snapshot of memory at the moment of
   `fork()`**. The kernel's copy-on-write makes this possible.
3. The **parent keeps mutating its own copy of memory**. Those mutations
   trigger COW page faults that *increase* parent RSS — the famous
   "fork doubles your memory" myth (it can, but only in worst case).

We will spend the rest of this chapter unpacking each.

---

## 9.3 The RDB File Format

RDB is binary. Format (Redis 7.x, version 11):

```
   "REDIS"   "0011"     <aux fields>     <db sections>     <EOF>   <crc64>
   magic     version    metadata          per-database     marker  checksum
   (5 bytes) (4 bytes)
```

### 9.3.1 Aux fields

Key/value pairs of metadata at the head of the file. Examples:

```
redis-ver: "7.4.0"
redis-bits: 64
ctime: 1717000000
used-mem: 1342177280
repl-stream-db: 0
repl-id: "abc...def"
repl-offset: 1234567890
aof-preamble: 0
```

### 9.3.2 Per-database sections

Each `SELECTDB <db_id>` is followed by:

```
RESIZEDB <total_keys> <total_keys_with_expire>     # hint for receiver
... per-key entries ...
```

Each key entry:

```
[ optional EXPIRETIME_MS marker + 8-byte ms timestamp ]
[ optional FREQ marker + 1-byte LFU counter ]
[ optional IDLE marker + variable idle time ]
[ object type byte ]
[ key (length-prefixed string) ]
[ value (type-specific encoding) ]
```

The "object type byte" is one of ~25 values: it picks both the high-level
type *and* the encoding. RDB has its own encoding namespace separate from
in-memory encodings — e.g., `RDB_TYPE_SET_LISTPACK`, `RDB_TYPE_ZSET_LISTPACK_2`.

### 9.3.3 Length encoding

RDB uses a variable-length integer encoding to be space-efficient:

| First byte | Meaning |
|------------|---------|
| `00xxxxxx` | 6-bit length: 0–63 |
| `01xxxxxx yyyyyyyy` | 14-bit length: 0–16383 |
| `10000000 4 bytes` | 32-bit length |
| `10000001 8 bytes` | 64-bit length |
| `11xxxxxx` | Special encoding (integers, LZF compression) |

So a hash with 3 fields takes 1 byte for the length. A list with 50 elements
takes 1 byte. This keeps RDB files compact for typical small collections.

### 9.3.4 String encoding inside RDB

Strings can be:

- **Length-prefixed raw bytes** (default).
- **8/16/32-bit integer** (e.g., the value `42` is encoded in 2-3 bytes
  not as the string `"42"`).
- **LZF compressed** if `rdbcompression yes` (default) and the original is
  long enough to compress.

LZF is fast (~500 MB/s) but compresses ~50% on typical text. The CPU cost
in the child is real — disabling RDB compression for small datasets saves
fork CPU at modest disk cost.

### 9.3.5 The CRC64 trailer

The last 8 bytes are a CRC64 of everything before. Loading verifies the
checksum and refuses to load on mismatch (configurable). Catches partial
writes from a crashed save.

### 9.3.6 Reading an RDB file

You can decode RDB files offline:

```bash
redis-cli --rdb /tmp/dump.rdb       # streams it from a remote server
rdb-tools dump.rdb                   # python tool: lists keys, sizes
```

The `rdb-tools` package is invaluable for forensic analysis — "what's in
this dump? what's the biggest hash? how many keys with TTL?"

---

## 9.4 The Save Triggers

```
save 3600 1            # save if ≥ 1 change in 3600 sec
save 300 100           # save if ≥ 100 changes in 300 sec
save 60 10000          # save if ≥ 10000 changes in 60 sec
save ""                # disable automatic RDB
```

Multiple `save` lines are OR-ed together. Default Redis 7 has the three
above. Whichever fires first triggers `BGSAVE`.

`server.dirty` (write counter) is checked in `serverCron`. Triggering is
deliberately asynchronous — even at burst write rate, the next snapshot is
at least 60 seconds away, giving time for the previous fork to complete.

You can also trigger:

```
BGSAVE              # async, recommended
SAVE                # synchronous on main thread; freezes server (don't!)
```

`SAVE` is useful only for tooling/scripts that explicitly need a "this
process saves to disk before doing anything else" semantic. Never on
production.

---

## 9.5 The fork() Mechanic in Depth

`fork()` is the syscall that makes RDB work without freezing the server.

### 9.5.1 What fork() does

When the parent process calls `fork()`:

1. The kernel creates a new process struct (PID, descriptors, etc.).
2. The new process's virtual address space is a **copy of the parent's**.
3. **No physical pages are copied**. Both processes share the same
   physical pages, marked read-only.
4. `fork()` returns 0 in the child, child PID in the parent.

When *either* process writes to a shared page, the kernel:

1. Catches the write fault.
2. Allocates a new physical page.
3. Copies the original page to the new page.
4. Maps the new page writable into the writing process.
5. Resumes the write.

This is **copy-on-write (COW)**. Conceptually: "share until divergence."

### 9.5.2 Why this lets RDB work

The child has a snapshot of memory at the moment of fork. From the child's
viewpoint, *nothing changes* — pages are read-only and consistent. The
child walks the dict, serialises every key, writes it to disk, exits.

The parent has a *mutable* view of the same memory. As writes happen, COW
kicks in to give the parent fresh pages. The child still sees the old
pages.

### 9.5.3 Why COW is dangerous on Redis

If 100% of the parent's memory pages get written between fork and child
exit, the parent's RSS doubles. For a Redis with 80 GB of data and a
write rate that touches every page in 5 minutes, you can OOM mid-save.

In practice, write rates are much lower than read rates, and writes
typically touch a small fraction of pages. Redis's `latest_fork_usec` and
`copy-on-write` stats let you measure this empirically:

```
> INFO memory
...
mem_fragmentation_ratio:1.20
mem_replication_backlog:1048576

> INFO persistence
loading:0
rdb_changes_since_last_save:1234
rdb_bgsave_in_progress:0
rdb_last_save_time:1717000000
rdb_last_bgsave_status:ok
rdb_last_bgsave_time_sec:5
rdb_current_bgsave_time_sec:-1
rdb_last_cow_size:268435456            # peak COW memory during last save
rdb_last_load_keys_expired:0
rdb_last_load_keys_loaded:0
```

`rdb_last_cow_size` is the killer metric. If your dataset is 100 GB and
`rdb_last_cow_size` is 5 GB, you have plenty of headroom. If it's 70 GB,
you're one bad save away from OOM.

>>> **Interview insight**: "Why does Redis sometimes OOM during BGSAVE?"
>>> Because COW dirtied pages **add to** parent RSS. Each dirty page costs
>>> 4 KB (the OS page size). A workload that randomly INCRs 1M keys during
>>> a save dirties at least 1M pages = 4 GB of new RSS. Combined with
>>> existing data, this can blow `maxmemory` (and thus the box's RAM).

### 9.5.4 Transparent Huge Pages: The Killer

On modern Linux, **THP (Transparent Huge Pages)** can default to enabled.
When THP is on, COW happens at 2 MB granularity instead of 4 KB.

Result: a single byte write to a key causes a **2 MB page copy**. For a
randomly-distributed write pattern, the multiplier is 512x.

```bash
# Check:
cat /sys/kernel/mm/transparent_hugepage/enabled
[always] madvise never              # bad
always [madvise] never              # good (Redis uses madvise)
always madvise [never]              # good

# Disable globally:
echo never > /sys/kernel/mm/transparent_hugepage/enabled

# Persist (Ubuntu/Debian):
# add to /etc/rc.local or use a systemd unit
```

(!) **Production hazard**: This is the single most common "Redis OOM during
  BGSAVE" cause. Redis logs a warning at startup if THP is enabled, but
  many people ignore it. If you don't disable THP, you can lose a server
  to one bad save.

### 9.5.5 The fork() time itself

`fork()` is not free. The kernel must duplicate page tables, which scales
with virtual memory size. For Redis with 80 GB of data:

```
Page table size = 80 GB / 4 KB = 20M pages × 8 bytes/PTE ≈ 160 MB
fork time ≈ 200 - 500 ms        (varies by kernel, CPU, NUMA)
```

Even though fork doesn't copy *data* pages, it copies *page tables*.
On big servers this means a half-second fork pause on the main thread.
**During the fork, no commands are processed.** This is one of those
"impossible to mitigate without re-architecting" pauses.

You can see it in `INFO`:

```
> INFO stats
latest_fork_usec:300000               # 300ms last fork
total_forks:42
```

`latest_fork_usec` going up over time as the dataset grows is a leading
indicator. At 1+ second forks, you should be considering vertical scaling
(more CPU/faster kernel) or sharding.

>>> **Interview insight**: This is why memory-rich Redis (>50 GB) is harder
>>> to operate than memory-light (< 10 GB). Fork pause grows linearly with
>>> RSS. At 200 GB you can see 1-2 second fork pauses — visible to clients
>>> as a connection timeout.

### 9.5.6 Diskless Replication

For replication bootstrap, Redis 6 added **diskless replication**: the
child sends RDB bytes directly to the replica's socket instead of writing
to disk first.

```
repl-diskless-sync yes
repl-diskless-sync-delay 5     # wait 5s for more replicas to join before starting
repl-diskless-sync-max-replicas 0
```

Saves the disk write hop. Useful when:
- Disk is slow / contended
- You have multiple replicas about to fresh-sync
- You want to avoid filling disk

Caveat: only one chance per fork. If a replica's connection drops mid-stream,
that replica must wait for the next sync — there's no resumable disk file.

---

## 9.6 What Gets Saved

RDB saves the entire keyspace **including expires**. Per-key TTL is stored
as an absolute timestamp. On load, expired keys are deleted at load time
(skipped) by default, configurable via `RDB_OPCODE_EXPIRETIME_MS` skipping.

What does **not** get saved:
- Pub/Sub subscribers (they're in-memory state on the connection)
- Client connection state
- Replication state (other than repl-id and offset for partial resync)
- Slow log entries
- LFU/LRU access stats (the field is present in RDB 9+, but only for keys
  with non-zero counters)

---

## 9.7 Loading RDB on Startup

```
> redis-server /etc/redis.conf
[Loading RDB...] reading file
1717000000:M 28 Apr 2026 10:00:00.000 * DB loaded from disk: 12.345 seconds
```

The load is **synchronous on the main thread**. During load:
- The server doesn't accept connections (TCP listener bound but accept loop
  isn't running).
- A 100 GB RDB takes ~3-5 minutes to load on modern hardware.

>>> **Interview insight**: "How do you minimise downtime on a Redis with
>>> 200 GB of data?" Answer: don't restart the primary. Failover to a
>>> replica that's already in memory; let the new primary serve traffic
>>> while the old one reloads in the background.

### 9.7.1 RDB checksum failure

If the trailer CRC doesn't match, by default Redis refuses to start. You
can override:

```
rdbchecksum yes                  # default
```

Setting `rdbchecksum no` lets Redis load corrupt RDBs (skipping anything
malformed). Useful for forensic recovery, dangerous as a default.

---

## 9.8 RDB-Backed Replica Bootstrap

When a replica connects fresh:

1. Replica sends `PSYNC ? -1` (no replid known).
2. Primary forks (or uses an existing in-progress save).
3. Primary streams RDB bytes to replica (file or socket).
4. While streaming, primary buffers new write commands in the **replication
   backlog**.
5. After RDB transfer ends, primary streams the buffered commands.
6. Replica is in sync. Future commands stream live.

The replica's perspective:

```
1. Open RDB socket / file
2. Load RDB into a temp keyspace
3. Atomically swap temp → live keyspace
4. Apply buffered commands
5. Resume normal traffic
```

The atomic swap means the replica goes from "old keyspace" directly to
"new keyspace" with no intermediate state. We get to the swap details in
Chapter 11.

---

## 9.9 Operational Practices

### 9.9.1 Watch `rdb_last_bgsave_status`

```
> INFO persistence
rdb_last_bgsave_status:ok
```

If this is `err`, the last save failed. Look at the server log immediately —
common causes are disk full, permission denied, child OOM, or fork failure.

### 9.9.2 Watch `latest_fork_usec`

If this is climbing into the seconds, your dataset is growing faster than
your fork capacity. Plan to shard.

### 9.9.3 Watch RSS during BGSAVE

```bash
watch -n 1 'redis-cli INFO memory | grep used_memory_rss'
```

You should see RSS grow during the save and shrink (mostly) after. The
peak should be ≤ 1.3x baseline for typical workloads.

### 9.9.4 Don't run BGSAVE on a tight-memory host

If RSS is at 70% of box RAM, fork's COW headroom is at most 30%. A bad
save can OOM-kill mysqld... I mean redis-server. Always size with fork
overhead in mind.

### 9.9.5 stop-writes-on-bgsave-error

```
stop-writes-on-bgsave-error yes      # default
```

When set, a failed `BGSAVE` causes the server to **refuse writes** until
the next successful save. The intent is "don't accept writes you can't
persist." If you're running RDB-only, this is essential.

If you're running AOF (so writes are durable independent of RDB), you can
set it to `no` — a stuck RDB shouldn't break writes.

---

## 9.10 The `MIGRATE` Command's Hidden RDB

Redis can ship a single key over the wire to another server using `MIGRATE`:

```
MIGRATE dst-host 6379 mykey 0 5000
```

Internally, `MIGRATE` serialises the key in a *one-key RDB-like format*
called the "DUMP/RESTORE" payload. You can also use it standalone:

```
> DUMP mykey
"\x00\x05hello\x09\x00\x6f\x53\x47\xfd..."
> RESTORE newkey 0 "<bytes from DUMP>"
```

The same format underlies `MIGRATE`, `DUMP`/`RESTORE`, and the `--copy`
backup pattern.

>>> **Interview insight**: This means you can move individual keys between
>>> Redis instances without setting up full replication. Useful for
>>> targeted migrations and resharding scripts.

---

## 9.11 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `rdb.c` | RDB save/load, the file format, fork orchestration |
| `rdb.h` | RDB type/opcode constants |
| `child.c`, `bio.c` | Background process management |
| `cluster.c` | `MIGRATE` command and DUMP/RESTORE wire format |
| `replication.c` | `replicationStartFork` etc. — replica bootstrap that hooks RDB |

`rdb.c` is ~3000 lines and worth a careful read — every conditional encoding
optimisation lives there.

---

## Practice Questions

1. Walk through what happens — kernel level — when a parent process with
   80 GB RSS calls `fork()`. How long does it take and why?
2. THP is enabled. Workload INCRs 1M random keys during a 30-second
   BGSAVE. Estimate COW memory overhead. Now disable THP. Re-estimate.
3. `rdb_last_cow_size` is 50% of `used_memory`. Is this concerning? Under
   what conditions would you act?
4. You see periodic 500ms p99 spikes that align with `BGSAVE` events. The
   dataset is 30 GB. What are the three most likely causes and the
   diagnostic for each?
5. You can't afford the fork pause. Can you turn off RDB entirely? What
   are the consequences for replication?
6. `stop-writes-on-bgsave-error yes` and disk fills up. What does a client
   see? What's the right operational response?
7. RDB compression (`rdbcompression yes`) is on. The child uses 50% more
   CPU than expected. When would you turn it off?

(Answers at end of Chapter 22.)
