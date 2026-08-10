# Chapter 2 — From Log to System
### Brokers, Topics, Partitions, Replicas, and the Controller

---

The previous chapter described a single log. A single log is not a system —
it lives on one machine, it has no fault tolerance, and it scales only as far
as that one machine's CPU, network, and disk allow. Kafka, the system, is
what you get when you take the log abstraction and make it survive disk
failures, machine crashes, network partitions, hot keys, and growth from a
megabyte per second to terabytes per second without anyone having to redesign
the integration.

That requires a layer above the log. This chapter is the floor plan of that
layer. We will walk the building once, lightly, before going room by room in
the chapters that follow. By the end of the chapter you should be able to
draw the architecture diagram from memory and explain what each box does and
why it has to exist.

---

## 2.1 The five nouns

Almost everything in Kafka is built from five concepts. Internalise them and
half the documentation becomes redundant.

**Topic.** A named log, conceptually. In practice, a logical grouping of
partitions. "All clickstream events", "all order-placed events", "all
audit-log entries" — each is one topic. A topic is the user-visible unit of
publishing and subscribing.

**Partition.** The actual log. A topic with 24 partitions is *24
independent logs*, each of which preserves order internally but has no
ordering relationship to its siblings. Partitions are the unit of parallelism
(more partitions = more concurrent consumers), the unit of distribution (each
partition lives on a particular set of brokers), and the unit of replication.

**Broker.** A single Kafka server process. A broker is a JVM running the
broker code, holding some number of partition replicas on its local disk,
serving producer and consumer requests over TCP. A *cluster* is a set of
brokers that know about each other. The broker is the operational unit — the
thing you patch, restart, replace.

**Replica.** A copy of a partition's log on a particular broker. A topic
configured with replication factor 3 means each partition has 3 replicas,
each on a different broker. One replica per partition is the **leader**;
the others are **followers**. All reads and writes for a partition go through
its leader. Followers exist solely for durability and failover.

**Controller.** A specially-elected broker (or, in KRaft, a dedicated quorum
of controllers) responsible for cluster-wide decisions: leader election when
a broker dies, assigning partitions to brokers, propagating metadata. There
is exactly one *active* controller in the cluster at any moment. The
controller is the brain.

That's the cast. Everything else in this book is interactions among them.

---

## 2.2 Why partition? Why not one big log per topic?

Partitions look, at first glance, like a flaw in the abstraction — they
sacrifice the clean "one log per topic" mental model for messy details. They
exist because of three forcing constraints, each of which makes a single log
untenable.

### Constraint 1: One disk is not enough

Suppose your "click events" topic ingests 10 GB/s. A single disk does, on
the absolute high end, perhaps 2 GB/s of sequential writes. A single
broker can host many disks, but at some point the broker itself — its CPU,
its network card, its memory bus — saturates. Beyond that point, the only
option is to spread the writes across multiple machines. Partitioning is the
mechanism: break the topic into N partitions, place them on different
brokers, and now your 10 GB/s is N × (10/N) GB/s instead.

### Constraint 2: One reader is not enough

Even if a single broker could handle the writes, a single consumer process
reading the topic would saturate long before the producer side did.
Real-world consumers do useful work — feature extraction, aggregation, IO
to a downstream system — and useful work is slower than just receiving
bytes. Multiple consumer processes need a way to share the load. The
partition is that unit of sharing: each partition is read by *exactly one*
consumer in a consumer group, but a group can have up to N consumers for an
N-partition topic, each working in parallel on a disjoint slice.

### Constraint 3: Total ordering across a giant log is a fiction anyway

A single global log of all events at the firm sounds appealing. In practice,
across a planet-scale distributed system, the *physical reality* is that
events are happening at multiple data centres simultaneously and any
"global ordering" you imagine is one you imposed at some serialisation
point. It is not real. Events happening simultaneously in Tokyo and São
Paulo do not have a true relative order; declaring one is fine for
bookkeeping but arbitrary, and the cost of imposing it (a single bottleneck
all events must pass through) is enormous.

Partitioning matches the physics: order is preserved *where order is
meaningful*, and meaningful order, in a distributed system, is per-key, not
global. Order all events for user 47 with respect to each other — that is
what user 47 cares about. Order all events for user 47 with respect to all
events for user 48 — irrelevant, and expensive to enforce.

So the partition is not a flaw. It is the right cut. Single-log is a fantasy
for a single machine; the real world wants per-key ordering and otherwise
parallelism, and that is what partitions deliver.

---

## 2.3 The partitioning contract

You — the producer — choose which partition each record lands in. The
default rule is:

```
partition(record) = (key == null) ?
  sticky_partitioner() :
  hash(key) % num_partitions
```

Two cases:

**Keyed records** go to a partition determined by a hash of the key. All
records with the same key land in the same partition. *This* is how you get
per-key ordering: records for user 47 always land in partition 13 (say), and
within that partition they are strictly ordered. Records for user 48 might
land in partition 7, and the relative order of user-47 events versus
user-48 events is undefined.

**Keyless records** do not need a particular partition. They are spread for
load balance using the *sticky partitioner* (Kafka 2.4+; before that,
round-robin). The sticky partitioner picks one partition, fills a batch
there, then moves to the next — this is dramatically better for batching
and compression than pure round-robin, which fragments writes across all
partitions and produces tiny per-partition batches. We will dig in further
in Chapter 4.

The contract has a sharp edge: **adding partitions changes the hash
mapping for new records**. If you go from 24 partitions to 32, records
keyed "user-47" that used to land on partition 13 now land on partition 7.
Old records remain on partition 13. Your consumer that maintains "the latest
state for each user" by partition has now broken: user 47 has state on two
partitions, and which partition's processor reads which partition's data
depends on the assignment, and the assumption that "all user-47 events flow
through one consumer instance" no longer holds.

You can mitigate this. You can use a custom partitioner that does
consistent-hashing rather than modular, so adding partitions only re-routes a
fraction of keys. You can use stable IDs derived from less mutable things.
You can, in extremis, accept the migration pain. But the right answer is
**choose your partition count carefully up front** and oversize. Going from
24 to 32 partitions is rare and painful; going from 24 to 24 forever is
free.

I have seen teams pick 6 partitions on day one, hit the wall a year later,
and spend six months unwinding the assumption. Pick a number bigger than you
think you need, by a factor of 4 to 10x. Disk is cheap. A topic with 200
partitions and 5 GB/s of traffic costs you nothing extra; a topic with 6
partitions that needs to grow to 200 will cost you a quarter.

---

## 2.4 Replicas and the leader/follower model

Each partition has a **replication factor** (RF), typically 3. RF=3 means
three brokers each hold a complete copy of that partition's log on local
disk. One of those three is the **leader**; the other two are **followers**.

```
Partition my-topic-0:
  broker 1: leader
  broker 2: follower
  broker 3: follower

Partition my-topic-1:
  broker 2: leader
  broker 1: follower
  broker 3: follower

Partition my-topic-2:
  broker 3: leader
  broker 1: follower
  broker 2: follower
```

Two important properties:

**All client traffic goes through the leader.** A producer sending to
`my-topic-0` finds the leader (broker 1) and sends only there. A consumer
reads from the leader by default. (Kafka 2.4+ introduced *follower fetching*
for cross-rack consumer reads to save WAN bandwidth — a niche feature
covered in Chapter 17.) Followers do not serve clients; they exist to mirror
the leader's log.

**Leadership is balanced across brokers.** A cluster of three brokers, each
hosting partitions of the same topic, will have leadership roughly evenly
distributed. The controller (Section 2.7) is responsible for keeping
leadership balanced as partitions are added, brokers join or leave, etc.
There is even a `kafka-leader-election.sh` tool for triggering a
"preferred-replica election" — restoring leadership to its preferred (i.e.,
balanced) layout after some perturbation has skewed it. Chapter 19 covers
this.

### How replication actually works (short version, deep version is Chapter 8)

The follower runs a tight loop:

```
while alive:
  send FetchRequest to leader, asking for offsets >= my LEO
  receive batch of records from leader
  append to local log
  update local LEO
```

LEO is the **Log End Offset** — the offset of the next record to be written
locally. If the follower's LEO falls within `replica.lag.time.max.ms` of the
leader's, it is considered **in-sync**. The set of all in-sync replicas
(including the leader itself) is the **ISR** — In-Sync Replica set.

The leader maintains the **High Watermark** (HWM) — the highest offset
that has been replicated to *all* members of the ISR. Records below the HWM
are *committed*; consumers are only allowed to read up to the HWM.
Producers with `acks=all` are only acknowledged once the record's offset is
≤ HWM.

Three offsets, then, define the state of a partition:

- **LEO** of each replica — where each replica's log ends
- **HWM** — the highest offset committed (replicated to all ISR)
- **Log start offset** — the lowest offset still retained (everything below
  has been deleted)

Memorise these three. Almost every replication discussion in this book is in
their language.

---

## 2.5 The producer/broker/consumer interaction (sketch)

Here is the full path of a record, in cartoon form, with chapter pointers
for each step.

```
APPLICATION:
  producer.send(record)
                                                     ↓
PRODUCER CLIENT (in-process):                        [ Chapter 4 ]
  serialize key/value
  pick partition (sticky / hash)
  append to RecordAccumulator (per-partition buffer)
  --- background Sender thread ---
  group batches by destination broker
  send ProduceRequest over TCP
                                                     ↓
LEADER BROKER:                                       [ Chapter 6 / 7 ]
  network thread: read request bytes
  request handler thread: validate, append to log
  add to ProducePurgatory if acks=all (waits for HWM advance)
                                                     ↓
FOLLOWER BROKERS (continuously):                     [ Chapter 8 ]
  Fetcher thread sends FetchRequest to leader
  receives batch, appends to local log, updates LEO
                                                     ↓
LEADER BROKER:
  on each follower fetch, recompute HWM
  if HWM ≥ produce request's offset → ack producer
                                                     ↓
PRODUCER CLIENT:
  callback fires: success(metadata) or failure(error)
                                                     ↓
CONSUMER CLIENT:                                     [ Chapter 10 ]
  Fetch thread sends FetchRequest to leader
  receives batches (only up to HWM)
  hands records to application via poll()
  application processes, then commits offsets
                                                     ↓
LEADER BROKER (group coordinator):                   [ Chapter 11 ]
  receives offset commit
  appends to __consumer_offsets topic
  acks the consumer
```

This is the steady-state happy path. Most of the rest of the book is about
what happens when this path is perturbed: the leader dies, the follower
falls behind, the consumer crashes, the partition is added, the controller
fails over, the disk runs out, the network partitions. Each perturbation has
a protocol designed to handle it, and each protocol has subtle edge cases
that are worth understanding before you encounter them at 3 a.m.

---

## 2.6 The metadata problem

A cluster has many topics. Each topic has many partitions. Each partition
has a leader and a set of replicas. As brokers join, leave, crash, and are
restarted, this assignment shifts. *Someone has to know the current state of
the world*, and *every client has to be able to learn it*, fast, when it
needs to.

This is the metadata problem, and it is the entire reason Kafka has a
controller. A producer sending to `my-topic-0` needs to know which broker is
currently the leader of `my-topic-0`. If the producer's information is stale
— the leader has moved — the produce request will fail with
`NOT_LEADER_OR_FOLLOWER`, the producer will refresh metadata, retry, and
eventually succeed. But the underlying question remains: *where does the
ground truth about the leader of partition 0 live?*

Through the entire ZooKeeper era (Kafka 0.x through 2.x and into 3.x), the
ground truth lived in ZooKeeper. The Kafka cluster's metadata —
topic configurations, partition assignments, ISR membership, controller
identity — was stored in znodes. The controller broker maintained a watcher
set on these znodes; when something changed (a broker died, an ISR shrank),
ZooKeeper notified the controller, and the controller propagated the new
state to the affected brokers via `LeaderAndIsrRequest` and
`UpdateMetadataRequest` RPCs.

This worked. It also had problems:

- **Two consensus systems.** ZooKeeper itself is a Raft-like consensus
  system (technically Zab, a sibling protocol). Running two consensus systems
  to operate one is operationally complex and politically uncomfortable —
  ZooKeeper has a different ops profile, different security model, different
  tuning story.
- **Slow recovery.** When the controller died, the new controller had to
  re-read every topic's metadata from ZooKeeper before it could function.
  On large clusters (10K+ partitions), this took *minutes*. Throughout that
  recovery, no leader elections could happen, no partitions could be added,
  no ISR updates could be applied — the cluster was effectively frozen on
  control-plane operations.
- **The watcher cliff.** ZooKeeper's notification model fires per-znode; on
  some events it would batch and on others it would fan out, and the
  controller would receive cascades of notifications during incidents that
  produced more incidents. The interactions were subtle and well-documented
  by the people running large clusters in pain.
- **Limited scalability.** ZooKeeper does not scale write throughput
  horizontally — five-node ensembles are common, but a five-node ensemble
  has a fixed write capacity and adding more ensembles does not help. At
  some point, large Kafka clusters were bottlenecked on ZooKeeper.

KIP-500 (proposed 2019, GA in Kafka 3.3 / 2022, ZK removal in Kafka 4.0 /
2025) was the answer: replace ZooKeeper with a Raft-based metadata log
*inside Kafka itself*. The result is **KRaft** — Kafka Raft.

This book describes Kafka in KRaft mode unless otherwise noted. We will go
deep on KRaft in Chapter 9. For now, the only thing to know is:

> The metadata of the cluster — every topic, every partition, every leader,
> every ISR member — lives in a special internal Kafka topic
> (`__cluster_metadata`), which is itself replicated via Raft across a small
> set of *controller* nodes. Every broker is a tail consumer of this topic
> and uses it to know what to do.

This is the fully reflexive design: Kafka's own metadata is stored in Kafka.
It is elegant and slightly uncanny when you first see it. It is also vastly
faster on cold start and substantially simpler operationally, and it is why
the era of "ZK + Kafka" is ending.

---

## 2.7 The controller, in three views

The controller deserves three views because it is hard to understand from any
one of them.

### View 1: Functional

The controller is responsible for:

- **Topic creation/deletion.** When you `CreateTopic`, the controller picks
  a partition assignment and propagates it.
- **Partition leader election.** When a leader broker dies, the controller
  picks a new leader from the surviving ISR and tells the cluster.
- **ISR maintenance.** When a follower falls behind or catches up, the
  controller updates the ISR set in the metadata log.
- **Broker join / fail.** When a broker registers (heartbeat) or stops
  heartbeating (failure), the controller updates membership.
- **Partition reassignment.** When you tell the cluster to move partition X
  from broker A to broker D, the controller orchestrates the migration.

It does *not* serve produce or consume traffic. It is purely a control plane.

### View 2: Organisational

The controller is *one specific broker* in the cluster (in ZK mode) or *one
specific node in the controller quorum* (in KRaft mode). At any moment,
there is exactly one **active** controller. In KRaft, there are typically
3 or 5 controller nodes total; one is the leader of the controller Raft
group; that one is the active controller; the others are passive standbys
ready to take over if the active controller dies.

In ZK mode, the active controller was elected by writing to a `/controller`
znode. The first broker to successfully claim the znode became the
controller. If it died, the znode's ephemeral lease expired, another broker
claimed it, and the new controller began the cold-start re-read.

In KRaft mode, the active controller is the Raft leader. It is determined by
the standard Raft election protocol (we cover this in Chapter 9). Failover is
typically sub-second, because the new active controller already has the full
metadata log replicated and does not need to re-read from a separate
storage system.

### View 3: Mechanical

In KRaft mode, the controller's job, mechanically, is:

1. **Receive write requests** for metadata changes (e.g., `AlterTopicRequest`,
   `AlterPartitionReassignmentsRequest`, broker heartbeats indicating
   liveness).
2. **Apply these as records to the `__cluster_metadata` log**, replicated
   via Raft to other controller nodes.
3. **Track every broker's "metadata offset"** — how far each broker has
   replicated the metadata log.
4. **Decide consequences** — when a broker's heartbeat times out, the next
   record in the metadata log marks it offline, which triggers leader
   elections for partitions it led, written as further records in the log.
5. **Brokers tail the metadata log** and apply the decisions — when a
   broker reads a record saying "you are now leader of partition 0", it
   transitions partition 0 to leader state locally, opens itself for produce
   traffic on that partition, etc.

The controller's authority does not come from RPC — it comes from being
able to write to the metadata log. Brokers obey the log, not the controller
directly. This is a very clean factoring.

---

## 2.8 Where everything lives, in 2026

Putting it together, here is the canonical KRaft-mode Kafka deployment in
2026:

```
                    ┌────────────────────────────────┐
                    │  CONTROLLERS  (3 or 5)         │
                    │  Raft replicate                │
                    │  __cluster_metadata            │
                    │                                │
                    │  ┌────┐  ┌────┐  ┌────┐        │
                    │  │ C1 │←→│ C2 │←→│ C3 │        │
                    │  └────┘  └────┘  └────┘        │
                    │   leader   follower  follower  │
                    └──────────────┬─────────────────┘
                                   │ replicate metadata log
                                   ↓
       ┌───────────────────────────────────────────────────┐
       │  BROKERS  (3 to thousands)                         │
       │                                                    │
       │  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ...      │
       │  │ B1 │  │ B2 │  │ B3 │  │ B4 │  │ B5 │            │
       │  └─┬──┘  └─┬──┘  └─┬──┘  └─┬──┘  └─┬──┘            │
       │    │       │       │       │       │               │
       │   disk    disk    disk    disk    disk             │
       │   (partition replicas)                             │
       └─────────────────┬─────────────────────────────────┘
                         │
              ┌──────────┴───────────┐
              │                      │
        Producers              Consumers
        (clients)              (clients, in groups)
```

A few notes:

- Controllers are *typically* dedicated nodes — not also brokers — for
  large production clusters. For small clusters, "combined mode" lets you
  run both roles on the same JVM. This is convenient for dev/test and
  acceptable for small workloads but not recommended for serious production.
- Brokers run on physical or virtual machines with local disks (SSDs in
  modern deployments; spinning disks were common historically and still
  exist for high-volume cold-tier topics). Disk is local, deliberately —
  Kafka leans heavily on the OS page cache, and shared storage (NAS, EBS)
  has subtle interaction issues we cover in Chapter 17.
- The topology can stretch across availability zones for fault tolerance
  (rack-aware replica assignment, KIP-36 and KIP-392) and across regions for
  geo-redundancy (MirrorMaker, Chapter 19).
- Modern (2024+) deployments increasingly use **tiered storage** (KIP-405,
  Chapter 13) to offload old segments to S3 or equivalent, keeping local
  disk for the hot tail. This changes the cost story significantly — you can
  now retain a year of data without paying for a year of SSD.

---

## 2.9 What is *not* in the picture

Some things are notable for their absence:

**No service discovery.** Clients learn the broker layout from the brokers
themselves via `MetadataRequest`. Bootstrap is via a list of *any* brokers
(`bootstrap.servers` config); from those, the client discovers all the
others. There is no Consul, no etcd in the client path.

**No load balancer.** There is no LB in front of brokers. Clients connect
directly to the leader of each partition. Putting an L4 LB in front would
break this — the client would need to retain the IP of the leader for that
partition, which an LB hides. (This is a frequent rookie mistake when
deploying Kafka in cloud environments.)

**No central scheduler.** Clients do their own retry, timeout, backoff,
batching. The broker exposes a passive surface. There is no global "send
this to that broker now" co-ordinator. (This is part of why Kafka scales:
nothing in the protocol requires a global decision per record.)

**No transactions across partitions, by default.** A produce of two records
to two different partitions can succeed for one and fail for the other.
Kafka's transactional protocol (Chapter 5) papers over this for groups of
records but it is opt-in and has costs.

These absences are deliberate. Each one of them is a place where you might
expect a centralised component, and Kafka has gone to some pains to avoid
having one. The reason is that centralised components are bottlenecks and
single points of failure, and Kafka's job is to be neither.

---

## Summary box

- **Topic** = logical name. **Partition** = the actual log. **Broker** = a
  Kafka server. **Replica** = a copy of a partition on a broker. **Controller**
  = the broker (or quorum) that owns cluster-level decisions.
- Partitioning is forced by physical limits (disk, network, single-reader
  bandwidth) and matches the partial order of distributed reality (per-key
  order, not global).
- Each partition has a leader and N-1 followers; all client traffic goes
  through the leader; followers replicate via a continuous fetch loop.
- Three offsets define a partition's state: **LEO** (per replica), **HWM**
  (committed point), **log start offset** (oldest retained).
- The controller is the brain. In KRaft mode, it is the Raft leader of a
  small controller quorum; metadata is replicated as a topic
  (`__cluster_metadata`) that brokers tail.
- Almost everything else in this book is one of these pieces in failure
  mode.

## Further reading

- KIP-500: Replace ZooKeeper with a Self-Managed Metadata Quorum. The
  origin document for KRaft.
- KIP-595: A Raft Protocol for the Metadata Quorum. The Raft variant
  Kafka uses.
- The original Kafka paper (NetDB 2011) for the initial broker design.
  Replication came later, in KIP-50 era.

## War story: the day a partition count broke the bank

A team I was advising had a single high-throughput topic — call it
`payments` — with 6 partitions. They had picked 6 because they had 6
consumer instances at launch, which was a reasonable choice. Two years
later, the consumer side had been re-engineered into a fleet of 200
processes. Each process could handle far less throughput than they wanted,
because *they could not have more than 6 active processes at once* — that's
the partition count's hard ceiling on consumer parallelism within a single
group. The other 194 processes sat idle, waiting on the 6 with assignments.

The fix should have been "increase partition count to 200." But they had
keyed by `payment_id`, and downstream services had been written to assume
that "all events for a payment land on a single consumer instance" — they
maintained per-payment in-memory state, and a payment's events being split
across two consumers would be a data-integrity bug.

So they could not just add partitions; that would scramble the hash. They
ended up doing a six-month migration: build a "bridge topic" with 200
partitions, rewrite producers to dual-write, build a custom partitioner that
preserved old assignments where possible, painstakingly migrate consumers,
finally cut over and decommission the 6-partition topic.

The total cost, in engineering time, was about $1.2 million.

The cost of picking 200 partitions on day one would have been zero.

> Pick partition counts generously. Disk is cheap; migration is not.

This is, I think, the single most expensive lesson in operational Kafka, and
the one I see new teams re-learning every couple of years. Read this
chapter twice. Pick big numbers. Move on.
