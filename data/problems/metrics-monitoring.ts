import type { Problem } from "@/lib/types";

export const metricsMonitoring: Problem = {
  slug: "metrics-monitoring",
  num: "3.3",
  title: "Design a Metrics Monitoring System",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a metrics monitoring system (think Prometheus + Cortex/Mimir, or Datadog) that ingests 50M data points/sec from 100K hosts and services across 500M active time series, serves dashboard queries at sub-200ms p99 over the last 15 days, and evaluates alert rules within 60 seconds of a real breach — without letting a single bad label turn cardinality into an outage.",
  ],
  hardParts:
    "The hard parts: keeping cardinality from turning a 500M-series system into an unbounded one, compressing time-series data enough to make 15 days of 10s-resolution history affordable, and evaluating alert rules on a live, occasionally-late stream without paging on noise.",
  keyTopics: [
    "Gorilla/XOR Time-Series Compression",
    "Cardinality Limiting",
    "Push-with-Local-Aggregation",
    "Hot/Cold Storage Tiering",
    "Sliding-Window Alert Evaluation",
  ],
  foundationsReferenced: [
    { label: "Kafka", tone: "orange" },
    { label: "Gorilla / XOR Compression", tone: "purple" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "LSM Trees vs B-Trees", tone: "blue" },
    { label: "Sliding Window Counters", tone: "orange" },
    { label: "CAP Theorem", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "dashboard", label: "Grafana / Dashboard", col: 1, row: 2, tone: "slate" },
      { id: "qfrontend", label: "Query Frontend", sub: "result cache", col: 2, row: 2, tone: "green" },
      { id: "querier", label: "Query Engine", sub: "PromQL-style", col: 3, row: 2, tone: "purple" },
      {
        id: "tsdb",
        label: "TSDB Storage",
        sub: "compressed blocks · 15d hot",
        mono: "hash(metric+labels) → shard",
        col: 4,
        row: 3,
        tone: "blue",
      },
      { id: "objstore", label: "Object Store", sub: "S3 · 13mo downsampled", col: 5, row: 5, tone: "blue" },
      { id: "agent", label: "Host Agent", sub: "100K hosts · push 10s", col: 1, row: 4, tone: "slate" },
      { id: "collector", label: "Ingestion Gateway", sub: "validate · cardinality cap", col: 2, row: 4, tone: "green" },
      { id: "kafka", label: "Kafka", sub: "partitioned by series hash", col: 3, row: 4, tone: "orange" },
      {
        id: "ingester",
        label: "TSDB Ingesters",
        sub: "in-memory head block",
        mono: "Gorilla XOR encode",
        col: 4,
        row: 4,
        tone: "blue",
      },
      {
        id: "compactor",
        label: "Compactor",
        sub: "ages hot blocks out",
        mono: "10s → 5m → 1h",
        col: 5,
        row: 4,
        tone: "blue",
      },
      { id: "streamagg", label: "Stream Processor", sub: "windowed alert eval", col: 3, row: 5, tone: "orange" },
      { id: "alertmgr", label: "Alertmanager", sub: "eval · dedupe · route", col: 4, row: 5, tone: "orange" },
    ],
    edges: [
      { from: "dashboard", to: "qfrontend", kind: "read" },
      { from: "qfrontend", to: "querier", label: "cache miss", kind: "read" },
      { from: "querier", to: "tsdb", label: "last 15d · LOCAL query", kind: "read" },
      { from: "querier", to: "objstore", label: "> 15d · downsampled", kind: "read" },
      { from: "agent", to: "collector", kind: "write" },
      { from: "collector", to: "kafka", label: "validate & dedupe", kind: "write" },
      { from: "kafka", to: "ingester", label: "consume · ordered per series", kind: "write" },
      { from: "ingester", to: "tsdb", label: "flush head block · RF=3", kind: "write" },
      { from: "kafka", to: "streamagg", label: "async fan-out", kind: "analytics" },
      { from: "streamagg", to: "alertmgr", label: "windowed rule eval", kind: "analytics" },
      { from: "tsdb", to: "compactor", label: "blocks age past 15d", kind: "analytics" },
      { from: "compactor", to: "objstore", label: "downsample 5m/1h", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · dashboards, sub-200ms p99" },
      { kind: "write", text: "write path · 50M points/sec ingestion" },
      { kind: "analytics", text: "background · rollups & alerting, async" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["agent", "collector", "dashboard", "qfrontend", "querier"],
      say: "Two independent paths behind their own entry points: agents push metrics in on the write side, Grafana queries come in on the read side. At 50M points/sec against maybe 10K dashboard queries/sec, the write side is the one that has to survive scale — nothing is durable yet, that's next.",
    },
    {
      reveal: ["kafka", "ingester", "tsdb"],
      say: "The gateway hands validated points to Kafka, partitioned by hash(metric + labels) so every point for a series lands on the same partition in order. Ingesters consume in that order and Gorilla-encode each series into an in-memory head block, flushed to TSDB storage as an immutable compressed chunk — the last 15 days the query engine now reads from.",
    },
    {
      reveal: ["compactor", "objstore"],
      say: "Data doesn't stay at full resolution forever. As blocks age past 15 days, a background compactor downsamples them to 5-minute then 1-hour resolution and rewrites them to object storage — 10-50x cheaper per byte — and the query engine merges hot and cold transparently when a range spans both.",
    },
    {
      reveal: ["streamagg", "alertmgr"],
      say: "Alerting runs off the same Kafka firehose, not off a query. The stream processor evaluates rules over sliding windows with a debounce so a 10-second blip never pages anyone, and Alertmanager groups a fleet-wide root cause into one notification instead of two hundred.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Ingest metrics via push (agent) and pull (scrape) from 100K+ hosts and services", tag: "P0" },
      { id: "FR-02", text: "Dimensional data model: metric name plus arbitrary key-value labels per point", tag: "P0" },
      { id: "FR-03", text: "Query time-series data with aggregation (sum/avg/rate/percentile) over a time range", tag: "P0" },
      { id: "FR-04", text: "Automatically downsample and roll up aging data (10s to 5m to 1h resolution)", tag: "P0" },
      { id: "FR-05", text: "Define alert rules (threshold and rate-of-change), evaluate on a schedule, route via Alertmanager", tag: "P0" },
      { id: "FR-06", text: "Render dashboards of time-series panels, with templated/variable queries", tag: "P0" },
      { id: "FR-07", text: "Enforce per-team cardinality limits/quotas to protect the shared cluster", tag: "P1" },
      { id: "FR-08", text: "Configurable retention per metric/namespace (e.g. 15 days raw, 13 months downsampled)", tag: "P1" },
      { id: "FR-09", text: "Multi-tenancy: isolate ingestion and query load across teams", tag: "P1" },
      { id: "FR-10", text: "Anomaly-based alerting layered on top of static thresholds", tag: "P2" },
      { id: "FR-11", text: "Historical backfill / bulk import of metrics", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Sustained ingestion throughput", tag: "50M points/sec" },
      { id: "NFR-02", text: "Ingestion latency, agent to queryable", tag: "p99 < 15s" },
      { id: "NFR-03", text: "Dashboard query latency, hot tier (last 15d)", tag: "p99 < 200ms" },
      { id: "NFR-04", text: "Alert notification latency, confirmed breach to page", tag: "< 60s" },
      { id: "NFR-05", text: "Availability (about 4.4 hours downtime per year)", tag: "99.95%" },
      { id: "NFR-06", text: "Ingestion durability: no silent data loss", tag: "at-least-once" },
      { id: "NFR-07", text: "Storage compression ratio vs naive 16 bytes/point", tag: "~12:1" },
      { id: "NFR-08", text: "Active time-series capacity the cluster is provisioned for", tag: "500M series" },
      { id: "NFR-09", text: "Write-to-query ratio that anchors the whole design", tag: "~5000:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: cardinality is the metric, not the row count",
      body: [
        "Unlike a system sized by row count, a metrics system is sized by time series — a unique combination of metric name and label set. Start with the boring baseline: 100K hosts, each emitting roughly 1,000 system and app metrics, gives 100M series before a single team adds a custom tag. That baseline is stable and easy to provision for.",
        "The number that actually matters is what one metric with a bad label does to that baseline. Tag a single metric with customer_id (5M distinct values) and it alone adds roughly 1% on top of the entire fleet's budget — bad, but survivable. Tag one with request_id or a raw UUID — effectively unbounded — and that single metric keeps minting new series every second, capable of out-growing the entire rest of the fleet within hours. 500M active series is the budget the design is provisioned for after cardinality limits are enforced — it is a target, not an emergent accident.",
      ],
      bullets: [
        { lead: "Base cardinality", text: "100K hosts × 1K metrics/host = 100M series from infrastructure metrics alone." },
        { lead: "One bad label", text: "a single metric tagged with an effectively unbounded dimension (request_id, UUID) can out-cardinality the entire rest of the system by itself; even a bounded-but-large one (customer_id) adds a meaningful chunk on its own." },
        { lead: "500M is the budget, not a guess", text: "it's what the cluster is provisioned for after cardinality limits are enforced at the gateway (Learn #4), not a number that just happens." },
      ],
      pictureTitle: "Where do 500M time series come from?",
      pictureRows: [
        { label: "100K hosts × 1K metrics", value: "100M series (infra baseline)", tone: "neutral" },
        { label: "+ app/business metrics, sane tags", value: "~400M series", tone: "good" },
        { label: "1 metric × customer_id tag (5M values)", value: "+5M series from ONE metric", tone: "bad" },
      ],
      remember: {
        problem: "How big is 'big' for a metrics system, and what's actually growing?",
        solution: "Size by unique time series (metric name + label set), not host count: 100K hosts × 1K metrics/host = 100M baseline, ~500M after realistic app/business metrics.",
        why: "A time series is created per unique label combination, so cardinality — not host count — is the real capacity variable.",
        tradeoff: "More descriptive labels make querying and debugging easier, but each new label dimension multiplies series count.",
        failure: "One engineer tags a metric with request_id or customer_id and that single metric outgrows the rest of the fleet.",
        mitigation: "Enforce a per-tenant series cap at the ingestion gateway and alert on cardinality growth rate before it becomes an incident.",
      },
    },
    {
      n: 2,
      title: "Push vs pull: kill the pure options, defend the hybrid",
      body: [
        "Two canonical collection models exist and the interview wants you to weigh both. Pull (Prometheus-style scraping) is server-driven: the server decides scrape rate and a failed scrape is a free liveness signal, but it needs service discovery for 100K targets and can't reach firewalled hosts or jobs too short-lived to be scraped. Push (StatsD/Datadog-agent-style) works through firewalls and for ephemeral jobs, but loses that free liveness signal and, done naively, means one network call per stat.",
        "The actual unlock is local aggregation: a per-host agent aggregates counters and histograms in-process over the push interval and sends one packet per metric per interval instead of one call per stat call. That's what makes push affordable at 50M points/sec.",
      ],
      bullets: [
        { lead: "Pull (Prometheus)", text: "server-driven, scrape failure = instant liveness signal, but needs service discovery and can't reach firewalled or short-lived jobs." },
        { lead: "Push (StatsD/Datadog agent)", text: "works through firewalls and for ephemeral jobs, but 'did it stop pushing' needs its own heartbeat check." },
        { lead: "Local aggregation is the actual win", text: "the agent turns thousands of stat calls/sec inside a process into one pre-aggregated packet per metric per interval." },
        { lead: "Winner: hybrid", text: "push, with local aggregation and jittered intervals, plus a heartbeat/last-seen check standing in for pull's free liveness signal." },
      ],
      pictureTitle: "Push vs pull at 100K hosts",
      pictureRows: [
        { label: "Pull / scrape", value: "free liveness signal, but needs reachability + discovery", tone: "neutral" },
        { label: "Push, no local aggregation", value: "1 network call per stat, drowns the network", tone: "bad" },
        { label: "Push + local aggregation agent", value: "1 packet per metric per interval — WINNER", tone: "good" },
      ],
      remember: {
        problem: "How do 100K hosts get metrics onto the wire without melting the network or missing ephemeral jobs?",
        solution: "Push through a local aggregation agent that pre-aggregates in-process and sends one packet per metric per interval; jitter intervals across hosts.",
        why: "Local aggregation cuts network calls by orders of magnitude, and push (unlike pull) works through firewalls and for jobs that don't live long enough to be scraped.",
        tradeoff: "You give up pull's free 'target is down' signal and must build a separate heartbeat/last-seen check.",
        failure: "Every agent syncing on the same 10s boundary creates a thundering-herd write burst at the ingestion gateway every interval.",
        mitigation: "Jitter each agent's push interval by a random offset, and give the gateway backpressure/rate limiting so a burst degrades gracefully instead of falling over.",
      },
    },
    {
      n: 3,
      title: "Gorilla compression: 16 bytes/point down to ~1.37",
      body: [
        "Naive storage is a timestamp (8 bytes) plus a float value (8 bytes) = 16 bytes/point. At 50M points/sec that's 800MB/sec, and over 15 days of hot retention it's the difference between an affordable cluster and a bill nobody approves. Facebook's Gorilla paper found production time series compress to ~1.37 bytes/point on average — roughly a 12:1 ratio — using two tricks that exploit how time series actually look.",
        "Points mostly arrive on a near-fixed interval and consecutive values (CPU%, request latency) are usually close together, so encoding the difference instead of the raw value needs only a handful of bits most of the time.",
      ],
      bullets: [
        { lead: "Delta-of-delta timestamps", text: "store the delta between consecutive deltas; when a point arrives exactly on the expected 10s step, it costs a single bit." },
        { lead: "XOR'd float values", text: "XOR-ing consecutive readings produces mostly leading/trailing zero bits, encoded with a few control bits instead of a fresh 64-bit float." },
        { lead: "In-memory head block", text: "each series' current chunk is encoded incrementally in an append-only bit-stream in memory, then flushed as an immutable compressed block roughly every 2 hours — how M3DB, Cortex, and Mimir actually implement it." },
      ],
      pictureTitle: "16 bytes/point vs Gorilla-compressed",
      pictureRows: [
        { label: "Naive (8B timestamp + 8B value)", value: "16 bytes/point", tone: "bad" },
        { label: "Gorilla (delta-of-delta + XOR)", value: "~1.37 bytes/point avg", tone: "good" },
        { label: "50M points/sec, 15d hot retention", value: "~90TB compressed vs ~1PB naive", tone: "used" },
      ],
      remember: {
        problem: "Store 15 days of 10s-resolution data for 500M series without an unaffordable disk bill.",
        solution: "Gorilla-style compression: delta-of-delta timestamp encoding + XOR'd float values, built up in an in-memory head block and flushed as immutable chunks.",
        why: "Consecutive timestamps and values in a time series are highly predictable, so encoding the difference instead of the raw value needs only a few bits most of the time.",
        tradeoff: "Compression is per-series and stateful — encoding the next point needs the previous one — so the format assumes append-only, in-order arrival, not random-access writes.",
        failure: "A naive 16-bytes/point format at this scale is roughly an order of magnitude more disk, which is the difference between a feasible cluster and a cancelled project.",
        mitigation: "Buffer and reorder slightly-late points before they hit the encoder; reject or side-channel points that arrive too late to fit the open head block.",
      },
    },
    {
      n: 4,
      title: "Cardinality explosion — the load-bearing risk",
      body: [
        "The whole compression and storage story assumes cardinality stays bounded. That's the one assumption that, if it breaks, breaks everything at once — unlike a slow query, a cardinality explosion is a write-path problem. Every new label combination is a brand-new series: a new in-memory head block, a new set of index entries, resident in ingester memory the moment the first point for it arrives.",
        "Quantify it: one metric with an unbounded label reaching millions of new series in an hour can consume more ingester memory than the rest of the fleet combined, and none of it gets cleaned up until retention expires.",
      ],
      bullets: [
        { lead: "Why it's the write path, not just the query path", text: "a wide-cardinality label doesn't just make queries slow, it creates real new series — new head blocks, new index rows — so ingester memory and disk both spike immediately." },
        { lead: "The fix is at the front door", text: "enforce a hard per-tenant series cap at the ingestion gateway — reject or drop points for series past the cap rather than let ingesters discover the problem after it's already resident in memory." },
        { lead: "Detect before it pages you", text: "alert on cardinality growth rate per metric, not just absolute count, so a runaway label is caught in minutes, not after the next OOM." },
      ],
      pictureTitle: "What happens when cardinality goes unbounded",
      pictureRows: [
        { label: "Bounded, sane tags", value: "500M series, provisioned & stable", tone: "good" },
        { label: "1 metric gets a request_id tag", value: "+millions of series/hour, unbounded", tone: "bad" },
        { label: "Per-tenant cap at the gateway", value: "reject over-limit series before ingest", tone: "good" },
      ],
      remember: {
        problem: "One mislabeled metric can grow cardinality unboundedly and take down ingestion for everyone.",
        solution: "Hard per-tenant/per-metric series caps enforced at the ingestion gateway, plus alerting on cardinality growth rate.",
        why: "Cardinality growth is a write-path resource problem (memory, index) that compounds every scrape/push interval until something rejects it.",
        tradeoff: "A hard cap means some legitimate high-cardinality use cases get dropped or need an exception process — better than an uncontrolled outage.",
        failure: "Without a cap, a single bad deploy that tags a metric with a UUID can exhaust ingester memory for the whole cluster within minutes.",
        mitigation: "Reject at the gateway (cheap, stateless check) rather than at the ingester (which has already paid the memory cost), and surface a clear error to the offending team.",
      },
    },
    {
      n: 5,
      title: "Hot/cold storage tiering and downsampling",
      body: [
        "Recency needs precision; history needs shape. A live incident debug needs 10s-resolution data from the last hour; a dashboard from six months ago just needs the trend line. Splitting storage into a hot and cold tier, like a cache hierarchy, keeps cost proportional to how often data is actually queried at full resolution.",
        "A background compactor rolls 10s data up to 5-minute (then 1-hour) resolution as it ages out of the hot tier and moves it to object storage, which is 10-50x cheaper per byte. The query engine is tier-aware and merges results transparently when a query range crosses the boundary.",
      ],
      bullets: [
        { lead: "Hot tier (0-15 days, 10s resolution)", text: "lives on TSDB ingester/store nodes with local SSD, serving the sub-200ms dashboard queries that matter for live debugging." },
        { lead: "Downsample, don't just delete", text: "a background compactor rolls 10s data up to 5-minute then 1-hour resolution as it ages, because a debugging dashboard from a month ago needs shape, not every point." },
        { lead: "Cold tier (15 days-13 months, downsampled)", text: "written as compressed blocks to object storage (S3), 10-50x cheaper per byte, queried directly by the same query engine when the range crosses the boundary." },
      ],
      pictureTitle: "Why not keep everything at full resolution forever",
      pictureRows: [
        { label: "Hot: 0-15d @ 10s, local SSD", value: "sub-200ms dashboard queries", tone: "good" },
        { label: "Cold: 15d-13mo @ 5m/1h, S3", value: "10-50x cheaper/byte, slower reads OK", tone: "good" },
        { label: "Full resolution forever", value: "cost grows unboundedly for data no one queries at full res", tone: "bad" },
      ],
      remember: {
        problem: "Keep 13 months of history without paying full-resolution storage cost forever.",
        solution: "Hot tier at 10s resolution for 15 days on local SSD; a compactor downsamples to 5m/1h and moves it to object storage for the remaining ~13 months.",
        why: "Nobody debugs an incident from 6 months ago at 10s resolution — recency needs precision, history needs shape.",
        tradeoff: "Cold-tier queries are slower and coarser; a query spanning the boundary must merge two representations.",
        failure: "Storing everything at full resolution forever makes the hot tier grow without bound and the storage bill dominates the whole system's cost.",
        mitigation: "Automate the downsample-and-move as a background compaction job, and make the query engine tier-aware so it's invisible to the user asking for a graph.",
      },
    },
    {
      n: 6,
      title: "Sliding-window alert evaluation, not a raw threshold",
      body: [
        "Alerting isn't a single point-in-time comparison — it runs on a live, sometimes-late stream and has to avoid paging on noise. A rule that fires on one sample above a threshold will page on a transient blip; a rule that fires on a sustained window won't.",
        "Two more concrete techniques matter: a small watermark delay so late-arriving points don't cause false clears or false re-fires, and Alertmanager-style grouping so a single root cause that trips 200 host-level rules produces one notification, not 200 pages.",
      ],
      bullets: [
        { lead: "Sliding/tumbling window, not a single point", text: "a rule evaluates over the last N minutes (e.g. rate() over 5m) so one noisy sample can't fire an alert." },
        { lead: "'For' duration debounces flapping", text: "a rule must stay in breach for a sustained period (e.g. 5 minutes) before it pages, so a 10-second blip doesn't wake anyone." },
        { lead: "Late data must not cause false clears or fires", text: "if points from a laggy shard arrive after the evaluation window closed, the rule engine needs a small grace/watermark delay before evaluating — trading a few seconds of freshness for correctness." },
        { lead: "Alertmanager dedups and groups", text: "one root-cause failure that trips 200 rules (every host in a cluster) becomes one grouped notification, not 200 pages." },
      ],
      pictureTitle: "Why a raw threshold check pages the wrong people",
      pictureRows: [
        { label: "Point-in-time threshold", value: "fires on a single noisy sample", tone: "bad" },
        { label: "Windowed + 'for' duration", value: "fires only on sustained breach", tone: "good" },
        { label: "200 hosts breach at once, ungrouped", value: "200 separate pages", tone: "bad" },
        { label: "Alertmanager grouping/dedup", value: "1 page for 1 root cause", tone: "good" },
      ],
      remember: {
        problem: "Evaluate alert rules on a live, occasionally-late stream without paging on noise.",
        solution: "Windowed rule evaluation with a sustained-breach 'for' duration, a small watermark delay for late data, and Alertmanager-side grouping/dedup.",
        why: "A single sample is not a signal; a sustained window is. And a fleet-wide root cause shouldn't produce a fleet-wide number of pages.",
        tradeoff: "The 'for' duration is a per-rule noise/latency trade-off chosen independently of the paging SLA — it delays when a rule is allowed to *start* firing. The < 60s NFR budget is measured from that confirmed-firing moment to notification, so it's the evaluation tick plus the watermark delay plus Alertmanager routing that eat into it, not the 'for' duration itself.",
        failure: "Alerting on raw points pages on-call for transient blips; ungrouped notifications during a real incident bury the one page that matters under 200 duplicates.",
        mitigation: "Tune 'for' duration and watermark per rule based on its noise profile, and route related alerts through Alertmanager's grouping keys.",
      },
    },
    {
      n: 7,
      title: "Sharding the write path: consistent hashing by series",
      body: [
        "50M points/sec has to spread evenly across ingesters, but the sharding key isn't obvious. Shard by time and every current write lands on whichever shard owns 'now' — a single hot shard takes 100% of ingestion traffic. Shard by host and one metrics-heavy service can still dominate a shard, and it doesn't guarantee a given series' points always land on the same node in order.",
        "Shard by hash(metric name + sorted label set) instead: every point for a given series always routes to the same ingester, which is what lets the in-memory head block work at all — Gorilla's delta-of-delta and XOR encoding require strictly ordered, in-sequence points per series.",
      ],
      bullets: [
        { lead: "Why not shard by time", text: "all current writes land on whichever shard owns 'now' — a single hot shard takes 100% of ingestion traffic." },
        { lead: "Why not shard by host", text: "one host can dominate a shard, and it doesn't guarantee the per-series ordering the compressor requires." },
        { lead: "Shard by hash(metric+labels)", text: "every point for a given series always routes to the same ingester, so the in-memory encoder always sees points for that series in order." },
        { lead: "Replicate for durability", text: "RF=3 across ingesters so losing one node doesn't lose the in-flight head block for any series." },
      ],
      pictureTitle: "Sharding the 50M points/sec write path",
      pictureRows: [
        { label: "Shard by time", value: "one hot shard owns 'now' — reject", tone: "bad" },
        { label: "Shard by host", value: "uneven load, breaks per-series order — reject", tone: "bad" },
        { label: "hash(metric + labels) → shard", value: "even spread + ordered per-series writes — WINNER", tone: "good" },
      ],
      remember: {
        problem: "Spread 50M points/sec evenly across ingesters while keeping each series' points in order (required for compression).",
        solution: "Consistent hash of (metric name + sorted label set) to pick the owning ingester; replicate each series to RF=3 nodes.",
        why: "Gorilla-style compression needs strictly ordered, in-sequence points per series, so a series must always land on the same node.",
        tradeoff: "A single very-high-volume series can still create a hot shard (mitigated by cardinality limits, not sharding) — sharding solves even distribution across series, not within one runaway series.",
        failure: "Sharding by time or by host either creates a moving hot spot or breaks the per-series ordering the compressor depends on.",
        mitigation: "Consistent hashing keeps rebalancing cheap when nodes are added or removed, and RF=3 replication means one node loss doesn't lose data mid-flush.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a write-heavy time-series store: ingest 50M points/sec across 500M series, compress hard, and keep dashboards and alerts fast without cardinality eating the cluster.",
      "Agents push pre-aggregated metrics through a local agent, so the network sees one packet per metric per interval instead of one call per stat.",
      "Gorilla-style delta-of-delta + XOR compression turns 16 bytes/point into ~1.37 bytes/point, which is what makes 15 days of full-resolution data affordable.",
      "Cardinality — not host count — is the real capacity variable, so it's capped at the ingestion gateway before a bad label can take down the cluster.",
      "Alerts evaluate over sliding windows with a sustained-breach duration and get grouped/deduped by Alertmanager, so on-call gets one page per root cause, not one per host.",
    ],
    flows: [
      {
        kind: "write",
        title: "WRITE · 50M POINTS/SEC",
        summary:
          "Each host's agent pre-aggregates locally and pushes once per interval. The gateway checks cardinality before anything hits Kafka, and every point for a series always lands on the same ingester so it can be compressed in order.",
        steps: [
          { label: "Host Agent", note: "local aggregation, push every 10s" },
          { label: "Ingestion Gateway", note: "validate, dedupe, cardinality cap" },
          { label: "Kafka", note: "partitioned by hash(metric+labels)" },
          { label: "TSDB Ingester", note: "consumes in order, Gorilla-encodes in memory" },
          { label: "TSDB block flush", note: "immutable chunk, RF=3, ~every 2h" },
        ],
      },
      {
        kind: "read",
        title: "READ · DASHBOARDS · SUB-200MS P99",
        summary:
          "A dashboard query hits a result cache first. On a miss, the query engine routes by time range — recent data from the hot tier, older data from downsampled object storage — and merges the two if the range spans both.",
        steps: [
          { label: "Dashboard", note: "renders panels from a query" },
          { label: "Query Frontend", note: "result cache" },
          { label: "Query Engine", note: "PromQL-style, routes by time range" },
          { label: "TSDB hot tier", note: "last 15d, local SSD" },
          { label: "Object Store", note: "> 15d, downsampled" },
        ],
      },
      {
        kind: "analytics",
        title: "ANALYTICS · ROLLUPS & ALERTING · NEVER BLOCKS INGEST",
        summary:
          "Two independent background jobs, neither on the ingest path. A stream processor consumes the Kafka firehose to evaluate alert rules over sliding windows, handing breaches to Alertmanager. Separately, a compactor ages 10s blocks out of the hot tier and rewrites them downsampled into object storage.",
        steps: [
          { label: "Kafka", note: "async fan-out, second consumer group" },
          { label: "Stream Processor", note: "sliding-window alert eval" },
          { label: "Alertmanager", note: "dedupe, group, route" },
          { label: "TSDB hot tier", note: "blocks age past 15d" },
          { label: "Compactor", note: "downsamples to 5m/1h" },
          { label: "Object Store", note: "downsampled rollups written" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "500M active time series, 50M points/sec ingested (10s scrape/push interval)",
          "Naive storage 16 bytes/point vs Gorilla ~1.37 bytes/point ≈ 12:1 compression",
          "Hot tier: 15 days @ 10s resolution ≈ 90TB compressed; cold tier: 13mo @ 5m/1h in S3",
          "Dashboard query p99 < 200ms (hot tier); alert breach-to-page < 60s",
          "Per-tenant cardinality cap (e.g. 1M active series/team), hard-enforced at the gateway",
          "Replication factor 3 on ingesters for durability",
          "100K hosts × ~1K metrics/host = 100M series baseline before app/business metrics",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Push with local pre-aggregation (agent), not raw pull-only or unaggregated push",
          "Gorilla-style delta-of-delta + XOR compression, in-memory head block flushed every ~2h",
          "Consistent hash of (metric+labels) → ingester, not shard by time or by host",
          "Hard per-tenant cardinality cap enforced at the ingestion gateway, not the ingester",
          "Hot tier on local SSD (15d @ 10s); cold tier downsampled to object storage (13mo)",
          "Windowed alert rules with a sustained-breach 'for' duration, not point-in-time thresholds",
          "Alertmanager groups/dedups notifications by root cause before paging",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Cardinality is the load-bearing risk — one unbounded label can out-cardinality the whole fleet",
          "Compression assumes strictly ordered per-series writes, which is why sharding is by series hash, not time or host",
          "Alerting and dashboards are different SLA tiers: dashboards can be a little stale, a missed page can't",
          "Downsampling is lossy on purpose — history needs shape, not every point",
          "At-least-once ingestion with idempotent writes, not exactly-once coordination, is the durability story",
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
      goal: "Get five numbers and two scope decisions on the board before drawing anything, and make the interviewer confirm scope out loud.",
      why: "This system inverts the usual pattern: writes dominate reads by three orders of magnitude, and the interviewer wants to see you catch that immediately rather than defaulting to a read-heavy mental model.",
      steps: [
        { kind: "ASK", text: '**"What\'s the read:write shape here?"** Walk them to "this is ingest-heavy, not query-heavy" — writes dominate reads, unlike most systems. Write **"50M points/sec write, ~10K dashboard queries/sec"** in the corner.' },
        { kind: "ASK", text: 'Ask **"how many hosts/services, and what\'s a reasonable metrics-per-host count?"** Land on "100K hosts, ~1K metrics/host" and write **"100M+ series baseline"**.' },
        { kind: "SAY", text: 'Propose the two SLA numbers yourself: **"sub-200ms p99 dashboard queries"**, **"breach-to-page under 60s"**. Wait for a nod, then write them down.' },
        { kind: "SAY", text: 'State scope. In: "metric ingestion", "storage & compression", "dashboards", "alerting". Out: "logs", "distributed tracing", "the UI itself". "Let me know if you\'d like me to bring any of those back in."' },
        { kind: "WRITE", text: 'Do the storage math out loud: **"500M series × 10s resolution × 15 days ≈ 65 trillion raw points"**, **"at ~1.37 bytes/point compressed, ≈ 90TB hot"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Do they catch the write-heavy inversion immediately, write numbers on the board, and lock scope before drawing boxes?",
    },
    {
      n: 2,
      title: "Data Model and Query API",
      minutes: 5,
      goal: "Commit to a dimensional data model and two endpoints, and defend it against the obvious flat-naming alternative.",
      why: "The interviewer wants to see you commit to labels-as-dimensions rather than encoding everything into the metric name, because that choice is what makes aggregation, cardinality-limiting, and querying tractable later.",
      steps: [
        { kind: "WRITE", text: 'Write the data model: **"metric_name{label1=\\"v1\\", label2=\\"v2\\"} value timestamp"**, e.g. `http_requests_total{service="checkout", status="500"}`. Two endpoints: push/scrape ingestion, and **"GET /query?expr=...&range=..."** for a PromQL-style range query.' },
        { kind: "DRAW", text: 'Sketch the series key: **"hash(metric_name + sorted labels) → series ID"**, one (timestamp, value) pair per point. Say it out loud: "This key is what sharding, indexing, and compression all key off of."' },
        { kind: "SAY", text: '"Labels-as-dimensions means I can aggregate across a dimension — sum status=500 across all services — without the client pre-computing every combination."' },
        { kind: "RULE OUT", text: '"A flat naming scheme like `http_requests_checkout_500_total` can\'t be aggregated after the fact and makes cardinality unmanageable — every combination is a hand-picked name." Cross it off.' },
      ],
      grading: "Crisp dimensional model, a query endpoint sketched, and a one-line rejection of the flat-naming alternative without prompting.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: write, read, background. Label arrows with throughput and latency, not box names.",
      why: "Drawing write, read, and background as separate lanes proves you understand they have different requirements — durability for writes, freshness for reads, correctness-over-speed for alerting — and so need different infrastructure.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write lane**: Agent → Ingestion Gateway → Kafka → TSDB Ingester → TSDB block flush. Label arrows **"50M points/sec"**, **"partitioned by hash(metric+labels)"**, **"RF=3"**.' },
        { kind: "DRAW", text: 'Add the **read lane**: Dashboard → Query Frontend (cache) → Query Engine → TSDB hot tier or Object Store, routed by time range. Label **"sub-200ms p99"**, **"> 15d → downsampled"**.' },
        { kind: "DRAW", text: 'Add the **background lane**: off Kafka, → Stream Processor → Alertmanager (windowed eval, grouping). Separately off TSDB, → Compactor → Object Store (downsamples as blocks age past 15d). Label both **"async, never blocks ingestion"**.' },
        { kind: "SAY", text: '"Three lanes because they have three different failure tolerances — losing a write is unacceptable, a slow dashboard is annoying, a late alert evaluation is a correctness bug, not an outage."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with throughput/latency, and an explicit statement of why each lane has different infra.",
    },
    {
      n: 4,
      title: "Deep Dive: Cardinality and Compression",
      minutes: 8,
      goal: "Show the cardinality cap and the Gorilla encoding, and quantify both instead of hand-waving.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can name the load-bearing risk (cardinality) before being asked, and whether you actually know how time-series compression works, not just that it exists.",
      steps: [
        { kind: "SAY", text: '"Cardinality is the real capacity variable here, not host count. 100K hosts × 1K metrics is only the baseline — one metric with an unbounded label can out-grow the whole fleet." Write **"cap enforced at the gateway, not the ingester"**.' },
        { kind: "SAY", text: 'Explain the compression: "Delta-of-delta timestamp encoding — most points land on a fixed 10s step, so it costs one bit. XOR\'d float values — consecutive readings are close, so XOR produces mostly zero bits." Write **"16B/pt naive → ~1.37B/pt Gorilla, ~12:1"**.' },
        { kind: "SAY", text: '"That compression is stateful per series, which is exactly why sharding is by hash(metric+labels), not time or host — a series must always land on the same node to stay in order."' },
        { kind: "RULE OUT", text: '"Shard by time → one hot shard owns \'now\'. Shard by host → uneven load and breaks per-series order." Cross both off.' },
      ],
      grading: "Cardinality named as the load-bearing risk, the compression ratio quantified (not just \"we compress it\"), and the sharding-order connection made explicitly.",
    },
    {
      n: 5,
      title: "Deep Dive: Alerting and Storage Tiering",
      minutes: 7,
      goal: "Walk windowed alert evaluation with grouping, then the hot/cold storage split, volunteering the late-data problem before being asked.",
      why: "Anyone can say 'if value > threshold, alert'. The interviewer wants windowed evaluation with a debounce, grouped notifications, and a tiering story that shows you thought about cost over 13 months, not just 15 days.",
      steps: [
        { kind: "SAY", text: '"Rules evaluate over a sliding window with a sustained-breach \'for\' duration — a 10-second blip shouldn\'t page anyone. A small watermark delay handles late-arriving points so they don\'t cause a false clear or false re-fire."' },
        { kind: "SAY", text: '"When 200 hosts breach the same rule at once, Alertmanager groups and dedupes them into one notification by root cause, not 200 pages."' },
        { kind: "SAY", text: '"Storage: hot tier is 15 days at 10s resolution on local SSD for the sub-200ms dashboards. A compactor downsamples to 5m then 1h and moves it to object storage for the remaining 13 months — 10-50x cheaper per byte."' },
        { kind: "SAY", text: '"The query engine is tier-aware and merges hot and cold results transparently when a range spans both."' },
      ],
      grading: "Windowed evaluation with a debounce, grouping/dedup volunteered, and a hot/cold tiering story with real cost reasoning.",
    },
    {
      n: 6,
      title: "Wrap: Tiers, Trade-offs, and Close",
      minutes: 5,
      goal: "Name the SLA tiers, push back on one requirement, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: explicit tiers that justify every trade-off, a willingness to negotiate scope, and a clean close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: '"Ingestion durability is tier-1, alerting correctness is tier-2, dashboard freshness is tier-3 — that\'s why dashboards can lag a few seconds but a dropped ingest point cannot happen silently."' },
        { kind: "SAY", text: 'Push back where useful: "Does every metric need 10s resolution, or just the tier-1 services? That changes cardinality and cost by a lot." Treat requirements as negotiable.' },
        { kind: "SAY", text: '"At-least-once ingestion with idempotent writes is the durability story, not exactly-once coordination — Kafka retention is the source of truth if an ingester crashes mid-flush."' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a write-heavy time-series store with cardinality-capped ingestion, Gorilla compression, and tiered storage. With more time I\'d cover multi-tenant isolation, anomaly detection, and backfill."' },
      ],
      grading: "Explicit SLA tiers used to justify trade-offs, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but cardinality and compression stay hand-waved.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: agents, a queue, a time-series database, a dashboard tool.",
          "Knows metrics have a name, a value, and a timestamp, and adds tags 'sort of'.",
          "Adds a cache in front of the database for dashboard queries because reads should be fast.",
          "Can sketch a threshold alert: 'if value > X, alert'.",
          "Handles 'what about old data' by saying 'delete it after a while'.",
        ],
        gaps: [
          "Doesn't reason about cardinality at all — treats 'how many time series' as unknowable or unimportant.",
          "No compression story; assumes the database 'just handles it'.",
          "Alerting is a bare threshold check with no window or debounce, so it would page on noise.",
          "No sharding story for the write path — assumes the database scales itself.",
          "Downsampling, if mentioned, is 'just delete old data' rather than roll it up.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks defaults with reasons, names trade-offs when asked, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes ingestion rate, series count, and latency targets on the board within the first 5 minutes.",
          "Picks push-with-local-aggregation over naive push or pull-only, and defends it.",
          "Names Gorilla-style compression (delta-of-delta + XOR) with a rough bytes/point number.",
          "Shards the write path by hash(metric+labels), not time or host, and explains why.",
          "Designs windowed alert evaluation with a 'for' duration, not a bare threshold.",
          "Splits hot/cold storage tiers with downsampling.",
          "Mentions cardinality limits when asked.",
        ],
        gaps: [
          "Volunteers the cardinality risk only after being prompted, not proactively.",
          "Doesn't quantify the compression ratio or storage cost, just says 'we compress it'.",
          "Alertmanager-style grouping/dedup only comes up if the interviewer asks about '200 pages at once'.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces cardinality as the load-bearing risk before being asked, and brings operational maturity beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Names cardinality as the single load-bearing risk of the whole design, unprompted, with a quantified failure mode (one bad label out-growing the entire fleet).",
          "Brings up the ordering constraint compression imposes on sharding unprompted (why time/host sharding breaks Gorilla).",
          "Defines explicit tiers — ingestion durability > alerting correctness > dashboard freshness — and uses that hierarchy to justify every trade-off.",
          "Discusses late-data/watermark handling for alert correctness without being asked.",
          "Pushes back on requirements ('does every metric need 10s resolution, or just the tier-1 ones?').",
          "Closes with a one-sentence summary and an explicit list of what they'd cover with more time (multi-tenancy isolation, anomaly detection, backfill).",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Sizing the system by host count instead of time-series cardinality — cardinality is the variable that actually breaks things.",
      "Storing raw 16-byte points with no compression story at tens of millions of points/sec — the storage bill alone kills the design.",
      "Alerting on a single raw sample with no window or debounce, guaranteed to page on noise.",
      "Sharding the write path by time, creating a single hot shard that owns 100% of 'now'.",
      "No cardinality limit anywhere, so one mislabeled metric can take down ingestion for every team.",
      "Treating dashboards and alerting as the same latency tier as ingestion durability — losing a data point silently is worse than a slow query.",
      "No plan for late-arriving data corrupting alert windows or double-counting.",
    ],
    followUps: [
      {
        q: "What happens if one team's metric goes cardinality-unbounded (e.g. tagged with a UUID)?",
        a: "The ingestion gateway enforces a hard per-tenant series cap and rejects points for series past the limit before they ever reach an ingester — cheap and stateless compared to discovering the problem after an ingester has already paid the memory cost. Separately, a cardinality-growth-rate alert (not just an absolute count) catches the runaway metric within minutes so the offending team can fix the label before hitting the cap, rather than silently dropping data.",
      },
      {
        q: "Why not just use a general-purpose database like Postgres or DynamoDB for time-series data?",
        a: "The write pattern is append-only, strictly ordered per series, and almost never updated — that matches a specialized, delta-encoded, time-partitioned store far better than a general row store. A general-purpose database pays per-point index overhead that's unaffordable at 50M points/sec; a time-series store amortizes cost by encoding each point as a small delta from its predecessor, which only works because it assumes the access pattern in advance.",
      },
      {
        q: "How do you avoid paging on-call 200 times for one root cause?",
        a: "Alertmanager groups and dedups notifications by label (e.g. group by cluster or service), so a single root cause tripping 200 host-level rules collapses into one notification with the 200 individual breaches attached as context, not 200 separate pages. Inhibition rules can also suppress dependent alerts — e.g. don't page for every service's error-rate alert if the cluster-down alert already fired.",
      },
      {
        q: "What if a query spans both the hot and cold tier?",
        a: "The query engine is tier-aware: it fetches raw 10s data from the hot tier for the portion of the range within 15 days, fetches downsampled 5m/1h data from object storage for the older portion, and merges the two into one series. This is acceptable because at that time range no one is looking at 10s resolution anyway, and the latency budget loosens for long-range historical queries versus the sub-200ms live-dashboard case.",
      },
      {
        q: "How do you keep ingestion durable if an ingester crashes mid-flush?",
        a: "Kafka is the durable source of truth for at-least-once delivery, not the in-memory encoder — a crashed ingester simply re-consumes from its last committed offset on restart. Combined with RF=3 replication across ingesters, losing one node loses neither the durable log (Kafka retention) nor the in-flight head block (still held by two other replicas), so recovery is a re-consume, not a data-loss event.",
      },
      {
        q: "How would multi-tenancy work so one team can't starve another team's queries?",
        a: "Each tenant gets its own cardinality quota enforced at the gateway, and its own routing key (tenant ID folded into the partition/shard key) so one tenant's write burst doesn't crowd out another's Kafka partitions. On the query side, per-tenant rate limits at the query frontend and fair-share scheduling at the querier prevent one team's expensive, wide-range query from stalling dashboards for everyone else.",
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
          "This is a write-heavy time-series store with two side channels — dashboards and alerting — bolted onto a shared ingestion pipeline. The core operation is appending a (timestamp, value) point to the correct series and, eventually, letting someone aggregate over a range of those points. Everything expensive (compression, sharding, cardinality limits) exists to keep that append cheap and unbounded-safe at 50M points/sec.",
          "Anchor everything on five numbers: 500M active series, 50M points/sec ingested, a sub-200ms p99 dashboard query, a sub-60s breach-to-page alert budget, and a write:query ratio of roughly 5000:1 (50M writes/sec against ~10K dashboard queries/sec). Every structural choice below is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing: cardinality, not hosts",
        body: [
          "100K hosts at ~1K metrics/host gives a 100M-series infrastructure baseline; realistic app and business metrics push that to ~500M. The number that actually threatens the system is a single metric tagged with a high-cardinality label — customer_id, request_id — which can out-grow the entire rest of the fleet by itself, because a time series is created per unique label combination, not per host.",
          "That's why 500M is a provisioned budget, enforced by a cap, rather than an organic outcome: the system has to actively reject growth past the number it was sized for.",
        ],
      },
      {
        heading: "Collection: push with local aggregation",
        body: [
          "Pull (Prometheus-style scraping) gives a free liveness signal and server-controlled load, but needs service discovery and can't reach firewalled hosts or short-lived jobs. Push works through firewalls and for ephemeral jobs, but naively means one network call per stat and loses the free 'target is down' signal.",
          "The resolution is push through a local aggregation agent: pre-aggregate counters and histograms in-process over the push interval, send one packet per metric per interval, jitter intervals across hosts to avoid a thundering herd, and add an explicit heartbeat/last-seen check to recover the liveness signal pull gave away for free.",
        ],
      },
      {
        heading: "Compression: Gorilla's delta-of-delta and XOR",
        body: [
          "Naive storage is 16 bytes/point (8-byte timestamp + 8-byte float); at 50M points/sec over 15 days that's an unaffordable hot tier. Gorilla-style compression exploits two regularities: timestamps mostly arrive on a fixed interval, so delta-of-delta encoding costs a single bit on the common case, and consecutive values are usually close together, so XOR-ing them yields mostly zero bits.",
          "The result is ~1.37 bytes/point on average, roughly a 12:1 ratio, bringing the 15-day hot tier down to ~90TB. The catch is that this encoding is stateful per series — it needs the previous point to encode the next — so it requires strictly ordered, in-order arrival, which drives the sharding decision below.",
        ],
      },
      {
        heading: "Sharding and storage tiering",
        body: [
          "Writes are sharded by a consistent hash of (metric name + sorted label set), not by time (which creates a single hot shard owning 'now') or by host (which is uneven and doesn't guarantee per-series order). A given series always lands on the same ingester, satisfying the ordering requirement compression depends on; ingesters replicate at RF=3 for durability.",
          "Storage is tiered like a cache hierarchy: 15 days at 10s resolution on local SSD for live-debugging dashboards, then a background compactor downsamples to 5-minute and 1-hour resolution and moves it to object storage for the remaining ~13 months at 10-50x lower cost per byte. The query engine merges tiers transparently when a range spans both.",
        ],
      },
      {
        heading: "Alerting semantics and SLA tiers",
        body: [
          "Alert rules evaluate over sliding windows with a sustained-breach 'for' duration, not a single raw sample, so a transient blip doesn't page anyone. A small watermark delay before evaluation absorbs slightly late points without causing a false clear or false re-fire. Alertmanager groups and dedups notifications by root cause, so a fleet-wide failure produces one page, not one per host.",
          "An explicit tier hierarchy — ingestion durability first, alerting correctness second, dashboard freshness third — justifies every trade-off in the design: dashboards may lag a few seconds behind real time, but a silently dropped ingest point or a missed page cannot happen, because those failures are far more expensive than a slow chart.",
        ],
      },
    ],
  },
};
