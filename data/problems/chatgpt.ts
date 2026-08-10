import type { Problem } from "@/lib/types";

export const chatgpt: Problem = {
  slug: "chatgpt",
  num: "7.4",
  title: "Design ChatGPT",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design ChatGPT: a conversational AI product that serves over 300 million weekly active users, streams token-by-token completions for roughly 1 billion messages a day (about 30K requests/sec at peak), maintains multi-turn context per conversation, and keeps time-to-first-token under a second even though each response is generated autoregressively, one token at a time, on a fleet of GPUs that is the scarcest resource in the whole system.",
  ],
  hardParts:
    "The hard parts: squeezing near-100% GPU utilization out of an inherently sequential, memory-bandwidth-bound decode loop (continuous batching, PagedAttention); keeping time-to-first-token flat as conversations grow by reusing a GPU-resident KV cache across turns instead of re-processing the whole history every message; and running safety moderation and model-tier routing without adding a second full inference call's worth of latency to every message.",
  keyTopics: [
    "Continuous (In-Flight) Batching",
    "PagedAttention KV-Cache Management",
    "Prefill/Decode Split & Time-to-First-Token",
    "Sticky Routing via Consistent Hashing",
    "Tiered Model Routing & Admission Control",
  ],
  foundationsReferenced: [
    { label: "Consistent Hashing", tone: "purple" },
    { label: "Load Balancing", tone: "green" },
    { label: "Rate Limiting / Token Bucket", tone: "green" },
    { label: "Kafka", tone: "orange" },
    { label: "Sharded Postgres", tone: "blue" },
    { label: "Vector Databases", tone: "purple" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "web / mobile app", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "API Gateway", sub: "authn · rate limit", col: 2, row: 1, tone: "green" },
      {
        id: "orchestrator",
        label: "Chat Orchestrator",
        sub: "stateless · builds prompt",
        mono: "hash(conversation_id) → sticky node",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "router", label: "Model Router", sub: "small vs. flagship tier", col: 4, row: 1, tone: "purple" },
      {
        id: "inference",
        label: "Inference Cluster",
        sub: "vLLM-style · continuous batching",
        mono: "prefill (parallel) + decode (sequential)",
        col: 5,
        row: 1,
        tone: "blue",
      },
      { id: "history", label: "Conversation Store", sub: "sharded Postgres", col: 3, row: 2, tone: "blue" },
      { id: "moderation", label: "Moderation Service", sub: "sync in/out filter, <50ms", col: 4, row: 2, tone: "purple" },
      {
        id: "kvcache",
        label: "KV Cache Pool",
        sub: "GPU HBM, per-session",
        mono: "PagedAttention blocks",
        col: 5,
        row: 2,
        tone: "blue",
      },
      { id: "kafka", label: "Kafka", sub: "async event bus", col: 2, row: 3, tone: "orange" },
      { id: "usage", label: "Usage Metering", sub: "tokens → billing", col: 3, row: 3, tone: "orange" },
      { id: "analytics", label: "ClickHouse", sub: "logs · abuse review · metrics", col: 4, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "gateway", label: "POST /chat/completions", kind: "write" },
      { from: "gateway", to: "orchestrator", kind: "write" },
      { from: "orchestrator", to: "history", label: "fetch last N turns", kind: "read" },
      { from: "orchestrator", to: "moderation", label: "input check, sync", kind: "read" },
      { from: "orchestrator", to: "router", label: "assembled prompt", kind: "write" },
      { from: "router", to: "inference", label: "route by tier · queue if saturated", kind: "write" },
      { from: "inference", to: "kvcache", label: "reuse cached prefix, sticky by conversation_id", kind: "read" },
      { from: "inference", to: "moderation", label: "output check, streamed", kind: "read" },
      { from: "inference", to: "client", label: "SSE token stream", kind: "write" },
      { from: "inference", to: "history", label: "persist full turn", kind: "write" },
      { from: "inference", to: "kafka", label: "token/latency/cost events", kind: "analytics" },
      { from: "kafka", to: "usage", kind: "analytics" },
      { from: "kafka", to: "analytics", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · fetch context, moderation checks, cached KV state" },
      { kind: "write", text: "write path · new tokens generated and persisted" },
      { kind: "analytics", text: "analytics · async, never blocks a token stream" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "gateway", "orchestrator", "router", "inference"],
      say: "Start with the shape of one request: client through the gateway to a stateless orchestrator, which hands the assembled prompt to a model router, and the router places it on the inference cluster, which streams tokens straight back over SSE. That's the loop before any of the optimizations that make it fast.",
    },
    {
      reveal: ["history", "moderation"],
      say: "Two synchronous stops happen before a token is generated: the orchestrator pulls the last N turns from the Conversation Store to rebuild context, and a small classifier checks the input in under 50ms, both completing before the prompt ever reaches a GPU. Output gets the same check, streamed incrementally as tokens come back.",
    },
    {
      reveal: ["kvcache"],
      say: "The KV Cache Pool is what makes a follow-up turn cheap: it lives in GPU HBM right next to the inference cluster, and sticky routing by hash(conversation_id) means a warm conversation only prefills the new message instead of re-processing the whole history.",
    },
    {
      reveal: ["kafka", "usage", "analytics"],
      say: "Everything off the critical path fires into Kafka and moves on: Usage Metering turns token events into billing, and ClickHouse holds them for abuse review and dashboards. Neither can ever add a millisecond to a token stream.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Accept a user prompt and stream the completion back token-by-token over a long-lived connection", tag: "P0" },
      { id: "FR-02", text: "Maintain multi-turn conversation context so a follow-up message can reference earlier turns", tag: "P0" },
      { id: "FR-03", text: "Enforce a per-model context window, truncating or summarizing older turns when a conversation exceeds it", tag: "P0" },
      { id: "FR-04", text: "Run synchronous input and output moderation without materially increasing latency", tag: "P0" },
      { id: "FR-05", text: "Route each request to an appropriately sized model based on task complexity or user tier", tag: "P1" },
      { id: "FR-06", text: "Let the user stop an in-flight generation or regenerate the last response", tag: "P1" },
      { id: "FR-07", text: "Persist conversation history durably, retrievable across devices and sessions", tag: "P0" },
      { id: "FR-08", text: "Enforce per-user and per-tier rate limits and token quotas (free vs. paid)", tag: "P0" },
      { id: "FR-09", text: "Accept multimodal input (images, file uploads) alongside text", tag: "P2" },
      { id: "FR-10", text: "Meter token usage per request for billing and cost attribution", tag: "P1" },
      { id: "FR-11", text: "Support custom system instructions / persona per user or conversation", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Time-to-first-token (TTFT), server-side", tag: "p99 < 1s" },
      { id: "NFR-02", text: "Inter-token streaming cadence once generation starts", tag: "p50 < 40ms/tok" },
      { id: "NFR-03", text: "Sustained request throughput, peak", tag: "30K/sec" },
      { id: "NFR-04", text: "Concurrent in-flight generations at peak", tag: "250K concurrent" },
      { id: "NFR-05", text: "Availability (chat completion path)", tag: "99.9%" },
      { id: "NFR-06", text: "GPU fleet utilization target", tag: "> 70%" },
      { id: "NFR-07", text: "Conversation history durability", tag: "zero loss" },
      { id: "NFR-08", text: "Moderation latency budget added to TTFT", tag: "< 50ms" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: how many GPUs does this actually take?",
      body: [
        "This system can't be sized off requests/sec the way a stateless web service can, because each request pins a GPU slot for the entire multi-second generation, not for a few milliseconds. Work backward from concurrency instead: 1 billion messages/day is about 12K requests/sec average; a 2.5x peak factor for daily and regional swings puts peak at roughly 30K requests/sec.",
        "An average response is about 240 output tokens, streamed at roughly 30 tokens/sec, so each generation occupies a slot for about 8 seconds. Peak concurrent in-flight generations is peak arrival rate times duration: 30,000 x 8 ≈ 250,000 concurrent generations. If one 8-GPU inference node can hold roughly 100 concurrent sequences via continuous batching, that's about 2,500 inference nodes — roughly 20,000 GPUs — just for the hot decode tier, before redundancy and multiple model tiers.",
      ],
      bullets: [
        { lead: "Requests/sec", text: "tells you arrival rate, not fleet size — it's the wrong axis to size GPUs off of." },
        { lead: "Duration matters", text: "a generation holding a GPU slot for 8 seconds means the fleet must hold 8 seconds' worth of arrivals at once, not just the arrivals themselves." },
        { lead: "Concurrency = rate x duration", text: "the same formula you'd use for any queueing system, applied to GPU slots instead of connections." },
        { lead: "Per-node capacity closes the loop", text: "divide total concurrency by concurrent-sequences-per-node to get the fleet size." },
      ],
      pictureTitle: "From messages/day to GPU count",
      pictureRows: [
        { label: "1B msgs/day → ~12K req/s avg, ~30K peak", value: "arrival rate", tone: "neutral" },
        { label: "240 out tok @ 30 tok/s → 8s/generation", value: "slot duration", tone: "neutral" },
        { label: "30K req/s x 8s ≈ 250K concurrent", value: "peak concurrency", tone: "good" },
        { label: "250K ÷ ~100 seqs/node ≈ 2,500 nodes (~20K GPUs)", value: "fleet size", tone: "good" },
      ],
      remember: {
        problem: "How many GPUs does 1B messages/day actually require?",
        solution: "Work backward from concurrency, not raw request rate: peak req/sec x average generation duration = concurrent in-flight generations, then divide by per-node batch capacity.",
        why: "GPU capacity is bounded by concurrent sequences a batch can hold, not by requests/sec directly — duration matters because each generation occupies a GPU slot for seconds, not milliseconds.",
        tradeoff: "Bigger batches raise GPU utilization but raise inter-token latency for everyone in the batch; smaller batches protect latency but waste GPU-seconds.",
        failure: "Sizing off req/sec alone, like a stateless web service, undercounts the fleet by 10x or more.",
        mitigation: "Size the fleet from concurrency (arrival rate x duration), keep spare batch headroom, and monitor GPU utilization directly, not just req/sec.",
      },
    },
    {
      n: 2,
      title: "Continuous batching and PagedAttention",
      body: [
        "Static batching groups requests into a fixed batch and waits for every sequence in it to finish before freeing any slot, padding shorter sequences to the length of the longest one. Under real traffic, response lengths vary wildly, so a batch stalls on its slowest member and wastes compute on padding for everyone else. Continuous (in-flight) batching fixes this at the scheduler level: at every decode step, finished sequences leave the batch and new requests join, so the GPU stays near saturated instead of idling.",
        "The other half of the problem is memory. A naive KV cache implementation pre-allocates space for the maximum possible sequence length per request up front, and since most conversations are far shorter than the max, that wastes the majority of GPU memory to fragmentation. PagedAttention borrows the idea of OS virtual-memory paging: the KV cache is stored in fixed-size, non-contiguous blocks allocated on demand, referenced through a per-sequence block table. That alone typically lets 2-4x more concurrent sequences fit in the same GPU memory.",
      ],
      bullets: [
        { lead: "Static batching", text: "pads to the longest sequence and holds every slot hostage until the slowest one finishes. Rejected." },
        { lead: "Continuous batching", text: "admits and evicts sequences at every decode step, keeping the GPU close to saturated. Winner." },
        { lead: "Naive KV cache", text: "pre-allocates for the worst case per sequence, wasting most of GPU memory in practice. Rejected." },
        { lead: "PagedAttention", text: "on-demand, fixed-size KV blocks plus a block table, 2-4x more concurrent sequences per GPU. Winner." },
      ],
      pictureTitle: "Batching and KV cache: kill two, keep two",
      pictureRows: [
        { label: "Static batching", value: "batch stalls on its slowest sequence", tone: "bad" },
        { label: "Continuous batching", value: "admit/evict every step, ~90%+ utilization", tone: "good" },
        { label: "Naive KV pre-allocation", value: "heavy fragmentation, memory wasted", tone: "bad" },
        { label: "PagedAttention", value: "on-demand blocks, 2-4x more concurrent sequences", tone: "good" },
      ],
      remember: {
        problem: "Autoregressive decoding is inherently sequential and GPU-expensive; naive batching wastes most of that capacity.",
        solution: "Continuous (in-flight) batching at the scheduler level, PagedAttention for the KV cache.",
        why: "Token-level admission keeps the GPU full instead of idling on the batch's slowest member; block-based KV cache eliminates the padding and fragmentation static allocation causes.",
        tradeoff: "More scheduler complexity — per-token admission, block-table bookkeeping — in exchange for multiples more throughput per GPU.",
        failure: "Static batching plus naive KV allocation can leave a GPU at 20-30% effective utilization even under heavy load.",
        mitigation: "Adopt a serving engine built around both techniques rather than hand-rolling batching.",
      },
    },
    {
      n: 3,
      title: "Prefill vs. decode: why TTFT and streaming cadence behave differently",
      body: [
        "Generation has two distinct phases with different bottlenecks. Prefill processes the entire input prompt in one parallel forward pass — it's compute-bound, and its cost grows with prompt length. Decode generates output tokens one at a time, each requiring a pass conditioned on the growing KV cache — it's memory-bandwidth-bound, and its cost per token is roughly constant. Time-to-first-token is dominated by prefill (plus any queueing); the steady streaming cadence afterward is dominated by decode.",
        "This split explains why longer conversations quietly get slower: without caching, every turn re-runs prefill over the entire history, so TTFT grows with conversation length even though the model itself hasn't changed. It also explains a subtler fairness problem — a long prompt's compute-heavy prefill can stall other users' decode steps if they share a batch on the same GPU, which is why production serving stacks often prioritize or even disaggregate prefill onto separate GPU pools from decode.",
      ],
      bullets: [
        { lead: "Prefill", text: "whole prompt processed in one parallel pass, compute-bound, cost grows with prompt length — dominates TTFT." },
        { lead: "Decode", text: "one token at a time, memory-bandwidth-bound, roughly constant cost per token — sets the streaming cadence." },
        { lead: "Mixing them in one batch", text: "a long prefill can stall in-flight decode steps for other users sharing the GPU, motivating prioritization or disaggregation." },
        { lead: "Caching the prefix", text: "if the shared history is already warm in cache on the node, only the new turn needs prefill — the single biggest lever on TTFT for a multi-turn chat." },
      ],
      pictureTitle: "Two phases, two bottlenecks",
      pictureRows: [
        { label: "Prefill (new conversation)", value: "compute-bound, cost ∝ prompt length", tone: "neutral" },
        { label: "Decode", value: "memory-bandwidth-bound, ~constant cost/token", tone: "neutral" },
        { label: "Cold start (full history reprocessed)", value: "TTFT scales with entire history", tone: "bad" },
        { label: "Warm cache (sticky routing)", value: "only the new turn is prefilled", tone: "good" },
      ],
      remember: {
        problem: "Time-to-first-token degrades as conversations get longer.",
        solution: "Split generation into prefill (parallel, compute-bound) and decode (sequential, memory-bound), and cache the prefill of the unchanged prefix across turns.",
        why: "Prefill cost scales with prompt length; re-running it on the full history every turn means TTFT grows with the conversation instead of staying flat.",
        tradeoff: "Prefix caching needs sticky (session-affine) routing, which reduces load-balancing flexibility and creates a KV-cache-loss failure mode on node death.",
        failure: "Recomputing full-history prefill every turn can make TTFT on a 20-turn conversation several times worse than on the first message.",
        mitigation: "Cache KV state for the shared prefix, route follow-ups to the same node via consistent hashing on conversation_id, and fall back to full recompute if that node is unavailable.",
      },
    },
    {
      n: 4,
      title: "Context window management: truncation, summarization, retrieval",
      body: [
        "Every model has a fixed maximum context window in tokens, and long-running conversations eventually exceed it. Hard truncation — dropping the oldest turns once the token budget is hit — is cheap and simple, but the model silently forgets facts stated many messages ago. Rolling summarization periodically collapses old turns into a compact summary with an extra model call, preserving the gist at the cost of extra latency and tokens for the summarization call itself. Retrieval-augmented memory embeds older turns into a vector store and pulls back only what's relevant to the current message, which scales to long-lived memory but adds a retrieval hop before every generation.",
        "No single technique is enough on its own, so production systems layer all three: keep the last K turns verbatim for exact recall, summarize what falls off that window on a schedule (not every turn, to bound the summarization cost), and optionally use retrieval for explicit long-term memory features.",
      ],
      bullets: [
        { lead: "Hard truncation", text: "drop oldest turns at the token budget — cheap, simple, but the model forgets facts stated 30 messages ago." },
        { lead: "Rolling summarization", text: "periodically collapse old turns into a summary with an extra model call — preserves gist, costs latency and tokens." },
        { lead: "Retrieval-augmented memory", text: "embed and store older turns, pull back only what's relevant — scales to long-term memory, adds a retrieval hop." },
        { lead: "Layered in production", text: "verbatim recent window + scheduled summary of the rest + optional retrieval, not one strategy alone." },
      ],
      pictureTitle: "Three techniques, one pipeline",
      pictureRows: [
        { label: "Hard truncation", value: "cheap, loses old facts", tone: "neutral" },
        { label: "Rolling summarization", value: "keeps the gist, extra model call", tone: "good" },
        { label: "Vector retrieval", value: "long-term memory, adds a hop", tone: "neutral" },
        { label: "Recent window + summary + retrieval", value: "what production systems actually do", tone: "good" },
      ],
      remember: {
        problem: "Conversations grow past the model's fixed context window.",
        solution: "Layer truncation, rolling summarization, and retrieval-augmented memory instead of picking just one.",
        why: "Each technique alone trades off badly — truncation forgets, summarization costs a call, retrieval adds latency — but combined they cover both the token budget and long-term recall.",
        tradeoff: "More pipeline stages before generation even starts, and summarization is itself lossy and can compound errors over many rounds.",
        failure: "Naive truncation on a long session silently drops a constraint the user stated early on, and the model contradicts it many messages later.",
        mitigation: "Keep the last K turns verbatim, summarize the rest on a schedule, and cap summary length so it can't itself blow the budget.",
      },
    },
    {
      n: 5,
      title: "Model routing and admission control under GPU scarcity",
      body: [
        "GPUs are the scarcest, most expensive resource in the whole system, so not every request should hit the flagship model. A router — a cheap classifier, prompt heuristics, or explicit user tier — decides whether a query goes to a small, fast model or the flagship model, since most queries don't need the biggest model's reasoning.",
        "Routing alone isn't enough when the flagship tier saturates under load. The instinct to just cram more sequences into a batch degrades inter-token cadence for every concurrent user at once, not just new arrivals, because it's a shared resource. Explicit admission control — queueing with a visible 'still thinking' state, or shedding the lowest-priority traffic first — protects the users already mid-generation instead of silently slowing everyone down.",
      ],
      bullets: [
        { lead: "Tiered models", text: "a small fast model handles simple queries, the flagship model handles complex reasoning — cuts GPU-seconds per request substantially since most queries are simple." },
        { lead: "Routing signal", text: "a cheap classifier decides tier before the expensive model is touched, so misrouting cost is a tiny fraction of a full flagship call." },
        { lead: "Admission control", text: "when the flagship tier saturates, queue with a visible wait state rather than overpacking the batch and degrading cadence for everyone already in it." },
        { lead: "Load shedding", text: "under extreme load, shed lowest-priority tiers (free-tier, background requests) before touching paying or interactive traffic." },
      ],
      pictureTitle: "Spending GPU-seconds where they earn their cost",
      pictureRows: [
        { label: "All requests → flagship model", value: "wastes GPU-seconds on simple queries", tone: "bad" },
        { label: "Router → tiered models", value: "cheap queries stay cheap", tone: "good" },
        { label: "Saturated tier, overpack batch", value: "cadence degrades for everyone", tone: "bad" },
        { label: "Saturated tier, queue + shed", value: "protects users already generating", tone: "good" },
      ],
      remember: {
        problem: "The flagship model is the most expensive, scarcest resource in the system.",
        solution: "Route by complexity or tier to smaller models where acceptable, and use explicit admission control — queue or shed — instead of overpacking batches when the flagship tier saturates.",
        why: "Most user queries don't need the biggest model's reasoning; spending GPU-seconds uniformly wastes the resource that's hardest to add capacity to.",
        tradeoff: "Misrouting a genuinely hard query to a small model degrades answer quality; queueing adds a visible wait instead of a silent slowdown.",
        failure: "No admission control means saturating the flagship tier overpacks every batch, degrading inter-token latency for every concurrent user at once.",
        mitigation: "Route by a cheap upfront classifier, cap batch size per node, queue with backpressure, and shed lowest-priority traffic first under extreme load.",
      },
    },
    {
      n: 6,
      title: "Moderation without doubling the latency budget",
      body: [
        "Safety review has to cover both input and output on every message, but it can't sit fully on the critical path or every message pays the cost of two expensive model calls. Split it by speed and accuracy: a small, fast classifier checks the input synchronously in tens of milliseconds before the prompt ever reaches the expensive model, output is checked incrementally as tokens stream out so a violation can abort the stream mid-flight rather than only being caught after the full response is generated, and a slower, more accurate review runs asynchronously after the fact for audit and abuse pattern detection.",
        "This mirrors the model-tiering idea one layer up: spend the expensive, accurate check only where it earns its cost, and let the cheap, fast check gate the vast majority of traffic.",
      ],
      bullets: [
        { lead: "Sync input check", text: "a small fast classifier, budgeted under 50ms, runs before the prompt reaches the expensive model — blocks obviously disallowed content before you spend a GPU on it." },
        { lead: "Streaming output check", text: "classify tokens incrementally as they're generated so a violation aborts the stream early instead of only being caught after the full response." },
        { lead: "Async deep review", text: "the full input/output pair is replayed through a slower, more accurate model off the critical path, feeding abuse pattern detection and audit trails." },
        { lead: "Fail-open vs. fail-closed", text: "decide per product tier whether a moderation outage blocks all traffic (safer, less available) or lets requests through unfiltered (available, riskier) — most systems fail-closed on output and degrade gracefully on the cheap input check." },
      ],
      pictureTitle: "Tiering safety review the same way you tier the model",
      pictureRows: [
        { label: "Sync input check", value: "<50ms, blocks before the expensive model", tone: "good" },
        { label: "Streaming output check", value: "abort mid-stream on violation", tone: "good" },
        { label: "Async deep review", value: "slower model, off the critical path", tone: "neutral" },
        { label: "Moderation service down", value: "fail-closed on output, degrade on input", tone: "neutral" },
      ],
      remember: {
        problem: "Safety review must cover every message without doubling generation latency.",
        solution: "A fast sync classifier on input, an incremental streaming check on output, and a slower deep review that runs async.",
        why: "Tiering moderation by speed and accuracy mirrors tiering the models themselves — spend the expensive check only where it earns its cost.",
        tradeoff: "The fast sync classifier is less accurate than the deep review, so some borderline content is only caught after the fact.",
        failure: "Running full deep review synchronously on every message would add hundreds of milliseconds before the flagship model even starts.",
        mitigation: "Keep the sync check cheap and fast, stream-check output to abort early, and treat async review as the accuracy backstop, not the first line.",
      },
    },
    {
      n: 7,
      title: "Session affinity: consistent hashing and the KV cache",
      body: [
        "Once a conversation's KV cache is warm on a specific inference node, every follow-up turn should land back on that node to skip re-prefilling the whole history. Route by hashing conversation_id — consistent hashing, so adding or removing nodes only reshuffles a small fraction of active conversations instead of all of them — to pick a sticky node per conversation.",
        "If that node dies, the KV cache is lost, because it lives only in GPU HBM, but the conversation text itself is safe in the durable conversation store. The fallback is a full re-prefill on a new node: one slower turn, never lost data. That distinction — GPU cache as a performance artifact vs. Postgres as the source of truth — is the whole point.",
      ],
      bullets: [
        { lead: "Consistent hashing on conversation_id", text: "picks a sticky inference node per conversation; scaling the fleet up or down only remaps a small fraction of active conversations." },
        { lead: "KV cache lives in GPU HBM only", text: "it's a performance cache, not the source of truth — losing it costs one slow re-prefill, never data." },
        { lead: "Conversation store (sharded Postgres)", text: "the durable copy: every completed turn is persisted there regardless of what happens to the GPU-side cache." },
        { lead: "Node failure fallback", text: "reroute to a new sticky node via the hash ring, reconstruct the prompt from the durable store, pay one cold prefill, resume warm from then on." },
      ],
      pictureTitle: "What's durable vs. what's a cache",
      pictureRows: [
        { label: "Sticky node alive", value: "warm KV cache, only new turn prefilled", tone: "good" },
        { label: "Sticky node dies", value: "KV cache lost, one cold re-prefill", tone: "neutral" },
        { label: "Conversation text", value: "always durable in Postgres regardless", tone: "good" },
        { label: "Naive round-robin routing", value: "every turn is a cold prefill", tone: "bad" },
      ],
      remember: {
        problem: "Reusing a warm KV cache across turns needs the same physical GPU node every time.",
        solution: "Consistent hash conversation_id to a sticky inference node; keep the durable conversation history in Postgres as the real source of truth.",
        why: "The KV cache is a derived performance artifact that exists only in GPU memory; the conversation store is what actually can't be lost.",
        tradeoff: "Sticky routing reduces load-balancer flexibility and can create hot nodes if a few conversations are unusually chatty.",
        failure: "Round-robin routing with no affinity turns every single turn into a cold, full-history prefill, so TTFT grows with conversation length forever.",
        mitigation: "Consistent hashing bounds reshuffling on scale events; on node death, fall back to durable-store recompute rather than losing the conversation.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's an autoregressive token-generation service wrapped in a chat UI: every message triggers a prefill (process the prompt) then a decode loop (generate tokens one at a time), streamed back over a long-lived connection.",
      "GPU capacity, not request rate, is the real constraint — continuous batching and PagedAttention are what keep GPUs near saturated instead of stalling on the slowest sequence in a batch.",
      "Conversations are stateful across turns, so a warm KV cache is the single biggest lever on latency — sticky routing by conversation_id keeps a conversation on the same node so it never re-prefills its own history.",
      "Moderation and model choice are both tiered by cost: a cheap classifier gates input before the expensive model runs, and a router sends simple queries to a small model so the flagship model is spent where it earns its cost.",
      "Everything off the critical path — usage metering, abuse review, analytics — goes through Kafka async, same discipline as any other latency-sensitive system.",
    ],
    flows: [
      {
        kind: "read",
        title: "FOLLOW-UP TURN · WARM CACHE PATH",
        summary:
          "A message in an existing conversation is routed back to the same GPU node that already holds its KV cache, so only the new turn needs to be prefilled.",
        steps: [
          { label: "Client", note: "sends the next message in an existing conversation" },
          { label: "API Gateway", note: "authn, rate limit" },
          { label: "Chat Orchestrator", note: "hash(conversation_id) → sticky node" },
          { label: "Moderation", note: "input check, sync, <50ms" },
          { label: "Inference Cluster", note: "prefill only the new turn, decode against warm KV cache" },
          { label: "Client", note: "SSE token stream" },
        ],
      },
      {
        kind: "write",
        title: "NEW CONVERSATION · COLD START",
        summary:
          "The first message in a conversation has no warm cache anywhere, so the full prompt is prefilled fresh before generation begins, and the turn is persisted once complete.",
        steps: [
          { label: "Client", note: "sends the first message" },
          { label: "API Gateway", note: "authn, rate limit" },
          { label: "Chat Orchestrator", note: "assigns a fresh sticky node via the hash ring" },
          { label: "Moderation", note: "input check, sync" },
          { label: "Model Router", note: "picks small vs. flagship tier" },
          { label: "Inference Cluster", note: "full prefill, then decode" },
          { label: "Conversation Store", note: "persist the completed turn" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC: USAGE, ABUSE REVIEW, METRICS",
        summary:
          "Everything that isn't on the critical path fires an event and moves on; a Kafka blip never touches a token stream.",
        steps: [
          { label: "Inference Cluster", note: "emits token/latency/cost event" },
          { label: "Kafka", note: "async event bus" },
          { label: "Usage Metering", note: "token counting → billing" },
          { label: "ClickHouse", note: "abuse review, dashboards" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "1B messages/day ≈ 12K req/s average, ~30K req/s at peak (2.5x)",
          "Avg response ~240 output tokens @ ~30 tok/s ⇒ ~8s per generation",
          "Peak concurrency = 30K req/s x 8s ≈ 250K in-flight generations",
          "~100 concurrent sequences per 8-GPU node ⇒ ~2,500 inference nodes (~20K GPUs) for the hot tier",
          "TTFT budget p99 < 1s; inter-token cadence p50 < 40ms (~25-30 tok/s)",
          "PagedAttention: 2-4x more concurrent sequences per GPU vs. naive KV allocation",
          "Moderation adds < 50ms to TTFT on the sync input check",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Continuous (in-flight) batching over static batching — GPU stays saturated instead of stalling on the slowest sequence",
          "PagedAttention-style block KV cache over naive per-sequence pre-allocation",
          "Consistent hashing on conversation_id for sticky routing — keeps the KV cache warm across turns",
          "Tiered model routing: small model for simple queries, flagship model for complex ones",
          "Layered context management: verbatim recent window + rolling summary + optional retrieval, not one strategy alone",
          "Sync classifier gates input before the expensive model; output checked incrementally while streaming",
          "Async pipeline (Kafka → usage/ClickHouse) for everything off the critical path",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Prefill is compute-bound and scales with prompt length; decode is memory-bandwidth-bound and roughly constant per token — TTFT is dominated by prefill",
          "KV cache is a GPU-HBM performance artifact, not the source of truth — losing it costs one slow re-prefill, never data",
          "GPU fleet is sized from concurrency (arrival rate x generation duration), not raw request rate",
          "Admission control (queue/shed) beats silently overpacking batches when the flagship tier saturates",
          "Sticky routing trades load-balancer flexibility for cache reuse — say why that trade is worth it",
          "GPU capacity, not request rate, is the actual bottleneck resource in this system",
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
      goal: "Get the traffic numbers, the latency targets, and the scope on the board before drawing anything.",
      why: "Every downstream decision — fleet size, batching strategy, cache sizing — falls out of these numbers. Locking them first is what separates driving the design from guessing at it.",
      steps: [
        { kind: "ASK", text: '**What\'s the traffic volume?** Walk them to "1B messages/day", land on "~12K req/s average". Write **"1B msgs/day ≈ 12K req/s avg"** on the board.' },
        { kind: "ASK", text: 'Next: **"Streaming or blocking response?"** Land on token-by-token streaming, not a single blocking call. Write **"SSE, streamed token-by-token"**.' },
        { kind: "SAY", text: 'Propose latency targets: **"TTFT p99 under 1s"**, **"streaming cadence p50 under 40ms/token"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "chat completion", "multi-turn context", "moderation", "model routing", "streaming". Out: "model training/fine-tuning", "tool-use/plugin execution", "image generation". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the concurrency math out loud: **"peak 30K req/s x ~8s per generation ≈ 250K concurrent generations"**, **"~2,500 inference nodes, ~20K GPUs, for the hot tier"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, parking out-of-scope items deliberately, and locking the latency budget before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "One streaming endpoint, one conversation-turn row, and the context-window math justified up front.",
      why: "The interviewer wants to see you commit to a small surface and connect it immediately to the context-window constraint, not treat the model as an infinite-memory black box.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoint: **"POST /conversations/:id/messages { content }"**, streams SSE events **"{ token }"** then a final **"{ done, message_id }"**. **"GET /conversations/:id"** returns history.' },
        { kind: "DRAW", text: 'Sketch the row: **"conversation_id"**, **"turn_id"**, **"role"**, **"content"**, **"created_at"**, **"token_count"**. Say: "This is the durable copy — the source of truth is here, not in any GPU cache."' },
        { kind: "SAY", text: 'Justify the context window: "the model has a fixed max token budget, say 128K; we reserve headroom for the output, so the effective input budget is smaller." Write it down.' },
        { kind: "RULE OUT", text: '"Sending the full history on every call with no limit" breaks once a conversation exceeds the window. "A stateless client that resends everything" avoids server-side state but doesn\'t solve truncation or caching. Cross both off as incomplete on their own.' },
      ],
      grading: "Crisp endpoint, a one-row schema, and connecting the schema immediately to the context-window constraint instead of treating it separately.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three flows)",
      minutes: 10,
      goal: "One diagram with three labeled paths: warm follow-up turn, cold new conversation, and async side channel.",
      why: "Drawing warm-vs-cold as separate flows is the whole point of this system: it proves you understand that the KV cache state, not the code path, is what determines latency. Candidates who draw one generic 'call the model' box miss the signature optimization.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **follow-up turn** path: Client → Gateway → Orchestrator (hash conversation_id) → Moderation → Inference (warm KV cache, only new turn prefilled) → stream tokens back. Label it **"warm cache, TTFT stays flat"**.' },
        { kind: "DRAW", text: 'Add the **new conversation** path as a separate lane: Client → Gateway → Orchestrator (assign fresh sticky node) → Moderation → Router → Inference (full prefill) → persist to Conversation Store. Label it **"cold start, full prefill"**.' },
        { kind: "DRAW", text: 'Add the **async** path off the Inference Cluster: → Kafka → Usage Metering + ClickHouse, dashed, labeled **"async, never blocks a token stream"**.' },
        { kind: "SAY", text: 'Narrate the split: "Same physical fleet, but warm vs. cold routing is the difference between flat TTFT and TTFT that grows with conversation length."' },
      ],
      grading: "Three clearly separated lanes, an explicit warm-vs-cold distinction, and a statement that async work never sits on the token stream.",
    },
    {
      n: 4,
      title: "Deep Dive: Continuous Batching and the KV Cache",
      minutes: 8,
      goal: "Explain continuous batching over static batching, PagedAttention over naive KV allocation, and sticky routing to keep the cache warm.",
      why: "This is the signature sub-problem: the interviewer is probing whether you understand why GPU serving is architecturally different from a stateless web service, and whether you can defend the two techniques that make high utilization possible.",
      steps: [
        { kind: "SAY", text: 'Explain static vs. continuous batching: "static batching pads to the longest sequence and stalls on the slowest one; continuous batching admits and evicts sequences at every decode step, keeping the GPU near saturated."' },
        { kind: "SAY", text: 'Explain PagedAttention: "naive KV allocation pre-allocates for the max sequence length and fragments memory; PagedAttention allocates fixed-size blocks on demand via a block table, like OS paging — 2-4x more concurrent sequences per GPU."' },
        { kind: "DRAW", text: 'Draw the sticky routing: **"hash(conversation_id) → node"**, note that follow-up turns reuse the warm KV cache and only prefill the new turn.' },
        { kind: "RULE OUT", text: '"Round-robin routing with no affinity" turns every turn into a cold prefill — reject. "Treating the KV cache as durable state" is wrong — it\'s GPU-HBM only, the conversation store is the real source of truth.' },
      ],
      grading: "Both techniques explained without prompting, tied explicitly to GPU utilization, and the KV-cache-vs-durable-store distinction stated clearly.",
    },
    {
      n: 5,
      title: "Deep Dive: Context Window, Routing, and Moderation",
      minutes: 7,
      goal: "Walk the layered context-management strategy, the tiered model routing, and the sync/async moderation split.",
      why: "This section shows operational maturity: the candidate connects three different 'tiering' decisions — context, model size, moderation depth — back to the same underlying principle of spending the expensive resource only where it earns its cost.",
      steps: [
        { kind: "SAY", text: 'Layer context management: "verbatim recent window for exact recall, scheduled summarization for what falls off it, optional retrieval for long-term memory — not one strategy alone."' },
        { kind: "SAY", text: 'Explain tiered routing: "a cheap classifier sends simple queries to a small model and complex ones to the flagship model, since most queries don\'t need the biggest model."' },
        { kind: "SAY", text: 'Explain moderation tiering: "a fast sync classifier gates input under 50ms, output is checked incrementally while streaming so we can abort mid-stream, and a slower deep review runs async for audit."' },
        { kind: "SAY", text: 'Tie it together: "these are the same idea three times — spend the expensive check, model, or context only where it earns its cost."' },
      ],
      grading: "All three tiering decisions covered with numbers, and the candidate naming the shared principle rather than presenting them as unrelated features.",
    },
    {
      n: 6,
      title: "Wrap: Bottlenecks, Admission Control, and Close",
      minutes: 5,
      goal: "Name GPU scarcity as the real bottleneck, cover admission control under saturation, and close with a crisp summary plus a parking-lot list.",
      why: "Staff-level signal is naming the actual constrained resource unprompted, having an answer for saturation beyond 'add more GPUs', and treating the interviewer as a collaborator through a clean close.",
      steps: [
        { kind: "SAY", text: 'State the real bottleneck: "GPU capacity, not request rate, is the constrained resource here — everything from batching to routing to sticky caching exists to protect it."' },
        { kind: "SAY", text: 'Cover saturation: "when the flagship tier saturates, we queue with a visible wait state or shed lowest-priority traffic first, instead of overpacking batches and degrading cadence for everyone already generating."' },
        { kind: "SAY", text: 'Push back where useful: "do we need a 128K context window for every request, or should the default be much smaller with retrieval covering the long tail?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "it\'s a GPU-scarce, stateful token-generation service with continuous batching, sticky KV-cache routing, and tiered model/moderation spend. With more time I\'d cover multi-region failover, tool-use/plugin execution, and fine-tuning pipelines."' },
      ],
      grading: "GPU scarcity named explicitly as the bottleneck, a concrete admission-control answer, at least one pushback on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working chat pipeline that mostly hangs together, but treats the model as an opaque black box and sizes it like a stateless web service.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Knows it's an LLM-serving system with a chat UI, streaming tokens back to the client.",
          "Adds a load balancer, an API server, and calls the model, but treats the model itself as an opaque black box.",
          "Mentions rate limiting and storing conversation history in a database.",
          "Adds a cache 'for speed' without being able to say precisely what it's caching or why it helps a generative workload.",
          "Handles moderation by bolting on a call to a safety API, without specifying sync vs. async.",
        ],
        gaps: [
          "Doesn't reason about GPU capacity at all; sizes the system like a stateless web service off request rate alone.",
          "No mention of batching, static or continuous — treats each request as fully isolated.",
          "No plan for context window overflow beyond 'just truncate'.",
          "Doesn't distinguish time-to-first-token from total generation time; treats 'latency' as one number.",
          "No session affinity story — assumes any server can serve any request equally well.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, sizes the GPU fleet from concurrency, and connects prefill/decode to latency behavior.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Sizes the GPU fleet from concurrency (arrival rate x generation duration), not raw req/sec.",
          "Explains continuous batching vs. static batching, and defends PagedAttention over naive KV pre-allocation.",
          "Splits generation into prefill and decode and connects that split to TTFT vs. streaming cadence.",
          "Proposes a layered context-management strategy (recent window + summarization) rather than a single truncation rule.",
          "Tiers the model (small vs. flagship) and moderation (sync input, async deep review).",
          "Puts async work — usage metering, abuse review — on a queue off the critical path.",
        ],
        gaps: [
          "Mentions sticky routing/session affinity only when prompted about KV cache reuse, not proactively.",
          "Doesn't quantify the failure mode of losing a KV cache (one slow re-prefill) — frames it as a data-loss risk instead.",
          "Skips admission control and load shedding under GPU saturation until asked what happens when the flagship tier fills up.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, names GPU scarcity as the real constraint unprompted, and brings operational maturity beyond the core design.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers that GPU capacity, not request rate, is the actual constrained resource, and sizes the fleet accordingly before being asked.",
          "Brings up prefill/decode disaggregation as an advanced lever for TTFT under mixed short/long-prompt traffic.",
          "Explicitly frames the KV cache as a derived performance artifact vs. the durable conversation store as the real source of truth, with the failure-mode difference.",
          "Volunteers admission control and load shedding by traffic tier as the answer to GPU saturation, not just 'add more GPUs'.",
          "Pushes back on requirements ('do we need 128K context for every request, or should the default window be smaller with retrieval for the long tail?').",
          "Closes with a crisp one-sentence summary and a named parking lot of what's out of scope.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Sizing the GPU fleet off requests/sec instead of concurrency (arrival rate x generation duration), which undercounts capacity by an order of magnitude.",
      "Treating the LLM call as a fast, stateless API call with no notion of batching, prefill/decode, or GPU scarcity.",
      "Truncating conversation history with no strategy, silently dropping facts the user stated earlier in the conversation.",
      "Running full safety/moderation review synchronously on every message with no fast/slow split, doubling latency for every request.",
      "No session affinity: routing every turn round-robin means every single message pays a full-history cold prefill.",
      "Treating the KV cache as durable state instead of a GPU-memory performance cache, and framing node failure as data loss instead of one slow re-prefill.",
      "Putting usage metering or abuse-review logging on the synchronous request path.",
    ],
    followUps: [
      {
        q: "Why does GPU capacity matter more than request rate here, compared to a typical web service?",
        a: "A typical stateless web request holds a server thread for milliseconds; a generation holds a GPU slot for seconds because it's an inherently sequential, memory-bandwidth-bound decode loop. Sizing off requests/sec the way you'd size a web tier undercounts the fleet badly — you have to size off concurrency, meaning peak arrival rate times average generation duration, because that's the number of GPU slots you actually need held open at once.",
      },
      {
        q: "What's the difference between prefill and decode, and why does it matter for TTFT?",
        a: "Prefill processes the entire prompt in one parallel forward pass and is compute-bound, with cost scaling with prompt length. Decode generates one token at a time conditioned on the growing KV cache and is memory-bandwidth-bound, with roughly constant cost per token. Time-to-first-token is dominated by prefill plus queueing, so a long, uncached prompt directly hurts TTFT, while the steady streaming cadence afterward is a decode property and stays roughly constant regardless of prompt length.",
      },
      {
        q: "How do you keep a warm KV cache across turns in a multi-node fleet?",
        a: "Consistent hash the conversation_id to pick a sticky inference node, so every turn in the same conversation lands on the node that already holds its KV cache and only needs to prefill the new turn. Consistent hashing specifically matters because it bounds how much reshuffling happens when the fleet scales up or down — only a small fraction of active conversations get remapped, not all of them. If the sticky node dies, the cache is lost, but the conversation text is durable in Postgres, so the fallback is one slow re-prefill on a new node, never data loss.",
      },
      {
        q: "What happens when the flagship model tier saturates during a traffic spike?",
        a: "The wrong answer is silently overpacking every batch, which degrades inter-token latency for every user already mid-generation, not just new arrivals, since it's a shared resource. The right answer is explicit admission control: queue new requests with a visible wait state rather than degrading existing streams, and shed the lowest-priority traffic first — free-tier or background requests — before touching paying or interactive users. Tiered routing to a smaller model for eligible queries also relieves pressure on the flagship tier directly.",
      },
      {
        q: "How would you handle a conversation that's grown past the model's context window?",
        a: "No single technique is sufficient alone. Keep the most recent K turns verbatim for exact recall, periodically summarize what falls off that window with a scheduled model call rather than every turn (to bound cost), and optionally use retrieval-augmented memory — embedding older turns into a vector store and pulling back only what's relevant — for long-term memory features. Production systems layer all three rather than picking one.",
      },
      {
        q: "Why not just run full moderation review synchronously on every message for maximum safety?",
        a: "Because the deep, accurate review model is itself expensive, and running it synchronously would add hundreds of milliseconds to every message before the flagship model even starts, doubling the cost of every request regardless of risk. Instead, tier it: a small fast classifier gates input in under 50ms, output is checked incrementally while streaming so a violation can abort mid-stream, and the slower deep review runs asynchronously afterward as the accuracy backstop for audit and abuse detection.",
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
          "This is a stateful, autoregressive token-generation service wrapped in a chat UI. Every message triggers two phases — prefill, processing the prompt in parallel, then decode, generating output tokens one at a time — streamed back over a long-lived connection. Almost everything in the design exists to protect one scarce resource: GPU capacity.",
          "Anchor everything on the numbers: about 1 billion messages a day, roughly 30K requests/sec at peak, an 8-second average generation, and a sub-1s p99 time-to-first-token. Multiplying peak rate by generation duration gives roughly 250,000 concurrent in-flight generations at peak — that concurrency figure, not the request rate, is what actually sizes the GPU fleet.",
        ],
      },
      {
        heading: "Sizing: GPUs, not requests, are the scarce resource",
        body: [
          "A stateless web request holds a thread for milliseconds; a chat generation holds a GPU slot for seconds. Sizing off requests/sec the way you would a typical service undercounts the fleet by an order of magnitude. The right approach is concurrency: peak arrival rate times average generation duration gives the number of GPU slots that must be held open simultaneously, roughly 250K at this system's scale.",
          "Dividing that by the number of concurrent sequences one inference node can hold via continuous batching — on the order of 100 per 8-GPU node — gives a fleet size in the low thousands of nodes, tens of thousands of GPUs, just for the hot decode tier. Every later decision (batching strategy, cache sizing, routing) is a consequence of protecting that fleet, not a preference.",
        ],
      },
      {
        heading: "Continuous batching and PagedAttention",
        body: [
          "Static batching pads every sequence in a batch to the length of the longest one and holds all slots hostage until the slowest sequence finishes — under real, variable-length traffic that wastes most of the GPU's time. Continuous (in-flight) batching admits and evicts sequences at every decode step instead, so the GPU stays near saturated regardless of how response lengths vary.",
          "The matching memory technique is PagedAttention: rather than pre-allocating KV cache space for the worst-case sequence length per request, which fragments memory badly, KV cache is stored in fixed-size blocks allocated on demand and tracked with a per-sequence block table, borrowing the idea of OS virtual-memory paging. Together these two techniques are what let a fleet sized for tens of thousands of concurrent sequences actually achieve high utilization instead of stalling on padding and pre-allocation waste.",
        ],
      },
      {
        heading: "Prefill vs. decode, and the KV cache as the latency lever",
        body: [
          "Prefill is compute-bound and scales with prompt length, and it dominates time-to-first-token. Decode is memory-bandwidth-bound and roughly constant per token, and it sets the steady streaming cadence. Without caching, every turn in a growing conversation re-runs prefill over the entire history, so TTFT quietly grows with conversation length even though nothing about the model has changed.",
          "The fix is to cache the KV state of the unchanged prefix and route follow-up turns back to the node holding that cache — via consistent hashing on conversation_id, which also bounds how much traffic reshuffles when the fleet scales. The cache lives only in GPU HBM, so it is a performance artifact, not the source of truth; the durable conversation store (sharded Postgres) is what actually can't be lost, and a node failure costs one slow re-prefill, never data.",
        ],
      },
      {
        heading: "Context window management",
        body: [
          "A fixed context window means long conversations must eventually be compressed. Hard truncation is cheap but lossy; rolling summarization preserves the gist at the cost of an extra model call; retrieval-augmented memory scales to long-term recall but adds a hop before every generation. None is sufficient alone, so production systems layer a verbatim recent window, a scheduled summary of what falls off it, and optional retrieval for explicit long-term memory.",
        ],
      },
      {
        heading: "Tiered spend: routing, admission control, and moderation",
        body: [
          "The same principle — spend the expensive resource only where it earns its cost — shows up three times. A router sends simple queries to a small model and complex ones to the flagship model. Moderation runs a fast synchronous classifier on input, checks output incrementally while streaming so it can abort mid-flight, and runs a slower deep review asynchronously for audit. And when the flagship tier saturates, explicit admission control — queueing with a visible wait state, or shedding the lowest-priority traffic first — protects users already mid-generation instead of silently overpacking batches and degrading everyone's cadence at once.",
        ],
      },
    ],
  },
};
