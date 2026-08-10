# Chapter 9 — The Controller and KRaft
### How Kafka's Brain Was Replaced In Flight

---

For the first decade of its life, Apache Kafka had an awkward dependency:
it required a separately-deployed ZooKeeper ensemble to manage its cluster
metadata. Operating Kafka meant operating ZooKeeper — a different system,
with different consensus mechanics, different tuning, different failure
modes, and different ops people. Half the operational pain of Kafka came
not from Kafka but from the system that lived under it.

KIP-500, proposed in 2019, made a single sentence promise: **"Kafka should
not need ZooKeeper."** The KIP was 25 pages; the implementation took
three years and three releases (3.3 GA in 2022, ZK-mode bridge release,
ZK removal in 4.0 in 2025). The result is **KRaft** (Kafka Raft):
a Raft-based consensus protocol implemented natively in Kafka, replacing
ZooKeeper for metadata management.

This chapter covers:

- The controller's role: what it actually does and why it has to exist.
- The pre-KRaft world: ZooKeeper, the controller znode, the cold-start
  problem, the watcher cliff.
- The KRaft architecture: controller quorum, the metadata log, broker
  registration and heartbeats.
- The Raft variant Kafka uses (KIP-595) and how it differs from textbook
  Raft.
- The migration: how a cluster moves from ZK to KRaft without downtime.
- KRaft mode tuning, recovery, and operational profile.

By the end you should be able to explain, on a whiteboard, what happens
between "broker dies" and "partition has new leader" in both ZK and KRaft
modes, and why the second is materially better.

---

## 9.1 What the controller does

A Kafka cluster has many things to keep track of:

- Which topics exist.
- For each topic, how many partitions, and what their replica assignments
  are.
- For each partition, which replica is the leader and which are followers.
- The current ISR of each partition.
- Which brokers are alive (heartbeating) and which are dead.
- Configuration overrides (per-topic, per-broker, per-client-id quotas,
  etc).
- ACLs (authorisation rules).
- Producer IDs (for idempotence) and transactional state (for transactions).

Some of this is *operational*: brokers dying, partitions failing over.
Some is *administrative*: a topic being created, an ACL added.
All of it is **cluster-wide state** — every broker needs a consistent
view, and changes must be totally ordered (broker A cannot believe X is
the leader while broker B believes Y).

The controller is the component that owns this state. There is **exactly
one active controller** at any moment; only it can make cluster-wide
decisions; its decisions are propagated to all brokers.

This is, in effect, a centralised metadata service. The "centralised" part
is unusual for Kafka — most of Kafka is deliberately decentralised — but
*for control-plane decisions, you cannot avoid centralisation*. Two
controllers making conflicting decisions about who leads partition 7 is a
recipe for data corruption. So: one active controller, fail-over to a
standby on death.

---

## 9.2 The ZooKeeper era

For Kafka 0.x through 2.x (and into 3.x as a deprecated mode), the
controller was a ZooKeeper-coordinated singleton.

### 9.2.1 ZooKeeper, briefly

ZooKeeper is a distributed coordination service. It exposes a hierarchical
namespace of "znodes" (like a filesystem) with strong consistency
semantics: writes are linearised through a Zab consensus protocol;
reads can be served from any follower or only from the leader (configurable);
ephemeral znodes disappear when the owning client session ends; sequential
znodes get monotonic sequence numbers; clients can set "watchers" to be
notified of changes.

A ZooKeeper ensemble is typically 3 or 5 nodes. Kafka used it for:

- **Controller election.** First broker to claim `/controller` znode wins.
  Ephemeral, so dies with the broker.
- **Broker registration.** Each broker creates `/brokers/ids/N` ephemeral
  znode on startup. Disappearance = broker dead.
- **Topic configuration.** `/config/topics/<name>` znodes hold topic
  configs.
- **Partition state.** `/brokers/topics/<topic>/partitions/<N>/state`
  znodes hold leader, ISR, leaderEpoch.
- **Many other things:** `/admin/...`, `/acls/...`, `/cluster/...`.

Kafka's controller broker watched these znodes and reacted. When
`/brokers/ids/5` disappeared (broker 5 dead), the controller's watcher
fired, and the controller began electing new leaders for partitions that
broker 5 had led.

### 9.2.2 The election protocol

Pre-KIP-500 controller election:

```
1. Broker starts up.
2. Broker tries to create ephemeral znode /controller with its broker ID.
3. If create succeeds: this broker is now the controller.
4. If create fails (someone else is controller): set a watcher on /controller.
5. When the watcher fires (controller znode disappeared):
   - Race to create /controller again.
   - First broker wins.
```

Standard ZK election idiom; works fine. The tricky part wasn't the
election; it was what happened after.

### 9.2.3 The cold-start problem

When a new controller is elected, it doesn't know the cluster state — it
has to read it from ZooKeeper. Concretely:

1. Read `/brokers/ids/*` to know which brokers are alive.
2. Read `/brokers/topics/*` to enumerate topics.
3. For each topic, read `/brokers/topics/<topic>/partitions/*/state` to
   know each partition's current leader, ISR, and epoch.
4. Read `/config/topics/*` for topic configs.
5. Read `/config/clients/*` for client quotas.
6. Read `/admin/...` for in-flight admin operations.
7. Set watchers on every relevant znode for change notifications.

For a small cluster, this is sub-second. For a 10K-partition cluster, it
is tens of seconds. For a 100K-partition cluster, it can be **several
minutes**, during which:

- No leader elections can happen.
- No ISR changes can be applied.
- No topics can be created or deleted.
- New brokers cannot register.
- Failed brokers' partitions are leaderless.

Worst case: a controller fails *during* cold-start, and a new controller
has to repeat the whole thing. I have personally watched a 50K-partition
cluster spend 8 minutes recovering from a single controller crash, with
all writes blocked.

This was the controller's biggest weakness, and the primary motivator for
KIP-500.

### 9.2.4 The watcher cliff

ZooKeeper's notification model fires *one watcher per change*, but
watchers must be **re-registered** after firing. So:

```
watcher fires for /brokers/ids/5 (broker 5 died)
    ↓
controller does the work
    ↓
controller re-registers watcher
```

If something changes *during* the work-doing step, the change is
batched into the next watcher fire. Most of the time this is fine. But
during incidents — say, a network partition causes 20 brokers to "die"
at once — the watchers can fire in cascades, with the controller falling
behind. The controller may end up processing notifications for state that
has already changed again. The result is occasional inconsistency
(controller acts on stale data) and slow recovery during big events.

There were also race conditions between the controller's watcher
processing and direct writes to ZK from leader brokers (the old ISR
update path). KIP-497 fixed many of these by routing ISR updates through
the controller, but that was years into the controller's life.

---

## 9.3 KIP-500 and KRaft

The KIP-500 design is conceptually simple: replace ZooKeeper with a
**Kafka topic** managed by Raft.

This is a self-referential idea — Kafka stores its own metadata in Kafka
— but it works, and it has several upsides:

1. **One technology to operate.** No separate ZooKeeper ensemble. No
   ZK-specific tooling, monitoring, security, upgrades.
2. **Faster cold-start.** The new controller already has the metadata log
   replicated to it; it doesn't need to "load" anything from a separate
   storage system.
3. **Better scalability.** Raft + log structure handles large clusters
   better than ZooKeeper's znode model.
4. **Unified protocol.** Brokers and clients learn cluster state through
   the same metadata-fetch mechanism, just as if metadata were any other
   topic.

The controller becomes a **quorum** of brokers (typically 3 or 5)
running a special "controller" role. They form a Raft group. The Raft
leader is the active controller; the others are passive standbys.

### 9.3.1 The controller quorum

```
controller.quorum.voters=1@controller-1.example.com:9093,2@controller-2:9093,3@controller-3:9093
process.roles=controller,broker         # combined mode (small clusters)
                                          # or "controller" only / "broker" only (production)
```

Three or five controllers. Each is a JVM process running Kafka with the
controller role. They form a Raft group with one leader (the active
controller) and N-1 followers.

In **combined mode** (`process.roles=controller,broker`), a single JVM
runs both controller and broker code. This is convenient for development
and small clusters. **Not recommended for production**: the controller's
work shouldn't compete with the broker's data-plane work.

In **separated mode** (preferred), controllers are dedicated nodes with
`process.roles=controller`. They have no data partitions; they don't
serve produce/fetch traffic. They only do controller work.

### 9.3.2 The metadata log

The metadata log is a single-partition topic called `__cluster_metadata`.
It is **replicated only to controllers**, not to brokers — brokers
*consume* it but do not host replicas.

Records in the metadata log:

- `RegisterBrokerRecord` — a broker registers.
- `UnregisterBrokerRecord` — a broker is fenced (heartbeat lost, etc).
- `TopicRecord` — a topic is created.
- `PartitionRecord` — a partition's assignment.
- `PartitionChangeRecord` — leader/ISR changes.
- `ConfigRecord` — config update.
- `AccessControlEntryRecord` — ACL change.
- `ProducerIdsRecord` — PID block allocation.
- And many more — see `ApiMessage` definitions in the source.

Every cluster-wide change is one or more records in this log. The active
controller writes them; the other controllers replicate them; brokers
consume them.

A change is **committed** when a Raft majority of controllers has
replicated it. That happens fast — sub-millisecond in healthy
networks — because it's just a Raft round trip to a small quorum.

### 9.3.3 Brokers consume the metadata log

Each broker runs a `BrokerMetadataListener` that tails
`__cluster_metadata`. As records are committed, brokers receive them and
update local state:

- "Broker 5 unregistered" → delete broker 5 from local view.
- "Partition X leader is now broker 3" → if I am broker 3, become leader;
  otherwise, become follower of broker 3.

This is structurally similar to a consumer group reading a topic: the
broker's `metadataFetcherThread` polls the active controller, gets the
batch of new records, applies them. The active controller exposes a
**MetadataRequest**-like API (`FetchSnapshot` and `Fetch` for the metadata
log), and brokers consume.

The implication: **all cluster state changes go through the metadata
log**. There is no out-of-band signaling from controller to broker. This
is much cleaner than the ZK era, where the controller pushed
`LeaderAndIsrRequest` over RPC and ZK watchers fired independently.

### 9.3.4 Heartbeats and broker liveness

Brokers prove they are alive by sending **BrokerHeartbeatRequest** to the
active controller every `broker.heartbeat.interval.ms` (default 2000 ms).
The heartbeat is a small RPC that says "I am broker N, I have seen
metadata up to offset M, my role is X."

If the active controller has not seen a heartbeat from broker N within
`broker.session.timeout.ms` (default 9000 ms), the controller writes an
`UnregisterBrokerRecord` for N. This triggers leader elections for any
partitions N led. The next batch of metadata records flows out, brokers
receive, partitions fail over.

Compare to ZK: the broker maintained a ZK ephemeral znode; if the broker
died (or its session timed out), ZK fired a watcher; the controller
reacted. Same effect, different mechanism. The KRaft mechanism is faster
(no ZK round trip) and has less coupling.

---

## 9.4 The Kafka Raft variant (KIP-595)

Standard Raft is well-known: leader election with randomized timeouts,
log replication with `AppendEntries` RPCs, log matching property,
commitment by majority.

Kafka's Raft (sometimes called "Raft with `Fetch`") differs in one major
way: instead of the leader pushing `AppendEntries` to followers, **the
followers fetch from the leader**. This mirrors the data-plane
replication model (Chapter 8) and lets controllers reuse the existing
fetch protocol with minor extensions.

```
Standard Raft:
    Leader → Follower: AppendEntries(prevLogIndex, prevLogTerm, entries[])
    Follower → Leader: AppendEntriesReply(success/failure, matchIndex)

Kafka Raft:
    Follower → Leader: Fetch(replicaId, fetchOffset, lastFetchedEpoch)
    Leader → Follower: FetchResponse(records, leaderEpoch, leaderHighWatermark)
```

The semantics are the same — both protocols achieve linearizable log
replication via majority commit — but the mechanism is symmetric to
Kafka's existing replication, which has implementation benefits.

Other KIP-595 details:

- **Pre-vote** to prevent disrupted re-elections. A follower that thinks
  it should run for leader first does a pre-vote round: "would you vote
  for me?" If a majority says yes (without bumping their term), only then
  does the actual election begin. Avoids spurious term bumps that would
  destabilise the existing leader.
- **Snapshots.** Long-running clusters accumulate millions of metadata
  records. Re-reading them all on startup is slow. KIP-630 added Raft
  snapshots: periodically, the active controller takes a snapshot of the
  current state, persists it as a special record, and old log entries
  before the snapshot can be deleted. New controllers start by reading the
  latest snapshot, then tailing only post-snapshot records.
- **Leader epochs** in metadata log records, just like data partitions.
  Truncation logic on follower controllers uses the same KIP-101-style
  reasoning as data replication.

The protocol is described in detail in KIP-595 (the design doc) and
implemented in `org.apache.kafka.raft.*`. It is a clean, well-documented
implementation; reading it is a good way to learn modern Raft.

---

## 9.5 The migration from ZK to KRaft

KIP-866 specified a **migration path**: a cluster running on ZooKeeper
can be moved to KRaft without downtime, in stages. The high-level
sequence:

1. **Set up KRaft controllers** alongside the existing ZK controllers.
   Configure them as a quorum but not yet active.
2. **Enable KRaft migration mode** (`migration.enabled=true`) on
   controllers and brokers. The cluster runs in **dual-write mode**:
   metadata changes go to both ZK and the new KRaft metadata log.
3. **Promote KRaft to primary**. The KRaft active controller now drives
   metadata changes; ZK is read-only (still updated, but treated as
   secondary).
4. **Verify** the KRaft cluster is healthy: brokers consuming metadata
   correctly, partition state stable.
5. **Decommission ZK**. Remove ZK-related configs from brokers, remove
   the migration flag, eventually shut down the ZK ensemble.

The migration is non-trivial but well-tested. As of Kafka 4.0 (2025), ZK
mode is removed; new clusters must be KRaft from inception. Existing ZK
clusters are expected to migrate by the time of further upgrades.

In 2026, most production fleets are mixed: some clusters still ZK (in
the long tail of upgrade laggers), most clusters KRaft. The migration is
considered safe enough to do during routine maintenance windows.

---

## 9.6 Operational profile of KRaft

### 9.6.1 Cold start

A new controller node, on startup:

1. Read the latest snapshot of `__cluster_metadata` from local disk (if
   present from a prior run).
2. Tail the metadata log forward from the snapshot's offset to current.
3. Now in sync with cluster state. Ready to vote in elections / serve as
   leader.

This is **seconds**, not minutes. The snapshot bounds the work; tailing
recent records is cheap.

### 9.6.2 Failover

Active controller dies. The remaining controllers (Raft followers)
detect the leader's silence (via heartbeat timeout in Raft), trigger
election, elect a new leader within milliseconds. The new leader
already has the metadata log replicated; it can begin issuing decisions
immediately.

Failover time: typically **< 1 second**. Compare to ZK era: 30 seconds
to several minutes.

### 9.6.3 Snapshot management

`metadata.log.max.snapshot.bytes` and similar configs control snapshot
behaviour. Defaults are sensible. The disk space for the metadata log
is small — even very large clusters keep `__cluster_metadata` under a few
GB — so unlike data partitions, metadata storage rarely needs operational
attention.

### 9.6.4 Observability

KRaft adds metrics specific to the metadata log:

- `kafka.controller:type=KafkaController,name=ActiveControllerCount`
  — should be `1` cluster-wide.
- `kafka.controller:type=KafkaController,name=MetadataLastOffset`
  — current offset of the metadata log.
- `kafka.controller:type=KafkaController,name=EventQueueTimeMs`
  — latency through the controller's internal queue. Should be low
  (sub-100ms p99).
- `kafka.server:type=BrokerMetadataListener,name=MetadataLag`
  — how far behind each broker is on the metadata log. Should be near
  zero.

Watch `MetadataLag` per broker. If a broker is many records behind, it
will act on stale leadership info and cause client errors.

---

## 9.7 What can go wrong with KRaft

KRaft is more reliable than ZK-mode, but not infallible. Real failure
modes I have seen:

### 9.7.1 Split brain on the controller quorum

If the controller quorum loses majority (e.g., 2 of 3 nodes down), the
remaining controller cannot form a quorum and the cluster cannot make
metadata changes. Existing partitions continue to function (data plane is
unaffected) but no failovers, no admin ops, no broker registrations.

Mitigation: deploy controllers across availability zones so a single AZ
failure doesn't take majority. With 3 controllers, you need 2 alive; with
5 controllers, 3 alive. Tolerance is N/2 + 1.

### 9.7.2 Slow Raft commits under load

The active controller's write throughput is bounded by the Raft commit
latency. On a busy cluster (many topic creations, ISR changes), this can
bottleneck.

Mitigation: keep controllers on fast disks (SSDs), low-latency networks,
and don't under-provision them. The bottleneck rarely matters in practice
but is worth knowing.

### 9.7.3 Broker not consuming metadata

If a broker fails to consume the metadata log (network issues, disk full,
JVM hung), it operates on stale metadata. It will continue serving its
existing partitions but won't react to leader changes elsewhere. Clients
talking to it will get stale routing.

The active controller detects this by the broker's heartbeat lag (the
broker reports its latest metadata offset; if it's far behind, the
controller can fence it).

`MetadataLag` JMX is the canary.

### 9.7.4 Snapshot growth

Very large clusters with many topics produce large snapshots. If the
controller's heap or disk is undersized, snapshot creation can slow or
fail. Rare but exists.

Mitigation: provision controllers generously. Heap of 4-8 GB and ample
disk is fine for clusters up to several thousand topics.

---

## 9.8 The big picture: control plane, then data plane

The deepest architectural insight from KIP-500 is the cleanly-separated
control plane:

- **Control plane:** the metadata log, replicated via Raft to a small
  quorum of controllers. Decisions about leadership, topology, ACLs flow
  here.
- **Data plane:** the user-data partitions, replicated via Kafka's
  follower-fetch protocol to the assigned brokers. Producer/consumer
  traffic flows here.

These were always conceptually distinct, but in the ZK era the control
plane was implemented in a wholly different system (ZooKeeper). KRaft
unifies them: both planes use Kafka's log + replication primitives, with
the control plane having a special quorum and special record types.

This unification has a beautiful implication: **the lessons from
operating Kafka's data plane apply directly to the control plane**.
Replication, ISR, leader epoch, snapshotting — all the things you've
learned about partitions transfer to the metadata log. The cognitive load
of operating Kafka has dropped substantially.

---

## 9.9 Configurations that matter

```properties
# In KRaft mode, on controllers:
process.roles=controller
node.id=1
controller.quorum.voters=1@host1:9093,2@host2:9093,3@host3:9093

# Listener for inter-controller traffic:
listeners=CONTROLLER://host1:9093
listener.security.protocol.map=CONTROLLER:PLAINTEXT
inter.broker.listener.name=...    # for brokers, not controllers

# Heartbeat / liveness:
broker.heartbeat.interval.ms=2000
broker.session.timeout.ms=9000

# Metadata log:
metadata.log.dir=/data/kafka-metadata
metadata.log.segment.bytes=1073741824
metadata.log.max.snapshot.bytes=10737418240
metadata.max.retention.bytes=...

# Raft tuning (rare):
controller.quorum.election.timeout.ms=1000
controller.quorum.election.backoff.max.ms=1000
```

Most of these defaults are correct; production tuning is rare.

---

## Summary box

- The **controller** owns cluster-wide metadata: topology, leadership,
  ISR, configs, ACLs.
- **ZK era (legacy)**: controller was an elected broker; metadata in
  ZooKeeper; cold start could take minutes; recovery was the operational
  pain point.
- **KRaft era (current)**: controllers are a dedicated Raft quorum;
  metadata is `__cluster_metadata`, a Raft-replicated topic; brokers tail
  the log; failover is sub-second.
- **Kafka Raft (KIP-595)** uses follower-fetch instead of leader-push,
  matching the data-plane protocol.
- **Migration** (KIP-866) supports zero-downtime move from ZK to KRaft;
  Kafka 4.0 (2025) removes ZK entirely.
- Operational profile is dramatically better in KRaft: faster cold start,
  cleaner failure semantics, single technology to operate.
- Watch `MetadataLag` per broker and `ActiveControllerCount` cluster-wide.

## Further reading

- KIP-500: Replace ZooKeeper with a Self-Managed Metadata Quorum. The
  founding document; ~25 pages, dense.
- KIP-595: A Raft Protocol for the Metadata Quorum. The Raft variant.
- KIP-630: Kafka Raft Snapshot.
- KIP-866: ZooKeeper to KRaft Migration.
- *In Search of an Understandable Consensus Algorithm* (Ongaro & Ousterhout,
  2014). The original Raft paper; KIP-595 is a thoughtful adaptation.

## War story: the controller that wouldn't die

A team I consulted for had recently migrated to KRaft. Cluster ran
smoothly for months. One Sunday, on-call paged: "ActiveControllerCount=2".

Two active controllers is impossible — that would be split-brain. The
metric must have been wrong, surely. Except the cluster was misbehaving:
some partitions had two different leaders depending on which broker you
asked.

What had happened: a network partition isolated one of the three
controllers from the other two. The isolated controller could not see the
other two; the other two had majority and elected a new leader among
themselves. So far, normal.

The problem was the isolated controller still had a stale belief that *it*
was the leader (its term hadn't been bumped because it couldn't see the
new election's heartbeats). It kept serving requests to brokers that
could still reach it. Two of the brokers — on the same isolated network
segment as the stuck controller — believed it. The other brokers believed
the new leader.

How did this happen? The isolated controller hadn't yet observed the
heartbeat timeout. Its lease was still valid by its own clock. Term was
unchanged.

How did it get fixed in Kafka? KIP-595's pre-vote and the leader-lease
mechanics actually *should* prevent this: the isolated controller's
lease expires before it can serve writes. But the team had set
`controller.quorum.fetch.timeout.ms` very high (60s) for some custom
reason, and the leader-lease logic was effectively turned off.

Fix: revert the timeout to default (10s); reboot the isolated
controller; full quorum re-converged within seconds.

Lessons:

1. **Don't tune Raft timeouts unless you really know what you're
   doing.** They interact in subtle ways; the defaults are battle-tested.
2. **`ActiveControllerCount > 1` is the worst possible alert. Page
   immediately.** Don't acknowledge until you understand why.
3. **Network partitions on the controller quorum are real.** Plan for
   them: AZ-spread the controllers; alarm on quorum membership flapping.

Even a well-tested Raft implementation has knobs that, mistuned, defeat
its safety guarantees. The defaults are not arbitrary. Respect them.
