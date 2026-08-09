import type { Problem } from "@/lib/types";

export const jobScheduler: Problem = {
  slug: "job-scheduler",
  num: "3.4",
  title: "Design a Job Scheduler",
  level: "Medium",
  deepDiveAvailable: true,
  intro: [
    "Design a distributed job scheduler that holds 10 million scheduled jobs (cron, fixed-interval, and one-off), triggers up to 50K jobs/minute at peak within a p99 skew of 5 seconds, and never silently double-fires or drops a job even as scheduler nodes crash and restart.",
  ],
  hardParts:
    "The hard parts: claiming a due job exactly once across a fleet of scheduler nodes without a single bottleneck leader, turning Kafka's at-least-once delivery into effectively-once execution downstream, and defining an explicit policy for what happens to the jobs that should have fired while the scheduler itself was down.",
  keyTopics: [
    "Sharded Polling + SKIP LOCKED",
    "Hashed Timing Wheel Lookahead",
    "Idempotency-Keyed At-Least-Once Delivery",
    "Timezone-Aware Cron with DST Handling",
    "Configurable Misfire / Catch-Up Policy",
  ],
  foundationsReferenced: [
    { label: "Consistent Hashing", tone: "purple" },
    { label: "etcd / ZooKeeper Leases", tone: "orange" },
    { label: "Postgres SELECT...FOR UPDATE SKIP LOCKED", tone: "blue" },
    { label: "Kafka", tone: "orange" },
    { label: "Idempotency & Exactly-Once Processing", tone: "green" },
    { label: "Hashed Timing Wheel", tone: "purple" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "api", label: "Scheduler API", sub: "CRUD jobs · idempotent create", col: 2, row: 1, tone: "green" },
      {
        id: "jobstore",
        label: "Job Store",
        sub: "Postgres · sharded by job_id",
        mono: "next_run_at B-tree index",
        col: 3,
        row: 1,
        tone: "blue",
      },
      { id: "etcd", label: "etcd", sub: "shard leases · leader lease", col: 1, row: 2, tone: "orange" },
      {
        id: "ticker",
        label: "Scheduler Nodes",
        sub: "each owns a shard range",
        mono: "hashed timing wheel · 5-min lookahead",
        col: 2,
        row: 2,
        tone: "purple",
      },
      { id: "kafka", label: "Kafka", sub: "trigger topic · key=job_id", col: 3, row: 2, tone: "orange" },
      { id: "worker", label: "Worker Pool", sub: "dispatchers · autoscale", col: 4, row: 2, tone: "green" },
      { id: "target", label: "Target", sub: "webhook / Lambda / queue", col: 5, row: 2, tone: "slate" },
      { id: "redis", label: "Redis", sub: "idempotency SETNX · TTL", col: 2, row: 3, tone: "purple" },
      { id: "exechistory", label: "Execution History", sub: "Cassandra · time-series", col: 3, row: 3, tone: "blue" },
      { id: "dlq", label: "DLQ", sub: "after max retries", col: 4, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "api", label: "create/update/cancel", kind: "write" },
      { from: "api", to: "jobstore", label: "validate cron · upsert", kind: "write" },
      { from: "etcd", to: "ticker", label: "shard lease", kind: "read" },
      { from: "jobstore", to: "ticker", label: "poll due · FOR UPDATE SKIP LOCKED", kind: "read" },
      { from: "ticker", to: "jobstore", label: "advance next_run_at (cron)", kind: "write" },
      { from: "ticker", to: "kafka", label: "publish trigger · idempotency key", kind: "write" },
      { from: "kafka", to: "worker", label: "consume · at-least-once", kind: "write" },
      { from: "worker", to: "redis", label: "dedupe check", kind: "read" },
      { from: "worker", to: "target", label: "execute", kind: "write" },
      { from: "worker", to: "exechistory", label: "async · write execution record", kind: "analytics" },
      { from: "worker", to: "dlq", label: "after N retries", kind: "analytics" },
      { from: "api", to: "exechistory", label: "status query", kind: "read" },
    ],
    legend: [
      { kind: "read", text: "read path · shard leases, due-job polling, status queries" },
      { kind: "write", text: "write path · job CRUD and the claim-to-dispatch chain" },
      { kind: "analytics", text: "async · execution history and DLQ, never blocks dispatch" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Create a scheduled job (cron expression, fixed interval, or one-off timestamp) with a payload up to 256KB", tag: "P0" },
      { id: "FR-02", text: "Support standard cron syntax with per-job timezone (e.g. \"0 9 * * MON-FRI\" in America/New_York)", tag: "P0" },
      { id: "FR-03", text: "Trigger job execution within a bounded skew of the scheduled time", tag: "P0" },
      { id: "FR-04", text: "Deliver triggers at-least-once with an idempotency key so consumers can dedupe to effectively-once", tag: "P0" },
      { id: "FR-05", text: "Update or cancel an existing scheduled job", tag: "P0" },
      { id: "FR-06", text: "Retry failed executions with exponential backoff and jitter, up to a configurable max attempts", tag: "P0" },
      { id: "FR-07", text: "Dead-letter jobs that exceed max retries, with alerting", tag: "P1" },
      { id: "FR-08", text: "Support multiple execution targets: HTTP webhook, message-queue publish, container/Lambda invoke", tag: "P1" },
      { id: "FR-09", text: "Query job status and execution history (last N runs, success/failure, latency)", tag: "P1" },
      { id: "FR-10", text: "Pause and resume a job without deleting its schedule", tag: "P1" },
      { id: "FR-11", text: "One-off \"run at this exact timestamp\" jobs alongside recurring ones", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Scheduling skew, scheduled time to trigger publish", tag: "p99 < 5s" },
      { id: "NFR-02", text: "Missed-fire rate (should have fired, didn't, within the grace window)", tag: "< 0.001%" },
      { id: "NFR-03", text: "Sustained trigger throughput, peak", tag: "50K/min" },
      { id: "NFR-04", text: "Total scheduled jobs stored", tag: "10M jobs" },
      { id: "NFR-05", text: "Scheduler availability", tag: "99.95%" },
      { id: "NFR-06", text: "Durability: no scheduled job silently lost", tag: "zero loss" },
      { id: "NFR-07", text: "Delivery semantics: at-least-once, deduped downstream", tag: "effectively-once" },
      { id: "NFR-08", text: "Job store create/update latency", tag: "p99 < 50ms" },
      { id: "NFR-09", text: "Status-read to schedule-write ratio that anchors sizing", tag: "20:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why a naive poll dies long before 10M jobs",
      body: [
        "The obvious first design is one process running `SELECT * FROM jobs WHERE next_run_at <= NOW()` every second. That query is indexed, so it looks cheap — but at 10M jobs the index still returns a growing due-set every tick, a single process has to iterate and update every row it finds, and there is exactly one place doing all of it. Push trigger volume to 50K/min (roughly 830/sec) and that one process is now the entire system's throughput ceiling.",
        "The fix is not a bigger box, it's removing the single point of both work and coordination: shard the job space by a hash of job_id into N ranges, and let each shard be owned and polled independently. Throughput becomes horizontal — add scheduler nodes, add shards, done.",
      ],
      bullets: [
        { lead: "Single poller", text: "simple to reason about, but throughput and availability both cap at one process; it is also the one thing that, when it stalls, silently stalls every job in the system." },
        { lead: "Sharding by job_id hash", text: "e.g. 256 shards over 10M jobs is ~40K jobs/shard — small enough that a shard-owner's due-set query and update batch stay fast even at peak." },
        { lead: "Shard count is a capacity knob", text: "picked from expected job count and desired jobs-per-shard, the same reasoning as picking partition counts for a Kafka topic." },
      ],
      pictureTitle: "One poller vs. sharded polling at 10M jobs",
      pictureRows: [
        { label: "Single process, full-table poll", value: "throughput and availability cap at 1 node", tone: "bad" },
        { label: "256 shards, ~40K jobs/shard", value: "throughput scales with node count", tone: "good" },
      ],
      remember: {
        problem: "A single poller cannot keep up with 10M jobs and 50K triggers/min.",
        solution: "Hash-partition jobs into shards (e.g. 256) and let each shard be independently owned and polled.",
        why: "Sharding turns a fixed one-process ceiling into a horizontal capacity knob — add nodes, add shards.",
        tradeoff: "You now need shard ownership and rebalancing, which a single poller never had to solve.",
        failure: "Under-shard and one node's poll query and update batch grow until it misses its tick deadline.",
        mitigation: "Size shard count from jobs-per-shard, monitor per-shard poll latency, and split hot shards.",
      },
    },
    {
      n: 2,
      title: "Claiming due jobs without double-firing",
      body: [
        "Sharding introduces a new risk: two scheduler nodes both believing they own the same shard, both firing the same job. There are two independent defenses, and the right answer uses both rather than picking one.",
        "First, shard ownership itself: each scheduler node holds a lease on its shard range in etcd (or ZooKeeper), renewed on a heartbeat; if a node dies, its lease expires and another node takes over after a bounded gap. Second — and this is the one people skip — even ownership handoff has a window where two nodes might briefly both think they own a shard, so the actual claim of an individual due job goes through the database with `SELECT ... FOR UPDATE SKIP LOCKED`, which atomically claims a row and lets any other node polling the same rows just skip past what's already locked.",
      ],
      bullets: [
        { lead: "Lease-based shard ownership", text: "etcd lease gives one node authority over a shard range; on crash, the lease times out and another node claims it — bounded, not instant, failover." },
        { lead: "SKIP LOCKED as the real dedupe", text: "the database row lock is what actually prevents two processes from both firing the same job during a lease handoff gap; the lease is an optimization, not the safety net." },
        { lead: "Stale-claim recovery", text: "a job claimed but never published to Kafka (node died mid-dispatch) gets a `claimed_at` timestamp; a shard-owner sweeps and re-claims anything claimed longer than a dispatch timeout ago." },
      ],
      pictureTitle: "Two independent defenses against double-firing",
      pictureRows: [
        { label: "etcd shard lease", value: "coarse ownership, bounded failover", tone: "neutral" },
        { label: "Postgres SKIP LOCKED", value: "the actual per-row exactly-once claim", tone: "good" },
        { label: "Lease-only, no row lock", value: "handoff window can double-fire", tone: "bad" },
      ],
      remember: {
        problem: "Two scheduler nodes must never both fire the same due job.",
        solution: "etcd leases for coarse shard ownership, plus `SELECT FOR UPDATE SKIP LOCKED` for the actual atomic claim.",
        why: "Lease handoff has a window where ownership is ambiguous; the row lock is what makes the claim safe regardless.",
        tradeoff: "Row-level locking adds DB contention under very hot shards versus a lease-only design.",
        failure: "Trusting the lease alone lets a handoff race double-fire a job during the crash-to-takeover gap.",
        mitigation: "Always claim through SKIP LOCKED; sweep and re-claim stale `claimed_at` rows past a dispatch timeout.",
      },
    },
    {
      n: 3,
      title: "The hashed timing wheel: precision without hammering the DB",
      body: [
        "Even with sharding, polling the DB every second for every shard is wasteful — most seconds, nothing in a given shard is due. The fix borrowed from Kafka's delay queue and OS timer implementations is a hashed timing wheel: each shard-owner sweeps its shard's due-set for the next 5 minutes into an in-memory structure once a minute, then a lightweight in-process ticker fires jobs at the right second from memory, no DB round-trip needed for the actual fire.",
        "This decouples DB read frequency (once a minute) from trigger precision (still sub-second), which is exactly the trade a timing wheel is built for: O(1) insert and fire, bounded memory for the lookahead window.",
      ],
      bullets: [
        { lead: "Lookahead sweep", text: "every 60s, pull `next_run_at` between now and now+5min for this shard into the wheel; a job due in 6 minutes simply isn't loaded yet." },
        { lead: "In-memory fire", text: "the wheel advances every second and fires whatever bucket matches — no DB read on the hot second-by-second path." },
        { lead: "Bounded blast radius", text: "if a scheduler node restarts, it loses at most 5 minutes of wheel state, which the next sweep rebuilds — never a source of missed jobs by itself." },
      ],
      pictureTitle: "DB reads vs. trigger precision",
      pictureRows: [
        { label: "Poll DB every second", value: "830 req/sec DB load at peak", tone: "bad" },
        { label: "Sweep every 60s + in-memory wheel", value: "same sub-second precision, ~1/60th the DB load", tone: "good" },
      ],
      remember: {
        problem: "Sub-second trigger precision without polling the DB every second per shard.",
        solution: "Sweep a 5-minute lookahead into an in-memory hashed timing wheel every 60s; fire from memory.",
        why: "Decouples DB read frequency from fire precision — the wheel does O(1) second-level ticking with no DB hop.",
        tradeoff: "Adds in-memory state that must be rebuilt correctly after a restart or shard handoff.",
        failure: "A node that never re-sweeps after taking over a shard silently stops firing that shard's jobs.",
        mitigation: "Re-sweep immediately on shard acquisition, not just on the 60s timer, so a handoff can't create a gap.",
      },
    },
    {
      n: 4,
      title: "At-least-once delivery and why 'exactly once' is a myth here",
      body: [
        "Once a job is claimed, the scheduler publishes a trigger event to Kafka and a worker pool consumes it to actually execute. Kafka gives at-least-once delivery: consumer rebalances, retries, and redelivery after a slow ack can all cause the same trigger to be delivered twice. There is no way to make the end-to-end pipeline truly exactly-once without an idempotent consumer — that is a property of distributed systems, not a bug to engineer away.",
        "So the design goal shifts: guarantee at-least-once delivery, and make duplicates harmless. The idempotency key is `job_id + scheduled_run_timestamp`; before executing, the worker does a `SETNX` in Redis with a TTL longer than the max processing time. If the key already exists, it's a duplicate delivery and the worker skips execution and just acks.",
      ],
      bullets: [
        { lead: "Idempotency key", text: "job_id + scheduled_run_timestamp uniquely identifies one intended firing, independent of how many times Kafka redelivers it." },
        { lead: "Redis SETNX + TTL", text: "the dedupe check itself must be atomic and fast; TTL must exceed worst-case execution time or a slow job can look 'done' before it's finished and let a real duplicate through." },
        { lead: "Downstream idempotency still matters", text: "if the target is a webhook, the scheduler's dedupe only protects the trigger step — a genuinely-once effect at the target requires the target to also treat the idempotency key as a dedupe token." },
      ],
      pictureTitle: "At-least-once + dedupe = effectively-once",
      pictureRows: [
        { label: "Kafka redelivery (rebalance, retry)", value: "expected, not a bug", tone: "neutral" },
        { label: "No idempotency key", value: "redelivery = real double-execution", tone: "bad" },
        { label: "SETNX(job_id+scheduled_ts) before execute", value: "duplicate delivery is a no-op", tone: "good" },
      ],
      remember: {
        problem: "Kafka can redeliver a trigger; a naive worker would execute the job twice.",
        solution: "Idempotency key = job_id + scheduled_run_timestamp, deduped via Redis SETNX with a TTL past max processing time.",
        why: "True exactly-once delivery is impossible across a network hop; effectively-once is achieved by making duplicates harmless.",
        tradeoff: "Adds a Redis dependency on the execute path and a TTL that must be tuned against worst-case job duration.",
        failure: "A TTL shorter than actual execution time lets a slow job's retry redeliver as a real duplicate.",
        mitigation: "Set TTL generously above p99.9 execution time, and require targets to be idempotent for genuinely-once side effects.",
      },
    },
    {
      n: 5,
      title: "Cron correctness: timezones and DST are where bugs actually live",
      body: [
        "Cron math looks trivial and is the single most common source of real production incidents in schedulers. A job defined as \"every day at 2:30am America/New_York\" is not a fixed UTC offset — it's a local-time rule that must be re-evaluated against the calendar every time, because the offset between America/New_York and UTC changes twice a year.",
        "Store the cron expression and the IANA timezone name (never a raw UTC offset) on the job, and recompute `next_run_at` in that local timezone on every advance, using a timezone-aware cron library that understands DST rules for that zone.",
      ],
      bullets: [
        { lead: "Spring forward", text: "clocks jump from 2:00am to 3:00am; a job scheduled for 2:30am literally does not exist that day. The scheduler must either skip it or shift it, and which one is a product decision, not a bug." },
        { lead: "Fall back", text: "1:30am happens twice; a naive fixed-offset implementation can fire the same 'daily' job twice in one calendar day." },
        { lead: "Never bake in a UTC offset", text: "storing 'UTC-5' instead of 'America/New_York' is the actual root cause of most DST bugs — the offset is only correct for part of the year." },
      ],
      pictureTitle: "Fixed UTC offset vs. IANA timezone",
      pictureRows: [
        { label: "Store fixed UTC-5 offset", value: "wrong for half the year (DST)", tone: "bad" },
        { label: "Store 'America/New_York' + recompute locally", value: "correct across DST transitions", tone: "good" },
      ],
      remember: {
        problem: "'Every day at 2:30am local time' must stay correct across DST transitions.",
        solution: "Store the IANA timezone name with the job; recompute next_run_at in local time each advance via a DST-aware cron library.",
        why: "The UTC offset for a timezone isn't constant; baking it in is correct half the year and wrong the other half.",
        tradeoff: "Local-time recomputation is more CPU per advance than a cached fixed offset, but it's the only correct option.",
        failure: "A fixed-offset implementation double-fires on the fall-back day and skips or misfires on the spring-forward day.",
        mitigation: "Use a timezone-aware cron library and unit-test both DST edges explicitly for every supported zone.",
      },
    },
    {
      n: 6,
      title: "Missed-fire policy: what happens when the scheduler was dark",
      body: [
        "If every scheduler node is down for 10 minutes, some jobs' scheduled times pass with nobody watching. On restart, what happens is a real product decision with three defensible answers, and picking implicitly (by accident, whatever the code happens to do) is the actual red flag — not any particular answer.",
        "Quartz calls these 'misfire instructions' and the same three options apply here: fire once immediately to catch up, fire nothing and just resume the normal schedule, or fire every single missed occurrence. The right default differs by job type, so make it a per-job setting, not a global one.",
      ],
      bullets: [
        { lead: "Fire-now (catch-up-once)", text: "run the job once immediately, then resume normal schedule — good for 'sync inventory every hour', bad for 'send the 9am digest email' if it's now 2pm." },
        { lead: "Skip-to-latest", text: "don't fire for missed occurrences at all, just wait for the next scheduled time — good for time-sensitive notifications where a stale run is worse than a skipped one." },
        { lead: "Fire-all-missed", text: "replay every occurrence that was missed — correct for jobs where each occurrence matters (e.g. per-minute billing ticks) but can cause a thundering-herd of catch-up work after a long outage." },
      ],
      pictureTitle: "Three misfire policies, three different jobs",
      pictureRows: [
        { label: "Fire-now", value: "good for idempotent sync jobs", tone: "neutral" },
        { label: "Skip-to-latest", value: "good for time-sensitive notifications", tone: "neutral" },
        { label: "Fire-all-missed", value: "good for per-tick jobs, risks a replay storm", tone: "bad" },
        { label: "No explicit policy", value: "outage behavior is undefined, both bad options possible", tone: "bad" },
      ],
      remember: {
        problem: "Jobs whose scheduled time passed while the scheduler was down need a defined outcome.",
        solution: "Explicit, per-job misfire policy: fire-now, skip-to-latest, or fire-all-missed.",
        why: "The right behavior depends on the job — a digest email and a billing tick need opposite defaults.",
        tradeoff: "Fire-all-missed guarantees no lost occurrences but risks a replay storm on downstream targets after an outage.",
        failure: "Leaving the policy implicit means an outage silently drops jobs or storms targets, and nobody chose that on purpose.",
        mitigation: "Require a misfire policy at job-creation time with a sane default, and grace-window it (only catch up if the gap is under N hours).",
      },
    },
    {
      n: 7,
      title: "Retry storms and protecting the downstream target",
      body: [
        "A failure mode unique to schedulers: many jobs pointing at the same downstream target (say, a webhook endpoint) fail at once because that target went down. Naive immediate retries from every worker turn a brief target outage into a sustained one, because the retry traffic itself becomes the load that keeps the target down.",
        "Exponential backoff with jitter spaces out each individual job's retries; a circuit breaker per target stops sending new attempts once failure rate crosses a threshold, giving the target room to recover; and after max attempts a job goes to a dead-letter queue with alerting rather than retrying forever.",
      ],
      bullets: [
        { lead: "Exponential backoff + jitter", text: "spacing retries as 1s, 2s, 4s, 8s... with random jitter prevents every failed job from retrying in lockstep and re-creating the exact spike that caused the failure." },
        { lead: "Per-target circuit breaker", text: "once a target's failure rate crosses a threshold, stop dispatching new attempts to it for a cooldown window — protects the target and stops burning worker capacity on requests likely to fail." },
        { lead: "Dead-letter after max attempts", text: "a job that has genuinely exhausted retries needs a human or an automated remediation to look at it, not an infinite retry loop quietly consuming capacity forever." },
      ],
      pictureTitle: "Retry storm vs. protected retry",
      pictureRows: [
        { label: "Immediate retry, no backoff", value: "retry traffic sustains the outage", tone: "bad" },
        { label: "Backoff + jitter + circuit breaker", value: "target gets room to recover", tone: "good" },
        { label: "Max attempts exceeded", value: "DLQ + alert, not infinite retry", tone: "neutral" },
      ],
      remember: {
        problem: "Many jobs failing against the same downstream target can turn a brief outage into a sustained one.",
        solution: "Exponential backoff with jitter, a per-target circuit breaker, and a DLQ after max attempts.",
        why: "Uncoordinated immediate retries from many workers become the load that keeps a struggling target down.",
        tradeoff: "Backoff and circuit-breaking delay legitimate recovery slightly in exchange for not amplifying an outage.",
        failure: "No circuit breaker means retries keep pounding a target that would otherwise have recovered in seconds.",
        mitigation: "Track per-target failure rate, trip the breaker on threshold, and DLQ with alerting past max attempts.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a claim-and-dispatch system: find jobs whose time has come, claim each one exactly once, and hand it to a queue so execution never blocks scheduling.",
      "Scaling past a few thousand jobs means you stop scanning the whole table every second — shard the jobs, and let each scheduler node keep an in-memory timing wheel for just its shard's near-term future.",
      "Delivery is at-least-once by construction (Kafka can redeliver); the idempotency key plus a downstream dedupe cache is what turns that into 'effectively once'.",
      "Cron math is deceptively hard — timezone and DST bugs are the number one real-world source of double-fires and silent skips.",
      "When the scheduler itself goes down, you need an explicit per-job policy for what happens to the jobs that should have fired while it was dark.",
    ],
    flows: [
      {
        kind: "write",
        title: "WRITE · JOB CREATE / UPDATE",
        summary:
          "A client submits a cron or one-off schedule. The API validates the cron expression and timezone, computes the first next_run_at, and upserts the row. Nothing about scheduling happens synchronously here.",
        steps: [
          { label: "Client", note: "submits cron/interval/one-off + payload" },
          { label: "Scheduler API", note: "validate cron, resolve timezone" },
          { label: "Job Store", note: "upsert · compute next_run_at" },
        ],
      },
      {
        kind: "write",
        title: "ASYNC · CLAIM AND DISPATCH · 50K/MIN PEAK",
        summary:
          "This is the core loop. Each shard-owning scheduler node sweeps its due-set into an in-memory timing wheel, claims each job atomically, publishes a trigger, and a worker pool executes it against the target.",
        steps: [
          { label: "etcd", note: "shard lease held by this node" },
          { label: "Job Store", note: "sweep due-set, 5-min lookahead" },
          { label: "Timing wheel", note: "in-memory second-level fire" },
          { label: "SKIP LOCKED claim", note: "atomic per-row, no double-fire" },
          { label: "Kafka trigger topic", note: "key=job_id, idempotency key attached" },
          { label: "Worker Pool", note: "Redis SETNX dedupe, then execute" },
          { label: "Target", note: "webhook / Lambda / queue" },
        ],
      },
      {
        kind: "read",
        title: "READ · STATUS AND HISTORY",
        summary:
          "Status and execution-history reads never touch the hot scheduling path — they go straight to the execution history store, which the worker pool writes to asynchronously.",
        steps: [
          { label: "Client", note: "GET job status / history" },
          { label: "Scheduler API", note: "read-only query" },
          { label: "Execution History", note: "Cassandra, time-series by job_id" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "10M scheduled jobs stored, 50K triggers/min sustained peak",
          "Scheduling skew: p99 < 5s from scheduled time to trigger publish",
          "Shard count: ~256 shards over job_id hash, ~40K jobs/shard",
          "Timing wheel: 5-min lookahead, resynced every 60s",
          "Idempotency TTL: > max processing time (e.g. 10 min)",
          "Missed-fire grace window: default 60s before a job counts as missed",
          "Job payload cap: 256KB, larger payloads referenced by pointer",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "SKIP LOCKED row claims, not a single global leader — throughput scales with shard count",
          "In-memory hashed timing wheel per shard, not per-second full-table polling",
          "Kafka as the trigger bus, decoupling 'decided to fire' from 'actually executed'",
          "Idempotency key = job_id + scheduled_run_ts, deduped in Redis before execution",
          "Timezone (IANA name) stored on the job, next_run_at recomputed in local time each tick",
          "Per-job configurable misfire policy: fire-now, skip-to-latest, or fire-all-missed",
          "Exponential backoff + jitter + per-target circuit breaker, DLQ after max attempts",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "'Exactly once' triggering doesn't exist end-to-end — it's at-least-once delivery plus an idempotent consumer",
          "DST transitions are a real, quantifiable bug source — say how a 2:30am cron job behaves on both DST edges",
          "Missed-fire policy must be explicit per job, or an outage silently drops or storm-replays work",
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
      goal: "Lock the job count, trigger rate, precision target, and delivery guarantee before drawing anything.",
      why: "Every later decision — shard count, whether you need a timing wheel at all, how tight the idempotency window is — falls straight out of these numbers. Getting them on the board first is what lets you defend design choices as consequences, not preferences.",
      steps: [
        { kind: "ASK", text: '**"How many scheduled jobs, and what\'s peak trigger volume?"** Land on "10M jobs, 50K triggers/min peak" and write **"10M jobs, 50K/min peak"** in the corner.' },
        { kind: "ASK", text: '**"How precise does the trigger time need to be?"** Land on "sub-5-second skew at p99", not "exactly on the second" — that number decides whether you need a timing wheel or a plain poll suffices.' },
        { kind: "SAY", text: 'Propose the delivery guarantee yourself: **"at-least-once delivery, effectively-once via an idempotency key"**. Get them to accept exactly-once end-to-end is not realistic before you build toward it.' },
        { kind: "SAY", text: 'State scope. In: "cron/interval/one-off scheduling", "claim-and-dispatch", "retries and DLQ", "misfire policy". Out: "the actual job execution logic (it just calls a webhook/queue)", "auth", "multi-tenant quotas". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Write the read:write anchor: **"20:1 status reads to schedule writes"** — this is what tells you the read path (status/history) and write path (create/claim/dispatch) need very different infra.' },
      ],
      grading: "Numbers written on the board within 5 minutes, the exactly-once-is-impossible framing stated up front, and scope explicitly parked rather than silently assumed.",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Three endpoints, one job row with the fields that make claiming and cron correctness possible, before anyone asks for them.",
      why: "The interviewer is checking whether the schema already anticipates the hard parts — next_run_at for claiming, timezone for DST correctness, claimed_at for stale-claim recovery — rather than being patched in later when a gap is found.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /jobs { schedule, timezone, payload, target, misfire_policy }"**, **"PATCH /jobs/:id"**, **"DELETE /jobs/:id"**, **"GET /jobs/:id/history"**.' },
        { kind: "DRAW", text: 'Sketch the row: **"job_id (PK)"**, **"cron_expr"**, **"timezone (IANA name, not offset)"**, **"next_run_at"**, **"status (active/paused)"**, **"claimed_at"**, **"misfire_policy"**, **"shard_id"**. Say out loud: "timezone is an IANA name, never a fixed UTC offset — that\'s what keeps DST correct."' },
        { kind: "SAY", text: 'Justify the 256KB payload cap: "large payloads get referenced by pointer, e.g. an S3 URL, so the job store row stays small and the index stays fast."' },
        { kind: "RULE OUT", text: 'Get ahead of it: "storing a fixed UTC offset instead of a timezone name" — cross it off, "that\'s the number one cause of DST double-fires and I want it out of the design from the start."' },
      ],
      grading: "The schema already has next_run_at, timezone-as-name, claimed_at, and misfire_policy without being prompted for each one individually.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 8,
      goal: "One diagram with write, claim-and-dispatch, and read lanes clearly separated, labeled with shares and latency budgets.",
      why: "This is the structural signal: creating a job, firing a job, and reading job status are three different workloads with three different SLAs. A candidate who draws one undifferentiated blob hasn't separated 'decide to fire' from 'actually executed', which is the seed of the double-firing bug.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write lane**: Client → Scheduler API → Job Store, labeled **"validate cron, upsert"**.' },
        { kind: "DRAW", text: 'Add the **claim-and-dispatch lane**: etcd (shard lease) + Job Store → Scheduler Nodes (timing wheel) → SKIP LOCKED claim → Kafka → Worker Pool → Target. Label arrows **"5-min lookahead"**, **"50K/min peak"**, **"at-least-once"**.' },
        { kind: "DRAW", text: 'Add the **read lane**: Client → Scheduler API → Execution History, dashed off the Worker Pool\'s async write. Label it **"20:1 vs. writes, never touches the claim path"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because deciding to fire, actually executing, and reading history all have different consistency and latency needs — mixing them is where double-firing and slow reads both come from."' },
      ],
      grading: "Three clearly separated lanes, the claim step visibly distinct from dispatch and from execution, and an explicit statement that execution history is async and off the claim path.",
    },
    {
      n: 4,
      title: "Deep Dive: Claiming Due Jobs Without Double-Firing",
      minutes: 8,
      goal: "Defend the two-layer defense — shard lease plus SKIP LOCKED — and walk the stale-claim recovery path.",
      why: "This is the signature sub-problem. The interviewer wants to see you name the handoff race (two nodes briefly both think they own a shard) and show the concrete mechanism that stays safe through it, not just 'use a lock'.",
      steps: [
        { kind: "SAY", text: 'State the shard lease: "Each scheduler node holds an etcd lease on a shard range, renewed on heartbeat. If a node dies, the lease expires and another node takes over after a bounded gap."' },
        { kind: "SAY", text: 'Name the gap: "Lease handoff has a window where ownership is ambiguous — the lease alone isn\'t enough." Then land the real defense: "the actual claim goes through `SELECT ... FOR UPDATE SKIP LOCKED` in Postgres, which atomically claims one row and lets a second node just skip it."' },
        { kind: "DRAW", text: 'Sketch the stale-claim recovery: a job claimed but never published (node died mid-dispatch) has an old `claimed_at`; the new shard owner sweeps and re-claims anything past a dispatch timeout.' },
        { kind: "RULE OUT", text: 'Cross off "lease-only, no row lock" — "that leaves a real double-fire window during handoff" — and "single global leader" — "caps throughput at one process."' },
      ],
      grading: "Both layers of defense named and correctly ordered (lease = coarse, SKIP LOCKED = actual safety), plus the stale-claim recovery mechanism volunteered.",
    },
    {
      n: 5,
      title: "Deep Dive: Timing Wheel, Cron/DST, and Retries",
      minutes: 8,
      goal: "Show the timing wheel's DB-load win, the timezone-as-name fix for DST, and the backoff/circuit-breaker chain for retries.",
      why: "These three sub-problems are where 'I know the pattern' candidates separate from 'I can quantify why it matters' candidates — each has a concrete number attached.",
      steps: [
        { kind: "SAY", text: 'Timing wheel: "Instead of polling per second, each shard sweeps a 5-minute lookahead into memory once a minute — same sub-second fire precision, about 1/60th the DB read load."' },
        { kind: "SAY", text: 'DST: "A job at 2:30am America/New_York doesn\'t exist on spring-forward day, and 1:30am happens twice on fall-back day. Storing the IANA timezone name and recomputing next_run_at in local time each tick is what keeps that correct — a fixed UTC offset is wrong half the year."' },
        { kind: "SAY", text: 'Retries: "Exponential backoff with jitter so failed jobs don\'t retry in lockstep, a per-target circuit breaker so a struggling downstream gets room to recover instead of being retried into the ground, and a DLQ with alerting after max attempts."' },
        { kind: "RULE OUT", text: 'Cross off "immediate retry with no backoff" — "that turns a brief target outage into a sustained one, the retries become the load."' },
      ],
      grading: "All three sub-problems quantified (DB-load ratio, both DST edges named, retry storm mechanism explained), not just labeled.",
    },
    {
      n: 6,
      title: "Wrap: Missed-Fire Policy and Close",
      minutes: 6,
      goal: "Name the misfire policy options unprompted, push back on a requirement, and close with a one-sentence summary plus a parked-items list.",
      why: "Staff-level signal here is treating 'what happens during an outage' as a product decision to be made explicit, not an implementation detail to discover accidentally — plus pacing the interview like a collaborator.",
      steps: [
        { kind: "SAY", text: 'Bring up misfire policy unprompted: "When the scheduler itself is down, jobs that should have fired need an explicit per-job policy — fire-now, skip-to-latest, or fire-all-missed. Leaving it implicit means an outage silently drops or storm-replays work."' },
        { kind: "SAY", text: 'Push back where useful: "Do we really need sub-5-second skew for every job, or just for time-sensitive ones? A looser default for most jobs would let us shrink the timing-wheel lookahead and shard count."' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a claim-and-dispatch system — sharded polling with a two-layer double-fire defense, a timing wheel for precision without DB load, and effectively-once delivery via idempotency keys." Then: "With more time I\'d cover multi-tenant quotas, per-target rate limiting, and job dependency chains."' },
        { kind: "SAY", text: 'Close the loop: "Any part you\'d like me to go deeper on?" — treat the remaining minutes as theirs to spend.' },
      ],
      grading: "Misfire policy volunteered with all three options named, at least one pushback on requirements, and a crisp closing summary with an explicit parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working single-poller design and adds a queue when prompted, but the double-firing and DST failure modes stay unexamined.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Picks cron parsing and a jobs table with a next_run_at column.",
          "Adds a queue (Kafka or SQS) between 'decided to fire' and 'executed' when asked why not call the webhook directly.",
          "Knows retries need backoff, can name 'exponential backoff' by name.",
          "Writes the basic CRUD endpoints and a reasonable schema.",
          "Handles 'what if it fails' by adding a retry count column.",
        ],
        gaps: [
          "Single scheduler process with no sharding story — doesn't notice it caps throughput.",
          "No mechanism to prevent two workers from claiming the same job; 'we'd use a lock' with no specifics.",
          "Timezone handling is 'store it in UTC' with no DST discussion.",
          "No missed-fire policy — assumes the scheduler is always up.",
          "Retry storm and circuit breaker not mentioned unless directly asked.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design to a sharded, dedupe-safe scheduler, names the exactly-once impossibility, and quantifies the hot spots the interviewer probes.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Shards jobs by job_id hash and uses SKIP LOCKED (or an equivalent atomic claim) to prevent double-firing.",
          "States that end-to-end exactly-once isn't achievable and designs for effectively-once via an idempotency key.",
          "Stores timezone as an IANA name and can explain why a fixed offset breaks on DST.",
          "Proposes a timing wheel or similar to avoid per-second full-table polling.",
          "Adds exponential backoff and a DLQ for retries.",
          "Separates read (status/history) from the claim-and-dispatch path.",
        ],
        gaps: [
          "Doesn't volunteer the shard-lease handoff race until asked 'what if the lease expires mid-claim?'",
          "Misfire/catch-up policy is mentioned as a single global behavior, not a per-job configurable one.",
          "Circuit breaker for retry storms comes up only after the interviewer describes a target outage scenario.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Treats outage behavior and delivery semantics as explicit product decisions, quantifies every trade-off, and paces the interview like a collaborator.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the shard-lease handoff race unprompted and names SKIP LOCKED as the actual safety net, the lease as only an optimization.",
          "Frames 'exactly once doesn't exist end-to-end' as a foundational constraint stated before it's asked, not a concession extracted later.",
          "Presents misfire policy as a required per-job setting with three named options and picks sane defaults per job type.",
          "Quantifies the timing wheel's DB-load reduction (~60x fewer reads) rather than describing it qualitatively.",
          "Names DST as a concrete, testable bug class with both transition edges called out by name.",
          "Pushes back on the uniform sub-5-second skew requirement and proposes tiering it by job type.",
          "Closes with a one-sentence summary and an explicit list of what's out of scope, pacing the 40 minutes deliberately.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Claiming 'exactly once' is achievable end-to-end without naming an idempotency key or acknowledging the impossibility of true exactly-once delivery across a network hop.",
      "A single scheduler process or single leader with no sharding story, capping throughput and creating one failure domain for every job in the system.",
      "Storing timezone as a fixed UTC offset instead of an IANA name — a guaranteed DST bug, not a hypothetical one.",
      "No mechanism preventing two nodes from claiming the same due job — 'we'd use a lock' with no specifics on what races it actually closes.",
      "Retries with no backoff or circuit breaker, so a downstream target outage gets amplified by the scheduler's own retry traffic.",
      "No explicit missed-fire policy, so an outage's behavior (silent drop vs. replay storm) is accidental rather than chosen.",
      "Putting execution-history writes or status reads on the claim-and-dispatch hot path instead of treating them as async.",
    ],
    followUps: [
      {
        q: "How do you guarantee exactly-once execution?",
        a: "You don't, end-to-end — that's the honest answer. Kafka delivers at-least-once (rebalances and retries can redeliver a trigger), so the design goal shifts to effectively-once: an idempotency key of job_id plus scheduled_run_timestamp, deduped via a Redis SETNX with a TTL longer than worst-case processing time. That makes duplicate deliveries a no-op at the scheduler layer. True exactly-once at the target still requires the target itself to be idempotent against that same key, which is why the scheduler passes it through rather than swallowing it.",
      },
      {
        q: "What happens if a scheduler node crashes right after claiming a job but before publishing to Kafka?",
        a: "The claimed row has a claimed_at timestamp but the trigger never reached Kafka, so the job would silently vanish if nothing recovers it. The fix is a stale-claim sweep: any shard owner (including whoever inherits the shard lease) periodically re-scans for rows with claimed_at older than a dispatch timeout and un-claims them, making them eligible for a fresh SKIP LOCKED claim. This bounds the worst-case delay to roughly the sweep interval plus the dispatch timeout, and it's the same mechanism whether the crash happened on the old owner or mid-handoff.",
      },
      {
        q: "How do you handle daylight saving time correctly?",
        a: "Store the job's timezone as an IANA name like America/New_York, never a fixed UTC offset, and recompute next_run_at in that local timezone every time you advance the schedule, using a DST-aware cron library. On the spring-forward day a time like 2:30am doesn't exist, so the library needs an explicit rule (skip or shift) rather than silently producing an invalid instant. On the fall-back day 1:30am happens twice, so a naive fixed-offset implementation would fire a 'once daily' job twice that day — recomputing from the IANA rule each time avoids that.",
      },
      {
        q: "How would you scale this from 10M jobs to 500M jobs and 500K triggers/min?",
        a: "The shard count and shard-per-node ratio are the main knobs — going from 256 shards to a few thousand keeps jobs-per-shard roughly constant, and the shard-lease and SKIP LOCKED mechanisms scale linearly with node count since there's no global coordinator on the claim path. The Job Store itself would need to move from a single sharded Postgres cluster toward a horizontally partitioned store (Postgres with more physical shards, or a wide-column store like Cassandra) once a single shard's write throughput for next_run_at updates becomes the bottleneck, and the timing-wheel lookahead window might need to shrink to bound per-node memory.",
      },
      {
        q: "Why route through Kafka instead of having the scheduler node call the webhook directly?",
        a: "Two reasons. First, decoupling: a slow or down target shouldn't block the scheduler node from continuing to claim and dispatch other due jobs — Kafka absorbs the backlog and lets a separately-scaled worker pool handle execution and retries. Second, retry and backoff logic belongs with the consumer, not the producer; if the scheduler node called the webhook synchronously, retry state would live on the scheduler's claim path, coupling scheduling precision to target availability, which is exactly the coupling the three-lane design is trying to avoid.",
      },
      {
        q: "Walk me through the three misfire policies and when you'd pick each.",
        a: "Fire-now runs the job once immediately on recovery then resumes the normal schedule — good for idempotent sync-type jobs like 'refresh inventory hourly' where a late run is harmless. Skip-to-latest does nothing for the missed window and just waits for the next scheduled time — right for time-sensitive notifications where a stale 9am digest arriving at 2pm is worse than not sending it. Fire-all-missed replays every occurrence that was missed — necessary when each occurrence has independent meaning, like per-minute billing ticks, but it risks a thundering-herd replay against downstream targets after a long outage, so it's usually paired with a grace window that caps how far back it will catch up.",
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
          "This is a claim-and-dispatch system, not a queue and not a database. The core operation is: find every job whose time has come, claim each one exactly once across a fleet of nodes, and hand it off to a separate execution path so that scheduling precision is never coupled to how long a job takes to run or whether its target is healthy.",
          "Anchor everything on four numbers: 10M jobs stored, 50K triggers/min at peak, sub-5s p99 scheduling skew, and at-least-once delivery (never true exactly-once). Every structural choice below — sharding, the timing wheel, the idempotency key, the misfire policy — is a direct consequence of one of these four.",
        ],
      },
      {
        heading: "Sizing and sharding the poll",
        body: [
          "A single process polling `WHERE next_run_at <= NOW()` every second is a hard ceiling: one process's due-set query and update batch have to absorb all 50K triggers/min, and it is simultaneously the only failure domain in the system. Sharding job_id into hash ranges (e.g. 256 shards, ~40K jobs/shard) turns throughput into a horizontal knob — the same reasoning as choosing partition counts for a Kafka topic.",
          "Shard ownership is assigned via an etcd lease per node, renewed on heartbeat, so a crashed node's shards get picked up after a bounded gap rather than being orphaned indefinitely.",
        ],
      },
      {
        heading: "Claiming without double-firing",
        body: [
          "Shard leases are coarse and have a handoff window where two nodes can briefly both believe they own a shard — that window is exactly where naive designs double-fire. The real safety net is `SELECT ... FOR UPDATE SKIP LOCKED` in the job store: it atomically claims one row and any other process polling the same rows silently skips whatever's already locked, regardless of which node currently 'owns' the shard.",
          "A job claimed but never published to Kafka — because its owning node died mid-dispatch — is recovered by a stale-claim sweep: any node re-scans for rows whose `claimed_at` is older than a dispatch timeout and re-claims them, bounding the worst case to roughly one sweep interval.",
        ],
      },
      {
        heading: "The timing wheel and delivery semantics",
        body: [
          "Polling every shard every second is wasteful when most seconds nothing in a given shard is due. Each shard owner sweeps a 5-minute lookahead into an in-memory hashed timing wheel once a minute, then fires jobs at the right second entirely from memory — decoupling DB read frequency (once a minute) from fire precision (still sub-second), roughly a 60x reduction in DB load for the same precision.",
          "Delivery from that point is Kafka's at-least-once: rebalances and retries can redeliver a trigger. Rather than chase an impossible true exactly-once, the design makes duplicates harmless with an idempotency key (job_id plus scheduled_run_timestamp) checked via Redis SETNX with a TTL past worst-case execution time before a worker actually executes.",
        ],
      },
      {
        heading: "Cron correctness: timezones and DST",
        body: [
          "Storing a fixed UTC offset instead of an IANA timezone name is the single most common real-world scheduler bug, because the offset between a timezone and UTC changes twice a year. The job stores the timezone as a name (e.g. America/New_York), and `next_run_at` is recomputed in that local timezone on every advance using a DST-aware cron library — one that knows a 2:30am job doesn't exist on spring-forward day and that 1:30am happens twice on fall-back day.",
        ],
      },
      {
        heading: "Failure handling: missed fires, retries, and backpressure",
        body: [
          "When the whole scheduler is down for a stretch, jobs whose scheduled time passed need an explicit, per-job answer: fire-now (catch up once), skip-to-latest (don't replay), or fire-all-missed (replay every occurrence, usually grace-windowed to avoid a replay storm). Leaving this implicit means an outage's behavior — silently dropped jobs or a downstream storm — happens by accident rather than by design.",
          "On the execution side, many jobs failing against the same target at once is handled with exponential backoff plus jitter (so retries don't re-synchronize into another spike), a per-target circuit breaker (so a struggling target gets room to recover instead of being retried into the ground), and a dead-letter queue with alerting once a job exhausts its max attempts.",
        ],
      },
    ],
  },
};
