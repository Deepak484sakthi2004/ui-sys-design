# Interview 02 — Distributed SQL Vendor (NewSQL)

> **The company:** Builds a distributed SQL database — Spanner/CockroachDB/TiDB class — that
> promises **SQL + ACID transactions at horizontal scale**, the thing CAP supposedly forbids.
> **The role:** Storage & replication engineer on the core engine. **The panel:** A database
> internals engineer who has read the Spanner and Calvin papers and will catch you if you
> wave at "it just shards." 
>
> **What they're testing:** Do you understand how the guarantees of a single-node DB
> (transactions, isolation, ordering) are *rebuilt* on top of unreliable machines — and what
> they actually cost? Domains: `DB` `DIST`. Pairs with loop [R2](../02-round-2-internals.md)
> and [R3](../03-round-3-distributed-messaging.md).

7 exchanges. ★★★★ — ★★★★★.

---

### [I02.Q1] "I have a SQL table too big for one machine. How do you split it and still run `WHERE id BETWEEN 100 AND 200`?"  ·  ★★★★★

**Interviewer:** A table won't fit on one node. Partition it. But I still want range scans and
`ORDER BY` to work. How do you shard, and why not just hash the key?

**Candidate:** The tension is **range queries vs even load**, and it dictates the choice.

- **Hash sharding** (hash the key → bucket) gives **perfectly even distribution** and no
  hotspots, but **destroys range scans**: adjacent keys land on different nodes, so
  `BETWEEN 100 AND 200` becomes a scatter-gather across *every* shard, and `ORDER BY` needs a
  global merge. Great for point lookups, terrible for the ranges you asked about.
- **Range sharding** (contiguous key ranges per shard — "range 100–200 lives here") keeps
  **range scans local and ordered** — a `BETWEEN` hits one or a few adjacent shards, and the
  data is already sorted. This is what Spanner/CockroachDB do, because SQL workloads live on
  ranges and ordering.

The catch with range sharding is **hotspots**: if the key is monotonic (a timestamp,
`AUTO_INCREMENT`), *all* new writes hit the **last range** — the same right-edge problem as
the B+tree (loop [R2.Q4]), now at the cluster level: one node takes all the write load while
the others idle. So the design is **range sharding + automatic splitting + rebalancing**:

1. Data is divided into **ranges** (CockroachDB calls them ranges, ~512MB; Spanner: splits/
   tablets). Each range is a contiguous key span.
2. When a range gets **too big or too hot**, the system **splits** it in two and **rebalances**
   one half to a less-loaded node. So a hot monotonic tail keeps splitting and spreading.
3. A **meta/range index** (itself a small range) maps key→range→node, so a query router finds
   the right node(s). Spanner keeps this in a directory; Cockroach in a meta range.

**Interviewer:** So a monotonic insert key still hammers one range until it splits. How do you
avoid the hotspot *without* hashing away your ranges?

**Candidate:** A few standard moves, trading off how much range-locality you keep:
- **Load-based splitting that's proactive** — split a hot range *before* it melts down, based
  on QPS/CPU per range, not just size, and move the new half away. This spreads the monotonic
  tail across nodes continuously. It's reactive but automatic.
- **Hash-prefixed / hash-sharded indexes** for the specific hot table — prepend a small hash
  bucket (say 0–15) to the key so monotonic inserts fan across 16 ranges instead of one, while
  *within* a bucket you keep ordering. CockroachDB exposes this as `hash-sharded indexes`. You
  trade a 16-way scatter on range scans (bounded, cheap) for 16× the write parallelism — a good
  deal when the hotspot would otherwise serialize all writes.
- **Choose a better shard key** — composite keys that lead with something well-distributed
  (e.g. `(tenant_id, timestamp)`) so different tenants spread naturally while each tenant's data
  stays range-local for *their* queries. Most multi-tenant SQL gets this for free.

The framing: **range sharding is the default for SQL because SQL is ordered and range-heavy,
and the hotspot problem is solved by automatic splitting/rebalancing plus optional hash-
prefixing for pathological monotonic keys — you reach for hashing *surgically*, on the hot
index, not globally where it would kill every range scan.** Picking hash globally because
you're afraid of hotspots is the junior overcorrection; it throws away the very thing SQL
needs.

──────────
> **[BANK]** Shard SQL by **range** (contiguous key spans), not hash — keeps range scans/
> `ORDER BY` local and ordered (hashing scatters them). Hotspot from monotonic keys (cluster-
> level right-edge problem) → **automatic load-based splitting + rebalancing**, and
> surgically **hash-prefix the hot index** (e.g. 16 buckets) to fan writes while keeping
> within-bucket order. A meta range maps key→range→node.
> **[TRAP]** Hash-sharding everything to dodge hotspots — kills range scans and ordering, the
> whole point of SQL. Or ignoring that monotonic keys serialize all writes onto one range.
> **[GO DEEPER]** loop [R2.Q4] the single-node right-edge/UUIDv7 version · [I02.Q3] consensus
> per range · [I02.Q5] distributed joins over these shards.

---

### [I02.Q2] "Single-node transactions use MVCC and a WAL. Now make a transaction span three machines."  ·  ★★★★★

**Interviewer:** On one node you do MVCC + 2PC-free local commit. Now a transaction writes
rows on three different shards. Give me ACID across them, and I know you know 2PC blocks —
so don't stop there.

**Candidate:** Distributed ACID = **2PC for atomicity across shards + MVCC for isolation +
a consensus-replicated commit so 2PC's coordinator isn't a single point of failure** — that
last part is the trick that makes modern NewSQL not suffer classic 2PC's fragility (loop
[R3.Q7]).

The layers:
1. **Each shard is itself replicated by consensus** (Raft, [I02.Q3]) — so "the shard committed"
   means "a majority of the shard's replicas durably logged it." A shard doesn't lose data when
   a node dies.
2. **A transaction touching shards A, B, C uses 2PC across them**, but every participant's
   prepare/commit decision is **itself written through Raft** to that shard's replicas. This
   kills 2PC's worst failure (loop [R3.Q7]): the classic blocking problem is "coordinator dies
   after prepare, participants stuck holding locks forever." Here, the **coordinator's state is
   also Raft-replicated**, so if the coordinator node dies, a new one is elected and **recovers
   the in-flight transaction's decision from the log** — it can always find out whether to
   commit or abort. No permanent block.
3. **MVCC provides isolation** (loop [R2.Q6]) across the whole thing: each transaction reads at
   a consistent timestamp, writes create new versions, and the commit makes them visible
   atomically at a single chosen commit timestamp.

**Interviewer:** 2PC still has two round-trips of latency (prepare, then commit) before you ack
the client. That's slow. Can you hide it?

**Candidate:** Yes — this is exactly what Spanner and CockroachDB optimize with **parallel
commit / Parallel Commits**, which removes one of the two sequential wait phases from the
**client-visible** latency.

The insight: the classic 2PC critical path is **prepare all participants → wait → commit all →
wait → ack client**, i.e. the client waits for *both* round-trips. Parallel commit changes the
**commit condition**. Instead of the coordinator deciding commit *after* a separate phase, the
transaction is **considered committed the moment all writes are "prepared" (staged) and a
durable commit record listing them exists** — and crucially, the system can **acknowledge the
client as soon as all prepares succeed**, doing the actual commit-marker cleanup
*asynchronously* in the background. A later reader who encounters a staged-but-not-finalized
write can **verify** the transaction's status from the commit record and help finalize it. So:

```
 classic 2PC:   prepare → (wait) → commit → (wait) → ack    [client waits 2 RTT]
 parallel commit: prepare-all in parallel → ack             [client waits ~1 RTT]
                  (finalize markers async; readers self-heal)
```

You've turned the client-perceived commit latency from ~2 consensus round-trips into ~1, by
making "committed" a *derivable* property (all writes prepared + commit record exists) rather
than a separate broadcast phase. It's the same spirit as Kafka's idempotent dedup or the
self-healing read barrier in ZGC (loop [R2.Q8]) — push work off the critical path and let a
later observer reconcile.

The honest cost: it's intricate (readers must know how to verify and finalize a pending
transaction), and you still pay consensus latency for durability — you've just removed the
*second* serial wait. But for a cross-shard write, halving the commit latency is enormous, and
it's a core reason NewSQL is viable for OLTP rather than a research toy.

──────────
> **[BANK]** Distributed ACID = **2PC across shards + MVCC isolation + each participant's (and
> the coordinator's) decisions written through Raft**, so a dead coordinator can't block — a
> new one recovers the decision from the replicated log (fixes classic 2PC's fatal flaw).
> **Parallel commit** cuts client-visible latency from ~2 consensus RTT to ~1: "committed" =
> all writes prepared + a commit record exists; finalize markers async, readers verify/heal.
> **[TRAP]** Plain 2PC with a single-node coordinator (blocking SPOF, loop [R3.Q7]); thinking
> distributed transactions are impossible (they're just expensive and intricate); ignoring that
> the commit still costs consensus latency.
> **[GO DEEPER]** loop [R3.Q7] why naive 2PC blocks · loop [R2.Q6] MVCC · [I02.Q3] the Raft
> underneath · [I02.Q4] the commit *timestamp*.

---

### [I02.Q3] "How many Raft groups does your cluster run, and why not just one?"  ·  ★★★★☆

**Interviewer:** You said each shard is Raft-replicated. So how many Raft groups are there —
one for the cluster, or more? Defend it.

**Candidate:** **Many** — one Raft group **per range** ("**Multi-Raft**"), not one for the
whole cluster, and the reason is throughput and blast radius.

A **single** Raft group for the entire cluster would be a disaster: one leader funnels *every*
write in the system, so the cluster's total write throughput is capped at **one node's**
capacity — you've built a distributed database that writes like a single machine. It also means
one leader's failure stalls everything.

**Multi-Raft** gives each range its own independent Raft group (its own leader, its own log,
its own majority of replicas):
- **Write throughput scales horizontally** — ranges on different nodes commit in parallel,
  each with its own leader. A 1000-range cluster has ~1000 independent consensus streams.
- **Blast radius shrinks** — a failed node only disrupts the ranges it led; those re-elect
  leaders among their other replicas while the rest of the cluster is untouched.
- **Leaders spread** — a node is leader for some ranges, follower for others, balancing load.

```
 Range [a–f]: Raft group  (leader n1, followers n2,n3)
 Range [g–m]: Raft group  (leader n2, followers n1,n3)
 Range [n–z]: Raft group  (leader n3, followers n1,n2)
   → all commit in parallel; node loss only re-elects its ranges
```

**Interviewer:** A thousand Raft groups means a thousand streams of heartbeats. That overhead
will eat you. How do you survive it?

**Candidate:** Right — naive Multi-Raft drowns in **heartbeat traffic**: each Raft group sends
periodic leader→follower heartbeats, so 1000 groups across 3 nodes is thousands of tiny
messages per tick, mostly redundant since the *same physical nodes* are talking. The fixes:

1. **Coalesced / batched heartbeats.** Instead of per-range heartbeats, the system sends **one
   heartbeat per node-pair** that piggybacks the liveness of *all* ranges those two nodes share.
   n1→n2 sends a single message covering all 200 ranges they co-host, not 200 messages.
   CockroachDB does exactly this; it collapses the O(ranges) heartbeat traffic to O(node-pairs).
2. **Quiescing idle ranges.** A range with no traffic doesn't need to keep heartbeating to
   maintain a leader — it **quiesces** (goes dormant), stopping its heartbeats entirely until a
   request wakes it. Most ranges are idle most of the time, so this slashes background traffic.
3. **Shared transport / batching** of the actual Raft messages over a single connection between
   each node pair, so you're not paying per-group connection overhead.

The framing: **Multi-Raft is mandatory for write scalability (one Raft group = single-node
throughput), and its overhead is tamed by coalescing heartbeats per node-pair and quiescing
idle ranges** — so you get thousands of independent consensus streams with roughly node-pair-
proportional background cost, not range-proportional. The candidate who says "use Raft" passes;
the one who knows you need *many* Raft groups and then knows the heartbeat storm that creates —
and how it's coalesced — is the one who's actually read how these systems work.

──────────
> **[BANK]** **Multi-Raft** = one Raft group per range, not one per cluster — writes scale
> horizontally (parallel leaders) and node loss only re-elects its own ranges. The cost is a
> heartbeat storm (O(ranges)); tame it by **coalescing heartbeats per node-pair** (one message
> covers all shared ranges) and **quiescing idle ranges**. 
> **[TRAP]** One Raft group for the whole cluster (caps write throughput at one node);
> forgetting that thousands of groups create a heartbeat storm that must be coalesced.
> **[GO DEEPER]** loop [R3.Q1] Raft itself · [I02.Q1] the ranges these replicate · [I02.Q2]
> transactions across groups.

---

### [I02.Q4] "Two transactions commit on different nodes. Whose timestamp is bigger — and how do you even know?"  ·  ★★★★★

**Interviewer:** Serializable isolation needs a global order of transactions. But your commits
happen on different machines with different clocks. How do you assign commit timestamps that
respect causality, without a single global clock?

**Candidate:** This is *the* hard problem of distributed SQL, and there are two famous answers
— **Spanner's TrueTime** and the **hybrid-logical-clock** approach (CockroachDB) — both solving
"order transactions consistently despite clock skew" (loop [R3.Q8]).

**Spanner — TrueTime:** make physical time *trustworthy* with hardware. GPS + atomic clocks in
every datacenter give each node a clock with a **known uncertainty bound ε** — TrueTime returns
an *interval* `[earliest, latest]` guaranteed to contain true time, not a single value. To
commit, Spanner picks a commit timestamp and then does **commit wait**: it **waits out the
uncertainty** (sleeps ~2ε, single-digit ms) before releasing locks, *guaranteeing* that when
the transaction is visible, its timestamp is definitely in the past for everyone. This gives
**external consistency** (linearizability for transactions): if T1 commits before T2 starts in
real time, T1's timestamp < T2's, globally. The cost is **a few ms of commit-wait latency** and
**special hardware** (the GPS/atomic clock infrastructure) most companies can't deploy.

**CockroachDB — Hybrid Logical Clocks (HLC):** no atomic clocks; combine a physical timestamp
with a logical counter (loop [R3.Q8]). On every message, take `max` of local and received HLC,
bumping the logical part, so causally-ordered events get ordered timestamps even under skew.
But without TrueTime's bounded ε, two transactions on different nodes within the **clock-skew
window** can have an **ambiguous order** — Cockroach handles this with an **uncertainty
interval**: a read at timestamp `t` treats writes in `[t, t+max_clock_offset]` as *uncertain*,
and if it encounters one, it **restarts the read at a higher timestamp** to resolve the
ambiguity rather than risk a stale read. So it trades TrueTime's "wait out ε every commit" for
"occasionally restart a read that hits the uncertainty window," and it relies on a configured
`max_clock_offset` (NTP-bounded) — if a node's clock drifts past that bound, it must be **fenced
out of the cluster** (self-terminate), because exceeding the assumed skew would break
correctness.

**Interviewer:** So both depend on a clock-skew assumption. What happens when a node's clock is
actually wrong — drifts past the bound?

**Candidate:** This is the safety-critical edge, and both systems treat it as **"violate the
assumption → remove the node," never "return wrong data."**

- **Spanner:** TrueTime's ε *widens* if a node loses sync with its time masters — the
  uncertainty interval grows, so commit-wait gets longer (you slow down) but stays correct. If a
  node can't bound its uncertainty at all (lost all GPS/atomic reference), it **stops serving** —
  it would rather be unavailable than return a timestamp it can't trust. Availability is
  sacrificed to preserve external consistency (a CP choice, loop [R1.Q3]).
- **CockroachDB:** it assumes clocks are within `max_clock_offset` (e.g. 500ms). It actively
  **measures** offset against peers, and if a node detects its clock has drifted **beyond half
  the max offset**, it **commits suicide** (crashes itself out of the cluster) — because a node
  operating outside the assumed skew could serve a read that violates serializability. Better a
  dead node than a silent consistency violation.

The unifying principle, and the thing the panel wants: **distributed serializable ordering
rests on a clock-skew assumption, and the entire design is built so that violating the
assumption causes *unavailability* (slow down, or kill the node), never *incorrectness*.** You
buy global ordering either by making physical time trustworthy and waiting out its error
(Spanner, needs hardware) or by tracking logical+physical hybrid time and restarting reads in
the uncertainty window (Cockroach, commodity hardware) — and in both, the clock is a *safety
dependency*, so the failure mode of a bad clock is fail-stop, not fail-wrong. That fail-stop
discipline is exactly the loop's lesson (loop [R3.Q1]/[R5.Q2]): never trade correctness for
availability silently; make the unsafe state unreachable.

──────────
> **[BANK]** Global commit ordering despite clock skew: **Spanner TrueTime** = GPS/atomic
> clocks give a bounded uncertainty ε; **commit-wait** (sleep ~2ε) guarantees external
> consistency, costing ms + special hardware. **CockroachDB HLC** = hybrid physical+logical
> clock on commodity hardware; reads carry an **uncertainty interval** (`max_clock_offset`) and
> **restart** if they hit an ambiguous write. Both make the clock a **safety dependency** — a
> node whose clock drifts past the bound **fails-stop** (Spanner stops serving, Cockroach kills
> itself), never serves wrong data.
> **[TRAP]** Assuming you can order distributed commits by raw wall-clock (skew breaks it);
> thinking a drifting clock should keep serving (it must fail-stop); not knowing TrueTime needs
> hardware while HLC trades it for read restarts.
> **[GO DEEPER]** loop [R3.Q8] logical clocks/TrueTime in general · [I02.Q2] the commit using
> this timestamp · loop [R5.Q2] fail-stop discipline.

---

### [I02.Q5] "A `JOIN` across two tables on different nodes. Don't you dare pull both to the client."  ·  ★★★★☆

**Interviewer:** `SELECT ... FROM orders JOIN users ON ...` where `orders` and `users` live on
different nodes. The naive engine ships both tables to a coordinator and joins there. Do
better.

**Candidate:** Shipping both tables to one coordinator is the **"pull data to compute"**
anti-pattern — it moves gigabytes over the network to do a join, saturating the coordinator and
the network. The principle of a distributed query engine is the inverse: **push the computation
to the data** ("compute follows data"), minimizing bytes on the wire. Several techniques,
chosen by the optimizer based on table sizes and key distribution:

1. **Predicate / projection pushdown.** Push `WHERE` filters and column projections **down to
   each node** so they scan locally and return only the *matching rows and needed columns*, not
   whole tables. Never ship a row or column the join won't use. This is the cheapest, biggest
   win and always applies.
2. **Co-located / collocated join.** If both tables are **sharded on the join key** (e.g. both
   partitioned by `user_id`), then the matching rows for a given key are **already on the same
   node** — so each node joins its *local* `orders` and `users` partitions and the coordinator
   just unions the results. **Zero cross-node data movement** for the join itself. This is why
   schema design (choosing aligned partition keys / interleaved tables in Spanner) is a
   performance decision — co-location turns a distributed join into N local joins.
3. **Distributed hash join (shuffle/repartition).** If they're *not* co-located, repartition on
   the fly: each node hashes its rows by the join key and **shuffles** them so all rows with the
   same key meet on the same node, then each node hash-joins its bucket. You still move data, but
   only the *filtered, projected* rows, and you parallelize the join across all nodes instead of
   bottlenecking one coordinator.
4. **Broadcast join.** If one side is **small** (a lookup/dimension table), **broadcast** that
   small table to every node and join locally against the big table's local shard — cheaper than
   shuffling the big table. The optimizer picks broadcast vs shuffle by comparing sizes.

```
 bad:  [node A: orders]──┐
       [node B: users ]──┴─▶ coordinator joins (ships everything)  ✗

 good: pushdown filters → co-located? join locally, union results
                        → not co-located? shuffle by join key (parallel)
                        → one side small? broadcast it
```

**Interviewer:** The optimizer keeps choosing shuffle when broadcast would've been cheaper, and
your tail latency suffers. What did it get wrong?

**Candidate:** Almost always **stale or missing statistics** — the planner picks shuffle-vs-
broadcast by *estimating* each side's size, and if the table stats are out of date (a small
table it thinks is large, or a filter whose selectivity it mis-estimates), it over-estimates the
"small" side and refuses to broadcast it, falling back to a needless shuffle. The fixes:
**keep statistics fresh** (auto-analyze after big mutations), **histograms** on the filtered
columns so selectivity estimates are accurate, and where the planner is unreliable, **plan
hints** or a **cost-model tune**. It's the same lesson as single-node `EXPLAIN` (loop [R1.Q7]),
amplified: a wrong estimate on one box picks a slightly worse index; on a cluster it picks the
wrong *data-movement* strategy, and data movement is the dominant cost — so a stats error is far
more expensive distributed. So the engine is a **distributed, parallel dataflow**: filter and
project at the source, then either join locally (co-located), shuffle (hash join), or broadcast
(small side) — and the **optimizer's job is to pick the plan that moves the fewest bytes**, using
table statistics and the partition keys. The coordinator orchestrates and merges; it doesn't do the heavy lifting.
The senior insight: **in a distributed database the dominant cost is data movement, so the whole
art of the query planner is minimizing bytes shipped — pushdown, co-location, and choosing
shuffle-vs-broadcast — not CPU cycles.** "Pull it all to one place and join" is exactly what a
distributed engine exists to avoid.

──────────
> **[BANK]** Distributed joins = **push compute to data, minimize bytes on the wire**:
> predicate/projection **pushdown** (scan + filter locally, ship only matching rows/cols);
> **co-located join** if both tables share the partition key (rows already on one node → N
> local joins, zero shuffle); **shuffle/hash join** (repartition by key, parallel) if not;
> **broadcast** the small side for big⋈small. The optimizer picks the min-bytes plan from
> statistics.
> **[TRAP]** Shipping whole tables to a coordinator to join (pull-data-to-compute — saturates
> network + coordinator). Not realizing aligned partition keys make joins free (co-location is a
> schema decision).
> **[GO DEEPER]** [I02.Q1] the sharding that enables co-location · loop [R1.Q7] indexes the
> local scans use · [I02.Q6] online schema change to add those indexes.

---

### [I02.Q6] "Add a column and an index to a 10-billion-row table. Zero downtime. Go."  ·  ★★★★★

**Interviewer:** `ALTER TABLE ADD COLUMN` plus a new index, on a 10-billion-row distributed
table, with the application live the whole time. A naive lock-the-table migration is
unacceptable. How?

**Candidate:** A blocking `ALTER` that locks the table or rewrites it synchronously is
impossible at this scale — it'd lock for hours. The answer is the **online, asynchronous schema
change protocol** pioneered by Google's F1 (the "F1 schema change" paper), which CockroachDB and
Vitess implement. The core idea: **a schema change is a *multi-stage rollout* where intermediate
states are mutually compatible**, never a single atomic switch — because in a distributed
system you **cannot** flip the schema on all nodes simultaneously (different nodes learn of the
new schema at different times), so you must guarantee that nodes running the *old* and *new*
schema versions at the same time **never corrupt each other's data**.

The mechanism uses **intermediate, non-public schema states** that roll forward one at a time,
with the invariant that **adjacent states differ by at most one step** so any two co-existing
versions are safe:

```
 ADD INDEX rollout:
   ABSENT → DELETE_ONLY → WRITE_ONLY → (backfill) → PUBLIC
```

- **DELETE-ONLY:** the index exists but is only used to *delete* entries, not to write new ones
  or serve reads. Why first? So that a node still on the old schema that deletes a row, and a
  node on the new schema, agree on cleanup without the index ever being half-populated and
  read.
- **WRITE-ONLY (delete-and-write-only):** now writes/updates maintain the index, but **reads
  don't use it yet**. This ensures that by the time the index is readable, *all new writes* are
  already indexed — no write slips through unindexed.
- **Backfill:** a background job scans the existing 10 billion rows in **chunks** and populates
  the index, throttled to not overwhelm the cluster, while live writes keep it current via the
  WRITE-ONLY state. This is the long part, and it runs online.
- **PUBLIC:** only once backfill completes and every node is at WRITE-ONLY does the index become
  fully readable/usable. Now the optimizer can use it.

Each transition waits until **all nodes have acknowledged the previous state** (bounded by a
schema lease/version mechanism) before advancing, guaranteeing at most two adjacent versions
coexist.

**Interviewer:** What stops a node still caching the old schema from writing data the new
schema considers corrupt — say, during that window?

**Candidate:** **Schema leases with a bounded version skew.** Every node holds a **lease on a
specific schema version** with an expiry, and the protocol enforces that **at most two
consecutive versions are live at once** (version N and N+1, never N and N+2). Because adjacent
states are designed to be **mutually compatible** (that's the whole point of DELETE-ONLY →
WRITE-ONLY → PUBLIC being single-step transitions), a node on version N and a node on N+1
**cannot corrupt each other** — by construction, anything N writes is valid for N+1 and vice
versa.

The enforcement:
- A node must hold a **valid (unexpired) lease** on a schema version to serve. The schema
  coordinator won't advance to version N+2 until **every lease on N−1 has expired or been
  released** — so it literally waits out the lease duration to guarantee no stragglers on an
  incompatible old version remain.
- If a node is partitioned/slow and its lease **expires**, it must **stop serving** until it
  re-acquires a current lease — fail-stop again (the recurring theme): a node that can't prove
  it has a recent-enough schema refuses to act rather than risk writing data an incompatible
  version would corrupt.

So the complete answer: **a schema change is a sequenced rollout of single-step-compatible
intermediate states (DELETE-ONLY → WRITE-ONLY → backfill → PUBLIC), gated by schema leases that
bound coexistence to two adjacent versions and force stragglers to fail-stop.** It's online
because the backfill runs in the background while compatible old/new nodes operate
concurrently, and it's *safe* because no two simultaneously-live schema versions can ever
disagree about whether data is valid. The deep lesson — and it rhymes with everything in this
interview — is that **in a distributed system you can't change anything atomically across all
nodes, so you turn every change into a rolling sequence of states that are pairwise
compatible**, exactly like a saga (loop [R3.Q7]) or a tombstone-grace-period (loop [R3.Q6]):
correctness comes from making the *intermediate* states safe, not from pretending the switch is
instantaneous.

──────────
> **[BANK]** Online schema change (F1/Spanner/CRDB) = a **rolling sequence of single-step-
> compatible states** (ADD INDEX: ABSENT→DELETE-ONLY→WRITE-ONLY→backfill→PUBLIC), never an
> atomic switch — because nodes learn the new schema at different times. **Schema leases** bound
> coexistence to **two adjacent versions** (designed mutually compatible), and a node whose
> lease expires **fails-stop**. Backfill runs throttled in the background → zero downtime.
> **[TRAP]** A blocking `ALTER` that locks/rewrites the table (hours of downtime at scale);
> assuming you can flip schema atomically cluster-wide (you can't — must be rolling +
> pairwise-compatible).
> **[GO DEEPER]** loop [R3.Q6] tombstone grace periods (same "make intermediate states safe"
> idea) · loop [R3.Q7] sagas · [I02.Q1] the ranges being backfilled.

---

### [I02.Q7] "Reads are 90% of my load and they all hit the leader. That's wasteful. Fix it without breaking consistency."  ·  ★★★★★

**Interviewer:** Every read goes to the range's Raft leader to be linearizable, so followers sit
idle and the leader is a bottleneck. I have lots of replicas doing nothing. Let me read from
them — without serving stale data.

**Candidate:** The tension is real: a strongly-consistent read normally must go to the **leader
(leaseholder)** because only it knows it has the latest committed data — a follower might be
behind. But that wastes the followers and bottlenecks the leader. The techniques to scale reads
safely, escalating in how much staleness you accept:

1. **Leaseholder reads (the baseline).** One replica holds a **read lease** for the range and
   serves linearizable reads *locally* without a Raft round-trip per read — because the lease
   guarantees no other replica can be leaseholder simultaneously, so its data is authoritative.
   This already avoids consensus on every read (the leaseholder just reads its local state). But
   it's still one node per range.
2. **Follower reads (the scaling win).** Let **followers serve reads** — but only for a
   timestamp they can *prove* they have all the data for. This works via **closed timestamps**:
   the leaseholder periodically publishes a **closed timestamp** `t_closed`, a promise that "no
   new writes will ever commit at or below `t_closed`." A follower that has applied the Raft log
   up to `t_closed` can **safely serve any read at a timestamp ≤ t_closed** locally, because it
   knows it has *every* write that will ever exist at that timestamp — there can be no future
   write that would change the answer. So:
   - A read at a **slightly stale timestamp** (a few seconds ago, ≤ `t_closed`) can hit the
     **nearest follower** — huge for read scaling and for **geo-locality** (read from the
     replica in your region instead of crossing the planet to the leader).
   - The read is still **consistent as-of that timestamp** (a valid MVCC snapshot, loop
     [R2.Q6]) — not garbage, just slightly in the past.
3. **Bounded-staleness reads** — let the client say "give me data no older than X" and the
   system routes to the closest replica that satisfies it, trading freshness for latency
   explicitly.

```
 closed timestamp t_c published by leaseholder ("nothing new ≤ t_c")
 follower applied log ≥ t_c  →  serves any read with ts ≤ t_c locally
   → strongly consistent AS OF t_c, served from the nearest replica
```

**Interviewer:** So follower reads are stale by the closed-timestamp interval. When is that
*not* acceptable, and what do you do then?

**Candidate:** It's not acceptable when the read must be **linearizable / read-your-own-writes
fresh** — e.g. a user just updated their profile and immediately reloads it, or a transaction
that read a balance is about to write based on it. A follower read "as of 4 seconds ago" would
show them the *old* value — a correctness/UX violation. In those cases:

- **Route to the leaseholder** for a fully fresh, linearizable read (pay the locality cost,
  accept the leader load for *those* reads). You reserve the expensive path for reads that
  genuinely need now-ness.
- **Read-your-writes via session timestamps:** track the timestamp of the client's last write,
  and ensure their subsequent reads use a timestamp ≥ that — so they always see their own
  changes even if other data is served stale. This satisfies the most common "freshness" need
  (your own writes) cheaply, without forcing *every* read to the leader.
- **Inside a transaction**, reads happen at the transaction's read timestamp against the
  appropriate replicas with the MVCC/uncertainty machinery (loop [I02.Q4]) — they're consistent
  by construction, not subject to follower staleness.

So the design is **tiered routing by freshness requirement**: serve the **90% of reads that
tolerate slight staleness from the nearest follower** (closed timestamps make this safe and
consistent-as-of-a-past-snapshot), route the **must-be-fresh minority to the leaseholder**, and
use **session timestamps for read-your-writes**. You scale reads across all replicas *and* keep
strong consistency where it's actually required — the same PACELC judgment as the loop ([R1.Q3]):
most reads happily trade a few seconds of freshness for locality and throughput, and you spend
the expensive linearizable path only where the application truly needs the present moment. The
naive "all reads hit the leader" is leaving your replicas — and your geo-distribution — entirely
unused.

──────────
> **[BANK]** Scale reads off the leader safely with **closed timestamps**: the leaseholder
> publishes `t_closed` ("no future write ≤ this"), so any **follower** caught up to `t_closed`
> can serve a read at ts ≤ `t_closed` locally — strongly consistent *as of that past snapshot*,
> from the nearest/geo-local replica. Route **must-be-fresh reads to the leaseholder**, use
> **session timestamps for read-your-writes**. Tier routing by freshness need (PACELC).
> **[TRAP]** Sending all reads to the leader (wastes replicas, bottlenecks the leader) — or
> serving stale follower reads to a read-your-writes flow (user doesn't see their own update).
> **[GO DEEPER]** loop [R2.Q6] MVCC snapshots · loop [R1.Q3] PACELC freshness/latency · [I02.Q4]
> the timestamps · loop [I02.Q3] the leaseholder/Raft leader.

---

## Closing note — the distributed-SQL floor

The whole interview was one move repeated: **take a guarantee that's easy on one machine —
range scans, ACID transactions, a global order, joins, schema changes, fresh reads — and
rebuild it on a cluster where machines fail, clocks lie, and nothing is atomic across nodes.**
Every answer rested on the same toolkit: consensus for durability (Multi-Raft), MVCC for
isolation, a clock-skew safety assumption that *fails-stop* when violated, and rolling/
pairwise-compatible intermediate states for anything that can't change atomically. The
candidate who shines treats "distributed" not as "the same but more boxes" but as **a different
physics where every single-node assumption must be earned back, and earned back with a known
cost** — and can always name that cost (a round-trip, a commit-wait, a few seconds of
staleness, a backfill).

→ Back to the [interview floor](./00-interviews-index.md) · related: loop
[R2](../02-round-2-internals.md), [R3](../03-round-3-distributed-messaging.md), and Interview
[08](./interview-08-object-storage.md) (durability), [16](./interview-16-container-orchestration.md)
(etcd/Raft control plane).
