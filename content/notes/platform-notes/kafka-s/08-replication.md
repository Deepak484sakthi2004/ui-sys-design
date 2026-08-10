# Chapter 8 — Replication
### ISR, HWM, LEO, and the Subtle Art of Truncation

---

The single biggest reason engineers misunderstand Kafka is that they have a
naive model of replication. They picture a leader sending writes to
followers, the followers acknowledging, and a sort of synchronous chain.
This model is roughly the *outcome* of Kafka replication, but it gets every
significant detail wrong. The actual protocol is *follower-pull, not
leader-push*; durability is governed by a *moving* set of in-sync replicas
rather than a fixed quorum; the high watermark is one step behind in
follower view from leader view; and recovery after leader change uses an
extra mechanism (leader epoch) on top of HWM precisely because HWM alone is
not enough.

Most production data loss in Kafka comes from misunderstanding one of these
points. This chapter is about getting them right.

We cover:

- The pull-based replication model and why it was chosen.
- The four offsets that define a partition: LEO, HWM, log start, log end.
- The In-Sync Replica set (ISR), its membership rules, and what shrinking
  means operationally.
- High watermark advancement and the subtle "follower's HWM lags leader's"
  property.
- Leader epoch and KIP-101 — the fix to a long-standing data-loss bug.
- Unclean leader election: when, why, and the cost.
- Rack-awareness and observer replicas.

By the end you should be able to draw the replication state machine and
predict, given a sequence of broker failures, whether data is lost or
preserved.

---

## 8.1 Pull, not push

Most replication protocols are **leader-push**: the leader sends writes
directly to the followers, often piggybacked on the client's write request.
Kafka does not do this. Followers **pull** from the leader on their own
schedule, exactly as if they were ordinary consumers (with one wire-level
flag indicating they are followers).

```
Follower thread (one per leader broker):
    while running:
        FetchRequest{
          replicaId = myBrokerId,    // says "I'm a follower, not a consumer"
          fetchOffset = myLEO,
          maxBytes = ...
        }
        --> send to leader
        <-- FetchResponse{batches, leaderHWM}
        for each batch:
            log.append(batch)
            myLEO = batch.lastOffset + 1
        leaderHWM = response.leaderHWM    // remember, used on truncation
```

Why pull?

**Backpressure for free.** A follower that cannot keep up — slow disk, GC,
network — simply fetches less often. The leader is not blocked; followers
self-regulate. With push, a slow follower would create back-pressure on
the leader, possibly affecting the leader's other duties.

**Naturally batched.** A follower fetches many records per request,
aggregating across batches. With push, the leader's natural granularity is
"per produce", and you'd have to add a buffer-and-flush layer to get
batches. Pull collapses batching and replication into one mechanism.

**Failure semantics are simpler.** Push requires the leader to track
follower delivery state and retry on failure. Pull moves all that
complexity to the follower: it fetches, it fails, it retries. The leader
just answers fetches.

**Recovery is symmetric with consumption.** A follower coming back online
after downtime fetches starting from its own LEO. This is identical to a
consumer resuming after a long pause. The protocol, the code path, the
optimisations — all shared. Push would need a separate "catch-up"
protocol.

The disadvantage: latency. With pull, the time between "leader appends" and
"follower has the byte" is bounded only by `replica.fetch.wait.max.ms` and
the network. In practice, with `replica.fetch.wait.max.ms=500ms` and
sub-millisecond fetches, replication lag in a healthy cluster is sub-10ms.
This is fine for almost everyone.

Some lower-latency replication protocols (Raft, Paxos, chain replication)
are push-based or hybrid. Kafka's choice is a deliberate trade for
simplicity and throughput, and 15 years of production says it was the right
call.

---

## 8.2 The four offsets

A partition has four canonical offsets, each meaningful, each the answer to
a different question.

| Offset | Definition | Per | Question it answers |
|--------|------------|-----|---------------------|
| **LEO** (Log End Offset) | Offset of the next record to be written | Replica | "Where will the next append go?" |
| **HWM** (High Watermark) | Highest offset replicated to all ISR members | Partition | "What's safe for consumers to read?" |
| **Log Start Offset** | Lowest offset still retained on disk | Replica | "How far back can I read?" |
| **Log End Offset** = LEO | Same as above; sometimes called "tail" | Replica | (same as LEO) |

Some additional offsets used in specific contexts:

- **LSO** (Last Stable Offset): in transactional systems, the highest
  offset before any in-flight transaction. Already covered in Chapter 5.
- **LRO** (Last Replicated Offset, sometimes informally): offset of the
  last record received from the leader. For followers, ≤ LEO.

The leader maintains a view of every follower's LEO. It uses this to
compute HWM:

```
HWM = min(LEO of every replica in ISR)
```

When a fetch from follower F arrives with `fetchOffset=N`, the leader
infers F's LEO is N (because F asks for offset N, meaning F has everything
< N). The leader updates its memory of F's LEO and possibly advances HWM.

### A subtlety: HWM is a leader concept; followers learn it lagged

The follower learns the HWM only as a field in the **next** fetch
response. So:

```
Time T0: leader's LEO advances to 1000 (new batch appended).
Time T1: follower fetches, gets the batch.
Time T2: follower's LEO is now 1000.
Time T3: follower fetches again (with fetchOffset=1000).
Time T4: leader processes fetch — sees follower LEO=1000, all ISR ≥ 1000,
         advances HWM to 1000.
Time T5: leader's response includes leaderHWM=1000.
Time T6: follower processes response, learns HWM=1000.
```

So between T0 (write) and T6 (follower knows it's committed), the follower's
view of HWM lags. This matters during failover: if the leader dies between
T4 and T5, the new leader (a former follower) will not know HWM is 1000
until it fetches and learns from the metadata. We will see, in 8.5, that
this gap was the source of the pre-KIP-101 data-loss bug.

---

## 8.3 ISR: in-sync replicas

The **In-Sync Replica set** is a *moving* subset of the assigned replicas.
A replica is in the ISR if:

1. It has sent a `FetchRequest` to the leader within the last
   `replica.lag.time.max.ms` (default 30000 ms).
2. Its LEO is "caught up" to the leader's, defined as: the follower's LEO
   has been >= the leader's LEO at *some point* within
   `replica.lag.time.max.ms`. (The condition is forgiving: a follower
   doesn't need to be perfectly current right now, just to have been
   current recently.)

The leader maintains the ISR. When a follower falls out of either
condition, the leader proposes an ISR shrink to the controller. When a
follower catches up, the leader proposes an expand.

### 8.3.1 Why time-based and not size-based?

Earlier Kafka versions had `replica.lag.max.messages` — a follower more
than N messages behind the leader was kicked out. This was a disaster in
practice: when a producer sent a sudden burst of M messages, every
follower was *temporarily* M messages behind, and they'd all be kicked
from the ISR — even though they were healthy and would catch up in
seconds. The result was thrashing: ISR shrinks, ISR expands, ISR shrinks,
repeatedly, every time traffic spiked.

Time-based lag (`replica.lag.time.max.ms`) ignores burst-induced lag.
What matters is whether the follower is *making progress*: as long as
the follower has fetched something recent enough, it stays in the ISR
even if its LEO is many messages behind. This is much more stable.

### 8.3.2 ISR membership and the controller

The leader proposes ISR changes. The controller commits them.

Why? Because ISR membership has cluster-wide consequences (it determines
which replicas can be elected leader if the current leader dies), and the
controller is the single source of truth for cluster-wide decisions. The
leader cannot just unilaterally decide; the controller has to write the
change to the metadata log.

The protocol (since KIP-497, Kafka 2.7+):

1. Leader notices follower F has fallen behind for >
   `replica.lag.time.max.ms`.
2. Leader sends `AlterPartitionRequest` to the controller, proposing the
   new ISR (without F).
3. Controller validates and commits to the metadata log.
4. Controller responds with the new partition state.
5. Leader updates its local state.

Pre-KIP-497, the leader wrote ISR changes directly to ZooKeeper, which had
race conditions during controller failover. AlterPartition fixed it.

### 8.3.3 The min.insync.replicas guard

`min.insync.replicas` (default 1; should be set to 2 for RF=3 in
production) is the minimum ISR size at which `acks=all` produces will be
*accepted*. If the ISR has shrunk below this threshold, the leader rejects
`acks=all` produces with `NOT_ENOUGH_REPLICAS`.

This is the safety net. Without it, `acks=all` silently degrades to
`acks=1` when the ISR shrinks to 1 (only the leader is in-sync, "all" of
ISR = 1 replica). With it, the producer is forced to confront the
durability gap rather than silently losing it.

A common production configuration:

```
replication.factor = 3
min.insync.replicas = 2
acks = all
```

This means: tolerate one broker failure, fail fast on two.

`min.insync.replicas` can also be set per-topic via the
`min.insync.replicas` topic config. If your application depends on
durability, set it explicitly on the topic — don't rely on the cluster
default.

---

## 8.4 The HWM advance protocol, in detail

Step-by-step, what happens when a producer sends `acks=all` to a topic
with RF=3, ISR={L, F1, F2}:

```
1. Producer P sends ProduceRequest with offset N's worth of records.
2. Leader L appends to its local log. L's LEO advances to N+1 (say).
3. L places the produce in ProducePurgatory, awaiting HWM advance.
4. Independently, F1 and F2 are running their fetch loops:
   F1 sends Fetch(fetchOffset=oldLEO_F1), gets the new bytes, appends.
   F1's LEO advances to N+1. F1's next Fetch will use fetchOffset=N+1.
5. When F1's next Fetch arrives at L, L sees fetchOffset=N+1, infers
   F1's LEO is N+1.
6. Similarly for F2.
7. L now knows: ISR LEOs are L=N+1, F1=N+1, F2=N+1.
8. min(ISR LEOs) = N+1. L advances HWM to N+1.
9. L's HWM-advance triggers ProducePurgatory check; the produce at offset
   N is now ≤ HWM, so it completes.
10. L sends ProduceResponse to P with success.
11. The next FetchResponse from L to F1/F2 carries leaderHWM=N+1; they
    learn the new HWM.
```

Steps 5 and 6 happen approximately concurrently. The timing of HWM advance
is driven by the slower of the two followers — if F1 fetches and acks
quickly but F2 is slow, HWM only advances when F2 has caught up. If F2 is
*too slow*, it gets kicked from the ISR (8.3), and then HWM advance is
governed by min(L, F1) only.

This is the key mechanism by which slow followers degrade producer
latency: even if F2 is 50ms behind, every `acks=all` produce waits 50ms
for F2's fetch to complete the chain. Kicking F2 from the ISR (after the
30-second `replica.lag.time.max.ms`) restores latency, at the cost of
durability margin.

### 8.4.1 What the consumer sees

Consumers (in `read_uncommitted`, the default) read up to **HWM**, not LEO.
A record at offset 1000 is *written* to the leader at time T1 but is not
*visible to consumers* until the HWM advances past 1000, which is some
milliseconds later.

This is why "consumer lag" is bounded below by HWM advancement, even if
the broker is otherwise instantaneous. In a healthy cluster, the gap is
under 10ms; in a sick cluster (slow follower, network issues), it can be
seconds, and consumers will appear to be lagging on a topic where they are
actually keeping up.

---

## 8.5 Leader epoch and the KIP-101 fix

Here is one of the more subtle bugs in distributed systems history.

### 8.5.1 The bug

Setup: RF=3, ISR={A, B, C}. A is leader. Producer sends record R at
offset 1000 with `acks=1` (let's stick with `acks=1` to make the bug
sharper; it also affected `acks=all` in some scenarios).

```
1. A appends R at offset 1000. A's LEO = 1001.
2. A acks the producer (acks=1, just need leader's local append).
3. A's HWM is still 999 — hasn't yet advanced.
4. B and C fetch, get R, append. Their LEOs = 1001.
5. Their *learned* HWM is still 999 (HWM in their last fetch response
   was 999; they don't have the new value yet).
6. A crashes. The controller picks B as new leader.
7. B becomes leader. B knows its LEO = 1001, but its HWM = 999.
8. C is still alive. C's LEO = 1001, HWM = 999.
9. C starts fetching from B (the new leader).
10. C asks: "I have offsets up to 1001. What about offset 1001?"
11. B's HWM is 999. B thinks (wrongly) that anything beyond HWM is
    untrusted — A might have crashed mid-replication. B truncates its own
    log down to HWM=999.
12. B's LEO is now 999. C is told to truncate to 999 too.
13. R is gone. Producer was acked, but R is lost.
```

The bug is at step 11: B doesn't know whether records beyond its HWM are
"committed but not yet announced" or "uncommitted because A died before
replicating fully." It can't distinguish without additional information,
so it conservatively truncates. The conservative choice loses R.

### 8.5.2 The fix: leader epoch

KIP-101 (Kafka 0.11) added the **leader epoch**: a monotonically increasing
integer assigned to each (broker, partition) pair, incremented every time
that broker becomes leader.

Each replica keeps a **leader epoch cache**, persisted in
`leader-epoch-checkpoint`:

```
leader-epoch-checkpoint:
0 0          ← epoch 0 started at offset 0
1 547        ← epoch 1 started at offset 547
2 1023       ← epoch 2 started at offset 1023
```

This says: "during epoch 0, offsets 0-546 were written by the epoch-0
leader. During epoch 1, offsets 547-1022. During epoch 2, offsets 1023+."

Each batch in the log is also tagged with `partitionLeaderEpoch` (we saw
this in Chapter 6's wire format).

Now, when a new leader B takes over:

1. B's leader epoch is incremented; say it was 1, now it's 2.
2. C, becoming a follower of B, sends an `OffsetsForLeaderEpochRequest`:
   "what was the last offset of epoch 1?"
3. B answers from its leader-epoch cache. The end of epoch 1 was, say,
   offset 1023.
4. C looks at its own log. C has offsets up to 1001 (in our example).
   1001 < 1023, so C does not need to truncate — its data is consistent
   with B's view of epoch 1.
5. C resumes fetching from B starting at offset 1001+1 = 1002.

If, hypothetically, C had additional offsets that B did not (because A had
written to C but not B before crashing), the answer would say "epoch 1
ended at, say, 1015" and C would truncate to 1015.

The key point: **the truncation decision uses the leader-epoch endOffset,
not the HWM**. The HWM-based decision was wrong because HWM lags the
follower's LEO by a fetch round trip; the leader-epoch endOffset is
correct because the new leader knows authoritatively when its predecessor's
epoch ended.

### 8.5.3 Why this matters historically

Pre-KIP-101 Kafka (< 0.11) had a known data-loss window in this scenario.
Operators with strong durability requirements were advised to use
`acks=all` *and* `min.insync.replicas=replication.factor` (i.e., require
ALL replicas to be in ISR before acking). This eliminated the bug at the
cost of durability degradation: any one replica falling behind would block
all writes.

KIP-101 made `acks=all` actually safe, allowing `min.insync.replicas` to
be relaxed (typically to RF-1) without data-loss risk.

Old codebases sometimes still have `min.insync.replicas=replication.factor`
left over from this era. It's not wrong, but it's strict — costs you
availability for no extra durability benefit on Kafka 0.11+.

---

## 8.6 Unclean leader election

Sometimes, all members of the ISR die. The remaining replicas (that fell
out of the ISR earlier) might still have *some* data, but their data is
known to be behind — that's why they fell out of the ISR.

Two options:

**Clean leader election (default):** wait for an ISR member to come
back. Until then, the partition is *offline* — no producer can write, no
consumer can advance. Availability is sacrificed; durability is preserved.

**Unclean leader election:** elect a non-ISR replica as the new leader.
That replica's data becomes truth. Any messages between its LEO and the
last committed offset are *permanently lost* — committed messages
(possibly already read by consumers) disappear.

`unclean.leader.election.enable` controls this. Default `false` since
Kafka 0.11. **Should never be true in production unless availability
strictly outweighs durability** — a metrics topic where dropping a few
points is fine, perhaps.

The historical misconfiguration was:

```
acks = 1
min.insync.replicas = 1
unclean.leader.election.enable = true
replication.factor = 3
```

This combination *looks* durable (RF=3!) but actually:

- `acks=1` → ack on leader-only append (no follower ack).
- `min.insync.replicas=1` → no minimum ISR.
- `unclean.leader.election.enable=true` → any replica can become leader.

The result: under bad network conditions, you could lose data and not even
notice. The producer was acked. Consumers had read the data. Then leader
crashed, ISR was empty, an out-of-sync replica was elected, and the data
silently vanished — replaced by whatever stale view the new leader had.

The combination above is the *worst possible* configuration for
durability. The defaults in modern Kafka prevent it. Don't fight the
defaults.

---

## 8.7 Rack-awareness

A common operational requirement: spread the replicas of a partition
across different racks (or, in cloud, availability zones), so a rack
failure doesn't lose all replicas.

`broker.rack` config sets each broker's rack identifier. The controller
uses this when assigning replicas: for a partition with RF=3, replicas are
placed on three brokers in three different racks if possible. KIP-36 added
this for partition creation; KIP-392 extended it to consumer fetch
preferences (a consumer can prefer a same-rack follower for cheaper WAN
reads).

A rack-aware cluster's failure model is roughly:

- Single broker failure: fine, ≤ 1 replica per partition affected.
- Single rack failure: fine, ≤ 1 replica per partition affected (assuming
  RF=3 and 3 racks).
- Two-rack simultaneous failure: 2/3 replicas affected — partition still
  has one survivor, ISR shrinks but doesn't go to 0.
- All-rack failure: catastrophic. RF=3 is overwhelmed.

In practice, with three AZs and RF=3, you survive any single AZ failure
without data loss. This is the production configuration for almost every
serious deployment.

---

## 8.8 Observer replicas (preview)

KIP-392 introduced **fetch from follower** for consumer reads. An advanced
extension (used in some commercial Kafka offerings, less so in the core)
is **observer replicas**: replicas that receive data but are *not* counted
in the ISR for HWM purposes. They serve reads but don't affect producer
acknowledgement timing.

Use case: a remote-region replica for backup/DR, where you want the data
mirrored but don't want it to block the local producer's `acks=all`.

The Apache Kafka core doesn't quite have this as a first-class feature.
MirrorMaker 2 and Cluster Linking (Confluent) approximate it. The next
wave of evolution may add native support.

---

## 8.9 Configurations that matter

```properties
# Cluster defaults (override per-topic if needed)
default.replication.factor=3
min.insync.replicas=2

# Replica behaviour
replica.lag.time.max.ms=30000              # default; rarely tuned
replica.fetch.min.bytes=1                  # follower long-poll
replica.fetch.wait.max.ms=500              # follower long-poll timeout
replica.fetch.max.bytes=1048576            # per-partition fetch cap
replica.socket.timeout.ms=30000            # follower fetch network timeout

# Replication threading
num.replica.fetchers=4                     # threads for follower fetching; raise on busy brokers

# Election
unclean.leader.election.enable=false       # default; KEEP THIS

# AlterPartition (modern ISR protocol)
# (Mostly automatic; tuning rare)
```

**Per-topic overrides** are how production fleets express varying
durability requirements:

```bash
# A critical topic: stricter durability
kafka-configs.sh --alter --entity-type topics --entity-name payments \
  --add-config min.insync.replicas=2,unclean.leader.election.enable=false

# A lossy topic: relaxed
kafka-configs.sh --alter --entity-type topics --entity-name metrics \
  --add-config min.insync.replicas=1,unclean.leader.election.enable=true
```

Use this. The cluster default is what you get with no override; the topic
override is what you actually want.

---

## Summary box

- Replication is **pull-based**: followers fetch from the leader exactly
  like consumers, with a `replicaId` flag.
- **Four offsets**: LEO (per replica), HWM (committed), log start, LSO
  (transactions).
- **ISR** = followers caught up to within `replica.lag.time.max.ms`.
  Time-based, not size-based — bursty traffic doesn't shrink it.
- **HWM** = `min(LEO of ISR)`. Advances on follower fetches; followers
  learn the new HWM in the *next* fetch response (lagged by one round
  trip).
- **Leader epoch** (KIP-101) replaced HWM-based truncation. New leaders
  expose `OffsetsForLeaderEpoch` so followers can truncate correctly even
  when their HWM is stale.
- **`min.insync.replicas`** is the minimum ISR for `acks=all` to succeed.
  The single most important durability knob; should be 2 with RF=3.
- **Unclean leader election** sacrifices committed data for availability;
  keep it `false`.
- **Rack-awareness** (`broker.rack`) spreads replicas across failure
  domains. Production-mandatory in cloud deployments.

## Further reading

- KIP-101: Alter Replication Protocol to use Leader Epoch rather than
  HWM. The fix; reading the proposal teaches the protocol.
- KIP-279: Fix log divergence between leader and follower after fast
  leader fail-over. A subsequent refinement.
- KIP-392: Allow consumers to fetch from closest replica. Cross-rack
  fetch.
- KIP-497: Add inter-broker API to alter ISR. Why ISR changes go through
  the controller in modern Kafka.
- The Kafka source: `core/src/main/scala/kafka/server/ReplicaManager.scala`
  and `Partition.scala`. Also the `ReplicaFetcherThread`.

## War story: the "we have RF=3 so we're safe" cluster

A team had a cluster with `replication.factor=3` everywhere. They
believed (reasonably) that this meant they could lose any one broker
without data loss.

What they didn't notice: their cluster default was
`min.insync.replicas=1` and they had `unclean.leader.election.enable=true`
on a few topics from an earlier "availability project". Their producers
used `acks=1`.

A planned maintenance restarted broker B. While B was down, broker A
became momentarily slow (a separate, unrelated GC issue). B's replicas
on partitions led by A had been fetching slowly already; with A slow, the
ISR for those partitions shrank to {A} only. Then A's network blipped.
The controller, seeing both A and B as struggling, allowed an unclean
leader election to broker C — which had been out of the ISR for an hour
because *someone* had set its `replica.lag.time.max.ms` to 60s instead
of the default 30s, and its LEO was way behind.

About 200,000 records were lost. Producers had been acked. Consumers had
already read most of them. The records were gone.

Recovery was non-trivial: they had to identify which records were lost
(by replaying the producer's logs against what was in the cluster), and
re-produce them. Took two days. Some records — those that had been read
by consumers but not durably stored downstream — were never recovered.

Audit revealed three independent bugs:

1. `min.insync.replicas=1` (cluster default never tightened).
2. `unclean.leader.election.enable=true` left over from a project.
3. `replica.lag.time.max.ms=60000` set on broker C's host (some operator
   had been "tuning" performance years prior).

Each was reasonable in isolation. Together, they took out the durability
guarantee that "RF=3" was supposed to provide.

The lesson: **`replication.factor=3` is not a durability statement on its
own**. It's a *prerequisite*. The full durability statement is
`replication.factor=3 + min.insync.replicas=2 + acks=all +
unclean.leader.election.enable=false + reasonable replica.lag.time.max.ms`.
Verify all five every time you onboard a new topic. Never assume the
defaults are tight enough.

I now keep a "durability checklist" runbook with exactly those five
items. Every new topic gets it run before it goes to production. We
have not lost data since.
