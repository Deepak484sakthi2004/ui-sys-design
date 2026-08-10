# The 25-Crore Interview

### Transcripts of a Principal-Class Loop

> You are sitting across the table from someone who has built and broken every layer
> of the stack. The panel does not want a definition — they can read Wikipedia. They
> want to watch you *think*: to start at the question, get pushed, and keep digging
> until you hit bedrock. This book is a recording of those conversations.

---

## What this book is

Every other book in this collection (`../dsa-mastery/`, `../platform-notes/`,
`../networkings/`, `../interview-prep/`) teaches you the **answer**. This one teaches
you the **performance** — what it actually sounds like to be drilled by a distinguished
engineer and to keep going three follow-ups deeper than the question that started it.

The conceit: a candidate with effectively unbounded depth is interviewing for a
principal/distinguished SDE role. A rotating panel runs a five-round loop. Each
exchange is a real back-and-forth — the interviewer asks, the candidate answers, and
then the interviewer **pushes on the weakest or most interesting part of the answer**,
escalating until the conversation is standing on first principles: byte layouts, kernel
code paths, real latency numbers, and the tradeoffs you can only defend if you actually
understand the machine.

You read it two ways at once:
1. **As a reference** — the candidate's answers are correct and deep, so the book
   doubles as a systems deep-dive.
2. **As a script** — you learn the *shape* of a top-tier answer: lead with the
   mechanism, anticipate the follow-up, name the tradeoff before you're asked.

---

## How to read an exchange

Every unit is an **Exchange** with an ID like `[R2.Q1]` — Round 2, Question 1. The
format:

```
### [R2.Q1] Short title  ·  `NET` · ★★★☆☆

Interviewer: opening question
Candidate:   deep answer — prose + an ASCII byte/diagram or real numbers
Interviewer: follow-up that pushes on a gotcha
Candidate:   goes deeper
Interviewer: one more escalation — the bar-raiser twist
Candidate:   first-principles bedrock answer

──────────
[BANK]  one-line takeaway worth memorizing
[TRAP]  what a mid-level candidate says here that quietly fails the loop
[GO DEEPER]  cross-links to other exchanges and the sister books
```

**Every exchange has at least two interviewer turns** — if it's a single Q&A, it
belongs in one of the other books, not here.

### Legend

| Mark | Meaning |
|---|---|
| `★` … `★★★★★` | Difficulty, 1–5. R1 is mostly ★★, R4/R5 mostly ★★★★★ |
| `[BANK]` | The compressed, memorizable version. The thing you say first |
| `[TRAP]` | The plausible-but-shallow answer that signals "mid-level" to a panel |
| `[GO DEEPER]` | Where to go next — other exchanges, or the sister books |
| Domain chips | `NET` `DB` `DIST` `JVM` `AI` `PS` (see below) |

### The six domains

| Chip | Domain |
|---|---|
| `NET` | Networking & wire protocols |
| `DB` | Databases & storage engines |
| `DIST` | Distributed systems |
| `JVM` | JVM, concurrency & the OS underneath |
| `AI` | AI/ML systems & serving infrastructure |
| `PS` | Pub/sub & messaging |

---

## The rounds

A real onsite is a *loop*, not a syllabus. Each round file mixes all six domains, but at
a rising difficulty band — so a domain shows up several times, each time deeper than the
last (databases: "what's an index?" in R1 → the bytes of an InnoDB page in R2 → design a
distributed store in R4 → defend your isolation level under load in R5).

| Round | File | The bar |
|---|---|---|
| **R1 — Screening** | [`01-round-1-screening.md`](./01-round-1-screening.md) | Warm-up. Breadth. *Can they articulate cleanly, without hand-waving?* |
| **R2 — Systems internals** | [`02-round-2-internals.md`](./02-round-2-internals.md) | The byte/kernel round. Wire framing, page layouts, GC, the memory model |
| **R3 — Distributed & messaging** | [`03-round-3-distributed-messaging.md`](./03-round-3-distributed-messaging.md) | Consensus, replication, Kafka/Valkey internals, ordering, the exactly-once myth |
| **R4 — Design & AI infra** | [`04-round-4-design-ai-infra.md`](./04-round-4-design-ai-infra.md) | Open-ended design altitude + LLM serving, vector indexes, RAG internals |
| **R5 — Bar-raiser** | [`05-round-5-bar-raiser.md`](./05-round-5-bar-raiser.md) | Cross-cutting tradeoffs, ambiguity, "you said X in R2 — defend it now" |

Plus [`A-glossary.md`](./A-glossary.md) — every term, and a flat index of every `[BANK]`
card in the book for last-night cramming.

### And: the interview floor — 20 standalone mock interviews

The five rounds above are *one* candidate's day at *one* company. The
[`interviews/`](./interviews/00-interviews-index.md) folder is the rest of the building: **20
self-contained mock interviews, one per company archetype** (HFT firm, distributed-SQL vendor,
payments, LLM-serving startup, hyperscaler, CDN, …), each ~8 multi-turn exchanges in the same
hybrid format. A trading firm and a social network ask completely different questions and mean
completely different things by "latency" — the floor trains you to switch contexts. Start at the
[interview-floor index](./interviews/00-interviews-index.md).

---

## Domain × round coverage matrix

What gets asked, where, and how the depth ramps:

| Domain | R1 (warm-up) | R2 (internals) | R3 (distributed/msg) | R4 (design/AI) | R5 (bar-raiser) |
|---|---|---|---|---|---|
| **NET** | OSI layers; MySQL's app protocol | wire framing, TLS handshake bytes, Nagle×delayed-ACK, pool internals | replication on the wire, head-of-line blocking | gRPC vs REST vs bus at scale | "why not just use HTTP for everything?" |
| **DB** | index basics, ACID | InnoDB B+tree page, LSM compaction, MVCC, WAL/redo | distributed txns, 2PC vs sagas | design a feature store / TSDB | isolation-vs-throughput under load |
| **DIST** | CAP in one line | logical clocks, idempotency keys | Raft, quorum reads, exactly-once myth | design a 1M-RPS rate limiter | CAP/PACELC judgment, split-brain recovery |
| **JVM/OS** | heap vs stack, GC basics | object header, G1/ZGC, JMM, false sharing, safepoints | lock-free queues, NUMA | GC pause budget for an SLA | tune-vs-rewrite judgment |
| **AI** | embedding vs inference vs training | tokenization, attention cost, fp16/int8 math | model serving, batching tradeoffs | KV cache, paged attention, HNSW/IVF, RAG | when NOT to use an LLM |
| **PS** | queue vs topic, delivery semantics | log segment/offset bytes, backpressure | ISR/HW/leader-epoch, rebalance, compaction | event-driven inference pipeline | exactly-once across pub/sub + DB |

---

## Reading paths

- **Full loop (cover to cover):** R1 → R2 → R3 → R4 → R5. Read it like you're living
  the day. ~1 week of evenings.
- **Cram (already strong, ≤ 3 days):** skim R1, read R2 fully, read R3, skim R4/R5,
  then read *only* the `[BANK]` cards in `A-glossary.md`.
- **By domain:** use the matrix above — follow one chip (e.g. `DB`) across all five
  rounds to watch the same topic deepen.
- **Just the cards:** `A-glossary.md` is the flat list of every `[BANK]` line. The
  morning-of refresher.

---

## Conventions (shared with the sister books)

- **Mechanism-first.** Why a thing exists before how it works. Every design choice is
  justified by a constraint — a physical limit, a hardware reality, a failure mode.
- **Grounded in real systems.** Linux, InnoDB, HotSpot, Kafka, vLLM — not toy models.
- **ASCII diagrams only**, RFC box-drawing style. Byte order is always stated.
- **Cost callouts** in the house idiom: `Cost: RTTs / bytes / copies / µs`,
  `In the wild: …`.
- **No emoji.** `**bold**` for load-bearing terms, `code` for identifiers.

> The interviewer is not testing whether you memorized the answer. They are testing
> whether you can rebuild it from the constraints when you've forgotten it. Read for
> the *why*, and the *what* comes for free.

---

*Start with [R2 — Systems internals](./02-round-2-internals.md) if you want to feel the
depth bar immediately; start with [R1](./01-round-1-screening.md) if you want the loop in
order.*
