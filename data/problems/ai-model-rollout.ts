import type { Problem } from "@/lib/types";

export const aiModelRollout: Problem = {
  slug: "ai-model-rollout",
  num: "7.12",
  title: "Design AI Model Rollout & Monitoring",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a platform that safely rolls out new versions of ML models serving 200K inference requests/sec across a fleet of 500+ production models, running 50+ rollouts a week, with automatic canary analysis that catches quality regressions within 5 minutes and rolls a bad model back before it ever reaches all of production traffic — without engineers hand-writing bespoke rollback logic per model.",
  ],
  hardParts:
    "The hard parts: catching real regressions in canary metrics that are noisy at 1% traffic without crying wolf or waiting too long to react, joining predictions to ground-truth outcomes that can arrive minutes to months later, and keeping the feature computation used at serving time bit-for-bit consistent with what the model was trained on.",
  keyTopics: [
    "Progressive Canary Rollout",
    "Shadow Traffic Mirroring",
    "Sequential Statistical Guardrails",
    "Delayed Ground-Truth Joining",
    "Feature/Prediction Drift Detection",
  ],
  foundationsReferenced: [
    { label: "Feature Stores (Feast)", tone: "purple" },
    { label: "Kafka & Stream Processing (Flink)", tone: "orange" },
    { label: "A/B Testing & Statistical Power", tone: "green" },
    { label: "Consistent Hashing", tone: "blue" },
    { label: "Time-Series & OLAP Stores (Prometheus/ClickHouse)", tone: "purple" },
    { label: "Blue-Green & Canary Deployments", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "registry", label: "Model Registry", sub: "versioned artifacts + metadata", col: 1, row: 1, tone: "purple" },
      { id: "controller", label: "Rollout Controller", sub: "stage gates · auto-rollback", col: 2, row: 1, tone: "purple" },
      { id: "router", label: "Traffic Router", mono: "consistent hash → bucket", col: 3, row: 1, tone: "purple" },
      { id: "client", label: "Upstream Caller", col: 1, row: 2, tone: "slate" },
      { id: "gateway", label: "Inference Gateway", sub: "200K req/s", col: 2, row: 2, tone: "green" },
      { id: "champion", label: "Champion Pool", sub: "stable · current majority", col: 3, row: 2, tone: "green" },
      { id: "challenger", label: "Challenger Pool", sub: "canary · ramps 1%→100%", col: 4, row: 2, tone: "green" },
      { id: "featurestore", label: "Online Feature Store", sub: "Feast · p99 < 10ms", col: 5, row: 2, tone: "blue" },
      { id: "kafka", label: "Prediction Log (Kafka)", sub: "features + version + output", col: 2, row: 3, tone: "orange" },
      { id: "flink", label: "Stream Processor (Flink)", mono: "PSI/KL drift · predictions ⋈ delayed outcomes", col: 3, row: 3, tone: "orange" },
      { id: "canary", label: "Canary Analysis Engine", sub: "sequential testing", col: 4, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "gateway", kind: "read" },
      { from: "registry", to: "controller", label: "new model version", kind: "write" },
      { from: "controller", to: "router", label: "stage: 1%→5%→25%→50%→100%", kind: "write" },
      { from: "router", to: "gateway", label: "routing config", kind: "write" },
      { from: "gateway", to: "champion", label: "stable traffic", kind: "read" },
      { from: "gateway", to: "challenger", label: "canary %", kind: "read" },
      { from: "champion", to: "featurestore", kind: "read" },
      { from: "challenger", to: "featurestore", kind: "read" },
      { from: "gateway", to: "kafka", label: "log every prediction", kind: "analytics" },
      { from: "kafka", to: "flink", kind: "analytics" },
      { from: "flink", to: "canary", label: "latency/error/drift/outcome metrics", kind: "analytics" },
      { from: "canary", to: "controller", label: "guardrail verdict → halt/rollback", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "inference path · 200K req/s" },
      { kind: "write", text: "control plane · rollout stage changes" },
      { kind: "analytics", text: "monitoring loop · never blocks inference" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "gateway", "champion"],
      say: "Strip away every rollout concept and this is a normal serving path: a stateless gateway forwards each request to whichever model version is currently live, the champion. At 200K req/s, this pool alone has to clear sub-50ms p99 before we add a single rollout mechanic.",
    },
    {
      reveal: ["featurestore"],
      say: "The model can't score anything without features, so every pool reads from one online feature store — Feast, p99 under 10ms — and that's the same store training reads from offline, which is the first defense against training-serving skew.",
    },
    {
      reveal: ["registry", "controller", "router", "challenger"],
      say: "Now the actual rollout: a new version lands in the Model Registry, the Rollout Controller walks it up the 1%→5%→25%→50%→100% ladder, and the Traffic Router turns that into routing config the gateway applies — a slice of live traffic peels off to a separate Challenger pool while everything else stays on champion.",
    },
    {
      reveal: ["kafka", "flink", "canary"],
      say: "Every prediction gets logged to Kafka without blocking the response. Flink computes drift and joins in delayed outcomes, and a sequential-testing Canary Analysis Engine watches continuously and writes its verdict straight back into the Rollout Controller — that feedback edge is what makes this a closed loop instead of a one-way pipeline with a dashboard bolted on.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Register a new model version with artifact, metadata, and lineage (training data, code commit, offline metrics) in a Model Registry", tag: "P0" },
      { id: "FR-02", text: "Deploy a model version behind a progressive rollout (1% → 5% → 25% → 50% → 100%) with a configurable bake time per stage", tag: "P0" },
      { id: "FR-03", text: "Route inference traffic between champion (current stable) and challenger (candidate) deterministically per request/user (sticky bucketing)", tag: "P0" },
      { id: "FR-04", text: "Run a challenger in shadow mode — mirror real traffic, log its predictions, never serve them to users — before it takes any live traffic", tag: "P0" },
      { id: "FR-05", text: "Continuously compute canary guardrail metrics (latency, error rate, prediction-distribution drift) and auto-halt or auto-rollback a stage that breaches them", tag: "P0" },
      { id: "FR-06", text: "Roll back to the last known-good model version within seconds via a config flip, with no redeploy", tag: "P0" },
      { id: "FR-07", text: "Join predictions to delayed ground-truth outcomes (click, conversion, chargeback, default) to compute true accuracy asynchronously", tag: "P1" },
      { id: "FR-08", text: "A/B test a model against business metrics (CTR, revenue) independent of the safety canary, with statistical significance testing", tag: "P1" },
      { id: "FR-09", text: "Detect feature drift and training-serving skew between offline training data and online serving features", tag: "P1" },
      { id: "FR-10", text: "Require human approval gates between rollout stages for high-risk model classes (credit, fraud, medical)", tag: "P1" },
      { id: "FR-11", text: "Maintain a full audit trail: which model version served which prediction to which user at which time", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Latency added by the routing/gateway layer on top of raw model inference", tag: "p99 < 5ms" },
      { id: "NFR-02", text: "End-to-end inference latency, champion or challenger", tag: "p99 < 50ms" },
      { id: "NFR-03", text: "Sustained inference throughput across the fleet", tag: "200K/sec" },
      { id: "NFR-04", text: "Time from a guardrail breach occurring to the rollout being auto-halted", tag: "< 5 min" },
      { id: "NFR-05", text: "Time to roll back a stage to the last known-good version", tag: "< 60s" },
      { id: "NFR-06", text: "Prediction log durability, required for compliance and offline audit", tag: "zero loss" },
      { id: "NFR-07", text: "Control-plane (router/gateway config) availability", tag: "99.99%" },
      { id: "NFR-08", text: "Independent models rolling out concurrently on the platform", tag: "500+" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing the rollout ladder: why 1% before anything else",
      body: [
        "The instinct is to pick a rollout percentage that 'feels safe'. The right way to pick it is statistical power: at 200K req/s, 1% of traffic is still ~2,000 req/s, which is plenty to catch a latency spike or an error-rate jump within seconds. But a subtle 2% drop in click-through rate needs a much bigger sample — even at 1% traffic that can take hours to reach significance, because the signal is small relative to normal day-to-day noise.",
        "So the ladder isn't arbitrary. 1% → 5% → 25% → 50% → 100% takes 5x multiplicative jumps early (1→5→25) while the absolute blast radius is still tiny, then tapers to safer 2x doublings (25→50→100) once real users are on the line — and each stage's bake time should be tied to how long the noisiest guardrail metric you're watching needs to reach significance, not to a fixed clock everyone forgot to justify.",
      ],
      bullets: [
        { lead: "1% floor", text: "at 200K req/s that's ~2K/s — enough for latency and error-rate guardrails to reach significance in under a minute, even though a subtle CTR regression at the same 1% needs hours." },
        { lead: "Tapering stage jumps", text: "1-5-25-50-100 takes 5x jumps early when absolute blast radius is still small, then tapers to 2x doublings (25→50→100) as the stakes rise — the standard shape for progressive delivery." },
        { lead: "Bake time isn't fixed", text: "tie the stage transition to time-to-significance for the noisiest metric being watched, not to a clock everyone forgot to justify." },
        { lead: "Blast radius math", text: "at 200K/s, a bad model sitting at 25% for 5 minutes touches ~15M requests — that number is why fast detection matters more than a cautious first step." },
      ],
      pictureTitle: "How much traffic proves a regression?",
      pictureRows: [
        { label: "1% stage (~2K/s), latency/error spike", value: "significant in seconds", tone: "good" },
        { label: "1% stage, subtle 2% CTR drop", value: "needs hours to reach significance", tone: "bad" },
        { label: "Jump straight to 100%", value: "blast radius = all traffic, zero early warning", tone: "bad" },
      ],
      remember: {
        problem: "Pick a rollout percentage schedule that's neither reckless nor glacially slow.",
        solution: "1% → 5% → 25% → 50% → 100%, with bake time driven by time-to-significance, not a fixed clock.",
        why: "1% (~2K/s at 200K/s scale) is enough sample for fast guardrails; slow-moving business metrics need longer regardless of stage size.",
        tradeoff: "A cautious ladder means legitimate improvements take longer to reach 100% of users.",
        failure: "Jumping straight to a large percentage means the first sign of trouble is already touching millions of requests.",
        mitigation: "Size the floor stage off your fastest guardrail's required sample, and gate stage transitions on significance, not the clock.",
      },
    },
    {
      n: 2,
      title: "Canary analysis: kill three options, defend one",
      body: [
        "Once traffic is split between champion and challenger, something has to decide 'is the challenger worse?' automatically, across 500+ models, without a human staring at a dashboard. Put the candidates on the board and rule them out.",
      ],
      bullets: [
        { lead: "Manual dashboard eyeballing", text: "doesn't scale past a handful of models, is subjective, and is asleep at 3am when the regression actually happens. Rejected." },
        { lead: "Fixed absolute threshold", text: "'error rate > 1%' ignores that a low-traffic model's baseline is naturally noisier than a high-traffic one, so it either false-alarms constantly or misses real regressions. Rejected." },
        { lead: "One-shot t-test at window end", text: "waits for the entire fixed window to close even when the effect is obvious in the first ten minutes, so a real regression burns extra users for no reason, and repeatedly peeking at a fixed test inflates the false-positive rate anyway. Rejected." },
        { lead: "Sequential statistical testing (mSPRT / Kayenta-style)", text: "continuously evaluates the evidence as data streams in and can stop the moment confidence crosses a threshold in either direction, while controlling the false-positive rate across those repeated looks — the 'peeking problem' other methods ignore. Winner." },
      ],
      pictureTitle: "Canary analysis: kill three, keep one",
      pictureRows: [
        { label: "Manual dashboard eyeballing", value: "doesn't scale, asleep at 3am → reject", tone: "bad" },
        { label: "Fixed absolute threshold", value: "ignores per-model baseline noise → reject", tone: "bad" },
        { label: "One-shot t-test, fixed window", value: "slow to react, peeking inflates false-positives → reject", tone: "neutral" },
        { label: "Sequential testing (mSPRT)", value: "stops early, controls false-positive rate → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Automatically decide 'is the challenger worse?' across 500+ models without a human watching a dashboard.",
        solution: "Sequential statistical testing (mSPRT / Kayenta-style) that evaluates continuously and can stop as soon as confidence crosses a threshold.",
        why: "It reacts as fast as the data allows while formally controlling the false-positive rate from repeated peeking, which a one-shot test does not.",
        tradeoff: "More statistical machinery to build and explain than 'if error_rate > 1%, roll back'.",
        failure: "A fixed threshold either false-alarms on noisy low-traffic models or misses real regressions on high-traffic ones.",
        mitigation: "Per-model baseline variance feeds the sequential test's threshold, so the bar adapts instead of being hand-tuned per model.",
      },
    },
    {
      n: 3,
      title: "Shadow mode: mirror traffic without doubling side effects",
      body: [
        "Before a challenger takes any live traffic, it should see real production requests and log real predictions — that's shadow mode. The catch: the mirrored call must never add latency to the response the user actually gets, and it must never cause a real-world side effect twice (a fraud model that 'shadow-blocks' a payment, or a ranking model that shadow-writes to a cache).",
      ],
      bullets: [
        { lead: "Fork after response", text: "the gateway returns the champion's answer to the caller first, then asynchronously fans the same request out to the challenger — shadow traffic can never sit on the critical path." },
        { lead: "Side-effect stripping", text: "shadow requests carry a dry-run flag so any downstream write (cache invalidation, external API call, database mutation) is short-circuited into a no-op or a sandbox." },
        { lead: "Fuzzy diffing, not exact diffing", text: "nondeterminism (floating-point order, ranking ties, GPU batching effects) means champion and challenger outputs are compared with a tolerance, not byte equality." },
        { lead: "Representative sampling", text: "shadow traffic is sampled to match production's real distribution, not just the easy or low-value requests, or the offline comparison is biased." },
      ],
      pictureTitle: "Why shadow traffic can't touch the user response",
      pictureRows: [
        { label: "Mirror before responding", value: "adds latency to every real request", tone: "bad" },
        { label: "Mirror after responding, async", value: "zero added latency, safe", tone: "good" },
        { label: "No side-effect stripping", value: "challenger double-writes/double-charges", tone: "bad" },
        { label: "Dry-run flag on shadow calls", value: "downstream writes become no-ops", tone: "good" },
      ],
      remember: {
        problem: "Evaluate a challenger on real traffic before trusting it with real users.",
        solution: "Fork the request after the champion has already responded; tag shadow calls dry-run; diff outputs with tolerance.",
        why: "Shadow traffic must be zero-risk to users and zero-latency to the response, or the safety net becomes a liability itself.",
        tradeoff: "Async forking means the challenger's shadow environment isn't byte-identical to a live serving path, so some issues only surface once it's live.",
        failure: "A shadow model without side-effect stripping can double-charge, double-block, or double-write in production.",
        mitigation: "Dry-run flags on every downstream call the shadow path makes, plus fuzzy (tolerance-based) output diffing instead of exact matching.",
      },
    },
    {
      n: 4,
      title: "Delayed ground truth: joining predictions to labels that haven't happened yet",
      body: [
        "A model's true accuracy needs a label, and labels lag: a click arrives in seconds, a confirmed fraud case in days, a loan default in months. You can't hold the canary decision hostage to a label that hasn't shown up yet, so real-time guardrails run on proxy signals (drift, latency, error rate) while a separate slower pipeline joins predictions to outcomes as they trickle in.",
      ],
      bullets: [
        { lead: "Prediction log as the join key", text: "every inference is logged with a unique request id, the features used, and the model version, with a retention TTL sized to the longest label lag that model needs; mirrored into an OLAP store (ClickHouse) it doubles as the audit trail, while live guardrail metrics stream to Prometheus for dashboards." },
        { lead: "Watermarked streaming join", text: "Flink joins outcome events to predictions by request id with a bounded watermark (e.g. 24h); state past the watermark is capped so the join doesn't grow unbounded." },
        { lead: "Cold join for long-tail labels", text: "labels that take weeks or months (loan default, chargeback) skip the streaming join entirely and get reconciled nightly in a batch warehouse job instead." },
        { lead: "Proxy signals bridge the gap", text: "prediction and feature distribution drift are available within minutes and are the leading indicator that something's wrong, well before a true labeled-accuracy number exists." },
      ],
      pictureTitle: "How long until you know the model is wrong?",
      pictureRows: [
        { label: "Prediction distribution drift", value: "minutes — leading indicator", tone: "good" },
        { label: "Click / short-lag label", value: "seconds to minutes — streaming join", tone: "good" },
        { label: "Fraud / default confirmed label", value: "days to months — batch/cold join", tone: "neutral" },
        { label: "Wait for true accuracy before reacting", value: "canary decision arrives too late", tone: "bad" },
      ],
      remember: {
        problem: "Measure true model accuracy when the label doesn't exist yet at decision time.",
        solution: "Streaming join with a bounded watermark for fast labels, batch cold join for slow ones, proxy drift metrics for the real-time gap.",
        why: "The canary decision has a 5-minute budget; most real labels don't arrive that fast, so the guardrail must run on what's available now.",
        tradeoff: "Proxy metrics (drift) can flag a problem that never actually hurts the labeled metric, trading some false alarms for speed.",
        failure: "Joining every outcome in one unbounded stream state blows up memory once labels with month-long lag are mixed with second-long ones.",
        mitigation: "Cap the streaming join's watermark to the fast-label cohort; route long-lag labels to a separate nightly batch reconciliation.",
      },
    },
    {
      n: 5,
      title: "Feature drift and training-serving skew",
      body: [
        "A model can be perfectly fine and still start failing in production because the world it's scoring has drifted from the world it was trained on, or because the serving-time feature computation quietly diverges from the training-time computation. Both are silent — nothing crashes, the model just gets steadily worse.",
      ],
      bullets: [
        { lead: "Population Stability Index (PSI)", text: "measures how far a feature's live distribution has moved from its training-time reference distribution; PSI > 0.2 is typically 'investigate', > 0.25 is 'alarm'." },
        { lead: "Point-in-time correctness", text: "the online feature store must return the exact feature value as of the request timestamp, matching how the training set was assembled, or the model sees data it never saw in training." },
        { lead: "Compute skew is the common silent bug", text: "an offline batch job and an online streaming job computing 'the same' feature with slightly different logic is the single most frequent cause of unexplained production degradation." },
        { lead: "Champion-vs-challenger drift", text: "comparing the two models' prediction distributions against each other catches skew even before any label or business metric moves." },
      ],
      pictureTitle: "Where skew hides",
      pictureRows: [
        { label: "PSI < 0.1 vs training reference", value: "stable, no action", tone: "good" },
        { label: "PSI 0.2–0.25", value: "investigate", tone: "neutral" },
        { label: "PSI > 0.25", value: "alarm — likely drift or skew", tone: "bad" },
        { label: "Same feature, two code paths", value: "classic silent training-serving skew", tone: "bad" },
      ],
      remember: {
        problem: "Catch model degradation caused by the input data drifting or the feature pipeline diverging, not by the model itself changing.",
        solution: "PSI/KL drift monitoring on features and predictions, plus a single shared feature-computation path for training and serving.",
        why: "Drift and skew are silent failures — nothing errors, the model just gets quietly worse — so they need their own dedicated monitor.",
        tradeoff: "One shared feature-computation path (vs. separate optimized batch/streaming implementations) costs some performance for correctness.",
        failure: "Two implementations of 'the same' feature drift apart over months of independent edits, and no one notices until accuracy has already dropped.",
        mitigation: "A feature store (e.g. Feast) as the single source of truth for both offline training reads and online serving reads.",
      },
    },
    {
      n: 6,
      title: "Rollback as a config flip, not a redeploy",
      body: [
        "The 60-second rollback budget rules out anything that involves a build, a container push, or a pod restart. Rollback has to be a data change: the router already treats 'which model version handles this bucket' as config it reads, so undoing a rollout is one atomic write to that config, propagated to every gateway instance.",
      ],
      bullets: [
        { lead: "Champion/challenger as pointers", text: "the router config holds version pointers and percentages, not code branches — swapping the pointer back is the entire rollback." },
        { lead: "Kill switch bypasses the ladder", text: "a P0 guardrail breach snaps the challenger's traffic to 0% immediately, skipping the graceful ramp-down that a lower-severity issue would get." },
        { lead: "Keep the rollback target warm", text: "the last known-good version stays deployed and serving a small floor of traffic (or fully warm-standby) so 'roll back' never means a cold start under load." },
        { lead: "Push, not poll", text: "gateways watch the config store (etcd/ZooKeeper-style) for changes instead of polling on an interval, which is what makes sub-60s propagation achievable." },
      ],
      pictureTitle: "What makes rollback fast?",
      pictureRows: [
        { label: "Rollback = redeploy", value: "minutes, needs a build/restart", tone: "bad" },
        { label: "Rollback = config pointer swap", value: "one atomic write, seconds", tone: "good" },
        { label: "Rollback target cold-started", value: "extra latency right when it matters most", tone: "bad" },
        { label: "Rollback target kept warm", value: "instantly absorbs 100% of traffic", tone: "good" },
      ],
      remember: {
        problem: "Roll back a bad model version in under 60 seconds.",
        solution: "Treat model version + traffic split as config the router watches; rollback is one atomic pointer swap, pushed not polled.",
        why: "Anything that involves building or restarting a service can't hit a sub-minute budget; a data change can.",
        tradeoff: "Keeping the previous version warm on standby costs idle serving capacity you hope never to need.",
        failure: "A rollback that requires redeploying a cold service adds exactly the kind of delay the guardrail was trying to avoid.",
        mitigation: "Push-based config propagation plus a warm standby pool for the last known-good version.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a progressive rollout system built on top of a normal model-serving fleet: new versions start at 1% of traffic and only climb once statistics say they're not worse.",
      "Canary analysis runs continuously with sequential testing (mSPRT/Kayenta-style), so it can stop early on a clear signal instead of waiting out a fixed window.",
      "Rollback is a config pointer swap the router already reads, not a redeploy, which is what makes a sub-60s rollback possible.",
      "Real accuracy needs labels that lag minutes to months, so fast guardrails run on proxy signals — latency, error rate, prediction/feature drift — while a separate join pipeline catches up to true accuracy later.",
      "Everything about drift, skew, and canary math rests on one thing: the feature computation at serving time must match training time exactly, or the whole monitoring story is measuring noise.",
    ],
    flows: [
      {
        kind: "read",
        title: "INFERENCE · 200K/S · SUB-50MS P99",
        summary:
          "A request comes in, the router decides champion or challenger based on a sticky hash, and the model pool answers using features from the online store.",
        steps: [
          { label: "Upstream Caller", note: "sends the inference request" },
          { label: "Inference Gateway", note: "consults routing config, sub-5ms overhead" },
          { label: "Champion or Challenger Pool", note: "sticky bucket via consistent hash" },
          { label: "Online Feature Store", note: "Feast, p99 < 10ms, point-in-time correct" },
          { label: "Response", note: "returned before any logging happens" },
        ],
      },
      {
        kind: "write",
        title: "ROLLOUT · CONTROL PLANE",
        summary:
          "A new version enters the registry, the controller starts it at 1% shadow-then-live, and every stage transition — including rollback — is a config write the gateways pick up in seconds.",
        steps: [
          { label: "Model Registry", note: "new version + lineage + offline metrics" },
          { label: "Rollout Controller", note: "starts shadow, then 1% stage" },
          { label: "Traffic Router", note: "writes routing config: version → % split" },
          { label: "Gateways", note: "push-based config watch, picks up change in seconds" },
          { label: "Rollback", note: "same write path, pointer swap to last known-good" },
        ],
      },
      {
        kind: "analytics",
        title: "MONITORING LOOP · NEVER BLOCKS INFERENCE",
        summary:
          "Every prediction is logged async. A streaming job computes drift and joins in delayed outcomes; a sequential test watches it continuously and can halt or roll back the rollout on its own.",
        steps: [
          { label: "Inference Gateway", note: "logs prediction + features + model version" },
          { label: "Kafka", note: "prediction log, zero loss for audit" },
          { label: "Flink", note: "PSI/KL drift + predictions ⋈ delayed outcomes" },
          { label: "Canary Analysis Engine", note: "sequential test (mSPRT), continuous" },
          { label: "Rollout Controller", note: "auto-halt or auto-rollback on breach" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "200K inference req/s across 500+ concurrently rolling-out models",
          "Rollout ladder: 1% → 5% → 25% → 50% → 100%, bake time by significance",
          "Gateway overhead p99 < 5ms; end-to-end inference p99 < 50ms",
          "Guardrail breach → auto-halt within 5 minutes; rollback within 60s",
          "PSI thresholds: < 0.1 stable, 0.2–0.25 investigate, > 0.25 alarm",
          "Prediction log retention TTL sized to each model's longest label lag",
          "50+ rollouts/week platform-wide",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Sequential testing (mSPRT/Kayenta-style), not a fixed-window t-test or a static threshold",
          "Rollback is a config pointer swap the router watches, never a redeploy",
          "Shadow mode forks after the champion responds; dry-run flag strips downstream side effects",
          "Streaming watermark join for fast labels, nightly batch cold join for slow labels (fraud, default)",
          "Single shared feature-computation path (Feast) for training and serving to prevent skew",
          "Proxy drift signals gate the canary in real time; true accuracy catches up asynchronously",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The peeking problem — a one-shot test evaluated repeatedly inflates false positives; sequential testing controls it by design",
          "Blast radius math: a bad model at 25% for 5 minutes at 200K/s touches ~15M requests",
          "Drift and skew are silent failures — nothing errors, the model just quietly gets worse",
          "Keep the rollback target warm/standby so 'roll back' never means a cold start under load",
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
      goal: "Nail down whether this is about safe rollout mechanics, quality monitoring, or both, and get the traffic and risk numbers on the board before drawing anything.",
      why: "This problem is easy to scope wrong — candidates either design a generic CI/CD pipeline with no ML content, or a pure monitoring dashboard with no rollout mechanics. Both miss the point: the interviewer wants the two tied together by a feedback loop.",
      steps: [
        { kind: "ASK", text: '**"What kind of models — how many, how much traffic, how risky?"** Land on "500+ models, 200K inference req/s combined, some high-risk (fraud/credit)". Write **"500+ models, 200K req/s"** in the corner.' },
        { kind: "ASK", text: 'Ask: **"How fast do labels come back — is this a click model or a fraud model?"** Get both: seconds for clicks, days-to-months for fraud/default. This single answer shapes the whole monitoring design later.' },
        { kind: "SAY", text: 'Propose the safety budget: **"guardrail breach detected and halted within 5 minutes"**, **"rollback within 60 seconds"**. Wait for a nod, write it down.' },
        { kind: "SAY", text: 'State scope. In: "progressive rollout", "shadow mode", "canary analysis", "drift detection", "rollback". Out: "training pipelines", "model architecture", "hyperparameter tuning". Confirm before moving on.' },
        { kind: "WRITE", text: 'Do the blast-radius math out loud: **"25% of 200K/s for 5 minutes ≈ 15M requests"** — this is the number that justifies fast detection over a cautious first stage. Write it on the board.' },
      ],
      grading: "Locks traffic scale, risk tiering, and label-latency variance before drawing boxes; writes the blast-radius number down unprompted.",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Define the registry entry, the routing config, and the prediction log schema — the three pieces of state that make everything else possible.",
      why: "The interviewer wants to see that rollout state (who's serving what %) is treated as data the router reads, not logic baked into a deploy script. That single modeling choice is what makes sub-60s rollback possible later.",
      steps: [
        { kind: "WRITE", text: 'Model registry entry: **"model_id, version, artifact_uri, training_lineage, offline_metrics, status (shadow/canary/stable/retired)"**.' },
        { kind: "WRITE", text: 'Routing config: **"model_id → { champion_version, challenger_version, challenger_pct, stage }"**, one row per model, watched by every gateway.' },
        { kind: "DRAW", text: 'Sketch the prediction log row: **"request_id (PK), model_version, features_used, prediction, timestamp, label_ttl"**. Say: "This one row is what makes the whole monitoring loop possible — drift, canary analysis, and the delayed ground-truth join all read from it."' },
        { kind: "SAY", text: '"Rollback is one write to routing config — champion_version pointer swap, challenger_pct → 0. No redeploy, no rebuild." Underline that the router already reads this on every request.' },
      ],
      grading: "Treats rollout state as data with a clear schema, and explicitly frames rollback as a write to that schema, not a deploy action.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram, three lanes: control plane (rollout), inference (serving), monitoring (feedback). Show the loop closing from monitoring back into control.",
      why: "The signature move here is drawing the feedback loop as a real edge, canary analysis writing back into the rollout controller, not just a dashboard. Candidates who draw a one-way pipeline (deploy → serve → log) miss that this system is supposed to react to itself.",
      steps: [
        { kind: "DRAW", text: 'Control-plane lane: Model Registry → Rollout Controller → Traffic Router → (config) → Gateway. Label the controller arrow **"stage: 1%→5%→25%→50%→100%"**.' },
        { kind: "DRAW", text: 'Inference lane: Upstream Caller → Gateway → Champion Pool / Challenger Pool → Online Feature Store. Label with **"200K req/s"** and **"p99 < 50ms"**.' },
        { kind: "DRAW", text: 'Monitoring lane: Gateway → Kafka (prediction log) → Flink (drift + delayed-outcome join) → Canary Analysis Engine. Draw the loop-closing edge: **Canary Analysis Engine → Rollout Controller**, labeled **"guardrail verdict → halt/rollback"**.' },
        { kind: "SAY", text: '"Three lanes because they have three jobs: control plane decides who gets what traffic, inference serves it fast, monitoring watches and writes back into control. That last edge is the whole point — this isn\'t a dashboard, it\'s a closed loop."' },
      ],
      grading: "Three lanes drawn, and the feedback edge from monitoring back to the controller is explicit and narrated, not implied.",
    },
    {
      n: 4,
      title: "Deep Dive: Canary Analysis and Statistical Guardrails",
      minutes: 8,
      goal: "Defend sequential testing over the naive alternatives, and quantify why a fixed threshold or a one-shot test fails at this scale.",
      why: "This is the signature sub-problem. The interviewer wants to see you reason about statistical power and the peeking problem, not just say 'monitor error rate and roll back if it spikes'.",
      steps: [
        { kind: "RULE OUT", text: '"A fixed threshold like error_rate > 1% ignores that a low-traffic model\'s baseline is noisier than a high-traffic one — false alarms on one, missed regressions on the other." Cross it off.' },
        { kind: "RULE OUT", text: '"A one-shot t-test at the end of a fixed window either waits too long on an obvious regression, or — if you peek early and re-test — inflates the false-positive rate. That\'s the peeking problem." Cross it off.' },
        { kind: "SAY", text: '"Sequential testing (mSPRT, the approach behind Netflix\'s Kayenta) evaluates evidence continuously and can stop the moment confidence crosses a threshold, while formally controlling the false-positive rate across repeated looks."' },
        { kind: "SAY", text: '"The guardrail metrics themselves are tiered: latency and error rate need only seconds of data; a subtle CTR regression needs hours even at the same traffic percentage — so different metrics finish their sequential test at different times."' },
      ],
      grading: "Names the peeking problem unprompted, defends sequential testing with the reason (not just the name), and separates fast vs. slow guardrail metrics.",
    },
    {
      n: 5,
      title: "Deep Dive: Delayed Ground Truth and Drift Detection",
      minutes: 7,
      goal: "Explain how the system reacts within its 5-minute budget when the real label for a prediction might not exist for days or months.",
      why: "This is the part that separates ML infra experience from generic distributed-systems knowledge — most candidates haven't thought about what happens when your 'quality metric' literally doesn't exist yet at decision time.",
      steps: [
        { kind: "SAY", text: '"True accuracy needs a label, and labels lag differently per model — a click in seconds, a confirmed fraud case in days to months. The canary can\'t wait on that, so it runs on proxy signals in real time."' },
        { kind: "SAY", text: '"Proxy signal: PSI or KL divergence between the challenger\'s prediction distribution and a training-time reference. PSI above ~0.25 is an alarm — and it\'s available in minutes."' },
        { kind: "SAY", text: '"For labels that do arrive fast, Flink joins predictions to outcomes by request_id with a bounded watermark, maybe 24 hours. Labels that take weeks skip that entirely and get reconciled in a nightly batch job instead — you can\'t hold one unbounded join state for both."' },
        { kind: "SAY", text: '"And skew, not just drift, matters — if the online feature computation quietly diverges from the offline training computation, the model degrades with no distribution shift at all. A shared feature store closes that gap."' },
      ],
      grading: "Explicitly separates fast-label streaming join from slow-label batch join, and names drift/skew as a leading indicator before true accuracy is available.",
    },
    {
      n: 6,
      title: "Wrap: Rollback, Governance, and Close",
      minutes: 5,
      goal: "Land the rollback mechanism as a config write, mention human approval gates for high-risk models, and close with a crisp summary plus what you'd cover next.",
      why: "Staff-level signal here is operational maturity: rollback framed as a data change (not a deploy), risk-tiered governance for regulated models, and a clean close that shows you were pacing the interview on purpose.",
      steps: [
        { kind: "SAY", text: '"Rollback is a pointer swap in the routing config the gateways already watch — sub-60s because there\'s no build, no restart, and the last known-good version is kept warm."' },
        { kind: "SAY", text: '"For high-risk model classes — credit, fraud, medical — stage transitions add a human approval gate on top of the automated guardrails. The automation still runs; it just can\'t auto-promote on its own for those classes."' },
        { kind: "SAY", text: 'Push back where useful: "Do all 500 models need the full 5-stage ladder, or can low-risk internal models skip straight to a 2-stage rollout?" Treat the ladder as tunable per model risk tier.' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a progressive-rollout control plane wrapped around normal model serving, closed by a monitoring loop that can halt or roll itself back. With more time I\'d cover multi-armed bandit traffic allocation and the training pipeline that produces these versions."' },
      ],
      grading: "Rollback framed as a config write, risk-tiered governance mentioned unprompted, one push-back on requirements, and a crisp closing summary with parked items.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Gets to a working rollout mechanism, but treats monitoring as a dashboard rather than a system that acts on its own.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Knows models should roll out gradually and can sketch a percentage-based split.",
          "Adds logging for predictions when prompted.",
          "Mentions A/B testing as the way to compare models.",
          "Knows rollback should exist, usually described as 'redeploy the old version'.",
          "Can name latency and error rate as things to monitor.",
        ],
        gaps: [
          "Rollback is a redeploy, not a config change, so it can't hit a sub-minute budget.",
          "Canary analysis is 'if error rate goes up, stop', with no statistical reasoning about noise or sample size.",
          "No mention of delayed labels — treats accuracy as something available immediately.",
          "Shadow mode, if mentioned at all, doesn't address side effects or added latency.",
          "Doesn't distinguish feature drift from a simple bug; monitoring is one undifferentiated bucket.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks the progressive ladder and shadow mode with reasons, and quantifies guardrails when pushed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the traffic scale, risk tiers, and rollback budget on the board within the first 5 minutes.",
          "Designs the 1-5-25-50-100 ladder and can justify the shape, not just state it.",
          "Treats rollback as a config write to routing state, not a redeploy.",
          "Runs shadow mode async, after the response, with a dry-run flag for side effects.",
          "Mentions PSI/KL drift monitoring and delayed ground-truth joining when asked.",
          "Names the peeking problem when pressed on why a single t-test isn't enough.",
        ],
        gaps: [
          "Volunteers sequential testing only after being nudged toward 'what's wrong with a one-shot test'.",
          "Doesn't proactively separate fast-label streaming joins from slow-label batch joins unless asked.",
          "Quantifies blast radius in words ('a lot of traffic') rather than a computed number.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, closes the monitoring loop back into the control plane unprompted, and reasons about the statistics like it's second nature.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Draws the feedback edge from canary analysis back to the rollout controller without being asked — frames the system as closed-loop, not a pipeline.",
          "Volunteers the peeking problem and defends sequential testing (mSPRT/Kayenta-style) as the fix, unprompted.",
          "Separates fast-label streaming joins from slow-label batch joins as a deliberate architectural split, not an afterthought.",
          "Names training-serving skew as distinct from data drift and ties both back to a single shared feature-computation path.",
          "Quantifies blast radius with a real number (e.g. ~15M requests at 25% for 5 minutes) to justify the detection budget.",
          "Brings up risk-tiered human approval gates for regulated model classes without prompting.",
          "Closes with a crisp summary and explicitly lists what they'd cover with more time (bandit traffic allocation, training pipeline).",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Describing rollback as 'redeploy the previous version' — that can't hit a sub-minute budget and defeats the point of a config-driven rollout.",
      "A canary guardrail that's a single fixed threshold with no notion of per-model baseline noise or sample size.",
      "Treating 'monitoring' as a dashboard a human watches, with no automated feedback loop back into the rollout controller.",
      "Assuming ground-truth labels are available immediately, with no plan for delayed or long-lag outcomes.",
      "Shadow mode that adds latency to the real response, or doesn't strip side effects from the shadow path.",
      "No distinction between data drift (world changed) and training-serving skew (pipeline bug) — both get lumped into 'the model got worse'.",
      "No risk tiering — a credit-scoring model and an internal recommendation widget get the exact same rollout process.",
    ],
    followUps: [
      {
        q: "Why not just A/B test every rollout instead of building a separate canary system?",
        a: "A/B testing measures business impact (does this model make more money/engagement) over a long enough window to be confident, which can take days. A canary is answering a different, faster question: is this model actively breaking something (latency, errors, wildly different predictions)? You want the canary to auto-halt in minutes; the A/B test can run in parallel over a longer horizon on the traffic that already passed the canary. They're complementary — safety canary gates whether a model is allowed to keep ramping, A/B testing decides whether it's actually better once fully rolled out.",
      },
      {
        q: "How do you avoid the canary system itself becoming a single point of failure?",
        a: "The canary analysis engine informs the rollout controller, but the controller enforces safe defaults independent of it: if the canary engine goes down or stops reporting, the controller should freeze the current stage (never auto-promote further) and optionally trigger a rollback to last known-good after a timeout, rather than assuming 'no news is good news'. The prediction log in Kafka is durable and replayable, so even if the streaming analysis pipeline crashes, it can catch up without losing data — it just delays the verdict rather than losing it.",
      },
      {
        q: "What's the difference between data drift and training-serving skew, and why do you monitor them differently?",
        a: "Drift is the world changing — real user behavior or input distributions shift over time, and the model, trained on older data, is now systematically off. Skew is a bug — the feature value computed online doesn't match what the model saw offline during training, even though the real world hasn't changed at all. Drift monitoring compares live features/predictions against a training-time reference distribution (PSI/KL). Skew monitoring compares the online feature computation against the offline one directly, often by replaying the same request through both paths and diffing the outputs. You need both because their fixes are different: drift means retrain, skew means fix a pipeline bug.",
      },
      {
        q: "Why does shadow mode fork the request after the champion responds instead of racing both in parallel and returning the faster one?",
        a: "Racing them and returning whichever answers first would mean the challenger's output sometimes reaches the user, which defeats the entire point of shadow mode — it's supposed to be zero-risk. Forking after the champion has already committed its response guarantees the user only ever sees the trusted model's output, at the cost of the shadow call being pure overhead with no chance of contributing to the response, which is exactly the trade you want during evaluation.",
      },
      {
        q: "How do you size the prediction log retention to work for both a click model and a fraud model?",
        a: "You don't use one retention policy for the whole log — retention is per model, sized to that model's expected label lag plus a safety margin (a click model might keep 48 hours of logs, a fraud model 6 months). The streaming join only ever operates on the fast-label cohort within its bounded watermark; long-lag models are excluded from the real-time join and instead read from a cheaper, longer-retention cold store (e.g., a data lake) for the nightly batch reconciliation job.",
      },
      {
        q: "What would you change about this design for a model where a wrong prediction is safety-critical (e.g. an autonomous braking model) versus one where it's low-stakes (a movie recommendation)?",
        a: "For safety-critical models, shadow mode and human approval gates aren't optional stages you can skip for speed — every stage transition requires a human sign-off in addition to the automated guardrails, the canary floor percentage stays near-zero for much longer, and rollback thresholds are tuned to be aggressive (accept more false-positive rollbacks in exchange for near-zero tolerance of a real regression). For low-stakes models, the ladder can compress to two stages with no human gate, and the guardrail thresholds can be looser since the cost of a bad prediction is low and the cost of rollout friction is comparatively high.",
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
          "This is a normal model-serving fleet wrapped in a closed loop: a control plane decides what percentage of traffic each model version gets, an inference path serves that traffic fast, and a monitoring pipeline watches the results and writes back into the control plane to speed up, halt, or reverse the rollout. The loop closing back on itself — not the serving path — is what makes this a rollout-and-monitoring system rather than just a serving system.",
          "Anchor everything on the numbers: 200K inference req/s across 500+ models, a 5-minute budget to detect a regression, and a 60-second budget to roll one back. Every structural choice below is a consequence of those two budgets.",
        ],
      },
      {
        heading: "The rollout ladder and why it's shaped that way",
        body: [
          "A new model version doesn't jump to serving users. It starts in shadow mode (real traffic, logged predictions, zero live impact), then climbs a ladder: 1% → 5% → 25% → 50% → 100%. Each step is roughly a 5x increase in blast radius and sample size. The floor, 1%, is picked because at 200K req/s it's still ~2,000 req/s — plenty of sample for fast guardrails like latency and error rate to reach statistical significance in seconds, even though a subtle business-metric regression at the same 1% can take hours.",
          "Bake time at each stage is not a fixed clock — it's tied to how long the noisiest metric being watched needs to reach significance. Quantify the risk of skipping stages: at 200K/s, a bad model sitting at 25% for just 5 minutes touches roughly 15 million requests, which is the number that justifies investing in fast detection rather than a more cautious first stage.",
        ],
      },
      {
        heading: "Canary analysis: sequential testing over the alternatives",
        body: [
          "The core decision at every stage is: is the challenger meaningfully worse than the champion? A fixed threshold ('error rate > 1%') ignores that different models have different baseline noise. A one-shot statistical test at a fixed window's end either reacts too slowly to an obvious regression or, if you peek at it early and repeatedly, inflates the false-positive rate — the classic peeking problem.",
          "The fix is sequential testing (an approach like mSPRT, the technique behind Netflix's Kayenta canary system): it evaluates the accumulating evidence continuously and is allowed to stop the moment confidence crosses a threshold in either direction, while formally controlling the false-positive rate across those repeated looks. Different guardrail metrics finish their sequential test at different times — latency and error rate resolve in seconds, a subtle CTR shift can take hours — so the system tracks each metric's own verdict rather than a single combined signal.",
        ],
      },
      {
        heading: "Shadow mode without doubling side effects",
        body: [
          "Before a challenger earns any live traffic, it runs in shadow: the gateway returns the champion's answer to the caller first, then asynchronously forks the same request to the challenger. This guarantees shadow traffic adds zero latency to what the user experiences and never has a chance of reaching them. Shadow calls carry a dry-run flag so any downstream write the model would normally trigger — a cache update, an external API call, a database mutation — is short-circuited into a no-op.",
          "Comparing champion and challenger outputs uses tolerance-based diffing rather than exact matching, because nondeterminism (floating-point ordering, ranking ties, GPU batching effects) means two correct models can still produce slightly different numbers on the same input. Shadow traffic is sampled to be representative of real production traffic, not just the easy cases, or the offline evaluation ends up biased.",
        ],
      },
      {
        heading: "Delayed ground truth and drift as the leading indicator",
        body: [
          "True accuracy requires a label, and labels arrive on wildly different timelines depending on the model: a click within seconds, a confirmed fraud case in days, a loan default in months. The 5-minute guardrail budget can't wait on most of these, so real-time decisions run on proxy signals instead — prediction and feature distribution drift, measured with PSI or KL divergence against a training-time reference, available within minutes.",
          "For labels that do arrive quickly, a streaming job joins predictions to outcomes by request id inside a bounded watermark (e.g. 24 hours), so join state doesn't grow unbounded. Labels with a long lag skip that streaming join entirely and get reconciled in a nightly batch job against a data warehouse instead — mixing fast and slow labels into one join would force an unworkable trade-off between state size and completeness.",
        ],
      },
      {
        heading: "Feature drift, training-serving skew, and instant rollback",
        body: [
          "Two distinct failure modes both look like 'the model got worse': drift, where the real world has genuinely changed since training, and skew, where the online feature computation has quietly diverged from the offline training computation even though nothing in the world has changed. Drift is monitored by comparing live distributions to a training-time reference; skew is caught by routing both training and serving through a single shared feature store (e.g. Feast) so there's only one implementation of each feature to drift apart.",
          "When something does breach a guardrail, rollback has to happen in under 60 seconds, which rules out anything involving a build or a restart. The design treats 'which model version serves this traffic' as config the router already reads on every request, so rollback is a single atomic write — a pointer swap — pushed to every gateway instance rather than polled for. The previous stable version stays warm on standby so the rollback target can absorb 100% of traffic instantly instead of cold-starting under load.",
        ],
      },
    ],
  },
};
