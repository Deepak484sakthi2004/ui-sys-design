import type { Problem } from "@/lib/types";

export const llmEvaluation: Problem = {
  slug: "llm-evaluation",
  num: "7.10",
  title: "Design an LLM Evaluation Platform",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a platform that evaluates LLM-powered features before and after they ship: run 60K test-case executions per day across golden datasets, model versions, and prompt versions, grade outputs with rule-based, embedding, and LLM-as-judge scorers, detect statistically significant regressions inside a 30-minute nightly window, and gate pull-request merges on a 5-minute smoke suite — all while controlling cost against rate-limited third-party model APIs.",
  ],
  hardParts:
    "The hard parts: LLM outputs are non-deterministic, so a single failing test case is not proof of a regression; using an LLM to grade LLM output (LLM-as-judge) introduces its own bias that has to be calibrated against humans on an ongoing basis; and running thousands of rate-limited, expensive model calls without blowing either the CI latency budget or the API bill.",
  keyTopics: [
    "LLM-as-Judge Calibration",
    "Statistical Regression Detection",
    "Durable Workflow Orchestration",
    "Multi-Provider Rate Limiting",
    "Production Shadow Evaluation",
  ],
  foundationsReferenced: [
    { label: "Temporal / Durable Execution", tone: "purple" },
    { label: "Kafka", tone: "orange" },
    { label: "Bootstrap Confidence Intervals", tone: "blue" },
    { label: "Token Bucket Rate Limiting", tone: "green" },
    { label: "ClickHouse", tone: "orange" },
    { label: "Idempotency Keys", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "CI job · SDK · dashboard user", col: 1, row: 1, tone: "slate" },
      { id: "api", label: "Eval API", sub: "submit run · list runs", col: 2, row: 1, tone: "green" },
      {
        id: "orchestrator",
        label: "Orchestrator",
        sub: "durable · retries",
        mono: "Temporal workflow",
        col: 3,
        row: 1,
        tone: "purple",
      },
      { id: "gateway", label: "Model Gateway", sub: "rate limit · cache · retry", col: 4, row: 1, tone: "blue" },
      { id: "providers", label: "Model Providers", sub: "OpenAI · Anthropic · Bedrock", col: 5, row: 1, tone: "slate" },
      { id: "queue", label: "Job Queue", sub: "Kafka · per-case tasks", col: 3, row: 2, tone: "orange" },
      { id: "workers", label: "Worker Pool", sub: "stateless · autoscale", col: 4, row: 2, tone: "green" },
      { id: "scorers", label: "Scorer Service", sub: "rule · embedding · LLM-judge", col: 5, row: 2, tone: "purple" },
      { id: "results", label: "Results Store", sub: "Postgres + ClickHouse", col: 2, row: 3, tone: "blue" },
      { id: "regression", label: "Regression Detector", sub: "bootstrap CI vs baseline", col: 3, row: 3, tone: "orange" },
      { id: "dashboard", label: "Dashboard", sub: "score trends, CI gate status", col: 1, row: 3, tone: "green" },
    ],
    edges: [
      { from: "client", to: "api", label: "submit run", kind: "write" },
      { from: "api", to: "orchestrator", label: "create workflow", kind: "write" },
      { from: "orchestrator", to: "queue", label: "enqueue test cases", kind: "write" },
      { from: "queue", to: "workers", label: "pull batch", kind: "write" },
      { from: "workers", to: "gateway", label: "prompt + params", kind: "write" },
      { from: "gateway", to: "providers", label: "rate-limited call", kind: "write" },
      { from: "workers", to: "scorers", label: "raw output", kind: "write" },
      { from: "scorers", to: "results", label: "scores + metadata", kind: "write" },
      { from: "scorers", to: "gateway", label: "LLM-judge call", kind: "analytics" },
      { from: "results", to: "regression", label: "compare vs baseline", kind: "analytics" },
      { from: "regression", to: "orchestrator", label: "pass/fail → CI gate", kind: "analytics" },
      { from: "results", to: "dashboard", label: "query trends", kind: "read" },
      { from: "client", to: "dashboard", label: "view results", kind: "read" },
    ],
    legend: [
      { kind: "write", text: "write path · executing an eval run end-to-end" },
      { kind: "read", text: "read path · querying stored results" },
      { kind: "analytics", text: "analytics · judge grading + regression detection, never blocks a run" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "api", "orchestrator"],
      say: "Start with the control plane: a client — a CI job, the SDK, or a dashboard user — submits a run to the Eval API, which hands it to a durable orchestrator. Nothing executes yet; this is just deciding what needs to happen and how to survive a crash midway through it.",
    },
    {
      reveal: ["queue", "workers", "gateway", "providers"],
      say: "The orchestrator fans a run out into one task per test case on a Kafka queue. A stateless, autoscaled worker pool pulls batches and calls a model through a rate-limited Model Gateway to the actual providers — OpenAI, Anthropic, Bedrock — so no single provider's throttling stalls the others.",
    },
    {
      reveal: ["scorers", "results"],
      say: "Every raw output goes to the Scorer Service — rule-based, embedding, or LLM-as-judge, whichever fits the criteria — and the resulting score, with full lineage back to the exact dataset/prompt/model version, lands immutably in the Results Store.",
    },
    {
      reveal: ["regression", "dashboard"],
      say: "A Regression Detector compares this run's score distribution against the baseline with a bootstrap confidence interval and reports pass/fail back to the orchestrator to gate CI, while a Dashboard queries the same results store for score trends — neither one ever sits on the run-execution path.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Define and version golden test-case datasets (input + expected output/rubric)", tag: "P0" },
      { id: "FR-02", text: "Submit an eval run for a given model version + prompt version + dataset version", tag: "P0" },
      { id: "FR-03", text: "Score outputs with pluggable scorers: exact-match/regex/schema, embedding similarity, LLM-as-judge", tag: "P0" },
      { id: "FR-04", text: "Detect statistically significant regressions against a baseline run, not raw score deltas", tag: "P0" },
      { id: "FR-05", text: "Gate CI/CD merges on a smoke eval suite completing within a time budget", tag: "P0" },
      { id: "FR-06", text: "Track full experiment lineage: which prompt/model/dataset version produced which score, reproducibly", tag: "P0" },
      { id: "FR-07", text: "Support multiple model providers behind one interface, each with its own rate limits", tag: "P0" },
      { id: "FR-08", text: "Route judge disagreements or low-confidence scores to a human review queue", tag: "P1" },
      { id: "FR-09", text: "Continuously sample production traffic for asynchronous shadow evaluation", tag: "P1" },
      { id: "FR-10", text: "Dashboard of score trends over time, sliceable by model, prompt, and dataset version", tag: "P1" },
      { id: "FR-11", text: "Re-run a failed or flaky test case with retry and idempotent scoring", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "PR smoke-suite gate latency, end to end", tag: "p99 < 5 min" },
      { id: "NFR-02", text: "Full nightly regression suite (10K cases) completion time", tag: "< 30 min" },
      { id: "NFR-03", text: "Per test-case latency, generation + judge round trip", tag: "p99 < 30s" },
      { id: "NFR-04", text: "Sustained eval throughput (smoke + nightly + shadow)", tag: "60K/day" },
      { id: "NFR-05", text: "Judge-vs-human agreement rate on the calibration gold set", tag: "> 85%" },
      { id: "NFR-06", text: "Durability of stored scores and traces (audit/compliance)", tag: "zero loss" },
      { id: "NFR-07", text: "Cache hit rate on repeated prompt+params+model tuples", tag: "> 30%" },
      { id: "NFR-08", text: "Eval control-plane availability", tag: "99.9%" },
      { id: "NFR-09", text: "Dashboard read queries vs. eval-run writes", tag: "20:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: what does a nightly run actually cost?",
      body: [
        "Before picking any infrastructure, size the workload in model calls, because that number drives everything downstream: worker pool size, rate-limit budgeting, and the API bill. The nightly full regression suite covers 10,000 test cases across 20 product-area suites. To handle non-determinism (more on that next), each case is sampled 3 times, and every sample gets graded once.",
        "That is 10,000 × 3 = 30,000 generation calls, plus 30,000 judge calls, for 60,000 model calls per nightly run. The PR smoke suite is smaller and single-sampled: 500 cases × 1 sample × 2 calls (generate + judge) = 1,000 calls, run on roughly 50 PRs a day, so 50,000 calls a day just from smoke gating. That alone is 110,000 raw model calls a day from CI gating; shadow evaluation adds roughly 5,000 more judge-only calls (production already generated the output, so shadow only pays for scoring, not generation) for ~115,000 calls a day total, at a blended cost around $0.015/call, roughly $1,500-2,000/day in third-party API spend for evaluation alone — before the product's own inference bill.",
      ],
      bullets: [
        { lead: "Nightly full suite", text: "10,000 cases × 3 samples = 30,000 generations + 30,000 judge calls = 60,000 calls, budgeted to finish inside 30 minutes." },
        { lead: "PR smoke suite", text: "500 cases × 1 sample × 2 calls ≈ 1,000 calls per PR, budgeted to finish inside 5 minutes so it doesn't stall merges." },
        { lead: "Aggregate", text: "~115K calls/day across smoke + nightly + shadow sampling — the number that sizes the worker pool and the rate-limit budget, not 'a lot of API calls'." },
      ],
      pictureTitle: "Where do 60,000 nightly calls come from?",
      pictureCaption: "10,000 cases × 3 samples = 30K generations, each graded once = 30K judge calls, total 60K",
      pictureRows: [
        { label: "10K cases × 3 samples", value: "30K generation calls", tone: "neutral" },
        { label: "30K generations × 1 judge each", value: "30K judge calls", tone: "neutral" },
        { label: "Nightly total", value: "60K calls, target < 30 min", tone: "good" },
      ],
      remember: {
        problem: "Is 'run the eval suite' a small job or a capacity-planning problem?",
        solution: "10K cases × 3 samples nightly = 60K model calls; 500-case smoke suite × 50 PRs/day = 50K more — size the worker pool and rate-limit budget from these numbers.",
        why: "Every downstream decision (worker count, per-provider rate limits, cache targets) is a consequence of the call volume, not a guess.",
        tradeoff: "More samples per case improves statistical confidence but multiplies cost and wall-clock time linearly.",
        failure: "Undersizing the worker pool for 60K calls in 30 minutes means the nightly run silently slips into the next business day.",
        mitigation: "Size worker concurrency and per-provider rate-limit budget directly from the call-volume math, and alert when a run's actual duration drifts from the 30-minute target.",
      },
    },
    {
      n: 2,
      title: "Non-determinism: why a single sample is a coin flip",
      body: [
        "An LLM at any non-zero temperature can return a different answer to the exact same prompt on two consecutive calls. That means a single pass/fail on one sample is not a measurement, it's a coin flip on borderline cases — two identical model+prompt runs can show a several-point swing in pass rate purely from sampling noise. Treating a single dropped test case as 'the regression' produces both false alarms and false confidence.",
        "The fix is to stop treating the score as a number and start treating it as a distribution. Take N=3 samples per test case, score each, and compare the aggregate distribution of this run against the baseline run using a bootstrap confidence interval: resample the per-case scores with replacement thousands of times, build a distribution of the aggregate metric, and only flag a regression if the two runs' confidence intervals don't overlap by more than a minimum detectable effect.",
      ],
      bullets: [
        { lead: "Single-sample pass/fail", text: "cheapest, but a borderline case flips outcome run to run — the noise floor can exceed the real signal you're trying to detect. Rejected as the sole method." },
        { lead: "Fixed hard threshold", text: "'score must be > 0.9' ignores both baseline drift and sample size, and gives no sense of how confident the pass/fail actually is. Rejected alone." },
        { lead: "Majority vote of N samples", text: "better, still collapses the distribution to one bit per case and throws away the variance information needed to size a confidence interval." },
        { lead: "Bootstrap CI over N samples", text: "keeps the full distribution, only calls a regression when the CIs genuinely don't overlap. Winner." },
      ],
      pictureTitle: "Turning noisy samples into a defensible verdict",
      pictureRows: [
        { label: "1 sample, pass/fail", value: "coin flip on borderline cases", tone: "bad" },
        { label: "Fixed threshold (>0.9)", value: "ignores baseline drift and N", tone: "bad" },
        { label: "3 samples, majority vote", value: "better, but loses variance info", tone: "neutral" },
        { label: "3 samples, bootstrap CI vs baseline", value: "flags only non-overlapping CIs — WINNER", tone: "good" },
      ],
      remember: {
        problem: "Decide whether a score dropped for real, or from sampling noise.",
        solution: "Sample each test case N=3 times, then compare this run's bootstrap confidence interval against the baseline's, not the point estimates.",
        why: "LLM outputs are non-deterministic; a single sample's pass/fail carries sampling variance large enough to look like a fake regression or hide a real one.",
        tradeoff: "More samples per case tighten the confidence interval but linearly multiply cost and run time.",
        failure: "Gating a merge on a single-sample pass rate causes flaky CI: the same code passes one run and fails the next.",
        mitigation: "Bootstrap resampling with a minimum-detectable-effect threshold, and treat 'CIs overlap' as 'no regression', not 'inconclusive, block anyway'.",
      },
    },
    {
      n: 3,
      title: "LLM-as-judge: necessary, biased, and calibrated on a loop",
      body: [
        "Deterministic scorers (exact-match, regex, JSON-schema validation) are cheap and reliable but can't grade open-ended quality — tone, helpfulness, factual correctness of free text. Embedding similarity catches semantic drift but has no notion of a rubric. For open-ended criteria you need an LLM to grade the LLM's output against a rubric prompt — LLM-as-judge — but the judge has its own well-documented biases: position bias (favoring whichever answer is shown first), verbosity bias (favoring longer answers), and self-preference bias (a model family rating its own outputs more favorably than a competitor's).",
        "The judge is not trustworthy by default; it has to be calibrated against humans on an ongoing basis. Score a human-labeled gold set with the judge and track agreement, target above 85%. When agreement drops, or when the judge model version changes underneath you, retune the rubric prompt or the judge model before trusting any new scores it produces.",
      ],
      bullets: [
        { lead: "Deterministic scorers", text: "exact-match, regex, JSON-schema — use these whenever the output has a checkable structure; they're free of judge bias and cheap." },
        { lead: "Embedding similarity", text: "catches semantic drift between an answer and a reference, but says nothing about rubric adherence like tone or safety." },
        { lead: "LLM-as-judge", text: "flexible enough for nuanced criteria, but carries position, verbosity, and self-preference bias — use a judge model distinct from the model under test." },
        { lead: "Calibration loop", text: "score a human-labeled gold set, target > 85% judge-human agreement, and re-run calibration whenever the judge model version changes." },
        { lead: "Human review queue", text: "judge disagreements and low-confidence scores get routed to a human reviewer, and those labels feed the next calibration round." },
      ],
      pictureTitle: "Which scorer for which criteria?",
      pictureRows: [
        { label: "Structured output (JSON, format)", value: "deterministic scorer, no bias risk", tone: "good" },
        { label: "Semantic closeness to a reference", value: "embedding similarity", tone: "neutral" },
        { label: "Open-ended quality, tone, correctness", value: "LLM-as-judge, calibrated", tone: "used" },
        { label: "Judge left uncalibrated", value: "position/verbosity/self-preference bias goes unchecked", tone: "bad" },
      ],
      remember: {
        problem: "Grade open-ended LLM output without trusting an unverified LLM judge.",
        solution: "Deterministic scorers where the output is structured; LLM-as-judge only for open-ended criteria, calibrated against a human-labeled gold set (> 85% agreement).",
        why: "LLM judges have known, reproducible biases (position, verbosity, self-preference) that a one-time sanity check won't catch as models and prompts drift.",
        tradeoff: "Calibration and human review add ongoing operational cost, but an uncalibrated judge silently drifts and no one notices until a bad release ships.",
        failure: "Using the same model family as both system-under-test and judge lets self-preference bias mask real regressions.",
        mitigation: "Use a judge model distinct from the model under test, track agreement over time, and route disagreements to a human review queue that becomes the next calibration set.",
      },
    },
    {
      n: 4,
      title: "Durable orchestration: surviving a 10K-case batch",
      body: [
        "A plain for-loop script works for ten test cases and collapses at ten thousand: no retry story, no backpressure, and a single 429 from a provider kills the whole run with no record of what already finished. A basic queue-and-worker pool is better, but if a worker crashes mid-batch you lose track of which cases actually completed and risk double-charging a provider on retry.",
        "The fix is a durable workflow engine — Temporal is the canonical choice — where each test case is a workflow activity with automatic retry and backoff, workflow state survives worker crashes, and idempotency keys make retried side effects (a provider call, a score write) safe to repeat. Layer a per-provider token-bucket rate limiter inside the Model Gateway so one provider throttling at 500 req/min doesn't stall the whole batch; other providers keep making progress.",
      ],
      bullets: [
        { lead: "For-loop script", text: "no retry, no resumability — one API error and the entire nightly run is gone with no partial record. Rejected." },
        { lead: "Plain queue + workers", text: "parallelizes work but a crashed worker loses in-flight state; retries can double-execute a scored side effect. Rejected alone." },
        { lead: "Durable workflow engine (Temporal)", text: "each test case is a resumable activity with built-in retry/backoff; a crash resumes from the last completed step, not from zero. Winner." },
        { lead: "Per-provider token bucket", text: "isolates rate limits by provider inside the Model Gateway, so one provider's 429s throttle only that provider's lane, not the whole run." },
        { lead: "Idempotency keys", text: "make a retried generation or score write safe to repeat without double-billing a provider or double-counting a score." },
      ],
      pictureTitle: "What survives a worker crash mid-run?",
      pictureRows: [
        { label: "For-loop script", value: "entire run lost, no partial record", tone: "bad" },
        { label: "Plain queue + workers", value: "partial progress kept, but retries can double-execute", tone: "neutral" },
        { label: "Temporal workflow + idempotency keys", value: "resumes from last step, no duplicate side effects", tone: "good" },
      ],
      remember: {
        problem: "Run a 10,000-case, 30-minute batch job against flaky, rate-limited third-party APIs without losing progress.",
        solution: "Durable workflow orchestration (Temporal) with per-test-case retry/backoff, plus per-provider token-bucket rate limiting and idempotency keys on every side effect.",
        why: "A crash or a provider throttle is an expected event at this scale, not an edge case; the system has to resume, not restart.",
        tradeoff: "A workflow engine adds operational complexity versus a plain queue, in exchange for crash-safe resumability and exactly-once side effects.",
        failure: "A plain queue-and-worker script loses in-flight state on a crash and can double-charge a provider on naive retry.",
        mitigation: "Model every test-case execution as a durable, idempotent workflow activity; isolate rate limits per provider so one provider's throttling never stalls the others.",
      },
    },
    {
      n: 5,
      title: "CI gating tiers: fast enough to block, thorough enough to trust",
      body: [
        "A PR merge gate has a hard time budget, five minutes or the team stops trusting it and starts merging around it. A statistically defensible regression check needs multiple samples and a large dataset, which takes thirty minutes even with a large worker pool. Those two requirements cannot share one run.",
        "Split into two tiers. The smoke suite is a small, high-signal subset (500 cases), single-sampled, preferring deterministic scorers, and it blocks the PR. The full regression suite (10,000 cases, 3 samples, LLM-judge where needed) runs nightly, doesn't block anything, and pages the on-call if it regresses. This mirrors a tier hierarchy: the PR gate is tier-1 (fast, blocking), the nightly suite is tier-2 (thorough, paging), and production shadow evaluation is tier-3 (continuous, async, covered next).",
      ],
      bullets: [
        { lead: "One suite for everything", text: "either the PR gate is too slow to be usable, or the nightly suite is too thin to be statistically meaningful. Rejected." },
        { lead: "Smoke suite (PR-blocking)", text: "500 curated high-signal cases, single sample, deterministic scorers preferred, target < 5 min so it doesn't stall merges." },
        { lead: "Full regression suite (nightly)", text: "10,000 cases, 3 samples, LLM-judge for open-ended criteria, target < 30 min, pages on a detected regression instead of blocking anyone." },
        { lead: "Say which handles which", text: "the interviewer wants to hear the tier boundary stated explicitly, the same way redirect-vs-analytics tiers get stated in other systems." },
      ],
      pictureTitle: "Two suites, two jobs",
      pictureRows: [
        { label: "Smoke suite", value: "500 cases, 1 sample, blocks PR, < 5 min", tone: "good" },
        { label: "Full regression suite", value: "10K cases, 3 samples, pages on-call, < 30 min", tone: "good" },
        { label: "One suite for both", value: "too slow to gate, or too thin to trust", tone: "bad" },
      ],
      remember: {
        problem: "A statistically meaningful check and a fast PR gate can't both fit in one run.",
        solution: "Two-tier suite: a small single-sample smoke suite blocks the PR; a large multi-sample regression suite runs nightly and pages instead of blocking.",
        why: "Statistical confidence needs sample size and dataset breadth; a merge gate needs speed — different SLAs demand different infra, not one compromise run.",
        tradeoff: "Real regressions caught only by the full suite ship for up to a day before the nightly run flags them.",
        failure: "Forcing the full 10K-case suite onto every PR makes CI take 30+ minutes, and engineers start merging around a gate that's too slow to respect.",
        mitigation: "Keep the smoke suite curated and high-signal, and treat a nightly regression as a page, not a silent dashboard update.",
      },
    },
    {
      n: 6,
      title: "Production shadow evaluation: closing the feedback loop",
      body: [
        "A golden dataset only tests what someone already imagined could go wrong. Production traffic finds the failures nobody thought to write a test case for. Sample about 1% of live production requests (with PII redacted) — on the order of 5,000 sampled cases a day off a ~500K/day production request volume — and run them through the same scorer pipeline asynchronously — never on the user-facing request path, the same way click analytics never sits on a redirect.",
        "Shadow evaluation does two jobs: it catches regressions and silent model drift the offline suite missed — including a provider quietly swapping the model behind a version string — and it mines new golden test cases from real failures, feeding them back into the offline dataset so the smoke and nightly suites get sharper over time instead of going stale.",
      ],
      bullets: [
        { lead: "Never on the request path", text: "shadow eval samples and scores asynchronously; a scoring backlog or outage must never add latency to a live user request." },
        { lead: "Catches model drift", text: "a provider can update the model behind an unpinned version string; shadow eval scores dip even though nothing in your codebase changed." },
        { lead: "Feeds the offline suite", text: "real production failures become new golden test cases, so the dataset keeps up with how the product actually gets used." },
        { lead: "PII and sampling", text: "redact before storage, sample a fixed percentage rather than 'everything', both for cost and for data-handling compliance." },
      ],
      pictureTitle: "Why shadow eval never touches request latency",
      pictureRows: [
        { label: "On the request path", value: "a scoring outage adds latency to real users", tone: "bad" },
        { label: "Async, 1% sample", value: "user request unaffected, eval catches up separately", tone: "good" },
        { label: "Feedback into golden set", value: "real failures become new nightly test cases", tone: "good" },
      ],
      remember: {
        problem: "The offline golden dataset only tests failures someone already anticipated.",
        solution: "Asynchronously sample ~1% of production traffic, score it through the same pipeline, and feed real failures back as new golden test cases.",
        why: "Production is the only source of failures nobody wrote a test case for, and it's also the only way to catch a provider silently swapping the model behind a version string.",
        tradeoff: "Shadow eval adds pipeline complexity and PII-handling obligations for coverage the offline suite structurally cannot provide.",
        failure: "Skipping shadow eval means model drift and real-world edge cases go undetected until a user complains.",
        mitigation: "Redact and sample rather than capture everything, keep it fully off the request-serving path, and route confirmed shadow failures into the offline dataset.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a durable batch-execution pipeline: run a prompt against a model across thousands of test cases, score the outputs, and decide whether the score moved enough to matter.",
      "LLM outputs are non-deterministic, so every score is a distribution, not a number — regressions are judged with a bootstrap confidence interval against a baseline, not a single pass/fail.",
      "Using an LLM to grade LLM output (LLM-as-judge) is necessary for open-ended quality but carries its own bias, so it's calibrated against a human-labeled gold set on an ongoing basis.",
      "A fast smoke suite blocks PR merges; the thorough multi-sample regression suite runs nightly and pages instead of blocking, because statistical validity and a 5-minute CI budget can't both fit in the same run.",
      "Production shadow evaluation samples live traffic asynchronously, catching regressions and model drift the offline golden dataset never anticipated, and feeding them back in as new test cases.",
    ],
    flows: [
      {
        kind: "write",
        title: "WRITE · SUBMIT & EXECUTE AN EVAL RUN",
        summary: "A run is a durable workflow: enqueue every test case, execute it against the model through a rate-limited gateway, and score the raw output.",
        steps: [
          { label: "Client", note: "CI job or SDK submits a run" },
          { label: "Eval API", note: "records run metadata" },
          { label: "Orchestrator", note: "Temporal workflow, durable, retries" },
          { label: "Job Queue", note: "Kafka, one task per test case" },
          { label: "Worker Pool", note: "stateless, autoscaled" },
          { label: "Model Gateway", note: "per-provider rate limit + cache" },
          { label: "Scorer Service", note: "rule / embedding / LLM-judge" },
          { label: "Results Store", note: "Postgres + ClickHouse" },
        ],
      },
      {
        kind: "analytics",
        title: "ANALYTICS · JUDGE GRADING + REGRESSION DETECTION",
        summary: "Judge calls and statistical comparison run alongside the write path and never block it; a regression posts a decision back to CI.",
        steps: [
          { label: "Scorer Service", note: "LLM-judge call via Model Gateway" },
          { label: "Results Store", note: "per-case scores aggregated" },
          { label: "Regression Detector", note: "bootstrap CI vs. baseline run" },
          { label: "Orchestrator / CI", note: "pass/fail gate decision" },
        ],
      },
      {
        kind: "read",
        title: "READ · DASHBOARD & CI STATUS",
        summary: "Score trends and gate status are simple queries against the results store, decoupled from run execution.",
        steps: [
          { label: "Client", note: "opens the dashboard" },
          { label: "Results Store", note: "queried for trend + gate status" },
          { label: "Dashboard", note: "score-over-time chart, pass/fail badge" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "10,000-case nightly full regression suite; 500-case PR smoke suite",
          "3 samples/case on nightly → 30K generations + 30K judge calls = 60K model calls, < 30 min",
          "Smoke suite: 500 cases × 1 sample × 2 calls ≈ 1K calls per PR, < 5 min gate",
          "~60K test-case executions/day: 30K nightly + 25K smoke (500 × 50 PRs) + ~5K shadow (1% of ~500K/day prod traffic) — ~115K raw model calls/day once judge calls are counted",
          "Per-test-case p99 (generation + judge round trip): < 30s",
          "Judge-vs-human agreement target: > 85%",
          "Cache hit rate target on repeated prompt/param/model tuples: > 30%",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Deterministic scorers (exact-match/schema) where possible, LLM-as-judge only for open-ended criteria",
          "Multiple samples + bootstrap confidence interval, not a single pass/fail run",
          "Durable workflow engine (Temporal-style) over a plain queue-and-worker script",
          "Per-provider token-bucket rate limiting inside the Model Gateway, isolated per provider",
          "Two-tier suite: smoke blocks the PR, full regression runs nightly and pages instead of blocking",
          "Judge calibrated against a human-labeled gold set, re-calibrated on judge-model upgrades",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Non-determinism is the load-bearing risk: a single failing sample is not proof of a regression",
          "LLM-as-judge has known biases (position, verbosity, self-preference) — calibration is ongoing, not one-time",
          "PR gate is tier-1 (fast, blocking); nightly regression is tier-2 (thorough, pages on fail)",
          "Production shadow evaluation closes the loop: it feeds new golden test cases back into the offline suite",
          "Cost is a first-class constraint: cache identical calls, reserve judge calls for cases that actually need them",
          "A provider silently swapping the model behind a version string is caught by shadow eval + pinned snapshots",
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
      goal: "Before drawing anything, get the scope (CI gate vs. production monitoring vs. both) and five numbers on the board.",
      why: "The interviewer is checking whether you drive the design from data and scope, not vibes. Every later decision — sample count, suite split, worker pool size — falls out of these numbers.",
      steps: [
        { kind: "ASK", text: '**Is this gating CI/CD merges, monitoring production, or both?** Land on "both — a fast PR-blocking smoke suite plus continuous production shadow evaluation." Write **"CI gate + prod shadow"** top-left.' },
        { kind: "ASK", text: 'Next ask: **"How many test cases, and how many model/prompt versions ship per day?"** Land on "10K-case nightly full suite, 500-case PR smoke suite, ~50 PRs/day." Write the numbers down.' },
        { kind: "SAY", text: 'Propose the latency targets yourself: **"PR gate under 5 minutes"**, **"nightly full suite under 30 minutes"**, **"per-test-case p99 under 30 seconds"**. Wait for them to nod before writing it down.' },
        { kind: "SAY", text: 'State scope. In: "golden dataset versioning", "rule-based + LLM-judge scoring", "regression detection", "CI gating", "production shadow eval". Out: "model training/fine-tuning", "prompt-authoring UI", "billing". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the call-volume math out loud: **"10K cases × 3 samples = 30K generations + 30K judge calls = 60K calls nightly"**, **"500 cases × 50 PRs/day × 2 calls = 50K calls/day from smoke"**, **"blended ~$0.015/call ≈ $1.5-2K/day"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, scoping CI-gate vs. production monitoring explicitly, and sizing the call volume before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Three endpoints, an immutable per-sample score row, and the sample-count decision justified with numbers.",
      why: "The interviewer wants to see you commit to a small surface and defend the schema. An immutable score row per sample signals you understand the run is an audit trail, not a mutable status field.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /evals/runs { datasetVersion, promptVersion, modelVersion, suite }"** returns **"{ runId }"**. **"GET /evals/runs/:id"** returns **"{ status, aggregateScore, ciBounds }"**. **"POST /evals/datasets/:id/cases"** appends a versioned golden test case.' },
        { kind: "DRAW", text: 'Sketch the row: **"run_id, test_case_id, sample_index, dataset_version, prompt_version, model_version, raw_output, score, scorer_type, judge_model, created_at"**. Say it out loud: "Runs are immutable once scored — a re-run is a new run_id, never an overwrite, so the score history stays a trustworthy audit trail."' },
        { kind: "SAY", text: 'Justify sample count: "3 samples per case balances judge cost against variance — enough spread to run a bootstrap confidence interval without tripling cost again for a 4th or 5th sample."' },
        { kind: "RULE OUT", text: '"Storing only the aggregate score with no per-sample trace is undebuggable when a run regresses — you\'d have no idea which cases actually flipped." "Overwriting a run in place on re-run destroys the audit trail." Cross both off.' },
      ],
      grading: "Crisp endpoint names, an immutable per-sample schema, and the sample-count number defended with a reason, not just stated.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled paths: write (execute a run), analytics (judge + regression detection), and read (dashboard). Label arrows with volumes and budgets, not box names.",
      why: "Drawing execution, statistical analysis, and dashboard querying as separate lanes proves you understand they have different SLAs and must not block each other — exactly like a redirect service must never wait on click analytics.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write path**: Client → Eval API → Orchestrator (Temporal) → Job Queue → Worker Pool → Model Gateway → Providers. Label the arrows **"60K calls nightly"**, **"< 30 min"**, **"per-provider rate limit"**.' },
        { kind: "DRAW", text: 'Branch the **analytics path** off the Worker Pool: → Scorer Service → (judge call back through the Gateway) → Results Store → Regression Detector → back to Orchestrator, labeled **"bootstrap CI vs. baseline, never blocks the run"**.' },
        { kind: "DRAW", text: 'Add the **read path** as a separate lane: Client → Dashboard → Results Store, labeled **"score trends, CI gate status"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three jobs — execute the run, decide if it regressed, and let a human look at the trend — and none of them should block each other."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with call volume and time budget, and an explicit statement that judge grading and regression detection never block run execution.",
    },
    {
      n: 4,
      title: "Deep Dive: Non-Determinism and Statistical Regression Detection",
      minutes: 8,
      goal: "Show the sampling + bootstrap CI approach and defend it against single-sample pass/fail and fixed thresholds.",
      why: "This is the signature sub-problem. The interviewer is probing whether you understand that LLM output is a random variable and can quantify how you turn noisy samples into a defensible regression verdict.",
      steps: [
        { kind: "DRAW", text: 'Draw the sampling picture: each of the 10,000 cases gets **"N = 3 samples at temperature ~0.7"**, each sample scored independently, aggregated into a distribution, not a single number.' },
        { kind: "SAY", text: 'Explain the bootstrap CI: "Resample the per-case scores with replacement thousands of times to build a distribution of the aggregate score. Compare this run\'s confidence interval against the baseline run\'s. Only flag a regression if the intervals don\'t overlap by more than a minimum detectable effect."' },
        { kind: "SAY", text: 'Quantify the failure mode of skipping this: "Two identical model+prompt runs can show a several-point swing in pass rate purely from sampling noise — a single-sample gate would be flaky by construction."' },
        { kind: "RULE OUT", text: 'One line each: **single-sample pass/fail** → coin flip on borderline cases. **Fixed hard threshold** → ignores baseline drift and sample size. **Majority vote alone** → collapses the distribution, loses the variance needed for a CI.' },
      ],
      grading: "The sampling + bootstrap approach explained without prompting, a quantified statement of the noise problem, and a one-line rejection for each weaker alternative.",
    },
    {
      n: 5,
      title: "Deep Dive: LLM-as-Judge Calibration",
      minutes: 7,
      goal: "Walk the three scorer types, name the judge's specific biases, and describe the ongoing calibration loop.",
      why: "Anyone can say 'use an LLM to grade it'. The interviewer wants to hear the biases named specifically and a calibration loop that runs continuously, not a one-time sanity check.",
      steps: [
        { kind: "SAY", text: 'Walk the scorer types: "Deterministic scorers — exact-match, regex, JSON-schema — for structured output. Embedding similarity for semantic closeness. LLM-as-judge with a rubric prompt only for open-ended quality criteria."' },
        { kind: "SAY", text: 'Name the judge biases explicitly: "Position bias favors whichever answer is shown first. Verbosity bias favors longer answers. Self-preference bias means a model rates its own family\'s outputs more favorably." Say all three unprompted.' },
        { kind: "SAY", text: 'Explain the calibration loop: "Score a human-labeled gold set with the judge, target above 85% agreement. When agreement drops, or the judge model version changes, retune the rubric prompt or judge model before trusting new scores."' },
        { kind: "SAY", text: 'Close with the review queue: "Judge disagreements and low-confidence scores route to a human review queue, and those labels become the next calibration round — it\'s a loop, not a one-time check."' },
      ],
      grading: "All three judge biases named without prompting, the calibration target quantified (>85% agreement), and the human review queue framed as feeding a continuous loop.",
    },
    {
      n: 6,
      title: "Wrap: Tiers, Cost, and Close",
      minutes: 5,
      goal: "Name the tier hierarchy, bring up cost control unprompted, push back on a requirement, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: explicit tiers used to justify trade-offs, cost treated as a first-class constraint, and a close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: '"PR gate is tier-1 — blocking, fast, cheap. Nightly full regression is tier-2 — thorough, pages instead of blocking. Production shadow eval is tier-3 — continuous and fully async." State all three unprompted.' },
        { kind: "SAY", text: 'Bring up cost control unprompted: "Cache identical prompt+params+model tuples, reserve judge calls for criteria that actually need them, sample shadow traffic at 1% not 100%."' },
        { kind: "SAY", text: 'Push back where useful: "Do we really need a 10K-case nightly suite, or does score stability let us rotate a third of it each night and still catch regressions inside a week?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a durable, statistically honest eval pipeline: golden dataset plus live shadow traffic, scored by rule-based and calibrated LLM judges, gating CI on a fast tier and monitoring the rest asynchronously. With more time I\'d cover safety/red-team evals and multi-turn conversation scoring."' },
      ],
      grading: "Explicit tier hierarchy stated unprompted, cost control volunteered with numbers, at least one push-back on requirements, and a crisp closing summary with parked items.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working eval pipeline that mostly hangs together, but treats scores as single numbers and the judge as trustworthy by default.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists a golden dataset and a scoring function, usually exact-match or a single LLM-judge call.",
          "Knows to run evals before deploying a new prompt or model version.",
          "Suggests storing results in a database and showing them on a dashboard.",
          "Picks a queue to run test cases in parallel instead of a serial loop.",
          "Handles 'how do you grade free-text output' by saying 'use an LLM to grade it'.",
        ],
        gaps: [
          "Treats a single run or sample as the definitive score, no notion of variance.",
          "No calibration story for the LLM judge — assumes its output is just correct.",
          "No retry/idempotency plan for a large batch; a single API error abandons the whole run.",
          "CI gate story is vague — 'run the evals in CI' with no time-budget tiering.",
          "No cost control story: every PR would call every provider on the full dataset.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, separates scorer types by criteria, and reaches for statistical significance and durability when pushed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Separates deterministic scorers from LLM-as-judge, using each for the criteria it actually fits.",
          "Uses multiple samples per test case and talks about statistical significance instead of a single flaky run.",
          "Splits a smoke suite (PR-gating, fast) from a full regression suite (nightly, thorough).",
          "Reaches for a durable workflow engine, or at minimum discusses retries and idempotency for the batch job.",
          "Adds a per-provider rate limiter so one provider's throttling doesn't stall the whole run.",
          "Calibrates the judge against a human-labeled gold set and tracks agreement rate.",
          "Mentions caching identical prompt/param/model calls to control cost.",
        ],
        gaps: [
          "Names 'statistical significance' but doesn't specify the actual method (bootstrap CI, minimum detectable effect) until pushed.",
          "Doesn't volunteer production shadow evaluation unprompted — treats the offline golden dataset as sufficient on its own.",
          "Cost control is mentioned but not quantified — no $/day estimate, no cache-hit-rate target.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats non-determinism as the central design risk, and brings an operational feedback loop that goes beyond the pipeline itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers non-determinism as the load-bearing risk and quantifies it (N samples, bootstrap CI, minimum detectable effect) before being asked.",
          "Names LLM-judge biases explicitly (position, verbosity, self-preference) and describes an ongoing calibration loop, not a one-time check.",
          "Frames PR-gate vs. nightly-regression as an explicit tier system, the same way a redirect vs. analytics pipeline gets tiered.",
          "Brings up production shadow evaluation unprompted as the feedback loop that keeps the golden dataset honest.",
          "Quantifies the platform's own cost ($/day, cache-hit-rate target) as a first-class design constraint, not an afterthought.",
          "Discusses what happens when a provider silently swaps the model behind a version string, and how shadow eval plus pinned snapshots catch it.",
          "Closes with a crisp summary and explicitly parks items — safety/red-team evals, multi-turn conversation scoring — for follow-up.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Treating a single pass/fail on one sample as ground truth, with no acknowledgment of sampling variance.",
      "Using the same model as both the system under test and the judge with no calibration against humans (self-preference bias goes unchecked).",
      "Putting the full multi-sample regression suite directly on the PR-merge critical path, making CI take 30+ minutes.",
      "No idempotency or retry story for a 10K-case batch job — one 429 or one crashed worker loses the whole run.",
      "Storing only aggregate scores with no per-test-case trace, making a regression undebuggable.",
      "Never sampling production traffic, so the eval suite only ever tests what someone already imagined could go wrong.",
      "No cost visibility — the eval platform's own API bill grows unnoticed until it rivals the product's inference bill.",
    ],
    followUps: [
      {
        q: "How do you know a score difference is a real regression and not just noise from LLM non-determinism?",
        a: "Sample each test case multiple times (N=3 in this design), then compute a bootstrap confidence interval on the aggregate score for both the current run and the baseline run by resampling the per-case scores with replacement thousands of times. Only call it a regression if the two confidence intervals don't overlap by more than a chosen minimum detectable effect. A raw point-estimate drop with overlapping CIs is noise, not signal, and should not fail the build.",
      },
      {
        q: "Why not just use a bigger, smarter model as the judge for everything?",
        a: "A stronger judge model still carries the same class of biases — position, verbosity, and especially self-preference bias if it's from the same model family as the system under test — so it still needs calibration against a human-labeled gold set regardless of size. It's also slower and more expensive per call, which matters at 30K+ judge calls a night, so deterministic scorers are preferred wherever the output is structured enough to check directly, reserving the expensive judge for genuinely open-ended criteria.",
      },
      {
        q: "What happens when a model provider silently updates the model behind the same API name or version?",
        a: "This is exactly what production shadow evaluation is built to catch: scores on live traffic drift even though nothing in your own prompt or code changed, which is the tell. Mitigate by pinning to dated model snapshots where the provider offers them, and treat an unexplained shadow-eval score dip as an incident to investigate, not just a dashboard blip.",
      },
      {
        q: "How do you keep the PR gate fast without making it statistically meaningless?",
        a: "Split into two tiers. The smoke suite is a small, curated, high-signal subset — 500 cases, single-sampled, preferring deterministic scorers — and it blocks the PR within a 5-minute budget. The full multi-sample regression suite (10K cases, 3 samples, LLM-judge) runs nightly outside the critical path and pages the on-call on a detected regression instead of blocking every merge. Real regressions the smoke suite misses ship for up to a day, which is the explicit trade-off for a usable CI gate.",
      },
      {
        q: "How do you control API cost at this scale?",
        a: "Cache identical (prompt, params, model) tuples so unrelated PRs that touch unchanged code don't repay for the same generation — targeting a 30%+ cache hit rate. Use cheaper, faster models for the smoke suite and for deterministic scoring, and reserve the more expensive judge model for genuinely open-ended criteria. Keep production shadow evaluation to a 1% sample rather than mirroring all traffic. Track $/day as a dashboard metric, not just latency and pass rate.",
      },
      {
        q: "What if the LLM judge and a human reviewer disagree on a score?",
        a: "Route the case to a human review queue and record the human's label as ground truth for that case. That disagreement becomes new data for the next calibration round against the judge's gold set. If disagreements cluster around a specific criterion or test-case type, treat it as a signal that the rubric prompt itself needs tightening, not just a one-off scoring error to overwrite.",
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
          "This is a durable batch-execution pipeline that turns (prompt version, model version, dataset version) into a statistically defensible score. The core operation — run a test case, grade the output, compare to a baseline — is simple; everything expensive (sampling, judge calibration, durable orchestration, tiered gating) exists to make that comparison trustworthy at 60K executions a day against non-deterministic, rate-limited, third-party model APIs.",
          "Anchor everything on the call-volume math: 10,000 nightly cases × 3 samples = 60,000 model calls in a 30-minute window, plus 500-case smoke suites on ~50 PRs a day. Every structural choice below is a consequence of those numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing: what a nightly run actually costs",
        body: [
          "10,000 test cases sampled 3 times each is 30,000 generation calls; each sample graded once is 30,000 more judge calls, for 60,000 calls per nightly run. The PR smoke suite adds roughly 1,000 calls per PR across ~50 PRs a day, another 50,000 calls, and shadow evaluation adds a further ~5,000 judge-only calls scoring already-generated production traffic — on the order of $1,500-2,000/day in third-party API spend for evaluation alone at a blended ~$0.015/call.",
          "That volume sizes the worker pool: clearing 60,000 nightly calls inside a 30-minute window needs roughly 2,000 calls/min of sustained throughput, well above what a single provider's rate limit can absorb alone. That's why the token bucket is per-provider rather than global — generation spreads across whichever providers are under test, and the judge model's own channel is provisioned for the largest share, since every sample needs a judge call regardless of which provider generated it. This also motivates every cost lever downstream: caching, tiering, and shadow-sampling at 1% instead of mirroring all production traffic.",
        ],
      },
      {
        heading: "Non-determinism and statistical regression detection",
        body: [
          "An LLM at non-zero temperature returns different output to the same prompt on different calls, so a single sample's pass/fail carries enough noise to look like a fake regression or hide a real one. The fix is to sample each case multiple times (N=3), score each sample, and compare the resulting distributions between the current run and the baseline using a bootstrap confidence interval — resample with replacement, build a distribution of the aggregate metric, and only flag a regression when the two runs' intervals fail to overlap by more than a minimum detectable effect.",
          "This is the load-bearing statistical idea in the whole design: a raw score drop with overlapping confidence intervals is noise and must not fail a build; a drop with non-overlapping intervals is a real signal worth paging someone over.",
        ],
      },
      {
        heading: "LLM-as-judge and the calibration loop",
        body: [
          "Deterministic scorers (exact-match, regex, JSON-schema) handle structured output cheaply and without bias risk. Embedding similarity catches semantic drift from a reference answer. Open-ended criteria — tone, helpfulness, factual correctness of free text — need an LLM judge grading against a rubric prompt, but that judge carries position bias, verbosity bias, and self-preference bias (rating its own model family's outputs more favorably).",
          "Calibration is not a one-time gate: score a human-labeled gold set with the judge, target above 85% agreement, and re-run calibration whenever the judge model version changes or agreement drifts. Judge disagreements and low-confidence scores route to a human review queue, and those human labels become the next round's calibration data — a continuous loop, not a launch-day checkbox.",
        ],
      },
      {
        heading: "Durable orchestration and multi-provider rate limiting",
        body: [
          "A 10,000-case, 60,000-call batch against flaky, rate-limited third-party APIs will hit a crashed worker or a provider throttle as a matter of course, not an edge case. A durable workflow engine (Temporal) models each test case as a resumable activity with automatic retry and backoff, so a crash resumes from the last completed step instead of losing the whole run.",
          "Inside the Model Gateway, a per-provider token-bucket rate limiter isolates throttling by provider, so one provider's 429s slow only that provider's lane while the others keep making progress. Idempotency keys on every side effect (a generation call, a score write) make retries safe to repeat without double-billing a provider or double-counting a score.",
        ],
      },
      {
        heading: "CI gating tiers and production shadow evaluation",
        body: [
          "A merge gate needs speed (a 5-minute budget or engineers merge around it); a defensible regression check needs sample size and breadth (30 minutes even with a large worker pool). Splitting into a small, single-sampled, PR-blocking smoke suite and a large, multi-sampled, nightly-paging regression suite resolves the conflict — tier-1 blocking, tier-2 thorough-and-async.",
          "Production shadow evaluation is the third tier: asynchronously sample about 1% of live traffic, score it through the same pipeline off the request path, and use it both to catch what the offline golden dataset never anticipated (including silent model drift when a provider swaps the model behind a version string) and to mine new golden test cases from real failures, keeping the offline suite from going stale.",
        ],
      },
    ],
  },
};
