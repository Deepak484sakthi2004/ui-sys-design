# Interview 04 — LLM Serving / AI-Infra Startup

> **The company:** Builds an LLM **inference platform** — a vLLM/TensorRT-LLM-class serving
> engine that other companies run their models on. Their margin *is* tokens-per-dollar-per-GPU,
> so every percent of throughput is the business. **The role:** Inference platform engineer.
> **The panel:** An engineer who has profiled attention kernels and a systems person who thinks
> of a GPU as "a memory-bandwidth device that occasionally does math." 
>
> **What they're testing:** Do you understand that LLM serving is a **scheduling and memory
> problem**, not a model problem — and can you reason about the throughput/latency frontier in
> real numbers? Domains: `AI`. Goes deeper than loop [R4](../04-round-4-design-ai-infra.md);
> read that first for the foundations.

7 exchanges. ★★★★ — ★★★★★.

---

### [I04.Q1] "A customer complains the model is 'slow.' What do you even measure?"  ·  ★★★★☆

**Interviewer:** "It's slow" is useless. Define the latency SLOs for an LLM serving system, and
tell me why there's more than one.

**Candidate:** LLM latency is **two fundamentally different numbers** because generation has two
phases (loop [R4.Q2], prefill vs decode), and conflating them is the root of most bad serving
decisions. The metrics:

1. **TTFT — Time To First Token.** How long from request arrival until the *first* output token
   appears. This is dominated by **prefill** (processing the whole prompt) plus any queue wait.
   It's what the user perceives as "responsiveness" — the model "starting to type." For a chat
   UI, TTFT is the felt latency; a 2-second TTFT feels broken even if generation is then fast.
   TTFT scales with **prompt length** (longer prompt = more prefill compute) and with queue depth.
2. **TPOT / ITL — Time Per Output Token (a.k.a. Inter-Token Latency).** The time between each
   subsequent token during **decode**. This sets the **streaming speed** — how fast text flows
   after it starts. Users read at ~5–10 tokens/sec, so a TPOT giving ≥20 tok/s feels smooth;
   slower feels laggy.
3. **End-to-end latency** = TTFT + (output_length × TPOT). For a long generation, TPOT dominates;
   for a short answer to a long prompt, TTFT dominates.
4. **Throughput** — total tokens/sec across *all* concurrent requests, the system-wide number
   that determines **cost per token** (the business metric).

The reason it matters that these are separate: **they trade off against each other and against
throughput.** Bigger batches raise throughput (more tokens/sec/GPU → lower cost) but *raise* TPOT
(each decode iteration processes more sequences, so each token takes longer) and can hurt TTFT (a
new request waits for a batch slot). So "make it faster" is ambiguous — faster TTFT? faster TPOT?
cheaper throughput? — and you optimize different things for each.

**Interviewer:** Give me the concrete tension: a chat product vs a batch-summarization product.
Same model, different SLOs. What changes?

**Candidate:** They sit at **opposite ends of the throughput-latency frontier**, and you'd
configure — ideally *deploy* — them differently:

- **Interactive chat:** **TTFT and TPOT are sacred**, throughput is secondary. A user is staring
  at the screen. So: **smaller batch sizes** (less queue wait, lower per-token latency), **chunked
  prefill** (loop [R4.Q2] — so a long prompt doesn't stall others' tokens), **prioritize TTFT** in
  the scheduler, maybe cap concurrency to protect tail latency. You accept lower GPU utilization
  (higher cost/token) to keep it snappy. You'd set an **SLO like "p99 TTFT < 500ms, p99 TPOT <
  50ms."**
- **Batch summarization / offline:** **throughput is everything**, latency barely matters — nobody
  watches a batch job. So: **maximum batch sizes**, pack the GPU to the memory limit, don't bother
  with chunked prefill or prioritization, just maximize tokens/sec/GPU to minimize cost. A
  request taking 30s instead of 3s is fine if you process 10× more of them per dollar. SLO is
  "tokens/dollar," not latency.
- **The deployment consequence:** you don't serve both from the same pool with the same config,
  because their optimal operating points are incompatible — batching that's great for
  summarization destroys chat's TPOT. You either run **separate replica pools** (chat pool tuned
  for latency, batch pool tuned for throughput) or use **priority lanes** where interactive
  requests preempt/jump ahead of batch ones (loop [R4.Q6] backpressure/prioritization). Mixing
  them naively means the long batch prefills cause head-of-line blocking for the chat users (loop
  [R4.Q2]).

So my answer to "it's slow": *which* slow — TTFT (responsiveness, fix prefill/queue) or TPOT
(streaming speed, fix batch size/decode)? — and *which product*, because the same model has
opposite SLOs for chat vs batch, and you tune (or separate) the deployment to the frontier point
each one needs. The framing the panel wants: **LLM serving has no single "latency" — it has TTFT,
TPOT, and throughput in tension, and good serving is choosing the right point on that frontier per
workload, not maximizing one number.**

──────────
> **[BANK]** LLM latency = **TTFT** (time to first token, dominated by prefill + queue, scales with
> prompt length — felt responsiveness) and **TPOT/ITL** (time per output token, decode speed —
> streaming smoothness), plus **throughput** (tokens/sec → cost). They **trade off**: bigger batch
> → more throughput but worse TPOT/TTFT. Chat = protect TTFT/TPOT (small batches, chunked prefill,
> lower util/higher cost); batch = max throughput (huge batches). Separate pools or priority lanes;
> don't co-mingle (long prefills HoL-block chat).
> **[TRAP]** Treating "latency" as one number; co-serving interactive + batch in one pool with one
> config; optimizing throughput while blowing TTFT (or vice versa).
> **[GO DEEPER]** loop [R4.Q2] prefill/decode & batching · [I04.Q3] the scheduler · [I04.Q6]
> multi-tenant prioritization.

---

### [I04.Q2] "Two users send the same 2,000-token system prompt. You computed its KV cache twice. Why is that criminal?"  ·  ★★★★★

**Interviewer:** A RAG app sends the same long system prompt + few-shot examples on every request
— 2000 identical tokens, then a short unique question. Your engine recomputes the KV cache for
those 2000 tokens every time. What's the waste, and the fix?

**Candidate:** The waste is **enormous and entirely avoidable**: those 2000 identical prefix tokens
get their **KV cache recomputed from scratch on every single request**, and prefill is the
compute-heavy phase (loop [R4.Q2]). For a RAG/agent workload where 90%+ of the prompt is a shared
prefix (system prompt, instructions, few-shot examples, even a shared document), you're burning the
**majority of your prefill FLOPs recomputing identical work** — directly torching TTFT and
throughput. At scale that's most of your GPU bill spent on redundancy.

The fix is **prefix caching** (a.k.a. automatic prefix caching / KV cache reuse), and it's a direct
consequence of **PagedAttention's** design (loop [R4.Q2]):

- Because PagedAttention stores the KV cache in **fixed-size blocks** with a block table (like OS
  pages), and the KV for a token depends only on the tokens *before* it, **two requests sharing a
  prefix produce identical KV blocks for that prefix**. So you can **cache and share** those blocks
  across requests instead of recomputing them.
- Mechanically: hash the prefix (block by block), and on a new request, **look up whether KV blocks
  for this prefix already exist**; if so, **reuse them** (the block table just points at the
  existing physical blocks — **copy-on-write** so a request that diverges gets its own block from
  the divergence point). You only compute prefill for the **new, unique suffix** (the user's actual
  question).
- Result: for a 2000-token shared prefix + 50-token question, you go from prefilling 2050 tokens to
  prefilling ~50 — a **~40× reduction in prefill work** for that request, collapsing TTFT and
  freeing the GPU for more requests.

```
 request A: [system prompt 2000 toks][question A]  → compute KV for all
 request B: [system prompt 2000 toks][question B]
   prefix caching: reuse A's KV blocks for the shared 2000 toks (CoW),
                   prefill only [question B]  → ~40× less prefill
```

**Interviewer:** Cached KV blocks consume the same scarce GPU memory as live requests' KV cache.
How do you decide what to keep, and what breaks if you get it wrong?

**Candidate:** Right — prefix-cache blocks **compete with active-request KV cache for the same
scarce VRAM** (loop [R4.Q5] — memory is *the* constraint), so it's a **caching/eviction problem**
under memory pressure, and getting it wrong means either OOM or thrashing:

- **Eviction policy — LRU on cached prefix blocks.** When memory is needed for active requests,
  evict the **least-recently-used** prefix blocks first. A hot shared system prompt stays resident
  (reused constantly → always recent); a one-off prefix gets evicted. This is exactly an OS page
  cache (the PagedAttention analogy runs all the way through). Some engines add reference counting
  — a block in use by an active request can't be evicted; only unreferenced cached blocks are
  eviction candidates.
- **The failure if you over-cache:** you starve **active requests** of KV memory, which **shrinks
  the batch size** (fewer sequences fit, loop [R4.Q2]) → throughput *drops*. You've traded prefill
  savings for a smaller batch — net loss. So prefix caching must yield to live demand: cached
  blocks are *reclaimable*, active KV is not.
- **The failure if you under-cache / wrong granularity:** if your block size or hashing means
  near-identical prefixes don't actually share (e.g. a tiny difference at token 5 invalidates the
  whole cache), you get no reuse. Block-level hashing with a sensible block size (e.g. 16 tokens)
  maximizes the shared prefix length you can capture before divergence.
- **Correctness caveat:** the cache key must include **everything that affects the KV** — the model
  version, the exact tokens, and any position/rope details — or you'd serve KV computed for a
  *different* context and produce garbage. Prefix identity must be exact.

So the design: **prefix caching reuses KV blocks for shared prompt prefixes (a free, huge TTFT/
throughput win for RAG/agent/few-shot workloads, enabled by PagedAttention's block structure +
copy-on-write), managed as an LRU cache that yields VRAM to active requests under pressure, with
exact prefix-identity keys.** The unifying insight the panel wants: **KV cache is the scarce
resource (loop [R4.Q5]), and the two biggest serving wins — PagedAttention (don't *waste* KV
memory) and prefix caching (don't *recompute* KV) — are both about treating the KV cache like a
precious, OS-managed memory hierarchy: page it, share it, cache it, evict it.** Recomputing an
identical 2000-token prefix per request is criminal because it's pure, repeated waste of your most
constrained resource.

──────────
> **[BANK]** **Prefix caching** reuses KV-cache **blocks** across requests that share a prompt
> prefix (system prompt / few-shot / RAG context) — enabled by PagedAttention's block table +
> copy-on-write. Prefill only the unique suffix → up to ~40× less prefill, collapsing TTFT &
> freeing the GPU. Manage as an **LRU cache that yields VRAM to active requests** (cached blocks
> reclaimable, active KV not); exact prefix-identity keys (model+tokens) or you serve garbage.
> **[TRAP]** Recomputing identical prefix KV per request (most of your prefill bill on RAG/agent
> workloads); over-caching and starving active KV (shrinks batch → throughput drops); inexact
> cache keys → wrong-context KV.
> **[GO DEEPER]** loop [R4.Q2] PagedAttention/KV cache · loop [R4.Q5] memory constraint · [I04.Q3]
> the scheduler balancing cache vs active.

---

### [I04.Q3] "Walk me through your batching scheduler, iteration by iteration."  ·  ★★★★★

**Interviewer:** You've said "continuous batching" a few times. I want the scheduler's actual
loop — what decisions does it make every iteration, and what makes it hard?

**Candidate:** The **continuous-batching scheduler** runs a loop where **each iteration produces
one token for every sequence currently in the batch**, and between iterations it admits/evicts
sequences (loop [R4.Q2] — iteration-level scheduling, vs static batching that locks a batch until
all finish). The per-iteration decisions:

```
 loop forever:
   1. ADMIT: pull waiting requests into the running batch IF there's KV-cache room
   2. (handle prefill vs decode mix — see below)
   3. RUN one forward pass → one new token for every running sequence
   4. APPEND each token's KV to its blocks; check stop conditions (EOS, max_len)
   5. EVICT finished sequences → free their KV blocks
   6. handle preemption if memory is exhausted (see Q below)
```

The decisions that make it hard:
1. **Admission under memory pressure.** Step 1 must check: does the candidate sequence's KV cache
   (its prompt length → blocks needed) **fit in remaining VRAM** alongside everything running? KV
   grows every token (loop [R4.Q5]), so admitting too aggressively risks running out mid-flight.
   The scheduler tracks free blocks and admits only what fits — this is the core
   memory-vs-throughput tradeoff every iteration.
2. **Prefill vs decode interleaving.** A newly admitted request needs a **prefill** (compute-heavy,
   processes its whole prompt) while existing requests need **decode** (one token each). If you run
   a big prefill in an iteration, it **stalls everyone's decode** (head-of-line blocking, loop
   [R4.Q2]) — the chat users' tokens pause while a 4000-token prompt prefills. So the scheduler
   uses **chunked prefill**: split the long prefill into chunks and interleave them with decode
   steps across several iterations, so no single iteration is monopolized. This smooths TPOT at a
   small cost to the prefilling request's TTFT.
3. **The batch composition is dynamic** — sequences finish at different lengths (some hit EOS at 10
   tokens, some run to 500), so every iteration the batch changes; the scheduler keeps it **full**
   by backfilling freed slots immediately, which is *the* throughput win over static batching (no
   idle slots waiting for the longest sequence).

**Interviewer:** You admitted requests greedily and now you're out of KV memory mid-generation. You
can't just drop a half-finished response. What does the scheduler do?

**Candidate:** This is **preemption**, and it's the scheduler's hardest job — because unlike a CPU
scheduler that can cheaply context-switch, an LLM sequence has a **large KV-cache state** that's
expensive to move or rebuild. When memory is exhausted and a running sequence needs to grow its KV
but there are no free blocks, the scheduler must **preempt** some sequence to free memory. Two
strategies:

1. **Recomputation (preempt-and-recompute).** Evict a victim sequence's KV cache entirely (free its
   blocks), and when memory frees up later, **re-admit it and recompute its KV from its tokens**
   (re-prefill). Cheap on memory (you store nothing), but you **redo the prefill work** for the
   evicted sequence when it resumes — wasted compute. Good when KV is large relative to
   recomputation cost.
2. **Swapping (preempt-and-swap).** **Copy the victim's KV blocks out to CPU/host memory** (offload
   to RAM), freeing GPU VRAM, and **swap them back** when memory is available. Saves the
   recomputation but costs **PCIe bandwidth** moving GBs of KV between GPU and host (slow), and host
   RAM. Good when recomputation would be very expensive (huge prompts).

Either way, the scheduler picks a **victim** (often the most-recently-arrived, or lowest-priority,
or the one with the most KV to reclaim — like a page-replacement policy), preempts it, serves the
sequences that *can* make progress, and resumes the victim later. The user's response isn't dropped
— it's **paused and resumed**, just with a latency hit (the swap/recompute cost shows up as a TPOT
stall for that request).

The deep framing the panel wants: **the continuous-batching scheduler is an OS scheduler + memory
manager for sequences, where the KV cache is the "process memory" — it admits based on free memory,
keeps the batch full by backfilling finished slots, interleaves prefill (chunked) with decode to
avoid head-of-line blocking, and preempts via recompute-or-swap (page replacement) when VRAM is
exhausted.** Every hard part maps to a classic OS problem (admission control, memory pressure,
preemption, page replacement) because it *is* one — the GPU's VRAM is the constrained resource and
the scheduler is rationing it across sequences. "Use continuous batching" is the headline; knowing
the scheduler is doing admission control + chunked-prefill interleaving + preempt-and-swap is the
depth.

──────────
> **[BANK]** Continuous-batching scheduler = per-**iteration** loop producing one token per running
> sequence: **admit** waiting requests iff their KV fits free VRAM, **interleave chunked prefill
> with decode** (so a long prompt doesn't HoL-block others' tokens), **backfill** finished slots
> (the throughput win over static batching), and **preempt** under memory exhaustion via
> **recomputation** (evict KV, re-prefill later — saves memory, redoes compute) or **swapping**
> (offload KV to host RAM over PCIe — saves compute, costs bandwidth). It's an OS scheduler +
> memory manager for sequences.
> **[TRAP]** Static batching (idle slots wait for the longest seq); greedy admission with no
> memory check (OOM mid-generation); running long prefills un-chunked (HoL-blocks decode); thinking
> you can cheaply context-switch sequences (KV state is huge).
> **[GO DEEPER]** loop [R4.Q2] continuous batching/PagedAttention · [I04.Q2] prefix cache competing
> for memory · [I04.Q6] priority/fairness in admission.

---

### [I04.Q4] "Decode is memory-bound and generates one token per forward pass. Can you generate more than one token per pass?"  ·  ★★★★★

**Interviewer:** You keep saying decode is bottlenecked on memory bandwidth — you read all the
weights to produce one token. That seems wasteful. Can you get more than one token out of a single
weight-read?

**Candidate:** Yes — that's **speculative decoding**, and the insight is exactly the waste you
named: in decode, the GPU reads the *entire model's weights from memory* to produce *one* token
(loop [R4.Q2], memory-bandwidth-bound, low compute utilization). The compute units are mostly
**idle** waiting on memory. Speculative decoding **fills that idle compute** by verifying *multiple*
candidate tokens in a single forward pass of the big model — getting several tokens per expensive
weight-read.

The mechanism uses a **small "draft" model + the big "target" model**:
1. **Draft:** a small, fast model (or a cheap method) **guesses the next K tokens** autoregressively
   — cheap because it's small. Say it proposes 4 tokens.
2. **Verify in parallel:** the **big model** processes all K draft tokens **in a single forward
   pass** (like a mini-prefill — parallel over the K positions), producing its own probability for
   each position. Because verification is parallel over K tokens, it costs ~**one** big-model
   forward pass (one weight-read) instead of K.
3. **Accept/reject:** compare — accept the longest prefix of draft tokens where the big model
   agrees (via a sampling rule that **provably preserves the target model's output distribution** —
   this is the crucial correctness property: speculative decoding is *exact*, the output is
   distributionally identical to normal decoding, not an approximation). On the first disagreement,
   take the big model's token and discard the rest of the draft.
4. Net: if the draft guessed well, you got **multiple tokens (e.g. 3 of 4 accepted) from one
   big-model forward pass** — a 2–3× speedup on TPOT, *for free* in terms of memory bandwidth
   because you were idle-waiting on it anyway.

```
 draft (small, fast): proposes  t1 t2 t3 t4
 target (big): verifies all 4 in ONE forward pass → agrees t1 t2 t3, differs at t4
 accept t1 t2 t3 + target's t4  →  4 tokens from ~1 big-model pass
```

**Interviewer:** What determines whether it actually helps, and when does it backfire?

**Candidate:** It's a **bet**, and the payoff depends on the **draft model's acceptance rate** vs
its **cost** — so it can backfire:

- **Acceptance rate is everything.** If the draft model is *accurate* (its guesses usually match the
  target — true for easy/predictable text, code with boilerplate, or when draft and target are
  well-aligned), you accept most proposed tokens → big speedup. If the draft is *bad* (low
  acceptance, frequent disagreement on hard/creative text), you **waste** the draft computation and
  the verification, and you might get **fewer** tokens per unit time than just decoding normally —
  net **slowdown**. The draft must be cheap *and* well-matched.
- **The draft model isn't free** — it adds latency and memory (you're running two models). The draft
  must be small enough that its cost is dwarfed by the savings. Variants reduce this:
  **Medusa** (extra prediction heads on the target model itself — no separate draft model), **EAGLE**
  (a lightweight draft that uses the target's features), and **n-gram / prompt-lookup** speculation
  (draft from a lookup table or the prompt itself — zero model cost, great when output echoes the
  input, e.g. RAG/summarization that quotes the context).
- **It helps throughput-bound less, latency-bound more.** Speculative decoding shines for
  **low-latency, low-batch** scenarios (a single user, where the GPU is idle and you want fast TPOT)
  — there's spare compute to spend. At **high batch sizes**, the GPU is already compute-saturated
  (the batch fills the idle compute), so there's no free capacity for speculation and it helps less
  or hurts. So it's a **latency optimization for under-utilized GPUs**, not a throughput one.
- **Tuning K** (speculation length): too few proposed tokens → little gain; too many → wasted work
  on rejections. Adaptive schemes tune K to the running acceptance rate.

So: **speculative decoding generates multiple tokens per big-model forward pass by drafting cheaply
and verifying in parallel — exact (preserves the distribution), a 2–3× TPOT win when the draft's
acceptance rate is high and the GPU has idle compute (low batch / single user), and a *loss* when
the draft is poorly matched or the GPU is already saturated.** The framing: it's **trading the
GPU's idle compute (during memory-bound decode) for fewer memory-bound steps** — spending the one
resource you have spare (FLOPs) to save the one you're bottlenecked on (memory bandwidth × number of
sequential steps). Knowing it's exact, draft-acceptance-dependent, and a low-batch/latency play (not
a universal speedup) is the depth.

──────────
> **[BANK]** **Speculative decoding**: a small **draft** model guesses K tokens; the big **target**
> model **verifies all K in one parallel forward pass** (one weight-read) and accepts the agreeing
> prefix — **exact** (provably preserves the target's distribution). Gets multiple tokens per
> expensive pass → 2–3× TPOT by spending the GPU's *idle decode compute* to cut memory-bound steps.
> Payoff depends on **draft acceptance rate** (good for predictable/echoing text; backfires if draft
> is mismatched or the GPU is already compute-saturated at high batch). Variants: Medusa, EAGLE,
> n-gram/prompt-lookup.
> **[TRAP]** Thinking it's approximate (it's exact); using it at high batch (GPU already saturated →
> no idle compute → little/negative gain); a draft model too slow or poorly matched (net slowdown).
> **[GO DEEPER]** loop [R4.Q2] why decode is memory-bound · [I04.Q1] TPOT (what this optimizes) ·
> [I04.Q5] parallelism (the other axis of decode speed).

---

### [I04.Q5] "The model is 140GB. Your GPU has 80GB. Now what?"  ·  ★★★★★

**Interviewer:** A 70B model in fp16 is 140GB (loop [R4.Q5]). It doesn't fit on one 80GB GPU even
before KV cache. You quantize, sure — but assume you must serve it at fp16 for quality. Spread it
across GPUs. How?

**Candidate:** You **shard the model across multiple GPUs**, and there are two orthogonal axes —
**tensor parallelism** and **pipeline parallelism** — with very different communication profiles. The
right answer is usually a *combination*, chosen by the interconnect.

**Tensor Parallelism (TP) — split each layer *across* GPUs.** Within a single layer, the big matrix
multiplications are **partitioned across GPUs** — e.g. split the attention heads or the columns of
the weight matrix, so each GPU holds a *slice* of every layer and computes its slice of each matmul.
- A 70B model with TP=4 puts ~35GB of weights on each of 4 GPUs → fits.
- **Communication:** every layer needs an **all-reduce** (or all-gather) to combine the partial
  results across the TP group — **on every forward pass, every layer**. That's a *lot* of frequent,
  latency-sensitive communication, so TP **requires a very fast interconnect** — **NVLink** within a
  single node (GPUs in one box). You do *not* span TP across nodes over Ethernet; the all-reduce
  latency would dominate. **TP is intra-node.**

**Pipeline Parallelism (PP) — split the layers *into stages* across GPUs.** GPU 0 holds layers 1–20,
GPU 1 holds 21–40, etc. A request flows through the stages like an assembly line.
- **Communication:** only the **activations** pass between consecutive stages — a small tensor,
  point-to-point, **once per stage boundary**, not per layer. So PP is **communication-light** and
  tolerant of **slower interconnects** — you can span PP **across nodes** (over InfiniBand/
  Ethernet).
- **The cost:** the **pipeline bubble.** While GPU 0 processes the first request, GPUs 1–3 are
  *idle* waiting for it; the pipeline fills and drains. You hide this by **microbatching** — feeding
  many requests so all stages stay busy — but there's inherent bubble inefficiency, and PP adds
  latency (a request traverses all stages serially).

```
 TP (intra-node, NVLink): each GPU has a slice of EVERY layer; all-reduce per layer (chatty)
 PP (cross-node ok):      GPU0=layers1-20 → GPU1=21-40 → ...; pass activations between stages
                          (light comm, but pipeline bubbles)
```

**Interviewer:** So which do you pick, and why not just use one?

**Candidate:** You **combine them**, matched to the **hardware topology**, because they have
complementary communication costs:

- **TP *within* a node** (across the 8 NVLink-connected GPUs in one server), because TP's per-layer
  all-reduce demands NVLink's bandwidth/latency and you have it inside the box.
- **PP *across* nodes** (over the slower inter-node network), because PP only passes activations at
  stage boundaries, which the slower link can handle.
- So a 70B (or a 405B) model is served as e.g. **TP=8 within each node, PP=2 across two nodes** —
  TP exploits the fast intra-node fabric, PP bridges the slow inter-node fabric. You **map the
  parallelism axis to the interconnect speed**: chatty TP rides NVLink, light PP rides the network.
- **Why not just one:** pure TP can't span nodes (all-reduce over Ethernet is too slow), so it caps
  at one node's GPU count — not enough for the biggest models. Pure PP across many GPUs has terrible
  bubble efficiency and high latency, and doesn't reduce per-GPU memory as cleanly within a layer.
  The combination gets you both: enough aggregate memory (across nodes) *and* efficient per-layer
  compute (within a node).
- (For *training* there's a third axis, **data parallelism**, replicating the model across groups —
  but for *inference* serving a single oversized model, TP+PP is the relevant combination; data
  parallelism at serving time is just running multiple independent replicas for throughput.)

There's also **expert parallelism** for MoE (Mixture-of-Experts) models — distribute the experts
across GPUs and route tokens to them — but for a dense 70B, TP+PP is the answer.

So: **shard with tensor parallelism inside a node (per-layer all-reduce, needs NVLink) and pipeline
parallelism across nodes (activations between stages, tolerates slower links, costs pipeline
bubbles), mapping each parallelism axis to the matching interconnect tier.** The deep point the
panel wants: **distributed inference is a communication-vs-memory problem, and you choose the
parallelism strategy by the *network topology* — chatty collective ops go on the fast fabric, light
point-to-point ops bridge the slow fabric.** It's the same "respect the hardware geometry" lesson as
the HFT NUMA question (Interview [01.Q3]), one level up: now the "cores" are GPUs and the "cache
lines" are NVLink vs Ethernet.

──────────
> **[BANK]** Model > 1 GPU → shard on two axes: **Tensor Parallelism** (split each layer's matmuls
> across GPUs; **all-reduce every layer** → chatty → needs **NVLink, intra-node**) + **Pipeline
> Parallelism** (split layers into stages; pass only **activations** between stages → light comm →
> spans **nodes**, but **pipeline bubbles** hidden by microbatching). Combine: **TP within a node,
> PP across nodes** — map each parallelism axis to its interconnect tier. (MoE adds expert
> parallelism.)
> **[TRAP]** Spanning TP across nodes (all-reduce over Ethernet kills it); pure PP across many GPUs
> (bubble inefficiency + latency); forgetting KV cache also needs memory beyond the sharded weights.
> **[GO DEEPER]** loop [R4.Q5] quantization (the other way to fit) · Interview [01.Q3] NUMA/topology
> thinking · [I04.Q1] the latency PP adds.

---

### [I04.Q6] "One tenant fires 10,000 requests. Your other customers' latency spikes. Fix it."  ·  ★★★★☆

**Interviewer:** Multi-tenant platform. One customer dumps a huge batch job. Suddenly every *other*
tenant's interactive requests get slow. What's happening and how do you isolate them?

**Candidate:** This is the **noisy-neighbor problem** on shared GPUs, and it happens because the
continuous-batching scheduler (loop [I04.Q3]), left naive, is **first-come-first-served / fair only
by accident** — the heavy tenant's 10,000 requests **flood the queue and fill the batch slots and KV
memory**, so everyone else waits behind them (queue starvation) and the big prefills head-of-line-
block the interactive tokens (loop [R4.Q2]). One tenant monopolizes the shared resource. The fixes,
escalating:

1. **Priority + fair scheduling in the admission step.** The scheduler's "which waiting requests to
   admit" decision ([I04.Q3] step 1) shouldn't be FCFS — make it **priority/fairness-aware**:
   interactive/high-priority requests jump ahead of bulk ones, and **per-tenant fair queuing**
   ensures no single tenant grabs more than its share of batch slots. So the heavy tenant's flood
   waits in *its own* queue rather than crowding out others (loop [R4.Q6] prioritization). This is
   the cheapest, most important fix.
2. **Per-tenant rate limits / quotas** (Interview's loop [R4.Q1]). Cap how many concurrent
   requests / tokens-per-second a single tenant can consume on a shared pool, so one customer
   *can't* submit 10,000 simultaneously — they get throttled (429 + retry) past their quota. Quotas
   prevent the flood at the door.
3. **Preemption by priority** ([I04.Q3]) — if interactive requests arrive and the GPU is full of a
   tenant's batch work, **preempt** (swap out) low-priority sequences to make room for the
   high-priority ones, resuming the batch work after. The latency-sensitive tenant doesn't wait for
   the batch job to drain.
4. **Physical isolation for strong guarantees.** If fairness-in-software isn't enough (a tenant
   needs a hard SLO), give them **dedicated replicas/GPUs** — separate pools (the chat-vs-batch
   separation from [I04.Q1], now per-tenant). Costs more (less sharing → lower utilization) but
   guarantees isolation. This is the throughput-vs-isolation tradeoff: shared GPUs are cheaper but
   need software fairness; dedicated GPUs are isolated but costlier.

**Interviewer:** Fair queuing on a GPU is harder than on a CPU. Why?

**Candidate:** Because **GPU work is batched and stateful in a way that makes preemption and
fine-grained fairness expensive** — you can't just time-slice it like a CPU:

- **The unit of work is a batch iteration, not a request.** The scheduler advances *all* running
  sequences together one token per iteration ([I04.Q3]). You can't instantly evict one tenant's
  sequence mid-iteration; fairness is enforced at **iteration boundaries** (which to admit/preempt
  next iteration), so it's coarser-grained than CPU preemption.
- **Preemption is expensive** ([I04.Q3]) — kicking out a sequence means swapping/recomputing its
  large **KV cache**, not a cheap register save. So you can't preempt freely to enforce fairness;
  there's a real cost, which limits how aggressively you rebalance.
- **KV memory is a shared, hard-limited resource** — fairness isn't just about *compute time* (like
  a CPU scheduler) but about **memory allocation**: a tenant holding lots of long-running sequences
  occupies KV blocks others can't use, even if it's not "running" much compute right now. So fair
  scheduling must ration **both** batch slots (compute) **and** KV blocks (memory) per tenant —
  two-dimensional fairness, harder than a CPU's single time dimension.
- **Head-of-line blocking is intrinsic** — a long prefill in the batch delays everyone's tokens
  that iteration ([I04.Q3] chunked prefill mitigates it, but it's a real coupling that CPU
  schedulers don't have in the same way).

So the complete answer: **isolate tenants with priority/fair scheduling in admission + per-tenant
quotas/rate limits + priority preemption, and fall back to dedicated pools for hard SLOs** — and
recognize that **GPU fair scheduling is harder than CPU because the unit is a batch iteration (coarse
preemption boundaries), preemption is expensive (large KV state), and you must ration two resources
(compute slots and KV memory), not one.** The framing: a multi-tenant LLM serving platform is a
**fair scheduler over a constrained, batched, stateful accelerator**, and naive FCFS continuous
batching gives you no isolation — the noisy neighbor is the default outcome until you add
fairness, quotas, and preemption, exactly as you'd protect any shared resource (loop [R4.Q1]/
[R4.Q6]).

──────────
> **[BANK]** Multi-tenant noisy neighbor on shared GPUs: naive continuous batching is FCFS → one
> tenant's flood fills queue + batch slots + KV memory, starving others. Fix with **priority/
> fair-queued admission** (per-tenant shares, interactive jumps bulk), **per-tenant quotas/rate
> limits**, **priority preemption** (swap out low-pri sequences), and **dedicated pools** for hard
> SLOs (isolation vs utilization). GPU fairness is **harder than CPU**: coarse preemption at
> iteration boundaries, expensive (large KV state to swap), and **two-dimensional** (ration compute
> slots *and* KV memory).
> **[TRAP]** Assuming continuous batching is fair (it's FCFS → noisy-neighbor by default); thinking
> you can cheaply time-slice a GPU like a CPU (batch-iteration granularity + expensive KV
> preemption).
> **[GO DEEPER]** loop [R4.Q1] rate limiting/quotas · loop [R4.Q6] prioritized shedding · [I04.Q3]
> the scheduler enforcing this.

---

### [I04.Q7] "GPUs cost $30k and take 40 seconds to load a model. Autoscale that for spiky traffic."  ·  ★★★★☆

**Interviewer:** Traffic is spiky. GPUs are absurdly expensive and you can't spin one up
instantly — loading a 140GB model takes tens of seconds. Design the autoscaling so you neither
melt under spikes nor burn money on idle GPUs.

**Candidate:** This is autoscaling with a **brutal cold-start problem** — the loop [R4.Q6] spike
problem, made worse because the "add capacity" action takes **tens of seconds to minutes** (provision
GPU node → pull a 140GB model → load into VRAM → warm up), and the resource is **extremely
expensive**, so both over- and under-provisioning hurt a lot. The design:

1. **Scale on the right signal — queue depth / wait time, not GPU utilization** (loop [R4.Q6]). GPU
   util is misleading (a fully-batched GPU is 100% util but may have plenty of headroom; a
   memory-bound decode shows low util while saturated). The true pressure signal is **pending queue
   depth and TTFT/wait time** — when requests start queuing or TTFT climbs past SLO, you need more
   capacity. Scale on that.
2. **Absorb the spike with a queue + admission control while capacity spins up** (loop [R4.Q6]).
   Since you *can't* add a GPU in milliseconds, the **bounded queue + load shedding + graceful
   degradation** is what survives the gap: queue what you can, shed/429 the overflow, and degrade
   (route to a smaller/cheaper model, or a cached response) rather than melt. The queue buys the
   ~40s the new GPU needs.
3. **Keep warm standby capacity** sized to your spike profile. Because cold start is slow, **pure
   reactive scaling is always too late** for a fast spike. So you keep a buffer of **pre-warmed
   GPUs** (model already loaded, idle or doing preemptible batch work) that can take interactive
   traffic *instantly* when a spike hits, while reactive scaling brings up *more* in the background.
   The warm buffer covers the cold-start latency. Sizing it is a **cost-vs-SLO** decision: more warm
   GPUs = better spike response = higher idle cost.
4. **Cut the cold start itself.** Engineer the 40s down: **fast model loading** (stream weights,
   load directly to GPU, memory-map from fast local NVMe instead of pulling 140GB over the network
   each time), **keep model weights cached on the node** (don't re-download), **snapshot a warm
   process** (CUDA graphs / a pre-initialized runtime) so you skip re-warmup. Every second off
   cold-start shrinks the warm buffer you must pay for.
5. **Use cheap capacity for the elastic, interruptible tier.** Run **batch/low-priority work on spot/
   preemptible GPUs** (much cheaper) that can be **preempted to free capacity for interactive spikes**
   ([I04.Q6] preemption) — so your expensive on-demand GPUs serve the latency-critical baseline and
   the spike overflow rides cheaper, interruptible capacity. Scale-to-zero for dev/idle tenants.

**Interviewer:** What's the failure mode if you get the warm-buffer sizing wrong in each direction?

**Candidate:** Both directions are expensive, which is *why* this is hard:
- **Too small a buffer (under-provisioned):** a spike arrives, the warm capacity is exhausted, and
  new GPUs take 40s to come up — so for those 40s you're **shedding load / blowing TTFT SLOs** (loop
  [R4.Q6]). Customers see errors or slowness during exactly the moment they care. You protected cost
  at the expense of the SLO.
- **Too large a buffer (over-provisioned):** you're paying for **idle $30k GPUs** doing nothing,
  torching margin (which *is* the business — cost/token). You protected the SLO at the expense of
  cost.
- The **right** sizing comes from the **traffic statistics** — model the spike distribution (how fast,
  how big, how often), set the warm buffer to cover the cold-start window for spikes up to your
  target percentile, and let reactive scaling handle the rest. You also **smooth scale-down** (don't
  drop a warm GPU the instant load dips — a flapping autoscaler that kills then re-cold-starts GPUs
  is the worst of both worlds), using a cooldown / hysteresis.

So the design: **scale on queue depth/TTFT (not GPU util); absorb the cold-start gap with a bounded
queue + shedding + degradation; keep a warm standby buffer sized from traffic statistics to cover the
40s cold start; aggressively cut cold-start time (local weight cache, fast loading, warm snapshots);
and ride cheap preemptible capacity for the elastic tier, preempting it for interactive spikes.** The
framing the panel wants: **GPU autoscaling is dominated by the cold-start latency and the cost of
idle — so you can't scale purely reactively (too slow) or purely warm (too expensive); you buy a
warm buffer to bridge the cold-start gap, shrink that gap with engineering, and let queue+shed+
degrade handle the overflow.** It's the loop's backpressure problem with the added cruelty that
adding capacity is slow *and* the capacity is the most expensive thing in your stack.

──────────
> **[BANK]** GPU autoscaling = brutal cold start (40s+ to load a 140GB model) + expensive idle. Scale
> on **queue depth/TTFT, not GPU util**. Bridge the cold-start gap with a **bounded queue + shedding +
> degradation** (loop [R4.Q6]) and a **warm standby buffer** sized from traffic stats (reactive
> scaling alone is too slow for spikes). **Cut cold start** (local weight cache, fast/streamed
> loading, warm snapshots) to shrink the buffer you must pay for. Ride **spot/preemptible GPUs** for
> the elastic tier, preempting them for interactive spikes. Hysteresis on scale-down (no flapping).
> **[TRAP]** Scaling on GPU utilization (misleading); purely reactive scaling (cold start = blown SLO
> during the spike); purely warm (idle $30k GPUs torch margin); flapping autoscaler that re-cold-
> starts on every dip.
> **[GO DEEPER]** loop [R4.Q6] backpressure/queue/shed · loop [R4.Q1] quotas · [I04.Q6] preempting
> the cheap tier.

---

## Closing note — the LLM-serving floor

Strip away the word "AI" and this interview was **systems all the way down**: a GPU is a
memory-bandwidth-constrained accelerator, the KV cache is the scarce resource, and the serving engine
is an **OS — scheduler, memory manager, cache, fair queue — for sequences**. Every win mapped to a
classic systems idea: PagedAttention is virtual memory, prefix caching is a page cache, continuous
batching is a run queue, preemption is page replacement, speculative decoding is spending idle compute
to cut memory-bound steps, parallelism is mapped to the interconnect topology, and autoscaling is
backpressure with a cruel cold start. The candidate who wins doesn't recite model architectures —
they reason in **TTFT, TPOT, throughput, and VRAM**, and they see that serving LLMs cheaply is the
same discipline as serving anything cheaply: find the binding constraint (memory bandwidth, KV
capacity), and ration it brilliantly.

→ Back to the [interview floor](./00-interviews-index.md) · related: loop
[R4](../04-round-4-design-ai-infra.md), Interviews [10](./interview-10-vector-search.md) (vector
search for RAG), [15](./interview-15-adtech-rtb.md) (low-latency ML serving).
