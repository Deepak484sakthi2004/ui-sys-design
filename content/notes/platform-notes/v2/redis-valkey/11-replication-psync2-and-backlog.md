# Chapter 11: Replication — PSYNC2 and the Backlog

> Replication is how a single Redis becomes a small distributed system.
> One primary streams every write, in order, to one or more replicas.
> The protocol that does this — PSYNC2 — has to handle network blips,
> primary failovers, replica restarts, and load spikes without ever
> shipping more data than necessary. The genius is in the **replication
> backlog**: a single circular buffer that turns a 30-second network
> outage into a 30-second resync instead of a 30-minute full sync.
> Get this chapter right and you can debug any replication issue in
> production.

---

## 11.1 The Big Picture

```
                    +-----------+
                    |  PRIMARY  |
                    |  (master) |
                    +-----------+
                       |   |   |
        +--------------+   |   +--------------+
        |                  |                  |
        v                  v                  v
   +---------+       +---------+        +---------+
   | REPLICA |       | REPLICA |        | REPLICA |
   |   r1    |       |   r2    |        |   r3    |
   +---------+       +---------+        +---------+
```

Each replica:

- **Keeps a complete copy** of the primary's keyspace in its own RAM.
- **Receives every write** from the primary as a stream of RESP commands
  (the "replication stream").
- **Applies writes locally** in the same order as the primary.
- **Optionally serves reads** to clients (reduces primary load).
- **Optionally is itself a replica's primary** (chained replication, used
  rarely but supported).

What replication is **not**:

- **Not synchronous.** The primary acks writes to the client before the
  replica receives them. There is *no* default backpressure.
- **Not consensus.** There's no quorum, no log truncation, no two-phase
  commit. If primary acks then crashes before propagating, that write is
  lost.
- **Not transactional across replicas.** The primary's order is the
  global order; replicas converge but with lag.

These constraints flow from Redis's "fast first, durable second" design.
We will see how to soften them with `WAIT`, `min-replicas-to-write`,
and Sentinel/Cluster failover.

---

## 11.2 The Three Layers of Replication

### 11.2.1 Layer 1: The Replication Stream

Every write executed on the primary is **also** appended to an in-memory
buffer called the **replication backlog** *and* sent to all connected
replicas as RESP commands. Same wire format as client commands.

```
client: SET k v
   |
   v
processCommand
   +-> mutate keyspace
   +-> propagate(args, dbid, flags)
        +-> feedReplicationBacklog(commands)
        +-> for each replica c: addReply(c, command_resp_bytes)
```

The replicas receive these and apply them via the same `processCommand`
path that handles client commands. There's no special "replica command"
path — replicas literally execute the commands as if they were issued by
a client.

### 11.2.2 Layer 2: The Replication Backlog

A **circular buffer** in the primary's RAM that mirrors the most recent
chunk of the replication stream:

```c
char *repl_backlog;
long long repl_backlog_size;       // capacity
long long repl_backlog_histlen;    // bytes currently in the backlog (≤ size)
long long repl_backlog_off;        // global stream offset of the first byte in the buffer
long long repl_backlog_idx;        // write head within the circular buffer
```

```
   stream offsets ------>  ... 1000  1001  1002  ...  N-1  N    (N = current write head)
                                              ^
   replicas at various offsets               primary's position
   (lag indicated by gap from N)

   replication backlog (circular, e.g., 256 MB):
   +----------------------------------------------------+
   | bytes from offset (N - repl_backlog_histlen) to N  |
   +----------------------------------------------------+
                                                ^
                                       repl_backlog_idx (write head)
```

The backlog **does not start until the first replica connects** — it's
allocated lazily.

### 11.2.3 Layer 3: Per-Replica TCP Stream

Each replica has a TCP connection to the primary. The primary writes the
replication stream to each replica's output buffer. Standard `client`
struct, standard `addReply`, standard event-loop write path.

If a replica is slow, its output buffer grows. If it grows past
`client-output-buffer-limit replica`, the primary kills the connection.
The replica reconnects and tries to resync (next section).

---

## 11.3 PSYNC2: How a Replica Resyncs

The trick is: when a replica connects (or reconnects), how do we figure
out whether to send it the entire database (full resync) or just a few
recent commands (partial resync)?

PSYNC2 (the v2 of the protocol, since Redis 4.0) uses two values per
primary:

```
replid  - a 40-byte hex string identifying this primary's history
offset  - the cumulative byte count of the replication stream
```

Replicas remember the (replid, offset) of their last successful sync.

When a replica reconnects:

```
replica: PSYNC <last_replid> <last_offset+1>
primary: 
   if replid matches AND (last_offset+1) is still in the backlog:
     +CONTINUE [<new_replid>]              <-- partial resync
     ... stream remaining bytes ...
   else:
     +FULLRESYNC <replid> <offset>         <-- full resync
     ... stream RDB ...
     ... stream backlogged bytes ...
```

The bytes "remaining in the backlog" are determined by:

```
   (last_offset+1) >= repl_backlog_off  AND  (last_offset+1) <= repl_backlog_idx_global
```

If the offset is **older than the start** of the backlog, partial resync
is impossible — too much has been overwritten. The primary falls back to
a full resync.

>>> **Interview insight**: This is the single most important number to
>>> tune in Redis replication: `repl-backlog-size`. If the backlog is too
>>> small, every network blip causes a full resync — which is expensive
>>> for the primary (fork + RDB stream + buffered backlog catch-up). Tune
>>> the backlog to **(write rate) × (max acceptable disconnect window)**.

---

## 11.4 The Three Replication States on a Replica

```
   REPL_STATE_NONE           Not configured as a replica
   REPL_STATE_CONNECTING     Trying to TCP-connect to primary
   REPL_STATE_RECEIVE_PING   Connected; sending PING to verify
   REPL_STATE_SEND_AUTH      Authenticating
   REPL_STATE_SEND_REPLCONF  Sending REPLCONF (port, capabilities)
   REPL_STATE_SEND_PSYNC     Sending PSYNC
   REPL_STATE_RECEIVE_PSYNC_REPLY
   REPL_STATE_TRANSFER       Receiving RDB (full sync only)
   REPL_STATE_CONNECTED      Streaming live updates
```

You can see the live state with:

```
> INFO replication
role:slave
master_host:10.0.0.5
master_port:6379
master_link_status:up
master_last_io_seconds_ago:0
master_sync_in_progress:0
slave_read_repl_offset:1234567890
slave_repl_offset:1234567890
slave_priority:100
slave_read_only:1
connected_slaves:0
master_failover_state:no-failover
master_replid:abc123...def
master_replid2:0000...0000
master_repl_offset:1234567890
second_repl_offset:-1
```

`master_link_status:up` is what you watch in monitoring. Anything else
means trouble.

---

## 11.5 The Full Resync Sequence

Step-by-step, from the moment a replica issues `PSYNC ? -1` (no prior
sync state):

```
replica -> primary: PSYNC ? -1

primary thinks:
  unknown replid -> full sync needed
  
primary -> replica: +FULLRESYNC <replid> <offset>

primary forks (or reuses an in-progress save)
primary's child: serialize keyspace to RDB, stream over socket OR write to disk

while RDB is streaming:
  primary buffers new write commands in
    server.repl_buffer (per-replica buffer for "during sync" commands)

replica receives RDB:
  load into a temporary keyspace
  
RDB transfer ends:
  primary streams the buffered commands
  primary marks replica as REPL_STATE_CONNECTED
  
replica:
  atomic swap: temp keyspace -> live keyspace
  apply buffered commands
  ready
```

### 11.5.1 The Atomic Swap

The replica loads RDB into a *temporary* keyspace (a separate `redisDb`
struct). When done, it deletes the existing keyspace (lazily, via BIO)
and replaces it with the temporary. This means:

- The replica continues serving stale reads from its existing keyspace
  during the RDB load.
- Once loaded, all reads start hitting the new keyspace.
- The old data is freed in the background.

(!) **Production hazard**: During the swap, **memory roughly doubles**
  on the replica. The old + new keyspaces both exist briefly. If the
  replica is RAM-constrained, sync can OOM it.

### 11.5.2 Diskless Replication

`repl-diskless-sync yes` (default in Redis 7+) makes the primary stream
RDB bytes from the child *directly to the replica's socket* without
writing to local disk. Saves disk I/O on the primary.

The primary's child opens pipes to all sync-ing replicas and writes the
RDB through them. With multiple replicas, all get the same bytes.

`repl-diskless-sync-delay 5`: when a replica connects, wait up to 5
seconds for additional replicas to connect before starting the diskless
sync. This batches multiple replicas into one fork — important if you're
bringing up many replicas at once.

### 11.5.3 Diskless Replica Load

`repl-diskless-load`: how the replica handles the incoming RDB.

| Value | Behavior |
|-------|----------|
| `disabled` (default) | Replica writes RDB to disk first, loads from disk |
| `swapdb` | Replica loads RDB straight into memory (a new tempdb), then swaps |
| `on-empty-db` | Same as swapdb, but only if existing DB is empty |

`swapdb` saves the disk write but keeps memory at 2x peak during the
swap. `disabled` is safer for tight-memory replicas.

---

## 11.6 Partial Resync: The Backlog Hit

When a replica reconnects within the backlog window:

```
replica -> primary: PSYNC abc123def 543000

primary thinks:
  replid matches my current replid
  offset 543000 still in my backlog (start = 500000, end = 600000)
  
primary -> replica: +CONTINUE
... stream bytes from offset 543000 onwards ...

primary appends new commands as they happen
replica catches up; once at the live offset, normal operation resumes
```

Cost: **only the missed bytes are transferred**. A 30-second blip with
5 MB/sec write rate transfers 150 MB. A full resync of a 100 GB dataset
would have transferred 100 GB. ~700x less data, ~700x less primary CPU.

### 11.6.1 The replid Handoff Trick (PSYNC2)

When a replica is promoted to primary (after a failover), it inherits
the **old primary's replid as a secondary "replid2"**. This means:

- New writes go to a fresh replid (new master_replid).
- But replicas of the old primary, reconnecting to the new primary, can
  still partial-resync via replid2.

```
old primary state: replid=A, offset=1000
old primary dies.
new primary (was replica): inherits A as replid2 with offset=1000,
                           starts new replid=B at offset=1001
                           
old replica (was at offset=999): connects to new primary
                                  PSYNC A 1000
                                  new primary checks: yes, replid2 matches
                                  +CONTINUE, stream new replid bytes
```

Without this, every failover would force every replica to do a full
resync. PSYNC2 makes failover lightweight.

### 11.6.2 Chained Replication and replid

A replica can itself be the primary of another replica. The chain
inherits the same replid. Failover anywhere in the chain still works
because every node knows the chain's replid.

---

## 11.7 Replica Read-Only and `READONLY`

By default `replica-read-only yes`. Writes to a replica are rejected:

```
> SET k v on replica
(error) READONLY You can't write against a read only replica.
```

You can override per-connection: `READONLY` flips the connection to
allow reads from a replica in cluster mode. (Without this, cluster
clients always send to the primary of a slot.)

Set `replica-read-only no` only if you have a use case where a replica
serves write traffic that doesn't need to propagate (e.g., local
session state for a region). Almost never.

---

## 11.8 Replica Lag and `WAIT`

```
> WAIT <numreplicas> <timeout_ms>
(integer) 2          # number of replicas that confirmed
```

`WAIT` blocks the client until either `numreplicas` have caught up to
the current offset OR `timeout_ms` elapses. Returns the count of replicas
caught up.

Use case: critical write that needs propagation before you confirm to a
user (e.g., an OAuth grant).

```python
client.set("auth:tok", token, ex=3600)
# now ensure at least 1 replica has it before we tell the user "logged in"
n = client.wait(1, 500)            # wait up to 500ms for 1 replica
if n < 1:
    raise Exception("not durable")
```

`WAIT` itself is non-blocking on the server (the client is parked,
waiting for replication acks via `REPLCONF ACK`). The primary keeps
serving other clients.

`min-replicas-to-write 1` and `min-replicas-max-lag 10`: refuse writes
unless at least 1 replica is connected and lagging ≤ 10s. A weaker but
permanent form of `WAIT`. If both replicas die, the primary stops
accepting writes — fail-stop safety.

>>> **Interview insight**: `WAIT` is **not** synchronous replication. It's
>>> "wait for async replication to finish for THIS client right now." You
>>> can `WAIT` after every important write — but if the primary crashes
>>> before the replica acks, the write is still lost (the primary's `WAIT`
>>> would have returned 0 and you should refuse the user-visible
>>> acknowledgement). It's an opt-in durability primitive, not a default.

---

## 11.9 Replica → Primary Acknowledgements

Replicas periodically send `REPLCONF ACK <offset>` to inform the primary
of their progress. By default every second. The primary uses these to:

- Compute lag per replica.
- Drive `WAIT` completion.
- Decide when to send the no-op `PING` to keep the link alive.

```
> INFO replication       # on primary
connected_slaves:2
slave0:ip=10.0.0.6,port=6379,state=online,offset=1234567890,lag=0
slave1:ip=10.0.0.7,port=6379,state=online,offset=1234567000,lag=1
```

`lag` is in seconds since the last ACK. `offset` is the replication
stream offset the replica has confirmed receiving. The primary's
`master_repl_offset` is the latest write offset; difference is lag in
bytes.

---

## 11.10 The Replica Output Buffer Limit

Recall from Chapter 3:

```
client-output-buffer-limit replica 256mb 64mb 60
```

If a replica is slow and the primary's output buffer to that replica
exceeds these limits, the primary disconnects the replica. The replica
reconnects and tries `PSYNC` again.

If the disconnection lasted long enough that the backlog rolled past
the replica's offset, **a full resync triggers**. Now we have:

- The primary forks (latency spike).
- A 100 GB RDB streams over the network.
- The replica swaps keyspaces (memory spike).
- More importantly: during the sync, the replica's *output buffer* on
  the primary fills again because the primary is appending all-the-writes-since-fork.

If that buffer hits the limit too, it disconnects again. **Cycle.**

This is the production "replica keeps falling behind" failure mode. The
fix is one of:

1. Raise `client-output-buffer-limit replica` to allow bigger buffers
   (RAM cost on primary).
2. Raise `repl-backlog-size` so partial resync covers the disconnect
   window.
3. Faster network/disk on the replica.
4. Reduce write throughput.

---

## 11.11 Replica of Replica

Chained replication:

```
   primary ----> replica1 ----> replica2
                                 (replica1 is replica2's "primary")
```

Use cases:
- **Geographic distribution**: primary in US, replica1 in EU, replica2..N
  read replicas in EU. Reduces transatlantic bandwidth.
- **Reducing primary load**: instead of 10 replicas each fanning from the
  primary, 2 fanning from the primary and 4 each fanning from those.

Caveats:
- Lag accumulates per hop.
- replica1 must be `replica-serve-stale-data yes` so it serves replica2
  during sync.
- Failure modes are more complex.

Most people don't need this. Use it only if the bandwidth math demands it.

---

## 11.12 The Failover Story (Manual)

```
> on a replica:
> REPLICAOF NO ONE             # promote: stop replicating, become primary
> on the old primary (if alive):
> REPLICAOF new-host new-port  # demote: become replica of the new primary
> on other replicas:
> REPLICAOF new-host new-port  # repoint
```

Each step is a single command. The new primary inherits its current
replid as its primary replid. The old primary's replid becomes the new
primary's replid2 (so other replicas can partial-resync via it).

Manual failover is the foundation Sentinel and Cluster use to automate.
Chapter 12 (Sentinel) and Chapter 13 (Cluster) detail the orchestration.

`CLUSTER FAILOVER` (in cluster mode) and `FAILOVER` (in non-cluster mode,
Redis 6.2+) are higher-level: they pause writes briefly to drain in-flight
commands before promotion, ensuring no acknowledged writes are lost during
the swap.

---

## 11.13 Common Replication Errors

| Error log | Likely cause | Fix |
|-----------|--------------|-----|
| `Master replied with status: NOMASTERLINK` | Replica's replica is asking for sync but the chain head is broken | Fix chain head |
| `Partial resynchronization not possible (no cached master)` | Replica restarted and lost its replid; trying full sync now | Normal after restart |
| `Master <-> Replica sync: parsing the synchronization stream` | Replica is loading RDB during sync; nothing wrong | Wait |
| `Master is not able to PSYNC to the slave` | replid/offset out of backlog | Increase `repl-backlog-size` |
| `Replica connected but not receiving from master` | Probably client-output-buffer-limit hit | Bump or fix lag |
| `Background AOF buffer size: N MB` | Lots of writes during sync; AOF rewrite buffer growing | Normal during sync |

---

## 11.14 Reading INFO Replication

The fields you actually look at:

| Field | Meaning |
|-------|---------|
| `role:master / slave` | Self-evident |
| `connected_slaves:N` | Number of replicas connected to primary |
| `master_link_status:up` | Replica's view of the link |
| `master_last_io_seconds_ago` | Seconds since last byte from primary; > 0 means stalled |
| `master_sync_in_progress:0/1` | Replica currently in full sync |
| `slave_repl_offset:N` | Replica's confirmed offset |
| `master_repl_offset:N` | Primary's current offset |
| Difference in offsets | Lag in bytes |

Replication lag in bytes is the most precise leading indicator. Lag in
seconds is good for human dashboards.

---

## 11.15 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `replication.c` | All replication logic: PSYNC, backlog, replica state machine |
| `server.h` | `repl_*` fields on the server struct |
| `aof.c` | AOF interaction with replication during sync |
| `rdb.c` | RDB transfer for full sync |

`replication.c` is dense (~5000 lines) but each section maps cleanly to a
state in the protocol. Read it alongside the PSYNC2 RFC-style spec at
`https://github.com/valkey-io/valkey/blob/unstable/redis.conf` (look for
the replication section).

---

## Practice Questions

1. A replica is disconnected for 90 seconds. Average write rate is 10 MB/s.
   `repl-backlog-size` is 256 MB. Will partial resync work? What's the
   expected behavior?
2. You execute `WAIT 2 1000` after a critical write. There are 3 replicas;
   2 are healthy and one is restarting. The command returns 2 in 50ms.
   Are you durable? What if the primary crashes 100ms later?
3. The primary's replid is `A`, offset 1000. It crashes. A replica at
   offset 999 is promoted. What's the new primary's replid? What's its
   replid2? What can other replicas at offset 999 do?
4. A team enables `replica-read-only no` to use replicas as scratchpads.
   What's the immediate operational risk?
5. Walk through what happens if two replicas connect simultaneously and
   neither is in the backlog window. Will they share a fork?
6. A 200 GB Redis primary is doing diskless replication to two replicas.
   One replica drops mid-sync. What's the recovery story for that
   replica?
7. `min-replicas-to-write 1, min-replicas-max-lag 10` and both replicas die.
   What does a write client see? How is this different from `WAIT 1 100`?

(Answers at end of Chapter 22.)
