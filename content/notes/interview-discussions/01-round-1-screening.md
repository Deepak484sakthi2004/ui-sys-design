# Round 1 — Screening

> **The panel:** One senior engineer, 45 minutes, video call. This isn't where you win
> the offer — it's where you *avoid losing it*. The questions look easy. The trap is
> answering them like they're easy. A principal candidate takes a "definition" question
> and, in two sentences, shows they understand the mechanism and the tradeoff underneath
> it — without being asked. That's the signal: depth that arrives *unprompted*.

Difficulty band: ★★ — ★★★. Eight exchanges, brisk but each still goes one level past the
definition.

Domains touched: `NET` `DB` `DIST` `JVM` `AI` `PS`.

---

### [R1.Q1] "Quickly — what are the OSI layers, and which ones do you actually touch?"  ·  `NET` · ★★☆☆☆

**Interviewer:** Give me the OSI model. Fast.

**Candidate:** Seven layers, bottom to top — **Physical, Data Link, Network, Transport,
Session, Presentation, Application** ("Please Do Not Throw Sausage Pizza Away"). But the
honest framing is that OSI is a *teaching* model; the real world runs the **TCP/IP
model**, which collapses it to four: Link, Internet (IP), Transport (TCP/UDP), and
Application — where OSI's top three (session, presentation, application) all fold into one
"application" layer.

What I actually touch day to day:
- **Network (L3): IP** — addressing and routing, best-effort, no delivery guarantee.
- **Transport (L4): TCP/UDP** — TCP adds reliability, ordering, flow & congestion control;
  UDP is fire-and-forget.
- **Application (L7): HTTP, gRPC, the MySQL protocol, DNS** — the actual conversation.

**Interviewer:** Where do TLS and a load balancer sit in that picture?

**Candidate:** Both are good examples of the model being fuzzy in practice. **TLS** doesn't
map cleanly — it sits *between* transport and application: it rides on top of TCP (L4) but
*below* HTTP, so HTTP becomes HTTPS without knowing TLS is there. In OSI terms people call
it L5/L6 (session/presentation), but really it's "above TCP, below the app protocol."

A **load balancer** is described by the layer it makes decisions at:
- An **L4 load balancer** routes on IP + port only — it forwards TCP connections without
  looking inside, so it's fast and protocol-agnostic but can't route on URL or cookie.
- An **L7 load balancer** terminates the connection, reads the *application* data (HTTP
  path, headers, host), and routes on that — so it can do path-based routing, sticky
  sessions, and TLS termination, at the cost of parsing every request. "L4 vs L7 LB" is
  shorthand for exactly this: how deep into the stack does the router look before it
  decides where to send you.

──────────
> **[BANK]** OSI = 7 layers (teaching); TCP/IP = 4 (real). The ones you touch: IP (L3),
> TCP/UDP (L4), app protocols (L7). TLS sits between L4 and L7. L4 LB = IP/port; L7 LB =
> reads HTTP, routes on path/host.
> **[TRAP]** Reciting all seven layers and nothing else. The interviewer wants to know you
> can *place* a real technology (TLS, a LB, QUIC) in the model.
> **[GO DEEPER]** [R2.Q1] the app protocol over TCP · [R2.Q2] where TLS fits, in bytes.

---

### [R1.Q2] "ACID — and is it the only option?"  ·  `DB` · ★★☆☆☆

**Interviewer:** What does ACID stand for, and why should a developer care?

**Candidate:** **Atomicity, Consistency, Isolation, Durability** — the guarantees a
transactional database makes:
- **Atomicity:** all-or-nothing. The transaction commits fully or not at all; a crash
  mid-way rolls back. (Mechanically: the undo log / rollback segment.)
- **Consistency:** the transaction moves the DB from one valid state to another, respecting
  constraints (FKs, uniqueness, checks). Note this "C" is the odd one out — it's largely an
  *application* property the DB helps enforce, not a storage mechanism like the others.
- **Isolation:** concurrent transactions don't step on each other; the result is *as if*
  they ran in some serial order (to the degree your isolation level promises).
- **Durability:** once committed, it survives a crash — guaranteed by the write-ahead log
  being `fsync`ed to stable storage before the commit returns.

The reason to care: ACID lets you *reason locally*. You write `UPDATE balance` and `INSERT
ledger` and trust they happen together or not at all, instead of hand-coding crash
recovery.

**Interviewer:** And BASE? When would you give up ACID on purpose?

**Candidate:** **BASE — Basically Available, Soft state, Eventually consistent** — is the
philosophy of many distributed NoSQL stores (Dynamo, Cassandra). You *deliberately* relax
the strong "I" and immediate "C" to gain **availability and horizontal scale**. Instead of
"every read sees the latest write, always," you get "every read eventually converges,
and the system stays up even when nodes are partitioned."

You give up ACID on purpose when:
- **Scale demands it** — a single ACID node can't hold your data or your write rate, and
  distributed ACID (2PC across shards) is slow and fragile.
- **The domain tolerates staleness** — a like-count, a feed, a "last seen" timestamp,
  product reviews. A few seconds of inconsistency is invisible to users and not worth a
  cross-region lock.

The mental model: **ACID and BASE are endpoints of a spectrum, and the right answer is
per-workload.** Money and inventory want ACID. Feeds and counters are fine with BASE. The
senior move is *not* "NoSQL scales so use it everywhere" — it's matching the consistency
need of each piece of data to the cost you're willing to pay. Most real systems are
**polyglot**: ACID Postgres for the orders, an eventually-consistent store for the
activity feed.

──────────
> **[BANK]** ACID = Atomicity (undo log), Consistency (constraints), Isolation (levels),
> Durability (fsync'd WAL). BASE trades strong isolation/immediate consistency for
> availability + scale. Pick per-data: money→ACID, feeds/counters→BASE.
> **[TRAP]** Saying "NoSQL is faster/more scalable so it's better." It trades guarantees
> you may need. Also: not knowing the "C" in ACID is mostly app-enforced.
> **[GO DEEPER]** [R2.Q6] how isolation is actually implemented (MVCC) · [R1.Q3] CAP · [R3]
> distributed transactions.

---

### [R1.Q3] "State CAP in one sentence — then tell me why it's misleading"  ·  `DIST` · ★★★☆☆

**Interviewer:** CAP theorem in one sentence.

**Candidate:** In the presence of a network **P**artition, a distributed system must choose
between **C**onsistency (every read sees the latest write) and **A**vailability (every
request gets a non-error response) — you can't have both while partitioned.

The one-sentence version everyone memorizes — "pick two of three" — is the misleading
part. **P is not optional.** Networks partition; you don't get to "choose" CP by deciding
partitions won't happen. So the real choice is binary and only matters *during* a
partition: when nodes can't talk, do you **refuse to answer** to stay consistent (CP), or
**answer with possibly-stale data** to stay available (AP)? When there's no partition, you
get both C and A — CAP says nothing about the normal case.

**Interviewer:** So if CAP only describes the partition case, what governs the
*non*-partition tradeoff — which is most of the time?

**Candidate:** **PACELC**, which is the upgrade every senior engineer should reach for. It
reads: *if* **P**artition, choose **A** or **C** (the CAP part); **E**lse (normal
operation), choose **L**atency or **C**onsistency. That second clause is the one that
actually dominates your design, because partitions are rare but you make the latency-vs-
consistency tradeoff on *every single request.*

Concretely: a strongly consistent read in a replicated system means contacting a quorum
(or the leader), which costs **latency** — extra round-trips, maybe cross-region. A fast,
local read from the nearest replica risks returning **stale** data. So:
- **Dynamo/Cassandra** are **PA/EL** — available under partition, and low-latency
  (eventually consistent) otherwise.
- **A traditional consistent store / spanner-like system** is **PC/EC** — consistent
  under partition, consistent (and thus higher-latency) otherwise.

PACELC is the better interview vocabulary because it forces you to talk about the
*common-case* cost, not just the rare failure. "We're CP" is half an answer; "we're CP
under partition and we accept the cross-region read latency in the normal case to stay
linearizable" is the whole one.

──────────
> **[BANK]** CAP: under a partition, choose Consistency or Availability (P isn't optional).
> PACELC extends it: Else (no partition) choose Latency or Consistency — and *that's* the
> tradeoff you actually make on every request. Dynamo = PA/EL, Spanner-like = PC/EC.
> **[TRAP]** "Pick two of three" as if P were a choice, and ignoring the normal-case
> latency/consistency tradeoff that PACELC names.
> **[GO DEEPER]** [R3] quorums and how "consistency" is actually purchased · [R5] split-
> brain recovery.

---

### [R1.Q4] "Heap vs stack — and why does autoboxing show up in my profiler?"  ·  `JVM` · ★★★☆☆

**Interviewer:** Heap versus stack in the JVM. Then explain why someone's `Map<Integer,
Integer>` is allocating like crazy.

**Candidate:** Two different memory regions with different lifetimes and management:

- **Stack:** per-thread, holds stack frames — local variables, operand stack, return
  addresses. Allocation is just bumping a pointer; deallocation is automatic when the
  method returns (pop the frame). It holds **primitives** and **references** (the pointer),
  not objects. Fast, thread-private, no GC. It's also bounded — deep/infinite recursion
  blows it → `StackOverflowError`.
- **Heap:** shared across all threads, holds **objects**. Managed by the garbage collector.
  Slower to allocate (though TLABs make it fast), and the source of GC pauses. This is
  where `new` anything lands.

So `int x = 5` lives on the stack; `Integer x = 5` puts an `Integer` *object* on the heap
and a reference to it on the stack.

That last distinction is the autoboxing answer. A `Map<Integer, Integer>` **cannot store
primitives** — generics only work over reference types — so every `int` you put in gets
**autoboxed** into a heap-allocated `Integer`. A loop that does `map.merge(k, 1,
Integer::sum)` a million times allocates a million `Integer` objects, churning the young
generation and showing up as constant minor GC in the profiler. Worse, each `Integer` is a
16-byte heap object (header + the int + padding) versus 4 bytes for a raw `int`, and the
map stores *references* to them scattered across the heap, destroying cache locality
compared to a primitive array.

**Interviewer:** What's the fix, and is there a subtlety in *which* boxed values are
expensive?

**Candidate:** The fix is **don't box in the hot path**: use primitive-specialized
collections — `int[]`, or a library like Eclipse Collections / fastutil / Koloboke that
provides `IntIntHashMap` storing primitives directly. The JDK gives you `IntStream`,
`LongStream`, and `java.util.OptionalInt` for the same reason — to keep `int` off the heap.

The subtlety is the **`Integer` cache**. The JVM pre-allocates and **caches boxed `Integer`
values from −128 to +127** (the `IntegerCache`), so `Integer.valueOf(100)` returns a shared
cached instance — autoboxing in that range is *free* of allocation. Outside that range,
`Integer.valueOf(1000)` allocates a fresh object every time. This is also the source of the
infamous `==` bug:

```java
Integer a = 127, b = 127;   a == b  → true   (same cached object)
Integer a = 128, b = 128;   a == b  → false  (two different heap objects)
```

So `==` on boxed integers compares *references* and "works" up to 127 then silently breaks
— which is why you always use `.equals()` (or unbox) for value comparison. The two lessons
land together: autoboxing costs allocations *and* introduces identity-vs-value bugs, and
the −128..127 cache is the reason both behave inconsistently in exactly the range your unit
tests probably use.

──────────
> **[BANK]** Stack = per-thread frames, primitives + references, auto-freed, no GC. Heap =
> shared objects, GC-managed. Generic collections can't hold primitives → autoboxing
> allocates an `Integer` per value (16 B vs 4 B, scattered). Fix: primitive collections.
> `Integer` caches −128..127, so `==` "works" then breaks — use `.equals()`.
> **[TRAP]** Saying "objects go on the heap, primitives on the stack" and stopping — miss
> that a primitive *field of a heap object* lives on the heap, and miss the autoboxing
> cost entirely.
> **[GO DEEPER]** [R2.Q7] the 16-byte object header that makes boxing expensive · [R2.Q8]
> the GC that cleans up the garbage.

---

### [R1.Q5] "Training, inference, embedding — keep them straight for me"  ·  `AI` · ★★★☆☆

**Interviewer:** A backend engineer joins an ML team. Distinguish training, inference, and
an embedding — and tell me which one you, the systems person, mostly care about.

**Candidate:** Three different activities with very different systems profiles:

- **Training:** learning the model's parameters (weights) from data by gradient descent —
  forward pass, compute loss, backprop the gradients, update weights, repeat over millions
  of examples. It's **throughput-bound, batch, offline**, runs for hours-to-weeks on big
  GPU/TPU clusters, and is enormously expensive. You do it rarely.
- **Inference:** *using* the trained model to produce an output for a new input — one
  forward pass, no weight updates. It's **latency-sensitive and online** (a user is
  waiting), runs continuously in production, and its cost is dominated by serving it cheaply
  at scale. This is the part that looks like a normal high-QPS service with unusual
  hardware.
- **Embedding:** a *representation* — a fixed-length vector of floats (say 768 or 1536
  dims) that a model produces to capture the *meaning* of an input (a word, sentence,
  image, user). Similar things land near each other in vector space, so you can measure
  semantic similarity with cosine distance. An embedding is usually a *by-product of
  inference* — you run the input through a model and take an internal/output vector.

Which one I care about: **inference and embeddings**, overwhelmingly. Training is the data-
science team's GPU-cluster problem. *Serving* inference at low latency and high QPS, and
*storing and searching* embeddings at scale, are systems problems — batching, caching, GPU
memory, vector indexes, tail latency. That's where a backend/infra engineer adds the value.

**Interviewer:** You said embeddings let you measure similarity. What does that unlock in a
system, in one concrete pattern?

**Candidate:** The headline pattern is **semantic search / retrieval**, and its current
star application is **RAG — Retrieval-Augmented Generation.** The idea: you can't fit your
whole knowledge base in an LLM's prompt, and the model's training data is stale, so instead
you:
1. **Offline:** embed all your documents into vectors and store them in a **vector
   database** (or a vector index like FAISS/HNSW).
2. **Online:** when a user asks a question, embed the *question*, find the **nearest
   document vectors** (semantically closest, not keyword-matched), and **stuff those
   documents into the LLM's prompt** as context.
3. The LLM answers *grounded in your retrieved data* instead of from memory — which reduces
   hallucination and lets it cite fresh, private information it was never trained on.

So embeddings turn "find me semantically relevant content" into a **nearest-neighbour
search in vector space**, and that search — at millions of vectors, with low latency — is a
pure systems problem (indexing, recall-vs-latency, sharding the index). That's the bridge
between "AI" and "the infra I already know how to build." The deeper version of all of this
— how the vector index actually works, how you serve the LLM cheaply — is the R4 material.

──────────
> **[BANK]** Training = learn weights (offline, throughput-bound, expensive, rare).
> Inference = use weights for one forward pass (online, latency-bound, continuous).
> Embedding = a vector capturing meaning; nearest-neighbour in vector space = semantic
> search → RAG. Infra engineers own inference serving + the vector index, not training.
> **[TRAP]** Conflating inference with training ("the model learns from each request" — it
> doesn't, weights are frozen at serving time), or thinking embeddings are keyword
> indexes.
> **[GO DEEPER]** [R4] KV cache, batching, HNSW/IVF, the real RAG failure modes.

---

### [R1.Q6] "Queue vs topic, and the three delivery guarantees"  ·  `PS` · ★★★☆☆

**Interviewer:** Messaging 101. What's the difference between a queue and a topic, and what
are the delivery semantics?

**Candidate:** It's about **fan-out** — how many consumers see each message:

- **Queue (point-to-point):** each message is delivered to **exactly one** consumer among
  those reading the queue. Multiple consumers means **competing consumers** — they share
  the load, each message goes to whoever grabs it first. This is a **work-distribution**
  pattern: N workers draining a task queue. (Classic RabbitMQ queue, SQS.)
- **Topic (publish/subscribe):** each message is delivered to **every** subscriber. N
  independent subscribers each get their own copy. This is an **event-broadcast** pattern:
  one "order placed" event fans out to billing, shipping, and analytics, each reacting
  independently. (Kafka topic, SNS, MQTT topic.)

Kafka blurs the line elegantly with **consumer groups**: a topic is pub/sub *across*
groups (every group gets all messages) but a queue *within* a group (the partitions are
divided among that group's consumers, so each message goes to one consumer in the group).
So Kafka gives you both axes at once — broadcast between teams, load-balance within a team.

**Interviewer:** Now the delivery guarantees — name them and tell me which one is a lie.

**Candidate:** Three semantics, defined by how the system handles failure and retries:

- **At-most-once:** deliver and don't retry. If the consumer crashes before processing,
  the message is **lost**. No duplicates, possible loss. (Fire-and-forget; fine for
  metrics where a dropped sample is harmless.)
- **At-least-once:** retry until acknowledged. If the ack is lost or the consumer crashes
  after processing but before acking, the message is **redelivered** → **possible
  duplicates**, never lost. This is the **default and the right default** for most systems,
  because losing data is usually worse than seeing it twice.
- **Exactly-once:** each message takes effect once — no loss, no duplicates.

The "lie" is **exactly-once delivery**. In a distributed system with crashes and network
loss, you fundamentally cannot guarantee a message is *delivered and processed* exactly
once — the **Two Generals problem** says the sender can never be certain the receiver got
it, so it must either risk loss (stop retrying) or risk duplicates (keep retrying). What
systems *actually* provide is **exactly-once *processing semantics***, built as
**at-least-once delivery + idempotency**: you accept that messages may be delivered twice,
and you make *processing* a duplicate a no-op — via an idempotency key, a dedup table, or
(in Kafka) the transactional/idempotent-producer machinery that makes the *effect* exactly
once even though delivery is at-least-once. So the senior framing is: **"exactly-once" is a
property you engineer on top of at-least-once with idempotency, not a delivery guarantee
the network can give you.**

──────────
> **[BANK]** Queue = 1 message → 1 consumer (work sharing). Topic = 1 message → all
> subscribers (broadcast). Kafka consumer groups = pub/sub across groups, queue within.
> Delivery: at-most-once (lossy), at-least-once (dup-prone, the default), exactly-once =
> a lie at the delivery layer — it's at-least-once + idempotency at the processing layer.
> **[TRAP]** Claiming a system gives "exactly-once delivery." It gives exactly-once
> *processing* via idempotency. Two Generals says delivery can't be exactly-once.
> **[GO DEEPER]** [R3] Kafka's idempotent producer & transactions, ISR/offsets · [R5]
> exactly-once across a pub/sub→DB boundary (outbox).

---

### [R1.Q7] "What is an index, really — and when does adding one make things worse?"  ·  `DB` · ★★★☆☆

**Interviewer:** Explain a database index to me like I half-forgot it. Then: when does
adding one *hurt*?

**Candidate:** An index is a **separate, sorted data structure that maps column values to
the rows that hold them**, so the database can find rows by value without scanning the whole
table. Without an index, `WHERE email = ?` is a **full table scan** — read every row,
O(n). With a B+tree index on `email`, it's a tree descent — O(log n), a few page reads. The
index trades **space and write cost** for **read speed**: it's a sorted copy of one (or a
few) columns plus a pointer back to the row.

Because it's *sorted*, an index accelerates more than equality: range scans (`WHERE ts >
?`), prefix matches (`LIKE 'abc%'`), `ORDER BY`, `GROUP BY`, and `MIN`/`MAX` — anything that
benefits from data already being in order. (A *hash* index would do equality in O(1) but
none of the ordered operations, which is why B+tree is the default.)

**Interviewer:** So why not index every column? When does it backfire?

**Candidate:** Because an index is **not free — it's a second structure the database must
keep in sync on every write.** Adding indexes hurts in several concrete ways:

1. **Write amplification.** Every `INSERT`/`UPDATE`/`DELETE` must update *every* index on
   the affected columns — insert into each index's B+tree, possibly splitting pages. Ten
   indexes means a single-row insert touches eleven B+trees (the table + ten indexes). On a
   write-heavy table, over-indexing tanks write throughput.
2. **Space.** Each index is a full sorted copy of its columns plus the row locator. Indexes
   can easily exceed the size of the table itself, bloating disk and, worse, the buffer
   pool — every page an index occupies in RAM is a page of actual data that *isn't* cached.
3. **The optimizer can pick wrong.** More indexes means more plans to consider, and the
   query planner can choose a poor index, or thrash between them as statistics shift.
4. **Low-selectivity indexes are useless.** An index on a boolean or a status with three
   values (`active`/`inactive`/`deleted`) barely narrows anything — the planner will often
   ignore it and full-scan anyway, so you paid the write cost for nothing. Indexes pay off
   on **high-selectivity** columns (many distinct values, like email or user_id).

The discipline: index for your **actual read patterns** (the `WHERE`, `JOIN`, and `ORDER
BY` columns in your real queries), prefer **composite indexes** that cover a query's
filter+sort together, lean on **covering indexes** to skip the row lookup — and then
*remove* indexes that `EXPLAIN` shows are never chosen. Every index is a standing tax on
every write, justified only by reads that actually use it. "Add an index" is the junior
reflex; "audit which indexes are *earning their keep*" is the senior one.

──────────
> **[BANK]** An index = a sorted secondary structure (B+tree) mapping values → rows; turns
> O(n) scans into O(log n) lookups and accelerates ranges/ORDER BY. Cost: every write
> updates every index (write amplification) + space + buffer-pool pressure. Index high-
> selectivity columns for real query patterns; drop indexes `EXPLAIN` never uses.
> **[TRAP]** "Add an index to make it fast" with no thought to write cost, selectivity, or
> whether the planner will even use it.
> **[GO DEEPER]** [R2.Q4] the B+tree internals + covering indexes + the PK-locator double
> lookup · [R1.Q2] the durability/consistency these support.

---

### [R1.Q8] "Process vs thread — and what's actually shared?"  ·  `JVM` · ★★★☆☆

**Interviewer:** Process versus thread. Then tell me what a context switch actually costs.

**Candidate:** A **process** is an isolated execution container with its **own virtual
address space**, file descriptors, and resources — the OS gives it the illusion of owning
the whole machine. A **thread** is a unit of execution *within* a process; threads of one
process **share the process's address space** — the same heap, the same globals, the same
file descriptors — but each has its **own stack, registers, and program counter**.

That sharing is the whole point and the whole danger:
- **Shared:** heap (objects), static/global data, open files, code. Two threads can read
  and write the same object — which is why you need synchronization, and why all the JMM /
  `volatile` / false-sharing concerns from R2 exist.
- **Private:** stack (local variables, call frames), registers, PC, thread-local storage.

Communication between **threads** is cheap — they just touch shared memory. Communication
between **processes** needs explicit IPC (pipes, sockets, shared memory segments, signals)
because their address spaces are walled off. That isolation is also a *safety* feature: one
process crashing doesn't corrupt another; one *thread* corrupting shared state can take down
the whole process.

**Interviewer:** You mentioned context switches. Why is a thread switch cheaper than a
process switch, and why is *any* switch surprisingly expensive?

**Candidate:** A **thread switch within the same process** is cheaper because the threads
share an address space — the OS saves/restores the registers and stack pointer, but it
**doesn't have to swap the page tables**, so the **TLB** (the cache that maps virtual →
physical addresses) stays valid. A **process switch** changes the address space, so the OS
reloads the page-table base register (`CR3` on x86) and the **TLB is flushed** — every
subsequent memory access misses the TLB until it refills, which is a slow trickle of page-
table walks. That TLB flush is the big hidden cost of crossing process boundaries.

But *any* context switch is expensive beyond the visible register save/restore, for two
reasons people forget:
1. **Cache pollution.** The incoming thread's working set isn't in L1/L2; it runs cold and
   suffers cache misses until it warms up, while having evicted the outgoing thread's hot
   data. The "cost" of a switch is mostly paid *afterward*, as cache misses, not in the
   switch instruction itself.
2. **The mode transition.** Switching involves a trip into the kernel (a syscall or
   interrupt), saving state, the scheduler picking the next thread, restoring state — all
   overhead that does no application work.

This is *the* argument for **async / event-loop / non-blocking I/O** and for **virtual
threads** (Project Loom). A thread-per-request server with 10,000 blocked threads pays for
10,000 OS threads' stacks (~1 MB each → 10 GB) and the scheduler thrashing between them on
every I/O wait. An event loop (Netty) or virtual threads multiplexes many logical tasks
onto few OS threads, so a blocking call parks a cheap *user-mode* continuation instead of
pinning and context-switching a kernel thread. The whole modern concurrency story —
reactor patterns, coroutines, Loom — exists to **avoid the per-OS-thread cost** I just
described. Knowing *why* the switch is expensive (TLB, cache, mode transition) is what makes
"just use virtual threads" an informed choice rather than a cargo cult.

──────────
> **[BANK]** Process = isolated address space; thread = execution within it, sharing heap/
> globals/FDs but with private stack+registers. Thread switch keeps the TLB (same address
> space); process switch flushes it. Real cost of any switch = cache pollution + mode
> transition afterward. This is why async/virtual threads exist — to avoid per-OS-thread
> cost.
> **[TRAP]** "Threads share memory, processes don't" and stopping — missing the TLB-flush
> distinction and the *post-switch* cache cost that makes the whole thing matter.
> **[GO DEEPER]** [R2.Q10] the cache effects in detail · [R3] lock-free coordination
> across cores · virtual threads (Loom).

---

## Round 1 — closing note from the panel

Every question here had a "junior stop" and a "senior continue." The candidate cleared the
screen not by knowing *more facts* but by reflexively taking each definition one layer
deeper — placing TLS in the OSI model, naming PACELC after CAP, exposing the `Integer`
cache behind autoboxing, calling exactly-once a lie. None of those continuations were
*asked for*. That unprompted depth is the entire signal of a screening round: it tells the
interviewer "I can stop drilling — this person volunteers the next layer."

Proceed to [Round 2 — Systems internals](./02-round-2-internals.md) for where the drilling
gets deliberate, or jump to [Round 3 — Distributed & messaging](./03-round-3-distributed-messaging.md).
