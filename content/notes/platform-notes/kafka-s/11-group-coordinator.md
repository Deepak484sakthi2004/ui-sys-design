# Chapter 11 — The Group Coordinator and Rebalancing
### How Consumers Find Each Other, and Why It Used to Hurt

---

A single Kafka consumer is a simple thing: it reads from partitions and
processes records. A *group* of consumers — what most production systems
actually run — is much more complicated. The group has to agree on which
member reads which partition, detect when members die, redistribute
partitions when membership changes, and do all this without losing track
of which records have been processed.

The mechanism that solves this is the **group coordinator** and the
**rebalance protocol**. It is, behind the producer's send loop and the
broker's storage engine, the third pillar of the consumer side. It has
also, historically, been the source of more operational pain than almost
any other part of Kafka — because rebalances *stop the world* for the
whole group, and naive applications discover this only after they've put
their first 500 consumers in production.

This chapter:

- The group-coordinator architecture.
- The classic rebalance protocol: JoinGroup, SyncGroup, the leader-broker
  versus group-leader-consumer split.
- Eager (stop-the-world) rebalancing and why it ruined everyone's day.
- Cooperative incremental rebalancing (KIP-429) and how it changes the
  protocol.
- Static membership (KIP-345) and the "I'm just restarting, don't move my
  partitions" optimisation.
- KIP-848: the next-gen protocol that puts the broker in charge of
  assignments.
- The interactions with the Streams DSL (Chapter 14) and exactly-once
  (Chapter 5).

This is one of the most subtle areas of Kafka. By the end you should be
able to predict, given a sequence of joins and leaves, exactly which
partitions move, when, and how long the consumers are blocked.

---

## 11.1 What "group" means, exactly

A consumer group is identified by a string: `group.id`. Two consumer
processes with the same `group.id` are members of the same group. They
will *cooperate* (split partitions among themselves) rather than
*compete* (each reading independently).

```
Topic with 6 partitions, group "my-app" with 3 consumers:
  consumer A: partitions 0, 1
  consumer B: partitions 2, 3
  consumer C: partitions 4, 5

Each partition is read by exactly ONE consumer in the group at a time.
```

The contract:

1. **Each partition is read by exactly one group member.** You cannot have
   two consumers in the same group reading the same partition; the
   protocol prevents it.
2. **Each group member reads ≥ 0 partitions.** A group with more
   consumers than partitions has idle members.
3. **On membership change, partitions get redistributed.** Joining a new
   consumer, killing a consumer, or scaling out triggers a rebalance.

The first contract is what makes consumer groups useful: it's how you
parallelise consumption. The third contract is where the trouble lies.

---

## 11.2 The group coordinator

A group coordinator is a **broker** in the cluster. It is selected by
hashing the group ID:

```
coordinator_partition = abs(hash(group_id)) % num_partitions(__consumer_offsets)
coordinator_broker = leader of __consumer_offsets[coordinator_partition]
```

So `__consumer_offsets` (default 50 partitions) maps groups to brokers
via partition leadership. The broker holding the leader of partition X
of `__consumer_offsets` is the coordinator for any group whose ID hashes
to partition X.

**Coordinator responsibilities:**

1. Track group membership (who is currently a member).
2. Run the rebalance protocol when membership changes.
3. Persist offset commits (writing to its
   `__consumer_offsets` partition).
4. Track member liveness via heartbeats.

If the coordinator broker dies, the new leader of the relevant
`__consumer_offsets` partition becomes the new coordinator. Group state
(membership, offsets) is in `__consumer_offsets`, so the new coordinator
reads the log to reconstruct.

A consumer learns its coordinator by sending `FindCoordinatorRequest`
to any broker. The reply gives the coordinator's broker ID and address.
The consumer then communicates with the coordinator directly for all
group-related operations.

---

## 11.3 The classic rebalance protocol

Pre-KIP-429, here is how a rebalance worked.

### 11.3.1 The roles

- **Coordinator (broker)**: orchestrates the protocol. Decides who is in
  the group. Picks a "leader consumer".
- **Leader consumer (the chosen one)**: computes the partition
  assignment. Sends it to the coordinator.
- **Other consumers**: passively wait for the assignment, accept it,
  start consuming.

The split is unusual. Why is the assignment computation done by a
*consumer* rather than the broker? Because the protocol is designed to
allow custom assignment strategies (range, round-robin, sticky, custom)
without broker code changes. The broker doesn't need to know what
strategy the group is using; it just shuttles bytes between the
consumers.

This was elegant in design but caused operational pain, as we'll see.

### 11.3.2 The two phases

**Phase 1: JoinGroup.**

```
Each consumer C → coordinator: JoinGroupRequest{
    group_id, member_id (or empty if first time),
    session_timeout_ms, rebalance_timeout_ms,
    assignment_strategies = [...]
    metadata = subscription info
}

Coordinator collects all JoinGroup requests for some time
(rebalance_timeout_ms is the upper bound).

Coordinator picks the leader: the first consumer to join the group.

Coordinator → each consumer C: JoinGroupResponse{
    member_id (assigned by broker if first join),
    leader_id (the chosen leader),
    is_leader (boolean),
    members = [list of (member_id, metadata)] (only sent to leader)
}
```

The coordinator has now collected all members; the leader knows about
the others; followers know who the leader is.

**Phase 2: SyncGroup.**

```
The leader consumer computes the assignment (using the configured strategy):
    assignment = assignor.compute(members, partitions)

Leader → coordinator: SyncGroupRequest{
    member_id, generation_id,
    assignments = [(member_id, partitions)]
}

Followers → coordinator: SyncGroupRequest{
    member_id, generation_id,
    assignments = []  (followers send empty; only leader's assignment counts)
}

Coordinator distributes:
Coordinator → each consumer C: SyncGroupResponse{
    assignment = partitions for this consumer
}
```

Each consumer now knows its partitions. They start consuming.

### 11.3.3 The eager (stop-the-world) part

Here is the critical detail: **before the JoinGroupRequest, every
consumer revokes its current partitions.** It calls
`onPartitionsRevoked()`, stops fetching, returns to the rebalance.

So during a rebalance:

```
Consumer A: revoke (1, 2) → idle → wait for SyncGroup → assigned (1, 2) → start
Consumer B: revoke (3, 4) → idle → wait for SyncGroup → assigned (3, 4) → start
Consumer C: revoke (5, 6) → idle → wait for SyncGroup → assigned (5, 6) → start
```

Even consumers whose partitions don't change still revoke and re-acquire
them. This is the **eager rebalance** — every member stops processing,
even if their assignment is unchanged.

For small groups with fast rebalances, this is fine. For large groups
(hundreds of consumers), the rebalance can take **minutes**, during which
no one in the group makes any progress. A team scaling out from 50 to
51 consumers experiences a multi-minute consumption pause. A team
recovering a single dead consumer experiences the same pause.

This was the operational scar of Kafka 0.x and 1.x. Every "Kafka war
story" book contains at least one rebalance horror story.

---

## 11.4 Cooperative incremental rebalancing (KIP-429)

KIP-429 (Kafka 2.4+) re-architected the rebalance protocol to fix this.

The core idea: **don't revoke partitions you'll keep**. Only revoke
partitions that are actually being moved.

### 11.4.1 The two-round protocol

A cooperative rebalance is a two-round affair:

**Round 1 — Identify what changes.**

```
Coordinator collects JoinGroup requests as before.
Leader consumer computes the new assignment as before.
Leader sends new assignment via SyncGroup.

Each consumer compares: my-current-assignment vs my-new-assignment.
- Partitions in current but not new: must be revoked.
- Partitions in new but not current: must be added (but can't until owner releases).

Each consumer revokes only the to-be-revoked partitions (calls
onPartitionsRevoked() with that subset).
Each consumer continues consuming the partitions it's keeping.

If revocation happened: trigger ANOTHER rebalance (round 2) to actually
assign the released partitions.
```

**Round 2 — Assign released partitions.**

```
Same protocol as round 1 but now the released partitions are unassigned
and can be given to their new owners.

After round 2, every consumer that gained partitions calls
onPartitionsAssigned() with the new ones.

No partition is "in flight" — each is owned by exactly one consumer at
each moment.
```

The result: consumers whose assignments don't change *never stop
consuming*. Only consumers gaining or losing partitions experience
disruption, and even they continue serving the partitions they keep.

### 11.4.2 The cost

The rebalance now takes *two* rounds instead of one. So in the rare case
where many partitions move, cooperative rebalancing is *slightly slower*
than eager. But the per-consumer pause is dramatically shorter, because
each consumer only stops on the partitions that are actually moving.

In practice, on large groups, cooperative is 10-20× faster. The
trade-off is hugely in its favour.

### 11.4.3 Enabling

```properties
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

This is **the recommended default** for almost every modern consumer.
Use it.

A subtlety: rolling out cooperative rebalancing across a group requires
all consumers to support it. The migration is documented in KIP-429:
during the transition, you set the assignor list to
`[CooperativeStickyAssignor, RangeAssignor]`, deploy to all consumers,
then on a subsequent rolling restart change to just
`[CooperativeStickyAssignor]`. Each consumer prefers the cooperative
strategy if all members support it.

For new groups, just go straight to `CooperativeStickyAssignor` and
forget the migration story.

---

## 11.5 Static membership (KIP-345)

A different optimisation, useful for a different problem: **a consumer
that restarts shouldn't trigger a rebalance**.

A streaming application with large local state (Streams app with 10 GB
RocksDB stores per task) takes a long time to recover after a rebalance:
the new owner has to download the state from changelog topic, replay,
warm up. If the rebalance was triggered by a routine restart (deploy,
upgrade), the cost is nearly the same as if the consumer had crashed for
real.

Static membership solves this:

```properties
group.instance.id=app-instance-7   # a stable, unique-per-consumer-instance string
```

Each instance has a stable ID. When the instance restarts:

1. New process starts up, sends JoinGroup with the same `group.instance.id`.
2. Coordinator recognises: "this is instance-7, which left briefly. It's
   back. Don't rebalance."
3. Coordinator returns the same assignment to instance-7.
4. Instance-7 resumes consuming the same partitions, with its
   already-warmed-up state.

The grace period is `session.timeout.ms` (default 45000 ms with
KIP-735's bump). If the instance reconnects within that window, no
rebalance. If it doesn't, the coordinator considers it permanently dead
and triggers a rebalance.

This is **the second-most-important consumer config after assignor
choice**. For Kafka Streams: essential.

The combination of cooperative rebalancing + static membership covers
about 95% of the rebalance pain that earlier Kafka versions had. A
group with 200 consumers using both can handle rolling restarts and
single-node failures with sub-second per-consumer pauses.

---

## 11.6 KIP-848: the new consumer rebalance protocol

KIP-848 (Kafka 3.7+, marked GA in 4.0) is a significant redesign. The
key change: **assignment computation moves to the broker.**

### 11.6.1 The motivation

The classic protocol's "leader consumer computes assignment" model has
several problems:

- **The leader is a special role** — picking it, handling its failure,
  ensuring it doesn't go silent during the rebalance. Lots of edge
  cases.
- **Members must agree on the assignor.** A heterogeneous group (some
  with cooperative, some with eager) must negotiate a common strategy.
- **The protocol is stop-the-world by default**, with cooperative
  added as an opt-in. Most groups don't enable it.
- **Restarts trigger rebalances**, and static membership is opt-in too.

KIP-848 simplifies:

- The broker (coordinator) computes the assignment, using a strategy
  that the broker knows.
- Members just heartbeat and report their state; they don't propose
  assignments.
- Cooperative incremental rebalancing is the only mode (no eager).
- The protocol uses single-RPC heartbeats with embedded assignment
  changes — no JoinGroup/SyncGroup roundtrip dance.

### 11.6.2 What it looks like

```
Consumer → coordinator: ConsumerGroupHeartbeatRequest{
    group_id, member_id, member_epoch,
    rebalance_timeout, subscribed_topic_names,
    assignor, server_assignor, ...
}

Coordinator → consumer: ConsumerGroupHeartbeatResponse{
    member_id, member_epoch, heartbeat_interval_ms,
    new_assignment_or_assignment_delta,
    ...
}
```

A single round trip. Frequent (default heartbeat interval still ~3s).
Assignment changes — when they happen — are communicated as deltas in
the response. The consumer applies them, calls `onPartitionsRevoked` /
`onPartitionsAssigned` for the deltas, and acknowledges in the next
heartbeat.

### 11.6.3 The "next generation" claim

KIP-848 also renames the consumer protocol entirely; old consumers using
the classic JoinGroup/SyncGroup protocol still work but are considered
legacy. The next-gen protocol is what new applications should use. As of
2026, library support is mature for Java, less so for some non-Java
clients.

The broker-side configuration:

```properties
group.coordinator.new.enable=true                                # enable new protocol
group.consumer.assignors=uniform,range                           # broker-side assignors
```

For a deep dive, KIP-848 is required reading. It is one of the most
important changes to consumer behaviour in Kafka's history.

---

## 11.7 Heartbeats, sessions, and the three timeouts

A consumer is considered "alive" by the coordinator if it heartbeats.
Three timing knobs interact:

| Config | Default | What it bounds |
|--------|---------|----------------|
| `heartbeat.interval.ms` | 3000 | How often the consumer sends a heartbeat |
| `session.timeout.ms` | 45000 | How long the broker waits without a heartbeat before declaring the consumer dead |
| `max.poll.interval.ms` | 300000 | How long the consumer can go without calling `poll()` before the *consumer* declares itself dead and leaves the group |

The relationships:

- **Heartbeat interval should be ~ 1/3 of session timeout.** Default
  3000 / 45000 ≈ 6.7%; a few missed heartbeats are tolerated before
  declaring dead. Don't set heartbeat too high or sessions get shaky.
- **`session.timeout.ms` can be raised** to tolerate longer
  heartbeat-thread pauses (rare GC, transient network). Default 45000
  is reasonable for most.
- **`max.poll.interval.ms` is independent** of heartbeats. The consumer
  can be heartbeating happily but stuck inside processing of a batch; if
  that processing takes longer than `max.poll.interval.ms`, the
  consumer self-fences (leaves the group voluntarily) on next `poll()`
  attempt. The classic "I forgot to leave the group, now I have a
  zombie" bug.

The way these interact:

1. Consumer's heartbeat thread sends heartbeats every 3s.
2. If the broker stops receiving heartbeats for 45s → consumer dead in
   broker's view; rebalance.
3. If the consumer's processing inside `poll()` exceeds 5 min → consumer
   leaves on next `poll()`; rebalance.

The three are needed because they protect against different failures:
session detects "consumer process hung or network failed", max-poll
detects "consumer process is alive but stuck in a slow processing
function". Neither subsumes the other.

A common production tuning: lower `max.poll.records` (so each `poll()`
batch is small enough to process quickly) rather than raising
`max.poll.interval.ms`. This keeps heartbeats frequent and reduces
latency to detection on real failures.

---

## 11.8 The rebalance callbacks

The consumer client lets you register callbacks for rebalance events:

```java
consumer.subscribe(Arrays.asList("my-topic"), new ConsumerRebalanceListener() {
    @Override
    public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
        // commit current offsets before partitions are reassigned
        consumer.commitSync(currentOffsets(partitions));
    }
    
    @Override
    public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
        // initialize state for newly assigned partitions
    }
    
    @Override
    public void onPartitionsLost(Collection<TopicPartition> partitions) {
        // (cooperative only) — partitions were forcefully taken; 
        // can't commit, just clean up state
    }
});
```

`onPartitionsRevoked` is called BEFORE the partition is taken away — the
consumer still owns it; commits will succeed. **This is the right place
to commit final offsets** if your consumer doesn't otherwise commit
synchronously.

`onPartitionsAssigned` is called AFTER the assignment is finalized.

`onPartitionsLost` (cooperative only) is called when the coordinator has
declared the partitions reassigned without giving the consumer a chance
to commit (e.g., the consumer's session timed out). The consumer can no
longer commit for those partitions — they belong to someone else now.

For Kafka Streams users, these callbacks are managed by the Streams
runtime; you don't write them yourself. For raw consumer users, they're
your responsibility.

---

## 11.9 Common rebalance pathologies

### 11.9.1 Rebalance loop

Symptom: the group rebalances every few seconds, never makes progress.

Causes:

1. `max.poll.interval.ms` is too short for the processing time. Consumer
   self-fences after each batch.
2. `session.timeout.ms` is too short relative to GC pauses. Consumer
   misses heartbeats during GC, gets kicked, rejoins.
3. `heartbeat.interval.ms` is too high. Heartbeats are too sparse to
   tolerate any miss.

Fix:

- Profile processing: how long does `poll()`-batch take?
- Set `max.poll.records` low enough that one batch completes in well
  under `max.poll.interval.ms`.
- Tune session timeout to fit GC behaviour.

### 11.9.2 Slow rebalance

Symptom: a single rebalance takes minutes.

Causes:

1. **Eager assignor** with many partitions. Use cooperative.
2. **No static membership.** Use `group.instance.id`.
3. **Stateful processing** (Streams) with large local state. Reduce
   state, use static membership, use exactly-once-v2 (Streams handles
   this internally).

Fix: cooperative + static membership, almost always.

### 11.9.3 Stuck rebalance

Symptom: rebalance starts but never completes. Group is "in transition"
forever.

Causes:

1. **A consumer didn't send SyncGroup.** Maybe it died between JoinGroup
   and SyncGroup. The coordinator waits for `rebalance.timeout.ms`
   (default 60s) and then proceeds without it.
2. **The leader consumer crashed during assignment computation.**
   Coordinator picks a new leader and re-runs.

Fix: usually self-healing. If persistent, the group ID may be stuck in
an odd state; an admin reset (`kafka-consumer-groups.sh --delete`) might
be needed.

### 11.9.4 Repeated reassignment

Symptom: a partition keeps being revoked and reassigned, never
processing.

Causes: very rare, but I have seen it once: a custom assignor with a
non-deterministic computation (hash with seed = current time) generated
different assignments on each round, causing perpetual reassignment.

Fix: deterministic assignor. Always.

---

## 11.10 The `__consumer_offsets` topic

Mentioned in passing. It deserves a section.

`__consumer_offsets` is created automatically with:

- 50 partitions (default; configurable via `offsets.topic.num.partitions`).
- RF 3 (configurable via `offsets.topic.replication.factor`).
- `cleanup.policy=compact` (it's a state store).
- `min.insync.replicas` matches the cluster default (typically 2).

It stores three things:

1. **Group metadata records.** For each group: members, generation, leader,
   subscription, assignment.
2. **Offset commit records.** For each (group, topic, partition): the
   committed offset and metadata.
3. **Tombstones.** When a group is deleted or a partition's offsets are
   purged, a null-valued record is written. The cleaner thread then
   garbage-collects.

Since it's a normal Kafka topic, you can read it with the regular
consumer API. Sometimes useful for debugging:

```bash
kafka-console-consumer.sh \
    --bootstrap-server localhost:9092 \
    --topic __consumer_offsets \
    --partition 13 \
    --formatter "kafka.coordinator.group.GroupMetadataManager\$OffsetsMessageFormatter"
```

The offsets topic is the ground truth for everything group-related. If
it's corrupted (very rare), you have a serious problem; in extreme
cases, recreating it is possible but groups lose their position.

---

## 11.11 Configurations that matter

```properties
# Identity and assignment
group.id=my-app
group.instance.id=instance-N                   # static membership; STRONGLY RECOMMENDED
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor

# Heartbeats and timeouts
heartbeat.interval.ms=3000                     # heartbeat freq
session.timeout.ms=45000                       # broker tolerance
max.poll.interval.ms=300000                    # consumer self-fence

# Polling
max.poll.records=500                           # tune for processing speed

# (Server-side, broker config)
offsets.topic.num.partitions=50
offsets.topic.replication.factor=3
group.initial.rebalance.delay.ms=3000          # wait for late joiners on first rebalance
group.min.session.timeout.ms=6000              # cluster-enforced minimum
group.max.session.timeout.ms=1800000           # cluster-enforced maximum

# KIP-848 (next-gen)
group.coordinator.new.enable=true              # broker-side; enable new protocol
group.protocol=consumer                         # consumer-side; use new protocol
```

The two settings that matter most:

1. `partition.assignment.strategy=CooperativeStickyAssignor`
2. `group.instance.id=...` (a stable per-instance string)

Set both. Everything else is tuning around the edges.

---

## Summary box

- The **group coordinator** is a broker, picked by `hash(groupId) %
  num_partitions(__consumer_offsets)`. It owns membership and offset
  commits.
- The **classic protocol**: JoinGroup → SyncGroup, with the broker
  picking a "leader consumer" who computes the assignment.
- **Eager rebalancing** (default in older Kafka) is stop-the-world for
  the entire group on any membership change.
- **Cooperative rebalancing** (KIP-429) is two-round but only revokes
  changing partitions; non-affected consumers keep working.
- **Static membership** (KIP-345) avoids rebalances on routine restarts;
  set `group.instance.id` and your assignment survives a session-timeout
  reconnect.
- **KIP-848** moves assignment computation to the broker, simplifying
  the protocol significantly. New default in Kafka 4.0+.
- Three timeouts (`heartbeat.interval.ms`, `session.timeout.ms`,
  `max.poll.interval.ms`) interact; understand them all.
- `__consumer_offsets` is the ground-truth state topic for groups;
  log-compacted; readable with normal consumer API for debugging.

## Further reading

- KIP-62: Allow consumer to send heartbeats from a background thread.
- KIP-345: Reduce multiple consumer rebalances by specifying member id.
- KIP-394: Require member.id for initial JoinGroup request.
- KIP-429: Kafka Consumer Incremental Rebalance Protocol.
- KIP-848: The Next Generation of the Consumer Rebalance Protocol.
- The `org.apache.kafka.clients.consumer.internals.ConsumerCoordinator`
  source. Tractable; the protocol is implemented mostly in this one
  class.

## War story: 200 consumers, three minutes per scale-out

A team I consulted had a Kafka Streams application with 200 instances.
Every time they scaled out — adding 5 more instances, say — the rebalance
took 3 to 4 minutes. During that window: zero throughput. Every
consumer was paused, even the ones whose partitions weren't moving.

The team had set `partition.assignment.strategy` to the default
`RangeAssignor` (eager). They had no `group.instance.id`. They had
been running this way for a year, with operational pain every deploy
window — they had even worked out a process where they would scale out
late at night and just absorb the downtime.

The fix took 30 minutes:

1. Switch assignor to `CooperativeStickyAssignor` (with the migration
   procedure: deploy with `[Cooperative, Range]`, then deploy with just
   `[Cooperative]`).
2. Add `group.instance.id` to each Streams instance, derived from
   pod name (Kubernetes makes this easy).

After deploy: scale-out rebalance time dropped from 3-4 minutes to
about 8 seconds, with each consumer typically pausing for under 2
seconds. Static membership made deploy-induced rebalances disappear
entirely — Streams applications restart without triggering reassignment
at all.

The team's deploy frequency went from "once a week, in a maintenance
window" to "whenever we want, during business hours."

The lesson: **the cooperative-plus-static-membership combination is
transformational** for any consumer group with more than ~30 members.
Most teams don't know about it. The defaults in Kafka 3.x didn't push
people toward it strongly enough. KIP-848 in 4.x makes cooperative the
only mode, but the static membership decision is still per-team.

If you have ten or more consumers in a group, you probably want both.
If you have a hundred or more, you definitely want both. There is no
real downside.
