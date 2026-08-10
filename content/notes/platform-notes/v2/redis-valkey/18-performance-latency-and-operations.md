# Chapter 18: Performance, Latency & Operations

> Most Redis incidents look the same: latency spike, then either
> recovery or escalation to "Redis is down." The cause is usually one
> of a small set of well-understood phenomena: a slow command, a
> synchronous fork, an AOF fsync stall, a big key, a hot key, or
> network/client-buffer trouble. This chapter is the playbook —
> diagnostics, dashboards, and fixes for each.

---

## 18.1 The Three Numbers You Watch

For any Redis in production:

```
INFO clients               -> connected_clients
INFO commandstats          -> calls, usec, usec_per_call per command
INFO memory                -> used_memory, used_memory_rss, mem_fragmentation_ratio
INFO persistence           -> last_save_time, latest_fork_usec, aof_pending_fsync
INFO replication           -> role, master_link_status, lag
INFO stats                 -> total_connections_received, instantaneous_ops_per_sec, etc.

> SLOWLOG GET 100
> LATENCY HISTORY event
> LATENCY GRAPH event
> CLIENT LIST                                    -- find slow client buffers
> MEMORY DOCTOR
> MEMORY USAGE bigkey
> CLUSTER INFO                                   -- in cluster mode
> DEBUG SET-ACTIVE-EXPIRE 0/1                    -- debug expiry
```

The three you watch always:

1. **p99 latency** of operations. Anything above your SLO is a problem.
2. **`master_link_status:up`** on every replica.
3. **Used memory** vs `maxmemory`.

Everything else is a leading indicator for one of these.

---

## 18.2 The Slow Log: Your Best Friend

Every command exceeding `slowlog-log-slower-than` microseconds (default
10000 = 10 ms) is logged in memory:

```
> CONFIG SET slowlog-log-slower-than 10000
> CONFIG SET slowlog-max-len 1024
> SLOWLOG GET 10
1) 1) (integer) 1234                  # unique id
   2) (integer) 1717000000              # unix timestamp
   3) (integer) 53000                   # 53 ms
   4) 1) "KEYS"
      2) "user:*"
   5) "10.0.0.1:55432"
   6) "myapp"                            # client name
2) ...
> SLOWLOG RESET                          # clear
> SLOWLOG LEN                            # how many entries
```

If your p99 is bad, **always start here**. 90% of the time the answer
is in the slow log.

Top offenders to look for:

- `KEYS *`, `KEYS pattern` — replace with `SCAN`
- `LRANGE k 0 -1` on big lists — replace with paged ranges
- `SMEMBERS huge_set` — replace with `SSCAN`
- `HGETALL huge_hash` — replace with `HSCAN`
- `SORT` on big collections
- `EVAL` of a bad script
- `DEL` of a huge compound type — use `UNLINK`
- `FLUSHDB` (sync) — use `FLUSHDB ASYNC`

---

## 18.3 The Latency Monitor

`SLOWLOG` only catches commands that finished slowly. The latency
monitor catches **events**: hiccups in the server itself.

Enable:

```
> CONFIG SET latency-monitor-threshold 100   # ms; events ≥ 100ms
```

Then:

```
> LATENCY LATEST
1) 1) "fork"
   2) (integer) 1717000000
   3) (integer) 350         # 350ms event
   4) (integer) 1500        # max in this window

2) 1) "fast-command"
   ...
```

Event types:

| Event | Cause |
|-------|-------|
| `event-loop` | Generic loop iteration too slow |
| `fast-command` | A fast O(1) command took too long — usually fork/COW or fsync |
| `command` | A command took too long |
| `fork` | `fork()` syscall took too long |
| `rdb-unlink-temp-file` | Cleanup of a temp RDB file |
| `aof-write-pending-fsync` | AOF write blocked on prior fsync |
| `aof-fstat` | AOF file system call slow |
| `aof-rewrite-diff-write` | AOF rewrite buffer I/O slow |
| `aof-rename` | Final rename of AOF rewrite slow |
| `expire-cycle` | Active expire cycle exceeded threshold |
| `eviction-cycle` | Eviction cycle slow |
| `eviction-del` | Single key delete during eviction slow |
| `active-defrag-cycle` | Active defrag cycle slow |

```
> LATENCY HISTORY fork
1) 1) (integer) 1717000000
   2) (integer) 350
2) 1) (integer) 1717000060
   2) (integer) 380

> LATENCY GRAPH fork
fork - high 380, low 200, avg: 290.5 (10 samples)

380 |        ##
    |    ##  ##
    |    ##  ##
    | ## ##  ## ##
    | ## ## ###### ##
    +-----------------
       1234567890

> LATENCY RESET                # clear all events
> LATENCY DOCTOR               # human-readable diagnosis
```

`LATENCY DOCTOR` is the killer command for a quick triage:

```
> LATENCY DOCTOR
Dave, I have observed the system; you have one major latency event:

1. There are 50 events of type "fork" that took on average 320ms.
   Forks are caused by RDB and AOF rewrite operations. Consider:
   - smaller dataset
   - faster CPU/kernel
   - disable transparent huge pages
   - move to diskless replication if you have replicas
```

---

## 18.4 INFO Decoded

`INFO` is a big text dump. The high-value sections:

### 18.4.1 INFO clients

```
connected_clients:543
cluster_connections:18
maxclients:10000
client_recent_max_input_buffer:512
client_recent_max_output_buffer:65536
blocked_clients:0
tracking_clients:0
clients_in_timeout_table:0
total_blocking_keys:0
```

Watch:
- `connected_clients` near `maxclients` — cap reached?
- `blocked_clients` — many blocked on `BLPOP`, `WAIT`, etc.?
- `client_recent_max_output_buffer` — slow consumer?

### 18.4.2 INFO commandstats

```
cmdstat_get:calls=12345678,usec=12345600,usec_per_call=1.0,...
cmdstat_set:calls=987654,usec=987600,usec_per_call=1.0,...
cmdstat_keys:calls=1,usec=53000,usec_per_call=53000.0,...
```

`usec_per_call` reveals expensive commands. The `KEYS` line above is
**screaming** at you — 53 ms per call, average!

### 18.4.3 INFO memory

```
used_memory_human:1.25G
used_memory_rss_human:1.50G
used_memory_peak_human:1.75G
maxmemory_human:4.00G
maxmemory_policy:allkeys-lru
mem_fragmentation_ratio:1.20
mem_fragmentation_bytes:268435456
mem_clients_normal:8388608
mem_replication_backlog:268435456
mem_aof_buffer:0
mem_total_replication_buffers:268435456
```

Watch:
- `used_memory` / `maxmemory` ratio
- `mem_fragmentation_ratio` (Chapter 8)
- `mem_replication_backlog` (Chapter 11)
- `mem_aof_buffer` growing → AOF is behind

### 18.4.4 INFO persistence

```
loading:0
rdb_changes_since_last_save:1234
rdb_bgsave_in_progress:0
rdb_last_save_time:1717000000
rdb_last_bgsave_status:ok
rdb_last_cow_size:268435456
aof_enabled:1
aof_rewrite_in_progress:0
aof_last_write_status:ok
aof_current_size:1073741824
aof_pending_bio_fsync:0
aof_delayed_fsync:0
```

Watch:
- `rdb_last_bgsave_status:err` → save failed
- `aof_last_write_status:err` → AOF write failed
- `aof_pending_bio_fsync` > 0 → fsync queue backed up
- `aof_delayed_fsync` climbing → BIO falling behind

### 18.4.5 INFO replication

```
role:master
connected_slaves:2
slave0:ip=10.0.0.6,port=6379,state=online,offset=1234567890,lag=0
slave1:ip=10.0.0.7,port=6379,state=online,offset=1234567000,lag=1
master_replid:abc...
master_repl_offset:1234567890
```

Watch:
- `state` is `online` (not `wait_bgsave` or `send_bulk`)
- `lag` ≥ 5s → replica is behind
- offset diff > backlog size → next disconnect = full resync

### 18.4.6 INFO stats

```
total_connections_received:1000000
total_commands_processed:100000000
instantaneous_ops_per_sec:50000
rejected_connections:0
keyspace_hits:90000000
keyspace_misses:10000000
expired_keys:1234567
evicted_keys:0
```

Watch:
- `keyspace_hits / (hits + misses)` = hit ratio. Below 90% = poorly
  cached.
- `evicted_keys` climbing → memory pressure.
- `rejected_connections` > 0 → maxclients hit.

---

## 18.5 Big Keys: Find Them, Fix Them

A "big key" is any single key with disproportionate memory or
operational cost. Common offenders:

- A single `LIST` with 1M elements
- A single `HASH` with 100K fields
- A single `SET` with 10M members
- A 100 MB string

Why bad:
- O(N) operations on the key freeze the server.
- Cluster resharding is slow (one slot dominated by one big key).
- `DEL` is single-threaded — use `UNLINK`.
- Memory accounting is skewed.

### 18.5.1 Find them: `redis-cli --bigkeys`

```bash
$ redis-cli --bigkeys
# Walks via SCAN; for each key reports type, size, sample
[00.00%] Biggest string  found so far '"foo"' with 5 bytes
[00.00%] Biggest list    found so far '"queue"' with 1234567 items
...
Biggest list at: queue       2453000 items
```

Slow on big DBs (minutes) but safe.

### 18.5.2 Find them by memory: `redis-cli --memkeys`

Similar, but ranks by `MEMORY USAGE` (real bytes including overhead)
instead of element count.

### 18.5.3 Fix them

- **List/Set/ZSet**: shard by some natural key (`feed:user:42:p0`,
  `feed:user:42:p1`, ...).
- **Hash**: same; use composite keys (`hash:user:42:bucket0`).
- **String**: compress; or split into chunks if very large.

### 18.5.4 Big key delete: always `UNLINK`

```
> UNLINK queue
# main thread: O(1) - just unlinks from dict, hands object to BIO
```

Versus `DEL`, which frees inline.

---

## 18.6 Hot Keys

A **hot key** = one key receiving outsized traffic. Single-threaded
execution means one CPU core handles all that traffic. At >50K ops/s
on a single key, you're CPU-bound on that one key.

### 18.6.1 Find them: `MONITOR` and `--hotkeys`

```bash
$ redis-cli --hotkeys
# Uses INFO keyspace + sampling; needs maxmemory-policy=allkeys-lfu or volatile-lfu
```

`--hotkeys` only works with LFU policies because it relies on the
`OBJECT FREQ` counter.

For non-LFU instances, sample with `MONITOR`:

```bash
$ redis-cli MONITOR | head -100000 | awk '{print $4}' | sort | uniq -c | sort -rn | head
   30000 "k1"
   15000 "k2"
    8000 "k3"
```

(`MONITOR` itself adds load — use briefly in non-peak.)

### 18.6.2 Mitigate hot keys

- **Add a local cache** (process-side LRU) for read-mostly hot keys.
  Combined with `CLIENT TRACKING` invalidations.
- **Replicate-and-spread**: read the key from any replica (via
  `READONLY`), spreading load across replicas.
- **Shard the key**: e.g., the rate limiter `requests:user:42` becomes
  `requests:user:42:shard{0..15}`, choose a random shard per increment,
  sum at read time.
- **Keep the hot key on its own node**: dedicate a Redis to a single
  hot key. (Rare but legitimate at extreme scale.)

---

## 18.7 Connection and Buffer Management

### 18.7.1 Watch Connections

```
> INFO clients
connected_clients:1500
maxclients:10000
```

Symptoms of too many connections:
- `rejected_connections` > 0
- High memory (each idle conn ~16 KB)
- Long handshake queue at startup (storms)

Fixes:
- Pool connections client-side (don't open per-request).
- Cap `tcp-backlog`.
- Limit per-IP connection rate at the load balancer.

### 18.7.2 Watch Buffers

```
> CLIENT LIST
id=12 addr=10.0.0.1:55432 obl=0 oll=0 omem=0 ...
id=13 addr=10.0.0.2:55433 obl=8388608 oll=4 omem=33554432 cmd=monitor
```

`omem` (output memory) > 0 means a slow consumer. `oll` (output list
length) is the depth of the output queue. A `MONITOR` connection (above)
is buffering 33 MB — kill it.

```
> CLIENT KILL ADDR 10.0.0.2:55433
```

---

## 18.8 The Latency Smoke Test

Before deeper diagnosis, run:

```bash
$ redis-cli --latency
min: 0, max: 16, avg: 0.50 (5234 samples)

$ redis-cli --latency-history
1707000000.000  min: 0, max: 5, avg: 0.45 (200 samples)
1707000005.000  min: 0, max: 16, avg: 0.51 (200 samples)
1707000010.000  min: 0, max: 12, avg: 0.48 (200 samples)
...
```

Just `PING`s in a loop. If the **server-side floor** is stable around
~0.5 ms, the network is fine. Spikes here ≥ 5 ms = something on the
server is causing event-loop stalls. Spikes only here, not in
application metrics, point at network.

---

## 18.9 The Common Production Incidents

### 18.9.1 "Latency spiked at 02:00 every night"

→ Cron-triggered `BGSAVE` or AOF rewrite. Check `INFO persistence`
timestamps. Possibly fork pause + COW. Mitigate: smaller working set,
diskless sync, faster CPU, disable THP.

### 18.9.2 "p99 just doubled this morning"

→ Probably a new code path issuing a bad command. `SLOWLOG GET 100`,
`INFO commandstats`. Look for new top entries. Often `KEYS *` from a
new admin endpoint.

### 18.9.3 "Replicas keep disconnecting"

→ `client-output-buffer-limit replica` hit, then partial-resync fails
(`repl-backlog-size` too small), full sync, repeats. Bump both.

### 18.9.4 "Memory is 90% full and growing"

→ Eviction policy and TTLs. `INFO memory`, `INFO stats`
`evicted_keys` and `expired_keys`. If `evicted_keys` is 0 and policy is
`noeviction`, you're about to OOM.

### 18.9.5 "We're getting `BUSY` errors"

→ A Lua script is running too long. `SCRIPT KILL` if no writes
happened; `SHUTDOWN NOSAVE` otherwise.

### 18.9.6 "Random `LOADING` errors"

→ Replica is loading RDB during sync. New replicas joining or a fast
disconnect-reconnect cycle. Wait it out, or scale out replicas with
diskless+swapdb.

### 18.9.7 "We see `OOM command not allowed`"

→ Memory at the cap with `noeviction`. Eviction policy is wrong, or the
working set has grown past `maxmemory`. Pick: scale up, change policy,
or shed traffic.

---

## 18.10 The Capacity Planning Worksheet

For each Redis instance:

```
Box CPU             N cores. Single-threaded execution + I/O threads.
Box RAM             X GB. Use 70-80% for Redis, 20-30% headroom.
maxmemory           Y GB. ~70% of box RAM.
maxmemory-policy    allkeys-lru / volatile-lru. Per workload.
maxmemory-samples   5..10.
maxmemory-clients   10% of maxmemory.
hz                  10 (default).

Persistence:
  save              60 10000 / 300 100 / 3600 1
  appendfsync       everysec
  auto-aof-rewrite  100% / 64mb
  no-appendfsync-on-rewrite  no

Replication:
  repl-backlog-size  estimate as (peak_write_rate × max_disconnect_window)
  client-output-buffer-limit replica  256mb 64mb 60
  min-replicas-to-write 0..N
  min-replicas-max-lag 10..30

Cluster (if applicable):
  cluster-enabled yes
  cluster-node-timeout 15000
  cluster-require-full-coverage yes

Network:
  TLS or not (10-30% CPU cost if yes)
  io-threads 4..8 (only helps if network-bound or TLS)

Monitoring:
  Prometheus exporter, Grafana dashboard
  Alerts on: master_link_status:down, used_memory > 90%, fork latency,
             slowlog rate, replica lag, evicted_keys rate
```

---

## 18.11 Key Operational Commands

```
> CONFIG GET maxmemory                                        # inspect
> CONFIG SET maxmemory 8gb                                    # change live
> CONFIG REWRITE                                              # save to redis.conf

> CLIENT PAUSE 1000                                           # pause processing for 1s (used during failover)
> CLIENT KILL ID 12                                           # disconnect a client
> CLIENT NO-EVICT ON                                          # this client is exempt from maxmemory-clients

> DEBUG SLEEP 5                                               # block server 5s (testing only!)
> DEBUG OBJECT k                                              # internal dump of key
> DEBUG JMAP                                                  # jemalloc stats

> MEMORY DOCTOR                                               # diagnostics
> MEMORY USAGE k                                              # bytes for one key
> MEMORY STATS                                                # detailed memory breakdown

> MONITOR                                                     # see every command (DON'T leave running)

> LATENCY DOCTOR                                              # diagnostics
> LATENCY GRAPH event-name

> REPLICAOF NO ONE                                            # promote (manual failover)
> REPLICAOF newprimary 6379                                   # demote

> CLUSTER FAILOVER [FORCE|TAKEOVER]                          # cluster manual failover
> CLUSTER RESET                                               # nuke local cluster state
> CLUSTER FORGET <node-id>                                    # manually remove a node
```

---

## 18.12 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `latency.c` | Latency event tracking |
| `slowlog.c` | The slow log |
| `debug.c` | DEBUG commands |
| `server.c` | INFO output, commandstats |
| `defrag.c` | Active defrag |

---

## Practice Questions

1. Your dashboard shows p99 latency tripled overnight. Walk through your
   diagnostic steps in order.
2. `aof_pending_bio_fsync` is 50. What does that mean and what's the
   fix?
3. A key returns `MEMORY USAGE` of 100 MB. The dataset is 10 GB. Is
   this a problem? What might be the cost?
4. `INFO commandstats` shows `cmdstat_keys:calls=1234,usec_per_call=53000`.
   What's the immediate action and what's the longer fix?
5. Your replica's `master_link_status` is `down` but the replica says
   `master_sync_in_progress:0`. Diagnose.
6. Active defrag is causing 5% CPU usage. `mem_fragmentation_ratio` is
   1.6. Should you let it run? When would you disable it?
7. A customer reports occasional `LOADING` errors. The cluster has 6
   nodes; this is one specific node. What's happening?

(Answers at end of Chapter 22.)
