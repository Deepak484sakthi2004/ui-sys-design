import type { Problem } from "@/lib/types";

export const aiAgentRestaurant: Problem = {
  slug: "ai-agent-restaurant",
  num: "7.2",
  title: "Design AI Agent Platform for Restaurant Ops",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design an AI agent platform that answers restaurant phones and chat widgets for 50,000 restaurants, handling ~5M calls/day (peaking around 50K concurrent calls during lunch and dinner rush), taking multi-turn orders end to end, and submitting validated orders into each restaurant's POS (Toast, Square, Clover) without ever inventing a menu item, misquoting a price, or double-firing an order.",
  ],
  hardParts:
    "The hard parts: keeping the ASR→LLM→TTS turn under ~800ms so the conversation feels human, grounding every price and availability answer in live POS state so the agent never hallucinates an item that's 86'd, and gating every order mutation through a deterministic guardrail before it becomes an irreversible write to the kitchen.",
  keyTopics: [
    "Streaming ASR→LLM→TTS Pipeline",
    "RAG + Live-Lookup Menu Grounding",
    "Deterministic Guardrail Gate",
    "Tool-Calling Order Builder",
    "Exactly-Once POS Writes",
  ],
  foundationsReferenced: [
    { label: "Vector Databases (RAG)", tone: "purple" },
    { label: "Idempotency Keys", tone: "blue" },
    { label: "State Machines", tone: "blue" },
    { label: "Event-Driven Architecture", tone: "orange" },
    { label: "Multi-Tenancy", tone: "purple" },
    { label: "Circuit Breakers", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "customer", label: "Customer", sub: "phone call or chat", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "Voice/Chat Gateway", sub: "Twilio · WebSocket", col: 2, row: 1, tone: "slate" },
      { id: "asr", label: "Streaming ASR", sub: "partial transcripts <300ms", col: 3, row: 1, tone: "green" },
      { id: "tts", label: "Streaming TTS", sub: "sentence-chunked, barge-in aware", col: 4, row: 1, tone: "green" },
      { id: "menurag", label: "Menu RAG", sub: "per-tenant vector index", col: 2, row: 2, tone: "purple" },
      {
        id: "orchestrator",
        label: "Agent Orchestrator",
        sub: "LLM + tool-calling",
        mono: "per-session state machine",
        col: 3,
        row: 2,
        tone: "purple",
      },
      {
        id: "guardrail",
        label: "Guardrail Service",
        sub: "price/stock/modifier checks",
        mono: "deterministic, outside the LLM loop",
        col: 4,
        row: 2,
        tone: "orange",
      },
      { id: "posadapter", label: "POS Adapter", sub: "Toast / Square / Clover", col: 5, row: 2, tone: "blue" },
      { id: "sessionstore", label: "Session Store", sub: "Redis · conversation + order state", col: 3, row: 3, tone: "blue" },
      {
        id: "menustore",
        label: "Live Menu Store",
        sub: "POS-mirrored price & stock",
        mono: "authoritative · <60s freshness",
        col: 5,
        row: 3,
        tone: "blue",
      },
      { id: "eventbus", label: "Kafka", sub: "turn + tool-call events", col: 2, row: 4, tone: "orange" },
      { id: "evalpipeline", label: "Eval Pipeline", sub: "transcript replay & scoring", col: 4, row: 4, tone: "orange" },
    ],
    edges: [
      { from: "customer", to: "gateway", label: "audio / text in", kind: "read" },
      { from: "gateway", to: "asr", label: "audio stream", kind: "read" },
      { from: "asr", to: "orchestrator", label: "partial + final transcript", kind: "read" },
      { from: "orchestrator", to: "menurag", label: "semantic grounding lookup", kind: "read" },
      { from: "orchestrator", to: "menustore", label: "live price/stock lookup", kind: "read" },
      { from: "orchestrator", to: "sessionstore", label: "load/save turn state", kind: "read" },
      { from: "orchestrator", to: "tts", label: "response tokens, streamed", kind: "read" },
      { from: "tts", to: "gateway", label: "audio out", kind: "read" },
      { from: "gateway", to: "customer", label: "spoken response", kind: "read" },
      { from: "orchestrator", to: "guardrail", label: "propose order action", kind: "write" },
      { from: "guardrail", to: "menustore", label: "re-verify price/stock/modifiers", kind: "write" },
      { from: "guardrail", to: "posadapter", label: "validated order · idempotency key", kind: "write" },
      { from: "posadapter", to: "menustore", label: "POS webhook · menu sync, <60s", kind: "analytics" },
      { from: "menustore", to: "menurag", label: "re-embed & index", kind: "analytics" },
      { from: "orchestrator", to: "eventbus", label: "turn + tool-call events, async", kind: "analytics" },
      { from: "eventbus", to: "evalpipeline", label: "replay & scoring", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "conversation path · ASR→LLM→TTS, sub-800ms turn" },
      { kind: "write", text: "order path · guardrail-gated writes to the POS" },
      { kind: "analytics", text: "async · menu sync, transcripts, evals, never blocks a turn" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["customer", "gateway", "orchestrator"],
      say: "Start with the skeleton: a customer talks to a gateway, and one orchestrator holds the conversation. Everything else in this design exists to make that middle box fast, grounded, and safe.",
    },
    {
      reveal: ["asr", "tts"],
      say: "Speech has to stream in both directions — ASR emits partial transcripts under 300ms so the orchestrator can start reasoning before the caller finishes talking, and TTS starts speaking on the first generated sentence instead of waiting for the full reply. That's how we hit sub-800ms p95 turn latency.",
    },
    {
      reveal: ["menurag", "menustore"],
      say: "Menu truth is two lookups, not one: RAG resolves 'something spicy' to a real item by semantic search, but only the Live Menu Store — synced from the POS in under 60 seconds — has the authoritative price and stock at this exact second.",
    },
    {
      reveal: ["guardrail", "posadapter"],
      say: "The orchestrator never writes to the POS directly. It proposes an order action; the Guardrail Service re-checks price, stock, and totals against the Live Menu Store; only a validated action reaches the POS Adapter with an idempotency key, so a dropped call can't double-fire a ticket.",
    },
    {
      reveal: ["sessionstore", "eventbus", "evalpipeline"],
      say: "Round it out with state and observability: Redis holds per-session conversation and order state across turns, and every turn and tool call is dropped onto Kafka for an eval pipeline to replay and score — asynchronously, so it never adds a millisecond to a live call.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Take phone orders end to end via a voice agent (ASR + LLM + TTS) with natural multi-turn conversation", tag: "P0" },
      { id: "FR-02", text: "Take chat/app orders through the same agent brain and tool set used for voice", tag: "P0" },
      { id: "FR-03", text: "Ground every menu, price, and availability answer in the tenant's live menu; never invent an item or price", tag: "P0" },
      { id: "FR-04", text: "Build an order incrementally across turns (add, remove, modify items) and confirm the final order back to the caller", tag: "P0" },
      { id: "FR-05", text: "Submit a validated order to the restaurant's POS (Toast/Square/Clover) exactly once, even under call drops or retries", tag: "P0" },
      { id: "FR-06", text: "Support tool-calling for order status, loyalty balance, hours/location, and upsell suggestions", tag: "P0" },
      { id: "FR-07", text: "Detect low-confidence, out-of-scope, or upset-customer situations and hand off to a human line", tag: "P0" },
      { id: "FR-08", text: "Support barge-in: the caller can interrupt agent speech mid-sentence and be heard immediately", tag: "P1" },
      { id: "FR-09", text: "Isolate configuration per tenant: menu, voice persona, upsell rules, business hours, POS credentials", tag: "P0" },
      { id: "FR-10", text: "Log full transcripts and tool-call traces for QA, dispute resolution, and compliance", tag: "P1" },
      { id: "FR-11", text: "Let restaurant admins A/B test prompt or model changes against replayed transcripts before rollout", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Voice turn latency, end of caller speech to start of agent audio", tag: "p95 < 800ms" },
      { id: "NFR-02", text: "ASR partial-transcript latency", tag: "< 300ms" },
      { id: "NFR-03", text: "Concurrent active calls, platform-wide peak (lunch/dinner rush)", tag: "50K concurrent" },
      { id: "NFR-04", text: "Order delivery to the POS", tag: "exactly-once" },
      { id: "NFR-05", text: "Bad orders reaching the POS (wrong price, item, or stock state)", tag: "~0 tolerance" },
      { id: "NFR-06", text: "Menu index freshness after a POS-side price/availability change", tag: "< 60s" },
      { id: "NFR-07", text: "Platform availability", tag: "99.95%" },
      { id: "NFR-08", text: "Fully-loaded cost per completed order (ASR + LLM + TTS)", tag: "< $0.15" },
      { id: "NFR-09", text: "Tenant data isolation: menu, prompt, and order data never cross tenants", tag: "hard multi-tenant" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: what number actually drives capacity?",
      body: [
        "5M calls/day sounds like the headline number, but capacity is driven by concurrency, not daily volume. If you naively spread 5M calls of ~90s each across a full day, you get a comfortable-looking average — and it's the wrong number to build against, because restaurant call volume is brutally concentrated in two windows: lunch and dinner.",
      ],
      bullets: [
        { lead: "Naive uniform spread", text: "5M calls × 90s ÷ 86,400s/day ≈ 5,200 average concurrent calls. Looks easy. It is not the number that will page you." },
        { lead: "Rush-hour concentration", text: "if ~60% of daily volume lands in a combined 7-hour lunch+dinner window, that's 0.6 × 450M call-seconds ÷ 25,200s ≈ 10,700 average concurrent during rush." },
        { lead: "Peak within rush", text: "the single busiest 15 minutes inside rush can run 3-5× the rush average, putting the real peak around 40-50K concurrent calls — the number every downstream service must be provisioned for." },
      ],
      pictureTitle: "Does the platform fit inside the concurrency budget?",
      pictureRows: [
        { label: "Naive uniform-spread math", value: "~5.2K avg concurrent — dangerously optimistic", tone: "bad" },
        { label: "Rush-hour concentration (~60% of volume, 7hrs)", value: "~10.7K avg concurrent during rush", tone: "neutral" },
        { label: "Peak-within-rush burst (3-5×)", value: "~40-50K concurrent — the real design target", tone: "good" },
      ],
      remember: {
        problem: "Size the platform before picking any component.",
        solution: "5M calls/day platform-wide, but concentrated in lunch/dinner rush ⇒ ~50K peak concurrent calls is the real design number, not the daily average.",
        why: "Concurrency, not daily volume, determines gateway/ASR/LLM/TTS capacity — a system sized to the average silently falls over at 7pm.",
        tradeoff: "Provisioning for peak means paying for idle capacity most of the day.",
        failure: "Sizing off the daily average (~5-10K avg) leaves the platform ~5× under-provisioned exactly when restaurants need it most.",
        mitigation: "Autoscale on concurrent-call count with headroom, and load-shed to human handoff before ASR/LLM queues back up.",
      },
    },
    {
      n: 2,
      title: "The streaming voice pipeline: where does 800ms go?",
      body: [
        "Human conversational turn-taking gaps average roughly 700-800ms; that is the bar the agent has to clear to feel like a person and not a robot on hold music. Hit that bar only by streaming every stage of the pipeline — never batch a full request/response anywhere on the hot path.",
      ],
      bullets: [
        { lead: "ASR", text: "streams partial transcripts as the caller speaks, under 300ms, so the orchestrator can start reasoning before the caller finishes the sentence." },
        { lead: "Endpointing (VAD)", text: "a silence threshold of ~200-300ms decides the caller is done talking. Too short and you cut people off mid-thought; too long and you add dead air to every turn." },
        { lead: "LLM time-to-first-token", text: "150-300ms with streaming output, not a wait for the full completion — the model can start committing to an opening phrase before it has generated the whole reply." },
        { lead: "TTS time-to-first-audio-byte", text: "~150-200ms, driven by sentence-boundary chunking: synthesize and start playing the first sentence while the LLM is still generating the second." },
      ],
      pictureTitle: "Where does the 800ms go?",
      pictureRows: [
        { label: "ASR partial transcript", value: "< 300ms, streaming word-by-word", tone: "good" },
        { label: "Endpointing (VAD silence threshold)", value: "~200-300ms", tone: "neutral" },
        { label: "LLM time-to-first-token", value: "~150-300ms, streamed", tone: "good" },
        { label: "TTS time-to-first-audio-byte", value: "~150-200ms, sentence-chunked", tone: "good" },
        { label: "Wait for the full LLM completion first", value: "adds 1-3s, blows the budget", tone: "bad" },
      ],
      remember: {
        problem: "Keep a voice turn feeling human, not robotic.",
        solution: "Stream every stage — partial ASR transcripts, first-token LLM output, sentence-chunked TTS — so no stage waits for the previous one to fully finish.",
        why: "Human conversational turn-taking gaps average ~700-800ms; batching any single stage blows the whole budget even if every other stage is fast.",
        tradeoff: "Streaming everything adds engineering complexity (partial-result handling, mid-stream cancellation) over a simple request/response call.",
        failure: "A synchronous 'wait for full completion, then speak' pipeline adds 1-3s of dead air, and callers hang up or talk over the agent.",
        mitigation: "Sentence-boundary chunking for TTS input and cancellable streams at every stage so a barge-in can stop mid-utterance.",
      },
    },
    {
      n: 3,
      title: "Grounding: where menu truth actually comes from",
      body: [
        "The agent will be asked things like \"what's spicy?\" and \"how much is the large with extra cheese?\" in the same breath. Those are two different problems — semantic discovery and authoritative fact lookup — and conflating them is exactly how you get a confidently wrong price.",
      ],
      bullets: [
        { lead: "Prompt-stuff the whole menu", text: "works for a 30-item menu, falls apart once you're at 50,000 tenants with 100-300 items and dozens of modifiers each — token cost and context-window pressure make it a non-starter at platform scale." },
        { lead: "RAG only", text: "a per-tenant vector index is great for \"something spicy\" style discovery, but embeddings are semantic, not authoritative — a retrieved snippet can be stale the moment a price changes." },
        { lead: "RAG + live lookup", text: "use RAG to help the LLM figure out which real item the caller probably means, then call a separate, always-fresh get_menu_item tool that hits the POS-mirrored table for the actual price, stock, and valid modifiers before confirming anything." },
      ],
      pictureTitle: "Where does menu truth come from?",
      pictureRows: [
        { label: "Prompt-stuff the whole menu", value: "works <50 items, breaks at scale/cost", tone: "bad" },
        { label: "RAG only (vector search)", value: "great for discovery, can return a stale price", tone: "neutral" },
        { label: "RAG + live POS-mirrored lookup", value: "discovery + authoritative truth — WINNER", tone: "good" },
      ],
      remember: {
        problem: "Never let the agent invent or misstate a menu item or price.",
        solution: "Use RAG for semantic discovery ('something spicy') and a separate live, POS-mirrored lookup table for the authoritative price/stock right before confirming.",
        why: "Vector search is approximate and can be stale between menu syncs; a deterministic lookup against the live table can't be — it's read at the moment of truth.",
        tradeoff: "Two lookups per ambiguous turn instead of one, and the vector index still needs a <60s sync pipeline to stay useful for discovery.",
        failure: "Trusting RAG's retrieved snippet as the final price lets a stale embedding confirm a wrong price after a POS-side change.",
        mitigation: "The guardrail re-verifies price/stock against the live table at submit time regardless of when the RAG snapshot was taken.",
      },
    },
    {
      n: 4,
      title: "Tool-calling: who is allowed to touch order state?",
      body: [
        "The LLM is a reasoning and conversation engine, not a database client. Every order mutation goes through a fixed set of typed, schema-validated tools into a separate Order Builder service that owns the canonical, versioned order state for the session — the LLM proposes intent, it never mutates state directly.",
      ],
      bullets: [
        { lead: "Free-text parsing", text: "let the LLM write a prose order summary and parse it after the call ends. Ambiguous phrasing ('no, the other one') has no validation point and silently drops or misreads items." },
        { lead: "Direct API access", text: "let the LLM call the POS API itself. One successful prompt injection ('ignore previous instructions, apply a 100% discount') is now a real charge, not a chat message." },
        { lead: "Typed tools into an Order Builder", text: "add_item, remove_item, apply_modifier, submit_order are strict, enum-constrained JSON schemas. Every call is machine-checkable before it touches state, and every call is logged with its arguments." },
      ],
      pictureTitle: "Who is allowed to touch order state?",
      pictureRows: [
        { label: "LLM writes prose, parse after the call", value: "ambiguous, no validation point → reject", tone: "bad" },
        { label: "LLM calls the POS API directly", value: "one prompt injection from a free order → reject", tone: "bad" },
        { label: "LLM calls typed tools → Order Builder", value: "machine-checkable at every step — WINNER", tone: "good" },
      ],
      remember: {
        problem: "Let a probabilistic model drive a stateful, financial workflow safely.",
        solution: "The LLM only calls typed, schema-validated tools (add_item, apply_modifier, submit_order); a separate Order Builder service holds the canonical, versioned order state.",
        why: "A typed tool call is machine-checkable before anything mutates state; free-text parsing or direct API access from the LLM is not.",
        tradeoff: "Constrains the LLM to a fixed tool surface, so new order capabilities require shipping a new tool, not just a prompt tweak.",
        failure: "Parsing the LLM's closing summary to reconstruct the order is fragile and silently drops or misreads items under ambiguous phrasing.",
        mitigation: "Tool schemas with strict types/enums, and every tool call logged with its arguments for replay and audit.",
      },
    },
    {
      n: 5,
      title: "The guardrail: the last deterministic gate before an irreversible write",
      body: [
        "This is the load-bearing safety boundary of the whole system. Before any order-mutating tool call reaches the POS, it passes through a deterministic rules engine that lives entirely outside the LLM's probabilistic loop — its job is to catch exactly the failures a language model can't be trusted to catch about itself.",
      ],
      bullets: [
        { lead: "Stock check", text: "is this item actually available right now, against live inventory, not a cached or RAG-retrieved snapshot." },
        { lead: "Price check", text: "does the proposed line-item price match the live menu at this exact moment, not what the LLM remembers saying two turns ago." },
        { lead: "Modifier and total bounds", text: "is the modifier combination valid, and is the order total within anomaly bounds — this is what stops a runaway comp or an injected 100% discount." },
        { lead: "Reject and re-prompt", text: "a rejected action returns a structured error to the orchestrator, which re-prompts the caller ('that item's out of stock right now, want to swap it?') instead of failing silently or retrying blindly." },
      ],
      pictureTitle: "The last gate before an irreversible write",
      pictureRows: [
        { label: "Item in stock right now", value: "checked against live inventory, not cache", tone: "good" },
        { label: "Price matches the live menu", value: "not the RAG snapshot, not the LLM's memory", tone: "good" },
        { label: "Total within anomaly bounds", value: "blocks runaway comps/discounts", tone: "good" },
        { label: "LLM self-check ('I verified it')", value: "not a safety boundary → reject", tone: "bad" },
      ],
      remember: {
        problem: "Guarantee a bad order (wrong price, out-of-stock item, unauthorized discount) never reaches the kitchen.",
        solution: "A deterministic Guardrail Service sits between the orchestrator's proposed action and the POS write, re-validating stock, price, modifiers, and totals against live state.",
        why: "The orchestrator is a probabilistic model; the boundary that decides what becomes real has to be deterministic and outside that loop.",
        tradeoff: "Adds a synchronous hop, and ~2-5% of proposed actions get rejected and re-prompted, to every order-mutating turn.",
        failure: "Skipping the guardrail and trusting the LLM's own verification lets a prompt injection or a stale RAG price turn into a real charge or a kitchen ticket.",
        mitigation: "Guardrail rejections return a structured error to the orchestrator, which re-prompts the caller instead of failing silently.",
      },
    },
    {
      n: 6,
      title: "Barge-in: handling an interruption mid-sentence",
      body: [
        "Natural conversation is duplex, not walkie-talkie. A caller who can't interrupt a rambling agent either hangs up or shouts over it — so the mic has to keep streaming to ASR even while TTS is playing, and the session needs an explicit state machine to make interruption a clean transition instead of a race condition.",
      ],
      bullets: [
        { lead: "Listening", text: "mic audio streams continuously to ASR/VAD, whether or not the agent is currently speaking." },
        { lead: "Speaking", text: "TTS is playing the agent's response, but the mic stream to ASR/VAD never pauses." },
        { lead: "Interrupted", text: "VAD detects speech during playback, the orchestrator cancels the TTS stream mid-utterance and flushes the remaining buffered audio, and the state machine moves back to Listening." },
        { lead: "What did the agent actually say?", text: "the session tracks the truncated utterance, not the full generated response, so downstream context reflects what the caller actually heard." },
      ],
      pictureTitle: "Handling an interruption mid-sentence",
      pictureRows: [
        { label: "Listening", value: "mic streaming to ASR/VAD", tone: "neutral" },
        { label: "Speaking", value: "TTS playing, mic still streaming", tone: "neutral" },
        { label: "VAD detects speech during playback", value: "cancel TTS mid-stream, flush buffer", tone: "good" },
        { label: "Strict turn-by-turn (no barge-in)", value: "feels like a walkie-talkie → reject", tone: "bad" },
      ],
      remember: {
        problem: "Let a caller interrupt the agent the way they'd interrupt a human.",
        solution: "Keep the mic streaming to ASR/VAD even while TTS is playing; on detected speech, cancel the TTS stream and move the session state machine from Speaking to Listening.",
        why: "Natural conversation is duplex, not walkie-talkie; a caller who can't interrupt a rambling bot hangs up or shouts over it.",
        tradeoff: "Requires cancellable, mid-stream TTS and careful handling of 'what did the agent actually finish saying' when stitching context.",
        failure: "A strict turn-by-turn pipeline that only listens after it stops speaking makes the agent feel unresponsive and gets talked over anyway, just messily.",
        mitigation: "Explicit per-session state machine (Listening/Speaking/Interrupted) so a barge-in is a clean state transition.",
      },
    },
    {
      n: 7,
      title: "Exactly-once writes: the call drops right as the order submits",
      body: [
        "Phone calls drop. Networks retry. Both can happen at the exact moment an order-submission tool call fires, and the failure mode isn't cosmetic — a duplicate submission is a duplicate kitchen ticket and, often, a duplicate charge.",
      ],
      bullets: [
        { lead: "Idempotency key", text: "derived deterministically from session_id + order_version, so a retried submit_order call with the same key is a safe no-op if the first attempt already succeeded." },
        { lead: "Confirm only after real success", text: "the agent tells the caller the order is confirmed only after the POS adapter gets an actual success response — never optimistically, before the write has landed." },
        { lead: "POS outage handling", text: "if the POS is unreachable, the guardrail-validated order goes into a durable outbox with retry and backoff, and the agent gives an honest, non-committal response instead of a false confirmation." },
        { lead: "Circuit breaker to human handoff", text: "if the POS stays down past a threshold, new calls for that tenant route straight to a human line rather than stacking up retries behind a dead integration." },
      ],
      pictureTitle: "The call drops right as the order submits — now what?",
      pictureRows: [
        { label: "No idempotency key", value: "retry can double-fire the order", tone: "bad" },
        { label: "Idempotency key = hash(session_id, order_version)", value: "retry is a safe no-op", tone: "good" },
        { label: "Confirm to caller before POS success", value: "over-promises a write that hasn't landed", tone: "bad" },
        { label: "Confirm only after POS success", value: "honest, matches reality", tone: "good" },
      ],
      remember: {
        problem: "A phone call can drop or retry at the exact moment an order is submitted.",
        solution: "Idempotency key derived from session_id + order_version; the POS adapter treats a retried submit with the same key as a no-op if it already succeeded.",
        why: "Telephony and POS APIs both fail independently of each other; without a dedup key, a network retry becomes a duplicate kitchen ticket and a duplicate charge.",
        tradeoff: "Requires durable tracking of in-flight and completed order versions per session, not just fire-and-forget calls.",
        failure: "Confirming the order to the caller before the POS adapter gets a real success response can tell someone their food is coming when it never reached the kitchen.",
        mitigation: "Only speak the confirmation after a real POS success; on POS outage, queue with retry/backoff and trip a circuit breaker to human handoff.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a real-time conversational agent wired to a restaurant's POS: ASR turns speech into text, an LLM decides what to say and which tools to call, TTS speaks the reply, and every order mutation is gated by a deterministic guardrail before it touches the POS.",
      "Latency is the product: humans expect a reply within ~800ms, so every stage streams — partial transcripts, first-token LLM output, sentence-chunked TTS — instead of waiting for full completions.",
      "The LLM never talks to the database. It calls typed tools; a separate Order Builder holds canonical order state, and a Guardrail Service is the last deterministic check before an irreversible POS write.",
      "Menu truth comes from two places: RAG for semantic discovery ('something spicy'), and a live, POS-mirrored lookup for the authoritative price and stock right before you confirm — RAG alone can go stale.",
      "Analytics, evals, and transcript logging run async off Kafka so a slow eval pipeline never adds a millisecond to a live call.",
    ],
    flows: [
      {
        kind: "read",
        title: "CONVERSATION TURN · SUB-800MS P95",
        summary:
          "Every stage streams. The orchestrator starts reasoning on partial transcripts, starts speaking before its full response is generated, and the caller can interrupt at any point.",
        steps: [
          { label: "Customer", note: "speaks or types" },
          { label: "Gateway", note: "streams audio/text in" },
          { label: "Streaming ASR", note: "partial transcripts, <300ms" },
          { label: "Agent Orchestrator", note: "reasons, may call Menu RAG or the Live Menu Store" },
          { label: "Streaming TTS", note: "sentence-chunked, first byte ~150-200ms" },
          { label: "Gateway", note: "plays audio out" },
          { label: "Customer", note: "hears the reply, can barge in" },
        ],
      },
      {
        kind: "write",
        title: "ORDER SUBMISSION · GUARDRAIL-GATED",
        summary:
          "The LLM never writes to the POS. It proposes a tool call; a deterministic guardrail re-checks price, stock, and totals against live state before the POS adapter submits with an idempotency key.",
        steps: [
          { label: "Agent Orchestrator", note: "proposes submit_order" },
          { label: "Guardrail Service", note: "re-checks price/stock/modifiers/totals against the Live Menu Store" },
          { label: "POS Adapter", note: "submits with idempotency key" },
          { label: "POS", note: "returns real success" },
          { label: "Agent Orchestrator", note: "confirms to the caller — only now" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC: TRANSCRIPTS, EVALS, COST",
        summary:
          "Every turn and tool call is emitted as an event and never blocks the live conversation. A separate pipeline replays and scores transcripts for QA and prompt/model rollout gating.",
        steps: [
          { label: "Agent Orchestrator", note: "emits turn + tool-call event" },
          { label: "Kafka", note: "async, decoupled from the call" },
          { label: "Eval Pipeline", note: "replay & scoring" },
          { label: "Analytics Warehouse", note: "dashboards, cost per order" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "50K restaurants, ~5M calls/day platform-wide, avg call ~90s",
          "Peak concurrency ~40-50K simultaneous calls during lunch/dinner rush",
          "Turn latency budget: p95 < 800ms, end of speech to start of agent audio",
          "ASR partial transcripts < 300ms, TTS first-audio-byte ~150-200ms",
          "Guardrail rejects ~2-5% of proposed order actions",
          "Menu index refreshed < 60s after a POS-side price/86 change",
          "Cost per completed order (ASR+LLM+TTS) target < $0.15",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Cascaded ASR→LLM→TTS pipeline, not a single speech-to-speech model, to keep tool-calling and guardrails in the loop",
          "LLM never writes state directly — typed tool calls into an Order Builder service",
          "Guardrail Service is a deterministic rules engine, separate from the LLM, gating every irreversible write",
          "RAG for semantic menu discovery + a live POS-mirrored lookup for authoritative price/stock",
          "Idempotency key = hash(session_id, order_version) so a dropped call never double-submits",
          "Duplex audio streaming with VAD-driven barge-in and an explicit per-session state machine",
          "Per-tenant config isolation: menu, prompt, voice persona, POS credentials namespaced by tenant_id",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Latency is the product for voice — human conversational turn-taking gap is ~700-800ms, so streaming end-to-end is non-negotiable",
          "The LLM proposes, the guardrail disposes — never trust a probabilistic model with an irreversible write",
          "RAG alone can hallucinate a stale price; always re-verify against live POS state before confirming",
          "Exactly-once order submission across a flaky phone line is a distributed-systems problem, not a prompt-engineering one",
          "Human handoff is a first-class feature, not a fallback bolt-on — low-confidence and upset-caller detection must trigger it",
          "Multi-tenant isolation must be hard, not just filtered — one tenant's prompt/menu must never leak into another's context",
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
      goal: "Lock the channels, the scale, and the latency budget before drawing anything — every later decision (pipeline shape, guardrail placement, cost model) falls out of these numbers.",
      why: "The interviewer is checking whether you drive this design from a conversational-UX constraint (latency feels human or it doesn't) plus a safety constraint (money moves), not from a generic microservices template.",
      steps: [
        { kind: "ASK", text: '**Is this voice-only, or chat too?** Land on "both channels, one shared orchestrator." Write **"voice + chat, shared agent brain"** in the top-left corner.' },
        { kind: "ASK", text: '**How many restaurants, and what\'s the call volume?** Land on "50K restaurants, ~5M calls/day platform-wide." Write it down.' },
        { kind: "SAY", text: 'Propose the latency target yourself: **"p95 < 800ms, end of caller speech to start of agent audio"** — the threshold where a conversation stops feeling human. Wait for a nod.' },
        { kind: "SAY", text: 'State scope. In: "voice/chat ordering, tool-calling, POS submission, guardrails, human handoff." Out: "payment processing internals, kitchen display routing, menu content authoring UI." "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the concurrency math out loud: **"5M calls/day, ~90s avg, ~60% concentrated in a 7hr lunch+dinner window ⇒ ~10.7K avg concurrent during rush, ~40-50K peak within rush."** Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, parking out-of-scope items deliberately, and locking the latency budget before drawing any boxes?",
    },
    {
      n: 2,
      title: "Interaction Model and Data Model",
      minutes: 5,
      goal: "A small, typed tool surface and a clean session/order model, with the alternatives ruled out before they get suggested.",
      why: "The interviewer wants to see you commit to a constrained, machine-checkable surface instead of letting the LLM freely read and write state — that discipline is the difference between a chat demo and a system that can safely move money.",
      steps: [
        { kind: "WRITE", text: 'Write the core objects: **"Session (per call/chat)"**, **"Order (line items, modifiers, status, version)"**, **"MenuItem (tenant-scoped, POS-mirrored)"**.' },
        { kind: "DRAW", text: 'Sketch the tool surface: **"get_menu_item"**, **"add_item"**, **"remove_item"**, **"apply_modifier"**, **"submit_order"**, **"get_order_status"**, **"escalate_to_human"**. Say: "Every one of these is a strict, typed JSON schema, not free text."' },
        { kind: "SAY", text: 'Justify it: "The LLM\'s output has to be machine-checkable before anything touches state — a typed tool call is; a prose sentence isn\'t."' },
        { kind: "RULE OUT", text: '"Parse the LLM\'s closing summary into an order" — ambiguous phrasing has no validation point. "Let the LLM call the POS API directly" — one prompt injection away from a free order. Cross both off.' },
      ],
      grading: "Crisp, typed tool names, a clear session/order model, and the free-text and direct-API-access alternatives ruled out with a reason, not just dismissed.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: conversation, order, and async/eval. Label the arrows with latency budgets and traffic shares, not box names.",
      why: "Drawing conversation, order, and async as separate lanes proves you understand they have different latency and durability requirements. Candidates who draw one blob miss that a slow eval pipeline must never add latency to a live call, and that order writes need a safety gate the conversation path doesn't.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **conversation lane**: Customer → Gateway → Streaming ASR → Orchestrator → Streaming TTS → Gateway → Customer. Label arrows **"<300ms partial transcript"**, **"streamed tokens"**, **"~150-200ms first audio byte"**.' },
        { kind: "DRAW", text: 'Add the **order lane**: Orchestrator → Guardrail Service (checks the Live Menu Store) → POS Adapter, labeled **"guardrail-gated · idempotency key"**.' },
        { kind: "DRAW", text: 'Add the **async lane**: Orchestrator → Kafka → Eval Pipeline, dashed, labeled **"never blocks a live turn"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different SLAs — conversation is latency-critical tier-1, order writes are safety-critical tier-2, analytics and evals are best-effort tier-3."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with latency budgets, and an explicit statement that the guardrail sits between the orchestrator and any irreversible write.",
    },
    {
      n: 4,
      title: "Deep Dive: Streaming Voice Pipeline and Barge-In",
      minutes: 8,
      goal: "Break down where the 800ms budget actually goes, and show how barge-in works without turning into a race condition.",
      why: "This is the signature latency sub-problem. The interviewer is probing whether you understand that streaming has to happen at every stage — not just 'use a fast model' — and whether you've thought through the duplex-audio mechanics of an interruption.",
      steps: [
        { kind: "SAY", text: 'Break down the budget: "ASR partial transcripts <300ms, endpointing ~200-300ms, LLM time-to-first-token ~150-300ms streamed, TTS first-audio-byte ~150-200ms via sentence-chunking." Each number adds up toward 800ms.' },
        { kind: "DRAW", text: 'Draw the cascaded pipeline and note the alternative: "A single speech-to-speech model can be lower-latency, but today it\'s harder to insert reliable tool-calling and a deterministic guardrail into that loop — I\'m trading a bit of latency for auditability and safety."' },
        { kind: "SAY", text: 'Explain barge-in: "The mic keeps streaming to ASR/VAD even while TTS plays. If VAD detects speech during playback, cancel the TTS stream mid-utterance and move the session state machine from Speaking to Listening."' },
        { kind: "RULE OUT", text: '"Wait for the full LLM completion before speaking" — kills the budget. "Strict turn-by-turn, no barge-in" — feels like a walkie-talkie, callers talk over it anyway.' },
      ],
      grading: "The latency budget broken down stage by stage with numbers, barge-in explained as a state-machine transition (not hand-waved), and a clear reason for choosing cascade over speech-to-speech.",
    },
    {
      n: 5,
      title: "Deep Dive: Grounding and the Guardrail",
      minutes: 7,
      goal: "Explain the two-source-of-truth model for the menu, and volunteer the guardrail as the deterministic safety boundary before being asked about failure modes.",
      why: "Anyone can say 'add RAG.' The interviewer wants to hear that RAG alone is not enough, and — for the top score — the candidate naming 'the LLM proposes, the guardrail disposes' as the core safety invariant, unprompted.",
      steps: [
        { kind: "SAY", text: 'Explain the split: "RAG handles semantic discovery — \'something spicy\' — but it can return a stale price. Before confirming anything, I call a separate get_menu_item tool against the live, POS-mirrored table for the authoritative price and stock."' },
        { kind: "SAY", text: 'Introduce the guardrail unprompted: "Before any order-mutating tool call reaches the POS, a deterministic Guardrail Service re-checks stock, price, modifiers, and total bounds — outside the LLM\'s probabilistic loop."' },
        { kind: "DRAW", text: 'Draw the chain: Orchestrator proposes → Guardrail validates against the Live Menu Store → POS Adapter writes → confirmation only after real POS success.' },
        { kind: "RULE OUT", text: '"Trust the LLM\'s own self-check" — a probabilistic model verifying itself isn\'t a safety boundary. Cross it off.' },
      ],
      grading: "Two-source grounding explained without prompting, the guardrail framed as the safety invariant of the whole system, and the self-verification alternative explicitly rejected.",
    },
    {
      n: 6,
      title: "Wrap: Reliability, Handoff, and Close",
      minutes: 5,
      goal: "Name the SLA tiers, the exactly-once story, human handoff, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: idempotent writes treated as a distributed-systems problem (not a prompt trick), human handoff framed as a first-class path, and a clean close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: 'State the exactly-once story: "Idempotency key = hash(session_id, order_version). A dropped call and a client retry hit the same key, so the POS adapter treats the retry as a no-op if it already succeeded."' },
        { kind: "SAY", text: 'Bring up human handoff unprompted: "Low-confidence or upset-caller signals trigger escalation to a live line. It\'s a first-class path, not an afterthought — an agent with no escape hatch is a red flag."' },
        { kind: "SAY", text: 'Push back where useful: "Does chat need the same 800ms budget as voice, or is that a voice-only constraint since there\'s no turn-taking pressure in a chat UI?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a real-time tool-calling agent with a deterministic guardrail between it and the POS. With more time I\'d cover payment tokenization, kitchen display integration, and shadow-eval gating for prompt/model rollout."' },
      ],
      grading: "Explicit exactly-once mechanism, human handoff framed as first-class, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working agent design that mostly hangs together, but treats the LLM as trustworthy by default and doesn't quantify latency or cost.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: ASR, LLM, TTS, a database, maybe a queue.",
          "Knows to use function/tool calling instead of parsing free text.",
          "Adds a vector DB 'for RAG' when prompted about menu grounding.",
          "Mentions a queue for logging or analytics.",
          "Can sketch a basic order flow: caller → agent → POS.",
        ],
        gaps: [
          "Doesn't quantify the latency budget across ASR/LLM/TTS stages; says 'make it fast' without numbers.",
          "Lets the LLM call the POS or database directly, with no deterministic guardrail layer.",
          "No idempotency story — assumes the order submission always succeeds exactly once.",
          "Multi-tenant isolation is an afterthought, mentioned only if asked.",
          "No plan for barge-in or interruption; assumes a strict turn-by-turn walkie-talkie model.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, quantifies the latency budget, separates the LLM from state mutation, and names the guardrail explicitly.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes concurrency, latency, and cost targets on the board within the first 5 minutes.",
          "Separates the LLM (proposes) from a deterministic Order Builder + Guardrail (disposes).",
          "Explains RAG for discovery vs. a live lookup for authoritative price/stock.",
          "Designs idempotent order submission with a session-scoped idempotency key.",
          "Handles barge-in with duplex audio streaming and an explicit state machine.",
          "Names human handoff as a required path, not a nice-to-have.",
          "Separates conversation/order/analytics into different latency and durability tiers.",
        ],
        gaps: [
          "Volunteers the guardrail's reject numbers only after being asked 'what if the LLM tries something bad'.",
          "Doesn't bring up cost-per-order until prompted.",
          "Treats eval/observability as an afterthought rather than a rollout gate for prompt changes.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats the guardrail as the load-bearing safety boundary, and brings operational maturity around prompt rollout, cost, and human handoff.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers unprompted that 'the LLM proposes, the guardrail disposes' and frames it as the core safety invariant of the whole system.",
          "Quantifies the failure mode of skipping the guardrail — a stale RAG price or a prompt-injected discount reaching the POS.",
          "Brings up shadow evals and replayed transcripts as the gate for shipping a new prompt or model version, unprompted.",
          "Pushes back on requirements ('does chat need the same 800ms budget as voice, or is that only a voice constraint?').",
          "Names the cost-per-order economics and how it shifts model-selection tradeoffs (cheap/fast model for intent routing, stronger model only for ambiguous turns).",
          "Closes with a one-sentence summary and explicitly lists parked items (payments, kitchen display, franchise-level rollout).",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Letting the LLM call the POS API directly instead of going through a deterministic guardrail — one prompt injection away from a free order.",
      "Trusting RAG retrieval alone for price and stock instead of re-verifying against live POS state right before confirming.",
      "No idempotency key on order submission, so a dropped call and a client retry can double-fire an order.",
      "Waiting for the full LLM completion before starting TTS, blowing the sub-800ms conversational budget.",
      "No human-handoff path, so a low-confidence or upset caller gets stuck talking to a bot with no escape hatch.",
      "Treating all tenants' menus/prompts as one shared context instead of hard per-tenant isolation.",
      "No cost or latency numbers on the board — model, ASR, and TTS choices become guesses instead of budget-driven decisions.",
    ],
    followUps: [
      {
        q: "Why cascade ASR→LLM→TTS instead of a single speech-to-speech model?",
        a: "A speech-to-speech model can be lower-latency and more natural in prosody, but today it's harder to insert reliable, structured tool-calling and a deterministic guardrail into that loop, and harder to audit/replay a clean text transcript for compliance and disputes. The cascaded pipeline trades a little latency and naturalness for auditability, tool-calling reliability, and a clean insertion point for the guardrail — the thing this platform needs most, since it's moving money. As speech-to-speech tool-calling matures, that tradeoff will shift.",
      },
      {
        q: "What happens if the LLM hallucinates a menu item that doesn't exist?",
        a: "The get_menu_item tool call resolves against the Live Menu Store, not RAG's fuzzy match; if the item genuinely doesn't exist, the tool returns a structured 'not found' and the orchestrator is prompted to clarify with the caller — it never reaches order submission. RAG is only used to help the LLM figure out which real item the caller might mean; the final identity is always resolved against ground truth.",
      },
      {
        q: "How do you keep menu changes (86'd items, price changes) from going stale?",
        a: "The POS Adapter receives webhooks (or short-polls where webhooks aren't available) and writes menu deltas into the Live Menu Store within under 60 seconds; a lightweight embedding job then re-indexes the per-tenant vector index off that same store. The guardrail always re-checks against the Live Menu Store at submit time regardless of when the RAG snapshot was taken, so even a stale vector index can't let a stale price through to the POS.",
      },
      {
        q: "What if the POS integration is down when the caller wants to place an order?",
        a: "The guardrail-validated order goes into a durable outbox with retry and backoff rather than being dropped. The agent gives the caller an honest, non-committal response instead of confirming an order that hasn't landed, and only after the POS adapter gets a real success response does the agent confirm to the caller. If the POS stays down past a threshold, a circuit breaker trips and routes new calls for that tenant straight to human handoff.",
      },
      {
        q: "How do you evaluate a new prompt or model version before rolling it out to all 50K restaurants?",
        a: "Replay it against a held-out library of recorded (redacted) real transcripts plus synthetic adversarial cases, score against rubrics like grounding accuracy, tool-call correctness, and guardrail-reject rate, then canary to a small percentage of low-risk tenants before a staged rollout — watching handoff rate and guardrail-reject rate as the key regression signals.",
      },
      {
        q: "How is tenant isolation actually enforced, not just assumed?",
        a: "Every request carries a tenant_id that scopes the vector index namespace, the menu/order tables (row-level security or per-tenant partitioning), the prompt/config bundle, and the POS credentials. The orchestrator loads only that tenant's config bundle per session, and the guardrail double-checks that every tool result belongs to the same tenant_id as the session, so a bug that mixes up sessions fails closed instead of leaking another restaurant's menu or order.",
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
          "This is a real-time, tool-calling conversational agent with a deterministic safety boundary between it and a restaurant's point-of-sale system. The core operation — carry a natural multi-turn conversation while incrementally building an order — is inherently probabilistic, so the design's entire job is to wrap that probabilistic core in enough streaming, grounding, and validation that it behaves safely and feels instant.",
          "Anchor everything on five numbers: 50K restaurants, ~5M calls/day, ~50K peak concurrent calls, a sub-800ms p95 turn latency, and under $0.15 fully-loaded cost per completed order. Every structural choice below is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing the platform",
        body: [
          "Daily call volume is not the number that matters — concurrency is. 5M calls/day at ~90s average spread uniformly looks like ~5,200 average concurrent calls, but restaurant traffic is sharply concentrated in lunch and dinner: roughly 60% of volume in a combined 7-hour window pushes the rush-hour average to ~10,700 concurrent, and the peak 15 minutes inside that window can run 3-5× higher, landing the real design target around 40-50K concurrent calls.",
          "Cost has to be tracked per order, not per token: ASR, LLM, and TTS are all metered services, and a sub-$0.15 per completed order target forces model-selection tradeoffs — a cheap, fast model for routine intent routing, escalating to a stronger model only for ambiguous or high-stakes turns.",
        ],
      },
      {
        heading: "The streaming voice pipeline and the 800ms budget",
        body: [
          "Human conversational turn-taking gaps average ~700-800ms, and that's the bar for the whole pipeline. It's only achievable by streaming every stage: ASR emits partial transcripts under 300ms as the caller speaks, endpointing (voice activity detection) uses a ~200-300ms silence threshold to decide the caller is done, the LLM streams its response with a 150-300ms time-to-first-token instead of waiting for the full completion, and TTS synthesizes and plays sentence by sentence with a ~150-200ms time-to-first-audio-byte.",
          "Barge-in rides on the same duplex-streaming foundation: the mic never stops feeding ASR/VAD, even while TTS is playing, so an interruption is a detected event that cancels the TTS stream and flips an explicit per-session state machine (Listening/Speaking/Interrupted) rather than a race condition to reason about ad hoc.",
        ],
      },
      {
        heading: "Grounding: RAG for discovery, live lookup for truth",
        body: [
          "Prompt-stuffing the full menu into the system prompt works for a handful of items and collapses once you're serving 50,000 tenants with 100-300 items and layered modifiers each. A per-tenant vector index solves discovery — matching 'something spicy' to the right dish — but embeddings are approximate and can be stale the moment a price or availability changes.",
          "The fix is to split the job: RAG narrows down which real item the caller probably means, and a separate get_menu_item tool call resolves the authoritative price, stock, and valid modifiers against a live, POS-mirrored table at the moment it's needed. A menu-sync worker keeps that table (and the vector index) fresh within under 60 seconds of any POS-side change, but the guardrail re-checks the live table again at submit time regardless — the sync SLA is a freshness target, not a substitute for the final check.",
        ],
      },
      {
        heading: "Tool-calling and the guardrail: propose vs. dispose",
        body: [
          "The LLM's entire interface to the world is a small set of typed, schema-validated tools — get_menu_item, add_item, apply_modifier, submit_order — routed into an Order Builder service that owns the canonical, versioned order state per session. The LLM never sees a database connection string and never gets to write prose that's parsed after the fact; every action it takes is machine-checkable the instant it's proposed.",
          "Before any order-mutating tool call reaches the POS, it passes through a deterministic Guardrail Service, structurally outside the LLM's loop: stock check against live inventory, price check against the live menu, modifier-combination validity, and total-anomaly bounds that catch a runaway comp or an injected discount. Roughly 2-5% of proposed actions get rejected and bounced back to the orchestrator as a structured error, which re-prompts the caller instead of failing silently. This is the single sentence that should anchor the whole design: the LLM proposes, the guardrail disposes.",
        ],
      },
      {
        heading: "Exactly-once writes, barge-in, and human handoff",
        body: [
          "Phone calls drop and networks retry independently of the POS integration's own reliability, so order submission carries an idempotency key derived from session_id + order_version — a retried submit_order with the same key is a safe no-op if it already succeeded. The agent only confirms the order to the caller after a real success response from the POS adapter, never optimistically; if the POS is unreachable, the validated order queues in a durable outbox with retry and backoff, and a circuit breaker routes new calls to human handoff if the outage runs long.",
          "Human handoff itself is a first-class path, not a fallback bolted on at the end: low-confidence tool resolution, repeated guardrail rejections, or detected caller frustration all trigger escalation to a live line. Combined with async, Kafka-backed transcript logging and an eval pipeline that gates prompt and model rollouts via replay against recorded and synthetic transcripts, the system's reliability story is less about any single component and more about keeping every risky decision — pricing, stock, payment, escalation — behind a deterministic check instead of inside the language model's own judgment.",
        ],
      },
    ],
  },
};
