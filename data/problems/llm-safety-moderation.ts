import type { Problem } from "@/lib/types";

export const llmSafetyModeration: Problem = {
  slug: "llm-safety-moderation",
  num: "7.11",
  title: "Design an LLM Safety & Content Moderation Pipeline",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design the safety layer for a chat product built on an LLM, serving 50M requests/day (~580 req/sec average, ~5K/sec peak). Every prompt must be classified against a harm taxonomy before generation starts, every streamed token must be checked as it's produced, borderline calls must reach a human review queue, and CSAM or imminent-harm content must be caught with near-zero false negatives — all while adding under 20ms p99 to the request path.",
  ],
  hardParts:
    "The hard parts: moderating before you have full context, since streamed tokens and multi-turn conversations are inherently incomplete-information decisions; keeping classification off the critical path without leaving a gap where harmful content can slip through; and setting per-category thresholds so false positives and false negatives cost the right amount for each harm type, instead of one global confidence bar for everything from profanity to CSAM.",
  keyTopics: [
    "Layered Classifier Cascade",
    "Streaming Window Moderation",
    "Fail-Open vs Fail-Closed Policy",
    "Human-in-the-Loop Review Queue",
    "Conversation-Level Risk Accumulation",
  ],
  foundationsReferenced: [
    { label: "Bloom Filters", tone: "green" },
    { label: "Token Bucket Rate Limiting", tone: "blue" },
    { label: "Kafka", tone: "orange" },
    { label: "Valkey / Redis", tone: "purple" },
    { label: "Circuit Breakers", tone: "orange" },
    { label: "Vector Similarity / ANN Search", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "API Gateway", col: 2, row: 1, tone: "slate" },
      {
        id: "inputMod",
        label: "Input Moderation",
        sub: "blocklist + fast classifier",
        mono: "p99 < 20ms",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "llm", label: "LLM Inference", sub: "streaming tokens", col: 4, row: 1, tone: "green" },
      {
        id: "outputMod",
        label: "Output Moderation",
        sub: "windowed streaming check",
        mono: "abort + fallback on trip",
        col: 5,
        row: 1,
        tone: "green",
      },
      { id: "policySvc", label: "Policy Service", sub: "versioned taxonomy & thresholds", col: 3, row: 2, tone: "blue" },
      { id: "riskStore", label: "Risk Profile Store", sub: "Valkey · per-user score", col: 4, row: 2, tone: "purple" },
      { id: "kafka", label: "Kafka", sub: "moderation events", col: 3, row: 3, tone: "orange" },
      { id: "deepClassifier", label: "Deep Classifier", sub: "async, full-context re-score", col: 4, row: 3, tone: "orange" },
      { id: "reviewQueue", label: "Review Queue + Humans", sub: "borderline confidence band", col: 5, row: 3, tone: "orange" },
      {
        id: "complianceStore",
        label: "Compliance Store",
        sub: "audit log · NCMEC reporting · retention",
        col: 5,
        row: 4,
        tone: "blue",
      },
    ],
    edges: [
      { from: "client", to: "gateway", label: "request", kind: "write" },
      { from: "gateway", to: "inputMod", label: "prompt + conversation context", kind: "write" },
      { from: "inputMod", to: "riskStore", label: "read per-user risk score", kind: "read" },
      { from: "inputMod", to: "riskStore", label: "escalate score on block", kind: "write" },
      { from: "inputMod", to: "policySvc", label: "category thresholds", kind: "read" },
      { from: "inputMod", to: "llm", label: "allowed · ~95%", kind: "write" },
      { from: "inputMod", to: "gateway", label: "blocked · refusal", kind: "write" },
      { from: "llm", to: "outputMod", label: "streamed tokens", kind: "write" },
      { from: "outputMod", to: "gateway", label: "forwarded tokens", kind: "write" },
      { from: "inputMod", to: "kafka", label: "moderation event", kind: "analytics" },
      { from: "outputMod", to: "kafka", label: "moderation event", kind: "analytics" },
      { from: "kafka", to: "deepClassifier", kind: "analytics" },
      { from: "deepClassifier", to: "reviewQueue", label: "borderline confidence", kind: "analytics" },
      { from: "deepClassifier", to: "complianceStore", label: "audit log", kind: "analytics" },
      { from: "reviewQueue", to: "complianceStore", label: "human decision + label", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · policy & risk lookups" },
      { kind: "write", text: "write path · request/response, ~5K/sec peak" },
      { kind: "analytics", text: "async · audit, review, retraining, never blocks a response" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "gateway", "inputMod", "llm", "outputMod"],
      say: "Every request is a straight line: client to gateway to input moderation, which has to call allow-or-block in under 20ms before the LLM ever sees the prompt. Once generation starts, streamed tokens pass through output moderation before they reach the client — those two hops are the only ones on the critical path.",
    },
    {
      reveal: ["policySvc", "riskStore"],
      say: "Input moderation doesn't decide alone: it reads the category thresholds from a versioned policy service and the user's risk score from the risk store, both sub-millisecond lookups, and writes the score back up whenever it blocks something so repeat violations raise the bar next time.",
    },
    {
      reveal: ["kafka", "deepClassifier"],
      say: "Every decision, allow or block, also drops a moderation event into Kafka without waiting on it. A slower, more accurate deep classifier consumes that stream off the critical path and re-scores with full context and no latency budget.",
    },
    {
      reveal: ["reviewQueue", "complianceStore"],
      say: "Whatever the deep classifier can't confidently call goes to the human review queue. Every outcome — automated or human — lands in an append-only compliance store, the audit trail that CSAM reporting and appeals depend on.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Classify user input (prompt) against a harm taxonomy before generation begins", tag: "P0" },
      { id: "FR-02", text: "Block generation and return a policy-compliant refusal for hard-block categories (CSAM, imminent violence)", tag: "P0" },
      { id: "FR-03", text: "Moderate model output incrementally while streaming, aborting the stream mid-generation on a violation", tag: "P0" },
      { id: "FR-04", text: "Support a configurable harm taxonomy (hate speech, self-harm, sexual content, violence, weapons, PII) with per-category confidence thresholds", tag: "P0" },
      { id: "FR-05", text: "Maintain a per-user risk/trust score that escalates enforcement (warnings, rate limits, suspension) for repeat violations", tag: "P0" },
      { id: "FR-06", text: "Route borderline-confidence decisions to a human review queue for adjudication", tag: "P1" },
      { id: "FR-07", text: "Moderate at the conversation level to catch violations built up across turns (jailbreak drip)", tag: "P1" },
      { id: "FR-08", text: "Log every moderation decision with policy version and classifier model version for audit and appeals", tag: "P0" },
      { id: "FR-09", text: "Update policy thresholds and taxonomy without redeploying the classifier models", tag: "P1" },
      { id: "FR-10", text: "Detect and block known prompt-injection and jailbreak patterns", tag: "P1" },
      { id: "FR-11", text: "Feed human-reviewed labels back into classifier retraining pipelines", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Input moderation latency added to the request path", tag: "p99 < 20ms" },
      { id: "NFR-02", text: "Streaming output moderation overhead per window check", tag: "p99 < 15ms" },
      { id: "NFR-03", text: "Sustained request throughput at peak", tag: "5K/sec" },
      { id: "NFR-04", text: "Moderation service availability", tag: "99.99%" },
      { id: "NFR-05", text: "False negative rate on hard-block categories (CSAM, imminent harm)", tag: "zero tolerance" },
      { id: "NFR-06", text: "Time from escalation to human adjudication", tag: "p95 < 15 min" },
      { id: "NFR-07", text: "Audit log durability and retention", tag: "7yr, zero loss" },
      { id: "NFR-08", text: "Classifier drift monitoring and retrain cadence", tag: "weekly" },
      { id: "NFR-09", text: "Streaming coverage: fraction of generated turns classified", tag: "100% of turns" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing the latency budget: why moderation can't be one big model",
      body: [
        "Start from the product's own SLA, not the moderation system's. If time-to-first-token is budgeted at ~300ms, input moderation runs entirely inside that window and has to be a thin slice of it — not because moderation matters less, but because it sits on the critical path of every single request. At 5K req/sec peak, a synchronous classifier that costs 200ms and a full extra GPU forward pass isn't a latency problem, it's a capacity problem: you'd need to roughly double LLM-inference-sized fleet just to gate the LLM.",
        "That rules out using a large, highly-accurate model (or the LLM itself, asked to judge its own input) synchronously on every request. The fast path has to be a small distilled classifier — tens of millions of parameters, not billions — that fits in single-digit milliseconds on CPU or a shared inference pool, reserving the expensive, accurate model for asynchronous, off-critical-path scoring.",
      ],
      bullets: [
        { lead: "Budget math", text: "300ms TTFT target, <20ms p99 for input moderation ⇒ moderation gets under 7% of the budget, so it has to be cheap by construction, not by luck." },
        { lead: "Fast classifier", text: "a distilled transformer (Llama-Guard-style, ~50-100M params) served via a low-latency inference runtime, single-digit ms per call." },
        { lead: "Deep classifier", text: "a larger, more accurate model (or an LLM-as-judge with policy chain-of-thought) runs async, off the request path, for audit and escalation." },
      ],
      pictureTitle: "Where does the latency budget go?",
      pictureRows: [
        { label: "TTFT budget", value: "~300ms total", tone: "neutral" },
        { label: "Input moderation (fast classifier)", value: "<20ms p99, on the critical path", tone: "good" },
        { label: "Deep classifier / LLM-as-judge", value: "100s of ms, async only", tone: "bad" },
      ],
      remember: {
        problem: "Moderate every request without blowing the response-time SLA.",
        solution: "A small distilled classifier runs synchronously in <20ms; the large accurate model runs async, off the critical path.",
        why: "Accuracy and latency trade off directly in model size; the request path can only afford the cheap end of that trade.",
        tradeoff: "The fast classifier is less accurate, so it needs a review path underneath it to catch what it misses.",
        failure: "Running a large model or the LLM itself synchronously on every request roughly doubles inference cost and blows TTFT.",
        mitigation: "Keep the fast classifier tiny and push all expensive judgment to the async deep-classifier and human-review layers.",
      },
    },
    {
      n: 2,
      title: "The cascade: kill three options, defend one",
      body: [
        "Put the candidates for 'how do we classify a request' on the board and rule them out one at a time, the same way you'd rule out ID-generation strategies for a URL shortener. The winner isn't any single technique — it's a cascade where each layer only sees what the layer before it couldn't resolve.",
      ],
      bullets: [
        { lead: "Static keyword blocklist alone", text: "trivially bypassed by leetspeak, unicode homoglyphs, or paraphrase, and understands no semantics. Too weak alone. Rejected as the only layer." },
        { lead: "LLM-as-judge on every request", text: "accurate but 100s of ms and a full extra inference call per request, roughly doubling cost at 5K/sec. Rejected as the synchronous layer." },
        { lead: "Human review on every request", text: "accurate but scales to maybe tens of thousands of decisions per day, not 50M. Rejected as the front line." },
        { lead: "Deterministic blocklist + hash match", text: "microseconds, catches exact known-bad strings and perceptual-hash matches (PhotoDNA-style) against known CSAM. Kept as layer 0." },
        { lead: "Fast distilled classifier", text: "single-digit ms, catches the majority of semantic violations that the blocklist misses. Kept as layer 1." },
        { lead: "Cascade: blocklist → fast classifier → async deep classifier → human review", text: "each request only pays for the layers it actually needs; almost all requests exit at layer 0 or 1. Winner." },
      ],
      pictureTitle: "Kill three, keep the cascade",
      pictureRows: [
        { label: "Blocklist only", value: "bypassed by leetspeak/unicode → reject as sole layer", tone: "bad" },
        { label: "LLM-as-judge on every request", value: "~2× inference cost, 100s of ms → reject as sync layer", tone: "bad" },
        { label: "Human review on every request", value: "scales to ~30K/day, not 50M → reject as front line", tone: "bad" },
        { label: "Blocklist → fast classifier → deep classifier → human", value: "each layer costs more, sees less traffic → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Classify 50M requests/day without a single technique that's both cheap enough and accurate enough.",
        solution: "A four-layer cascade: hash/blocklist, fast distilled classifier, async deep classifier, human review — increasing accuracy, decreasing traffic volume.",
        why: "No single model hits the accuracy/latency/cost point for all 50M requests; layering lets each stage filter for the next.",
        tradeoff: "More moving parts and more classifiers to keep in sync (versioning, drift) in exchange for cost and latency that scale.",
        failure: "Any single-layer design either misses obvious bypasses (blocklist alone) or can't afford the volume (LLM-judge or human alone).",
        mitigation: "Route only the layer-0/1 escapes forward, so the expensive layers see a small, high-value slice of traffic.",
      },
    },
    {
      n: 3,
      title: "Streaming output moderation: the partial-context problem",
      body: [
        "Once the model starts streaming tokens, you're moderating a response that doesn't exist yet. You can't wait for the full completion — that would mean either buffering the entire response before showing anything (killing the point of streaming) or moderating only after the user already saw it. So moderation has to run on windows of tokens as they're produced, and that's a genuinely incomplete-information decision: a window can look benign in isolation while continuing a violation that started two windows earlier.",
        "The design buffers tokens into windows — roughly 25-30 tokens, about a sentence, checked every ~150-250ms of generation — and classifies each window in the context of a rolling summary of what's already been emitted, not in isolation. If a window trips a threshold, the stream is aborted immediately: buffered-but-unsent tokens are discarded and a canned fallback message replaces them. The classifier call runs in parallel with token generation so it doesn't add to time-to-first-token; it only costs a stream abort-and-rollback in the rare case it trips.",
      ],
      bullets: [
        { lead: "Window size trade-off", text: "smaller windows check faster but miss violations that only become clear across multiple windows; larger windows catch more context but let the user see more before a cutoff." },
        { lead: "Rolling context", text: "each window is classified alongside a compact rolling summary, not just its own tokens, so a violation that spans window boundaries doesn't get an artificial pass." },
        { lead: "Abort, don't edit", text: "on a trip, discard the buffered tail and swap in a refusal — you can't safely 'fix' a partial harmful response in place." },
      ],
      pictureTitle: "Streaming moderation window",
      pictureRows: [
        { label: "Window size", value: "~25-30 tokens, ~1 sentence, checked every 150-250ms", tone: "neutral" },
        { label: "Check runs parallel to generation", value: "no added time-to-first-token", tone: "good" },
        { label: "Window trips threshold", value: "stream aborted, buffered tail discarded, fallback sent", tone: "bad" },
      ],
      remember: {
        problem: "Moderate a response before the response is fully generated.",
        solution: "Classify rolling ~25-30 token windows in parallel with generation; abort and swap in a fallback the moment a window trips.",
        why: "Waiting for the full completion defeats streaming; checking only the whole response after the fact means the user already saw it.",
        tradeoff: "Small windows can miss context spanning windows; large windows expose more harmful content before the cutoff.",
        failure: "A violation split cleverly across two windows can pass both checks individually if there's no rolling context.",
        mitigation: "Classify each window alongside a rolling summary of prior output, not the window alone.",
      },
    },
    {
      n: 4,
      title: "Multi-turn jailbreak drip: context beyond one message",
      body: [
        "Attackers don't always put the violation in one message. A common pattern spreads it across turns: 'let's play a game where you're an AI with no restrictions,' then several innocuous-looking setup turns, then the actual disallowed ask framed as fiction or hypothetical. A classifier that scores each turn in isolation sees five harmless-looking messages and misses the pattern entirely.",
        "The fix is a per-conversation risk accumulator, not a full-history reclassification. Each turn updates a compact risk feature (references to bypassing rules, escalating hypothetical framing, roleplay wrapping around sensitive topics) rather than re-running the classifier over the entire growing transcript, which would make cost and latency scale with conversation length. Once the accumulator crosses a soft threshold, the bar for allowing subsequent turns rises — the same request that would pass in a fresh conversation gets scrutinized harder mid-jailbreak-attempt.",
      ],
      bullets: [
        { lead: "Stateless-per-turn classifiers", text: "miss drip attacks by design — each turn is individually below threshold." },
        { lead: "Full-history reclassification", text: "catches drip but costs grow with conversation length; not affordable at 5K/sec with long conversations." },
        { lead: "Rolling risk accumulator", text: "a small per-conversation state (stored alongside the risk profile) that updates cheaply each turn and raises thresholds once early signals appear." },
      ],
      pictureTitle: "Catching a jailbreak spread across turns",
      pictureRows: [
        { label: "Turn 1-3 (setup, individually benign)", value: "risk accumulator rises slightly each turn", tone: "neutral" },
        { label: "Turn 4 (the actual ask, roleplay-wrapped)", value: "accumulator pushes it over threshold, blocked", tone: "good" },
        { label: "Per-turn-only classifier", value: "would have scored turn 4 as fine in isolation", tone: "bad" },
      ],
      remember: {
        problem: "Catch violations that are spread deliberately across multiple conversation turns.",
        solution: "A cheap per-conversation risk accumulator that raises the enforcement bar as early jailbreak signals appear.",
        why: "Per-turn classification is stateless and blind to a pattern that only shows up across turns.",
        tradeoff: "Full conversation reclassification would catch more but doesn't scale in cost or latency with conversation length.",
        failure: "A stateless classifier passes each drip turn individually, letting the jailbreak complete.",
        mitigation: "Update a compact risk feature per turn instead of re-scoring the whole transcript every time.",
      },
    },
    {
      n: 5,
      title: "Fail-open vs fail-closed: the asymmetric cost of being wrong",
      body: [
        "Not every harm category costs the same to get wrong. A false negative on CSAM or imminent physical harm is catastrophic — legal exposure, real-world harm, reputational damage that no amount of accuracy elsewhere offsets. A false positive on a gray-area medical or political question is annoying and erodes trust, but it's a UX cost, not a safety one. Treating every category with the same confidence threshold means either over-blocking legitimate use constantly, or under-blocking the categories that can't tolerate it.",
        "So the policy config carries a per-category enforcement mode, not one global bar: absolute-prohibition categories (CSAM, terrorism, imminent violence) are fail-closed and, for CSAM specifically, enforced deterministically via hash-matching against known-bad content rather than left to probabilistic ML judgment at all — ML is never the last line of defense there. Gray-area categories are fail-open with monitoring, biased toward letting the request through and logging it for review rather than refusing.",
      ],
      bullets: [
        { lead: "Hard-block categories", text: "fail-closed, deterministic where possible (hash match), near-zero false-negative tolerance, always reported/logged." },
        { lead: "Gray-area categories", text: "fail-open, higher confidence bar to block, biased against over-refusal that damages trust and product usage." },
        { lead: "One threshold for everything", text: "the naive default — either blocks too much of the gray area or misses too much of the absolute-prohibition list." },
      ],
      pictureTitle: "Different categories, different failure cost",
      pictureRows: [
        { label: "CSAM / imminent harm", value: "fail-closed, hash-matched, zero tolerance", tone: "bad" },
        { label: "Hate speech / violence (general)", value: "fail-closed-ish, ML classifier + review band", tone: "neutral" },
        { label: "Political / medical gray area", value: "fail-open, high bar to block, monitored", tone: "good" },
      ],
      remember: {
        problem: "One confidence threshold can't be right for both CSAM and a borderline medical question.",
        solution: "Per-category enforcement mode: fail-closed and deterministic for absolute prohibitions, fail-open and monitored for gray areas.",
        why: "False negatives and false positives cost wildly different amounts depending on the harm category.",
        tradeoff: "More policy surface to configure and audit, in exchange for not over-blocking or under-blocking uniformly.",
        failure: "A single global threshold either over-refuses legitimate gray-area requests or under-blocks the categories that can't tolerate it.",
        mitigation: "Store {threshold, enforcement-mode, fail-open-or-closed} per category in the versioned policy service.",
      },
    },
    {
      n: 6,
      title: "The human review queue: sizing it so it doesn't overflow",
      body: [
        "The borderline confidence band — scores that aren't clearly 'allow' or clearly 'block' — routes to human reviewers instead of an automated call. This is where queue math matters as much as classifier accuracy: at 50M requests/day, even a small borderline rate produces a lot of absolute volume, and reviewer capacity is finite.",
        "At ~0.05% of 50M requests landing in the borderline band, that's ~25K/day. With 250 trust-and-safety reviewers each adjudicating ~120 cases/day, capacity is ~30K/day — a real but thin margin. That margin is why threshold tuning matters: widen the borderline band even slightly and the queue backs up past the 15-minute p95 adjudication SLA, especially during a coordinated abuse spike that deliberately targets the gray zone.",
      ],
      bullets: [
        { lead: "Queue math", text: "0.05% of 50M/day ≈ 25K/day into review; 250 reviewers × 120/day ≈ 30K/day capacity — a thin, monitored margin, not slack." },
        { lead: "During adjudication", text: "the user sees a soft hold or a generic response depending on category, never an indefinite hang." },
        { lead: "Feedback loop", text: "every human decision becomes a labeled training example, fed back weekly to retrain the fast and deep classifiers, shrinking future queue volume as accuracy improves." },
      ],
      pictureTitle: "Review queue capacity math",
      pictureRows: [
        { label: "Borderline rate (0.05% of 50M/day)", value: "~25K cases/day", tone: "neutral" },
        { label: "250 reviewers × ~120/day", value: "~30K/day capacity", tone: "good" },
        { label: "Threshold drifts wider", value: "queue backs up past 15-min p95 SLA", tone: "bad" },
      ],
      remember: {
        problem: "Route borderline decisions to humans without the queue overflowing at 50M requests/day.",
        solution: "Tune the borderline band tightly (~0.05%) against measured reviewer capacity (~30K/day), and feed decisions back into retraining.",
        why: "Even a tiny percentage of a huge volume is a lot of absolute cases; capacity is finite and must be sized deliberately.",
        tradeoff: "A tighter borderline band means more auto-decisions from a classifier that's less accurate than a human.",
        failure: "A coordinated abuse campaign deliberately targeting the gray zone can spike queue volume past capacity within hours.",
        mitigation: "Monitor queue depth as a first-class metric, auto-tighten thresholds under load, and keep reviewer capacity headroom.",
      },
    },
    {
      n: 7,
      title: "Compliance and the audit trail: CSAM isn't a confidence score",
      body: [
        "Every moderation decision — block, allow, or flag — gets logged with the policy version, the classifier model version, and per-category confidence scores, retained for a fixed compliance window (commonly multi-year, jurisdiction-dependent) to support audits and user appeals. This audit log is a separate, append-only compliance store, distinct from the mutable review queue, because it has to survive as legally defensible evidence independent of any later re-review.",
        "CSAM specifically doesn't go through the probabilistic pipeline at all. It's matched deterministically via perceptual hashing against known-bad hash databases (PhotoDNA-style), and a match triggers a hard-coded compliance path — immediate block, mandatory reporting to the relevant authority (NCMEC in the US) within the legally required window — that bypasses the confidence-threshold machinery entirely. ML judgment is never the last word on an absolute-prohibition category; it's either a deterministic hash match or it routes to human review, never an automated 'probably fine.'",
      ],
      bullets: [
        { lead: "Audit log", text: "policy version + model version + per-category scores, append-only, separate store from the review queue, multi-year retention." },
        { lead: "CSAM hash-matching", text: "deterministic, not probabilistic — matched against known-bad perceptual hashes, never left to a confidence threshold." },
        { lead: "Mandatory reporting", text: "a CSAM match triggers a hard-coded, non-optional reporting pathway with its own audit trail, independent of the general moderation flow." },
      ],
      pictureTitle: "Why CSAM skips the confidence pipeline",
      pictureRows: [
        { label: "General harm categories", value: "confidence score → threshold → maybe review", tone: "neutral" },
        { label: "CSAM", value: "deterministic hash match → hard block → mandatory report", tone: "good" },
        { label: "CSAM left to ML confidence alone", value: "unacceptable false-negative risk", tone: "bad" },
      ],
      remember: {
        problem: "Some categories can't tolerate any probabilistic-classifier risk, and every decision needs a defensible audit trail.",
        solution: "Deterministic hash-matching for CSAM with a hard-coded reporting path; a separate append-only compliance store for every decision.",
        why: "Confidence thresholds imply nonzero false-negative rate, which is unacceptable for absolute-prohibition content; audits need immutable evidence.",
        tradeoff: "Hash-matching only catches known content, so it's paired with — not a replacement for — the ML classifier for novel material.",
        failure: "Routing CSAM through the same confidence-threshold pipeline as hate speech risks a false negative on the one category that can't have any.",
        mitigation: "Hard-code the CSAM path outside the general cascade, and make the audit log append-only and independently retained.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a layered cascade: cheap deterministic checks first, then a fast distilled classifier on the request path, then an async deep classifier and human review for what's left over.",
      "Input moderation runs before generation; output moderation runs on rolling token windows during streaming, since you can't wait for the full response to check it.",
      "Different harm categories get different enforcement modes — fail-closed and hash-matched for CSAM, fail-open and monitored for gray-area content — not one global threshold.",
      "Multi-turn jailbreaks are caught with a cheap per-conversation risk accumulator, not by re-scoring the whole transcript every turn.",
      "The review queue and audit log are sized and retained deliberately: queue capacity has to beat borderline volume, and CSAM has its own deterministic, non-ML reporting path.",
    ],
    flows: [
      {
        kind: "write",
        title: "INPUT MODERATION · 5K/S PEAK · P99 < 20MS",
        summary:
          "A prompt is checked before the LLM ever sees it. A blocklist catches known-bad content in microseconds; a fast classifier catches the rest in single-digit ms. Only allowed prompts reach generation.",
        steps: [
          { label: "Client", note: "sends a prompt" },
          { label: "API Gateway", note: "attaches conversation context" },
          { label: "Blocklist / hash match", note: "microseconds, known-bad exact/perceptual matches" },
          { label: "Fast classifier", note: "distilled model, single-digit ms" },
          { label: "Risk Profile Store", note: "per-user score adjusts threshold" },
          { label: "Allow → LLM Inference", note: "~95% of requests" },
          { label: "Block → refusal", note: "policy-compliant message, logged" },
        ],
      },
      {
        kind: "write",
        title: "STREAMING OUTPUT MODERATION",
        summary:
          "Tokens stream from the LLM in rolling windows. Each window is checked in parallel with generation, with a rolling summary of what's already been sent, so it doesn't add to time-to-first-token.",
        steps: [
          { label: "LLM Inference", note: "streaming tokens" },
          { label: "Window buffer", note: "~25-30 tokens, ~150-250ms" },
          { label: "Window classifier", note: "checked with rolling context, parallel to generation" },
          { label: "Trip → abort stream", note: "discard buffered tail, send fallback" },
          { label: "No trip → forward", note: "tokens reach the client" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC AUDIT, REVIEW, AND RETRAINING",
        summary:
          "Every decision emits an event. A deeper, slower classifier re-scores it off the critical path, borderline cases go to humans, and every human decision becomes a labeled example for the next model.",
        steps: [
          { label: "Kafka", note: "moderation events from both input and output paths" },
          { label: "Deep Classifier", note: "async, high-accuracy re-score" },
          { label: "Review Queue", note: "~25K/day borderline, ~30K/day reviewer capacity" },
          { label: "Compliance Store", note: "append-only audit log, 7yr retention, NCMEC path for CSAM" },
          { label: "Retraining pipeline", note: "weekly, human-labeled feedback loop" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "50M requests/day, ~580/s average, ~5K/s peak",
          "Input moderation budget: p99 < 20ms, inside a ~300ms TTFT target",
          "Streaming window: ~25-30 tokens (~1 sentence), checked every ~150-250ms",
          "Fast classifier: ~50-100M param distilled model, single-digit ms",
          "Borderline review rate: ~0.05% of traffic ≈ 25K/day",
          "Reviewer capacity: 250 reviewers × ~120/day ≈ 30K/day",
          "Audit retention: 7 years, append-only, zero loss",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Four-layer cascade: blocklist → fast classifier → async deep classifier → human review",
          "Streaming moderation on rolling windows with rolling context, not per-token or whole-response",
          "Per-category enforcement mode: fail-closed/deterministic for CSAM, fail-open/monitored for gray areas",
          "Per-conversation risk accumulator instead of full-history reclassification for jailbreak drip",
          "Policy thresholds live in a versioned config service, decoupled from classifier deploys",
          "CSAM handled by deterministic perceptual-hash matching, never left to a confidence threshold",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Moderation is an incomplete-information problem on both input (multi-turn) and output (streaming)",
          "False positive vs false negative cost is asymmetric per category — say which categories are fail-open vs fail-closed",
          "Review queue capacity is a real number to size, not an infinite safety net",
          "CSAM bypasses ML confidence entirely — hash match plus mandatory reporting",
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
      goal: "Lock the traffic numbers, the latency budget, and the harm taxonomy scope before drawing anything.",
      why: "This system lives or dies on latency budgets and category-specific policy, not raw throughput. The interviewer wants to see you pin down what 'safe enough' means numerically before proposing a cascade.",
      steps: [
        { kind: "ASK", text: '**"What scale — requests per day, and is this text-only or multimodal?"** Land on "50M requests/day, ~5K/sec peak, text-only for this design." Write **"50M/day, 5K/s peak"** in the corner.' },
        { kind: "ASK", text: '**"What\'s the overall response latency SLA?"** Land on "~300ms time-to-first-token." Write it down — everything about the moderation budget derives from this one number.' },
        { kind: "SAY", text: 'Propose the moderation latency budget yourself: **"input moderation under 20ms p99, inside that 300ms window."** Wait for a nod.' },
        { kind: "SAY", text: 'State scope. In: "input moderation, streaming output moderation, human review, audit/compliance." Out: "model alignment/RLHF, multimodal image moderation, auth." "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Name the harm taxonomy out loud: **"hate speech, self-harm, sexual content, violence, weapons, PII, plus CSAM as an absolute-prohibition category."** Write it as a short list — it anchors the whole policy discussion later.' },
      ],
      grading: "Are the QPS, latency budget, and taxonomy on the board before any component gets drawn? Does the candidate treat the 300ms SLA as the thing that constrains classifier choice, not an afterthought?",
    },
    {
      n: 2,
      title: "API and Policy Model",
      minutes: 5,
      goal: "Define the moderation call shape and the per-category policy config, and justify why policy is decoupled from the classifier.",
      why: "The interviewer wants to see that policy (thresholds, enforcement mode) is treated as versioned config, not baked into model weights — that's what lets thresholds change without a redeploy.",
      steps: [
        { kind: "WRITE", text: 'Write the moderation call: **"classify(text, conversation_context, user_risk_score) → { category, confidence, decision }"**, where decision is one of allow / block / flag-for-review.' },
        { kind: "DRAW", text: 'Sketch the policy record per category: **"category, confidence_threshold, enforcement_mode (fail-open/fail-closed), action (block/flag/hash-match)"**. Say: "This lives in a versioned policy service, not in the model — that\'s how thresholds change without a classifier redeploy."' },
        { kind: "SAY", text: 'Justify per-category thresholds explicitly: "CSAM and imminent harm are fail-closed and hash-matched; gray-area categories are fail-open with a high bar to block. One global threshold can\'t serve both."' },
        { kind: "RULE OUT", text: '"A single confidence bar for every category either over-blocks legitimate gray-area content or under-blocks the categories that can\'t tolerate any false negatives." Cross it off.' },
      ],
      grading: "A clean call shape, a policy record with enforcement mode as a first-class field, and an explicit rejection of a single global threshold.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram: the synchronous input+output moderation lane, the policy/risk lookups, and the async audit/review/retrain lane.",
      why: "Drawing sync vs async as separate lanes proves the candidate understands which parts of moderation can add latency and which absolutely cannot. Candidates who draw one blob miss why the deep classifier can't sit on the request path.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **input path**: Client → Gateway → Input Moderation (blocklist → fast classifier) → LLM Inference, with a branch back to Gateway labeled **"blocked · refusal"**. Label the allow arrow **"~95%"**.' },
        { kind: "DRAW", text: 'Add the **streaming output path**: LLM Inference → Output Moderation (windowed) → Gateway, labeled **"~25-30 token windows, checked parallel to generation"**, with an abort branch labeled **"trip → discard tail, send fallback"**.' },
        { kind: "DRAW", text: 'Add the **async lane**, dashed: Input/Output Moderation → Kafka → Deep Classifier → Review Queue + Humans, and → Compliance Store. Label it **"never blocks a response"**.' },
        { kind: "SAY", text: 'Narrate the split: "Two things must stay under the latency budget — input classification and the streaming window check. Everything else — deep re-scoring, human review, audit logging — runs async and can take seconds to minutes."' },
      ],
      grading: "Three clearly separated lanes (sync input, sync streaming output, async audit/review), each labeled with its own latency expectation, and an explicit statement of what must never add latency.",
    },
    {
      n: 4,
      title: "Deep Dive: Streaming Output Moderation",
      minutes: 8,
      goal: "Explain the windowed check, the rolling-context requirement, and the abort-and-fallback behavior on a trip.",
      why: "This is the signature hard part. The interviewer is probing whether the candidate understands that streaming moderation is a genuinely incomplete-information problem, not just 'run the same classifier more often.'",
      steps: [
        { kind: "SAY", text: 'State the core tension: "We can\'t wait for the full response — that defeats streaming — but a single window checked in isolation can miss a violation that spans window boundaries."' },
        { kind: "DRAW", text: 'Draw the window: **"~25-30 tokens, ~1 sentence, checked every ~150-250ms, in parallel with generation."** Show the classifier taking the window plus a rolling summary of prior output, not the window alone.' },
        { kind: "SAY", text: 'Explain the trip behavior: "On a threshold breach, abort the stream immediately, discard the buffered-but-unsent tail, and swap in a canned fallback. You can\'t safely edit a partial harmful response in place."' },
        { kind: "RULE OUT", text: '"Checking only the full completed response" → the user already saw it while streaming. "Checking every single token" → too much classifier overhead for too little added context per call. Cross both off.' },
      ],
      grading: "The windowing mechanism explained with real numbers, rolling context named as necessary (not just per-window scoring), and the abort-and-fallback behavior stated without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: Fail-Open/Closed, Multi-Turn, and the Review Queue",
      minutes: 7,
      goal: "Cover the asymmetric cost of errors per category, the jailbreak-drip problem, and size the human review queue with real numbers.",
      why: "Staff-level signal here is quantifying the review queue instead of hand-waving 'humans review the rest,' and volunteering that different harm categories need different failure modes.",
      steps: [
        { kind: "SAY", text: 'State the asymmetry: "A false negative on CSAM is catastrophic; a false positive on a gray-area medical question is a UX cost. CSAM is fail-closed and hash-matched — never left to a confidence score. Gray areas are fail-open with monitoring."' },
        { kind: "SAY", text: 'Name jailbreak drip: "Attackers spread a jailbreak across turns, each individually benign. A per-conversation risk accumulator updates cheaply each turn and raises the bar once early signals appear, instead of re-scoring the full transcript every time."' },
        { kind: "WRITE", text: 'Size the review queue out loud: **"~0.05% of 50M/day ≈ 25K/day borderline, 250 reviewers × ~120/day ≈ 30K/day capacity."** Write both numbers — the margin is the point.' },
        { kind: "SAY", text: 'Volunteer the failure mode: "A coordinated abuse campaign targeting the gray zone can spike queue volume past capacity in hours — we monitor queue depth and can auto-tighten thresholds under load."' },
      ],
      grading: "Explicit per-category fail-open/closed reasoning, the risk-accumulator explained without prompting, and queue capacity quantified with both sides of the math (volume in, capacity out).",
    },
    {
      n: 6,
      title: "Wrap: Compliance, Feedback Loop, and Close",
      minutes: 5,
      goal: "Name the CSAM reporting path, the retraining feedback loop, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational and legal maturity: knowing CSAM needs a deterministic, non-ML path with mandatory reporting, and that human decisions should close the loop back into the classifiers.",
      steps: [
        { kind: "SAY", text: '"CSAM doesn\'t go through the confidence pipeline at all — it\'s matched deterministically via perceptual hashing against known-bad hash databases, and a match triggers a hard-coded, non-optional reporting path, separate from general review."' },
        { kind: "SAY", text: '"Every human review decision becomes a labeled example, fed back weekly to retrain the fast and deep classifiers — that\'s what shrinks review-queue volume over time instead of it growing with traffic."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need 100% turn coverage on streaming, or can low-risk conversations sample windows less densely to save compute?" Treat it as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a layered cascade tuned per-category, with streaming and multi-turn moderation as the genuinely hard, incomplete-information parts. With more time I\'d cover multimodal moderation, adversarial red-teaming, and the appeals workflow."' },
      ],
      grading: "CSAM's deterministic path stated unprompted, the retraining feedback loop named, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working moderation design with a classifier and a blocklist, but treats every category the same and doesn't quantify the review queue.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Proposes a classifier in front of the LLM and a keyword blocklist as a first line of defense.",
          "Knows that streaming responses need to be checked somehow, even if the mechanism is vague.",
          "Adds a queue for human review when prompted.",
          "Understands that CSAM and other severe categories need special handling if asked directly.",
          "Can name a few harm categories (hate speech, violence, sexual content) when asked.",
        ],
        gaps: [
          "Uses one global confidence threshold for every harm category instead of per-category enforcement modes.",
          "Doesn't explain how streaming moderation actually works — 'check it as it streams' with no windowing mechanism.",
          "No numbers on review queue volume vs. reviewer capacity, so the queue is treated as infinite capacity.",
          "Misses multi-turn jailbreak drip entirely unless the interviewer raises it.",
          "Doesn't distinguish the synchronous fast classifier from an async, more accurate one — proposes one model for everything.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the cascade design end-to-end, quantifies the latency budget, and explains streaming and multi-turn moderation with real mechanisms.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the latency budget (TTFT, moderation slice of it) on the board within the first 5 minutes.",
          "Proposes the layered cascade (blocklist → fast classifier → deep classifier → human) and can justify each layer.",
          "Explains windowed streaming moderation with a concrete window size and check cadence.",
          "Names the fail-open/fail-closed distinction per category when asked.",
          "Sizes the review queue with rough numbers.",
          "Mentions CSAM needs different handling from other categories.",
          "Describes a feedback loop from human review back into classifier retraining.",
        ],
        gaps: [
          "Volunteers the jailbreak-drip / multi-turn risk only after the interviewer hints at it, not on their own.",
          "States the review queue capacity in general terms ('humans review the rest') rather than with both sides of the math.",
          "Doesn't proactively separate CSAM's deterministic hash-match path from the general probabilistic pipeline.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats moderation as a set of asymmetric-cost decisions per category, and surfaces the incomplete-information framing before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Frames both streaming output and multi-turn input moderation as fundamentally incomplete-information problems, unprompted.",
          "Volunteers that CSAM must bypass the confidence-threshold pipeline entirely, with a hard-coded deterministic hash-match and mandatory reporting path.",
          "Quantifies the review queue with both volume in and capacity out (~25K/day vs ~30K/day) and names the coordinated-abuse-spike failure mode.",
          "Explains the per-conversation risk accumulator as a cost-bounded alternative to full-history reclassification, with the reasoning for why full reclassification doesn't scale.",
          "Distinguishes fail-open vs fail-closed per category with the actual cost asymmetry reasoning (not just 'CSAM is different').",
          "Pushes back on requirements where appropriate (e.g., streaming coverage density by risk tier) and treats them as negotiable.",
          "Closes with a one-sentence summary and explicitly lists what they'd cover with more time (multimodal, red-teaming, appeals).",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Running a large model or the LLM itself synchronously as the only classifier on every request — kills the latency budget and roughly doubles inference cost.",
      "One global confidence threshold for every harm category, with no fail-open/fail-closed distinction between CSAM and gray-area content.",
      "No mechanism for streaming output moderation beyond 'check it as it streams' — no windowing, no rolling context, no abort behavior.",
      "Classifying each conversation turn in complete isolation, missing multi-turn jailbreak drip entirely.",
      "Treating CSAM as just another ML confidence category instead of a deterministic hash-match with mandatory reporting.",
      "No numbers on human review queue capacity vs. borderline volume, so the queue is implicitly assumed to be infinite.",
      "No audit logging or policy versioning — thresholds baked into the classifier so every policy change requires a model redeploy.",
    ],
    followUps: [
      {
        q: "How do you moderate streaming output without adding latency to time-to-first-token?",
        a: "The window classifier runs in parallel with token generation, not in series before each token is emitted — the model keeps producing tokens while the previous window is being scored. Time-to-first-token is untouched because the first window's check overlaps with the generation of the next window's tokens. The only latency cost shows up on the rare path where a window trips: the stream aborts and a fallback is sent, which is a worse outcome for that one response but doesn't touch the common case.",
      },
      {
        q: "What happens if the moderation service itself goes down?",
        a: "This is exactly why fail-open/fail-closed is configured per category rather than globally. For most gray-area categories, an outage fails open with heavy logging — the product stays available, and every request during the outage gets flagged for priority async review once the service recovers. For hard-block categories, the answer isn't 'let the service go down and fail open' — it's making the deterministic layer (hash-matching, blocklist) highly available independently, since that layer alone can keep CSAM and other absolute prohibitions covered even if the probabilistic classifier tier is degraded.",
      },
      {
        q: "How do you handle multi-turn jailbreak attempts (jailbreak drip)?",
        a: "A per-conversation risk accumulator updates on every turn based on signals like rule-bypass framing, escalating hypotheticals, and roleplay wrapping, without re-scoring the entire conversation history each time. Once the accumulator crosses a soft threshold, the enforcement bar rises for subsequent turns in that conversation, so a request that would pass in a fresh conversation gets scrutinized harder mid-attempt. This keeps cost bounded (a small state update per turn) instead of scaling with conversation length like full-history reclassification would.",
      },
      {
        q: "Why not just use the LLM itself as the moderation classifier?",
        a: "Using the same LLM (or a peer-sized model) as a judge is accurate but expensive: it roughly doubles the inference cost per request and adds hundreds of milliseconds, which doesn't fit inside a ~20ms synchronous budget at 5K req/sec peak. It's also a chicken-and-egg risk — a model that can be jailbroken as a generator can potentially be manipulated as a judge with similar techniques. The design keeps LLM-as-judge as the async deep-classifier tier, scoring off the critical path where the latency and cost are affordable, and uses a small distilled classifier for the synchronous decision.",
      },
      {
        q: "How do you prevent the review queue from becoming a backlog during a coordinated abuse campaign?",
        a: "Queue depth is monitored as a first-class metric, not just reviewer throughput. When depth trends toward the capacity ceiling, thresholds can auto-tighten temporarily — shrinking the borderline band so more cases get an automated decision, trading some accuracy for queue stability — and the risk-profile store can apply stricter rate limits to accounts showing campaign-like patterns (many similar borderline requests in a short window), reducing the inflow at the source rather than only trying to add reviewer capacity reactively.",
      },
      {
        q: "How is CSAM handled differently from other harm categories?",
        a: "It's removed from the probabilistic pipeline entirely. Content is checked via perceptual hash-matching (PhotoDNA-style) against databases of known CSAM hashes; a match is a deterministic, unambiguous block with mandatory reporting to the relevant authority (NCMEC in the US) within the legally required window, running through a hard-coded compliance path with its own independent audit trail. This exists because a confidence-threshold approach implies a nonzero false-negative rate, which is legally and ethically unacceptable for this category — hash-matching only catches previously-identified content, so it's paired with, not a replacement for, the ML classifier and human review for novel material.",
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
          "This is a layered cascade sitting in front of and inside an LLM's request/response cycle: cheap deterministic checks first, a small fast classifier on the critical path, and an expensive accurate classifier plus human judgment pushed entirely off that path. The two genuinely hard problems — streaming output and multi-turn input — share one root cause: you're always moderating with incomplete information, because the harmful content, if any, isn't fully written yet.",
          "Anchor on the numbers: 50M requests/day, ~5K/sec peak, a ~300ms time-to-first-token budget that gives input moderation under 20ms, and a harm taxonomy where different categories tolerate wildly different false-negative rates. Every structural choice below follows from these facts, not from a generic 'add a safety filter' instinct.",
        ],
      },
      {
        heading: "Sizing and the cascade",
        body: [
          "A synchronous large model or LLM-as-judge on every request roughly doubles inference cost and blows the latency budget, so the request path uses a small distilled classifier (tens of millions of parameters, single-digit ms) preceded by a microsecond-cost deterministic blocklist and hash-match layer. Together those two layers resolve the vast majority of traffic; only the fraction they can't confidently resolve continues to the async deep classifier and, if still ambiguous, to human review.",
          "The cascade's economics only work because each layer sees a shrinking slice of traffic: nearly everything exits at layer 0 or 1, a small fraction reaches the deep classifier, and a much smaller borderline slice reaches humans. Sizing the borderline band correctly is what keeps the whole system affordable.",
        ],
      },
      {
        heading: "Streaming output: moderating a response that doesn't exist yet",
        body: [
          "Output moderation can't wait for the full completion without defeating streaming, so it classifies rolling windows of ~25-30 tokens (about a sentence) roughly every 150-250ms, run in parallel with token generation so it never adds to time-to-first-token. Each window is scored alongside a rolling summary of prior output — not in isolation — because a violation can span a window boundary and look benign in either half alone.",
          "When a window trips a threshold, the stream aborts immediately: buffered-but-unsent tokens are discarded and a canned fallback replaces them, because partial harmful output can't be safely edited in place. The window-size trade-off is real — smaller windows catch cutoffs sooner but miss cross-window context and add classifier overhead; larger windows have more context but expose more content before the abort.",
        ],
      },
      {
        heading: "Multi-turn context and the risk accumulator",
        body: [
          "Jailbreak drip spreads a violation across several conversation turns, each individually below threshold, which defeats a stateless per-turn classifier. Re-scoring the full transcript every turn would catch it but scales cost and latency with conversation length, which doesn't work at 5K/sec with long-running conversations.",
          "The fix is a compact per-conversation risk accumulator, stored alongside the per-user risk profile, that updates cheaply on each turn based on signals like rule-bypass framing or escalating hypotheticals, and raises the enforcement bar for later turns once early signals accumulate — bounded cost, catches the pattern a stateless classifier misses.",
        ],
      },
      {
        heading: "Fail-open vs fail-closed, and the review queue",
        body: [
          "Different harm categories carry different costs when the system is wrong. CSAM and imminent-harm content are fail-closed and, for CSAM specifically, enforced through deterministic perceptual hash-matching rather than a confidence threshold at all — a probabilistic classifier is never the last line of defense on an absolute prohibition. Gray-area categories are fail-open with monitoring, biased toward not over-refusing legitimate requests, since the false-positive cost there is UX, not safety.",
          "The borderline confidence band routes to human review, and that queue has to be sized against real numbers: roughly 0.05% of 50M requests/day is ~25K/day, and 250 reviewers at ~120 adjudications/day each is ~30K/day capacity — a real but thin margin that a coordinated abuse campaign targeting the gray zone can overrun within hours if thresholds aren't monitored and auto-tightened under load.",
        ],
      },
      {
        heading: "Compliance, audit, and the feedback loop",
        body: [
          "Every decision — block, allow, flag — is logged to an append-only compliance store with the policy version, classifier model version, and per-category confidence scores, retained for a multi-year compliance window independent of the mutable review queue. CSAM matches trigger a hard-coded, non-optional reporting path (NCMEC in the US) with its own audit trail, entirely outside the general confidence-threshold machinery.",
          "Human review decisions don't just resolve individual cases — they become labeled training data fed back weekly into both the fast and deep classifiers, which is what makes review-queue volume shrink over time relative to traffic instead of growing with it. That closed loop, plus policy thresholds living in versioned config decoupled from classifier deploys, is what lets the system adapt to new abuse patterns without a full redeploy cycle.",
        ],
      },
    ],
  },
};
