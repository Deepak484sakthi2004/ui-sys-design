# The Interview Floor — 20 Standalone Mock Interviews

> The [five-round loop](../00-index.md) is *one* candidate's day at *one* company. This
> folder is the rest of the building: **20 separate mock interviews**, each at a different
> kind of company, each drilling what *that* org actually cares about. A trading firm and a
> social network ask completely different questions — and expect completely different depth
> on the same word ("latency" means microseconds to one and fan-out to the other).

Each interview is **self-contained**: a panel, a role/level, a scenario, and **~8 multi-turn
exchanges** in the house [hybrid format](../00-index.md#how-to-read-an-exchange) —
Interviewer↔Candidate drilling dialogue closed by `[BANK]` / `[TRAP]` / `[GO DEEPER]`. Read
any one cold; they don't depend on each other (though they cross-link to the round files and
to each other).

---

## The roster

| # | Company archetype | Role / level | What they drill | Core domains |
|---|---|---|---|---|
| 01 | **HFT / low-latency trading firm** | Systems SDE, "make it faster" | microseconds, zero-GC, kernel bypass, cache | `JVM` `NET` `OS` |
| 02 | **Distributed SQL vendor** (NewSQL) | Storage/replication engineer | MVCC, Raft, distributed txns, the optimizer | `DB` `DIST` |
| 03 | **Payments / fintech** (Stripe-like) | Backend SDE, money correctness | exactly-once, idempotency, ledgers, double-entry | `PS` `DB` `DIST` |
| 04 | **LLM serving / AI-infra startup** (vLLM-like) | Inference platform engineer | KV cache, batching, GPU memory, throughput | `AI` |
| 05 | **Hyperscaler** (planet-scale cloud) | Senior SDE, "design global X" | scale, multi-region, blast radius, control planes | `DIST` `DB` |
| 06 | **Streaming platform vendor** (Kafka/Confluent) | Distributed systems engineer | ISR, exactly-once, tiered storage, ordering | `PS` `DIST` |
| 07 | **CDN / edge compute** (Cloudflare-like) | Edge/network engineer | anycast, TLS, caching, BGP, DDoS | `NET` |
| 08 | **Object storage** (S3-like) | Storage systems engineer | durability, erasure coding, quorum, the eleven 9s | `DB` `DIST` |
| 09 | **Observability / TSDB** (Datadog-like) | Data-plane engineer | high cardinality, ingestion, compression, downsampling | `DB` `PS` |
| 10 | **Search / vector-DB vendor** (Elastic/Pinecone) | Search engineer | inverted index, ANN, ranking, relevance | `AI` `DB` |
| 11 | **Social feed** (Meta/Twitter-like) | Backend SDE, timelines | fan-out, caching, the celebrity problem, ranking | `DIST` `DB` |
| 12 | **Ride-share / geo** (Uber-like) | Real-time systems SDE | geospatial index, matching, surge, dispatch | `DIST` `DB` |
| 13 | **Chat / messaging at scale** (WhatsApp-like) | Realtime backend engineer | persistent connections, presence, ordering, fan-out | `NET` `DIST` |
| 14 | **Real-time multiplayer gaming** | Netcode / engine engineer | UDP, state sync, lag compensation, tick rate | `NET` `OS` |
| 15 | **Ad-tech / real-time bidding** | Low-latency platform SDE | sub-100ms auctions, budget pacing, ML serving | `DIST` `AI` |
| 16 | **Container orchestration** (k8s vendor) | Control-plane engineer | reconciliation loops, scheduling, etcd, the API server | `DIST` |
| 17 | **Blockchain / distributed ledger** | Protocol engineer | BFT consensus, Merkle trees, finality, forks | `DIST` |
| 18 | **Video streaming** (Netflix/YouTube-like) | Media platform engineer | ABR, encoding, CDN, the buffering tradeoff | `NET` `AI` |
| 19 | **OS / kernel / embedded-DB shop** | Systems programmer | virtual memory, syscalls, lock-free, the page cache | `OS` `JVM` |
| 20 | **Security / zero-trust infra** | Security platform engineer | TLS internals, auth, key management, threat models | `NET` |

> The grid is deliberately overlapping: "latency," "consistency," and "durability" recur, but
> each company forces a *different operating point* — and the bar-raising follow-ups are tuned
> to where that org's real pain lives.

---

## Reading paths

- **Targeted prep:** going to interview at a payments company? Read **03**, then **05/06**
  (the messaging/scale neighbours), then the loop's [R3](../03-round-3-distributed-messaging.md)
  and [R5.Q5](../05-round-5-bar-raiser.md) (outbox).
- **By domain obsession:** want to go deep on AI infra? **04 → 10 → 15 → 18**, plus loop
  [R4](../04-round-4-design-ai-infra.md).
- **Range training:** read one interview from each cluster (one infra, one data, one realtime,
  one AI) to practice *switching contexts* — the skill of answering "latency" correctly for
  whoever's asking.
- **Full floor:** all 20, in order. Each is ~45 minutes of reading; the set is a month of
  evenings and a genuinely broad systems education.

## The clusters

- **Latency-obsessed:** 01 HFT · 07 CDN · 13 Chat · 14 Gaming · 15 Ad-tech · 20 Security
- **Data & storage:** 02 Distributed SQL · 08 Object storage · 09 TSDB · 10 Search · 19 Kernel/DB
- **Scale & coordination:** 05 Hyperscaler · 06 Streaming · 11 Social · 12 Ride-share · 16 k8s · 17 Blockchain
- **AI infra:** 04 LLM serving · 10 Vector search · 15 Ad-tech ML · 18 Video

---

*Pick a company and sit down. The panel is waiting. Back to the
[main index](../00-index.md).*

### Build status

This is a large set, written in batches. Completed interviews are linked above as their files
land; the roster is the full plan.
