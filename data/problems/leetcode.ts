import type { Problem } from "@/lib/types";

export const leetcode: Problem = {
  slug: "leetcode",
  num: "4.3",
  title: "Design LeetCode",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design an online judge like LeetCode: 50M registered users submit code in 15+ languages against 3,000+ problems, sustaining 500 submissions/sec normally and bursting to 5,000/sec in the first 60 seconds of a live contest, with a judge verdict (Accepted, Wrong Answer, TLE, MLE, Runtime Error, Compile Error) returned in a few seconds and a live contest leaderboard that stays fair and hard to game.",
  ],
  hardParts:
    "The hard parts: executing arbitrary untrusted code safely without letting the sandbox become the attack surface, absorbing a predictable-but-massive contest-start burst without starving normal judging, and producing deterministic verdicts (no flaky false TLEs, no lost or duplicated results) at scale.",
  keyTopics: [
    "Sandboxed Code Execution (gVisor/Firecracker)",
    "Priority Queues & Predictive Autoscaling",
    "Verdict State Machine & Determinism",
    "Real-Time Status via Pub/Sub",
    "Contest Leaderboards (Redis ZSET)",
  ],
  foundationsReferenced: [
    { label: "Kafka", tone: "orange" },
    { label: "gVisor / Firecracker Sandboxing", tone: "purple" },
    { label: "Redis Sorted Sets", tone: "green" },
    { label: "PostgreSQL", tone: "blue" },
    { label: "Token Bucket Rate Limiting", tone: "orange" },
    { label: "WebSockets / Pub-Sub", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "web / IDE", col: 1, row: 2, tone: "slate" },
      { id: "gateway", label: "API Gateway", sub: "auth · LB", col: 2, row: 2, tone: "slate" },
      { id: "problem", label: "Problem Service", sub: "statements · tags", col: 2, row: 1, tone: "green" },
      {
        id: "submission",
        label: "Submission Service",
        sub: "validate · idempotency key",
        col: 3,
        row: 2,
        tone: "purple",
      },
      { id: "postgres", label: "PostgreSQL", sub: "problems · submissions · users", col: 4, row: 1, tone: "blue" },
      { id: "redis", label: "Redis", sub: "rate limit · status cache", col: 4, row: 2, tone: "blue" },
      { id: "kafka", label: "Kafka", sub: "judge-jobs, priority partitions", col: 3, row: 3, tone: "purple" },
      {
        id: "judge",
        label: "Judge Worker Pool",
        sub: "gVisor / Firecracker",
        mono: "compile → run tests → compare",
        col: 4,
        row: 3,
        tone: "purple",
      },
      { id: "testcases", label: "Test Case Store", sub: "S3, cached on judge node", col: 5, row: 3, tone: "slate" },
      { id: "results", label: "Result Consumer", sub: "verdict → status update", col: 4, row: 4, tone: "purple" },
      {
        id: "leaderboard",
        label: "Contest Leaderboard",
        sub: "Redis ZSET · live rank",
        col: 5,
        row: 4,
        tone: "orange",
      },
    ],
    edges: [
      { from: "client", to: "gateway", label: "browse / view", kind: "read" },
      { from: "gateway", to: "problem", kind: "read" },
      { from: "problem", to: "postgres", label: "statement + samples", kind: "read" },
      { from: "client", to: "gateway", label: "submit code", kind: "write" },
      { from: "gateway", to: "submission", kind: "write" },
      { from: "submission", to: "redis", label: "rate limit + idempotency check", kind: "write" },
      { from: "submission", to: "postgres", label: "insert, status=PENDING", kind: "write" },
      { from: "submission", to: "kafka", label: "enqueue judge job", kind: "write" },
      { from: "kafka", to: "judge", label: "consume, priority partitions", kind: "write" },
      { from: "judge", to: "testcases", label: "fetch hidden tests, cached", kind: "write" },
      { from: "judge", to: "results", label: "publish verdict", kind: "write" },
      { from: "results", to: "postgres", label: "update status + stats", kind: "write" },
      { from: "results", to: "client", label: "WS push verdict", kind: "write" },
      { from: "results", to: "leaderboard", label: "contest only, async", kind: "analytics" },
      { from: "leaderboard", to: "redis", label: "ZADD rank + penalty", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · browsing problems" },
      { kind: "write", text: "write path · submit → judge → verdict" },
      { kind: "analytics", text: "contest leaderboard · async, never blocks judging" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Browse and search the problem list, filterable by difficulty and tags", tag: "P0" },
      { id: "FR-02", text: "View a problem statement with constraints and sample test cases", tag: "P0" },
      { id: "FR-03", text: "Submit code in one of 15+ supported languages to be judged against hidden tests", tag: "P0" },
      {
        id: "FR-04",
        text: "Run code against sample/custom input for fast feedback without recording an official verdict",
        tag: "P0",
      },
      {
        id: "FR-05",
        text: "Judge a submission and return a verdict: Accepted, Wrong Answer, TLE, MLE, Runtime Error, Compile Error",
        tag: "P0",
      },
      { id: "FR-06", text: "Push real-time submission status updates (Pending → Running → Verdict) to the client", tag: "P0" },
      { id: "FR-07", text: "Store per-user submission history with code, verdict, and runtime/memory stats", tag: "P0" },
      { id: "FR-08", text: "Run timed contests with a synchronized start/end and a live leaderboard", tag: "P1" },
      { id: "FR-09", text: "Rate-limit submissions per user and per IP to prevent abuse", tag: "P1" },
      { id: "FR-10", text: "Handle submission retries idempotently so a network blip never double-judges", tag: "P1" },
      { id: "FR-11", text: "Flag near-duplicate code across a contest's submissions for plagiarism review", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Judge latency, typical problem, p99", tag: "< 3s" },
      { id: "NFR-02", text: "Judge latency, full hidden suite worst case, p99", tag: "< 10s" },
      { id: "NFR-03", text: "Submission ingest, sustained", tag: "500/sec" },
      { id: "NFR-04", text: "Submission ingest, contest-start burst", tag: "5K/sec" },
      { id: "NFR-05", text: "Sandbox isolation: no cross-tenant or host compromise", tag: "zero breakout" },
      { id: "NFR-06", text: "Judging correctness despite worker crash or message redelivery", tag: "exactly-once" },
      { id: "NFR-07", text: "Contest leaderboard update freshness", tag: "< 2s" },
      { id: "NFR-08", text: "Platform availability", tag: "99.9%" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: how many judge sandboxes do we actually need?",
      body: [
        "Before picking a sandbox technology, size the fleet, because that number decides whether the answer even fits in a reasonable budget. Use Little's Law: concurrency needed equals throughput times average time-in-system. At the sustained rate, 500 submissions/sec times an average 3s judge time (compile plus running the hidden suite) is 1,500 concurrently running sandboxes.",
        "Now do the same math for a contest burst: 5,000 submissions/sec times 3s is 15,000 concurrent sandboxes, ten times the steady-state number, and it has to be ready within the first minute of a scheduled event. Provisioning 15,000 warm sandboxes permanently is wasteful; provisioning only 1,500 means the contest opening minute collapses under queueing delay. The number itself is the argument for predictive autoscaling rather than either extreme.",
      ],
      bullets: [
        { lead: "Little's Law", text: "concurrency = throughput × latency. It turns a vague 'we get bursts' into a hard capacity number you can plan against." },
        { lead: "Steady state", text: "500/sec × 3s ≈ 1,500 concurrent sandboxes — the always-on fleet size." },
        { lead: "Contest burst", text: "5,000/sec × 3s ≈ 15,000 concurrent sandboxes — a 10× spike that lasts roughly one minute, not held all day." },
      ],
      pictureTitle: "Concurrency needed at each traffic level",
      pictureCaption: "burst needs 10× the steady-state sandbox count, but only for ~60 seconds",
      pictureRows: [
        { label: "Steady state (500/s × 3s)", value: "~1,500 concurrent sandboxes", tone: "good" },
        { label: "Contest burst (5,000/s × 3s)", value: "~15,000 concurrent sandboxes", tone: "bad" },
        { label: "Always provisioning for burst", value: "10× cost, idle 23.5 hrs/day", tone: "bad" },
      ],
      remember: {
        problem: "How big should the judge worker fleet be?",
        solution: "Apply Little's Law at both steady state and contest burst, then autoscale between the two.",
        why: "Concurrency = throughput × latency turns 'we get bursts' into a number you can provision and test against.",
        tradeoff: "Sizing for burst 24/7 wastes ~10× the compute; sizing for steady state alone collapses at contest open.",
        failure: "Under-provisioning means queue depth explodes in the first contest minute and verdicts arrive minutes late.",
        mitigation: "Predictive pre-scaling before scheduled contests (known start times) plus reactive autoscaling for the rest.",
      },
    },
    {
      n: 2,
      title: "Sandboxing untrusted code: kill the weak options, defend a tiered one",
      body: [
        "Every submission is arbitrary code from an untrusted user, run on shared infrastructure, with the explicit goal of executing it. That is the sharpest security requirement in the whole system: get it wrong and one submission compromises the host or another tenant's data. Put the isolation options on the board and rule out the ones that share too much with the host kernel.",
      ],
      bullets: [
        { lead: "Bare process + ulimit/seccomp", text: "cheapest and fastest, the approach tools like isolate use, but it shares the host kernel directly. A kernel syscall bug is a full host compromise. Rejected as the sole boundary at this scale." },
        { lead: "Docker containers", text: "namespace and cgroup isolation, still one shared kernel underneath. A container-escape CVE is still a host compromise, and this platform's whole business model is 'run code we don't trust.' Rejected as a hard security boundary." },
        { lead: "gVisor (runsc)", text: "intercepts syscalls in a user-space kernel, so the real host kernel's attack surface is barely touched. Overhead is small (low single-digit ms), cold start is fast. Strong default." },
        { lead: "Firecracker microVMs", text: "a genuinely separate kernel per sandbox, the strongest boundary available, at the cost of a ~125ms cold boot — hidden behind a pre-warmed VM pool so it never sits on the judge's hot path." },
        { lead: "Tiered winner", text: "gVisor for every submission by default; an abuse-detection signal (repeated crashes, known exploit patterns, reported code) escalates a user's future submissions into the Firecracker tier, paying the stronger isolation only where the risk signal justifies it." },
      ],
      pictureTitle: "Sandboxing options: kill three, defend a tier",
      pictureRows: [
        { label: "Bare process + ulimit", value: "shared kernel → reject as sole boundary", tone: "bad" },
        { label: "Docker containers", value: "shared kernel, escape = host compromise → reject", tone: "bad" },
        { label: "gVisor (default tier)", value: "user-space kernel, low overhead → WINNER", tone: "good" },
        { label: "Firecracker (escalation tier)", value: "separate kernel, warm pool hides cold start → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Run arbitrary untrusted code from millions of users without the sandbox becoming the exploit.",
        solution: "gVisor by default for every submission; escalate flagged users to Firecracker microVMs with a warm pool.",
        why: "Docker and raw processes share the host kernel; a container-escape bug is a full host compromise at this scale.",
        tradeoff: "gVisor adds small per-syscall overhead versus a raw process; Firecracker adds a ~125ms cold boot, masked by pre-warming.",
        failure: "Treating Docker namespaces as a hard security boundary means one kernel CVE compromises every tenant on the host.",
        mitigation: "Two-tier isolation plus hard cgroup caps (memory, CPU quota, no network egress) on every submission regardless of tier.",
      },
    },
    {
      n: 3,
      title: "The verdict state machine: precedence and determinism",
      body: [
        "A verdict is not a single boolean, it is a small state machine with a strict precedence order, and getting the order wrong shows the user a misleading result. Compile Error short-circuits everything else — if the code doesn't build, no test ever runs. Otherwise tests run in order and the first failure (Wrong Answer, Time Limit Exceeded, Memory Limit Exceeded, Runtime Error) stops the run and is what gets shown, unless the caller explicitly asked to run the full suite for statistics.",
        "The trap most designs miss is determinism: two identical submissions must get the same verdict every time, or the platform looks broken. Wall-clock timing is not safe because host noisy-neighbor scheduling jitter can make an identical program flicker between Accepted and a false TLE. Measure CPU time from the cgroup's own accounting instead, and cut network entirely so code can't behave differently based on external state.",
      ],
      bullets: [
        { lead: "Compile Error", text: "checked first and skips execution entirely — the cheapest possible fast-fail." },
        { lead: "Early-exit on first failure", text: "stop at the first failing hidden test by default; run-all is a separate mode for showing partial-credit style diagnostics." },
        { lead: "CPU time via cgroup, not wall clock", text: "cgroup cpu.stat reports actual CPU nanoseconds consumed, immune to a noisy host stealing wall-clock time and causing a false TLE." },
        { lead: "No network namespace", text: "removes both a data-exfiltration path and a source of non-determinism (the program can't get different answers from the outside world across runs)." },
        { lead: "MLE vs RE", text: "cgroup memory.max plus an OOM-kill is a distinct exit path from a segfault-style crash, so the verdict correctly separates 'ran out of memory' from 'crashed'." },
      ],
      pictureTitle: "Verdict precedence order",
      pictureRows: [
        { label: "1. Compile Error", value: "skips execution entirely", tone: "bad" },
        { label: "2. Runtime Error", value: "crash, segfault, uncaught exception", tone: "bad" },
        { label: "3. Time Limit Exceeded", value: "cgroup CPU time, not wall clock", tone: "bad" },
        { label: "4. Memory Limit Exceeded", value: "cgroup OOM-kill, distinct from RE", tone: "bad" },
        { label: "5. Wrong Answer", value: "output mismatch on a passing run", tone: "neutral" },
        { label: "6. Accepted", value: "every hidden test passes", tone: "good" },
      ],
      remember: {
        problem: "Return a correct, reproducible verdict instead of a flaky one.",
        solution: "A strict precedence order (CE > RE > TLE > MLE > WA > AC) plus cgroup-based CPU/memory accounting, no network.",
        why: "Wall-clock timing and shared network state make an identical submission produce a different verdict on different runs.",
        tradeoff: "Early-exit on first failure is cheaper but hides how many of the remaining hidden tests would also have failed.",
        failure: "Timing off wall clock under host contention produces false TLEs that erode trust in the whole judge.",
        mitigation: "cgroup cpu.stat for CPU time, cgroup memory.max + OOM-kill for MLE, and a disabled network namespace for both security and determinism.",
      },
    },
    {
      n: 4,
      title: "Contest bursts: priority lanes and predictive autoscaling",
      body: [
        "A weekly contest is a burst you know about in advance: the start time is scheduled, so treat it as a planned event, not a surprise. Reactive autoscaling that watches queue depth and spins up workers typically takes 30-60 seconds to react — too slow when the burst front-loads almost entirely into the first 60 seconds after the contest opens.",
        "Two more moves matter beyond scaling. First, keep contest submissions on separate Kafka partitions from casual practice submissions, so a contest burst can never starve someone practicing outside the contest. Second, when demand still exceeds capacity for a few seconds, show the user their real queue position rather than silently stalling — fairness within a FIFO partition, not a black box.",
      ],
      bullets: [
        { lead: "Predictive pre-scaling", text: "scale the judge fleet and pre-warm the sandbox pool 5-10 minutes before a known contest start, instead of waiting for queue depth to trigger a reactive scale-up." },
        { lead: "Separate priority partitions", text: "contest-jobs and practice-jobs are different Kafka topics/partitions consumed by (possibly) different worker pools, so one never starves the other." },
        { lead: "Visible backpressure", text: "when the burst still outpaces capacity, surface a queue position to the client instead of a silent hang — same fairness idea as a well-run ticket queue." },
        { lead: "Warm sandbox pool", text: "keep pre-initialized gVisor sandboxes ready so a scaled-up worker can start judging immediately instead of paying cold-start cost per submission." },
      ],
      pictureTitle: "Reactive vs. predictive autoscaling for a known burst",
      pictureRows: [
        { label: "Reactive (queue-depth triggered)", value: "30-60s lag → burst already landed", tone: "bad" },
        { label: "Predictive (scheduled contest)", value: "pre-scale 5-10 min ahead → ready at t=0", tone: "good" },
        { label: "Shared queue, no lanes", value: "contest burst starves practice judging", tone: "bad" },
        { label: "Separate priority partitions", value: "contest and practice isolated from each other", tone: "good" },
      ],
      remember: {
        problem: "Absorb a 10× contest-start burst without starving normal traffic or blowing the judge SLA.",
        solution: "Predictive pre-scaling ahead of known contest times, plus separate priority partitions for contest vs. practice jobs.",
        why: "The burst is scheduled and predictable, so reacting to queue depth after the fact is strictly slower than acting on the calendar.",
        tradeoff: "Pre-scaling spends compute on a fleet that sits idle right up until the contest opens.",
        failure: "Purely reactive autoscaling reacts in 30-60s, well after a burst that front-loads into the first minute.",
        mitigation: "Scheduled pre-scale plus a visible queue-position fallback if the burst still exceeds provisioned capacity.",
      },
    },
    {
      n: 5,
      title: "Exactly-once judging and pushing status in real time",
      body: [
        "A flaky network means the client may retry a submit click, and a judge worker may crash mid-run and get its Kafka message redelivered. Neither should ever produce a duplicate verdict or a lost one. The fix is the same pattern twice: make the write idempotent, and only acknowledge the work after the result is durably persisted.",
        "For status, the user should watch Pending → Running → Verdict update live, not poll and hope. Push it instead of pulling it, and make the pull path a safety net rather than the primary path.",
      ],
      bullets: [
        { lead: "Client idempotency key", text: "a UUID generated at the Submit click travels with the request; the Submission Service does an insert keyed on (user, problem, key) that no-ops on a retry, so a doubled network call never enqueues twice." },
        { lead: "Commit-after-persist", text: "the Kafka consumer offset for a judge job is only committed after the verdict is durably written to Postgres, so a worker crash mid-run causes a safe redelivery and rejudge rather than a silently lost submission." },
        { lead: "Idempotent write, not idempotent judge", text: "rejudging the same submission twice is fine because the result write uses the same idempotency key — 'redelivered' overwrites the same row, it does not create a second one." },
        { lead: "Push via pub/sub", text: "a completed verdict fires a Redis Pub/Sub message on a per-submission channel; a WebSocket Gateway holds the client connection and forwards it in real time." },
        { lead: "Polling as a fallback", text: "if the WebSocket drops, the client falls back to GET /submissions/:id, so an update is only ever delayed, never lost." },
      ],
      pictureTitle: "Where exactly-once is actually enforced",
      pictureRows: [
        { label: "Submit retry", value: "idempotency key dedups the insert", tone: "good" },
        { label: "Worker crash mid-run", value: "offset uncommitted → safe redelivery", tone: "neutral" },
        { label: "Redelivered job", value: "idempotent result write, no duplicate verdict", tone: "good" },
        { label: "WebSocket drop", value: "client falls back to polling, nothing lost", tone: "good" },
      ],
      remember: {
        problem: "Never double-judge a retried submission and never silently lose a crashed one.",
        solution: "Idempotency key on ingest; commit the Kafka offset only after the verdict is durably persisted.",
        why: "At-least-once delivery plus an idempotent write is the standard recipe for effectively-once behavior without distributed transactions.",
        tradeoff: "Every submission pays one extra conditional-insert round trip to enforce the idempotency key.",
        failure: "Committing the offset before persisting the verdict means a crash between the two loses the submission's result forever.",
        mitigation: "Persist-then-commit ordering, plus a WebSocket-with-polling-fallback so status is never dropped on the client side either.",
      },
    },
    {
      n: 6,
      title: "Contest leaderboards: fast, fair, and reconcilable",
      body: [
        "A live leaderboard needs O(log N) rank updates on every accepted submission, which is exactly what a Redis sorted set (ZSET) gives you: score in, rank out, no full re-sort. But 'fast' and 'source of truth' are different jobs — Redis is the read-optimized live view, Postgres's submission log is what the standings are legally derived from.",
        "Two more real-world requirements come from actual contest platforms: a freeze window near the end so people can't snipe rank by watching others solve in real time, and a post-contest reconciliation pass that recomputes final standings from the durable log in case the live cache lost anything mid-contest.",
      ],
      bullets: [
        { lead: "Redis ZSET per contest", text: "ZADD on every Accepted verdict; score combines problems solved (weighted) and accumulated penalty time, giving O(log N) inserts and O(log N + k) range reads for a leaderboard page." },
        { lead: "Penalty-time tie-break", text: "ties on problems-solved are broken by total penalty time (time to solve plus a fixed penalty per wrong submission), matching how competitive-programming judges score." },
        { lead: "Freeze window", text: "standings shown to competitors freeze for the last 5-10 minutes of the contest; real ranks are computed and revealed only after the contest ends, preventing last-minute sniping of who's about to pass whom." },
        { lead: "Post-contest reconciliation", text: "Postgres's append-only submission log is the actual source of truth; final standings are recomputed from it after the contest closes, so a Redis restart mid-contest can never corrupt the official result." },
      ],
      pictureTitle: "Redis ZSET (live) vs. Postgres log (source of truth)",
      pictureRows: [
        { label: "During contest", value: "Redis ZSET serves live rank, sub-2s freshness", tone: "used" },
        { label: "Last 5-10 minutes", value: "standings frozen, real rank hidden", tone: "neutral" },
        { label: "After contest ends", value: "final rank recomputed from Postgres log", tone: "good" },
        { label: "Redis restart mid-contest", value: "no data loss — Postgres log is authoritative", tone: "good" },
      ],
      remember: {
        problem: "Serve a fast, fair, and ultimately correct contest leaderboard.",
        solution: "Redis ZSET for live O(log N) ranking, a freeze window near the end, and post-contest reconciliation from Postgres.",
        why: "A sorted set gives cheap incremental ranking, but only a durable append-only log can be the legally authoritative source of standings.",
        tradeoff: "Running two representations (fast cache + durable log) means extra bookkeeping to keep them in sync.",
        failure: "Trusting Redis alone as the source of truth means a cache restart mid-contest can silently corrupt final standings.",
        mitigation: "Treat Redis purely as a read-optimized view and always recompute final results from the Postgres submission log.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "This is a submission-and-judging pipeline wrapped around a CRUD problem bank: browsing problems is a normal read path, but submitting code triggers async, sandboxed execution.",
      "Untrusted code runs in gVisor by default, escalating to Firecracker microVMs for flagged users — never trust a shared-kernel container as the hard security boundary.",
      "Verdicts follow a strict precedence (Compile Error > Runtime Error > TLE > MLE > Wrong Answer > Accepted) and are timed off the cgroup, not the wall clock, so they stay deterministic.",
      "Contest bursts are predictable, so pre-scale the judge fleet on the calendar before the contest opens, not reactively off queue depth.",
      "The live leaderboard is a Redis ZSET for speed, but the Postgres submission log is the actual source of truth, reconciled after the contest ends.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · BROWSE & VIEW PROBLEMS",
        summary:
          "Viewing the problem list or a problem statement is a normal cached read, no different from any other content service.",
        steps: [
          { label: "Client", note: "opens problem list or a problem page" },
          { label: "API Gateway", note: "authn, routes the request" },
          { label: "Problem Service", note: "fetches statement, constraints, samples" },
          { label: "PostgreSQL", note: "problems table, cached at the service layer" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · SUBMIT → JUDGE → VERDICT",
        summary:
          "A submission is validated, deduped by idempotency key, queued, then judged in an isolated sandbox before the verdict is persisted and pushed back to the client.",
        steps: [
          { label: "Client", note: "submits code with a client-generated idempotency key" },
          { label: "Submission Service", note: "rate limit check, idempotent insert, status=PENDING" },
          { label: "Kafka", note: "judge-jobs topic, contest vs. practice partitions" },
          { label: "Judge Worker Pool", note: "gVisor sandbox: compile → run hidden tests → compare" },
          { label: "Test Case Store", note: "hidden tests fetched from S3, cached on the judge node" },
          { label: "Result Consumer", note: "persists verdict, commits Kafka offset only after persist" },
          { label: "WebSocket push", note: "client sees Pending → Running → Verdict live" },
        ],
      },
      {
        kind: "analytics",
        title: "ANALYTICS · CONTEST LEADERBOARD, NEVER BLOCKS JUDGING",
        summary:
          "An Accepted verdict during a live contest updates the leaderboard asynchronously; a slow or failed leaderboard update never delays or blocks the judge pipeline itself.",
        steps: [
          { label: "Result Consumer", note: "on Accepted verdict during a contest window" },
          { label: "Contest Leaderboard", note: "ZADD score = solved (weighted) − penalty time" },
          { label: "Redis ZSET", note: "O(log N) rank update, < 2s freshness" },
          { label: "Freeze + reconcile", note: "frozen last 5-10 min, recomputed from Postgres post-contest" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "50M registered users, 3,000+ problems, 15+ supported languages",
          "500 submissions/sec sustained, bursting to 5,000/sec in a contest's first 60s",
          "Concurrency (Little's Law): ~1,500 sandboxes steady state, ~15,000 at peak burst",
          "Judge latency: p99 < 3s typical problem, < 10s worst-case full hidden suite",
          "Sandbox limits: 256MB memory, 1-15s CPU time (problem-defined), no network egress",
          "Contest leaderboard freshness: < 2s during the live window",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "gVisor by default for isolation, Firecracker microVMs for escalated/flagged users",
          "cgroup CPU time (not wall clock) for TLE, cgroup OOM-kill for MLE",
          "Strict verdict precedence: CE > RE > TLE > MLE > WA > AC, early-exit on first failure",
          "Separate Kafka partitions for contest vs. practice jobs, predictive pre-scaling before known contest starts",
          "Idempotency key on submit, offset committed only after verdict is persisted",
          "Redis ZSET for the live leaderboard, Postgres submission log as the source of truth",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Docker's shared kernel is not a hard security boundary for untrusted code at this scale",
          "Wall-clock timing causes false TLEs under host contention — always time off the cgroup",
          "Contest bursts are scheduled, not surprises — pre-scale on the calendar, not off queue depth",
          "Leaderboard freeze window near contest end prevents last-minute rank sniping",
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
      goal: "Lock the five numbers that drive every later decision: users, problems, submission rate (steady and contest-burst), and the judge latency budget.",
      why: "The interviewer wants to see the design driven by data, not intuition. Judge fleet size, queue partitioning, and autoscaling policy all fall out of the steady-state and burst numbers, so lock them before drawing anything.",
      steps: [
        { kind: "ASK", text: '**"Is this dominated by casual submissions or contest traffic?"** Land on "both — 500/sec sustained, but a scheduled weekly contest bursts to ~5,000/sec in its first minute." Write **"500 r/s steady, 5K r/s burst"** on the board.' },
        { kind: "ASK", text: 'Ask: **"How many languages, and does judging need to be a hard security boundary?"** Land on "15+ languages, arbitrary untrusted code, yes — this is a genuine sandboxing problem, not a formality."' },
        { kind: "SAY", text: 'Propose the latency target yourself: **"p99 < 3s for a typical problem, < 10s worst case on the full hidden suite."** Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "problem browsing", "submission + judging", "real-time status", "contests + leaderboard". Out: "editorial/discussion forum", "premium billing", "IDE autocomplete". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the concurrency math out loud with Little\'s Law: **"500/s × 3s ≈ 1,500 concurrent sandboxes steady state"**, **"5,000/s × 3s ≈ 15,000 at contest burst"**. Write both totals on the board — this is the number that justifies predictive autoscaling later.' },
      ],
      grading: "Are you writing the steady-state and burst numbers on the board, deriving concurrency from Little's Law, and locking scope before any boxes get drawn?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "A handful of endpoints, a submission row with an idempotency key, and the verdict enum stated up front.",
      why: "The interviewer wants to see you commit to a small surface and name the verdict states before being asked, since the whole judging pipeline exists to fill in that one enum correctly.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /submissions { problemId, language, code, idempotencyKey }"** → **"{ submissionId, status: PENDING }"**. **"GET /submissions/:id"** → status + verdict. **"POST /run"** → sample-input execution, no verdict recorded.' },
        { kind: "DRAW", text: 'Sketch the submission row: **"id (PK)"**, **"user_id"**, **"problem_id"**, **"idempotency_key (unique w/ user+problem)"**, **"language"**, **"status"**, **"verdict"**, **"runtime_ms"**, **"memory_kb"**, **"created_at"**.' },
        { kind: "SAY", text: 'State the verdict enum up front: **"Compile Error, Runtime Error, Time Limit Exceeded, Memory Limit Exceeded, Wrong Answer, Accepted — checked in that precedence order."** Write it on the board as an ordered list, not a bag of options.' },
        { kind: "RULE OUT", text: 'Get ahead of a likely question: "Why not judge synchronously inside the request?" — "Sandboxed execution can take seconds; blocking an HTTP request on that is fragile and doesn\'t survive worker restarts. Async with a status poll/push is the only sane shape." Cross synchronous judging off the board.' },
      ],
      grading: "Crisp endpoint names, an idempotency key visible in the schema, and the verdict precedence stated as an ordered list before being prompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: read (browsing), write (submit → judge → verdict), and analytics (async leaderboard).",
      why: "Separating these three lanes proves you understand they carry different SLAs and failure tolerances — a leaderboard hiccup should never touch judging, and judging should never touch problem browsing.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read lane**: Client → API Gateway → Problem Service → PostgreSQL. Label it **"browsing, normal cached reads."**' },
        { kind: "DRAW", text: 'Lay down the **write lane**: Client → Gateway → Submission Service → Redis (rate limit + idempotency) → PostgreSQL (insert) → Kafka → Judge Worker Pool (sandbox) → Test Case Store → Result Consumer → PostgreSQL (update) → WS push to Client. Label arrows with the numbers: **"500/s steady, 5K/s burst"**, **"gVisor sandbox"**.' },
        { kind: "DRAW", text: 'Add the **analytics lane** dropping off the Result Consumer: → Contest Leaderboard → Redis ZSET, dashed, labeled **"async, contest-only, never blocks a verdict."**' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they fail differently — a leaderboard outage is cosmetic, a judging outage is the whole product, and a browsing outage is embarrassing but not dangerous."' },
      ],
      grading: "Three clearly separated lanes, the sandbox called out explicitly on the write lane, and an explicit statement that the leaderboard is async and non-blocking.",
    },
    {
      n: 4,
      title: "Deep Dive: Sandboxing and the Verdict State Machine",
      minutes: 8,
      goal: "Defend the sandbox choice against the obvious weaker alternatives, then walk the verdict precedence and why timing is done off the cgroup.",
      why: "This is the signature sub-problem: can the candidate reason about a real security boundary instead of waving at 'we containerize it', and can they explain why naive timing produces flaky verdicts.",
      steps: [
        { kind: "RULE OUT", text: 'One line each: **Bare process + ulimit** → shares host kernel, a syscall bug is a full compromise. **Docker** → still one shared kernel, a container-escape CVE is still a host compromise. Cross both off as the hard boundary.' },
        { kind: "SAY", text: 'Defend the winner: "gVisor by default — it intercepts syscalls in a user-space kernel, so the real kernel\'s attack surface barely gets touched, with small overhead. For flagged or abusive users, escalate to Firecracker microVMs, a genuinely separate kernel, hidden behind a pre-warmed pool so the ~125ms cold boot never lands on a normal judge."' },
        { kind: "DRAW", text: 'Write the precedence order on the board: **"CE > RE > TLE > MLE > WA > AC"**. "Compile Error skips execution entirely; otherwise we stop at the first failing test by default."' },
        { kind: "SAY", text: 'Call out the determinism trap unprompted: "Timing off wall clock causes false TLEs under host noisy-neighbor contention — I time CPU usage from the cgroup\'s own accounting instead, and I disable the network namespace so nothing depends on external state."' },
      ],
      grading: "A defended tiered sandbox choice (not just \"Docker\"), the precedence order on the board unprompted, and the cgroup-vs-wall-clock determinism point raised without being asked.",
    },
    {
      n: 5,
      title: "Deep Dive: Contest Bursts and Exactly-Once Judging",
      minutes: 7,
      goal: "Explain predictive autoscaling for a known burst, priority partitioning, and how a retried submit or a crashed worker never produces a wrong result count.",
      why: "The interviewer wants to see burst handling reasoned from the fact that contest start times are known in advance, not treated as a generic autoscaling problem, plus a clean explanation of exactly-once semantics under real failure modes.",
      steps: [
        { kind: "SAY", text: 'Make the predictability point explicit: "A weekly contest\'s start time is on a calendar. Reactive autoscaling off queue depth lags 30-60 seconds — too slow for a burst that lands almost entirely in the first minute. Pre-scale the judge fleet 5-10 minutes ahead instead."' },
        { kind: "SAY", text: '"Contest jobs and practice jobs sit on separate Kafka partitions, so a contest burst can never starve someone doing a normal practice problem."' },
        { kind: "SAY", text: '"On the client side, a retried submit carries the same idempotency key, so a doubled network call never enqueues twice. On the worker side, the Kafka offset is only committed after the verdict is durably persisted, so a crash mid-run causes a safe redelivery, not a lost submission."' },
        { kind: "RULE OUT", text: '"Committing the offset before persisting the result" — cross it off: "that\'s the classic bug that loses a submission\'s verdict forever on a worker crash."' },
      ],
      grading: "Burst handling framed around the known contest schedule (not generic autoscaling), priority partitions named, and exactly-once explained as idempotent-write-plus-persist-then-commit, not hand-waved.",
    },
    {
      n: 6,
      title: "Wrap: Leaderboard, Reconciliation, and Close",
      minutes: 5,
      goal: "Name the leaderboard's freeze window and reconciliation step, push back on one requirement, and close with a crisp one-sentence summary plus a parked-items list.",
      why: "Staff-level signal here is knowing that a fast cache (Redis ZSET) and a source of truth (Postgres log) are different responsibilities, plus the operational maturity to freeze standings near the end and reconcile after.",
      steps: [
        { kind: "SAY", text: '"The live leaderboard is a Redis sorted set for O(log N) rank updates, but it\'s a read-optimized view, not the source of truth — final standings are recomputed from the Postgres submission log after the contest ends, so a Redis restart mid-contest can\'t corrupt the official result."' },
        { kind: "SAY", text: '"Standings freeze for the last 5-10 minutes so no one can snipe rank by watching a rival solve in real time — real rank is revealed only after close."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need true global fairness across regions for a contest, or is per-region judging with a reconciled global rank acceptable? That changes whether the judge fleet needs to be single-region for consistency." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s an async submit-and-judge pipeline behind tiered sandboxing, with a deterministic verdict machine and a fast-cache-plus-durable-log leaderboard. With more time I\'d cover plagiarism detection and multi-region judge placement."' },
      ],
      grading: "Redis-vs-Postgres roles stated explicitly, the freeze window named unprompted, at least one pushback on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working submit-and-judge pipeline that hangs together, but the security and determinism reasoning stays shallow.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: a queue, worker pool, and a database for submissions.",
          "Knows judging has to be async and returns a status the client can poll.",
          "Names Docker as the sandbox without being asked why it's needed.",
          "Can write the submit/get-status endpoints and a basic submission schema.",
          "Handles contests by adding 'a leaderboard table' with no ranking data structure named.",
        ],
        gaps: [
          "Treats Docker as a sufficient security boundary, without acknowledging the shared-kernel risk.",
          "Times TLE off wall clock with no awareness that this produces false positives under load.",
          "No plan for a contest burst beyond 'autoscaling handles it'.",
          "Doesn't distinguish MLE from RE, or misses the compile-error short-circuit.",
          "Leaderboard is a plain SQL query with ORDER BY, no discussion of update cost at scale.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, defends the sandbox and verdict choices with reasons, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the steady-state and burst submission rates on the board within the first 5 minutes.",
          "Rejects Docker as a hard security boundary and names gVisor or an equivalent user-space kernel approach.",
          "States the verdict precedence order (CE > RE > TLE > MLE > WA > AC) without prompting.",
          "Uses cgroup-based CPU accounting instead of wall clock, when asked why TLEs might be flaky.",
          "Uses a Redis sorted set for the leaderboard and can explain the O(log N) update cost.",
          "Separates contest and practice queues when asked how bursts are isolated.",
          "Names idempotency keys for retried submissions when asked about duplicate handling.",
        ],
        gaps: [
          "Brings up predictive/scheduled pre-scaling only after being asked why reactive autoscaling isn't enough.",
          "Doesn't volunteer the leaderboard freeze window or post-contest reconciliation from the durable log.",
          "Explains exactly-once at a high level but doesn't connect offset-commit-after-persist to worker crash recovery specifically.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats the contest burst as a scheduled event rather than a generic scaling problem, and surfaces the security and consistency risks before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Derives the sandbox fleet size from Little's Law (throughput × latency) rather than guessing a headcount.",
          "Volunteers the tiered sandboxing model (gVisor default, Firecracker escalation) and the specific abuse-signal trigger for escalation.",
          "Explains why reactive autoscaling structurally cannot meet a 60-second burst window, and proposes scheduled pre-scaling unprompted.",
          "Names the cgroup-vs-wall-clock determinism trap before being asked why TLEs might be flaky.",
          "States explicitly that Redis is a read-optimized view and Postgres's submission log is the source of truth, with reconciliation as a named step.",
          "Brings up the leaderboard freeze window and its anti-sniping purpose without prompting.",
          "Closes with a one-sentence summary and an explicit list of what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Treating Docker or a raw chroot as a sufficient security boundary for arbitrary untrusted code at scale.",
      "Timing TLE off wall-clock duration, producing false verdicts whenever the host is under contention.",
      "Judging synchronously inside the HTTP request, so a slow sandbox blocks the client connection.",
      "No idempotency story: a retried submit or a redelivered Kafka message silently double-judges or double-counts.",
      "Reacting to a contest burst only via generic queue-depth autoscaling, ignoring that the start time is known in advance.",
      "Treating Redis as the leaderboard's source of truth with no durable log to reconcile against.",
      "Skipping the compile-error short-circuit and running the full test suite even when the code doesn't build.",
    ],
    followUps: [
      {
        q: "Why gVisor instead of just Docker containers for every submission?",
        a: "Docker's isolation is namespaces and cgroups on top of one shared host kernel — a container-escape kernel CVE is a full host compromise, and this platform's entire job is running code it explicitly doesn't trust. gVisor intercepts syscalls in a user-space kernel, so the real host kernel's syscall surface is barely exposed to the sandboxed process, at a small overhead cost. It's a materially stronger default boundary for roughly the same operational simplicity as a container.",
      },
      {
        q: "How do you prevent a false Time Limit Exceeded caused by a noisy host?",
        a: "Never time off wall clock. A busy host can steal scheduler time from a sandbox through no fault of the submitted code, and wall-clock timing then reports a TLE for a program that would have passed on an idle host. Instead, read CPU time from the cgroup's own accounting (cpu.stat), which reflects actual CPU nanoseconds consumed by that cgroup regardless of what else is running on the box, making the verdict reproducible.",
      },
      {
        q: "What happens if a judge worker crashes mid-execution?",
        a: "The Kafka consumer only commits the offset for a judge job after the verdict has been durably persisted to Postgres. If the worker crashes before that persist happens, the offset is never committed, so the message is redelivered to another worker and rejudged. Because the result write is keyed on the submission's idempotency key, a rejudge simply overwrites the same row rather than creating a duplicate — the combination of at-least-once delivery and an idempotent write gives effectively-once behavior without a distributed transaction.",
      },
      {
        q: "Why not run everything in Firecracker microVMs for maximum security all the time?",
        a: "Firecracker's separate-kernel boundary is strictly stronger than gVisor's, but it pays a real cold-boot cost, roughly 125ms, which is significant against a 3s median judge time and becomes painful at 15,000 concurrent sandboxes during a contest burst. The tiered approach uses gVisor as the default — strong enough for the vast majority of well-behaved submissions — and reserves Firecracker for accounts flagged by an abuse signal, so the platform pays the stronger, slower boundary only where the risk actually justifies it.",
      },
      {
        q: "How does the leaderboard stay correct if Redis loses data mid-contest?",
        a: "Redis is deliberately treated as a read-optimized cache of standings, never as the authority. The Postgres submission log is append-only and durable, and it's what every accepted verdict is ultimately recorded in. If Redis restarts or loses state mid-contest, live standings degrade temporarily, but the moment the contest ends, final standings are recomputed directly from the Postgres log, so the official result can never be corrupted by a cache failure.",
      },
      {
        q: "How do you support 15+ languages without needing 15 separate judge fleets?",
        a: "Each language gets its own pre-built sandbox image (compiler/runtime baked in) but the same gVisor/Firecracker execution harness, resource-limiting logic, and verdict pipeline are shared across all of them — only the compile-and-run command differs per language. Judge workers are generic; they pull the right image for a job's language field and run the same compile → execute → compare state machine regardless of which language it is, so adding a 16th language is a new container image, not a new subsystem.",
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
          "This is a content platform (problems, users, submission history) wrapped around one genuinely hard subsystem: safely executing arbitrary untrusted code at scale and returning a deterministic verdict. Browsing is ordinary CRUD; submitting triggers an async, sandboxed pipeline that has to be secure, fast, and fair under a predictable but massive contest burst.",
          "Anchor everything on five numbers: 50M users, 3,000+ problems, 500 submissions/sec sustained, 5,000/sec at contest burst, and a p99 judge latency under 3 seconds. Every structural choice below — sandbox tiering, queue partitioning, autoscaling policy — is a consequence of these numbers.",
        ],
      },
      {
        heading: "Sizing the judge fleet",
        body: [
          "Little's Law converts throughput and latency into concurrency: 500 submissions/sec × ~3s average judge time ≈ 1,500 concurrent sandboxes at steady state. The same math at contest burst — 5,000/sec × 3s — gives ~15,000 concurrent sandboxes, a 10× spike lasting roughly one minute.",
          "That gap is the whole argument for autoscaling: provisioning 15,000 sandboxes permanently is wasteful, provisioning only 1,500 collapses the contest opening minute. The fleet has to move between the two, and because contest starts are scheduled, that move can be predictive rather than purely reactive.",
        ],
      },
      {
        heading: "Sandboxing untrusted code",
        body: [
          "The isolation requirement is unusually sharp: every submission is arbitrary code from an untrusted user, executed on shared infrastructure, on purpose. A raw process with ulimit/seccomp and a Docker container both still share the host kernel — a syscall bug or container-escape CVE in either is a full host compromise, unacceptable at this scale.",
          "gVisor intercepts syscalls in a user-space kernel, dramatically shrinking the exposed attack surface at low overhead, and is the default for every submission. Firecracker microVMs give a genuinely separate kernel per sandbox — the strongest available boundary — at the cost of a ~125ms cold boot, hidden behind a pre-warmed pool and reserved for users an abuse signal has flagged. Every submission, regardless of tier, also gets hard cgroup caps: 256MB memory, a CPU quota matching the problem's time limit, and no network egress.",
        ],
      },
      {
        heading: "Determinism in verdicts",
        body: [
          "A verdict follows strict precedence: Compile Error short-circuits everything (no test ever runs against code that doesn't build); otherwise the first failing hidden test — Runtime Error, Time Limit Exceeded, Memory Limit Exceeded, or Wrong Answer — stops the run and becomes the verdict, unless a full-suite run was explicitly requested for diagnostics.",
          "The determinism trap is timing: wall-clock duration is subject to host noisy-neighbor scheduling jitter, so an identical program can flicker between Accepted and a false TLE run to run. CPU time is measured from the cgroup's own accounting instead, immune to what else is running on the host. Memory is enforced via cgroup memory.max with an OOM-kill, which is how MLE is correctly distinguished from a crash-style Runtime Error. The network namespace is disabled entirely — both a security measure and a determinism one, since it removes any dependency on external, changeable state.",
        ],
      },
      {
        heading: "Contests: bursts, priority, and predictive autoscaling",
        body: [
          "A weekly contest's start time is known well in advance, so the burst is a scheduled event, not a surprise — and reactive autoscaling that watches queue depth typically takes 30-60 seconds to react, too slow when the burst front-loads almost entirely into the first minute. The fleet and sandbox pool are pre-scaled 5-10 minutes ahead of a known contest start instead of waiting for demand to trigger scaling.",
          "Contest submissions and casual practice submissions sit on separate Kafka partitions so a contest burst can never starve normal judging. If demand still momentarily exceeds capacity, the client is shown a real queue position rather than a silent stall — fairness within a FIFO partition rather than an opaque hang.",
        ],
      },
      {
        heading: "Exactly-once judging and the leaderboard",
        body: [
          "A submission carries a client-generated idempotency key so a retried network call never enqueues twice, and a Kafka consumer only commits its offset after the verdict is durably persisted, so a worker crash mid-run causes a safe redelivery-and-rejudge rather than a lost result — the idempotent write means a redelivery overwrites the same row instead of duplicating it. Status is pushed to the client over WebSocket via a per-submission Redis Pub/Sub channel, with polling as a fallback so an update is only ever delayed, never lost.",
          "The contest leaderboard is a Redis sorted set for O(log N) live rank updates, scored on problems solved and penalty time, frozen for the last 5-10 minutes to prevent rank sniping. Redis is a read-optimized view, not the authority — Postgres's append-only submission log is the source of truth, and final standings are always recomputed from it after the contest closes, so a mid-contest cache restart can never corrupt the official result.",
        ],
      },
    ],
  },
};
