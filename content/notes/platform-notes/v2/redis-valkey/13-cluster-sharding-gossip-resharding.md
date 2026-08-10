# Chapter 13: Cluster — Sharding, Gossip & Resharding

> Sentinel handles failover for one Redis. Cluster handles **scaling out**
> across many. The keyspace is partitioned across N primary nodes, each
> with its own replicas, and the system gossips topology among itself
> until everyone agrees on who owns what. Cluster is conceptually simple
> — 16,384 hash slots, distributed by key hash — but the operational
> details (MOVED redirects, ASK redirects, hash tags, resharding without
> dropping keys) are where Staff-level interview questions live.

---

## 13.1 The Setup: Slots, Not Hash Rings

Redis Cluster splits the keyspace into **16,384 hash slots** (always
exactly 16,384 — not configurable). Each slot is owned by exactly one
primary at a time. Replicas of that primary serve the same slots in
read-only mode.

```
   16384 slots distributed across N=3 primaries:

   primary A: slots 0    - 5460
   primary B: slots 5461 - 10922
   primary C: slots 10923 - 16383
```

The slot for a key is determined by:

```
slot = CRC16(key) % 16384
```

That's it. CRC16 of the key, mod 16384. Same key always lands on the same
slot. The same slot always lives on the same primary (until resharding
moves it).

>>> **Interview insight**: Why fixed slots instead of consistent hashing?
>>> Two reasons:
>>> 1. **Determinism**: every client computes the same slot for the same
>>>    key without consulting a service.
>>> 2. **Move granularity**: you can move slots one at a time during
>>>    resharding, without disturbing other slots. With consistent hashing,
>>>    moving a node usually disturbs many neighbors.
>>>
>>> The 16,384 number is a sweet spot. Big enough that any reasonable
>>> cluster size has slots distributed evenly. Small enough that each
>>> node's slot map fits in a 2 KB bitmap.

### 13.1.1 Why 16,384 Specifically

`16384 = 2^14`. So slot fits in 14 bits, 16 bits with some bits to spare.
A 16,384-bit bitmap is 2,048 bytes. Each node gossips its slot ownership
as one of these bitmaps, which is small enough to send unconditionally
in every gossip message.

Salvatore wrote a long blog post on the choice (he considered 1024,
4096, 65536) — the conclusion was 16,384 is enough granularity for
1000-node clusters and small enough for cheap gossip.

---

## 13.2 Hash Tags: Multi-Key Operations Across Slots

Multi-key commands (`MGET`, `MSET`, `SUNIONSTORE`, transactions, Lua
scripts) require **all keys to be on the same node**. By default, two
different keys hash to two different slots (most likely on two different
nodes), so multi-key operations across them fail:

```
> MGET user:1:profile user:2:profile
(error) CROSSSLOT Keys in request don't hash to the same slot
```

**Hash tags** force a subset of the key to determine the slot:

```
{user:1}.profile      -> CRC16("user:1") % 16384 = slot S
{user:1}.session       -> CRC16("user:1") % 16384 = slot S (same!)
{user:1}.preferences   -> CRC16("user:1") % 16384 = slot S (same!)
```

Anything between the first `{` and the first matching `}` is the hash
tag. The whole key still works for `GET`/`SET`, but the slot is
computed only on the tag.

Use cases:
- Group all data for one user: `{user:42}.profile`, `{user:42}.cart`,
  `{user:42}.session`.
- Multi-key transactions across logically related keys.

Caveat: **all keys with the same tag are on the same node.** Hot tags
become hot shards. A single user with billions of operations on
`{user:42}.*` will overload one node.

---

## 13.3 The Cluster Bus

Each cluster node opens **two TCP ports**:

- **Client port** (e.g., 6379): handles client requests over RESP.
- **Cluster bus port** (client port + 10000, e.g., 16379): node-to-node
  gossip.

Cluster bus uses a **binary protocol** (not RESP) for efficiency. The
protocol is documented in `cluster.h`.

```c
typedef struct {
    char sig[4];                    // "RCmb" - Redis Cluster message bus
    uint32_t totlen;
    uint16_t ver;                   // protocol version
    uint16_t port;
    uint16_t type;                  // PING, PONG, MEET, FAIL, etc.
    uint16_t count;                 // number of gossip section entries
    uint64_t currentEpoch;
    uint64_t configEpoch;
    uint64_t offset;                // replication offset
    char sender[CLUSTER_NAMELEN];   // sender's node ID
    unsigned char myslots[CLUSTER_SLOTS/8];  // 2 KB bitmap of sender's slots
    char slaveof[CLUSTER_NAMELEN];
    char myip[NET_IP_STR_LEN];
    char notused1[34];
    uint16_t pport;                 // plaintext client port if TLS
    uint16_t cport;
    uint16_t flags;
    unsigned char state;
    unsigned char mflags[3];
    union clusterMsgData data;       // gossip entries, MEET data, FAIL data, etc.
} clusterMsg;
```

Every PING contains the sender's slot bitmap, replication offset, and
gossip entries about other nodes. Receivers update their topology view.

---

## 13.4 Gossip Protocol

Every second, each node sends a PING to a random node it knows about.
Each PING includes gossip entries about a few other random nodes:

```
A pings B with: "I know about C: it's at 10.0.0.6:6379, last pong 2s ago, flags: master"
                 "I know about D: it's at 10.0.0.7:6379, last pong 8s ago, flags: master, possibly down"
                 "I know about E: ..."
```

B updates its view: "Oh, A says D might be down. Let me also check D."

This **eventually consistent** propagation means topology updates
spread across the cluster in seconds. Each node maintains:

```c
typedef struct clusterNode {
    mstime_t ctime;                  // node creation time
    char name[CLUSTER_NAMELEN];      // 40-byte hex node ID
    int flags;                       // MASTER, SLAVE, MYSELF, FAIL, PFAIL, ...
    uint64_t configEpoch;
    unsigned char slots[CLUSTER_SLOTS/8];  // 2 KB bitmap
    int numslots;
    int numslaves;
    struct clusterNode **slaves;
    struct clusterNode *slaveof;
    mstime_t ping_sent;
    mstime_t pong_received;
    char ip[NET_IP_STR_LEN];
    int port;
    int cport;
    list *fail_reports;              // who reported this node as failing
    ...
} clusterNode;
```

Each node has 40-byte hex ID assigned at first startup, persisted to
`nodes.conf`.

### 13.4.1 PING Frequency

```
cluster-node-timeout 15000        # ms; default 15 seconds
```

A node is **PFAIL** (possibly fail) if no PONG was received in
`cluster-node-timeout / 2` ms. After more time, gossip propagates the
PFAIL state. If a majority of primaries report a node PFAIL, the cluster
agrees it's **FAIL**.

`cluster-node-timeout` is the single most important cluster knob. Small
values: faster failover, more spurious failures during network jitter.
Large values: more stable, slower failover. Default 15 seconds is a
balance.

---

## 13.5 Slot Ownership Reconciliation

When two nodes disagree about who owns a slot:

```
A says: slot 100 is mine, configEpoch=5
B says: slot 100 is mine, configEpoch=7
```

The **higher configEpoch wins**. `configEpoch` is incremented every time
a node "claims" slots authoritatively (becomes a primary or completes
failover).

This is the cluster's analog to Sentinel's epoch — a Lamport clock
ensuring last-writer-wins on slot ownership.

---

## 13.6 The Client's View: MOVED and ASK

Cluster clients are expected to be **cluster-aware**: they know how to
compute slots, maintain a slot-to-node map, and route requests.

When a client gets it wrong:

### 13.6.1 MOVED redirect

```
client -> A: GET foo
A computes slot for "foo": slot 8000
A doesn't own slot 8000 anymore (B does)
A -> client: -MOVED 8000 10.0.0.6:6379

client (cluster-aware) updates its slot map: 8000 -> 10.0.0.6:6379
client retries: connect to 10.0.0.6, GET foo
```

`-MOVED` is **persistent**: "this slot is now owned by that node, update
your map permanently."

### 13.6.2 ASK redirect (for in-flight resharding)

```
client -> A: GET foo
A is migrating slot 8000 to B but the migration isn't done yet
A still has the key but is told to redirect:
A -> client: -ASK 8000 10.0.0.6:6379

client connects to B, sends ASKING (one-shot flag) and then GET foo
B handles GET foo for that one request
```

`-ASK` is **transient**: "for THIS query, ask the other node, but don't
update your map." After `ASKING`, the next command is executed even on
slots the responding node doesn't yet own.

### 13.6.3 Why two redirects

During resharding, slot 8000 might be **half-migrated**: half the keys
on A, half on B. Without ASK, every client request would race —
sometimes the key is on A (MOVED to B is wrong), sometimes on B (no
MOVED needed).

ASK lets the source node redirect any *unresolved* keys to the
destination *for this query only*. After resharding completes, both
nodes update their epochs, MOVED redirects flow, and clients
permanently update.

---

## 13.7 Resharding: Moving Slots Without Dropping Keys

The cluster's secret weapon. You can move slot 100 from A to B while
both nodes are serving live traffic, with zero key loss.

### 13.7.1 The Steps

1. On B, mark slot 100 as **importing** from A:
   ```
   CLUSTER SETSLOT 100 IMPORTING <node-A-id>
   ```
2. On A, mark slot 100 as **migrating** to B:
   ```
   CLUSTER SETSLOT 100 MIGRATING <node-B-id>
   ```
3. Use `CLUSTER GETKEYSINSLOT 100 100` on A to fetch a batch of keys.
4. For each key, send `MIGRATE` from A to B:
   ```
   MIGRATE <B-host> <B-port> "" 0 5000 KEYS k1 k2 ... kN
   ```
5. Repeat 3-4 until A has zero keys in slot 100.
6. On B, finalize: `CLUSTER SETSLOT 100 NODE <node-B-id>`.
7. On A, finalize: `CLUSTER SETSLOT 100 NODE <node-B-id>`.
8. The new slot ownership propagates via gossip; configEpoch is bumped.

### 13.7.2 What Happens to Reads/Writes During Migration

Two states a key can be in:

- **On A, not yet migrated**: A serves it normally.
- **On B, already migrated**: B serves it with `ASKING` flag from clients
  who get redirected.

When A's `slot 100` map says "MIGRATING to B" and a key in slot 100 is
*not* on A:
- Client's request to A returns `-ASK 100 <B>`.
- Client sends `ASKING` then the command to B.
- B serves it.

When A's map says "MIGRATING" and the key IS on A:
- A serves it normally.

When B's map says "IMPORTING from A" and the client sends a command:
- Without `ASKING` first: B returns `-MOVED 100 <A>`. (B isn't accepting
  general traffic for this slot yet.)
- With `ASKING` first: B serves it.

This protocol ensures **no key is lost in transit** and **clients never
see a slot vanish**.

>>> **Interview insight**: The ASK / MIGRATE / IMPORTING / MIGRATING
>>> dance is the killer slide of any cluster talk. The key insight is
>>> "split slot ownership at the per-key level, briefly." It's the same
>>> idea Vitess uses for resharding, the same idea Cassandra uses for
>>> token range moves. Once you see this, you see it everywhere.

### 13.7.3 redis-cli --cluster reshard

In practice you don't run individual `MIGRATE`s. Use:

```
redis-cli --cluster reshard 10.0.0.5:6379 \
  --cluster-from <source-node-id> \
  --cluster-to <dest-node-id> \
  --cluster-slots 1000 \
  --cluster-yes
```

This walks the slot list and moves slots one by one. Or:

```
redis-cli --cluster rebalance 10.0.0.5:6379
```

Auto-balance slots evenly across all primaries.

---

## 13.8 Cluster Failover

Each primary has zero or more replicas. When the primary dies, one of
its replicas is promoted automatically.

### 13.8.1 Failure Detection

Same gossip mechanism as topology. PFAIL → majority-reported FAIL →
trigger replica promotion.

### 13.8.2 Replica Election

Replicas of the failed primary race to become the new primary. The
process is loosely Raft-ish:

1. Each replica computes a "wait time" inversely proportional to its
   replication offset (more up-to-date replicas wait less, so they go
   first).
2. After waiting, the replica increments `currentEpoch` and asks **other
   primaries** (not other replicas) for votes.
3. Other primaries vote yes if they haven't voted in this epoch already
   AND the requester has the highest replication offset they've seen.
4. The first replica to get a majority of primary votes is elected.
5. The new primary takes over the failed primary's slots and bumps its
   `configEpoch`.

The `wait time = 500ms + random(0..500) + 10 * (rank in offset
order)` gives the most-up-to-date replica a head start of about a
second.

### 13.8.3 Why Vote-By-Primaries

Replicas don't get to vote on which other replica becomes primary.
This avoids "all replicas vote for themselves" deadlocks. The
primaries are the authoritative voters because they own the
configEpoch updates.

If at any moment fewer than majority of primaries are alive, **no new
primary can be elected**. The cluster goes into a degraded state:

```
> CLUSTER INFO
cluster_state:fail
```

In fail state, the cluster refuses writes (and reads, by default, since
slots whose owner is dead can't be served).

```
cluster-require-full-coverage yes      # default; refuse writes if any slot is uncovered
```

Set to `no` if you want to keep serving the slots that ARE covered while
some are unreachable. Less safe; sometimes operationally necessary.

---

## 13.9 Multi-Key Commands and Scripts

Constraints in cluster:

- All keys touched by `MULTI/EXEC` must be on the same node (use hash
  tags).
- All keys touched by `EVAL` must be on the same node.
- `MGET`/`MSET` across slots is rejected with `CROSSSLOT`.
- `MIGRATE` works across nodes (it's a deliberate multi-node command).
- `CLUSTER COUNTKEYSINSLOT` and `CLUSTER GETKEYSINSLOT` work per node
  for their own slots.

The `CROSSSLOT` constraint is the major API change clients face when
moving from single-instance to cluster. Most client libraries handle
single-key commands transparently but require explicit hash tags for
multi-key.

```python
# Single-instance: works
client.mget(['user:1:name', 'user:2:name'])

# Cluster: same call, fails with CROSSSLOT
client.mget(['user:1:name', 'user:2:name'])  # likely different slots

# Cluster: works because same hash tag
client.mget(['{users}:1:name', '{users}:2:name'])  # same slot

# Cluster: also works because library does parallel mget per node
cluster_client.mget(['user:1:name', 'user:2:name'])  # transparently parallelized
```

---

## 13.10 Replicas in a Cluster

Each primary has zero or more replicas. Replicas:

- Replicate from their assigned primary via PSYNC2 (Chapter 11).
- Don't serve writes (always return -MOVED on writes).
- Optionally serve reads if the client sends `READONLY` first.
- Participate in failover voting (only their primary's failure triggers
  their election).

`cluster-allow-replica-migration yes` (default): if a primary loses all
its replicas, another primary's "extra" replica can be moved to cover
it. Improves overall availability.

### 13.10.1 Replica Read Configuration

```
> READONLY
+OK
> READWRITE
+OK
```

`READONLY` lets a connection issue read commands to a replica. Useful
for read-heavy applications that can tolerate slight staleness. Set on
the connection, not globally.

---

## 13.11 Cluster Configuration

A node config:

```
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 15000
cluster-port 16379
cluster-announce-ip 10.0.0.5
cluster-announce-port 6379
cluster-announce-bus-port 16379
cluster-require-full-coverage yes
cluster-allow-reads-when-down no
cluster-replica-no-failover no       # set yes to disable replica becoming primary
```

`nodes.conf` is auto-managed by the node; don't edit by hand. It
persists the local view of the cluster across restarts.

---

## 13.12 Operational Commands

```
CLUSTER INFO
CLUSTER NODES                          # full topology dump
CLUSTER MYID                           # this node's ID
CLUSTER COUNTKEYSINSLOT 8000
CLUSTER GETKEYSINSLOT 8000 10
CLUSTER KEYSLOT mykey                   # which slot does this key fall into?
CLUSTER COUNT-FAILURE-REPORTS <node-id> # how many nodes have reported this one PFAIL
CLUSTER RESET                          # nuke local state (dangerous)
CLUSTER FORGET <node-id>               # remove a node from local view
CLUSTER MEET <ip> <port>               # add a node to the cluster
CLUSTER FAILOVER                       # request failover (run on a replica)
CLUSTER SLAVES <node-id>               # list replicas of a primary
```

`redis-cli --cluster` subcommands wrap these for higher-level operations
(create cluster, add/remove node, reshard, rebalance, fix, check).

---

## 13.13 Building a Cluster from Scratch

```bash
# Start 6 nodes (3 primaries + 3 replicas) on different ports
for port in 7000 7001 7002 7003 7004 7005; do
  redis-server --port $port --cluster-enabled yes \
               --cluster-config-file nodes-$port.conf \
               --cluster-node-timeout 15000 \
               --appendonly yes &
done

# Build the cluster
redis-cli --cluster create 127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 \
                            127.0.0.1:7003 127.0.0.1:7004 127.0.0.1:7005 \
                            --cluster-replicas 1
```

`--cluster-replicas 1` says "for every primary, configure 1 replica." With
6 nodes that's 3 primaries + 3 replicas. With 9 nodes it'd be 4 primaries
+ 5 replicas (rounded).

---

## 13.14 Failure Modes to Know

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `CLUSTERDOWN The cluster is down` | Some slots are uncovered | Recover failed primaries; or `cluster-require-full-coverage no` |
| `CROSSSLOT Keys in request don't hash to the same slot` | Multi-key command across slots | Use hash tags or per-node parallel client |
| `MOVED 8000 ip:port` | Client's slot map is stale | Cluster-aware client should refresh |
| `ASK 8000 ip:port` | Slot in transit during reshard | Client must follow up with ASKING + command |
| Primary's replicas keep falling behind during reshard | Network/IO bottleneck | Slow down reshard with smaller batches; or wait |
| `CLUSTER FAILOVER` does nothing | No replicas eligible (e.g., they're far behind) | Catch up replicas first |

---

## 13.15 Limits and Practical Sizes

The Redis Cluster reference suggests:

- Up to ~1000 nodes (gossip overhead grows ~O(N²)).
- Each primary should have at least 1 replica for HA.
- Slot count is fixed at 16,384 — granularity of placement at any
  scale.
- Plan for ~25-50 GB per primary node for typical workloads (tied to
  fork pause, RDB time, replica catch-up speed).

Beyond ~1000 nodes, gossip-induced overhead becomes nontrivial. At that
scale you typically use external sharding (proxy layer, application-side
sharding) over multiple separate clusters.

---

## 13.16 Cluster vs Sentinel vs Standalone (Decision Matrix)

| | Standalone | Sentinel | Cluster |
|-|------------|----------|---------|
| Memory limit | 1 node | 1 node | N nodes |
| Throughput | 1 node | 1 node | N nodes |
| HA | No | Yes (manual or sentinel) | Yes (automatic) |
| Multi-key constraints | None | None | Same-slot only |
| Operational complexity | Low | Medium | Higher |
| Use when | <10 GB, dev/test, simple cache | <10 GB needing HA | >10 GB or >50K ops/s peak |

**Default recommendation in 2026**: cluster mode, even for small
deployments. Migration from cluster-enabled-with-1-shard to multi-shard
later is straightforward; migration from standalone to cluster is
disruptive.

---

## 13.17 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `cluster.c` | All cluster logic: gossip, slots, failover, reshard, MEET/FORGET |
| `cluster.h` | Cluster bus protocol, clusterNode/clusterState structs |
| `cluster_legacy.c` (Valkey 8) | Legacy non-clustered code paths |
| `crc16.c` | The slot hash |

Additionally, look at `redis-cli.c` (specifically the `clusterManagerCommand*`
functions) to see how the high-level cluster admin tooling is implemented
on top of the bus.

---

## Practice Questions

1. Why does Redis Cluster use 16,384 slots (not 1024 or 65536)?
   What's the reasoning behind this exact number?
2. You have a 6-node cluster (3 primaries, 3 replicas). One primary
   dies. Walk through what happens to a `GET` from a client that doesn't
   yet know about the failure.
3. A team uses keys like `user:42:profile`. They want all per-user data
   to be local for atomic transactions. Sketch the migration.
4. Resharding moves slot 100 from A to B. Mid-move, a client does
   `GET key123` (in slot 100) against A. Walk through the wire
   sequence.
5. Why must the *configEpoch* of the new primary be higher than the
   old one's? What goes wrong if two replicas claim the same epoch?
6. `cluster-require-full-coverage yes`. Slot 5000's primary and all
   its replicas are unreachable. What can clients do? What should
   operators do?
7. `cluster-node-timeout` is 15 seconds. A network partition isolates
   primary X from the cluster bus for 14 seconds. What happens?
8. A team stores millions of keys with hash tag `{global}` to make all
   their data accessible in one transaction. What happens at scale?
9. Walk through how the slot map propagates after a successful
   reshard, and why MOVED redirects eventually all converge.
10. You can't run `MGET k1 k2` across slots. Sketch a client-side
    pattern that achieves the equivalent semantics with parallelism.

(Answers at end of Chapter 22.)
