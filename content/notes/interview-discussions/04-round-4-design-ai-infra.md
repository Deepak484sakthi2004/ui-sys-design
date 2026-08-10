# Round 4 — Design & AI Infrastructure

> **The panel:** A principal engineer who owns the inference platform and a staff engineer
> who designs distributed systems for a living. Now the mechanisms from R2 and R3 are raw
> material. The questions are open-ended — "design X" — and the bar is *altitude*: can you
> hold the whole system in your head, reason in real numbers (RTTs, GB of VRAM, QPS), name
> the bottleneck before building around it, and defend the tradeoff? Hand-waving dies here.

Difficulty band: ★★★★★. Seven exchanges.

Domains touched: `AI` `DIST` `PS` `JVM`.

---

### [R4.Q1] "Design a rate limiter for 1 million requests per second, across regions"  ·  `DIST` · ★★★★★

**Interviewer:** Design a rate limiter. 1M RPS globally, multiple regions, per-user limits.
Start wherever you want, but I'll push on the distributed part.

**Candidate:** Let me start with the **algorithm**, then the **distribution**, because the
hard part is the second.

**Algorithm — token bucket**, which I'd pick over fixed/sliding window for most cases:
- A bucket per key (user/API-key) holds tokens; each request costs a token; tokens refill
  at a steady rate up to a capacity. It allows **bursts** up to the bucket size while
  bounding the **sustained** rate — which matches how people actually want limits ("100
  req/s but a short burst is fine").
- It's cheap to store: just two numbers per key — `tokens` and `last_refill_timestamp` —
  and you compute the refill lazily on each request (`tokens = min(cap, tokens + elapsed *
  rate)`), so there's no background refill job.

Why not the alternatives: a **fixed window** counter has the boundary-burst bug — a client
can send 2× the limit across a window edge (full quota at 0:59 and again at 1:00). A
**sliding-window log** is exact but stores every timestamp (expensive at 1M RPS). A
**sliding-window counter** (weighted blend of current+previous window) is a good cheap
approximation. Token bucket gives burst control with O(1) state, so I'll build on it.

**Distribution — this is the real question.** At 1M RPS you cannot have a single global
counter; the coordination would be the bottleneck. The options, in tension:

```
 Option A: central store (Redis)  — accurate, but a round-trip per request + hotspot
 Option B: local-only per node    — fast, but N nodes each allow the full limit → N× leak
 Option C: local + async sync     — fast, approximately accurate (my default)
```

**Interviewer:** Go with C. Now the hard part: a user's requests hit 50 servers across 3
regions. How do you enforce "100 req/s" globally without a round-trip to a central counter
on every request?

**Candidate:** This is the **local-accuracy vs global-coordination** tradeoff, and the
honest answer is **you approximate, and you choose *how* you approximate based on how much
over-admission you can tolerate.** A request-by-request global count is impossible at this
scale without paying a cross-region RTT (50–150 ms) per request, which would dwarf the
actual work. So:

**Approach: distributed token bucket with quota leasing + async reconciliation.**
1. **Each node holds a local bucket** and serves requests from it with **zero network calls
   on the hot path** — that's what keeps it fast enough for 1M RPS.
2. **A central authority (a Redis cluster, sharded by user key) owns the *true* quota** and
   **leases** slices of it to nodes. Instead of "100 tokens globally," node X requests a
   **lease of, say, 10 tokens** for that user, serves them locally, and asks for more before
   running out. Nodes return unused tokens. This turns per-request coordination into
   **per-lease coordination** — one round-trip per ~10 requests instead of per request,
   amortizing the cost 10×.
3. **Reconciliation is async and approximate.** Nodes periodically report consumption and
   pull updated leases. Between syncs the global count drifts, so the enforced limit is
   **"100 ± slack"**, where slack ∝ (lease size × number of nodes). You tune lease size to
   trade accuracy for coordination cost: tiny leases → accurate but chatty; big leases →
   cheap but loose.

For the **storage**, Redis is the natural fit: the lazy token-bucket math (`tokens`,
`last_refill`) is two fields, and the **refill+decrement must be atomic** so concurrent
requests don't both read-modify-write and over-admit — I'd do it as a **Lua script** that
runs atomically on the Redis node (check-refill-decrement in one server-side operation),
which also avoids a race that a naive GET/SET would have. Shard Redis by user key so no
single instance is a hotspot, and a hot key (one user hammering) is handled by that key's
node plus local leasing absorbing the burst.

**The cross-region decision is explicitly CAP/PACELC** (calling back to R1/R3): do I want
*one* global limit enforced consistently (then I need cross-region coordination, paying
latency — the PC/EC choice), or per-region limits that sum to roughly the global limit
(then each region is independent and fast, but a user could get up to 3× during a partition
— the PA/EL choice)? For a rate limiter, **availability and latency almost always win** —
the *purpose* of a rate limiter is to protect the system, and it failing *open* (allowing a
bit too much) is far less bad than it failing *closed* (blocking legit traffic) or adding
latency to every request. So I'd run **per-region quotas** (e.g. split 100 into ~34 per
region, or weight by traffic) with loose async global reconciliation, and **fail open** if
the quota store is unreachable. I'd state that explicitly: I'm choosing approximate global
enforcement and occasional over-admission to buy availability and sub-millisecond
hot-path latency, because that's the right failure mode for *this* component.

**Interviewer:** What happens when Redis — your quota authority — goes down?

**Candidate:** That's the decision that separates a toy from a production design: **fail
open, not closed.** If the quota store is unreachable, each node falls back to its **local
bucket with its last-known lease** and keeps serving — degrading to per-node approximate
limiting rather than blocking traffic. The reasoning: a rate limiter is a *protective*
component, not a *correctness* component; if it goes down, the worst case of failing open
is "we briefly allow more traffic than intended," whereas failing closed means "the rate
limiter outage becomes a full site outage" — the dependency would be more dangerous than
the thing it protects. I'd also (a) make the limiter a **library/sidecar** with the local
bucket, so a central outage can't take the hot path down at all, (b) keep **short local
fallback limits** so failing open still caps the absolute worst case, and (c) ensure the
Redis layer is itself replicated so this is rare. The meta-principle: **a safety mechanism
must never become a bigger single point of failure than the system it guards** — its
failure mode has to be benign by design.

──────────
> **[BANK]** Rate limiter: token bucket (burst + sustained, O(1) state) over fixed-window
> (boundary burst) / log (expensive). At scale: per-node local buckets + central quota
> *leasing* + async reconciliation → amortize coordination ~10×, enforce "limit ± slack"
> (slack ∝ lease size). Atomic refill-decrement (Redis Lua). Cross-region = PACELC: pick
> per-region quotas + **fail open**, because a limiter must not become a bigger SPOF than
> what it protects.
> **[TRAP]** A single global counter (bottleneck) or pure per-node limits (N× leak); failing
> *closed* when the quota store dies (limiter outage → site outage).
> **[GO DEEPER]** [R1.Q3] CAP/PACELC · [R3.Q2] quorum/leasing intuition · [R4.Q6]
> backpressure as the inverse problem.

---

### [R4.Q2] "Serve an LLM. The GPU is busy but utilization is 30%. Fix it."  ·  `AI` · ★★★★★

**Interviewer:** You're serving a 13B-parameter LLM for chat. Throughput is poor, GPU
utilization sits around 30% even under load. Diagnose and fix — and I want the memory math.

**Candidate:** 30% utilization under load means the GPU is **stalling, not compute-bound** —
and for LLM *decode* the culprit is almost always **memory and batching**, not FLOPs. Two
things to understand first: the **autoregressive** generation pattern and the **KV cache**.

LLM inference has two phases:
- **Prefill:** process the whole prompt in parallel — compute-heavy, one big matmul, good
  GPU utilization.
- **Decode:** generate tokens **one at a time**, each depending on all previous tokens.
  Each decode step does very little compute (one token) but must read the **entire model's
  weights** and the **KV cache** from memory. So decode is **memory-bandwidth-bound** — the
  GPU's compute units sit idle waiting on memory. That's your 30%.

The **KV cache** is the key data structure. Attention needs the Key and Value vectors of
*every previous token* to generate the next one. Rather than recompute them each step (O(n²)
wasted work), you **cache** them — but that cache is **huge** and grows with sequence length:

```
 KV cache size = 2 (K and V)
              × num_layers
              × num_heads × head_dim   (= hidden_size)
              × seq_len
              × bytes_per_param (2 for fp16)
              × batch_size
```

For a 13B model (~40 layers, hidden ~5120), one token of KV is roughly
`2 × 40 × 5120 × 2 bytes ≈ 800 KB`. A 2048-token sequence is `~1.6 GB` of KV cache **per
request**. On an 80 GB A100 with ~26 GB of weights (13B × 2 bytes), you have ~50 GB for KV
— so naively only ~30 concurrent long sequences fit. That scarcity is *why* batching is hard
and why utilization is low: you can't fit enough requests in memory to keep the GPU fed.

**The fixes, in order of impact:**

1. **Continuous (in-flight) batching** — the biggest win. Naive "static" batching groups N
   requests, runs them together, and waits for **all** to finish before starting the next
   batch. But sequences finish at *different* lengths, so the batch runs at the speed of the
   *longest* one while finished slots sit idle — terrible utilization. **Continuous
   batching** (the vLLM/Orca approach) operates at the **iteration level**: after *every
   token*, it evicts finished sequences and admits waiting ones into the freed slots. The
   batch is continuously refilled, so the GPU is always working on a full batch. This alone
   often 2–4×'s throughput.

2. **PagedAttention** — solves KV-cache *fragmentation*. Normally you'd pre-allocate a
   contiguous KV buffer for each request's *max* length, wasting enormous memory on
   sequences that finish early or never reach max — internal fragmentation that caps your
   batch size. PagedAttention (vLLM) borrows the OS **virtual memory / paging** idea: split
   the KV cache into fixed-size **blocks (pages)**, allocate them **on demand** as the
   sequence grows, and track them with a **block table** per request. Non-contiguous physical
   blocks, logically contiguous via the table — just like OS page tables. This cuts KV waste
   from ~60–80% down to <4%, so you fit **many more** concurrent sequences → bigger batches →
   higher utilization. It even enables **copy-on-write block sharing** for identical prompt
   prefixes (system prompts, few-shot examples shared across requests).

**Interviewer:** Good. You've maxed batching. Throughput is up but **p99 latency** got
worse for short requests. Why, and what do you do?

**Candidate:** Because batching trades **latency for throughput**, and continuous batching
mixes **prefill and decode** work in ways that hurt the tail:
- A **long prompt's prefill** is compute-heavy and, when it lands in a batch, **stalls the
  decode steps** of every other request in that iteration — a short chat request gets stuck
  behind a 4000-token prefill. This is **head-of-line blocking inside the batch**.
- Bigger batches mean each iteration takes longer, so per-request **time-per-output-token**
  rises even as aggregate throughput rises.

Mitigations:
1. **Chunked prefill** — split a long prefill into smaller chunks and interleave them with
   ongoing decodes, so one giant prompt can't monopolize an iteration. Smooths the tail.
2. **Prioritization / separate pools** — route short, latency-sensitive requests and long,
   throughput-oriented ones to **different replicas** (or priority lanes), so a batch chat
   isn't competing with a 100K-token summarization. This is the "disaggregated prefill/
   decode" idea taken to the deployment level — some setups even run **prefill and decode on
   separate GPU pools** since one is compute-bound and the other memory-bound.
3. **Cap batch size / set a latency SLO** in the scheduler — accept slightly lower
   throughput to protect p99. It's the same throughput-vs-latency knob as everywhere: you
   tune the batch ceiling to the SLA, not to the max the memory allows.

The framing the panel wants: **LLM serving throughput is a memory-and-scheduling problem,
not a FLOPs problem.** Decode is bandwidth-bound; the KV cache is the scarce resource;
continuous batching keeps the GPU fed; PagedAttention lets you fit more sequences; and then
you spend the rest of your time managing the **latency tail** that aggressive batching
creates — chunked prefill and prefill/decode separation. Knowing *why* utilization was 30%
(idle compute waiting on memory during decode) is what makes every fix obvious instead of a
list of buzzwords.

──────────
> **[BANK]** LLM inference = prefill (compute-bound, parallel) + decode (one token at a time,
> **memory-bandwidth-bound** → low GPU util). KV cache (K+V per layer per token, ~GB per long
> request) is the scarce resource. Continuous/in-flight batching refills the batch every
> iteration (vs static batching stalling on the longest seq); PagedAttention pages the KV
> cache (OS-style block tables) to kill fragmentation → bigger batches. Then manage the p99
> tail: chunked prefill, prefill/decode separation.
> **[TRAP]** Thinking inference is FLOPs-bound (it's memory-bound in decode), or that bigger
> batches are free (they raise the latency tail and cause in-batch head-of-line blocking).
> **[GO DEEPER]** [R4.Q5] quantization shrinks weights *and* KV · [R4.Q3] the vector index
> for RAG · [R2.Q10] memory hierarchy thinking.

---

### [R4.Q3] "A billion vectors, 10ms p99 search. Exact nearest-neighbour is out. What do you build?"  ·  `AI` · ★★★★★

**Interviewer:** Semantic search over a billion 768-dim embeddings, p99 under 10 ms. Exact
search is O(N) per query — dead on arrival. What's the index, and what do you trade?

**Candidate:** Exact nearest-neighbour over a billion vectors means a billion dot products
per query — impossible at 10 ms. So you give up *exactness* and use **ANN — Approximate
Nearest Neighbour** — accepting that you find the true top-k *most of the time*, measured by
**recall** (what fraction of the true neighbours you actually return). The whole game is
**recall vs latency vs memory**, and there are two dominant index families.

**HNSW — Hierarchical Navigable Small World** (a graph index):
- Build a multi-layer graph where each vector is a node connected to its neighbours. Upper
  layers are **sparse** (long-range "express" links), lower layers **dense** (short-range
  links) — like a skip list in vector space.
- **Search:** enter at the top layer, greedily hop to the neighbour closest to the query,
  descend a layer, repeat — zooming in from coarse to fine. Search is **~O(log N)** hops,
  not O(N).
- **Strengths:** the **best recall-latency tradeoff** in the industry — sub-millisecond,
  >95% recall. It's the default in pgvector, Qdrant, Weaviate, Elasticsearch.
- **Costs:** **memory-hungry** — the graph (the neighbour links) lives in RAM alongside the
  full vectors, so a billion 768-dim fp32 vectors = `1B × 768 × 4 B ≈ 3 TB` *plus* the graph
  edges. Inserts are relatively expensive (graph maintenance), and **deletes are awkward**
  (you tombstone and rebuild). For a billion vectors, raw HNSW in RAM is eye-wateringly
  expensive.

**IVF — Inverted File index** (a clustering/partitioning approach):
- **Cluster** the vectors into, say, `√N` ≈ 32K cells via k-means; each vector belongs to
  its nearest centroid. At query time, find the `nprobe` **nearest centroids** and search
  **only the vectors in those cells** — pruning the search space to a few cells instead of
  the whole billion.
- **`nprobe` is the recall knob:** probe more cells → higher recall, higher latency; probe
  fewer → faster, lower recall. The classic tradeoff exposed as a single tunable.

The thing that makes a *billion* vectors actually fit is **PQ — Product Quantization** —
which I'd combine with IVF (**IVF-PQ**, the FAISS workhorse for billion-scale):

**Interviewer:** Explain PQ — that's where the real magic for billion-scale lives.

**Candidate:** **Product Quantization** is **lossy compression of the vectors themselves**,
trading recall for an enormous memory reduction — and memory *is* the constraint at a
billion vectors.

The idea: a 768-dim vector is too big to store raw (3 KB at fp32). PQ **splits the vector
into m sub-vectors** (say 96 chunks of 8 dims each), and for each sub-vector space runs
k-means to learn a **codebook** of, say, 256 representative centroids. Then it represents
each sub-vector by the **1-byte id** of its nearest centroid. So a 768-dim vector becomes
**m bytes** (96 bytes here) instead of 3072 — a **~32× compression**. A billion vectors drop
from ~3 TB to ~96 GB, which now fits in RAM on a reasonable machine.

```
 vector (768 dim, 3072 B)
   → split into 96 sub-vectors of 8 dims
   → each sub-vector → nearest of 256 codebook centroids → 1 byte
   → 96 bytes total  (32× smaller)
```

Distance computation gets faster too: you **precompute** the distance from the query's
sub-vectors to all 256 centroids per chunk (a small lookup table), then a vector's distance
is just **summing m table lookups** — no full dot product. This is the **Asymmetric Distance
Computation** trick. The cost is **recall**: PQ is *lossy* — you're comparing against
quantized approximations, so you lose precision. You recover it by **re-ranking**: use
IVF-PQ to fetch a larger candidate set fast and cheap, then **re-score the top candidates
with the full-precision vectors** (kept on disk/SSD) to get exact ordering on the shortlist.
Coarse-and-fast then exact-on-the-shortlist.

So my **billion-scale design**: **IVF-PQ** — IVF to prune to a few cells, PQ to make the
billion vectors fit in RAM, re-ranking with full vectors for the final top-k. I'd shard the
index across machines by cell (a query fans out only to shards owning its probed cells),
replicate for availability, and keep `nprobe` and the PQ code size as the two dials I tune
against the 10 ms / recall SLA. If the dataset were merely *millions*, I'd just use **HNSW**
in RAM and skip the complexity — its recall-latency is better and memory is affordable
there. **The index choice is a function of scale: HNSW for millions, IVF-PQ (+ re-rank) for
billions**, because at a billion vectors the binding constraint flips from "search speed" to
"do the vectors even fit in memory," and PQ is the answer to *that* question.

──────────
> **[BANK]** Billion-scale semantic search = ANN, traded on recall/latency/memory. HNSW =
> multi-layer proximity graph, ~O(log N) hops, best recall-latency, but RAM-hungry (graph +
> full vectors) → great for *millions*. IVF = cluster + probe `nprobe` cells (recall knob).
> PQ = split vector into sub-vectors, replace each with a 1-byte codebook id → ~32×
> compression so a billion vectors fit in RAM (lossy → re-rank top candidates with full
> vectors). Billion-scale = IVF-PQ + re-rank; millions = HNSW.
> **[TRAP]** Proposing exact search or pure in-RAM HNSW at billion scale (3 TB+), or
> forgetting re-ranking to recover PQ's lost precision.
> **[GO DEEPER]** [R1.Q5] embeddings & why we search them · [R4.Q4] RAG built on this index ·
> [R2.Q4] B+tree (why it *can't* do nearest-neighbour — ordered ≠ similar).

---

### [R4.Q4] "Your RAG demo was great. In production it confidently lies. Debug it."  ·  `AI` · ★★★★★

**Interviewer:** You built RAG — embed docs, retrieve, stuff into the prompt, generate. The
demo wowed everyone. In production it gives confident, wrong answers. Walk the pipeline and
find the failure modes.

**Candidate:** RAG fails at **every stage**, and "confident but wrong" specifically points
at **retrieval** feeding the model bad or missing context that it then fluently rationalizes.
Let me walk the pipeline and name the failure at each stage, because "the LLM hallucinates"
is the junior diagnosis — the LLM is usually doing its job on garbage input.

```
 docs → [chunk] → [embed] → [vector store] → [retrieve top-k] → [rerank] →
        [stuff into prompt] → [LLM generate] → answer
           ▲ each arrow is a place it breaks
```

**1. Chunking (the most underrated failure).** You split docs into chunks before embedding.
If chunks are **too large**, a chunk covers many topics and its embedding is a muddy
average — it matches everything weakly and nothing strongly. **Too small**, and a chunk
loses the context that makes it meaningful (a sentence that says "it increased 40%" with no
subject). **Naive fixed-size splitting** cuts mid-sentence, mid-table, mid-thought, so the
retrieved chunk is a fragment the LLM must guess around. Fix: **semantic / structure-aware
chunking** (split on headings, paragraphs, sentence boundaries), **overlap** between chunks
so context isn't severed at the boundary, and sometimes **small chunks for retrieval but
fetch the surrounding parent** for generation (small-to-big).

**2. Embedding / retrieval mismatch.** The query and the documents may live in **different
"spaces"** — a short question ("refund policy?") embeds differently from a long formal
document chunk, even when they're about the same thing. Pure **semantic (dense) retrieval**
also **misses exact-match** needs — product codes, error numbers, names — because embeddings
capture *meaning*, not literal tokens. Fix: **hybrid search** — combine dense (semantic) with
sparse **BM25/keyword** retrieval and fuse the rankings, so "SKU-4471" matches literally
while "how do I get my money back" matches semantically.

**3. Top-k retrieval quality.** If `k` is too small you miss the relevant chunk; too large
and you dilute the prompt with irrelevant context, which **actively degrades** the answer —
LLMs exhibit **"lost in the middle,"** attending well to the start and end of the context
but **ignoring the middle**, so a correct chunk buried at position 7 of 12 gets overlooked.
Fix: **rerank** — retrieve a broad candidate set with the cheap vector index, then reorder
with a **cross-encoder reranker** (which actually reads query+chunk together, far more
accurate than the bi-encoder embedding) and pass only the top few, placing the best at the
edges.

**4. The "confident lie" itself — generation.** Even with good context, the LLM may **ignore
the retrieved docs and answer from its parametric memory** (stale or wrong), or **over-
extrapolate** beyond what the context supports. And critically — if retrieval returned
**nothing relevant**, a naive prompt still asks the model to answer, so it **makes something
up** rather than saying "I don't know." Fixes: **prompt for grounding** ("answer *only* from
the context; if the answer isn't there, say you don't know"), **require citations** (force
the model to point to the chunk it used, which both reduces fabrication and makes errors
auditable), and a **relevance gate** — if the top retrieval score is below a threshold,
short-circuit to "I don't have information on that" instead of generating.

**Interviewer:** Pick the *one* you'd instrument first to find where it's actually breaking.

**Candidate:** I'd **measure retrieval quality in isolation first**, because it's the most
common root cause and the cheapest to verify. Concretely: build an eval set of real
questions with their known-correct source chunks, and measure **retrieval recall@k** — *for
what fraction of questions is the correct chunk even in the retrieved set?* This **decouples
retrieval from generation**: if recall@k is low, the LLM never had a chance — fix chunking/
embedding/hybrid-search, and *no* amount of prompt engineering will help. If recall@k is
*high* but answers are still wrong, the bug is downstream — reranking order, "lost in the
middle," or the generation prompt — and now I tune *those*.

That decomposition is the senior instinct: **RAG is a pipeline, so debug it as a pipeline
with a metric per stage** (retrieval recall@k, rerank precision, faithfulness/groundedness
of the final answer against the context) rather than staring at the final wrong answer and
blaming "the model." Most teams discover their "LLM hallucination problem" is actually a
**chunking-and-retrieval problem** — the model is faithfully working with context that never
contained the answer. The fix to "it confidently lies" is usually "make sure the right chunk
is retrieved *and* tell the model to abstain when it isn't," not a bigger model.

──────────
> **[BANK]** RAG fails at every stage, and "confident lie" usually = bad/missing
> *retrieval*, not the LLM. Chunking (semantic + overlap, small-to-big) → embedding (hybrid
> dense+BM25 for exact matches) → top-k (rerank with a cross-encoder; beware "lost in the
> middle") → generation (ground-only prompt + citations + relevance gate to abstain). Debug
> by measuring **retrieval recall@k in isolation** first.
> **[TRAP]** Blaming "the model hallucinates" and reaching for a bigger LLM, when the
> correct chunk was never retrieved. Pure dense retrieval missing exact-match (codes/IDs).
> **[GO DEEPER]** [R4.Q3] the vector index doing retrieval · [R1.Q5] embeddings · [R4.Q2]
> serving the generation step.

---

### [R4.Q5] "A 70B model, an A100. Does it fit? Show me."  ·  `AI` · ★★★★☆

**Interviewer:** You want to serve a 70-billion-parameter model on a single 80 GB A100. Do
the math out loud. Does it fit?

**Candidate:** Let me do the napkin math, because the answer depends entirely on
**precision**, and the headline number is just `params × bytes-per-param`:

- **fp32 (4 bytes):** `70B × 4 = 280 GB` — needs 4 A100s just for weights. Dead.
- **fp16 / bf16 (2 bytes):** `70B × 2 = 140 GB` — still **doesn't fit** on one 80 GB card.
  Needs 2 GPUs.
- **int8 (1 byte):** `70B × 1 = 70 GB` — fits in 80 GB for the *weights*… but barely, and
  I've left no room for the **KV cache** or activations. In practice tight/risky on one card.
- **int4 (0.5 bytes):** `70B × 0.5 = 35 GB` — comfortably fits weights, leaving ~40+ GB for
  KV cache and activations. **This is the realistic single-A100 answer.**

So the honest answer: **not at fp16; yes at int4 (and marginally at int8).** And I haven't
even counted the KV cache yet — for a 70B model the per-token KV is large, so at int4 the
remaining ~40 GB is what bounds your batch size and context length. Memory budget on a GPU
is always **weights + KV cache + activations + framework overhead**, and people forget the
last three and OOM in production after "it loaded fine."

**Interviewer:** int4 sounds like a free lunch — 8× smaller than fp32. What did you actually
give up, and why doesn't the model become garbage?

**Candidate:** It's not free — **quantization trades precision for memory and speed**, and
the reason it isn't garbage is that *LLMs are remarkably robust to weight precision* but
**not uniformly**, so the good methods are clever about *what* they keep precise.

What you give up:
1. **Accuracy** — some quality loss, measured as perplexity increase or benchmark drop.
   Naive **round-to-nearest** int4 *does* noticeably degrade a model. The art is keeping the
   loss small.
2. **The naive failure: outliers.** A few weights/activations have **huge magnitudes**
   (outlier features), and if you pick a single quantization scale for a whole tensor, those
   outliers either saturate or force a coarse scale that destroys the precision of the many
   small values. This is why dumb quantization wrecks quality.

Why modern int4 *works* — the methods handle outliers and calibrate per-group:
- **GPTQ** quantizes layer by layer, using second-order (Hessian) information to adjust the
  remaining weights to **compensate for each rounding error** as it goes — so the cumulative
  error stays small.
- **AWQ (Activation-aware Weight Quantization)** notices that not all weights matter equally
  — it identifies the **salient weight channels** (those multiplied by large activations) and
  protects them (scales them to preserve precision) while quantizing the rest aggressively.
- **Per-group scales** (e.g. a separate scale per 128 weights) instead of one per tensor, so
  a local outlier only coarsens its small group, not the whole layer.

The result is int4 with often **<1% quality loss** on many tasks — which is why it's the
default for fitting big models on one GPU. The deeper tradeoff to name: there's also
**weight-only** quantization (compress weights to int4 but **compute in fp16** by
dequantizing on the fly — this is the common case, and it speeds up *memory-bound decode*
because you move 4× less weight data per token, which is exactly the bottleneck from Q2)
versus **full int8 compute** (W8A8 — quantize activations too and use int8 tensor cores,
which speeds up *compute-bound prefill* but is harder because activation outliers are worse
than weight outliers). So quantization isn't one thing — it's a set of choices about
**which precision, which tensors, weight-only vs activations, and how you handle outliers**,
tuned to whether you're bottlenecked on memory (decode) or compute (prefill).

The summary the panel wants: **`params × bytes-per-param` is the first-order memory model;
precision is the dial; int4 weight-only is the pragmatic way to fit a 70B on one 80 GB A100,
and it works — despite being 8× smaller than fp32 — because methods like GPTQ/AWQ protect the
outlier weights that naive rounding would destroy.** And it directly helps serving throughput
because decode is memory-bandwidth-bound, so smaller weights = faster tokens, not just
"fits."

──────────
> **[BANK]** GPU memory ≈ params × bytes/param (+ KV cache + activations + overhead). 70B:
> fp32 280 GB, fp16 140 GB (needs 2 GPUs), int8 70 GB (tight), **int4 35 GB (fits one 80 GB
> A100)**. Quantization trades accuracy for memory/speed; naive RTN fails on **outliers**, so
> GPTQ (Hessian error compensation) / AWQ (protect salient channels) / per-group scales keep
> int4 loss <1%. Weight-only int4 speeds up memory-bound decode specifically.
> **[TRAP]** Forgetting KV cache + activations + overhead beyond weights (OOM after "it
> loaded"), or thinking int4 is lossless / that naive rounding is what production uses.
> **[GO DEEPER]** [R4.Q2] why smaller weights speed up decode (bandwidth) · [R4.Q3] PQ is
> the *same* quantization idea for vectors.

---

### [R4.Q6] "Inference is your slowest stage. Traffic spikes 10×. Design the pipeline so it doesn't fall over."  ·  `PS`·`AI` · ★★★★★

**Interviewer:** Event-driven pipeline: requests come in, hit an expensive GPU inference
step, results go out. Traffic spikes 10× in a flash sale. The GPU can't scale instantly.
Design it so the system degrades gracefully instead of collapsing.

**Candidate:** The core problem is an **impedance mismatch**: requests arrive in unbounded
bursts, but the GPU processes at a **fixed, hard-limited rate** (you can't conjure GPU
capacity in milliseconds — model load alone is tens of seconds). So the design principle is
**decouple arrival from processing with a queue, and apply backpressure so the queue can't
sink the system.** Synchronous request→GPU→response *cannot* survive a 10× spike; the GPU
saturates, latency climbs, callers time out and **retry**, retries pile on more load, and you
get a **retry-storm collapse**. The whole design is about breaking that loop.

**The architecture:**
```
 ingress → [bounded queue / Kafka] → [batcher] → GPU workers → results topic → callers
              │ backpressure when full        │ continuous batching (R4.Q2)
              └ load shedding / 429            └ autoscale on queue depth
```

1. **A queue between ingress and inference** (Kafka or SQS). Requests are accepted and
   buffered; GPU workers pull at *their own* sustainable rate. This **absorbs the burst** —
   the queue is a shock absorber that converts a 10× *instantaneous* spike into a longer tail
   of work at the GPU's max throughput. Make it **async**: the caller gets a request-id and
   polls / gets a callback / reads a result topic, rather than holding a synchronous
   connection open while the GPU is backed up.

2. **The queue is BOUNDED, and that's the whole point.** An unbounded queue doesn't solve
   overload — it **hides it** until you OOM or until items sit so long they're useless
   (you'd compute results for requests that timed out 30 s ago — pure waste). A bounded queue
   gives you **backpressure**: when it's full, you must *do* something, and that something is
   **load shedding** — reject new requests fast with a **429 / "try later,"** rather than
   accept work you can't finish. **Shedding load early is a feature**: a fast rejection lets
   the caller back off, whereas silently queuing forever turns into cascading timeouts.

3. **Backpressure must propagate upstream.** The GPU worker pulls only when it has capacity
   (it doesn't accept a new batch mid-flight); the queue signals fullness to ingress; ingress
   sheds. Backpressure is **the inverse of the rate limiter** in Q1 — there I protected a
   downstream from too many requests; here the *downstream itself* (GPU) signals "I'm full,
   slow down," and that signal flows back to the edge.

4. **Continuous batching at the GPU** (from Q2) maximizes throughput per GPU so the queue
   drains as fast as physically possible — the batcher pulls as many queued requests as fit
   and runs them together.

5. **Autoscale on queue depth / age, not CPU.** GPU CPU% is a lie for this workload; the real
   signal is **how deep and how old the queue is**. Scale workers up when backlog grows — but
   acknowledge the **cold-start lag** (loading a 70B model takes tens of seconds), so keep
   **warm standby capacity** for spikes and treat autoscaling as the medium-term relief while
   the queue + shedding handle the instant.

**Interviewer:** During the spike you're shedding load. How do you decide *what* to shed so
it's not random damage?

**Candidate:** Shedding should be **prioritized and deadline-aware**, not FIFO-blind —
random shedding under load is how you drop the requests that mattered most.

1. **Priority tiers / quality of service.** Paying customers, checkout, and interactive
   requests get priority lanes; best-effort and background work (pre-warming caches, batch
   analytics, low-tier free traffic) gets shed first. Implement as separate queues or a
   priority queue, so when capacity is scarce, the GPU spends it on what's most valuable.

2. **Drop stale work — deadline propagation.** Every request carries a **deadline/TTL**, and
   the worker **checks it before processing**: if a queued request has already blown its
   client timeout, **drop it without running the GPU** — computing a result nobody is waiting
   for is the worst kind of waste under overload, because it steals capacity from requests
   that *can* still be served in time. This is the single highest-leverage shedding rule:
   never spend your scarcest resource on work whose answer is already useless.

3. **Graceful degradation, not binary fail.** Where possible, offer a **cheaper fallback**
   instead of a hard 429: route to a **smaller/quantized model** (lower quality but fast), a
   **cached/precomputed** answer, or a non-AI heuristic. The user gets a *degraded* answer
   instead of *no* answer — far better than a blanket failure.

4. **Shed early and cheaply, at the edge.** Reject at ingress *before* the request consumes
   downstream resources, return a clear **`429` with `Retry-After`**, and rely on **client
   backoff with jitter** so rejected clients don't synchronize and re-stampede.

The unifying principle: **under overload, a system's job is to protect its ability to serve
*some* requests well, not to attempt all of them and serve none.** That means a bounded
queue (not unbounded), backpressure that propagates to the edge, prioritized + deadline-aware
shedding (drop stale and low-value work first), and graceful degradation to cheaper paths —
so a 10× spike yields "we served the important traffic and fast-rejected the rest" instead of
"everything timed out." A queue isn't just a buffer; **the bound on the queue, and what you
do when you hit it, is the actual design.**

──────────
> **[BANK]** Spike-proof an expensive-stage pipeline: **bounded** queue decouples arrival
> from a fixed-rate GPU (shock absorber) → backpressure propagates to the edge → **load shed
> early** (429 + Retry-After + jittered backoff) rather than queue unboundedly. Shed smart:
> priority tiers + **deadline-aware drop of stale work** (never run the GPU on an already-
> timed-out request) + degrade to a smaller/cached model. Autoscale on **queue depth/age**,
> keep warm standby for cold-start lag.
> **[TRAP]** Unbounded queue (hides overload → OOM, computes dead results), synchronous
> calls into the GPU (retry storms), FIFO shedding (drops high-value/fresh work alongside
> junk).
> **[GO DEEPER]** [R4.Q1] rate limiting as the inverse · [R4.Q2] continuous batching draining
> the queue · [R3.Q5] consumer scaling.

---

### [R4.Q7] "Your SLA is p99 under 50ms. The JVM service GCs. Reconcile that."  ·  `JVM` · ★★★★☆

**Interviewer:** A latency-critical JVM service must hold **p99 < 50 ms**. The GC pauses the
world. How do you even reason about whether that SLA is achievable — give me the budget
math?

**Candidate:** The key insight is that **GC pauses hit p99/p999 specifically**, because a
pause freezes *every* in-flight request simultaneously — so even rare pauses dominate the
*tail* even if the *average* is fine. So the reasoning is a **pause budget** against the
tail, not the mean.

The back-of-envelope:
- p99 < 50 ms means **at most 1% of requests** may exceed 50 ms. If a GC pause is, say,
  **30 ms**, then during that pause **every** concurrent request eats +30 ms. The question
  becomes: *how often can I afford a 30 ms pause such that fewer than 1% of requests are
  caught in one?*
- If I serve 10,000 req/s and each request takes ~5 ms, I have ~50 requests in flight at any
  instant. A single 30 ms pause delays all ~50 of them past budget. Over one second that's
  50 affected requests out of 10,000 = **0.5%** — *per pause per second*. So even **one
  30 ms pause per second** already spends half my entire 1% tail budget. Two pauses a second
  and I've blown p99. That math shows the SLA is **viable but fragile** with a 30 ms-pause
  collector — and *not* viable if pauses are 100+ ms.

So the budget forces collector choice: with **G1** targeting `MaxGCPauseMillis=...`, pauses
scale with live-set and you'll see occasional larger ones (and the **time-to-safepoint**
risk from R2.Q8 — a poll-less loop can give you a 200 ms freeze the GC logs won't even
show). To *reliably* hold p99 < 50 ms I'd move to **ZGC or Shenandoah** (R2.Q8), whose pauses
are **sub-millisecond and don't scale with heap** — they take GC off the tail budget almost
entirely, at the cost of some throughput (the load-barrier tax). That's the right trade for a
latency SLA: spend throughput to buy a flat tail.

**Interviewer:** Suppose you're stuck on G1 for now. What do you tune, and what's the
non-GC move?

**Candidate:** Two fronts — **reduce GC pressure** and **reduce what GC even has to do** —
and then the real senior move, **stop allocating**:

*Tuning G1:*
- **Size the heap and generations to reduce collection frequency** — a bigger young gen
  means minor collections run less often (fewer pause events to catch requests), though each
  is slightly longer; tune `MaxGCPauseMillis` and young-gen sizing to the budget.
- **Reduce allocation rate** — the GC runs because you generate garbage; halve the garbage
  and you roughly halve the collection frequency. Most "GC problems" are **allocation
  problems** in disguise.
- **Watch for promotion / humongous objects** — objects that survive to old gen trigger the
  expensive mixed collections; large objects (>½ region) are "humongous" and allocated
  specially, causing fragmentation and more frequent old-gen work.

*The non-GC move — allocate less, or off-heap:*
- **Object pooling / reuse** for hot-path objects (buffers, request contexts) so you're not
  minting millions of short-lived objects — directly cuts the allocation rate that *drives*
  GC. (Carefully — pooling can backfire by promoting objects to old gen.)
- **Off-heap / direct buffers** for large data (Netty's pooled `ByteBuf`, off-heap caches)
  so it **never enters the GC-managed heap** — the GC can't pause for memory it doesn't
  manage. This is how low-latency systems (trading, Cassandra's off-heap structures) sidestep
  GC for their biggest data.
- **Primitive/value-based design** (R1.Q4) — avoid autoboxing and object-per-element
  collections; use primitive arrays so a million numbers are one allocation, not a million.
- The extreme version is **"zero-allocation on the hot path"** — the LMAX/HFT discipline:
  pre-allocate everything at startup, reuse it forever, and the steady-state allocation rate
  is ~0, so the GC **essentially never runs** during trading hours. You've turned a GC
  problem into a *design* problem and solved it upstream.

The framing the panel wants: **a GC SLA is a tail-latency budget, and you reason about it as
"how often can I afford a pause of size X before it eats my 1% tail."** That budget tells you
whether to (a) switch to a concurrent low-pause collector (buy a flat tail with throughput),
(b) tune G1's frequency/heap, or (c) — the deepest fix — **reduce allocation so the GC has
nothing to do**, via pooling, off-heap, and primitive layouts. "Just add `-XX:+UseZGC`" is a
valid first move; "I profiled the allocation hot path and moved the buffers off-heap so the
collector stopped firing" is the answer that says you understand the GC is reacting to *your*
garbage. Knowing the *math* of the budget is what turns "GC is slow" into a quantified,
solvable engineering problem.

──────────
> **[BANK]** GC pauses hit **p99/p999**, not the mean — a pause freezes all in-flight
> requests at once. Reason via a **tail budget**: a 30 ms pause × ~50 in-flight reqs ≈ 0.5%
> of 10k req/s spent *per pause/sec* — so even ~1 pause/sec can blow p99<50 ms. Fix order:
> ZGC/Shenandoah (flat sub-ms pause, costs throughput) → tune G1 heap/frequency → **reduce
> allocation** (pooling, off-heap buffers, primitives) so the GC barely runs. Watch
> time-to-safepoint (R2.Q8).
> **[TRAP]** Reasoning about GC via *average* pause time (it's a tail problem), or treating
> it as untunable instead of an allocation problem you can attack at the source.
> **[GO DEEPER]** [R2.Q8] G1 vs ZGC mechanics & safepoints · [R1.Q4] autoboxing as an
> allocation source · [R5] tune-vs-rewrite judgment.

---

## Round 4 — closing note from the panel

This round rewards **altitude with numbers.** Every strong answer named the **binding
constraint** first — for the rate limiter it was coordination cost; for LLM serving it was
memory bandwidth and the KV cache; for billion-scale search it was whether the vectors *fit
in RAM*; for the spike it was the impedance mismatch between bursty arrival and fixed GPU
rate; for the GC SLA it was the tail budget. Designs flow naturally once you've found the
constraint and stated the tradeoff you're making against it (and which way you fail). The
candidates who struggle list components; the ones who get the offer **reason from the
bottleneck and defend the failure mode they chose.**

Proceed to [Round 5 — Bar-raiser](./05-round-5-bar-raiser.md), where the panel stops asking
"how does it work" and starts asking "you said X earlier — now defend it, and tell me when
you'd be wrong."
