# Chapter 14: The System Design Framework

> **Relearning log.** I build distributed systems for a living, so I assumed the design round would
> be easy. It isn't — because the round doesn't score *whether I can build the system*, it scores
> *whether I can drive a structured, time-boxed conversation about an ambiguous problem*. My rust
> showed as: diving into the database schema in minute 3 (before scoping), rambling without a
> structure the interviewer could follow, and — the killer — *not driving*. I'd wait to be asked
> the next question instead of saying "let me now cover how we shard this." The recovery was to
> memorize a **7-step script** and a **time budget**, so that even when the problem is unfamiliar I
> have a frame to hang it on. The design round is to system design what
> [Ch 3's script](03-problem-solving-framework.md) is to coding.

This chapter is the reusable framework. [Ch 15](15-building-blocks-and-back-of-envelope.md) is the
component vocabulary; [Ch 16](16-system-design-worked-problems.md) applies both to real problems.

---

## 14.1 The 7-step script (≈45 min)

```
1. REQUIREMENTS    (~5 min)  functional + non-functional + scale; scope ruthlessly
2. ESTIMATE        (~5 min)  QPS, storage, bandwidth — sizes the design
3. API             (~3 min)  the handful of endpoints / RPCs
4. DATA MODEL      (~5 min)  entities, access patterns → storage choice
5. HIGH-LEVEL      (~8 min)  boxes & arrows; the happy-path data flow
6. DEEP DIVE       (~12 min) pick the interesting bottleneck and go deep
7. WRAP / TRADEOFFS(~5 min)  bottlenecks, failure modes, what I'd change at 10×
```

> The single biggest behavior change: **I narrate the step I'm in and the step I'm going to.** "I've
> scoped the requirements; let me do quick capacity math, then sketch the API." This makes the
> interviewer's note-taking trivial and signals that I'm *driving* — the L5 differentiator.

---

## 14.2 Step 1 — Requirements (scope ruthlessly)

Most candidates fail by trying to build everything. **Senior move: propose a scope and confirm it.**

- **Functional:** "For a chat system, I'll focus on 1:1 messaging, delivery, and online status.
  Group chat and media I'll mention but not deep-dive unless you'd prefer. OK?"
- **Non-functional (the ones that shape architecture):**
  - **Scale** — users, QPS, data volume, read:write ratio.
  - **Latency** — p99 target (interactive < 200 ms? batch?).
  - **Consistency vs availability** — can it be eventually consistent, or must it be strongly
    consistent? (This is the CAP decision — see [Ch 15](15-building-blocks-and-back-of-envelope.md).)
  - **Durability** — can we lose data? (Usually no for the source of truth.)
- **Out of scope:** say it explicitly ("auth, payments, analytics — out of scope").

> Read:write ratio and consistency requirement are the two answers that change the *whole* design.
> A read-heavy, eventually-consistent system (news feed) and a write-heavy, strongly-consistent one
> (ledger) look nothing alike. Ask early.

---

## 14.3 Step 2 — Back-of-envelope estimation

Volunteer the math; don't wait to be asked (L5 signal). Keep it rough and round.

Worked rhythm (e.g., "design Twitter"):
- 300 M users, 50% daily active → 150 M DAU.
- Each posts ~2 tweets/day → 300 M tweets/day ≈ **~3,500 writes/sec**, peak ~2× → ~7 k/s.
- Reads dominate: each user reads timeline ~20×/day → 3 B reads/day ≈ **~35 k reads/sec**, peak
  ~70 k/s. **Read:write ≈ 100:1** → cache + fan-out-on-write.
- Storage: 300 M tweets/day × 300 bytes ≈ 90 GB/day ≈ **~33 TB/year** (text only).

The estimation cheat-sheet (latency numbers, unit math) lives in
[Ch 15](15-building-blocks-and-back-of-envelope.md) and [App A](A-cheatsheets.md).

> The point of estimation isn't precision — it's to **justify architectural decisions with numbers**.
> "35 k reads/sec at 100:1 read:write is why I'll precompute timelines and cache aggressively"
> is the sentence the math exists to produce.

---

## 14.4 Steps 3–4 — API and data model

- **API:** a few endpoints, with the key parameters. `postTweet(userId, text) → tweetId`;
  `getTimeline(userId, cursor) → tweets[]`. Mention pagination (cursor, not offset), idempotency
  keys for writes, and auth as assumed.
- **Data model:** entities and — more importantly — **access patterns**, because the access pattern
  picks the store. "I query timeline-by-user, newest-first → this wants a wide-column store keyed by
  userId with time-sorted columns, or Redis lists." Choosing SQL vs NoSQL vs cache *because of the
  access pattern* (not vibes) is the signal.

---

## 14.5 Step 5 — High-level design

Draw the boxes and the **happy-path flow**, narrating the request's journey:

```
        ┌────────┐   ┌──────────────┐   ┌───────────────┐
Client →│  CDN/  │ → │ Load Balancer│ → │ API / App     │
        │  Edge  │   └──────────────┘   │ Servers (sl)  │
        └────────┘                      └──────┬────────┘
                                  ┌────────────┼─────────────┐
                              ┌───▼───┐   ┌────▼────┐   ┌─────▼─────┐
                              │ Cache │   │ Primary │   │  Message  │
                              │(Redis)│   │   DB    │   │  Queue    │
                              └───────┘   └────┬────┘   └─────┬─────┘
                                          (replicas)     (async workers)
```

Walk a write and a read through it. State **stateless app servers** (so they scale horizontally),
**cache-aside** for reads, and where the **async** boundary is (queue + workers for fan-out, media
processing, notifications).

---

## 14.6 Step 6 — Deep dive (where L5 is won)

**Choose** the most interesting bottleneck and go deep *unprompted* — that's the difference between
"answered questions" (L4) and "drove the design" (L5). Typical deep-dive choices:

- **The hot path bottleneck:** timeline generation (fan-out-on-write vs on-read, and the
  *celebrity/hybrid* solution), or the rate limiter algorithm, or the dedup/idempotency mechanism.
- **Data partitioning:** what's the shard key, how do we avoid hot shards, how do we resize
  (consistent hashing).
- **Consistency:** how do replicas stay in sync; what does a client see during failover.

Say: *"The interesting part here is timeline generation, because of the 100:1 read ratio and the
celebrity fan-out problem. Let me go deep there."* Then own it.

---

## 14.7 Step 7 — Wrap: bottlenecks, failure, scale

Close by *proactively* covering what breaks:
- **Single points of failure** → replicate, multi-AZ, failover.
- **Bottlenecks** → the component that saturates first and how to scale it (shard, cache, read
  replicas, queue + backpressure).
- **Failure modes** → what happens when the cache/DB/a worker dies; retries with jitter, circuit
  breakers, idempotency, dead-letter queues (see [Ch 15](15-building-blocks-and-back-of-envelope.md)).
- **What I'd revisit at 10×** → "at 10× write volume, the primary DB becomes the bottleneck; I'd
  shard by userId and move to async fan-out."

---

## 14.8 The L4 vs L5 bar in the design round

| Behavior | L4 | L5 |
|----------|----|----|
| Requirements | asks clarifying Qs when prompted | *proposes* scope, drives the scoping |
| Estimation | does math if asked | volunteers math, ties it to decisions |
| Structure | covers components | manages time, narrates the step, owns the whiteboard |
| Deep dive | goes deep where directed | *chooses* the bottleneck, goes deep unprompted |
| Tradeoffs | mentions some | frames every choice as "X vs Y, I pick X because, it costs Z" |
| Failure | hits it if asked | proactively covers SPOFs, failure, and the 10× story |

> Memorize this sentence shape and use it on *every* decision: **"I'll use X over Y because [reason
> tied to a requirement]; the tradeoff is [cost]."** It single-handedly converts answers from L4 to
> L5, because it demonstrates judgment, not just knowledge.

---

## 14.9 Tradeoff vocabulary (the words that signal seniority)

- **CAP / PACELC** — consistency vs availability under partition; latency vs consistency otherwise.
- **Strong vs eventual consistency**, read-your-writes, monotonic reads.
- **Fan-out-on-write vs on-read** (push vs pull).
- **Sync vs async** (and "make it async with a queue" as a scaling lever).
- **Vertical vs horizontal scaling; stateless services; sharding; replication.**
- **Idempotency, at-least-once vs exactly-once, backpressure, circuit breaker, bulkhead.**
- **p50/p99 latency, throughput, durability, SLA/SLO.**

Each is unpacked in [Ch 15](15-building-blocks-and-back-of-envelope.md).

---

## 14.10 Common pitfalls

- **Designing before scoping** (jumping to schema in minute 3).
- **Not driving** — waiting to be asked the next thing.
- **No numbers** — hand-waving "it's big" instead of estimating.
- **Listing components without a flow** — a pile of boxes isn't a design; the *request's journey* is.
- **Refusing to make a decision** — "it depends" with no choice. Decide, state the tradeoff, move on.
- **Going deep on the boring part** — pick the bottleneck that actually matters.

## Interview Drills

- **D14.1 [E]** Recite the 7 steps and their time budget.
- **D14.2 [M]** For "design a URL shortener," do *only* steps 1–2 (requirements + estimation) in 8
  minutes, out loud.
- **D14.3 [M]** Convert this L4 line to L5: "We'll use Redis for caching." *(e.g., "I'll add a
  cache-aside Redis layer in front of the DB because reads are 100:1; the tradeoff is cache
  invalidation complexity and a brief stale-read window, which is acceptable for a feed.")*
- **D14.4 [H]** Given a read:write of 1000:1 vs 1:1, how does your top-level architecture differ?
  *(Heavy caching + precompute + replicas vs. write path optimization + sharding + careful
  consistency.)*

## Key Takeaways

1. **The design round scores driving a structured conversation about ambiguity, not building the
   system.** Use the 7-step script and narrate the step you're in.
2. **Scope ruthlessly first;** read:write ratio and consistency requirement reshape the whole
   design — ask early.
3. **Volunteer the estimation math** and tie it to decisions.
4. **Choose the bottleneck and deep-dive it unprompted** — the L4→L5 differentiator.
5. **Frame every choice as "X over Y because [requirement]; tradeoff is [cost]."** This sentence
   shape is the seniority signal.
