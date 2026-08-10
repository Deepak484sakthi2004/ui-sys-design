# Chapter 12: Sentinel — Automated Failover

> Replication gives you backup copies of your data. Failover gives you a
> way to *use* those copies when the primary dies. Sentinel is Redis's
> automated failover orchestrator: a separate process (in fact a separate
> binary, though it's the same executable in a different mode) that
> watches the cluster, decides when the primary is dead, elects a new
> primary, and reconfigures everyone. This chapter walks through how
> sentinel decides "dead," how it picks a winner, and the dozen subtle
> ways a misconfigured sentinel deployment can split-brain you.

---

## 12.1 What Sentinel Is and Isn't

Sentinel is for **non-cluster** Redis deployments where you want
automatic primary failover. Topology:

```
                    +-----------+
                    |  PRIMARY  |
                    +-----------+
                       |   |
                       v   v
                 +---------+  +---------+
                 | replica |  | replica |
                 +---------+  +---------+

   monitored by:
   +-----------+    +-----------+    +-----------+
   | sentinel1 |<-->| sentinel2 |<-->| sentinel3 |
   +-----------+    +-----------+    +-----------+
                          ^
                          gossip; quorum decisions; failover orchestration
```

**It is**: a watchdog plus an orchestrator. Sentinels gossip with each
other and the data nodes. When enough sentinels agree the primary is
dead, one is elected as the failover orchestrator and runs `REPLICAOF
NO ONE` on a chosen replica.

**It is not**: a sharding or scaling layer. All your writes still go to
one primary. Sentinel only solves "the primary died; who's the new
primary?"

>>> **Interview insight**: Sentinel and Cluster (Chapter 13) solve different
>>> problems. Sentinel: failover for one shard. Cluster: sharding across
>>> many shards (each shard internally uses cluster's own primary-election,
>>> not Sentinel). You don't run them together.

---

## 12.2 Sentinel as a Process

```bash
redis-sentinel /etc/redis/sentinel.conf
# OR
redis-server /etc/redis/sentinel.conf --sentinel
```

Same binary. Different mode. The sentinel mode disables the dataset
operations and runs sentinel-specific code instead.

A typical sentinel config:

```
port 26379
sentinel monitor mymaster 10.0.0.5 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel parallel-syncs mymaster 1
sentinel failover-timeout mymaster 60000
sentinel auth-pass mymaster topsecret
```

`sentinel monitor mymaster 10.0.0.5 6379 2` means: "monitor a primary
named `mymaster` at 10.0.0.5:6379; quorum is 2 sentinels."

The "name" (`mymaster`) is how clients ask sentinels for the current
primary. Multiple Redis deployments share a sentinel cluster by giving
each a unique name.

---

## 12.3 What Sentinels Do, Continuously

Every second, each sentinel:

- Sends `PING` to the primary, every replica, and every other sentinel.
- Sends `INFO` to data nodes to learn topology (which primary is whose,
  who has which replicas).
- Publishes/subscribes on the `__sentinel__:hello` channel of every
  monitored data node — used to discover other sentinels.

```
Every 1 second:    PING all known nodes
Every 10 seconds:  INFO the primary (refresh topology)
Every 2 seconds:   PUBLISH/SUBSCRIBE __sentinel__:hello
```

Two states a sentinel tracks per primary:

- **SDOWN** (Subjectively Down): *this* sentinel hasn't heard a valid
  reply in `down-after-milliseconds`.
- **ODOWN** (Objectively Down): the *quorum* of sentinels say SDOWN.

A primary going ODOWN triggers failover voting.

---

## 12.4 The Failure Detector: SDOWN

`sentinel down-after-milliseconds mymaster 5000`

Each sentinel pings the primary every second. If none of the last
`down-after` ms pings got a valid reply (PONG, or an error that's still
"alive enough" like `-MASTERDOWN` from a replica), the sentinel marks
the primary **SDOWN** (subjectively down).

"Valid reply" includes:

- `+PONG` (healthy)
- `-LOADING` (loading RDB; busy but alive)
- `-MASTERDOWN` (replica reporting that *its* primary is down — sentinel
  uses this for cross-checking)

Anything else, or a timeout, or a connection error, increments the
"down counter."

After `down-after-milliseconds` of consecutive misses, SDOWN. The
sentinel logs:

```
+sdown master mymaster 10.0.0.5 6379
```

### 12.4.1 Why a Subjective Layer?

Networks have hiccups. One sentinel might lose its link to the primary
even if everyone else can reach it. We don't want that one sentinel to
fail-over the cluster on its own.

So SDOWN is private to the sentinel that observed it. To proceed, that
sentinel asks others: "do you also see it down?"

---

## 12.5 The Failure Detector: ODOWN

When a sentinel marks a primary SDOWN, it asks every other sentinel via
`SENTINEL is-master-down-by-addr <ip> <port> <epoch> <runid>`. Each
sentinel replies with its current SDOWN state for that primary.

If at least `quorum` sentinels (including itself) say SDOWN, the primary
is **ODOWN** (objectively down). Failover begins.

```
+odown master mymaster 10.0.0.5 6379 #quorum 2/2
```

`quorum` is the third argument to `sentinel monitor`. Common settings:

| Topology | Quorum | Reasoning |
|----------|--------|-----------|
| 3 sentinels | 2 | Majority of 3 |
| 5 sentinels | 3 | Majority of 5 |
| 4 sentinels | 3 | Tolerate 1 down (4-1=3) |
| 2 sentinels | 1 or 2? | Either is bad — see §12.10 |

**Always use an odd number of sentinels (3 or 5)** to avoid split-vote
scenarios. Three is the minimum; five if you can afford it.

---

## 12.6 Leader Election (Raft-Lite)

When a primary is ODOWN, **one** sentinel becomes the *failover leader*
for this incident. We don't want all sentinels trying to fail over at
once. The election uses a Raft-like algorithm:

```
sentinel A: I see ODOWN. I increment my epoch. I vote for myself. I ask others:
            "vote for me as leader for epoch N?"
sentinel B: My current epoch is N-1. A's epoch N is bigger. I vote for A.
sentinel C: same as B.

A receives ≥ quorum + 1 (majority) votes. A is elected leader.
```

Two important details:

1. **The epoch increments each failover attempt.** This is a Lamport-style
   logical clock. Old failover attempts can't interfere with new ones —
   their epoch is stale.
2. **Each sentinel votes at most once per epoch.** If a sentinel has
   already voted for A in epoch N, it refuses B's request. This makes
   the election safe: at most one leader per epoch.

If no sentinel gets majority in `failover-timeout`, the failover aborts
and a new attempt starts with a fresh epoch.

>>> **Interview insight**: This is *not* full Raft. There's no log
>>> replication, no committed state across all sentinels, no consensus
>>> on data. It's just leader election. The actual failover decisions
>>> (which replica to promote) are made by the leader unilaterally — but
>>> the *configuration update* propagates via the same epoch mechanism.

---

## 12.7 Picking the New Primary

The leader sentinel filters and ranks replicas:

### Filtering (rejected replicas):
- Replicas marked SDOWN.
- Replicas with `slave-priority 0` (configured as ineligible).
- Replicas where `master_link_status:down` for too long.
- Replicas reporting `INFO replication` indicates they're far behind.

### Ranking (best to worst):
1. **Lower `slave-priority`** wins (default 100; setting it to 50 favors
   that replica, 0 = never).
2. **Higher replication offset** wins (most up-to-date data).
3. **Lower runid** lexicographic wins (deterministic tiebreaker).

The selected replica gets:

```
sentinel (as user) -> replica: REPLICAOF NO ONE
```

That replica is now the primary.

### 12.7.1 Reconfiguring Other Replicas

The leader then sends to every other replica:

```
REPLICAOF <new_primary_ip> <new_primary_port>
```

`parallel-syncs 1` means: only one replica reconfigures at a time. Why?
Because each new-primary'd replica triggers a partial or full resync,
which costs primary CPU and bandwidth. Doing them one at a time prevents
the new primary from being overwhelmed.

`parallel-syncs 2..N` is allowed but rare in production.

### 12.7.2 The Old Primary, If It Comes Back

The leader updates its config such that `mymaster` now points to the new
primary. Sentinels propagate via gossip. When the old primary comes back
online, the next sentinel to ping it sees:

```
sentinel: PING old-primary -> +PONG  (it's healthy)
sentinel: INFO old-primary -> "I'm a master, I have 0 replicas"
sentinel: my view of mymaster: it's at new-primary
sentinel: ssh, send to old-primary: REPLICAOF new-primary
```

The old primary becomes a replica. Its data, if newer than the new
primary's (which can happen with split-brain — see §12.10), is **lost**.

(!) **This is the fundamental data-loss surface of Sentinel.** If the
  old primary acked writes that the chosen replica didn't yet have, those
  writes are erased when the old primary becomes a replica of the new
  primary. There's no merge.

---

## 12.8 Configuration Epoch and Propagation

Every sentinel maintains:
- **current-epoch**: the highest epoch it knows about (incremented on
  failover initiation).
- **leader-epoch (per primary)**: the epoch that elected the current
  leader.

When the leader completes failover, it broadcasts a `+config-update`
event with the new epoch. Other sentinels:
- Update their config if the epoch is higher.
- Reject older epochs (split-brain protection).

```
+switch-master mymaster <old> <port> <new> <port>
```

This is what you grep for in sentinel logs to confirm the failover ran.

---

## 12.9 Notifications (Pub/Sub) and Hooks

Sentinel publishes events to its own Pub/Sub channels. You can subscribe
from any client connected to a sentinel:

```
> SUBSCRIBE __sentinel__:hello
> SUBSCRIBE +sdown
> SUBSCRIBE +odown
> SUBSCRIBE +switch-master
> SUBSCRIBE *
```

Useful for monitoring (page when `+odown` fires) or for client libraries
to learn the new primary.

You can also register external scripts to run on events:

```
sentinel notification-script mymaster /etc/sentinel/notify.sh
sentinel client-reconfig-script mymaster /etc/sentinel/reconfig.sh
```

The scripts run on the sentinel that fired the event, with arguments
describing what happened. Use sparingly: a buggy script can stall the
sentinel.

---

## 12.10 Split-Brain Scenarios

This is where Sentinel earns its reputation as "subtly hard." Three
scenarios:

### 12.10.1 The Network Partition

```
   Network partition:
   
   +--------------+      |     +-------------+
   |  PRIMARY     |      |     |  REPLICA    |
   |  (still      |      |     |  (will be   |
   |   serving    |      |     |   promoted) |
   |   clients!)  |      |     +-------------+
   +--------------+      |     +-------------+
   |  sentinel1   |      |     |  sentinel2  |
   +--------------+      |     +-------------+
                         |     |  sentinel3  |
                         |     +-------------+
                         |
              partition splits the world here
```

Sentinels 2 and 3 see SDOWN, reach quorum (2/3), elect a leader, promote
the replica. Now there are **two primaries**. Clients on each side
write to their local primary. **Data forks.**

When the partition heals, the old primary becomes a replica of the new
primary. Its writes during the split are **lost**.

### 12.10.2 Mitigation: `min-replicas-to-write`

```
min-replicas-to-write 1
min-replicas-max-lag 10
```

If the primary loses all replicas (or all are too laggy), it stops
accepting writes. In the partition above:
- Old primary's only replicas are on the wrong side of the partition.
- Old primary fails the min-replicas check.
- Old primary returns errors to clients.

This bounds split-brain data loss to "writes that were already in flight
before the failover decision."

(!) **Caveat**: if you have N=2 replicas and `min-replicas-to-write 1`,
  losing one replica drops you to 1 — still satisfying the policy.
  Losing both stops writes. Tune min-replicas-to-write carefully relative
  to your replica count.

### 12.10.3 The Sentinel Quorum vs Replica Set Mismatch

Three sentinels and one primary + one replica. The primary dies. Quorum
of 2 sentinels see ODOWN. They elect a leader. The leader promotes the
single replica.

But what if the network partition isolates the *primary* from the
sentinels but not from clients? Clients keep writing. Sentinels promote
the replica. **Two primaries, real partitions.**

The fix: deploy sentinels close to (or on the same nodes as) the
**clients**. If a sentinel can't see the primary but a client can, the
sentinel might trigger spurious failover. Co-location aligns failure
modes.

### 12.10.4 Even-Number Sentinels Are Worse

With 4 sentinels and quorum=3:
- Lose 2 sentinels: quorum still possible (3 of remaining 2... wait no,
  there are 2 left, quorum=3, no failover possible).
- Lose 1 sentinel: 3 left, quorum possible.

With 4 sentinels you tolerate exactly 1 failure but pay for 4. With 5,
you tolerate 2 failures. Always odd, always 3 or 5.

---

## 12.11 Client Awareness

Clients must be **sentinel-aware** to use Sentinel correctly:

```python
import redis.sentinel
sentinel = redis.sentinel.Sentinel([
    ('sentinel1', 26379),
    ('sentinel2', 26379),
    ('sentinel3', 26379),
])
master = sentinel.master_for('mymaster', socket_timeout=0.5)
master.set('foo', 'bar')
```

The client library:
1. Connects to one sentinel (any).
2. Asks `SENTINEL get-master-addr-by-name mymaster`.
3. Connects to that address.
4. Subscribes to `+switch-master` to learn of failovers.

**On failover**, the client library:
1. Sees `+switch-master` notification.
2. Drops connections to the old primary.
3. Reconnects to the new primary.

In-flight commands during failover **may fail**. Client code must
retry idempotent operations.

---

## 12.12 What Happens to In-Flight Writes During Failover

Sequence at failover time:

```
T0: client sends SET k v to old primary
T0+1ms: old primary writes to memory, queues reply
T0+2ms: replica RECEIVES the write (asynchronously)
T0+3ms: old primary BUFFERS the reply (event-loop deferred-write)
T0+5s: old primary dies (network partition, hardware fault, etc.)
T0+5s+down-after: sentinel sees SDOWN
T0+5s+down-after+epsilon: sentinel sees ODOWN
T0+5s+down-after+...: leader elected, replica promoted
```

Whether the client got the OK reply depends on whether the buffered
reply got flushed before the death. **If it didn't, the client times
out and may retry.**

If `WAIT 1 100ms` was used after the write, and the replica acknowledged,
the data is on the new primary. If it wasn't, the data may be lost
forever.

---

## 12.13 Operational Checklist

To operate a Sentinel deployment:

1. **Run an odd number of sentinels (3 or 5)**, on independent failure
   domains.
2. **Deploy sentinels close to clients** to reduce false-positive ODOWNs.
3. **Set `quorum = floor(N/2) + 1`** (majority).
4. **Set `down-after-milliseconds` ≥ 5 sec**, larger than typical
   network jitter.
5. **Set `failover-timeout` ≥ 60 sec** to allow real failover work.
6. **Configure `min-replicas-to-write 1, min-replicas-max-lag 10`** to
   limit split-brain damage.
7. **Use a sentinel-aware client library** (jedis, lettuce, ioredis,
   stackexchange.redis all support it).
8. **Test failover quarterly**: kill the primary, watch the failover,
   confirm clients reconnect.
9. **Monitor `+sdown`, `+odown`, `+switch-master`** events.
10. **Set `requirepass`** AND **`sentinel auth-pass`** consistently.

---

## 12.14 Sentinel vs Cluster vs External Tools

| | Sentinel | Cluster | External (e.g., k8s + custom controller) |
|-|---------|---------|------------------------------------------|
| Sharding | No | Yes (16384 slots) | Up to you |
| Failover | Automatic | Automatic | Up to you |
| Operator burden | Medium | Low (more abstracted) | High |
| Client complexity | Sentinel-aware lib needed | Cluster-aware lib needed | Plain client |
| Data consistency on failover | Best-effort | Best-effort | Up to you |

**Modern Redis**: most new deployments use Cluster (Chapter 13) for both
sharding and HA. Sentinel is for legacy or single-shard setups.

---

## 12.15 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `sentinel.c` | All sentinel logic. ~5000 lines. Independent of dataset code. |
| `server.c` | Sentinel init, mode flag |

`sentinel.c` is self-contained — you can read it without knowing the rest
of the codebase. The Raft-lite leader election and the failure detector
are about 800 lines.

---

## Practice Questions

1. You have 3 sentinels, quorum=2, and your primary's IP is
   unreachable from sentinel1 only. What does sentinel1 do? Will
   failover trigger?
2. A network partition isolates the primary AND sentinel1 + sentinel2
   from sentinel3 + replica. Quorum is 2. Walk through what happens.
3. The new primary is elected with replication offset 1000. The old
   primary, when it comes back, was at offset 1050 before crashing.
   What happens to those 50 bytes of writes?
4. Why is `parallel-syncs 1` the right default? When would you raise
   it?
5. `min-replicas-to-write 1, min-replicas-max-lag 10` is set. The
   single replica suddenly has 12 seconds of lag. What happens to a
   client doing `SET k v`?
6. A sentinel deployment has 4 sentinels (oops, even number). The
   primary dies and 2 sentinels can reach replicas; 2 cannot. What
   happens?
7. A client library is sentinel-aware. Walk through what it does on
   the wire from the moment a `+switch-master` event fires.
8. Your sentinel logs show `+sdown` then `+odown` then `+failover-abort-no-good-slave`.
   What went wrong? What configuration change might fix it?

(Answers at end of Chapter 22.)
