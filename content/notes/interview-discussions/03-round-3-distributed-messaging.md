# Round 3 — Distributed Systems & Messaging

> **The panel:** A principal engineer who has run consensus systems in production and a
> staff engineer from the streaming-platform team. This round assumes the machine is no
> longer one box. The network drops packets, reorders them, and pauses your process for a
> GC right when it mattered. The question stops being "how does it work" and becomes "what
> happens when a node lies, dies, or comes back from the dead with stale state."

Difficulty band: ★★★★. Eight exchanges.

Domains touched: `DIST` `PS` `DB`.

---

### [R3.Q1] "Explain Raft like I have to implement it tonight"  ·  `DIST` · ★★★★☆

**Interviewer:** Raft. Leader election and log replication. Assume I'm going to write it,
so don't hand-wave the safety conditions.

**Candidate:** Raft keeps a replicated log identical across a cluster so the replicated
state machines stay in sync. It decomposes consensus into three subproblems: **leader
election, log replication, and safety.** Time is divided into **terms** — a logical clock,
a monotonically increasing integer; each term has at most one leader.

**Leader election:** every node is Follower, Candidate, or Leader. A follower that hears
nothing from a leader before its randomized **election timeout** (say 150–300 ms) becomes a
Candidate: it increments its term, votes for itself, and sends `RequestVote` RPCs. A node
grants its vote if (a) it hasn't voted this term and (b) the candidate's log is **at least
as up-to-date** as its own (more on that below). A candidate that collects votes from a
**majority** becomes Leader and starts sending heartbeats (`AppendEntries`). The
**randomized** timeout is the trick that prevents split votes — nodes time out at different
moments, so usually one candidate starts first and wins before others wake.

**Log replication:** clients send commands to the leader. The leader appends the command to
its log and sends `AppendEntries` to followers. Once a **majority** have written the entry
to *their* logs, the leader marks it **committed**, applies it to its state machine, and
returns to the client; followers apply it once they learn it's committed. Each entry
carries its term and index.

```
 leader log:  [1:x=1][1:y=2][2:z=3][3:w=4]   term:index:cmd
                 │      │      │      │
 followers replicate; entry committed once a majority have it
```

**Interviewer:** You said "at least as up-to-date." That phrase is doing enormous work.
Spell out the exact safety rule, because it's where naive implementations corrupt data.

**Candidate:** Right — this is the **Log Matching + Leader Completeness** property, and
getting it wrong means a committed entry can be overwritten, which is database corruption.

The **"up-to-date" comparison** in `RequestVote`: a candidate's log is at least as
up-to-date as a voter's if either (a) its **last entry's term is higher**, or (b) the terms
are equal and its **log is at least as long**. Term wins over length. This guarantees the
**Leader Completeness property**: a newly elected leader's log contains *every entry that
was already committed*, because a majority stored each committed entry, the new leader needed
a majority's votes, and those two majorities **must overlap** in at least one node — which
would have refused to vote for a candidate missing that entry. So we can never elect a
leader that's missing committed data.

The second half is the leader's append rule. An entry is **only considered committed once
it's replicated to a majority *in the leader's current term***. The subtle, dangerous part
is **a leader must never commit an entry from a *previous* term by counting replicas
alone** — the famous Figure-8 scenario in the Raft paper. An entry from an old term might be
present on a majority yet still get overwritten by a future leader, so Raft only commits
old-term entries *indirectly*, by committing a new entry from the current term on top of
them (which drags the old ones into committed status safely). If you skip that rule and
commit an old-term entry the moment a majority has it, you can later truncate it — silent
data loss. That single condition is the one most hand-rolled Raft implementations get wrong.

The **Log Matching property** itself: if two logs have an entry with the same index *and*
term, then (a) they store the same command, and (b) all preceding entries are identical.
`AppendEntries` enforces this with a consistency check — it includes the index+term of the
entry *immediately preceding* the new ones, and a follower rejects the append if its log
doesn't match there, forcing the leader to walk backward (decrement `nextIndex`) until they
find agreement, then overwrite the follower's divergent tail. That backward-repair is how a
follower that fell behind or has a stale tail gets reconciled.

**Interviewer:** A leader gets a 5-second GC pause, the cluster elects a new leader, then
the old leader wakes up and tries to commit. What stops corruption?

**Candidate:** **Terms** — the logical clock — are the fence. While the old leader was
paused, a follower timed out, incremented the term (say from 4 to 5), won an election, and
became leader for term 5. Now the old leader wakes up still believing it's leader for
**term 4** and sends `AppendEntries` with `term=4`.

Two things kill its attempt:
1. **Every RPC carries a term, and any node — including followers — rejects an RPC whose
   term is *older* than its own current term.** The followers have moved on to term 5, so
   they reply rejecting the stale leader's `term=4` append and include "current term is 5."
2. **A node that learns of a higher term immediately steps down.** When the old leader sees
   "current term is 5" in that rejection (or in any RPC), the Raft rule is: *if you see a
   term higher than yours, update your term and revert to Follower.* So the zombie leader
   instantly demotes itself.

Crucially, the old leader **never reached a majority** for anything during its confusion —
because a majority of nodes are now at term 5 and reject its term-4 messages, it can't
commit. And it couldn't have committed during the pause either, since it was frozen. So
there's no window where two leaders both commit: the **majority requirement plus
monotonic terms** guarantees at most one leader can *make progress* at a time, even though
two nodes might *believe* they're leader for an instant. This is the precise mechanism that
makes Raft safe under the "process pause" failure that breaks naive lock-based designs —
and it's why a distributed lock needs a **fencing token** (a monotonically increasing
number the resource checks) for exactly the same reason: to reject the zombie that wakes up
thinking it still holds the lock.

──────────
> **[BANK]** Raft = terms (logical clock) + majority quorums. Leader election uses
> randomized timeouts; a voter only grants a vote to a candidate whose log is ≥ up-to-date
> (term first, then length), guaranteeing Leader Completeness via majority overlap. Never
> commit a prior-term entry by replica count alone (Figure 8) — commit it indirectly via a
> current-term entry. A paused→woken leader is fenced by terms: higher term seen ⇒ step
> down; it never held a majority, so no double-commit.
> **[TRAP]** "Majority agrees, so commit it" without the same-term condition — that allows
> committed entries to be overwritten. Also forgetting that the up-to-date check is term-
> then-length, not just length.
> **[GO DEEPER]** [R3.Q2] quorums in Dynamo-style (no leader) · [R5] split-brain & fencing
> tokens · Raft paper Fig 8.

---

### [R3.Q2] "No leader, just quorums — make W + R > N concrete"  ·  `DIST` · ★★★★☆

**Interviewer:** Dynamo-style systems skip the leader and use quorum reads/writes. Explain
`W + R > N` and what it buys you — and where it leaks.

**Candidate:** In a leaderless, replicated store, each key is replicated to **N** nodes. A
write must be acknowledged by **W** of them; a read must gather responses from **R** of
them. The tunable invariant is:

> **W + R > N**  ⇒  the write set and the read set **overlap in at least one node**, so a
> read is guaranteed to see at least one copy of the latest acknowledged write.

That overlap is the whole trick — it's the same majority-intersection logic as Raft, but
generalized and *tunable per-operation*. Concretely with N=3:
- **W=3, R=1:** writes need all replicas (slow, fragile to one node down), reads are fast
  and consistent. "Read-optimized."
- **W=1, R=3:** writes are fast (one ack), reads must check all three. "Write-optimized."
- **W=2, R=2:** the balanced quorum — both tolerate one node down and still overlap
  (2+2 > 3). This is the common default; you can lose any one of three nodes and still read
  and write consistently.

Because R sees *multiple* versions on the overlapping read, the system needs a way to pick
the winner — typically **version vectors / vector clocks** to detect which value is newer
(or concurrent), and **last-write-wins** or application-level merge to resolve. Stale
replicas get repaired via **read repair** (the read coordinator notices a lagging replica
and pushes the fresh value) and background **anti-entropy** (Merkle-tree comparison between
replicas).

**Interviewer:** You said W+R>N "guarantees" the read sees the latest write. That's not
actually true in general. When does it break?

**Candidate:** Correct — it's weaker than it sounds, and a careful engineer flags this.
`W+R>N` guarantees overlap *only under benign conditions*. It leaks in several real cases:

1. **Sloppy quorums + hinted handoff.** When some of the N "home" nodes are down, Dynamo-
   style systems will accept the write on *other, healthy* nodes (a **sloppy quorum**) and
   leave a **hint** to hand the data back to the real home node when it recovers. This keeps
   the system *available* under partition — but the W nodes that acked the write and the R
   nodes a reader later contacts may now be **disjoint sets**, so the overlap guarantee is
   gone. You can write with W=2, the partition heals, and a read with R=2 misses it. Sloppy
   quorums trade the consistency guarantee for availability — they're an AP choice wearing
   quorum clothing.

2. **Concurrent writes.** Two clients writing the same key concurrently both satisfy their
   quorums, producing **two concurrent versions**. `W+R>N` says nothing about *which* wins;
   without vector clocks you get last-write-wins and **silently lose** one update (the
   classic Dynamo shopping-cart problem — LWW drops an item).

3. **Non-overlapping failures / timing.** A write that's acked by W but where one of those
   nodes crashes before durably persisting, combined with a read hitting the *other* nodes,
   can miss it. And `W+R>N` gives you no recency bound — it's not linearizable; a read can
   still see an *older* value if it happens to hit only stale replicas in edge timing.

So the honest statement is: **`W+R>N` gives you quorum overlap and thus a strong
*probability* of reading the latest write, and tunable consistency, but it is not
linearizability** — it doesn't handle concurrent writes (you need version vectors + merge)
and the guarantee evaporates under sloppy quorums. The senior framing: it's a *knob*, not a
theorem you can lean your money on. For actual strong consistency you reach for a
leader-based consensus (Raft/Paxos) or a system like Spanner; for tunable AP with conflict
resolution you reach for quorums + CRDTs/vector clocks and design the app to *merge*.

──────────
> **[BANK]** Leaderless replication: N replicas, W write acks, R read responses. W+R>N ⇒
> read/write sets overlap ⇒ read sees the latest write — *under benign conditions*.
> W=R=2,N=3 is the balanced default. It leaks: sloppy quorums (hinted handoff) break
> overlap for availability; concurrent writes need vector clocks + merge or you lose data
> via LWW. It's tunable consistency, not linearizability.
> **[TRAP]** Treating W+R>N as iron-clad strong consistency. It says nothing about
> concurrent writes and is voided by sloppy quorums.
> **[GO DEEPER]** [R3.Q1] leader-based consensus for true linearizability · [R3.Q8] vector
> clocks · [R5] CAP/PACELC judgment.

---

### [R3.Q3] "You said exactly-once is a lie. Kafka claims it. Reconcile that."  ·  `PS` · ★★★★★

**Interviewer:** In R1 you called exactly-once a myth. Kafka markets "exactly-once
semantics." Either you were wrong or Kafka is. Which?

**Candidate:** Neither — the resolution is the difference between **exactly-once
*delivery*** (impossible) and **exactly-once *processing semantics*** (achievable on top of
at-least-once). Kafka delivers the latter, and it's worth seeing exactly how, because the
machinery is the proof that "it's at-least-once + idempotency underneath."

There are two layers:

**1. The idempotent producer** solves *producer-side duplicates*. Without it, a producer
sends a record, the broker writes it, but the **ack is lost** in the network; the producer
retries, and the broker writes the record **twice**. Kafka fixes this by giving each
producer a **Producer ID (PID)** and tagging every record with a **monotonic sequence
number per partition**. The broker tracks the last sequence number it accepted per
(PID, partition); a retry arrives with a sequence number it has *already seen*, and the
broker **deduplicates it** — silently drops the duplicate but still acks. So the *delivery*
was at-least-once (the producer really did send it twice), but the *effect* on the log is
exactly-once. That's the whole pattern in miniature: at-least-once on the wire, dedup by a
monotonic key at the destination.

**2. Transactions** solve the *consume-process-produce* problem — the real "exactly-once"
use case, e.g. a stream processor that reads from topic A, transforms, and writes to topic
B, and must not double-count if it crashes mid-flight. Kafka makes the **writes to B *and*
the consumer-offset commit on A atomic**: they're wrapped in a transaction coordinated by a
**transaction coordinator** with a two-phase commit to the partitions, marked by
**transaction markers** (commit/abort) in the log. Consumers reading B with
`isolation.level=read_committed` **only see records from committed transactions** — aborted
records are filtered out. So if the processor crashes after writing to B but before
committing, the transaction aborts, those B-records are invisible, and on restart it
reprocesses from the last *committed* offset — net effect: each input message affects the
output exactly once.

**Interviewer:** You glossed "the offset commit and the output write are atomic." Why is
that the linchpin, and what breaks without it?

**Candidate:** Because **the duplicate in a stream processor comes from the gap between
"I produced my output" and "I recorded that I consumed the input."** Those are two separate
writes to two separate places (output topic vs the `__consumer_offsets` topic), and a crash
between them is what causes double processing.

Walk the failure without atomicity:
- Processor reads message at offset 100 from A, computes, **writes the result to B**, then
  **crashes before committing offset 100**.
- On restart, it resumes from the last committed offset (99), **re-reads message 100**,
  recomputes, and **writes the result to B again.** Now B has the output twice — duplicate
  processing. (The mirror-image failure — commit the offset first, then crash before
  writing B — gives you *lost* output instead.)

The transaction makes the **output write and the offset commit one atomic unit**: either
both happen or neither does. So after a crash, you can never be in the "output written but
offset not committed" state — the transaction either committed (output visible *and* offset
advanced) or aborted (output invisible *and* offset not advanced, so you cleanly redo). The
offset commit being *inside* the transaction is the linchpin; it's what ties "I did the
work" to "I won't do it again" into a single fact.

And note what's *still* true underneath: delivery is at-least-once (the processor really
might read message 100 twice), the broker really might receive a record twice. Exactly-once
*semantics* is the **emergent property** of (idempotent dedup by sequence number) + (atomic
output+offset via transactions) + (read_committed isolation hiding aborted work). It is
engineered on top of at-least-once, exactly as I claimed — Kafka didn't repeal the Two
Generals problem, it built idempotency and atomic commit *around* it.

**Interviewer:** Last bit — this only works *inside* Kafka. What about when the output sink
is an external database?

**Candidate:** That's the boundary where Kafka's transaction can't reach, and it's the most
important caveat. Kafka's exactly-once is **closed-world**: the atomicity is between Kafka
topics and Kafka's own offset store, all under one transaction coordinator. The moment your
processor writes to an **external system** — Postgres, S3, a payment API — that write is
**not** part of the Kafka transaction. You're back to the dual-write problem: "write to the
DB" and "commit the Kafka offset" are two separate systems with no shared transaction, and a
crash between them double-processes or loses data.

The two real solutions at that boundary:
1. **Idempotent sink writes.** Make the external write idempotent with an idempotency key —
   e.g. `INSERT ... ON CONFLICT DO NOTHING` keyed by the Kafka (topic, partition, offset),
   or upsert by a business key. Then redelivery is a no-op even though Kafka and the DB
   aren't transactional together. This is the most common production answer.
2. **The transactional outbox + CDC** (the inverse direction): when the DB is the *source*,
   write your business row and an "outbox" event **in the same DB transaction**, then a
   change-data-capture connector (Debezium) reads the outbox and publishes to Kafka — so
   "state changed" and "event emitted" are atomic *in the database*, and Kafka delivery
   downstream is at-least-once + idempotent consumers.

So the complete picture: Kafka gives you genuine exactly-once *semantics* within its own
world, and at every external boundary you re-establish it the same way the network always
demands — **at-least-once delivery plus an idempotency key at the destination.** There is no
escaping that pattern; Kafka just automates it for the all-Kafka case.

──────────
> **[BANK]** Kafka EOS = idempotent producer (PID + per-partition sequence number → broker
> dedups retries) + transactions (atomic output-write *and* offset-commit, surfaced via
> `read_committed`). It's exactly-once *semantics* built on at-least-once delivery +
> idempotency, not exactly-once delivery. It's closed-world: at an external DB boundary you
> need idempotent sink writes or the transactional outbox.
> **[TRAP]** Believing Kafka transactions extend to your database. They don't — the offset/
> output atomicity is Kafka-internal only.
> **[GO DEEPER]** [R1.Q6] the delivery-semantics taxonomy · [R5] exactly-once across pub/sub
> → DB (outbox) in depth.

---

### [R3.Q4] "A Kafka broker dies mid-write. What's the ISR doing?"  ·  `PS` · ★★★★★

**Interviewer:** A partition leader crashes while producers are writing. Walk me through
ISR, high watermark, and what gets lost — precisely.

**Candidate:** A Kafka partition has one **leader** and several **follower** replicas. The
**ISR — In-Sync Replica set** — is the subset of replicas that are **caught up** to the
leader (within `replica.lag.time.max.ms`, ~30 s by default). Only ISR members are eligible
to become leader, and that's the core safety mechanism.

Two watermarks matter:
- **Log End Offset (LEO):** the offset of the next record to be appended — how far each
  replica has written.
- **High Watermark (HW):** the offset up to which **all ISR members have replicated.** It's
  the *minimum* LEO across the ISR. The HW is the **commit point**: only records *below* the
  HW are considered committed and are visible to consumers.

```
 leader LEO = 100  ┐
 follower1 LEO = 100│ ISR
 follower2 LEO =  95┘   → HW = 95 (min of ISR LEOs)
 consumers can read up to offset 95; 96–99 are written on the leader
 but NOT yet committed (not replicated to all ISR) → invisible
```

When the leader crashes, the controller elects a new leader **from the ISR** — a replica
guaranteed to have *every committed record* (everything up to the old HW), because by
definition the HW is the offset all ISR members reached. So **committed data (≤ HW)
survives.** What can be lost: records **between the HW and the leader's LEO** (offsets
96–99 above) — they were written on the leader but **not yet replicated to the full ISR**,
so they were never committed, never acked to a producer that required full acks, and never
visible to consumers. They vanish with the dead leader. That's correct and expected: Kafka
only promises durability for *committed* (≤ HW) records.

**Interviewer:** That assumes `acks=all`. Tie `acks` and `min.insync.replicas` together —
what's the actual durability contract, and where do people footgun it?

**Candidate:** Durability is the product of **three settings**, and getting any one wrong
silently weakens it:

- **`acks` (producer):** how many replicas must acknowledge before the producer considers
  the write successful. `acks=0` (fire-and-forget, can lose freely), `acks=1` (leader only —
  acked once the *leader* writes, but if the leader dies before a follower replicates, that
  record is lost even though the producer got an ack — **the classic data-loss footgun**),
  `acks=all`/`-1` (the leader waits until the **full ISR** has the record before acking).
- **`min.insync.replicas` (broker/topic):** the *minimum* ISR size for which `acks=all`
  writes are accepted. If the ISR shrinks below this (too many followers fell behind/died),
  the broker **rejects writes** with `NotEnoughReplicas` rather than accept a write that
  isn't durably replicated.

The robust contract is **`acks=all` + `replication.factor=3` + `min.insync.replicas=2`**:
a write is acked only when at least 2 replicas have it, so you can lose **any one** broker
with zero data loss, and if a second goes down the partition **stops accepting writes**
(chooses consistency/durability over availability) instead of silently risking loss. The
footguns: (a) `acks=all` with `min.insync.replicas=1` — sounds safe but "all ISR" can be
just the leader if everyone else lagged out, so you're effectively back to `acks=1`; (b)
`replication.factor=2` with `min.insync.replicas=2` — now you *can't tolerate any* broker
loss, because losing one drops the ISR below the minimum and writes halt. The magic
combination is RF=3, min.isr=2: tolerate one failure transparently, refuse to lose data on
the second.

**Interviewer:** Now the dangerous one. The last in-sync replica dies and only a stale,
out-of-sync replica is left. Do you elect it?

**Candidate:** That's the **unclean leader election** decision, and it's a naked
**availability-vs-durability** choice — CAP made concrete in a config flag.

- **`unclean.leader.election.enable=false`** (the safe default): if no ISR member is
  available, the partition goes **offline** — no leader, no reads, no writes — and *waits*
  for an ISR member to come back. You **preserve consistency/durability** (you never elect a
  replica that's missing committed data) at the cost of **availability** (the partition is
  down, possibly for a while). This is the **CP** choice.
- **`unclean.leader.election.enable=true`:** elect the stale out-of-sync replica as leader
  so the partition keeps serving. You **regain availability**, but that replica is **missing
  committed records** the old leader had, so you **lose data** *and*, worse, you **truncate
  the log** — consumers that already read offsets the new leader doesn't have now see the
  log "rewind," and the same offset may later hold a *different* record. This is the **AP**
  choice, and the data loss is not theoretical — it's guaranteed if the replica was behind.

The principled answer: keep it **false** for anything where correctness matters (orders,
payments, the source of truth), and only consider **true** for data where availability
trumps a gap — high-volume metrics or logs where a hole is acceptable and being down is
worse. The fact that this is *one boolean* is the whole lesson of the round: in a
distributed system the deepest tradeoffs — consistency vs availability, the exact moment you
choose to lose data — often come down to a single flag whose default you'd better understand
before production teaches it to you.

──────────
> **[BANK]** ISR = replicas caught up to the leader; only ISR can be elected. HW = min LEO
> across ISR = commit point; only ≤HW is visible/durable. Leader death loses only the
> uncommitted (HW→LEO) tail. Durability = `acks=all` + RF=3 + `min.insync.replicas=2`
> (survive 1 loss, halt on 2). Unclean leader election = elect a stale replica → availability
> but guaranteed data loss + log truncation; keep it `false` for sources of truth.
> **[TRAP]** `acks=1` thinking it's durable; `acks=all` with `min.insync.replicas=1`
> (collapses to leader-only); RF=2 with min.isr=2 (zero fault tolerance).
> **[GO DEEPER]** [R3.Q1] the same majority/quorum logic in Raft · [R3.Q5] rebalance · [R5]
> split-brain.

---

### [R3.Q5] "Add a consumer to a group at peak traffic. What just happened to everyone?"  ·  `PS` · ★★★★☆

**Interviewer:** A consumer group is happily processing. You add one consumer during peak.
Describe what happens to throughput, and why ops teams fear this.

**Candidate:** Adding (or removing, or crashing) a consumer triggers a **rebalance** — the
group re-divides the partitions among its current members. Under the classic **eager
rebalancing** protocol, the fear is justified, because eager rebalance does a
**stop-the-world**:

1. The new consumer joins; the **group coordinator** (a broker) detects the membership
   change and triggers a rebalance.
2. **Every** consumer in the group **revokes *all* its partitions** — the entire group
   stops consuming. This is the "stop-the-world": even partitions that aren't changing hands
   get dropped and reassigned.
3. The coordinator runs the **assignment strategy** (range, round-robin, sticky) to map
   partitions to members, and everyone resumes with their new assignment.

During steps 2–3, the **whole group's throughput goes to zero** for the rebalance duration
— which can be seconds, and cascades: if processing involves heavy per-partition state
(caches, DB connections) it must be torn down and rebuilt. At peak traffic that's a latency
spike and a consumer-lag spike across *all* partitions, not just the ones being moved.
Worse, a flapping consumer (one that keeps timing out and rejoining) can cause **continuous
rebalancing** — the group spends more time rebalancing than working, a death spiral ops
teams genuinely fear.

**Interviewer:** So how do modern Kafka clients make this not catastrophic?

**Candidate:** Two big improvements, both about *not* stopping the whole world:

1. **Cooperative (incremental) rebalancing** (`CooperativeStickyAssignor`, the modern
   default). Instead of revoking everything, it does the reassignment **incrementally**:
   only the partitions that actually need to *move* are revoked, in a two-phase rebalance.
   Consumers keep processing the partitions they're retaining throughout — so adding one
   consumer to a 100-partition group only pauses the handful of partitions being handed to
   the newcomer, not all 100. Throughput barely dips. The "sticky" part also means partitions
   tend to stay with the same consumer across rebalances, preserving local state.

2. **Static membership** (`group.instance.id`). Normally, when a consumer briefly
   disconnects (a rolling deploy, a GC pause, a pod restart), the coordinator treats it as
   "left" and rebalances — then rebalances *again* when it returns. Static membership gives
   each consumer a stable identity, so a **transient** disconnect within the
   `session.timeout.ms` window does **not** trigger a rebalance — the consumer reclaims its
   *same* partitions when it returns. This kills the rolling-deploy rebalance storm, where
   restarting 10 pods one by one would otherwise cause 20 rebalances.

The operational tuning that goes with it: size `session.timeout.ms` and `heartbeat.
interval.ms` so a normal GC pause or a slow poll doesn't get you evicted, and keep
`max.poll.interval.ms` larger than your worst-case processing time per batch so a slow
batch doesn't look like a dead consumer and kick off a rebalance mid-work. The senior
summary: **a rebalance is a coordination event, and the goal of every modern setting is to
make rebalances rarer and cheaper — incremental instead of stop-the-world, and immune to
transient blips.** Knowing that adding a consumer used to halt the entire group (and still
does under the old assignors) is what makes "just scale out the consumers" a decision you
make carefully during peak, not casually.

──────────
> **[BANK]** Membership change → rebalance. Eager = stop-the-world: every consumer revokes
> *all* partitions, group throughput → 0 until reassigned (flapping → death spiral).
> Cooperative/incremental rebalancing moves only the partitions that change hands; static
> membership (`group.instance.id`) suppresses rebalances on transient disconnects (rolling
> deploys, GC). Tune session/heartbeat/max.poll so blips don't look like death.
> **[TRAP]** "Just add consumers to scale" with no awareness that eager rebalance pauses the
> *whole* group, or that >partitions consumers sit idle (parallelism caps at partition count).
> **[GO DEEPER]** [R3.Q4] ISR/leader the partitions live on · [R4] designing the consuming
> pipeline with backpressure.

---

### [R3.Q6] "A Kafka topic that keeps only the latest value per key — how, and what's a tombstone?"  ·  `PS` · ★★★★☆

**Interviewer:** You want a Kafka topic to behave like a changelog — only the latest value
per key is retained forever. How does compaction work, and what's the gotcha with deletes?

**Candidate:** That's **log compaction** (`cleanup.policy=compact`), as opposed to the
default time/size **retention** (`cleanup.policy=delete`, which drops whole old segments
regardless of key). Compaction guarantees that for each **key**, the log retains *at least*
the **most recent value**, while garbage-collecting older values for the same key. So the
topic becomes a **materialized snapshot of the latest state per key**, plus a tail of
recent changes — exactly a changelog / KTable, which is how Kafka Streams stores state and
how `__consumer_offsets` works.

Mechanically, a background **log cleaner** thread scans a partition's segments and builds an
**offset map** of key → latest offset, then rewrites the segments **dropping any record
whose key appears at a later offset**. Records are removed *out of the middle* of the log,
so offsets become non-contiguous (there are gaps) — but **relative order is preserved**, and
the latest record for every key is always kept. The "head" of the log (recent, not yet
compacted) still has every record; only the compacted "tail" is deduplicated.

```
 before:  k1=A  k2=X  k1=B  k3=P  k1=C  k2=Y
 after :              k3=P  k1=C  k2=Y      (only latest per key survives)
```

**Interviewer:** Now the gotcha. How do you *delete* a key from a compacted topic, and why
do people leak deleted keys forever?

**Candidate:** You delete a key by appending a **tombstone** — a record with that **key and
a `null` value.** The log cleaner treats a null-value record specially: it signals "this key
is deleted," so during compaction the tombstone causes **all prior values for that key to be
removed**, and consumers reading the changelog see the null and know to drop the key from
their materialized view. So a delete in a compacted topic isn't a removal — it's *appending a
null marker* that compaction later honours.

The gotcha — and where people leak — is that **the tombstone itself must linger long enough
for every consumer to see it before it's removed.** If compaction deleted the tombstone
immediately, a consumer that was offline or slow might **never observe the delete** and would
keep the stale key in its local state forever — the delete would be lost to anyone who wasn't
watching at that instant. So Kafka keeps tombstones around for a grace period,
**`delete.retention.ms`** (default 24 hours), measured from when the segment is compacted,
*before* purging them. The failure modes:
- **Too short** `delete.retention.ms`: a consumer down for longer than the window comes back,
  the tombstone is already gone, and it **resurrects a deleted key** — a "zombie record" in
  its state store.
- **Forgetting tombstones entirely**: if your producer "deletes" by writing an empty string
  or a sentinel object instead of a genuine `null`, compaction never removes the old values,
  the key never actually leaves the topic, and your changelog grows unbounded with logically-
  deleted data — a slow storage leak and a correctness bug, because downstream sees a "value"
  where there should be nothing.

So the complete mental model: **compaction = keep latest per key; delete = a null-value
tombstone; and the tombstone needs its own retention window so slow consumers don't miss the
delete.** It's a beautiful little distributed-systems lesson in one feature: even "delete"
becomes an *append* in a log-structured world, and you have to reason about how long a
"this is gone" fact must survive so that everyone eventually learns it.

──────────
> **[BANK]** `cleanup.policy=compact` keeps ≥ the latest value per key (a changelog/KTable);
> the log cleaner rewrites segments dropping superseded keys (offsets get gaps, order kept).
> Delete = append a **tombstone** (key + `null` value). Tombstones must persist
> `delete.retention.ms` (default 24h) so slow/offline consumers see the delete — too short →
> resurrected zombie keys; using a sentinel instead of real null → unbounded leak.
> **[TRAP]** Thinking compaction = time-based retention, or "deleting" with an empty value
> instead of a real null tombstone (the key never leaves).
> **[GO DEEPER]** [R3.Q3] `__consumer_offsets` is a compacted topic · Kafka Streams state
> stores · [R3.Q5] changelog-backed local state across rebalances.

---

### [R3.Q7] "Two services, one business operation, no shared database. How do you not corrupt money?"  ·  `DB`·`DIST` · ★★★★★

**Interviewer:** Order service and payment service, separate databases. An order must
charge the card *and* create the order, atomically-ish. You can't use a single DB
transaction. Options?

**Candidate:** This is the **distributed transaction** problem, and there are two families
of answer — one that tries to preserve atomicity across services (**2PC**) and one that
gives it up for something weaker but more available (**sagas**).

**Two-Phase Commit (2PC):** a coordinator drives all participants through two phases.
*Phase 1 (prepare):* coordinator asks every participant "can you commit?" — each does the
work, takes locks, writes to a durable log, and replies "yes, prepared" or "no." *Phase 2
(commit/abort):* if all said yes, coordinator tells everyone "commit"; if any said no,
"abort." It gives you genuine atomicity — all commit or all abort.

The reasons I'd avoid 2PC for an order/payment flow:
1. **It's a blocking protocol with a single point of failure.** Between phase 1 and phase 2,
   participants hold **locks** and sit in an uncertain "prepared" state. If the
   **coordinator crashes after participants prepared but before deciding**, those
   participants are **stuck holding locks indefinitely** — they can't unilaterally commit
   (someone else might have voted no) or abort (the coordinator might have decided commit).
   This is the famous 2PC blocking problem. Locks held across network round-trips and across
   *services* destroy throughput and availability.
2. **It couples availability.** The transaction can only commit if *every* participant is up
   at commit time. Two services with 99.9% uptime, joined by 2PC, are *less* available than
   either alone.

So for a long-lived, cross-service business operation, the modern answer is usually a
**saga**.

**Interviewer:** Define the saga precisely, and tell me what you give up versus 2PC.

**Candidate:** A **saga** is a sequence of **local transactions**, one per service, where
each step commits *independently* in its own database, and **every step has a compensating
transaction** that semantically undoes it. There's no global lock and no global atomic
commit. If step 3 fails, you run the **compensations** for steps 2 and 1 in reverse to walk
the system back to a consistent state.

For the order flow:
```
 forward:   reserve inventory → charge card → create order → confirm
 if "create order" fails:
 compensate: refund card  ←  release inventory      (reverse order)
```

Two ways to coordinate it:
- **Choreography:** each service emits an event, the next reacts (reserve→emits→payment
  reacts→emits→…). Decentralized, no coordinator, but the flow is implicit and hard to
  follow across many services.
- **Orchestration:** a central saga orchestrator explicitly drives the steps and invokes
  compensations on failure. Easier to reason about, monitor, and modify; the orchestrator is
  a (replicated) component, not a 2PC-style lock holder.

What you **give up** versus 2PC is **isolation and atomicity**. A saga is **not atomic** —
there are intermediate states visible to the outside world: between "charge card" and
"create order," the customer *has been charged but has no order yet*. And it's **not
isolated** — another transaction can observe those intermediate states (the dirty-read
problem), so you can hit anomalies 2PC would prevent. You manage this with **semantic
locks** (e.g. mark the order PENDING so nothing else acts on it), **commutative updates**,
and designing compensations to be **idempotent and always-eventually-succeed** (a refund
must not itself fail permanently). What you gain is **availability and decoupling**: each
service commits locally, holds no cross-service locks, and the system makes progress even if
a downstream service is briefly down (the saga retries/queues).

The two crucial properties every saga step needs: **idempotency** (steps and compensations
will be retried after failures — charging twice or refunding twice must be safe, via
idempotency keys) and **compensations that can't hard-fail** (you can't "un-charge" if the
refund API is down forever, so compensations target systems you control or retry until they
succeed). And the honest caveat: some things **can't be compensated** — you can refund money
but you can't un-send an email or un-ship a package, so you sequence irreversible steps
*last*, after everything reversible has committed.

The senior framing: **2PC buys atomicity with locks and a fragile coordinator; sagas buy
availability by replacing atomicity with eventual consistency + compensations.** For
money-across-services, the industry overwhelmingly chose sagas (+ idempotency + the outbox
pattern for reliable event emission), accepting "eventually consistent with visible
intermediate states, carefully compensated" over "atomic but blocking and coupled." You pick
sagas and then *engineer around* the lost isolation, rather than pretending the distributed
operation can be as clean as a single-DB `BEGIN…COMMIT`.

──────────
> **[BANK]** Cross-service atomicity: 2PC (coordinator + prepare/commit) gives true
> atomicity but blocks holding locks and wedges if the coordinator dies mid-protocol — a
> single point of failure that *lowers* availability. Saga = sequence of local txns each
> with a compensating txn; no global lock, available and decoupled, but **not atomic / not
> isolated** (intermediate states visible). Needs idempotent steps + non-failing
> compensations; sequence irreversible steps last.
> **[TRAP]** Reaching for 2PC/XA across microservices (blocking, coupled), or claiming a
> saga is atomic — it's eventually consistent with visible intermediate states.
> **[GO DEEPER]** [R3.Q3] the outbox pattern for reliable event emission · [R5] exactly-once
> across pub/sub→DB · [R2.Q6] single-node isolation it's replacing.

---

### [R3.Q8] "No global clock. How do you know event A happened before event B?"  ·  `DIST` · ★★★★☆

**Interviewer:** Across machines there's no trustworthy shared wall clock. So how does a
distributed system establish that one event happened before another?

**Candidate:** You **stop relying on physical time** and use **logical clocks**, because
physical clocks across machines are untrustworthy for ordering — they drift, they're skewed
by NTP, and they can even **jump backward** (a leap second or an NTP correction), so
comparing two machines' timestamps to order their events is fundamentally unsafe. The
foundational idea is Lamport's **happens-before** relation (→):

- If A and B are in the **same process** and A comes first, then A → B.
- If A is a **send** and B is the matching **receive**, then A → B.
- It's **transitive**: A → B and B → C ⇒ A → C.
- If neither A → B nor B → A, the events are **concurrent** — and that's a real, first-class
  outcome, not an error. Concurrency means "no causal relationship," and the system must be
  able to *represent* that, not force a false order.

**Lamport timestamps** implement a piece of this: each process keeps a counter, increments
it on every event, and stamps outgoing messages with it; on receive, a process sets its
counter to `max(local, received) + 1`. This guarantees **A → B ⇒ L(A) < L(B)** — if A
causally precedes B, A's timestamp is smaller. It gives a consistent **total order** (break
ties by process id) that *respects* causality, which is enough for things like a totally-
ordered log.

**Interviewer:** Lamport timestamps have a hole. `L(A) < L(B)` doesn't tell you A actually
caused B. Why does that matter, and what fixes it?

**Candidate:** Right — the implication only runs **one way**: A → B ⇒ L(A) < L(B), but
**not** the converse. `L(A) < L(B)` does **not** imply A → B; A and B might be **concurrent**
and just happen to have ordered counters. So a Lamport timestamp can tell you a *possible*
order but **cannot detect concurrency** — it can't distinguish "A caused B" from "A and B
were independent." That matters enormously for **conflict detection**: if two replicas
independently update the same key, you need to know those writes were *concurrent* (a real
conflict needing resolution/merge) versus one *causally following* the other (the later one
simply wins). Lamport timestamps would falsely impose an order and you'd **silently drop a
concurrent update** — the Dynamo lost-update problem again.

The fix is **vector clocks.** Instead of one counter, each process keeps a **vector** of
counters, one entry per process. A process increments *its own* entry on each event; on
receiving a message it takes the **element-wise max** of its vector and the message's, then
increments its own entry. Now you can compare two vectors precisely:
- V(A) < V(B) **element-wise** (every entry ≤, at least one <) ⇒ **A → B** (genuine
  causality, both directions hold now).
- Neither dominates the other (each has some entry larger) ⇒ **A and B are concurrent** —
  a true conflict.

```
 A = [2,1,0]   B = [2,3,0]   → A < B elementwise ⇒ A happened-before B
 A = [2,1,0]   B = [1,2,0]   → neither dominates ⇒ concurrent (conflict!)
```

So vector clocks **detect concurrency**, which Lamport clocks can't — that's why Dynamo-
style stores use version vectors to flag concurrent writes and surface them for merge (or
LWW) instead of silently ordering them. The cost is **size**: a vector clock grows with the
number of participating nodes (O(N) per value), which is why systems prune them, use
**dotted version vectors**, or in practice bound the actors.

For completeness, the production middle-ground is **hybrid logical clocks (HLC)** — used by
CockroachDB and others — which combine a physical timestamp (so the values are
human-meaningful and roughly track wall time for things like TTLs and debugging) with a
logical counter (so causality is still respected even when physical clocks are skewed or
jump). And Google **Spanner** takes the opposite, expensive route: it makes physical time
*trustworthy* with atomic clocks + GPS (**TrueTime**) and a deliberate **commit wait** —
it waits out the clock uncertainty interval ε before committing, so timestamps are globally
meaningful and it can offer external consistency. Most of us can't afford atomic clocks, so
we use logical/vector/hybrid clocks instead.

The unifying lesson: **"happened-before" is about causality, not the wall clock.** Wall
clocks lie; logical clocks encode the *causal* structure the system actually needs — and
the choice between Lamport (cheap, total order, no concurrency detection) and vector
(detects concurrency, costs O(N)) is exactly the choice between "I just need an order" and
"I need to know when two things genuinely conflict."

──────────
> **[BANK]** No trustworthy shared wall clock (drift, skew, backward jumps) → use logical
> clocks. Lamport: counter, `max+1` on receive; A→B ⇒ L(A)<L(B) but **not** converse —
> can't detect concurrency. Vector clocks: per-node counter vector, element-wise compare →
> detect causality *and* concurrency (true conflicts), at O(N) size. HLC = physical+logical
> hybrid (CockroachDB); Spanner buys real time with TrueTime + commit-wait.
> **[TRAP]** Ordering distributed events by wall-clock timestamp, or using Lamport
> timestamps for conflict detection (they can't tell concurrent from causal → silent lost
> updates).
> **[GO DEEPER]** [R3.Q2] vector clocks resolving quorum conflicts · [R2.Q9] happens-before
> *within* one machine (the JMM) · [R5] split-brain reconciliation.

---

## Round 3 — closing note from the panel

The spine of this round: **once there's more than one machine, every guarantee you took for
granted becomes a negotiation with failure.** Atomicity becomes 2PC's blocking dilemma or a
saga's compensations. "Latest write" becomes a quorum overlap that sloppy quorums quietly
void. "Exactly once" becomes idempotency bolted onto at-least-once. Even *time* — the most
basic shared fact — dissolves into logical clocks. The candidate who shines doesn't recite
the algorithms; they keep returning to the **failure that motivates** each one: the paused
leader, the lost ack, the disjoint read/write sets, the concurrent write, the coordinator
that died mid-commit. Master the failure and the algorithm is obvious.

Proceed to [Round 4 — Design & AI infra](./04-round-4-design-ai-infra.md), where you stop
explaining mechanisms and start composing them into a system under a latency and cost budget.
