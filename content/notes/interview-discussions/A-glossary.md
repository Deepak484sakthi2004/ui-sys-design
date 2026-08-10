# Appendix A — Glossary & the BANK Cards

> Two things in one file. **Part 1** is every `[BANK]` card in the book, collected by round —
> the morning-of-interview flashcard deck. **Part 2** is a term glossary for the load-bearing
> vocabulary, so you can place a word the moment a panel uses it.

---

## Part 1 — The BANK deck (every card, by round)

### Round 1 — Screening

- **[R1.Q1] OSI/TCP-IP** — OSI = 7 layers (teaching); TCP/IP = 4 (real). You touch IP (L3),
  TCP/UDP (L4), app protocols (L7). TLS sits between L4 and L7. L4 LB = IP/port; L7 LB =
  reads HTTP, routes on path/host.
- **[R1.Q2] ACID vs BASE** — ACID = Atomicity (undo log), Consistency (constraints),
  Isolation (levels), Durability (fsync'd WAL). BASE trades strong isolation/immediate
  consistency for availability + scale. Pick per-data: money→ACID, feeds/counters→BASE.
- **[R1.Q3] CAP/PACELC** — CAP: under a partition, choose Consistency or Availability (P
  isn't optional). PACELC: Else (no partition) choose Latency or Consistency — the tradeoff
  you make on *every* request. Dynamo = PA/EL, Spanner-like = PC/EC.
- **[R1.Q4] Heap/stack & autoboxing** — Stack = per-thread frames (primitives + references),
  auto-freed, no GC. Heap = shared objects, GC-managed. Generic collections box primitives
  (16 B `Integer` vs 4 B `int`, scattered). `Integer` caches −128..127, so `==` "works" then
  breaks — use `.equals()`.
- **[R1.Q5] Training/inference/embedding** — Training = learn weights (offline, throughput).
  Inference = one forward pass (online, latency). Embedding = a vector capturing meaning;
  nearest-neighbour = semantic search → RAG. Infra owns serving + the vector index, not
  training.
- **[R1.Q6] Queue/topic & delivery** — Queue = 1 msg → 1 consumer (work sharing). Topic = 1
  msg → all subscribers (broadcast). Kafka consumer groups = pub/sub across groups, queue
  within. Delivery: at-most-once (lossy), at-least-once (the default), exactly-once = a lie at
  the delivery layer (it's at-least-once + idempotency at the processing layer).
- **[R1.Q7] Indexes** — An index = a sorted B+tree mapping values → rows; O(n) scan → O(log n)
  lookup, plus ranges/ORDER BY. Cost: every write updates every index + space + buffer-pool
  pressure. Index high-selectivity columns for real queries; drop indexes `EXPLAIN` never
  uses.
- **[R1.Q8] Process/thread** — Process = isolated address space; thread = execution within it,
  sharing heap/globals/FDs, private stack+registers. Thread switch keeps the TLB; process
  switch flushes it. Real cost of any switch = cache pollution + mode transition. Why async/
  virtual threads exist.

### Round 2 — Systems internals

- **[R2.Q1] DB wire protocols** — Datastores don't ride on HTTP — each defines a custom binary
  app protocol on TCP (or Unix socket): MySQL Client/Server, Postgres FE/BE, Redis RESP,
  MongoDB Wire, Kafka binary.
- **[R2.Q2] TLS 1.3** — 1-RTT because the client sends an ephemeral `key_share` in
  `ClientHello`; everything after `ServerHello` is encrypted. Wrong-group guess → extra RTT
  (`HelloRetryRequest`). 0-RTT early data is replayable — idempotent only.
- **[R2.Q3] Nagle × delayed-ACK** — A reproducible ~40 ms stall with no loss = Nagle (holds a
  small segment until prior data is ACKed) deadlocking with delayed ACK (holds the ACK ~40 ms
  to piggyback). Fix: `TCP_NODELAY`, or better, coalesce your own writes.
- **[R2.Q4] InnoDB pages** — InnoDB tables are clustered B+trees keyed by PK — leaves hold full
  rows. Secondary index → PK → clustered tree (double lookup) unless covering. Random PKs →
  read-before-write + mid-page splits; monotonic PKs append. Use UUIDv7.
- **[R2.Q5] B+tree vs LSM** — B+tree = in-place, random-write cost, predictable reads. LSM =
  append-only (WAL + memtable → SSTables + compaction), turns writes sequential at the cost of
  read + space amplification. Leveled = low space/read, high write-amp; size-tiered =
  opposite.
- **[R2.Q6] MVCC** — Hidden `DB_TRX_ID`/`DB_ROLL_PTR` + undo-log version chains + per-txn read
  view. Readers walk back to their snapshot; no read locks. Purge reclaims old versions unless
  a long-running txn stalls it (history bloat). Snapshot isolation ≠ serializable — close
  write-skew/lost-update with `FOR UPDATE` or version columns.
- **[R2.Q7] Object header** — 64-bit object = 8 B mark word (hashCode/GC age/lock state) + 4 B
  compressed klass ptr, padded to 16. Compressed oops shift by 3 bits → 32 GB ceiling; just
  over 32 GB is *worse* than just under. Lilliput (JDK 24) packs toward one word.
- **[R2.Q8] G1 vs ZGC** — G1 evacuates (copies live objects) in a STW pause → pause grows with
  live set. ZGC/Shenandoah relocate *concurrently* via colored pointers + load barriers (or a
  Brooks pointer + write barrier) → flat sub-ms pauses, paid for with a per-load barrier
  (throughput tax). Real pause = GC work + time-to-safepoint (a poll-less loop freezes
  everyone).
- **[R2.Q9] Double-checked locking** — DCL without `volatile` is broken: `new Holder()` can
  publish the reference before the constructor's writes are visible, so another thread sees a
  half-built object. `volatile` adds the release/acquire happens-before edge ordering
  construction before publication. Prefer the holder-class idiom or an enum.
- **[R2.Q10] False sharing** — Independent variables on the same 64-byte cache line force MESI
  to bounce exclusive ownership between cores on every write — parallelism collapses with zero
  logical contention. Pad the hot field (`@Contended`, `LongAdder`); cost is ~8× memory, so
  pad only profiled-hot fields. Diagnose with `perf c2c`.

### Round 3 — Distributed & messaging

- **[R3.Q1] Raft** — Terms (logical clock) + majority quorums. Randomized election timeouts; a
  voter grants a vote only to a candidate whose log is ≥ up-to-date (term first, then length) →
  Leader Completeness via majority overlap. Never commit a prior-term entry by replica count
  alone (Figure 8). A paused→woken leader is fenced by terms: higher term ⇒ step down; it never
  held a majority, so no double-commit.
- **[R3.Q2] Quorums (W+R>N)** — N replicas, W write acks, R read responses; W+R>N ⇒ read/write
  sets overlap ⇒ read sees the latest write *under benign conditions*. W=R=2,N=3 balanced
  default. Leaks: sloppy quorums (hinted handoff) break overlap; concurrent writes need vector
  clocks + merge or LWW loses data. Tunable consistency, not linearizability.
- **[R3.Q3] Kafka EOS** — Idempotent producer (PID + per-partition sequence → broker dedups
  retries) + transactions (atomic output-write *and* offset-commit, surfaced via
  `read_committed`) = exactly-once *semantics* on at-least-once delivery. Closed-world: at an
  external DB boundary you need idempotent sink writes or the outbox.
- **[R3.Q4] ISR / durability** — ISR = replicas caught up to the leader; only ISR can be
  elected. HW = min LEO across ISR = commit point; only ≤HW is visible/durable. Leader death
  loses only the uncommitted (HW→LEO) tail. Durability = `acks=all` + RF=3 + `min.insync.
  replicas=2`. Unclean leader election = elect a stale replica → availability but guaranteed
  data loss; keep `false` for sources of truth.
- **[R3.Q5] Rebalance** — Membership change → rebalance. Eager = stop-the-world (every consumer
  revokes *all* partitions, group throughput → 0). Cooperative/incremental moves only
  partitions that change hands; static membership (`group.instance.id`) suppresses rebalances
  on transient disconnects. Tune session/heartbeat/max.poll.
- **[R3.Q6] Log compaction** — `cleanup.policy=compact` keeps ≥ the latest value per key (a
  changelog/KTable). Delete = append a **tombstone** (key + `null` value). Tombstones persist
  `delete.retention.ms` (default 24h) so slow consumers see the delete — too short → resurrected
  zombie keys; a sentinel instead of real null → unbounded leak.
- **[R3.Q7] 2PC vs sagas** — 2PC (coordinator + prepare/commit) = true atomicity but blocks
  holding locks and wedges if the coordinator dies mid-protocol (SPOF, lowers availability).
  Saga = local txns each with a compensating txn; available + decoupled, but **not atomic / not
  isolated** (intermediate states visible). Needs idempotent steps + non-failing compensations;
  sequence irreversible steps last.
- **[R3.Q8] Logical clocks** — No trustworthy shared wall clock → logical clocks. Lamport:
  `max+1` on receive; A→B ⇒ L(A)<L(B) but not converse — can't detect concurrency. Vector
  clocks: per-node counter vector, element-wise compare → detect causality *and* concurrency,
  at O(N) size. HLC = physical+logical hybrid; Spanner buys real time (TrueTime + commit-wait).

### Round 4 — Design & AI infra

- **[R4.Q1] Rate limiter** — Token bucket (burst + sustained, O(1) state). At scale: per-node
  local buckets + central quota *leasing* + async reconciliation → amortize coordination,
  enforce "limit ± slack". Atomic refill-decrement (Redis Lua). Cross-region = PACELC: per-
  region quotas + **fail open** (a limiter must not become a bigger SPOF than what it protects).
- **[R4.Q2] LLM serving** — Inference = prefill (compute-bound) + decode (one token at a time,
  **memory-bandwidth-bound** → low GPU util). KV cache (~GB per long request) is the scarce
  resource. Continuous batching refills the batch every iteration; PagedAttention pages the KV
  cache (OS-style block tables) → bigger batches. Then manage the p99 tail: chunked prefill,
  prefill/decode separation.
- **[R4.Q3] Vector indexes** — Billion-scale = ANN, traded on recall/latency/memory. HNSW =
  proximity graph, ~O(log N) hops, best recall-latency, RAM-hungry → millions. IVF = cluster +
  probe `nprobe` cells. PQ = sub-vector codebook → 1 byte each → ~32× compression so billions
  fit in RAM (lossy → re-rank). Billion-scale = IVF-PQ + re-rank; millions = HNSW.
- **[R4.Q4] RAG** — "Confident lie" usually = bad/missing *retrieval*, not the LLM. Chunking
  (semantic + overlap) → embedding (hybrid dense+BM25 for exact matches) → top-k (rerank with a
  cross-encoder; beware "lost in the middle") → generation (ground-only prompt + citations +
  abstain gate). Debug by measuring **retrieval recall@k in isolation** first.
- **[R4.Q5] Quantization** — GPU memory ≈ params × bytes/param (+ KV cache + activations +
  overhead). 70B: fp16 140 GB (2 GPUs), int8 70 GB (tight), **int4 35 GB (fits one 80 GB
  A100)**. Naive RTN fails on **outliers**; GPTQ/AWQ/per-group scales keep int4 loss <1%.
  Weight-only int4 speeds up memory-bound decode.
- **[R4.Q6] Backpressure** — Spike-proof an expensive stage: **bounded** queue decouples
  arrival from a fixed-rate GPU → backpressure to the edge → **load shed early** (429 +
  Retry-After + jittered backoff) over unbounded queuing. Shed smart: priority tiers +
  **deadline-aware drop of stale work** + degrade to a smaller/cached model. Autoscale on queue
  depth/age.
- **[R4.Q7] GC SLA** — GC pauses hit **p99/p999** (freeze all in-flight at once). Reason via a
  **tail budget**: a 30 ms pause × ~50 in-flight reqs ≈ 0.5%/sec — even ~1 pause/sec can blow
  p99<50 ms. Fix order: ZGC/Shenandoah (flat pause, costs throughput) → tune G1 → **reduce
  allocation** (pooling, off-heap, primitives) so the GC barely runs.

### Round 5 — Bar-raiser

- **[R5.Q1] LSM for reads?** — Read-heavy OLTP + strict tail → B+tree (predictable path) over
  LSM (read amp + compaction jitter). Don't overcorrect: LSM still wins for *recent-data* reads,
  extreme scale, or when the distribution model (Cassandra/AP) dictates the engine.
  "Read-heavy" is underspecified — name the deciding property.
- **[R5.Q2] Split-brain** — Correct consensus makes two leaders committing impossible (only one
  side holds a quorum). If conflicting writes *did* commit, you weren't running quorum-commit
  (AP-in-CP-costume). Recover: fence (fencing token) → detect (vector clocks) → resolve (LWW
  lossy / CRDT merge / human). Real fix = never ack without quorum + fence leases + design data
  for conflict.
- **[R5.Q3] Why not HTTP for DBs** — Binary protocols win for **stateful, long-lived, high-
  throughput sessions** (HTTP is stateless, header-bloated per tiny query, no native result-set
  streaming). HTTP wins for stateless/browser/serverless/edge access (PostgREST, DynamoDB HTTP
  API). gRPC (HTTP/2 binary) is the middle ground. Axis: stateful+hot → binary; stateless+reach
  → HTTP.
- **[R5.Q4] Tune vs rewrite** — GC SLA miss → don't rewrite in Rust first. Climb the cheap
  ladder (ZGC → tuning → off-heap → kill allocation) and **measure** — usually ends it in days.
  Rewrite only when the SLA is *provably* unachievable on the JVM (µs-level HFT), and then
  **surgically** (hot 5% via FFI), not the whole service. Bias: cheapest proven-sufficient fix,
  surgical over wholesale.
- **[R5.Q5] Outbox** — Dual-write (DB then Kafka) silently loses events on a crash between them.
  **Transactional outbox:** business row + event row in **one DB transaction**, then a relay
  (polling or Debezium/CDC) publishes (at-least-once). Close it with **consumer-side
  idempotency / inbox**: dedup on a unique event id recorded **in the same transaction as the
  effect**. Net = exactly-once *processing*.
- **[R5.Q6] When not to use an LLM** — Say no when the task is **deterministic/rule-
  expressible** (use code), **correctness must be guaranteed** (LLMs hallucinate → assist, not
  decide), **latency/cost is tight**, a **classical ML model fits better**, or **auditability**
  is required. Yes for **open-ended language** with a tolerable, verifiable failure mode +
  human-in-loop, gated by retrieval + a validator.
- **[R5.Q7] Disagree-and-commit** — Consistency-vs-latency peer disagreement: (1) make it
  **concrete & per-operation** (not "the system"); (2) replace opinions with **measured latency
  + the product requirement**; (3) hunt the **hybrid that dissolves it** (strong source of
  truth + eventual replicas, read-your-writes, CRDTs); (4) if unresolved, make the case **once
  in writing**, then **commit fully**, built **reversible/instrumented**. Two-way doors deserve
  less agonizing.

---

## Part 2 — Term glossary

### Networking

- **Application protocol** — the L7 conversation format above the transport (HTTP, gRPC, the
  MySQL/Postgres/RESP binary protocols). Independent of the transport carrying it.
- **Framing** — how a protocol marks message boundaries inside TCP's boundary-less byte stream
  (length prefixes, delimiters). MySQL: 3-byte LE length + 1-byte sequence.
- **`key_share` (TLS 1.3)** — the client's ephemeral DH public key sent in `ClientHello`,
  enabling 1-RTT; a wrong-group guess triggers a `HelloRetryRequest` (extra RTT).
- **0-RTT / early data** — resumed-session application data sent in the first flight; fast but
  **replayable**, so idempotent-only.
- **Nagle's algorithm** — coalesces small TCP sends while data is unacked; deadlocks with
  delayed ACK to produce ~40 ms stalls. Disable with `TCP_NODELAY`.
- **Delayed ACK** — receiver holds the ACK up to ~40 ms (Linux) to piggyback it on data or
  combine ACKs.
- **Head-of-line blocking** — one stalled item delaying everything behind it (a long prefill in
  a batch, a lost TCP segment blocking later ones in HTTP/2).
- **L4 vs L7 load balancer** — L4 routes on IP/port (fast, opaque); L7 reads the application
  data (HTTP path/host) to route (TLS termination, sticky sessions).

### Databases & storage

- **B+tree** — balanced tree with data only in linked leaf nodes; high fan-out, shallow, range-
  friendly. InnoDB's clustered index.
- **Clustered / index-organized table** — the table *is* the PK B+tree; leaves hold full rows.
  Secondary indexes store the PK as the row locator.
- **Covering index** — a secondary index containing every column a query needs, so the
  clustered-tree bookmark lookup is skipped.
- **LSM tree** — Log-Structured Merge tree: WAL + in-memory memtable → immutable sorted
  **SSTables** → background **compaction**. Sequential writes, read/space amplification.
- **Write / read / space amplification** — physical writes per logical write / files probed per
  read / disk used vs live data. The RUM trade-off; each engine optimizes two.
- **Compaction (leveled vs size-tiered)** — leveled = non-overlapping levels, low space/read-
  amp, high write-amp; size-tiered = merge similar-size files, low write-amp, high space/read-
  amp (transient ~2× disk).
- **Bloom filter** — probabilistic set membership; lets an LSM skip SSTables that definitely
  lack a key (no false negatives).
- **MVCC** — Multi-Version Concurrency Control: keep old row versions (undo log) so readers see
  a snapshot without locking writers.
- **Read view / snapshot** — the per-transaction set of "which trx ids were active," defining
  what a reader can see.
- **Undo log / version chain / purge** — the before-images forming a row's history; purge
  reclaims versions no read view still needs.
- **Isolation levels** — Read Committed (fresh view per statement) < Repeatable Read (one view
  per txn; InnoDB adds gap locks vs phantoms) < Serializable.
- **Write skew / lost update / phantom** — anomalies snapshot isolation still permits; close
  with `FOR UPDATE`, version columns, or Serializable.

### JVM, concurrency & OS

- **Object header** — per-object overhead: mark word (hashCode/GC age/lock) + compressed klass
  pointer; padded to 8 bytes. Lilliput shrinks it.
- **Compressed oops** — 32-bit object references shifted by 3 bits (8-byte alignment) to address
  32 GB; above 32 GB references double in size.
- **GC: G1 vs ZGC/Shenandoah** — G1 copies live objects in STW pauses (pause ∝ live set);
  ZGC/Shenandoah relocate concurrently behind load/write barriers → flat sub-ms pauses, a
  throughput tax.
- **Safepoint / time-to-safepoint (TTSP)** — a known-state point where threads can be stopped;
  the real pause includes the time for the slowest thread to reach a poll.
- **Happens-before / JMM** — the ordering relation that defines visibility between threads; a
  `volatile` write→read (release/acquire) establishes it.
- **False sharing** — independent variables on one 64-byte cache line causing MESI coherence
  bouncing; fix by padding (`@Contended`, `LongAdder`).
- **MESI** — the cache-coherence protocol (Modified/Exclusive/Shared/Invalid) that makes a
  cache *line* the unit of ownership between cores.
- **TLB** — Translation Lookaside Buffer, the virtual→physical address cache; flushed on a
  process (address-space) switch, preserved on a thread switch.

### Distributed systems

- **Consensus (Raft/Paxos)** — agreeing on a replicated log despite failures, via majority
  quorums and terms.
- **Term** — Raft's logical clock; a monotonic integer fencing stale leaders (higher term seen ⇒
  step down).
- **Quorum / W+R>N** — overlap requirement: write set and read set intersect so a read sees the
  latest write — under benign conditions.
- **Sloppy quorum / hinted handoff** — accept writes on non-home nodes during failure (for
  availability), leaving a hint to repair later; breaks the overlap guarantee.
- **Linearizability vs eventual consistency** — every read sees the latest write (single global
  order) vs replicas converge over time.
- **Lamport clock / vector clock / HLC** — logical timestamps; Lamport gives total order but
  can't detect concurrency, vector clocks detect concurrency at O(N), HLC blends physical +
  logical.
- **Fencing token** — a monotonic number a resource checks to reject a stale (paused-then-woken)
  lock/lease holder.
- **2PC** — Two-Phase Commit: prepare then commit/abort across participants; atomic but blocking,
  coordinator is a SPOF.
- **Saga** — a sequence of local transactions with compensating transactions; available but not
  atomic/isolated.
- **CRDT** — Conflict-free Replicated Data Type; mergeable data so concurrent writes converge
  without coordination.
- **CAP / PACELC** — under Partition choose Consistency or Availability; Else choose Latency or
  Consistency.

### Pub/sub & messaging

- **Delivery semantics** — at-most-once (lossy) / at-least-once (dup-prone, default) / exactly-
  once (processing only, via idempotency).
- **Idempotency key** — a unique id that makes reprocessing a no-op, the basis of "exactly-once
  processing."
- **ISR / LEO / High Watermark** — In-Sync Replicas / Log End Offset / the min-LEO commit point
  below which records are durable and visible.
- **`acks` / `min.insync.replicas`** — producer ack requirement / minimum ISR for `acks=all`
  writes; `acks=all`+RF=3+min.isr=2 survives one loss.
- **Unclean leader election** — electing an out-of-sync replica → availability at the cost of
  guaranteed data loss + log truncation.
- **Rebalance (eager vs cooperative)** — redistributing partitions on membership change; eager
  stops the whole group, cooperative moves only what changes hands.
- **Log compaction / tombstone** — retain the latest value per key; a `null`-value record marks
  a delete, retained `delete.retention.ms`.
- **Transactional outbox / inbox** — write the event in the same DB txn as the state change
  (outbox); dedup on the consumer in the same txn as the effect (inbox).
- **CDC (Change Data Capture)** — tailing the DB's WAL/binlog (e.g. Debezium) to stream committed
  changes as events.

### AI / ML systems

- **Training vs inference** — learning weights (offline, throughput) vs using them for a forward
  pass (online, latency).
- **Embedding** — a fixed-length vector capturing semantic meaning; similarity = vector distance.
- **Prefill vs decode** — process the prompt in parallel (compute-bound) vs generate tokens one
  at a time (memory-bandwidth-bound).
- **KV cache** — cached Key/Value vectors of prior tokens so attention isn't recomputed; large,
  grows with sequence length; the scarce serving resource.
- **Continuous (in-flight) batching** — refill the batch every iteration as sequences finish,
  vs static batching stalling on the longest.
- **PagedAttention** — OS-style paging of the KV cache into fixed blocks with a block table, to
  kill fragmentation and enable prefix sharing.
- **ANN (HNSW / IVF / PQ)** — Approximate Nearest Neighbour: graph index (HNSW), cluster-probe
  (IVF), sub-vector codebook compression (PQ); traded on recall/latency/memory.
- **Recall@k** — fraction of true neighbours (or correct chunks) actually retrieved; the metric
  to isolate retrieval quality in RAG.
- **RAG** — Retrieval-Augmented Generation: embed + retrieve relevant chunks, stuff into the
  prompt, generate grounded answers.
- **Quantization (fp16/int8/int4, GPTQ/AWQ)** — reduce weight precision for memory/speed;
  outlier-aware methods keep int4 quality loss small.
- **Cross-encoder / reranker** — reads query+document together for accurate relevance scoring,
  used to reorder a cheap vector-retrieval candidate set.

---

*Back to the [index](./00-index.md). The cards above are the deck; the rounds are the
reasoning. Read the reasoning until the cards feel obvious — that's when you're ready.*
