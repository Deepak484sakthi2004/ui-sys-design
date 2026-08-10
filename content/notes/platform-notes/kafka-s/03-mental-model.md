# Chapter 3 — The Mental Model
### How to Think About Kafka Before Reasoning About Anything Specific

---

You can know every config, every wire format, every line of broker source
and still be unable to debug Kafka effectively. This happens because debugging
distributed systems is not a lookup task — it is a reasoning task, and
reasoning requires a mental model. A mental model is the set of *invariants*
you carry in your head, the *cause-and-effect chains* you have rehearsed,
and the *failure modes* you imagine before they happen. Without one,
documentation is noise; with one, the documentation slots into place around a
skeleton you already understand.

This chapter is the skeleton. It is the only chapter in this book that does
not introduce new mechanism; it organises mechanism you already half-know
into a frame. Most chapters are forty pages. This one is short and to be
re-read.

---

## 3.1 The four-layer model

Hold this in your head whenever you are debugging Kafka:

```
  ┌─────────────────────────────────────────────┐
  │  Layer 4 — APPLICATIONS                     │
  │  Producers, consumers, Streams jobs,        │
  │  Connect tasks, your actual business logic. │
  └─────────────────────────────────────────────┘
                       ↑↓
  ┌─────────────────────────────────────────────┐
  │  Layer 3 — CLIENT PROTOCOL                  │
  │  Kafka API: Produce, Fetch, Metadata,       │
  │  OffsetCommit, JoinGroup, etc. The wire.    │
  └─────────────────────────────────────────────┘
                       ↑↓
  ┌─────────────────────────────────────────────┐
  │  Layer 2 — BROKER INTERNALS                 │
  │  Network threads, request handlers, log     │
  │  segments, replication, controller,         │
  │  consumer-offset/transactional storage.     │
  └─────────────────────────────────────────────┘
                       ↑↓
  ┌─────────────────────────────────────────────┐
  │  Layer 1 — PHYSICAL                         │
  │  JVM (heap, GC, off-heap), OS (page cache,  │
  │  fsync, sendfile), disk, NIC, kernel.       │
  └─────────────────────────────────────────────┘
```

Every Kafka problem lives in one of these layers. Many problems present
*as if* they live in one layer but actually live in another, and the
discipline of asking "which layer is this?" is what separates a fast debugger
from a slow one.

A few examples:

- *"Producers are slow."* Almost always Layer 1 (page cache thrashed by
  retention or tiered-storage upload, GC pause on broker, NIC saturation) or
  Layer 4 (you forgot `linger.ms`). Almost never Layer 3.
- *"Consumer rebalances are constant."* Always Layer 4 (your `poll()` loop
  is not running fast enough) or Layer 3 (`max.poll.interval.ms` is too
  tight). Layer 2 will *show* the symptom (partitions revoked) but it is
  not the cause.
- *"`acks=all` is acknowledged but data is lost on broker failure."* Almost
  always a Layer 2 failure (`min.insync.replicas` was set wrong, ISR shrank
  to 1, leader died, follower with stale data took over). The producer was
  doing exactly what you asked.
- *"Cluster CPU is at 100%."* Layer 1 (GC death spiral) or Layer 2
  (request-handler saturation due to a mis-sized request queue). Wear your
  flame-graph hat.

When something breaks, name the layer first. Then debug.

---

## 3.2 The four invariants

These are the truths Kafka holds. Every protocol exists to preserve them; every
incident is one of them being violated.

### Invariant I: Within a partition, the order of records is the order of writes

Two records `r1` and `r2` written to the same partition in that order, by
the same producer (or even by different producers, as serialised by the
broker), will be assigned offsets `o1 < o2` and read back in that order
forever. Always.

Corollaries:

- **Replication preserves order.** Followers see records in offset order.
- **Consumers see order.** A consumer reading partition P sees records in
  offset order.
- **Order across partitions is undefined.** Two records on different
  partitions have no enforceable temporal relationship.

Violations of this invariant (record reordering within a partition) have
happened — historically, due to producer retry without idempotence (Chapter
5). Modern Kafka has fenced these out, but the fix was non-trivial. The
invariant is the bedrock; understand the protocols that preserve it.

### Invariant II: Once committed (HWM-acknowledged), a record will never be lost as long as ≤ N-1 brokers in the ISR fail simultaneously, where N is replication factor

This is the durability promise. The qualifier — "as long as ≤ N-1 brokers
fail simultaneously" — is doing real work. With RF=3, two brokers can fail
at once and you lose nothing. Three failing simultaneously is data loss. But
*sequential* failures with recovery between them are absorbable: if broker 1
dies, the ISR shrinks to {2,3}, and as long as 2 fails *after* 1 recovers,
you are still safe.

This invariant is bounded by:

- **`min.insync.replicas`**, which sets the minimum ISR size before
  produces with `acks=all` are rejected. If you have RF=3 but min ISR=1, you
  can technically commit a record to one broker only — and lose it when
  that broker dies. **`min.insync.replicas=2` is the floor for serious
  durability.**
- **`unclean.leader.election.enable`**, which, if true, allows a non-ISR
  replica to become leader. This trades availability for durability and
  *will* cause data loss in real failures. Default is now `false`. Keep it
  that way.
- **Disk failures.** If the local disk is corrupted on enough replicas, the
  invariant fails. RF≥3 plus rack-awareness (different racks/AZs for the
  three replicas) is the operational mitigation.

### Invariant III: A consumer's progress is exactly captured by its committed offsets

The consumer is a stateless thing, modulo its committed offset. If you kill
the consumer process, restart it with the same group ID, it picks up exactly
where the last commit landed. Re-process means re-process from the committed
offset.

This has two implications people get wrong:

- **Auto-commit is dangerous.** With `enable.auto.commit=true`, offsets are
  committed every `auto.commit.interval.ms` (default 5s) regardless of
  whether you have processed those records yet. A crash between "received"
  and "processed" loses data. Almost every production deployment should
  set `enable.auto.commit=false` and commit explicitly after processing.
- **Idempotence is your problem, not Kafka's.** A consumer that processes a
  batch, fails before committing, and restarts will *reprocess that batch*.
  This is "at-least-once" semantics. If your processing is not idempotent
  (e.g., it sends emails), you double-send. The Kafka protocol cannot fix
  this for you — only you can, by making your processing idempotent or by
  using the transactional/exactly-once machinery (Chapter 5).

### Invariant IV: The metadata is eventually consistent across all brokers

When the controller decides "broker 5 is now the leader of partition 7", that
decision is propagated via the metadata log. Brokers and clients catch up to
the new metadata at slightly different times. *In the gap*, a producer might
send to the old leader, get a `NOT_LEADER_OR_FOLLOWER` error, refresh
metadata, retry to the new leader, and succeed. This is normal.

The implication is that *transient errors during leadership changes are
expected* and the client must be configured to retry. A producer with
`retries=0` will drop messages during a leader election, full stop. The
default is now `retries=Integer.MAX_VALUE` for exactly this reason — but
older codebases sometimes have `retries=0` left over from a misguided
optimisation, and they break in subtle ways during cluster maintenance.

---

## 3.3 The three failure modes that matter

Almost every Kafka incident is one of:

### Failure mode A: The producer is faster than the broker can absorb

Symptom: producer's `BufferPool` exhausted, `send()` blocks for
`max.block.ms`, eventually throws. Or: produce latency p99 spikes; producer
queue grows.

Root causes (in rough order of likelihood):

1. Broker CPU saturated (request handlers all busy, request queue backing
   up). Diagnose with `RequestHandlerAvgIdlePercent` JMX metric.
2. Broker disk saturated (writes can't drain to disk, page-cache backpressure).
3. Network saturated (NIC pegged at line rate).
4. GC pause on broker (long stop-the-world, request handlers can't run).
5. Replication-induced latency: `acks=all` is waiting for slow followers to
   catch up. ISR is small or one ISR member is slow.

Layer: usually Layer 1 or Layer 2. Producer config (Layer 4) only
*amplifies* the problem; the producer is the canary, not the cause.

### Failure mode B: The consumer falls behind

Symptom: consumer lag grows unboundedly; `kafka-consumer-groups.sh
--describe` shows large `LAG` values; downstream system is "behind".

Root causes:

1. Application processing is slower than ingest rate. (Layer 4.) The
   processing function is too slow per record, or there are not enough
   consumer instances to parallelise.
2. Consumer is repeatedly rebalancing — every rebalance pauses consumption
   on all members for seconds. `max.poll.interval.ms` too tight, or sticky
   partitioner not enabled, or static membership not configured. (Layer 3/4.)
3. Network egress from broker to consumer is throttled or saturated. (Layer
   1.)
4. Consumer's per-partition fetch buffer is too small —
   `max.partition.fetch.bytes` lower than your largest record batch. The
   consumer skips that batch with an error and lag grows. (Layer 3.)

The diagnostic is almost always JMX + `kafka-consumer-groups.sh --describe`.
Lag tells you the *fact*; the rate of consumption versus production tells
you the cause.

### Failure mode C: Cluster-level state divergence

Symptom: producers/consumers seeing different leader information; ISR
flapping; controller thrashing; metadata stale on some brokers; partitions
"stuck" with `under-replicated-partitions` JMX metric > 0.

Root causes:

1. Network partition between subset of brokers. The controller can't reach
   them; the brokers can talk to each other but not to clients.
2. Slow follower(s) being included and excluded from ISR repeatedly, often
   because of disk-IO spikes (compaction running, retention delete
   running) coinciding with replication.
3. ZooKeeper / KRaft quorum issues — slow control plane. (Pre-KIP-500
   common; rare in KRaft.)
4. **Pathological case:** the controller itself is mis-behaving. Almost
   always a JVM issue (GC, OOM) on the controller node.

This is the most operationally complex failure mode. The mitigations are
mostly preventive: rack-aware replica assignment so any one network partition
can't take down a majority; conservative `min.insync.replicas` so loss of
one replica doesn't lose data; KRaft instead of ZooKeeper for faster
control-plane recovery; aggressive monitoring of `UnderReplicatedPartitions`
and `OfflinePartitionsCount`.

---

## 3.4 The seven knobs that matter

Kafka has hundreds of configs. Of those, seven matter on every cluster, and
mis-setting any one of them is most of how teams hurt themselves.

### Producer

| Config | Recommendation | Why |
|--------|----------------|-----|
| `acks` | `all` | Anything else trades durability for latency. The default of `all` exists for a reason. (`acks=1` was the default in older Kafka.) |
| `enable.idempotence` | `true` | Default since Kafka 3.0. Prevents duplicates on retry; cost is negligible. Off for "fire and forget" only. |
| `linger.ms` | `5` to `100` | Default 0 disables batching. Even 5 ms hurts your latency by 5 ms but improves throughput and compression substantially. |
| `compression.type` | `lz4` or `zstd` | Default `none` is wasteful. lz4 is fast and gives 3-5x compression; zstd gives 5-7x and is now widely supported. |

### Broker

| Config | Recommendation | Why |
|--------|----------------|-----|
| `min.insync.replicas` | `2` (with RF=3) | The single most common durability bug is `min.insync.replicas=1`. Set this at the topic level if possible. |
| `unclean.leader.election.enable` | `false` | Default. Never change this without a written justification. |
| `default.replication.factor` | `3` | Cluster-wide default for new topics. Anything less is "I am okay losing this data." |

These seven, set right, eliminate maybe 80% of the configuration-induced
incidents I have seen.

---

## 3.5 The mental moves that diagnose 80% of issues

When you are paged on Kafka, run through this sequence. Not as a checklist
to follow blindly — as a sequence of *mental moves* that orients you fast.

**Move 1: What changed?**

Almost every incident is "we changed something and it broke." Most often:
configuration push, broker restart, version upgrade, network change, sudden
traffic spike. Look at deploys, look at on-call notes, look at the cluster
metadata for recent topic changes. The phrase "this just started happening"
is almost always wrong; *something* started happening immediately before.

**Move 2: Producer or consumer?**

Is the symptom "producers are slow / failing" or "consumers are slow /
failing / behind"? These are very different problem spaces. Producer issues
are usually broker-side or network. Consumer issues are usually
application-side or rebalance.

**Move 3: All partitions or some partitions?**

If producer/consumer trouble is on every partition, it's a global broker or
network problem. If it's on a subset of partitions, find the brokers hosting
those partitions — there is almost certainly something wrong with one
specific broker.

**Move 4: Acute or chronic?**

Did this start in the last fifteen minutes (acute), or has it been getting
worse for hours (chronic)? Acute = an event happened. Chronic = a slow leak.
The diagnostic posture differs.

**Move 5: Look at the broker's GC log and request-handler idle %**

These two metrics tell you, faster than anything else, whether the broker is
healthy at Layer 1 and 2. GC logs show pause times; a 10-second GC pause
will *cause* most of the symptoms you are seeing without being one of them.
Request-handler idle % tells you whether the broker is CPU-bound on its own
work; below 30% sustained is a problem.

**Move 6: Look at `UnderReplicatedPartitions` and `OfflinePartitionsCount`**

These are the cluster's distress signals. Both should be 0 in steady state.
Anything else means there is a follower that can't catch up
(`UnderReplicatedPartitions`) or a partition with no leader at all
(`OfflinePartitionsCount`). The latter is "we are not serving traffic for
some partitions, period."

You will internalise these moves over time. The book will return to each of
them in the operational chapters with concrete commands and dashboards.

---

## 3.6 The most underrated mental model: Kafka as a state machine

Here is a viewpoint that pays for itself the first time you encounter a
weird incident: **a Kafka cluster is a giant deterministic state machine
whose state is the metadata log, whose inputs are administrative requests
and broker heartbeats, and whose outputs are leader-and-isr changes.**

The implication is that *if you have the metadata log, you can replay
exactly what the cluster did, in order, and reason about cause and effect
deterministically*. KRaft makes this concretely true (`__cluster_metadata`
is the log); it was true in spirit even in ZK mode.

When something weird happens — "why did partition 7 elect this leader and
not that one?" — the answer is in the sequence of metadata events leading
up to that election. The current state is a function of the history. There
is no oracle, no random number, no hidden global. Every decision has a
recorded cause.

Most engineers reason about Kafka as a network of objects that talk to each
other — broker A sends a thing to broker B which does a thing. This
mental model is fine for some things but fails on cluster-wide reasoning.
Reasoning over the metadata log is much more powerful, and it is how the
Kafka maintainers themselves think.

---

## Summary box

- Four layers: **applications, client protocol, broker internals, physical**.
  Every problem lives in one. Naming the layer is half the diagnosis.
- Four invariants: **per-partition order, durability with ≥1 ISR member
  alive, consumer progress = committed offsets, metadata is eventually
  consistent**.
- Three failure modes: **producer outpacing broker, consumer falling behind,
  cluster-level metadata divergence**. Each has a small, predictable set of
  root causes.
- Seven knobs: `acks`, `enable.idempotence`, `linger.ms`,
  `compression.type`, `min.insync.replicas`, `unclean.leader.election.enable`,
  `default.replication.factor`. Set these right; ignore most other configs
  until you have a reason.
- The metadata log is the cluster's state machine. Reasoning over the log,
  not over inter-broker RPCs, is the most powerful frame for hard
  incidents.

## Further reading

- Confluent's *Apache Kafka Operations* training material is reasonable on
  diagnostic playbooks. Take with a small grain of salt — vendor framing.
- *Kafka: The Definitive Guide* (2nd edition, 2021) chapters 9 and 11 for
  the operator's view.
- Brendan Gregg, *Systems Performance*. Not Kafka-specific, but the
  USE method (Utilisation, Saturation, Errors) is exactly the diagnostic
  posture you want at Layer 1.

## War story: the cluster that wasn't actually broken

Years ago I was paged at 4 a.m. for a "complete cluster outage." Producers
were timing out across the board. Consumers were stalled. Dashboards red.

I started at the top: applications. Producer logs showed
`TimeoutException` everywhere. So the producer wasn't getting through.

Layer 3, the wire? `tcpdump` on a producer host showed it sending and
receiving — packets were flowing. Not a connectivity issue.

Layer 2, the broker? CPU low. Memory low. Disk busy but not pegged.
`kafka-topics.sh --describe`: every partition had a leader, ISR was full,
no under-replicated partitions. The cluster *thought* it was healthy.

Layer 1, the physical? `iotop` on a broker. Bingo: a runaway log compaction
process was reading every segment of a particular topic, churning page
cache. The page cache was being evicted faster than it could be warmed by
producer/consumer traffic. Every produce was waiting for a write that
required a kernel-level page allocation; every fetch was a cold-read from
disk.

The cluster was not broken. The cluster was *fine*, by every metric the
broker exposed. The kernel's page cache was thrashed, and that was costing us
50× on every operation.

Fix: stop the offending log compaction (the topic in question had been
mis-configured to compact aggressively), and the entire cluster recovered
within minutes.

The lesson: the broker exposes a lot of metrics, and they are very good. But
the *substrate* — JVM, page cache, disk, NIC — exposes its own metrics, and
the substrate matters. A cluster whose self-reporting says "I am healthy"
can still be choking on Layer 1 in ways the broker has no view of.

The four-layer model would have saved me an hour of going down the wrong
path. I now reach for it instinctively. So should you.
