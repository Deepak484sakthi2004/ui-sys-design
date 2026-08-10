import type { Problem } from "@/lib/types";

export const llmInferenceServing: Problem = {
  slug: "llm-inference-serving",
  num: "7.8",
  title: "Design an LLM Inference Serving Stack",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design the serving stack behind a hosted chat API built on a 70B-parameter open-weight model: 50K concurrent streaming users, 20K requests/minute sustained, prompts up to 32K tokens, a sub-300ms p50 time-to-first-token, and GPUs that cost real money per hour and take minutes to warm up.",
  ],
  hardParts:
    "The hard parts: GPU memory, not compute, is the real capacity constraint because the KV cache grows with every token of every active conversation; prefill and decode have opposite resource profiles and fight for the same GPU; and autoscaling can't react in seconds because loading a 140GB checkpoint into GPU memory takes minutes, so admission control has to absorb the gap.",
  keyTopics: [
    "Continuous (Iteration-Level) Batching",
    "PagedAttention KV Cache",
    "Prefill/Decode Disaggregation",
    "Prefix/Radix Caching",
    "KV-Cache-Aware Routing",
  ],
  foundationsReferenced: [
    { label: "Consistent Hashing", tone: "green" },
    { label: "Load Balancing Algorithms", tone: "blue" },
    { label: "Message Queues / Backpressure", tone: "orange" },
    { label: "LRU Caching", tone: "green" },
    { label: "Autoscaling & Capacity Planning", tone: "purple" },
    { label: "Queueing Theory (M/M/1)", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "streaming SSE", col: 1, row: 1, tone: "slate" },
      {
        id: "router",
        label: "Smart Router",
        sub: "KV-cache aware",
        mono: "consistent hash on prompt prefix",
        col: 2,
        row: 1,
        tone: "green",
      },
      { id: "queue", label: "Admission Queue", sub: "priority + timeout, sheds load", col: 3, row: 1, tone: "orange" },
      {
        id: "prefill",
        label: "Prefill Pool",
        sub: "compute-bound · TP=8",
        mono: "batches prompts together",
        col: 4,
        row: 1,
        tone: "purple",
      },
      {
        id: "decode",
        label: "Decode Pool",
        sub: "memory-bound · cont. batching",
        mono: "PagedAttention scheduler",
        col: 5,
        row: 1,
        tone: "purple",
      },
      { id: "prefixcache", label: "Prefix Cache", sub: "radix tree · shared system prompts", col: 4, row: 2, tone: "blue" },
      { id: "kvcache", label: "GPU KV Cache", sub: "paged blocks · ~55GB usable/GPU", col: 5, row: 2, tone: "blue" },
      { id: "weights", label: "Model Weight Store", sub: "blob storage · 140GB checkpoint", col: 1, row: 3, tone: "slate" },
      { id: "autoscaler", label: "GPU Autoscaler", sub: "watches queue depth + KV occupancy", col: 2, row: 3, tone: "orange" },
      { id: "metrics", label: "Metrics / Observability", sub: "TTFT · ITL · tokens/sec · queue depth", col: 4, row: 3, tone: "orange" },
      { id: "draft", label: "Draft Model", sub: "small model · speculative decoding", col: 5, row: 3, tone: "purple" },
    ],
    edges: [
      { from: "client", to: "router", label: "chat request", kind: "read" },
      { from: "router", to: "queue", label: "cache-aware routing", kind: "read" },
      { from: "queue", to: "prefill", label: "admitted · new prompt", kind: "read" },
      { from: "prefill", to: "decode", label: "handoff after prefill", kind: "read" },
      { from: "decode", to: "client", label: "SSE token stream", kind: "read" },
      { from: "draft", to: "decode", label: "propose tokens · verified in one pass", kind: "read" },
      { from: "prefill", to: "prefixcache", label: "write/reuse prefix KV blocks", kind: "write" },
      { from: "prefill", to: "kvcache", label: "allocate blocks for prompt", kind: "write" },
      { from: "decode", to: "kvcache", label: "allocate/free paged blocks", kind: "write" },
      { from: "weights", to: "prefill", label: "cold start: load 140GB checkpoint", kind: "analytics" },
      { from: "weights", to: "decode", label: "cold start: load 140GB checkpoint", kind: "analytics" },
      { from: "autoscaler", to: "prefill", label: "scale replicas", kind: "analytics" },
      { from: "autoscaler", to: "decode", label: "scale replicas", kind: "analytics" },
      { from: "queue", to: "metrics", label: "queue depth", kind: "analytics" },
      { from: "prefill", to: "metrics", label: "TTFT", kind: "analytics" },
      { from: "decode", to: "metrics", label: "ITL · tokens/sec · KV occupancy", kind: "analytics" },
      { from: "metrics", to: "autoscaler", label: "queue depth + KV occupancy trend", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "request/response path · 20K req/min" },
      { kind: "write", text: "KV cache & block mutations" },
      { kind: "analytics", text: "control plane · autoscaling, cold start, metrics" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "router", "queue", "prefill", "decode"],
      say: "The synchronous skeleton: a chat request goes through the Smart Router into an Admission Queue, then Prefill and Decode run back-to-back and stream tokens straight back to the client — this is the path that has to hit sub-300ms time-to-first-token.",
    },
    {
      reveal: ["prefixcache", "kvcache"],
      say: "Every token pins GPU memory, so this is where the real constraint lives: Prefill allocates paged KV blocks for the prompt and checks the radix-tree Prefix Cache first, so a repeated system prompt or chat history skips redundant compute instead of being reprocessed.",
    },
    {
      reveal: ["draft"],
      say: "For latency-sensitive traffic, a small Draft Model proposes several tokens ahead and Decode verifies them in one forward pass, cutting the number of expensive full-model steps needed per output token.",
    },
    {
      reveal: ["weights", "autoscaler", "metrics"],
      say: "Behind the scenes, Metrics track queue depth, KV occupancy, TTFT, and ITL, and the Autoscaler reacts to the trend rather than the instant reading — because pulling a 140GB checkpoint out of the Weight Store and warming up a new replica takes minutes, not seconds.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Accept a chat completion request (system + user messages) and stream tokens back over SSE/WebSocket", tag: "P0" },
      { id: "FR-02", text: "Support variable-length prompts up to 32K context tokens and cap max output tokens per request", tag: "P0" },
      { id: "FR-03", text: "Continuous batching so concurrent requests share GPU compute without one waiting on the slowest", tag: "P0" },
      { id: "FR-04", text: "Multi-tenant routing to the correct model/fine-tune version, with per-API-key rate limits and quotas", tag: "P0" },
      { id: "FR-05", text: "Admission control: queue or reject with explicit backpressure when GPU capacity is saturated", tag: "P0" },
      { id: "FR-06", text: "Prefix/system-prompt caching so repeated shared prefixes skip redundant prefill computation", tag: "P1" },
      { id: "FR-07", text: "Autoscale GPU replica pools up and down, accounting for multi-minute model load time", tag: "P1" },
      { id: "FR-08", text: "Support mid-stream cancellation and free GPU/KV resources immediately", tag: "P1" },
      { id: "FR-09", text: "Canary/A-B rollout of a new model version without downtime", tag: "P1" },
      { id: "FR-10", text: "Speculative decoding with a small draft model to cut per-token latency for latency-sensitive traffic", tag: "P2" },
      { id: "FR-11", text: "Batch/offline inference queue for throughput-oriented jobs that share capacity off-peak", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Time-to-first-token (TTFT), p50 on short prompts", tag: "p50 < 300ms" },
      { id: "NFR-02", text: "Time-to-first-token, p99 under load", tag: "p99 < 2s" },
      { id: "NFR-03", text: "Inter-token latency (ITL) / time-per-output-token, p50", tag: "p50 < 40ms" },
      { id: "NFR-04", text: "Sustained throughput across the fleet", tag: "20K req/min" },
      { id: "NFR-05", text: "Concurrent streaming connections", tag: "50K concurrent" },
      { id: "NFR-06", text: "GPU utilization target (cost efficiency)", tag: "> 65%" },
      { id: "NFR-07", text: "Availability", tag: "99.9%" },
      { id: "NFR-08", text: "Max context window supported", tag: "32K tokens" },
      { id: "NFR-09", text: "Autoscale reaction floor imposed by checkpoint load", tag: "~3 min cold start" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why GPU memory, not compute, is the ceiling",
      body: [
        "Before picking any scheduling trick, prove where the real limit is. Serving is often assumed to be compute-bound like training, but inference at scale is usually memory-bound: every token of every in-flight conversation needs its own slice of the attention key/value (KV) cache sitting in GPU memory for as long as that conversation is active. Do the math and the ceiling becomes obvious.",
        "For a 70B-class model with grouped-query attention (8 KV heads, head_dim 128, 80 layers, fp16), one token of KV cache costs 2 (K and V) × 80 layers × 8 heads × 128 dim × 2 bytes ≈ 320KB. A single 4K-token conversation therefore pins down about 1.2GB of GPU memory, on top of the ~17.5GB per GPU already spent on the model's own weights (140GB total, split 8 ways by tensor parallelism).",
      ],
      bullets: [
        { lead: "Weights are fixed", text: "140GB of fp16 weights split across 8 GPUs (tensor parallelism) costs ~17.5GB per GPU no matter how many users are connected." },
        { lead: "KV cache scales with load", text: "every active token from every active conversation adds ~320KB per GPU-shard; a burst of long conversations, not a burst of compute, is what runs a replica out of room." },
        { lead: "Compute headroom is real", text: "modern GPUs have FLOPs to spare for inference; what runs out first is the memory to hold everyone's conversation state, which is why capacity planning starts from GB of KV, not TFLOPs." },
      ],
      pictureTitle: "What actually fills an H100?",
      pictureRows: [
        { label: "Model weights (70B, TP=8)", value: "~17.5GB / GPU, fixed", tone: "neutral" },
        { label: "KV cache per 4K-token session", value: "~1.2GB, scales with active users", tone: "used" },
        { label: "~55GB usable KV budget / GPU", value: "≈45 concurrent 4K sessions / GPU", tone: "good" },
      ],
      remember: {
        problem: "What actually limits how many users one GPU pod can serve?",
        solution: "GPU memory for the KV cache, not raw compute — size capacity in GB of KV, not TFLOPs.",
        why: "Weights are a fixed ~17.5GB/GPU cost; every token of every active conversation adds its own ~320KB of KV cache that must stay resident until that conversation ends.",
        tradeoff: "Longer context windows and more concurrent users both eat the same finite KV budget, so you trade max context length against max concurrency.",
        failure: "Provisioning by FLOPs alone looks fine on paper and then falls over the moment conversations get long, because memory fills up long before the GPU runs out of compute.",
        mitigation: "Track KV occupancy as the primary capacity metric, and use PagedAttention-style block allocation so no memory is wasted on padding or fragmentation.",
      },
    },
    {
      n: 2,
      title: "Continuous (iteration-level) batching",
      body: [
        "A GPU is only economical when it processes many requests at once, but requests don't arrive or finish at the same time — one user asks a one-line question, another pastes a 20-page document. Static (request-level) batching waits for every sequence in a batch to finish before admitting new work, so a single long response holds an entire batch of short ones hostage: classic head-of-line blocking, with the GPU idling on stragglers.",
        "Continuous batching (the technique behind vLLM's and Orca's schedulers) reschedules the batch at every single decoding step instead of once per request. After each forward pass, any sequence that just emitted its end token leaves the batch and a new queued request immediately takes its slot — the GPU never idles waiting for the slowest sequence to finish.",
      ],
      bullets: [
        { lead: "Static batching", text: "fixed batches run start-to-finish together; one long generation blocks every short one behind it and wastes GPU cycles on padding." },
        { lead: "Continuous batching", text: "the scheduler reforms the batch every iteration (every generated token), so finished sequences exit and queued ones enter without waiting for a batch boundary." },
        { lead: "Throughput vs fairness", text: "this is what lifts GPU utilization from the 20-30% range of naive serving up toward 70-80%+, while also cutting tail latency for short requests stuck behind long ones." },
      ],
      pictureTitle: "Static batch vs continuous batch",
      pictureRows: [
        { label: "Static batch", value: "waits for slowest sequence, GPU idles", tone: "bad" },
        { label: "Continuous batch", value: "reschedules every token, no head-of-line block", tone: "good" },
        { label: "Effect on GPU util", value: "~20-30% → ~70-80%+", tone: "good" },
      ],
      remember: {
        problem: "A single long generation blocks a whole batch of short ones and wastes GPU cycles.",
        solution: "Continuous (iteration-level) batching: reform the batch after every decoding step, not every request.",
        why: "Sequences finish at wildly different times; scheduling at the token granularity lets a finished slot be reused immediately instead of waiting for a batch boundary.",
        tradeoff: "More scheduler overhead per step and more complex bookkeeping (which sequence sits at which position) in exchange for far higher GPU utilization.",
        failure: "Static, request-level batching wastes GPU cycles on padding and produces terrible tail latency for short requests queued behind long ones.",
        mitigation: "Adopt a continuous-batching engine (vLLM, TensorRT-LLM in-flight batching, SGLang) rather than hand-rolling request-level batching.",
      },
    },
    {
      n: 3,
      title: "PagedAttention: why the KV cache needs an allocator",
      body: [
        "Continuous batching still needs somewhere to put each sequence's growing KV cache, and the naive approach — reserve a contiguous buffer sized for the maximum possible sequence length, per request — wastes enormous memory. Most conversations never reach the max, so early serving systems saw only 20-40% effective KV memory utilization, most of it lost to over-reservation and fragmentation.",
        "PagedAttention (vLLM) borrows the operating system's virtual memory idea: split the KV cache into small fixed-size blocks (pages), store them non-contiguously anywhere in GPU memory, and keep a per-sequence block table that maps logical token positions to physical blocks. A sequence grows by grabbing one more block at a time instead of pre-reserving its worst case.",
      ],
      bullets: [
        { lead: "Contiguous pre-allocation", text: "reserves worst-case context length per request up front; unused tail space is wasted and can't be reclaimed by anyone else." },
        { lead: "Paged blocks", text: "fixed-size pages (e.g. 16 tokens each) allocated on demand; a sequence's KV lives in whatever physical blocks are free, tracked by a block table." },
        { lead: "Free side effect: sharing", text: "identical prefixes (a shared system prompt, parallel sampling of the same prompt) can point multiple block tables at the same physical blocks — copy-on-write, not copy-on-read." },
      ],
      pictureTitle: "Contiguous reservation vs paged blocks",
      pictureRows: [
        { label: "Contiguous, worst-case reserved", value: "~20-40% effective utilization", tone: "bad" },
        { label: "Paged, on-demand blocks", value: "near-zero fragmentation", tone: "good" },
        { label: "Shared prefixes", value: "multiple sequences reference same physical blocks", tone: "good" },
      ],
      remember: {
        problem: "Pre-reserving worst-case KV memory per request wastes most of the GPU's memory.",
        solution: "PagedAttention: fixed-size, non-contiguous KV blocks plus a per-sequence block table, allocated on demand.",
        why: "Same trick as OS virtual memory paging — you only pay for the pages you actually use, and blocks can be shared or freed independently.",
        tradeoff: "A layer of indirection (block table lookups) on every attention computation, in exchange for 2-4x more concurrent sequences per GPU.",
        failure: "Contiguous per-request buffers cap concurrency far below what the hardware could actually support, because most of the reserved memory sits empty.",
        mitigation: "Use an inference engine with paged KV cache (vLLM, TensorRT-LLM, SGLang) instead of a hand-rolled contiguous allocator.",
      },
    },
    {
      n: 4,
      title: "Prefill vs decode, and disaggregation",
      body: [
        "Generating a response has two phases with opposite resource profiles, and mixing them on the same GPU at the same time is where interactive latency gets hurt. Prefill processes the entire input prompt in one shot — a large matrix multiply that is compute-bound and GPU-efficient. Decode generates one token at a time, autoregressively; each step must stream the entire KV cache and model weights through GPU memory to produce a single token, so it is memory-bandwidth-bound and inherently low-utilization per step.",
        "Run them on the same GPU in one continuous batch and a new long prompt's prefill can stall every other user's in-flight decode step for hundreds of milliseconds — a latency spike on someone else's stream just because a third party's document landed at the wrong moment. Disaggregated serving puts prefill and decode on separate GPU pools connected by a fast KV-cache transfer over NVLink/InfiniBand; where you can't afford separate pools, chunked prefill splits a big prompt into small pieces interleaved between decode steps instead of running as one blocking chunk.",
      ],
      bullets: [
        { lead: "Prefill", text: "one large matmul over the whole prompt, compute-bound, high GPU utilization, and it happens once per request." },
        { lead: "Decode", text: "one token per step, memory-bandwidth-bound, low utilization per step, but it repeats for every output token and is what the user watches stream in." },
        { lead: "The interference problem", text: "a big prefill mixed into a decode-heavy batch blocks the GPU long enough to spike inter-token latency for every other streaming user in that batch." },
        { lead: "Two fixes", text: "disaggregate into separate prefill/decode GPU pools with a fast KV handoff, or chunk large prefills into small pieces interleaved with decode steps if you must share a pool." },
      ],
      pictureTitle: "Prefill and decode have opposite resource profiles",
      pictureRows: [
        { label: "Prefill", value: "compute-bound, high GPU util, one-shot", tone: "neutral" },
        { label: "Decode", value: "memory-bandwidth-bound, low util/step, repeats per token", tone: "neutral" },
        { label: "Mixed on one GPU", value: "new prompt's prefill spikes others' ITL", tone: "bad" },
        { label: "Disaggregated / chunked", value: "prefill can't stall a decode step", tone: "good" },
      ],
      remember: {
        problem: "A new user's long prompt stalls every other user's streaming tokens.",
        solution: "Separate prefill (compute-bound) from decode (memory-bound) into different pools, or chunk large prefills between decode steps.",
        why: "The two phases have opposite bottlenecks; batching them together lets one prompt's one-shot compute burst block everyone else's per-token latency.",
        tradeoff: "Disaggregation adds a KV-cache transfer hop between pools (needs NVLink/InfiniBand-class bandwidth) and doubles the number of pools to operate.",
        failure: "A single shared pool serving both phases produces highly variable inter-token latency whenever a big prompt lands.",
        mitigation: "Disaggregated prefill/decode pools for latency-critical traffic, or chunked prefill as the lighter-weight fix when a second pool isn't justified yet.",
      },
    },
    {
      n: 5,
      title: "Prefix / radix caching",
      body: [
        "Many real workloads repeat the same prefix over and over: a fixed system prompt, a few-shot template, or the growing history of one multi-turn conversation. Recomputing prefill for that shared prefix on every single request burns GPU compute on work that produces the exact same KV values every time.",
        "Prefix caching keeps the KV blocks for previously-seen prefixes resident and reuses them: SGLang's RadixAttention organizes cached prefixes in a radix tree so a new request's prompt can match the longest shared prefix already cached, walk straight past it, and only run prefill on the new suffix. For a workload with a long shared system prompt, this can cut prefill compute — and therefore time-to-first-token — dramatically for the repeated part.",
      ],
      bullets: [
        { lead: "Naive", text: "every request reprocesses its full prompt from scratch, even an identical 2,000-token system prompt shared by every request in the fleet." },
        { lead: "Prefix cache / RadixAttention", text: "KV blocks for common prefixes stay cached (often keyed as a radix tree over token sequences); a new request only computes prefill for the tokens after the longest cached match." },
        { lead: "Who benefits most", text: "multi-turn chat (the whole history up to the last turn is a cache hit), shared system prompts, and RAG templates with a fixed instruction block." },
      ],
      pictureTitle: "Recompute every time vs reuse cached prefixes",
      pictureRows: [
        { label: "No prefix cache", value: "full prompt reprocessed every request", tone: "bad" },
        { label: "Prefix cache hit", value: "prefill only the new suffix", tone: "good" },
        { label: "Best case: multi-turn chat", value: "whole prior history is a cache hit", tone: "good" },
      ],
      remember: {
        problem: "Identical prompt prefixes get recomputed on every request.",
        solution: "Cache KV blocks for shared prefixes (radix tree over token sequences) and prefill only the uncached suffix.",
        why: "Attention is deterministic given the same prefix tokens, so the KV values for a repeated prefix never change and are safe to reuse.",
        tradeoff: "Extra GPU memory held for cached prefixes competes with the KV budget for active generation, and needs an eviction policy under memory pressure.",
        failure: "Without prefix caching, a shared long system prompt or deep chat history gets reprocessed on every turn, wasting compute and inflating TTFT.",
        mitigation: "Run a prefix-cache-aware engine (vLLM automatic prefix caching, SGLang RadixAttention) and route requests to replicas that already hold the relevant prefix.",
      },
    },
    {
      n: 6,
      title: "KV-cache-aware routing and slow autoscaling",
      body: [
        "Once every replica has its own KV cache and possibly its own set of cached prefixes, the router's job stops being generic load balancing. Round-robin or least-connections spreads load evenly but destroys cache locality: a follow-up message from the same conversation might land on a different replica than the one holding its cached prefix, forcing a full recompute. The fix is cache-aware routing — hash the prompt (or conversation id) to consistently prefer the replica that already has the relevant prefix cached, falling back to load-based routing when that replica is saturated.",
        "Autoscaling has its own twist: a new GPU replica isn't ready in seconds. Pulling a 140GB checkpoint from blob storage over the network, loading it into GPU memory, and warming up communication between tensor-parallel shards takes on the order of minutes. An autoscaler that only reacts to current utilization is always too late; it has to react to a leading indicator — queue-depth trend, not just point-in-time GPU busy-ness — and keep a warm buffer of spare replicas for predictable traffic peaks.",
      ],
      bullets: [
        { lead: "Cache-aware routing", text: "consistent-hash the request onto the replica most likely to already hold its prefix in cache, instead of round-robin, to keep prefix-cache hit rate high." },
        { lead: "Fallback to load", text: "if the preferred replica is saturated (queue depth or KV occupancy too high), spill to the next-best replica rather than force a wait." },
        { lead: "Cold start is the real constraint", text: "~140GB checkpoint load plus memory initialization plus tensor-parallel warm-up ≈ minutes, not seconds — autoscaling reaction time is bounded below by this." },
        { lead: "Lead, don't lag", text: "scale on queue-depth trend and time-of-day patterns, not on current GPU utilization, because by the time utilization is high it's already too late to help this traffic spike." },
      ],
      pictureTitle: "Routing and scaling both need to think ahead",
      pictureRows: [
        { label: "Round-robin routing", value: "even load, destroys prefix cache locality", tone: "bad" },
        { label: "Cache-aware routing", value: "consistent hash toward the cache holder", tone: "good" },
        { label: "React to current utilization", value: "always ~3 min too late", tone: "bad" },
        { label: "React to queue-depth trend", value: "scale before the queue backs up", tone: "good" },
      ],
      remember: {
        problem: "Generic load balancing and reactive autoscaling both fight against LLM serving's realities.",
        solution: "Cache-aware (consistent-hash) routing plus trend-based autoscaling with a warm standby buffer.",
        why: "Cache locality only pays off if the router respects it; a multi-minute cold start means the autoscaler must predict, not react.",
        tradeoff: "Warm standby replicas cost GPU-hours even when idle, and cache-aware routing can create hot spots if one prefix gets very popular.",
        failure: "Round-robin routing tanks prefix-cache hit rate; utilization-triggered autoscaling always arrives after the traffic spike it was meant to absorb.",
        mitigation: "Consistent hashing with a saturation fallback for routing; queue-depth-trend-based autoscaling plus a small warm buffer for predictable peaks.",
      },
    },
    {
      n: 7,
      title: "Admission control and SLO tiers",
      body: [
        "Past a certain point, adding more concurrent requests to a saturated GPU pool doesn't add throughput — it only adds queueing delay, the same curve you get from any system pushed past its saturation point. If every request is accepted no matter what, everyone's latency degrades together and the system has no way to protect its SLO for anyone.",
        "The fix is explicit admission control: track available KV cache budget and queue depth, and once a threshold is crossed, either queue new requests with a bounded timeout or reject them outright with a clear backpressure signal rather than accepting work the pool can't actually serve within budget. Layer this with SLO tiers — interactive chat traffic gets priority and a tight latency budget, while bulk/offline jobs are lower priority and can be preempted or delayed to absorb the slack.",
      ],
      bullets: [
        { lead: "Past saturation, more requests = more queueing", text: "not more throughput — the same shape as any M/M/1 queue near full utilization, latency for everyone rises, not just for the newcomer." },
        { lead: "Admission control", text: "reject or bounded-queue new requests once KV occupancy or queue depth crosses a threshold, instead of accepting unlimited work." },
        { lead: "Explicit backpressure", text: "return a clear signal (429/503, retry-after) so clients can back off, instead of silently letting every request's latency creep upward." },
        { lead: "SLO tiers", text: "interactive traffic gets priority scheduling and a protected latency budget; offline/batch jobs fill the remaining capacity and are the first to be delayed under load." },
      ],
      pictureTitle: "Unbounded admission vs tiered admission control",
      pictureRows: [
        { label: "Accept everything", value: "latency degrades for all requests together", tone: "bad" },
        { label: "Admission control + backpressure", value: "explicit reject/queue, protects accepted requests' SLO", tone: "good" },
        { label: "SLO tiers", value: "interactive protected, batch absorbs the slack", tone: "good" },
      ],
      remember: {
        problem: "Unbounded acceptance of requests degrades latency for every user once the GPU pool saturates.",
        solution: "Admission control on KV occupancy/queue depth, explicit backpressure, and SLO tiers that protect interactive traffic first.",
        why: "A saturated serving system behaves like any queue near full utilization — more arrivals mean more wait, not more completions, so someone has to be turned away to protect everyone else.",
        tradeoff: "Rejecting or queuing requests means some traffic is delayed or dropped during peaks, which has to be a deliberate, communicated policy, not an accident.",
        failure: "No admission control means a traffic spike degrades every in-flight stream simultaneously, including ones that were already near their SLO.",
        mitigation: "Threshold on KV occupancy/queue depth, bounded queue with timeout, explicit backpressure, and offline traffic as the shock absorber.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a GPU-memory-bound serving system: the KV cache, not raw compute, decides how many users one replica can hold.",
      "Continuous batching reschedules every decoding step so short requests never wait behind long ones, and PagedAttention allocates KV cache in small blocks instead of wasteful pre-reserved buffers.",
      "Prefill (compute-bound, one-shot) and decode (memory-bound, per-token) fight for the same GPU; disaggregating or chunking them stops one user's big prompt from spiking everyone else's token latency.",
      "Prefix caching skips recomputation for repeated system prompts and chat history; the router has to be cache-aware (consistent hashing), not round-robin, or that cache hit rate collapses.",
      "Autoscaling can't react in seconds — loading a 140GB checkpoint takes minutes — so admission control and a warm standby buffer absorb the gap while capacity catches up.",
    ],
    flows: [
      {
        kind: "read",
        title: "GENERATE · 20K REQ/MIN · SUB-300MS TTFT",
        summary: "A prompt goes through admission control, gets a prefill pass, hands its KV cache to a decode pool, and streams tokens back until it hits a stop token or the max output length.",
        steps: [
          { label: "Client", note: "sends chat request" },
          { label: "Smart Router", note: "cache-aware, consistent hash on prefix" },
          { label: "Admission Queue", note: "priority + timeout, sheds load past capacity" },
          { label: "Prefill Pool", note: "compute prompt, checks prefix cache" },
          { label: "Decode Pool", note: "continuous batching, one token/step" },
          { label: "Client", note: "SSE stream until stop token" },
        ],
      },
      {
        kind: "write",
        title: "KV CACHE LIFECYCLE",
        summary: "Every token a sequence generates claims another paged block of GPU memory; the whole memory-management story is allocating, sharing, and freeing those blocks cheaply.",
        steps: [
          { label: "Prefill", note: "allocate blocks for prompt tokens" },
          { label: "Prefix Cache", note: "match/write shared prefix blocks" },
          { label: "Decode", note: "claim one new block roughly every N tokens" },
          { label: "Completion or cancel", note: "free all blocks immediately" },
        ],
      },
      {
        kind: "analytics",
        title: "AUTOSCALE & COLD START",
        summary: "Capacity changes are slow, so the control loop has to look ahead: watch the queue-depth trend, decide early, and accept a multi-minute lag before a new replica can take traffic.",
        steps: [
          { label: "Metrics", note: "track queue depth, KV occupancy, TTFT/ITL" },
          { label: "Autoscaler", note: "decides from trend, not point-in-time" },
          { label: "Weight Store", note: "pull 140GB checkpoint, load, ~3 min" },
          { label: "New replica", note: "joins pool, starts taking routed traffic" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "70B-param model, fp16 weights ≈140GB, TP=8 across GPUs ≈17.5GB weights/GPU",
          "~320KB KV cache per token (GQA, 8 KV heads, 80 layers) ≈1.2GB per 4K-token session",
          "~45 concurrent 4K-context sessions per GPU on ~55GB usable KV budget",
          "20K req/min sustained, 50K concurrent streams",
          "p50 TTFT < 300ms, p50 ITL < 40ms/token",
          "Cold start: ~3 min to load a 140GB checkpoint and warm up a new replica",
          "GPU util target > 65% (continuous batching typically lifts it from ~20-30%)",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Continuous (iteration-level) batching, not static request-level batching",
          "PagedAttention: fixed-size KV blocks + block table, not contiguous per-request reservation",
          "Disaggregate prefill/decode pools (or chunked prefill) so one big prompt can't spike others' ITL",
          "Prefix/radix caching for shared system prompts and multi-turn history",
          "KV-cache-aware (consistent hash) routing, not round-robin",
          "Trend-based autoscaling (queue-depth trend) plus a warm standby buffer",
          "Explicit admission control with backpressure and SLO tiers",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "GPU memory (KV cache), not compute, is usually the binding constraint",
          "Prefill is compute-bound; decode is memory-bandwidth-bound — say both, and why mixing them hurts latency",
          "Cold start (~minutes) is why autoscaling has to be predictive, not reactive",
          "Past saturation, more admitted requests only add queueing delay, not throughput",
          "Cache locality (prefix cache) and routing decisions are coupled — routing policy determines whether the cache even works",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  rehearse: [
    {
      n: 1,
      title: "Clarify Requirements and Scale",
      minutes: 5,
      goal: "Lock five numbers and the product scope before drawing anything: traffic pattern, model size, context window, and latency targets.",
      why: "Numbers drive every later choice here — replica sizing, batching policy, autoscaling thresholds all fall out of these numbers, so locking them first is what separates an engineer from someone guessing at GPU counts.",
      steps: [
        { kind: "ASK", text: '**Interactive chat, or also batch/offline jobs?** Land on "interactive chat is P0, batch is P2". Write **"chat P0, batch P2"** in the corner.' },
        { kind: "ASK", text: 'Next: **"What model size and context window?"** Land on "~70B params, up to 32K context". Write **"70B, 32K ctx"**.' },
        { kind: "SAY", text: 'Propose the latency targets: **"p50 TTFT < 300ms"**, **"p50 ITL < 40ms/token"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "request routing", "batching", "KV cache management", "autoscaling", "admission control". Out: "model training/fine-tuning", "content-safety filtering". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do quick capacity math out loud: **"140GB weights / TP=8 = 17.5GB per GPU"**, **"~320KB KV per token"**. Write the totals on the board before being asked.' },
      ],
      grading: "Are numbers written on the board, is out-of-scope explicitly parked, and does the KV-memory math start before the interviewer prompts for it?",
    },
    {
      n: 2,
      title: "API and Serving Model",
      minutes: 5,
      goal: "One streaming endpoint, the KV block-table model, and the per-token memory math brought forward before being asked.",
      why: "The interviewer wants to see this framed as a memory-bound streaming system, not a generic REST CRUD app. Bringing the block-table model and the KV math forward signals you already know where the constraint lives.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoint: **"POST /v1/chat/completions { messages, max_tokens, stream: true }"** returns an SSE stream of token deltas. Add **"GET /v1/models"** for available versions.' },
        { kind: "DRAW", text: 'Sketch a sequence\'s state: **"{ request_id, block_table → physical KV blocks, position, prefix_cache_ref }"**. Say: "The block table, not a full contiguous buffer, is what lets PagedAttention share and reclaim memory cheaply."' },
        { kind: "SAY", text: 'Justify the per-token KV number: **"~320KB/token with GQA, so a 4K-token session is about 1.2GB"** — that\'s the real per-user cost, not compute.' },
        { kind: "RULE OUT", text: 'Get ahead of naive alternatives: "one GPU per user doesn\'t scale — batching is what makes this economical." "Contiguous max-length KV buffers waste 60-80% of memory." Cross both off.' },
      ],
      grading: "Crisp API surface, the block-table model drawn, and the KV-per-token math brought forward unprompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: request/serving, KV-cache/state, and background control-plane. Label arrows with numbers, not just box names.",
      why: "Drawing these as separate lanes proves you understand they run on different timescales and have different failure modes: serving is milliseconds, cache mutation is per-token, autoscaling is minutes. Candidates who draw one blob miss why a cold start can't be an autoscaler's only lever.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **request lane**: Client → Smart Router → Admission Queue → Prefill Pool → Decode Pool → Client. Label arrows **"cache-aware routing"**, **"admitted · new prompt"**, **"SSE token stream"**.' },
        { kind: "DRAW", text: 'Add the **KV-cache/state lane**: Prefill → Prefix Cache (**"write/reuse prefix blocks"**), Prefill → GPU KV Cache (**"allocate blocks for prompt"**), Decode → GPU KV Cache (**"allocate/free paged blocks"**).' },
        { kind: "DRAW", text: 'Add the **background/control lane**: Weight Store → Prefill/Decode (**"cold start ~3 min"**), Metrics → Autoscaler → Prefill/Decode (**"scale replicas"**).' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they run on three different timescales — serving is milliseconds, cache mutation is per-token, autoscaling is minutes."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with concrete numbers, and an explicit statement about the differing timescales.",
    },
    {
      n: 4,
      title: "Deep Dive: KV Cache & PagedAttention",
      minutes: 8,
      goal: "Show the block-table mechanism and defend it against contiguous allocation, quantified.",
      why: "This is the signature sub-problem. The interviewer is probing whether you understand memory as the real constraint and can explain, with numbers, why paged allocation beats the naive approach.",
      steps: [
        { kind: "DRAW", text: 'Draw a block-table example: a sequence\'s tokens mapped across non-contiguous 16-token blocks scattered physically in GPU memory.' },
        { kind: "SAY", text: '"Fixed-size pages mean a sequence grows by grabbing one more block instead of pre-reserving worst-case length — the same idea as OS virtual memory paging."' },
        { kind: "SAY", text: '"Shared prefixes let two sequences\' block tables point at the same physical blocks — copy-on-write, not copy-on-read — which is what makes prefix caching cheap."' },
        { kind: "RULE OUT", text: '"Contiguous per-request reservation" → "~20-40% effective utilization, rejected."' },
      ],
      grading: "Block table explained without prompting, contiguous-allocation waste quantified, and prefix-sharing tied back to PagedAttention.",
    },
    {
      n: 5,
      title: "Deep Dive: Continuous Batching & Prefill/Decode Disaggregation",
      minutes: 7,
      goal: "Explain iteration-level scheduling precisely, then volunteer why prefill and decode interfere and how to fix it.",
      why: "Anyone can say 'batch requests'. The interviewer wants iteration-level scheduling explained correctly, and — for the top score — the prefill/decode interference problem named before being asked about latency spikes.",
      steps: [
        { kind: "SAY", text: '"Static batching waits for the slowest sequence in a fixed batch; continuous batching reschedules every decoding step so finished sequences leave and queued ones join immediately."' },
        { kind: "SAY", text: '"Prefill is one big compute-bound matmul; decode is memory-bandwidth-bound, one token at a time. Mixed on one GPU, a new long prompt\'s prefill can stall everyone else\'s in-flight decode step."' },
        { kind: "SAY", text: '"Fix: disaggregate into separate prefill/decode pools with a fast KV handoff over NVLink/InfiniBand, or chunk large prefills between decode steps if a second pool isn\'t justified yet."' },
        { kind: "RULE OUT", text: '"A single monolithic batch mixing both phases" → "unpredictable inter-token latency, rejected for latency-sensitive traffic."' },
      ],
      grading: "Continuous batching explained precisely (per-step, not per-request), both prefill and decode resource profiles named, and at least one mitigation for interference.",
    },
    {
      n: 6,
      title: "Wrap: Autoscaling, Admission Control, and Close",
      minutes: 5,
      goal: "Name the cold-start constraint, tie admission control to queueing behavior, push back once, and close with a summary plus parked items.",
      why: "Staff-level signal is operational maturity: framing autoscaling as predictive because of cold start, admission control tied to a saturation argument rather than 'we'll add a queue', and a clean close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: '"Autoscaling reaction time is floored by a ~3-minute cold start to load a 140GB checkpoint, so we scale on queue-depth trend, not point-in-time utilization, plus a warm standby buffer."' },
        { kind: "SAY", text: '"Past saturation, admitting more requests just adds queueing delay for everyone, so admission control rejects or queues with explicit backpressure once KV occupancy crosses a threshold."' },
        { kind: "SAY", text: 'Push back: "Do we actually need 32K context for most traffic, or is that a long tail? That changes the average KV footprint a lot."' },
        { kind: "SAY", text: 'Close: "It\'s a GPU-memory-bound streaming system built around continuous batching, PagedAttention, and cache-aware routing, with autoscaling that has to predict rather than react. With more time I\'d cover multi-tenant isolation and quantization tradeoffs."' },
      ],
      grading: "Cold-start constraint named as the reason for predictive autoscaling, admission control tied explicitly to queueing-past-saturation, at least one pushback, and a crisp close with parked items.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but the memory math and the interference risks stay unquantified.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, cache, GPU inference server, request queue.",
          "Knows to use a framework like vLLM or Triton, without necessarily explaining why.",
          "Understands streaming responses via SSE/WebSocket.",
          "Adds a queue when told the system gets overloaded.",
          "Knows the KV cache exists as a concept but can't size it.",
        ],
        gaps: [
          "Doesn't do the KV-cache math out loud, or just says 'add more GPUs' without quantifying it.",
          "Treats prefill and decode as the same workload, doesn't notice the interference problem.",
          "Cache is one layer with no hit-rate estimate or a plan for prefix caching.",
          "Assumes autoscaling is instant, no notion of a cold start.",
          "Admission control is missing, or just 'return an error when busy' with no stated threshold or tiering.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, quantifies the KV-cache constraint, and separates prefill from decode with a concrete mitigation.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes QPS, context length, and TTFT/ITL targets on the board within the first 5 minutes.",
          "Explains why GPU memory (the KV cache), not compute, is the binding constraint, with rough math.",
          "Describes continuous batching and PagedAttention correctly, distinguishing static vs iteration-level batching.",
          "Separates prefill and decode conceptually, and proposes disaggregation or chunking.",
          "Uses prefix caching and connects it to routing policy (cache-aware routing).",
          "Names autoscaling's cold-start floor and designs around it (warm buffer, trend-based scaling).",
          "Adds admission control with explicit backpressure.",
        ],
        gaps: [
          "Volunteers prefill/decode interference only when prompted about latency spikes, not proactively.",
          "Quantifies queueing behavior in words ('gets slower') rather than the saturation framing.",
          "Doesn't proactively bring up SLO tiering between interactive and batch traffic.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats GPU memory as the load-bearing constraint from minute one, and brings operational maturity that goes beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the 'KV cache is the real constraint' framing unprompted, quantifying the weights-vs-KV split and sessions/GPU.",
          "Brings up prefill/decode interference and disaggregation before being asked about latency spikes.",
          "Frames autoscaling as fundamentally predictive because of cold start, with a warm-buffer strategy and specific reaction-time numbers.",
          "Explicitly separates SLO tiers (interactive vs batch) and uses that hierarchy to justify admission-control policy.",
          "Pushes back on requirements (context length, concurrency targets) and explains how each changes the capacity math.",
          "Discusses quantization (fp8/int8/int4) and speculative decoding as levers, and knows their tradeoffs (accuracy vs throughput/latency).",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Reaching for 'just add more GPUs' without ever computing what a GPU actually holds (weights + KV budget).",
      "Treating prefill and decode as interchangeable work that can always share one batch, with no mention of interference.",
      "Round-robin or least-connections routing with no acknowledgment that it destroys prefix-cache locality.",
      "Assuming autoscaling reacts in seconds, ignoring the multi-minute checkpoint-load cold start.",
      "No admission control: accepting unlimited concurrent requests and letting latency silently degrade for everyone.",
      "Quoting a cache hit rate or GPU utilization number with no basis, or no plan for what happens if traffic patterns shift.",
      "Designing with no capacity numbers at all, so batch size, replica count, and context limits are all guesses.",
    ],
    followUps: [
      {
        q: "Why is GPU memory usually the bottleneck instead of compute?",
        a: "Decode generates one token at a time, and each step streams the entire KV cache and model weights through GPU memory to produce a single token — that's a huge amount of memory traffic per unit of compute, so the GPU has FLOPs to spare while its memory bandwidth and capacity are saturated. Meanwhile the KV cache itself grows linearly with context length times concurrent users, unlike weights which are a fixed cost, so at any real scale it's the KV budget, not TFLOPs, that runs out first.",
      },
      {
        q: "How does PagedAttention actually reduce fragmentation?",
        a: "It applies the OS virtual-memory trick: instead of reserving a contiguous buffer sized for the worst-case sequence length, KV cache is split into small fixed-size blocks allocated on demand, with a per-sequence block table mapping logical positions to physical blocks. Block size is a real tradeoff — too small adds per-block bookkeeping overhead, too large reintroduces internal fragmentation — but in practice this lifts effective utilization from the 20-40% range of contiguous allocation to near-zero fragmentation, roughly 2-4x more concurrent sequences per GPU.",
      },
      {
        q: "Why can't you just always disaggregate prefill and decode?",
        a: "Disaggregation costs a second GPU pool plus a KV-cache transfer network fast enough not to become its own bottleneck (NVLink or InfiniBand-class bandwidth), so it only pays off past a certain scale or latency sensitivity. Below that, chunked prefill — splitting a big prompt into small pieces interleaved between decode steps — gets most of the latency benefit on a single shared pool without the operational cost of running two fleets.",
      },
      {
        q: "What happens to prefix cache hit rate under multi-tenant traffic with many different system prompts?",
        a: "It degrades gracefully rather than catastrophically: cached blocks are evicted under an LRU-style policy as memory pressure rises, so low-traffic prefixes fall out first while high-traffic ones stay resident. The bigger risk is a bad routing key — if the router hashes on the full prompt instead of just the shared prefix, requests with a common header but different tails scatter across replicas and never converge on the same cache, so the key has to be chosen to match the actual shared structure.",
      },
      {
        q: "How would you serve two different model sizes or versions on the same fleet?",
        a: "Route by model_id at the Smart Router and keep separate replica pools per model, since weights and tensor-parallel topology differ enough that sharing a pool doesn't make sense. For a version rollout, canary a small percentage of traffic to the new version's pool, watch TTFT, ITL, and error rate against the incumbent, and ramp the traffic split only once those match or beat the baseline.",
      },
      {
        q: "What levers would you pull to cut cost per token without hurting quality much?",
        a: "Quantization (fp8, sometimes int8 or calibrated int4) shrinks both the weight footprint and memory bandwidth per token, directly raising achievable batch size and throughput. Speculative decoding uses a small draft model to propose several tokens that the full model verifies in one pass, cutting the number of expensive full-model decode steps needed per output token. Both compose with continuous batching and PagedAttention rather than replacing them, and both trade a small amount of output quality or implementation complexity for real throughput gains.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  deepDive: {
    intro:
      "A full written walkthrough of this design, end to end — the same reasoning as the tabs above, laid out as prose you can read once and re-derive from memory.",
    sections: [
      {
        heading: "The one-line mental model",
        body: [
          "This is a GPU-memory-bound streaming system with two very different phases per request. The core operation — turn a prompt into a stream of tokens — has a one-shot compute-bound prefill and a repeated memory-bandwidth-bound decode, and everything expensive in the stack (batching, cache paging, disaggregation, routing, autoscaling) exists to keep both phases fast without one starving the other.",
          "Anchor everything on five numbers: a 70B-parameter model, 20K requests/minute, 50K concurrent streams, a 32K-token max context, and a sub-300ms p50 time-to-first-token. Every structural choice below is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing: weights, KV cache, and the concurrency ceiling",
        body: [
          "140GB of fp16 weights, split 8 ways by tensor parallelism, costs ~17.5GB per GPU no matter how many users are connected — that part is fixed. What varies is the KV cache: with grouped-query attention (8 KV heads, head_dim 128, 80 layers, fp16), one token costs ≈320KB, so a 4K-token conversation pins down ≈1.2GB of GPU memory for as long as it's active.",
          "With ~55GB of usable KV budget left per GPU after weights and overhead, that's roughly 45 concurrent 4K-context sessions per GPU. This is the number that actually caps a replica's concurrency — not TFLOPs — and it's why capacity planning for this system starts from gigabytes of KV cache, not throughput benchmarks.",
        ],
      },
      {
        heading: "Continuous batching and PagedAttention",
        body: [
          "Static, request-level batching waits for the slowest sequence in a batch before admitting new work, wasting GPU cycles on padding and creating terrible tail latency for short requests stuck behind long ones. Continuous batching reschedules the batch at every decoding step: a sequence that just finished leaves, a queued one immediately takes its slot, and GPU utilization climbs from the 20-30% range up toward 70-80%+.",
          "That only works if the KV cache itself doesn't force worst-case pre-allocation. PagedAttention splits KV cache into small fixed-size blocks tracked by a per-sequence block table — the same trick as OS virtual memory paging — turning ~20-40% effective utilization under contiguous allocation into near-zero fragmentation, and enabling cheap prefix sharing as a side effect.",
        ],
      },
      {
        heading: "Prefill/decode disaggregation",
        body: [
          "Prefill and decode have opposite resource profiles: prefill is one large compute-bound matmul over the whole prompt, decode is memory-bandwidth-bound and repeats once per output token. Mixed in one continuous batch, a new long prompt's prefill can stall every other user's in-flight decode step for hundreds of milliseconds, spiking inter-token latency for streams that have nothing to do with the new request.",
          "The fix is either separate prefill and decode GPU pools connected by a fast KV-cache transfer over NVLink or InfiniBand, or — when a second pool isn't justified — chunked prefill, which splits a large prompt into small pieces interleaved between decode steps so it can never block for too long at once.",
        ],
      },
      {
        heading: "Prefix caching and cache-aware routing",
        body: [
          "Shared system prompts, few-shot templates, and multi-turn conversation history all repeat the same prefix across requests; recomputing that prefix's prefill every time wastes compute for a result that's deterministic given the same tokens. Prefix caching (SGLang's RadixAttention, vLLM's automatic prefix caching) keeps those KV blocks resident and reuses them, so a new request only needs prefill on the tokens after the longest cached match.",
          "That cache only helps if the router sends related requests to the replica that already holds them: round-robin or least-connections routing spreads load evenly but destroys locality, so a cache-aware router consistent-hashes on the prompt prefix (or conversation id) and falls back to load-based routing when the preferred replica is saturated.",
        ],
      },
      {
        heading: "Autoscaling, admission control, and SLO tiers",
        body: [
          "A new GPU replica is not ready in seconds: pulling a 140GB checkpoint and warming up tensor-parallel communication takes on the order of minutes, so an autoscaler that reacts to current utilization is always too late. It has to scale on a leading indicator — queue-depth trend — and keep a warm standby buffer for predictable peaks.",
          "Past saturation, admitting more requests doesn't add throughput, it only adds queueing delay for everyone, so admission control rejects or bounded-queues new requests with explicit backpressure once KV occupancy or queue depth crosses a threshold. SLO tiers make that policy fair: interactive chat traffic is protected first, and offline/batch jobs are the ones delayed or preempted to absorb the slack.",
        ],
      },
    ],
  },
};
