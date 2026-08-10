# Round 5 — The Bar-Raiser

> **The panel:** A single distinguished engineer who wasn't in any of the earlier rounds but
> **read the notes from all of them.** Their job is not to test knowledge — the previous four
> rounds did that. It's to test **judgment under pressure**: Can you defend a position you
> took? Change your mind when the facts change *without* collapsing? Sit in ambiguity where
> there's no clean answer? Say "I don't know, here's how I'd find out"? The bar-raiser is
> looking for the failure modes that don't show up in a whiteboard: arrogance, rigidity,
> bluffing. The right answers here are often "it depends — and here's exactly what it depends
> on."

Difficulty band: ★★★★★. Seven exchanges. Each one **calls back** to a claim from an earlier
round and pushes on it.

Domains touched: all six, cross-cutting.

---

### [R5.Q1] "In Round 2 you praised LSM trees. I'm building read-heavy OLTP. Defend LSM, or back down."  ·  `DB` · ★★★★★

**Interviewer:** Earlier you explained LSM trees beautifully — sequential writes, great
ingest. My workload is **read-heavy OLTP**: lots of point lookups and short range scans, few
writes, strict latency. Defend using an LSM here. Or admit it's the wrong tool.

**Candidate:** For *that* workload, the honest answer is: **a B+tree is the better default,
and I'd back down from LSM** — but let me be precise about *why*, and about the narrow
conditions where I'd reconsider, because "back down" without the reasoning is just as weak as
defending the wrong tool.

LSM's whole bargain (R2.Q5) is **trade read and space amplification to make writes
sequential.** On a read-heavy workload you're **paying the tax without using the benefit**:
- A point lookup may probe the memtable plus several SSTables across levels — **read
  amplification** — whereas a B+tree is a single ~3–4 page path. Bloom filters help LSM skip
  files, but a B+tree's read path is *predictable*, and read-heavy OLTP cares about
  predictable p99.
- **Compaction** runs continuously in the background, stealing I/O and CPU and causing
  **latency spikes** exactly when a big merge collides with your read traffic — a tail-
  latency hazard for a latency-strict service.
- You barely write, so LSM's sequential-write win is mostly unused.

So I'd choose a B+tree (InnoDB/Postgres) and not feel clever about it.

**Interviewer:** So you'd never use LSM for reads. Final answer?

**Candidate:** No — "never" would be overcorrecting, and that's a different failure. There
are read-heavy shapes where an LSM still wins, and a senior answer names them rather than
retreating to a slogan:

1. **If "read-heavy" means recent data.** LSM keeps the freshest data in the memtable and
   upper levels, often in memory — so a workload that reads *recently written* keys (time-
   series dashboards, recent activity feeds) gets great LSM read performance because the hot
   set is in the upper levels and Bloom filters prune the rest. "Read-heavy" and "reads cold
   random keys across the whole keyspace" are very different.
2. **If the dataset is enormous and write volume, though a minority, is still huge in
   absolute terms.** At a scale where a B+tree's random-write cost would dominate even at
   "10% writes," LSM's sequential writes plus horizontal scale (Cassandra/Scylla) may be the
   only thing that holds — you might accept higher read amplification because the B+tree
   simply can't take the write rate *or* the data volume on one node.
3. **If I need the operational profile** — Cassandra-style multi-region, masterless
   availability — the *storage engine* choice rides along with the *distribution* choice. I
   might "choose LSM" not for its read/write curve at all but because I chose Cassandra for
   AP availability, and LSM came with it.

So my actual answer: **for classic read-heavy OLTP with point lookups across a large
keyspace and a strict latency SLA, B+tree — I back down from LSM, and the reason is read
amplification + compaction jitter against a predictable-tail requirement.** But I'd resist
turning that into "LSM is bad for reads," because the truth is workload-shaped: recent-data
reads, extreme scale, and the distribution model can each flip it back. The judgment isn't
picking a winner — it's knowing *which properties of "read-heavy" actually decide it*, so I'm
choosing on the real constraint instead of a remembered rule of thumb.

──────────
> **[BANK]** Read-heavy OLTP, point lookups, strict tail → **B+tree** (single predictable
> path) over LSM (read amplification across SSTables + compaction jitter). But don't
> overcorrect to "LSM is bad for reads": LSM still wins for *recent-data* reads (hot set in
> upper levels), at extreme scale/write-volume, or when the distribution model (Cassandra/AP)
> dictates the engine. "Read-heavy" is underspecified — *which* property decides it.
> **[TRAP]** Both failure modes: stubbornly defending the tool you praised, *and*
> overcorrecting to an absolute ("never use LSM for reads"). Judgment = naming the deciding
> property.
> **[GO DEEPER]** [R2.Q5] the amplification tradeoffs · [R2.Q4] B+tree internals · [R1.Q3]
> the AP/CP choice that drags the engine along.

---

### [R5.Q2] "Your CP system had a split-brain. Two leaders took writes. Now what?"  ·  `DIST` · ★★★★★

**Interviewer:** You designed a leader-based system and assured me it was safe. A network
partition happened, and for 20 seconds **two nodes both believed they were leader and both
accepted writes.** Now the partition heals. Walk me through the damage and the recovery — and
tell me how it happened despite your "safety."

**Candidate:** First, the uncomfortable honesty: if **two leaders both *committed* writes**,
then either the consensus protocol was violated or — far more likely — **I wasn't actually
running consensus for those writes.** A correct Raft/Paxos system (R3.Q1) makes this
*impossible to commit*: a write needs a **majority quorum**, and in a partition **only one
side can hold a majority**, so the minority-side "leader" can *accept* writes locally but can
**never commit them** — it can't reach a quorum. So the first thing I'd determine is *which
kind* of split-brain this is, because it changes everything:

1. **If both sides truly committed** — that means writes were acknowledged **without a
   quorum** (e.g. a leader that kept serving reads/writes from local state during the
   partition, or async replication treated as committed, or a lease/lock-based "leader" with
   no fencing). That's the dangerous case and it's a **design bug**, not bad luck.
2. **If only one side committed** and the minority leader merely *accepted but never
   committed* — recovery is clean: when the partition heals, the minority "leader" sees a
   **higher term** from the real cluster, **steps down** (R3.Q1), and its uncommitted tail is
   **truncated** via the log-matching repair. No durable damage. This is what a correct
   system does, and it's why I'd build on real consensus.

Let me assume the bad case, because that's what you're testing.

**Interviewer:** Yes — assume both sides durably committed conflicting writes to the same
keys. The damage is real. Recover it.

**Candidate:** Then I have **divergent histories that both claim to be authoritative**, and
there is **no purely mechanical, lossless fix** — by accepting writes without a quorum I
manufactured a true conflict, and *something* has to give. Recovery is damage control plus
prevention:

**Immediate containment:**
- **Fence first, reconcile second.** Establish a single authoritative leader (re-run
  election under a fresh, higher term) and **immediately stop accepting new writes to the
  affected keys** so the divergence can't grow while I reconcile. A monotonic **fencing
  token** is what makes the zombie leader's late writes get rejected by the storage layer
  going forward.

**Reconciliation — and now it's a *data* problem, not a *protocol* problem:**
- **Detect the conflicts.** Compare the two divergent logs/states — **vector clocks**
  (R3.Q8) are exactly the tool: writes that are causally ordered, the later wins
  automatically; writes that are **concurrent** (neither vector dominates) are the **genuine
  conflicts** that need a decision.
- **Resolve, accepting that resolution is lossy or human:**
  - **Last-write-wins** — simple, but *silently discards* one side's committed writes. Only
    acceptable if the data tolerates it (and "we told a user their write succeeded then threw
    it away" is a serious breach for anything like money).
  - **Application-semantic merge / CRDTs** — if the data type is mergeable (a set union, a
    counter that can be summed, a shopping cart), merge both sides losslessly. This is the
    *good* outcome and it requires having **designed for conflict** ahead of time.
  - **Escalate to a human / business process** — for irreconcilable money-like conflicts
    (both sides "withdrew the last $100"), there may be no automatic answer; you quarantine
    the conflicting records and run a reconciliation/audit process, possibly issuing
    compensating transactions (R3.Q7 saga-style).

**The real answer is prevention, and I'd own that:**
- **Never acknowledge a write without a quorum.** If I'd required majority commit, the
  minority leader physically *couldn't* have committed and this is impossible. So the root-
  cause fix is "stop calling non-quorum writes committed."
- **Fencing tokens** on any lock/lease-based leadership so a paused-then-woken leader (R3.Q1,
  the GC-pause zombie) is rejected by the resource — the classic "distributed lock needs a
  fence" lesson.
- **Design data for conflict** where availability under partition is required: choose CRDTs /
  mergeable types so a heal is a *merge*, not a *loss*.

The bar-raiser point I'd make explicitly: **a split-brain that durably commits conflicting
writes is almost always evidence that the system was AP wearing a CP costume** — it stayed
*available* during the partition by accepting writes it couldn't safely commit. The mature
response isn't a clever recovery script; it's recognizing the design accepted an
availability/consistency tradeoff (R1.Q3 / PACELC) it never admitted to, and either (a)
becoming honestly CP (refuse writes without quorum — fail closed during partition) or (b)
becoming honestly AP (embrace CRDTs and merge-on-heal). The thing you can't do is want
strong consistency *and* availability during a partition and act surprised when CAP collects.

──────────
> **[BANK]** Correct consensus makes "two leaders commit" impossible — only one partition side
> holds a majority/quorum; the other can accept but never commit, and on heal it sees a higher
> term, steps down, truncates. If conflicting writes *did* durably commit, you weren't running
> quorum-commit — that's AP-in-CP-costume. Recovery: fence (fencing token) → detect conflicts
> (vector clocks) → resolve (LWW lossy / CRDT merge / human escalation). Real fix = never ack
> without quorum + fence leases + design data for conflict.
> **[TRAP]** Promising a clever lossless auto-recovery for genuinely concurrent conflicting
> commits (there isn't one), or not realizing the bug was acking writes without a quorum.
> **[GO DEEPER]** [R3.Q1] terms/quorums that prevent it · [R3.Q8] vector clocks for
> reconciliation · [R3.Q2] sloppy quorums · [R1.Q3] PACELC honesty.

---

### [R5.Q3] "You keep saying databases roll their own binary protocol. Why not just use HTTP? It'd be simpler."  ·  `NET` · ★★★★☆

**Interviewer:** Round 2, question 1 — you were almost smug that MySQL doesn't use HTTP. But
HTTP is universal, debuggable, load-balanceable, has a huge ecosystem. Argue the *other*
side: why *not* just put the database protocol on HTTP and keep it simple?

**Candidate:** Fair challenge — and the steelman for HTTP is genuinely strong, so let me make
*their* case first, then explain why the database world still doesn't, because the reasons are
specific and they're not "binary is cooler."

**The case FOR HTTP (which is real):** universal tooling (curl, proxies, every language has a
client), human-debuggable, trivially load-balanced by L7 proxies, TLS and auth ecosystems
solved, traverses firewalls and middleboxes that distrust unknown ports, and HTTP/2 even gives
you multiplexing. For *most* services, "just use HTTP/gRPC" is exactly right, and inventing a
custom binary protocol would be premature optimization. I'd push back hard on anyone hand-
rolling a wire protocol for a normal API.

**Why databases specifically don't:**

1. **Statefulness.** HTTP is fundamentally **request/response and stateless** by design; a
   database connection is a **long-lived, stateful session** — authentication, the current
   transaction, prepared-statement handles, session variables, server-side cursors, temp
   tables. The MySQL/Postgres protocol is a **conversation**, not a series of independent
   requests. Modeling a transaction (BEGIN…multiple statements…COMMIT, with locks held
   across them) on top of stateless HTTP means re-inventing session affinity and state
   tracking that the binary protocol gets for free. You'd fight HTTP's core assumption.

2. **Latency and per-message overhead.** A query is a tiny message issued **millions of times
   per second** on a hot connection. HTTP carries **verbose text headers** on every
   request/response — easily hundreds of bytes of `Host:`, `User-Agent:`, `Content-Type:`,
   cookies — dwarfing a 20-byte query. The binary protocol's 4-byte header (R2.Q1) vs HTTP's
   header bloat is a real throughput and bandwidth difference at database call volumes. And
   parsing text headers costs CPU on every message versus reading a length-prefixed binary
   frame. At a million queries/sec that overhead is the difference between one box and ten.

3. **The protocol needs things HTTP doesn't model well.** Result sets are **streamed**
   row-by-row (a server-side cursor pushing rows as the client consumes); the protocol
   multiplexes commands, server-initiated messages, and binary-typed values natively. HTTP/1
   has no server push and head-of-line blocking; you'd be bolting streaming semantics onto a
   protocol that resists them. (HTTP/2 closes some of this gap — which is exactly why
   **gRPC**, an HTTP/2 binary protocol, *is* used for many RPC needs.)

4. **It already works and the clients exist.** The protocol predates HTTP's dominance, every
   driver implements it, and there's no benefit to migrating a battle-tested binary protocol
   to HTTP for "simplicity" the database team doesn't experience — they're not curling their
   database.

**Interviewer:** So is there a line where you *would* put data access on HTTP?

**Candidate:** Yes, and naming it is the point — the answer isn't dogma. I'd use HTTP-based
access when the **access pattern is stateless and request/response-shaped** rather than a
stateful session:
- **REST/GraphQL data APIs and "database-over-HTTP"** products (Postgres via PostgREST,
  DynamoDB's HTTP API, Firebase, Supabase, edge databases) — these deliberately expose data
  over HTTP because their clients are **browsers and serverless functions** that can't hold a
  persistent pooled TCP connection, can't traverse to port 3306, and *want* the HTTP
  ecosystem (CDN caching, edge proxies, stateless auth tokens). For a **serverless**
  function that spins up per request, a stateless HTTP data call is *better* than a classic
  connection because there's no pool to keep warm.
- **gRPC** for internal service-to-service data access when I want HTTP/2's multiplexing +
  binary framing + codegen + the ecosystem, accepting it's heavier than a raw DB protocol.

So my honest, non-smug position: **the database's custom binary protocol is the right tool
for a high-throughput, stateful, long-lived session between an app server and its database —
that's the niche it's optimized for, and HTTP would be a poor fit there. But "always use a
custom binary protocol" is wrong; for stateless, browser/serverless/edge access, HTTP-based
data APIs are genuinely better, which is why they exist and are growing.** The deciding axis
is **stateful-session-and-high-throughput → binary protocol; stateless-request/response-and-
ecosystem-reach → HTTP.** R2.Q1 wasn't "HTTP is bad"; it was "this particular workload chose
the protocol that fits it" — and the bar-raiser version of that is being able to argue the
*other* side and locate the line.

──────────
> **[BANK]** DB binary protocols beat HTTP for **stateful, long-lived, high-throughput
> sessions**: HTTP is stateless (transactions/cursors don't fit), its text headers bloat
> every tiny query (vs a 4-byte frame), and it doesn't natively stream result sets. But HTTP
> *wins* for stateless/browser/serverless/edge access (PostgREST, DynamoDB HTTP API,
> Supabase) where there's no pooled connection to keep warm and the HTTP ecosystem matters.
> gRPC (HTTP/2 binary) is the middle ground. Deciding axis: stateful+hot → binary; stateless+
> reach → HTTP.
> **[TRAP]** Dogma either way — "always custom binary" (ignores serverless/edge reality) or
> "always HTTP" (ignores why hot stateful DB sessions avoid it). The bar-raiser tests whether
> you can argue against your own earlier claim.
> **[GO DEEPER]** [R2.Q1] the MySQL protocol · [R2.Q2] TLS inside it · [R4.Q6] HTTP 429/
> backpressure.

---

### [R5.Q4] "GC is blowing your SLA. Do you tune the JVM or rewrite the service in Rust?"  ·  `JVM` · ★★★★★

**Interviewer:** From Round 4: your JVM service keeps missing its latency SLA on GC pauses.
An engineer on your team says "Java is the problem, let's rewrite it in Rust — no GC, no
pauses." You have the authority to approve it. Decision?

**Candidate:** My default answer is **no — don't rewrite, not yet** — and the reasoning is
mostly about engineering economics and risk, not language preference. But I'd hold it
loosely, because there's a real version of "yes." Let me reason it as a decision, not a taste.

**Why "rewrite in Rust" is usually the wrong *first* move:**

1. **You probably haven't exhausted the cheap options.** From R4.Q7, a GC SLA miss is usually
   an **allocation problem**, and I have a ladder of fixes that are days of work, not months:
   switch to **ZGC/Shenandoah** (sub-millisecond pauses, often a one-line flag + retest),
   **tune heap/young-gen**, **profile and kill the allocation hot path**, move big data
   **off-heap**, eliminate autoboxing. Most "GC is killing us" stories are solved at step 1
   or 2. Rewriting in Rust to fix GC pauses before trying `-XX:+UseZGC` is like buying a new
   car because the tank is empty.

2. **A rewrite is enormous, risky, and re-introduces bugs.** The existing service encodes
   *years* of fixed edge cases, business logic, and battle-testing. A from-scratch rewrite
   throws that away and **reintroduces a new generation of bugs** in code that was finally
   stable — the classic "second-system" and "Netscape rewrite" trap. The team also likely has
   deep Java expertise and shallow Rust expertise, so velocity craters and the bug rate spikes
   during and after. The *opportunity cost* — months not spent on product — is the biggest
   hidden line item.

3. **Rust isn't a free win even on the merits.** No GC means **no GC pauses**, true — but it
   moves memory management into the type system (borrow checker), which is a real productivity
   and hiring cost, and you can still have latency spikes from allocator behavior, lock
   contention, or `Drop` running at bad times. "No GC" removes one specific problem, not all
   tail latency. And you lose the JVM's mature observability, libraries, and the team's fluency.

**Interviewer:** Fine — you've made the case against rushing in. So when *would* you actually
approve it? Give me the conditions, not a flat "never."

**Candidate:** When the problem genuinely has the properties native buys you, and naming those
conditions precisely is what separates judgment from reflex:

- **If the SLA is genuinely unachievable on the JVM after exhausting tuning** — e.g. a
  hard *single-digit-microsecond* p99.9 (HFT order matching), where even ZGC's sub-ms pause
  and the JIT warmup/safepoint jitter are too much. At that tier, GC-less native (Rust/C++)
  is the *right* tool and the industry agrees.
- **If it's a small, well-bounded, hot component** — not the whole service. The smart move is
  almost never "rewrite the service"; it's **rewrite the 5% hot path** in Rust and call it via
  JNI/FFI, keeping the other 95% in productive Java. Surgical, not wholesale.
- **If there's a strategic reason beyond this SLA** — the team is moving to Rust anyway,
  hiring for it, and this service is a sensible pilot — then the latency issue is a *reason*,
  not *the* reason, and that's a legitimate call.

**The decision framework I'd actually apply:** First, **quantify** — what's the current p99,
what's the target, what does the allocation profile say? Then **try the cheap ladder** (ZGC,
tuning, off-heap, allocation reduction) and *measure* — this is days and often ends the
discussion. **Only if that provably can't hit the SLA** do I consider native, and then
**surgically** (the hot component via FFI), not a full rewrite, unless there's an independent
strategic reason. So my answer to the engineer: "Great instinct that GC is the problem —
let's first prove the SLA is unachievable on the JVM, because if `-XX:+UseZGC` and an
allocation-profiling pass fix it this week, a six-month Rust rewrite is the most expensive way
we could possibly solve a config problem. If we *do* prove it's unachievable, we rewrite the
hot path, not the service." The bar-raiser is watching whether I reach for the exciting
rewrite or the boring measurement — **senior engineering is biased toward the cheapest fix
that's proven sufficient, and toward surgical over wholesale.**

──────────
> **[BANK]** GC SLA miss → don't rewrite in Rust *first*. Climb the cheap ladder (ZGC/
> Shenandoah one-liner → heap/young tuning → off-heap → kill allocation hot path) and
> **measure** — usually ends it in days. Rewrite only when the SLA is *provably* unachievable
> on the JVM (e.g. µs-level HFT), and then **surgically** (hot 5% via FFI), not the whole
> service — a full rewrite throws away years of battle-testing and reintroduces bugs. Bias:
> cheapest proven-sufficient fix, surgical over wholesale.
> **[TRAP]** Approving an exciting full rewrite to fix what `-XX:+UseZGC` would (config
> problem, six-month solution), *or* dogmatically refusing native even where the SLA truly
> demands it. Both are judgment failures.
> **[GO DEEPER]** [R4.Q7] the GC budget math & off-heap moves · [R2.Q8] ZGC mechanics · [R5.Q1]
> the same "don't overcorrect" discipline.

---

### [R5.Q5] "Make 'charge the card and publish an event' exactly-once. No hand-waving about Kafka transactions."  ·  `PS`·`DB` · ★★★★★

**Interviewer:** Round 3 you said Kafka's exactly-once is closed-world and stops at the
database boundary. Here's that boundary: a service must **update its database AND publish an
event** to Kafka, and downstream must process that event exactly once. No lost events, no
duplicates. Design it. And you can't use a distributed transaction across the DB and Kafka.

**Candidate:** This is the **dual-write problem**, and it's the single most common silent
data-loss bug in event-driven systems, so let me name the naive trap first, then the
solution, then close the downstream side.

**The naive trap:** in your request handler, you do two writes to two systems:
```java
db.save(order);              // write 1: database
kafka.publish(orderEvent);   // write 2: Kafka
```
There is **no atomicity** across these two systems, so any crash *between* them corrupts:
- DB commits, then the process **crashes before the Kafka publish** → the order exists but
  **the event is lost forever**. Downstream never learns. Silent.
- Reverse the order (publish first, then DB) and a crash between them means you **published an
  event for an order that doesn't exist** → downstream acts on a phantom.
- Even retrying the publish risks **duplicates**. There is no ordering of two independent
  writes that is safe — that's the whole problem.

**The solution: the Transactional Outbox pattern.** Collapse the two writes into **one
atomic database transaction** by writing the event *into the same database*:

```
 BEGIN TX
   INSERT INTO orders         (...)         -- the business state change
   INSERT INTO outbox (event, status='NEW') -- the event, SAME transaction
 COMMIT                                      -- both or neither, atomically
```

Because both inserts are in **one local ACID transaction** (R1.Q2), they're **atomic** — you
can never have an order without its event or vice versa. The dual-write is gone; there's only
a single write now. Then a **separate relay** moves outbox rows to Kafka:

```
 outbox table ──[relay]──▶ Kafka
   relay reads NEW rows, publishes, marks them SENT (or deletes)
```

Two ways to build the relay:
1. **Polling publisher** — a background worker `SELECT`s `status='NEW'` rows, publishes to
   Kafka, marks them `SENT`. Simple, but polling lag and load.
2. **CDC / log tailing (the better one)** — **Debezium** tails the database's **WAL / binlog**
   (R2 territory — the replication log InnoDB already writes) and streams outbox inserts to
   Kafka. No polling, low latency, and it reads the *already-durable* commit log so it can't
   miss a committed row.

**Interviewer:** The relay publishes to Kafka, then crashes before marking the row `SENT`. On
restart it republishes. You just created a duplicate. So where did exactly-once go?

**Candidate:** Exactly — and this is the crux: **the outbox guarantees at-least-once, not
exactly-once.** The relay→Kafka step *can* duplicate (crash after publish, before marking
sent → republish on restart). That's unavoidable for the same Two Generals reason (R1.Q6) —
which is *why I never promised the delivery would be exactly-once.* I close it the only way
the network ever allows: **at-least-once delivery + idempotency at the destination**, just
like everywhere else in this loop.

Two reinforcing layers handle the duplicate:
1. **Producer-side dedup:** publish with Kafka's **idempotent producer** (R3.Q3) — a stable
   producer id + a deterministic **sequence/message key derived from the outbox row's id** —
   so the broker dedups a republish of the *same* event within a partition. This catches the
   relay's own retries.
2. **Consumer-side idempotency (the durable guarantee):** each event carries a **unique
   idempotency key** (the outbox row id / event id). The **downstream consumer** records
   processed ids and makes processing idempotent:
   ```
   process(event):
     if already_processed(event.id): return        -- dedup
     BEGIN TX
       apply business effect
       INSERT INTO processed_events (event.id)      -- same TX as the effect
     COMMIT
   ```
   The **"inbox" pattern**: record "I processed event X" **in the same transaction as the
   effect** of processing it, so a redelivery finds the id already present and **no-ops**.
   This is the mirror image of the outbox, and it's what makes the *effect* exactly-once even
   though *delivery* was at-least-once.

So the full picture, boundary to boundary:
```
 producer side          transport         consumer side
 ┌─ outbox (atomic ─┐    Kafka (at-     ┌─ inbox/idempotency key ─┐
 │  with business   │──▶ least-once, ──▶│  dedup in same TX as     │
 │  write)          │    idempotent     │  the effect              │
 └──────────────────┘    producer)      └──────────────────────────┘
   guarantees the         de-dups          guarantees the EFFECT
   event is never lost     retries          happens exactly once
```

The honest summary I'd give: **you cannot get exactly-once *delivery* across a DB and Kafka —
no distributed transaction, Two Generals forbids it. What you build is exactly-once
*processing*: (1) the outbox makes "state changed" and "event recorded" atomic in one DB
transaction so nothing is ever lost; (2) at-least-once delivery via the relay + idempotent
producer; (3) the inbox/idempotency key on the consumer makes duplicate delivery a no-op so
the *effect* lands once.** It's the exact pattern from R1.Q6 and R3.Q3 — at-least-once +
idempotency — applied at the boundary Kafka's own transactions can't cross. There's no magic;
there's discipline: never dual-write, always make the dedup record part of the same
transaction as the thing it guards.

──────────
> **[BANK]** Dual-write (DB then Kafka) silently loses events on a crash between them — never
> do it. **Transactional outbox:** write business row + event row in **one DB transaction**
> (atomic, nothing lost), then a relay (polling or Debezium/CDC tailing the WAL) publishes —
> this is at-least-once. Close it with **consumer-side idempotency / inbox**: dedup on a
> unique event id, recorded **in the same transaction as the effect**. Net: exactly-once
> *processing* from outbox (no loss) + idempotent consumer (no dup effect).
> **[TRAP]** Believing the outbox alone gives exactly-once (the relay can still duplicate —
> you need consumer idempotency), or doing the naive dual-write at all.
> **[GO DEEPER]** [R3.Q3] Kafka's idempotent producer + closed-world EOS · [R1.Q6] at-least-
> once + idempotency · [R3.Q7] sagas (outbox is how saga steps emit events reliably).

---

### [R5.Q6] "Everyone wants an LLM in the product. When do you say no?"  ·  `AI` · ★★★★☆

**Interviewer:** Round 4 you clearly know how to serve LLMs. Product wants to put one
everywhere. As the engineer in the room, when do you push back and say "an LLM is the wrong
tool here"?

**Candidate:** Often — and being the person who says "this doesn't need an LLM" is a
*senior* contribution, not a Luddite one, because an LLM is an expensive, slow, non-
deterministic component and most problems people point it at have a cheaper, better-behaved
solution. I'd push back when the problem has any of these shapes:

1. **The task is deterministic and rule-expressible.** If the answer is a lookup, a
   calculation, a regex, a SQL query, or a finite set of business rules — **use code.** "Is
   this order eligible for free shipping?" is an `if` statement, not a prompt. An LLM here is
   slower, costs money per call, and will *occasionally get the deterministic answer wrong* —
   strictly worse on every axis. The reflex "throw an LLM at it" often replaces a 1ms
   deterministic function with a 2-second probabilistic one that's sometimes incorrect.

2. **Correctness must be guaranteed.** LLMs are **probabilistic and hallucinate** (R4.Q4);
   they have no guarantee of correctness. For anything where a wrong answer is unacceptable
   and unverifiable — medical dosing, legal/financial calculations, security decisions,
   anything regulated — an LLM as the *decision-maker* is disqualified. It can *assist* (draft,
   summarize, surface) with a human or a deterministic check in the loop, but it can't *be*
   the authority. "Confidently wrong" (R4.Q4) is a fundamental property, not a bug to be
   prompted away.

3. **Latency or cost is tight.** LLM inference is hundreds of ms to seconds and costs real
   money per token (R4.Q2/Q5). On a high-QPS hot path with a tight latency budget or thin
   margins, an LLM call per request may be economically or latency-wise infeasible — a
   smaller model, an embedding-similarity lookup, or a classical ML classifier may give 95%
   of the value at 1% of the cost and 100× the speed.

4. **A smaller, classical model is a better fit.** Lots of "AI" tasks — classification,
   sentiment, spam detection, ranking, named-entity extraction, anomaly detection — are
   solved better, cheaper, faster, and *more predictably* by **traditional ML** (gradient-
   boosted trees, a fine-tuned small encoder, logistic regression) than by a giant
   generative LLM. Using a 70B model to classify text into 3 buckets is using a
   sledgehammer as a scalpel.

5. **Explainability / auditability is required.** If you must explain *why* a decision was
   made (loan denial, content moderation appeals, anything legally challengeable), an LLM's
   opaque reasoning is a liability; a rules engine or an interpretable model is defensible in
   a way "the model said so" never is.

**Interviewer:** So where is an LLM actually the *right* call?

**Candidate:** Where the problem genuinely has the properties LLMs uniquely provide, and the
failure mode is tolerable:
- **Open-ended natural language** — generation, summarization, translation, rewriting,
  extraction from messy unstructured text — tasks with **no closed-form rule** and high
  variability that classical methods handle poorly.
- **Where some error is acceptable** and there's a **human in the loop** or easy verification
  — a draft the user edits, a suggestion they accept/reject, a first-pass triage a person
  reviews. The LLM accelerates a human rather than replacing a guarantee.
- **Where the alternative is "nothing"** — tasks that previously *couldn't* be automated at
  all because they required language understanding; here even an imperfect LLM is a step
  change.
- **As one component, gated** — an LLM *plus* retrieval for grounding (R4.Q4), *plus* a
  deterministic validator on its output, *plus* a confidence/relevance gate to abstain. The
  LLM does the language-shaped part and code guards the correctness-shaped part.

So my pushback framing: **"What's the simplest thing that solves this — is it a rule, a query,
a small classical model, or genuinely an open-ended-language problem? And what happens when
the LLM is wrong?"** If a deterministic solution exists, use it; if correctness must be
guaranteed, the LLM can assist but not decide; if it's open-ended language with a tolerable,
verifiable failure mode, the LLM earns its place — ideally gated by retrieval and a validator.
The senior move is matching the tool to the problem's *correctness and cost requirements*,
and being willing to be the person who says "this is an `if` statement" when the room is
excited about AI. Knowing how to *serve* LLMs well (R4) is exactly what lets me credibly say
when *not* to.

──────────
> **[BANK]** Say no to an LLM when the task is **deterministic/rule-expressible** (use code —
> a 1ms function beats a 2s sometimes-wrong prompt), when **correctness must be guaranteed**
> (LLMs hallucinate → assist, never decide, for regulated/medical/financial), when
> **latency/cost is tight**, when a **classical ML model fits better** (classification/
> ranking/NER), or when **auditability** is required. Say yes for **open-ended language**
> (generation/summarization/extraction) with a **tolerable, verifiable failure mode** and a
> human-in-loop, ideally gated by retrieval + a deterministic validator.
> **[TRAP]** "Throw an LLM at it" reflexively — replacing a fast deterministic function with a
> slow probabilistic one that's occasionally wrong, on a problem that was an `if` statement.
> **[GO DEEPER]** [R4.Q4] RAG/hallucination · [R4.Q2/Q5] the real cost/latency of serving ·
> [R1.Q5] when an *embedding* (not generation) is the right primitive.

---

### [R5.Q7] "The architect wants strong consistency. You want low latency. You both have a point. What do you do?"  ·  `DIST` · ★★★★★

**Interviewer:** Final one. A senior architect insists a new feature must be **strongly
consistent**. You believe that forces a latency cost the product can't afford, and that
**eventual consistency** is the right call. You're both experienced; you both have real
arguments. No clean technical answer. What do you actually do?

**Candidate:** This is a **disagree-and-commit** situation, and the worst thing I can do is
either steamroll with my opinion or silently cave — both are seniority failures. The whole
test is whether I can navigate a genuine technical disagreement with a respected peer
*productively*. Here's how I'd run it:

**1. Make the disagreement concrete, not abstract.** "Strong vs eventual" is a religious war
in the abstract and a solvable engineering question in the specific. So I'd first **pin down
exactly which data and which operations** we're arguing about — because the answer is almost
always *per-operation*, not global (R1.Q2's "polyglot" point). The architect may be right
that the *core write* needs linearizability while I'm right that the *read-heavy display
path* tolerates staleness. Often the "disagreement" dissolves once you stop saying "the
system" and start naming individual flows. **Reframe from "which philosophy wins" to "which
guarantee does *this specific operation* actually need."**

**2. Replace opinions with the real numbers and the real requirement.** My latency claim and
the architect's consistency claim are both currently *assertions*. I'd make them measurable:
- What's the **actual latency cost** of strong consistency *here*? Quantify it (R1.Q3's
  PACELC — the cross-region/quorum round-trips). "It'll be slow" → "a linearizable read here
  is +40ms cross-region; the product budget is 100ms, so it fits" — and the argument is
  *over*, the architect was right and it's cheap. Or "+40ms breaks a 50ms budget" — now I have
  evidence, not vibes.
- What does the **business/product** actually require? Go to the source: is a few seconds of
  staleness *actually* a problem for *this* feature, or are we both guessing about user
  impact? Sometimes product says "this is money, it must be correct" (architect wins) and
  sometimes "it's a view count, nobody cares" (I win). **The requirement, not the engineers,
  should decide.**

**3. Look for the design that dissolves the tradeoff.** The best outcome isn't "I win" — it's
a third option neither of us defended:
- **Strong where it matters, eventual where it doesn't** — strongly-consistent writes to the
  source of truth, eventually-consistent read replicas/caches for display. Most large systems
  *are* this hybrid.
- **Read-your-own-writes** consistency (a session guarantee) — often the user only needs to
  see *their own* changes immediately, which is far cheaper than global linearizability and
  may satisfy the architect's real concern (user confusion) without the full cost.
- **CRDTs / mergeable types** if the issue is concurrent writes (R5.Q2) — get availability
  *and* convergence for the right data shape.

Very often this collapses the disagreement: the architect's real fear ("users see stale
data and get confused / we corrupt money") and my real fear ("the hot path is too slow") are
**both addressable** by a targeted hybrid, and we were arguing about a global label when the
answer was per-flow.

**Interviewer:** Say you do all of that — concrete, measured, hunted for the hybrid — and you
*still* genuinely disagree. The data's ambiguous, both designs are defensible, and the
architect outranks you. Now what?

**Candidate:** Then it's a true judgment call, and this is the part most engineers handle
badly — so here's the discipline.

**4. If it genuinely doesn't resolve — disagree and commit.** Both designs are defensible and
the input is ambiguous. Then:
- I make my case **once, clearly, in writing** — the tradeoff, the numbers, the risk I see —
  so it's on record and the decision is *informed*.
- If the architect, who may have **context I lack** (regulatory, strategic, history of this
  exact mistake), still chooses strong consistency, **I commit fully and execute it as if it
  were my own idea** — no passive resistance, no "I told you so" insurance. A team where the
  most senior reasonable voice prevails on a genuine toss-up and everyone commits **moves
  faster** than one that re-litigates every call.
- And I'd make the decision **reversible if I can** — build it so we can measure the real
  latency in production and **revisit with data** if my concern materializes. "Let's ship the
  consistent version, instrument the latency, and if it breaches budget we have the hybrid
  ready" turns an unresolvable argument into a cheap experiment. Strong opinions, **weakly
  held**; and **two-way doors** (reversible decisions) deserve far less agonizing than one-way
  doors.

The bar-raiser is watching for a specific thing here: **do I treat a peer disagreement as a
contest to win or a problem to solve?** The answer that earns the offer is — make it
concrete and per-operation, replace opinions with measured numbers and the actual product
requirement, hunt for the hybrid that dissolves the tradeoff, and if it's still a genuine
judgment call, make my case once and then **commit wholeheartedly to the decision, ideally
built to be reversible with data.** Being *right* matters less than being someone a strong
team can disagree with and still move fast alongside. The engineer who can't lose an argument
gracefully is a worse hire than the one who's slightly less right but makes everyone around
them more effective.

──────────
> **[BANK]** Genuine consistency-vs-latency disagreement with a peer = disagree-and-commit,
> run as: (1) make it **concrete & per-operation** (not "the system" — which *flow* needs
> which guarantee; usually polyglot); (2) replace opinions with **measured latency + the
> actual product requirement**; (3) hunt the **hybrid that dissolves it** (strong source of
> truth + eventual read replicas, read-your-writes, CRDTs); (4) if still unresolved, make the
> case **once in writing**, then **commit fully**, and make it **reversible/instrumented** so
> data can revisit it. Two-way doors deserve less agonizing.
> **[TRAP]** Treating it as a contest — steamrolling *or* silently caving (both seniority
> failures), arguing global philosophy instead of per-operation, and fighting with assertions
> instead of numbers + the product requirement.
> **[GO DEEPER]** [R1.Q3] PACELC (the latency cost to quantify) · [R1.Q2] polyglot/per-data ·
> [R5.Q2] CRDTs · [R5.Q1] strong-opinions-weakly-held discipline.

---

## Round 5 — closing note from the panel

The bar-raiser never asked a question with a clean answer — every one was "defend your earlier
self," "recover the unrecoverable," "argue against your own claim," "choose under real
ambiguity." That's deliberate: by R5 the panel knows the candidate has the knowledge; what
they're pricing is **judgment, humility, and the ability to be wrong gracefully.** The
through-line of the whole loop lands here — the strongest engineers don't *win* with facts,
they **reason from constraints, name the tradeoff they're choosing, change their mind when the
numbers change, and commit to a team decision even when they'd have chosen differently.** The
offer goes to the person you'd want in the room when the answer *isn't* in any book — including
this one.

— *End of loop. Return to the [index](./00-index.md), or revisit the
[glossary](./A-glossary.md) for every `[BANK]` card in one place.*
