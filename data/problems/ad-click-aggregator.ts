import type { Problem } from "@/lib/types";

export const adClickAggregator: Problem = {
  slug: "ad-click-aggregator",
  num: "2.1",
  title: "Design an Ad Click Aggregator",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design an ad click aggregation system that ingests 50K clicks/sec sustained (200K/sec at peak) across 10M active ads, deduplicates and counts them accurately enough to drive advertiser billing, and serves both a near-real-time dashboard (under 1 minute freshness) and an exact, reconciled daily count used for invoicing.",
  ],
  hardParts:
    "The hard parts: defining and defending exactly-once click counting when the number directly drives advertiser billing, aggregating high-cardinality dimensions (ad × campaign × minute × geo × device) in real time without the key space exploding, and reconciling a fast approximate view against a slow exact one without ever confusing which number is the invoice.",
  keyTopics: [
    "Exactly-Once Stream Aggregation",
    "Idempotency Keys & Dedup Windows",
    "Watermarks for Late/Out-of-Order Events",
    "Two-Tier Accuracy: Real-Time vs T+1 Reconciled",
    "Hot-Ad Partition Skew",
  ],
  foundationsReferenced: [
    { label: "Apache Kafka", tone: "orange" },
    { label: "Apache Flink / Stream Processing", tone: "orange" },
    { label: "Apache Druid (OLAP)", tone: "purple" },
    { label: "Idempotency & Exactly-Once Delivery", tone: "green" },
    { label: "Consistent Hashing / Partitioning", tone: "blue" },
    { label: "HyperLogLog", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Ad Click", sub: "browser / app SDK", col: 1, row: 1, tone: "slate" },
      { id: "lb", label: "Load Balancer", col: 2, row: 1, tone: "slate" },
      {
        id: "ingest",
        label: "Click Ingestion Service",
        sub: "stateless · assigns click_id",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "redis", label: "Redis", sub: "idempotency key · 10min TTL", col: 4, row: 1, tone: "green" },
      { id: "kafka", label: "Kafka", sub: "raw_clicks · part. by ad_id", col: 5, row: 1, tone: "orange" },
      {
        id: "flink",
        label: "Flink",
        sub: "1-min windows",
        mono: "watermark = event time − 5min",
        col: 5,
        row: 2,
        tone: "orange",
      },
      { id: "druid_rt", label: "Druid (real-time)", sub: "~1 min freshness", col: 4, row: 2, tone: "purple" },
      { id: "s3", label: "S3 Data Lake", sub: "raw click log, Parquet", col: 5, row: 3, tone: "slate" },
      { id: "spark", label: "Spark Batch Job", sub: "T+1 reconciliation", col: 4, row: 3, tone: "orange" },
      { id: "druid_hist", label: "Druid (historical)", sub: "billing-exact", col: 3, row: 3, tone: "blue" },
      { id: "dashboard", label: "Advertiser Dashboard", sub: "Query API", col: 1, row: 3, tone: "green" },
    ],
    edges: [
      { from: "client", to: "lb", kind: "write" },
      { from: "lb", to: "ingest", kind: "write" },
      { from: "ingest", to: "redis", label: "dedup check", kind: "write" },
      { from: "ingest", to: "kafka", label: "ack · raw_clicks", kind: "write" },
      { from: "kafka", to: "flink", label: "consume", kind: "analytics" },
      { from: "flink", to: "druid_rt", label: "upsert rollups", kind: "analytics" },
      { from: "kafka", to: "s3", label: "raw archive", kind: "analytics" },
      { from: "s3", to: "spark", label: "T+1 nightly", kind: "analytics" },
      { from: "spark", to: "druid_hist", label: "reconciled counts", kind: "analytics" },
      { from: "dashboard", to: "druid_rt", label: "last 1hr · approx", kind: "read" },
      { from: "dashboard", to: "druid_hist", label: "billing-exact · T+1", kind: "read" },
    ],
    legend: [
      { kind: "write", text: "ingest path · 50K-200K clicks/s" },
      { kind: "analytics", text: "streaming + batch aggregation" },
      { kind: "read", text: "dashboard reads · approximate and billing-exact" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Ingest ad click events (ad_id, campaign_id, advertiser_id, device/user id, ts, geo, referrer) at high throughput", tag: "P0" },
      { id: "FR-02", text: "Deduplicate duplicate click events (double-tap, client retry, replayed pixel) within a bounded window", tag: "P0" },
      { id: "FR-03", text: "Aggregate click counts per ad at 1-minute grain, rolled up to hour and day", tag: "P0" },
      { id: "FR-04", text: "Serve advertiser dashboard queries: clicks by ad/campaign over an arbitrary time range", tag: "P0" },
      { id: "FR-05", text: "Produce an exact, reconciled click count per ad per day for billing, eventually consistent (T+1)", tag: "P0" },
      { id: "FR-06", text: "Basic bot/fraud signal filtering (per-IP/device rate limits, known bot lists) before a click counts toward spend", tag: "P0" },
      { id: "FR-07", text: "Top-N queries: top 100 ads by clicks in the last hour, sliding", tag: "P1" },
      { id: "FR-08", text: "Filter/breakdown aggregates by dimension: geo, device, placement", tag: "P1" },
      { id: "FR-09", text: "Handle late-arriving events (mobile network delay) up to a bounded lateness", tag: "P1" },
      { id: "FR-10", text: "Support backfill/reprocessing of historical data when aggregation logic changes", tag: "P1" },
      { id: "FR-11", text: "CSV/API export of an advertiser's click data for a custom date range", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Ingestion throughput, sustained (burst)", tag: "50K/sec (200K/sec)" },
      { id: "NFR-02", text: "Ingestion ack latency, server-side", tag: "p99 < 20ms" },
      { id: "NFR-03", text: "Real-time dashboard freshness (approximate)", tag: "< 1 min" },
      { id: "NFR-04", text: "Billing count accuracy, reconciled (T+1)", tag: "zero double-count/loss" },
      { id: "NFR-05", text: "Dashboard query latency", tag: "p99 < 200ms" },
      { id: "NFR-06", text: "Durability of the raw click log", tag: "zero loss" },
      { id: "NFR-07", text: "Ingestion path availability", tag: "99.95%" },
      { id: "NFR-08", text: "Retention: raw log (hot rollups)", tag: "1yr (90d)" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: click volume and the cardinality trap",
      body: [
        "Start from the numbers before drawing anything. 200K clicks/sec at peak is far too much for one writer, so the first structural decision — partitioning by ad_id — falls straight out of that number. Then check the other axis: if you naively kept one counter row per (ad, minute, geo, device) combination, the key space would explode long before the traffic does.",
        "10M active ads × 1,440 minutes/day is already 14.4B potential keys per day before you even add geo or device breakdowns — most of which are zero because most ads aren't clicked in most minutes. The fix isn't a bigger database, it's picking the aggregation grain (1-minute base buckets, rolled up to hour/day) so only live ads generate keys, and letting the OLAP store's rollup do the collapsing instead of pre-allocating every combination.",
      ],
      bullets: [
        { lead: "Peak throughput", text: "200K clicks/sec spread across ~200 Kafka partitions keyed by ad_id keeps each partition around 1K clicks/sec — comfortably within a single consumer's throughput." },
        { lead: "Cardinality", text: "10M ads × 1-min buckets is 14.4B potential keys/day if uncapped; capping the base grain at 1 minute and only materializing keys that actually got a click keeps the live set orders of magnitude smaller." },
        { lead: "Raw storage", text: "4.3B clicks/day × ~200 bytes/click ≈ 860GB/day raw, compressing to roughly 250GB/day in Parquet — the number that sizes the S3 data lake and the nightly Spark job." },
      ],
      pictureTitle: "Sizing the ingestion pipe",
      pictureRows: [
        { label: "200K clicks/sec peak", value: "~200 Kafka partitions @ ~1K/sec each", tone: "good" },
        { label: "10M ads × 1-min buckets", value: "14.4B potential keys/day if uncapped", tone: "bad" },
        { label: "1-min base grain + rollup", value: "bounds active keys to ads actually clicked", tone: "good" },
      ],
      remember: {
        problem: "200K clicks/sec and 10M ads threaten to explode both throughput and key cardinality.",
        solution: "Partition Kafka by ad_id (~200 partitions); aggregate at a 1-minute base grain and roll up.",
        why: "Partitioning bounds per-partition throughput; a fixed base grain bounds the live key set to ads actually clicked, not every possible combination.",
        tradeoff: "1-minute grain means sub-minute queries aren't possible without re-deriving from raw events.",
        failure: "Pre-allocating a counter per (ad, minute, geo, device) combination would blow past 14B keys/day, most of them zero.",
        mitigation: "Only materialize a key on first click in that bucket; let Druid's rollup collapse dimensions at query time.",
      },
    },
    {
      n: 2,
      title: "Exactly-once: clicks are money, not a rounding error",
      body: [
        "Most analytics pipelines tolerate a little double-counting. This one can't: clicks map directly to advertiser billing (cost-per-click), so overcounting is overbilling — a real financial and legal liability — and undercounting is lost revenue and an advertiser who thinks the platform is broken. \"Close enough\" is a bug here, not an approximation.",
        "Duplicates enter at three different layers, so each needs its own defense. A client-side retry (an SDK that times out and resends) is caught with an idempotency key. A restarted stream processor re-reading events it already committed is caught with exactly-once checkpointing. A bot replaying the same click thousands of times is caught with rate limiting before the click is allowed to count toward spend at all.",
      ],
      bullets: [
        { lead: "Client retry", text: "the SDK generates a click_id (hash of ad_id + user + timestamp bucket); the Ingestion Service checks it against Redis with a 10-minute TTL before accepting, so a resend within the window is a no-op." },
        { lead: "Pipeline restart", text: "even a perfectly deduped input stream can be double-processed if Flink crashes mid-window; exactly-once checkpointing (state snapshot + transactional sink) guarantees each event affects the aggregate exactly once, not zero or twice." },
        { lead: "Bot / fraud burst", text: "per-IP and per-device rate limits, checked before a click is credited toward billing, though the raw event is still logged for fraud analysis rather than silently dropped." },
      ],
      pictureTitle: "Where duplicates get introduced, and where they get killed",
      pictureRows: [
        { label: "Client-side retry", value: "Redis idempotency key, 10-min TTL", tone: "good" },
        { label: "Flink restart mid-window", value: "checkpointed exactly-once state + sink", tone: "good" },
        { label: "Bot replaying a click", value: "rate-limited before it counts toward billing", tone: "neutral" },
      ],
      remember: {
        problem: "A click maps to real money, so duplicate or lost clicks are a billing bug, not noise.",
        solution: "Three independent defenses: Redis idempotency key, Flink exactly-once checkpointing, pre-billing rate limits.",
        why: "Duplicates originate at three different layers (client, pipeline, adversary) and no single mechanism catches all three.",
        tradeoff: "Every layer adds latency and state (Redis lookups, checkpoint overhead, rate-limit bookkeeping) to a path that also needs to be fast.",
        failure: "Relying only on client-side dedup misses pipeline-restart duplicates; relying only on exactly-once misses bot replay, since a replayed click is a 'new' distinct event.",
        mitigation: "Layer the defenses instead of picking one; log everything raw so fraud rules can be tightened later without losing data.",
      },
    },
    {
      n: 3,
      title: "Event time, watermarks, and why 'now' is the wrong clock",
      body: [
        "A mobile click can sit in a spotty network for seconds to minutes before it reaches the server. If aggregation used processing time (when the server saw the event), those delayed clicks would land in the wrong minute bucket. So every click carries its own event timestamp, and Flink windows on that instead of wall-clock arrival time.",
        "But you can't wait forever for stragglers — a window has to close eventually or the dashboard never updates. A watermark (current max event time seen, minus an allowed lateness of 5 minutes) is the trigger: once the watermark passes a bucket's end, that bucket emits. Anything arriving after that goes to a side output instead of quietly reopening a closed window.",
      ],
      bullets: [
        { lead: "Event time vs. processing time", text: "windows are keyed on the timestamp embedded in the click payload, not on when Flink received it, so mobile delay doesn't misplace the click." },
        { lead: "Watermark", text: "computed as max observed event time minus 5 minutes; a window closes and emits once the watermark passes its end boundary." },
        { lead: "Beyond the bound", text: "events arriving after the watermark has already closed their window go to a 'late clicks' side output — they don't reopen the real-time aggregate, they get folded in during the T+1 batch reconciliation instead." },
      ],
      pictureTitle: "Why 'now' is the wrong clock for a mobile click",
      pictureRows: [
        { label: "Processing time", value: "delayed clicks land in the wrong bucket", tone: "bad" },
        { label: "Event time + watermark", value: "clicks land in their true minute", tone: "good" },
        { label: "Beyond 5-min lateness", value: "side output → folded in at T+1, not lost", tone: "neutral" },
      ],
      remember: {
        problem: "Out-of-order, delayed mobile clicks can't be aggregated on server-arrival time.",
        solution: "Window on event time; use a watermark (max event time − 5min) to decide when a window is done.",
        why: "Event time reflects when the click actually happened; a watermark bounds how long you wait for stragglers without waiting forever.",
        tradeoff: "5 minutes of allowed lateness means the real-time dashboard is provisionally 5 minutes behind 'fully settled'.",
        failure: "Waiting indefinitely for every straggler means windows never close and the dashboard never updates.",
        mitigation: "Route events past the lateness bound to a side output reconciled in the T+1 batch job instead of dropping them.",
      },
    },
    {
      n: 4,
      title: "Two-tier accuracy: real-time approximate vs. T+1 exact",
      body: [
        "One pipeline can't be both instantly fresh and perfectly correct, so this design deliberately runs two. The streaming path (Kafka → Flink → Druid real-time) gives advertisers a dashboard number under a minute old, good enough to react to a campaign in flight, but it's provisional: bounded by the watermark, occasionally short a late event or a fraud signal that hadn't resolved yet.",
        "The batch path re-reads the full raw click log from S3 the next day, applies the final dedup and fraud rules deterministically over the complete dataset (no lateness bound, no watermark trade-off), and writes the result to a separate 'historical' Druid datasource. That reconciled number — not the real-time one — is what actually appears on the invoice.",
      ],
      bullets: [
        { lead: "Real-time (Druid real-time)", text: "fed by Flink, fresh under 1 minute, uses HyperLogLog for approximate unique-click counts where exactness isn't worth the memory cost." },
        { lead: "Batch (Druid historical)", text: "fed by a nightly Spark job over the immutable S3 log, exact dedup and final fraud filtering, no time pressure — this is the number that generates the invoice." },
        { lead: "Say which is which", text: "the dashboard should visibly label the real-time number as an estimate and only firm it up once the T+1 reconciliation lands — advertisers should never mistake one for the other." },
      ],
      pictureTitle: "Two numbers, two jobs",
      pictureRows: [
        { label: "Druid real-time", value: "< 1 min, approximate, advisory only", tone: "neutral" },
        { label: "Druid historical (T+1)", value: "exact, deterministic, drives billing", tone: "good" },
        { label: "Confusing the two", value: "an advertiser disputes an invoice that never matched what they saw live", tone: "bad" },
      ],
      remember: {
        problem: "You can't be both sub-minute fresh and perfectly exact with one pipeline.",
        solution: "Run both: a streaming approximate view for dashboards and a T+1 batch reconciliation as the billing source of truth.",
        why: "Freshness and exactness trade off against each other; splitting them lets each side optimize for its own goal instead of compromising.",
        tradeoff: "Two pipelines, two Druid datasources, and a UI that must clearly label which number is which.",
        failure: "Treating the real-time number as final trains advertisers to distrust the invoice when it doesn't match what they saw live.",
        mitigation: "Label the real-time number as an estimate in the UI; reconcile nightly and only finalize billing off the batch result.",
      },
    },
    {
      n: 5,
      title: "The viral ad: partition skew on a single hot key",
      body: [
        "Aggregate throughput numbers hide a real risk: one ad going viral (a Super Bowl spot, a trending post) can send a disproportionate share of the 200K clicks/sec at a single ad_id. Since Kafka partitioning and Flink keyed state both key on ad_id, that traffic concentrates on one partition and one Flink subtask instead of spreading out — the same hot-key problem any key-based sharding scheme eventually hits.",
        "The fix is a two-stage aggregation: salt the key with a random shard suffix (ad_id#0 .. ad_id#N) so the hot ad's clicks spread across N partitions and N parallel Flink subtasks, each keeping a partial count; a second, cheap reduce stage sums the N partial counts back into one per-ad total before it hits Druid.",
      ],
      bullets: [
        { lead: "Symptom", text: "one Kafka partition and one Flink subtask absorb far more than their 1K clicks/sec share, becoming the bottleneck for the entire pipeline's throughput." },
        { lead: "Salted key", text: "ad_id#0..N spreads a single hot ad's clicks across N partitions instead of one, at the cost of a small combiner step afterward." },
        { lead: "Combine stage", text: "a second Flink operator sums the N partial per-shard counts into the true per-ad total — the classic map-side combiner pattern applied to a streaming key." },
      ],
      pictureTitle: "Spreading one hot ad across many partitions",
      pictureRows: [
        { label: "Plain ad_id key", value: "viral ad saturates 1 of 200 partitions", tone: "bad" },
        { label: "Salted ad_id#shard key", value: "viral ad's load spreads across N shards", tone: "good" },
        { label: "Combine stage", value: "N partial counts summed back to 1 total", tone: "neutral" },
      ],
      remember: {
        problem: "A single viral ad concentrates load on one partition and one Flink subtask.",
        solution: "Salt the aggregation key (ad_id#shard) to spread it, then combine partial sums back into one total.",
        why: "Key-based partitioning is only balanced if no single key dominates; salting turns one hot key into N warm ones.",
        tradeoff: "Every ad now pays a small combine step, even the 99.99% that were never going to be hot.",
        failure: "Without salting, a viral ad can single-handedly cap the whole pipeline's throughput at one partition's ceiling.",
        mitigation: "Salt dynamically only when a key's rate crosses a threshold, to avoid paying the combine cost on every ad by default.",
      },
    },
    {
      n: 6,
      title: "Why Kafka + Flink + Druid, not just a database",
      body: [
        "The obvious naive design — write each click as an UPDATE counters SET clicks = clicks + 1 in Postgres — fails immediately at 200K clicks/sec: row-level lock contention on hot ad rows and write amplification from constant updates make it a non-starter. Each piece of this stack earns its place by solving one part of that problem.",
        "Kafka is a durable buffer that decouples the bursty, spiky ingestion rate from the steadier rate downstream consumers can process at — a traffic spike fills the log instead of falling over. Flink is a stateful stream processor built for exactly-once windowed aggregation, which a plain consumer loop doesn't give you for free. Druid is a purpose-built time-series OLAP store with native rollup and bitmap indexes, so a dashboard query (clicks by campaign, last 7 days, broken down by geo) is a sub-200ms scan instead of a full-table aggregation.",
      ],
      bullets: [
        { lead: "Why not just Postgres counters", text: "row-level locking on a hot ad's counter row serializes every click to that ad; at 200K/sec aggregate the p99 write latency would blow past any usable SLA." },
        { lead: "Kafka's job", text: "absorb bursts durably and let ingestion and aggregation scale independently — the Ingestion Service never blocks waiting on Flink." },
        { lead: "Druid's job", text: "pre-aggregated rollups and roaring-bitmap indexes make a multi-dimensional dashboard query fast without scanning raw events at read time." },
      ],
      pictureTitle: "Why each piece is there",
      pictureRows: [
        { label: "Postgres UPDATE counter", value: "lock contention melts down at 200K/sec", tone: "bad" },
        { label: "Kafka", value: "durable buffer, decouples ingest from aggregation", tone: "good" },
        { label: "Flink", value: "stateful, exactly-once windowed aggregation", tone: "good" },
        { label: "Druid", value: "OLAP rollups, sub-200ms dashboard queries", tone: "good" },
      ],
      remember: {
        problem: "Naive per-click row updates can't survive 200K clicks/sec on hot ads.",
        solution: "Kafka to buffer, Flink to aggregate statefully and exactly-once, Druid to serve OLAP queries fast.",
        why: "Each piece specializes in the one thing a general-purpose OLTP database is bad at here: absorbing bursts, stateful windowed math, and multi-dimensional read-time rollups.",
        tradeoff: "Three systems to operate instead of one, and eventual — not immediate — consistency between them.",
        failure: "A single Postgres counter table serializes writes on hot rows and can't hold multi-dimensional history for fast ad-hoc queries.",
        mitigation: "Accept the operational surface area; it's the price of both write throughput and read flexibility at this scale.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a streaming aggregation pipeline: absorb bursty clicks in Kafka, aggregate them statefully and exactly-once in Flink, and serve the rollups from Druid.",
      "Because clicks drive billing, exactly-once counting is enforced at three layers: a Redis idempotency key for client retries, Flink checkpointing for pipeline restarts, and rate limits for bot replay.",
      "Two accuracy tiers run side by side: a real-time approximate dashboard (under 1 minute fresh) and a T+1 batch reconciliation over the raw S3 log that is the actual billing source of truth.",
      "Event-time windowing with a watermark handles delayed mobile clicks without waiting forever for stragglers.",
      "A single viral ad can saturate one partition, so the aggregation key gets salted and combined back, the same fix as any hot-key problem.",
    ],
    flows: [
      {
        kind: "write",
        title: "INGEST · 50K-200K CLICKS/SEC",
        summary:
          "A click reaches the Ingestion Service, gets checked against Redis for a duplicate, and is acknowledged into Kafka. The service is stateless and never waits on anything downstream of Kafka.",
        steps: [
          { label: "Client", note: "browser or app SDK fires a click" },
          { label: "Load Balancer", note: "routes to a nearby pod" },
          { label: "Ingestion Service", note: "stateless, assigns click_id" },
          { label: "Redis", note: "idempotency check, 10-min TTL" },
          { label: "Kafka", note: "ack, raw_clicks partitioned by ad_id" },
        ],
      },
      {
        kind: "analytics",
        title: "STREAM + BATCH AGGREGATION",
        summary:
          "Two paths off the same Kafka topic: Flink aggregates in near-real-time for the dashboard, while the raw log lands in S3 for a nightly job that produces the exact billing number.",
        steps: [
          { label: "Kafka", note: "raw_clicks topic" },
          { label: "Flink", note: "1-min tumbling windows, watermark = event time − 5min, exactly-once" },
          { label: "Druid (real-time)", note: "upserted rollups, ~1 min freshness" },
          { label: "S3 Data Lake", note: "raw archive, Parquet" },
          { label: "Spark", note: "T+1 nightly reconciliation over the full raw log" },
          { label: "Druid (historical)", note: "billing-exact counts" },
        ],
      },
      {
        kind: "read",
        title: "DASHBOARD QUERY",
        summary:
          "The advertiser dashboard reads two datasources depending on what it's asking: last-hour trends come from the fast approximate store, invoice-facing totals come from the reconciled store.",
        steps: [
          { label: "Advertiser Dashboard", note: "requests clicks by ad/campaign/time range" },
          { label: "Query API", note: "stateless" },
          { label: "Druid (real-time)", note: "last hour, approximate, HLL for uniques" },
          { label: "Druid (historical)", note: "T+1, billing-exact" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "50K clicks/sec sustained, 200K/sec peak, ~4.3B clicks/day",
          "~200 Kafka partitions keyed by ad_id, ~1K clicks/sec each",
          "10M active ads, 1M campaigns; 1-min base aggregation grain",
          "Dedup window: 10-min idempotency key TTL in Redis",
          "Watermark lateness bound: 5 min before a window closes",
          "Raw click log: ~860GB/day raw, ~250GB/day Parquet compressed",
          "Retention: 1yr raw in S3, 90d hot rollups in Druid",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Kafka as a durable buffer, decoupling bursty ingest from steady aggregation",
          "Flink for stateful, exactly-once windowed aggregation, not a plain consumer loop",
          "Druid for OLAP rollups and bitmap indexes, not Postgres UPDATE counters",
          "Two-tier accuracy: real-time approximate (Druid + HLL) vs T+1 exact (Spark reconciliation)",
          "Redis idempotency key for client-side dedup; Flink checkpointing for pipeline-side dedup",
          "Salted key (ad_id#shard) + combine stage for viral-ad hot partitions",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Clicks map directly to advertiser billing, so 'close enough' counting is a financial bug",
          "Real-time dashboard numbers are advisory; only the T+1 reconciled number invoices",
          "Watermarks trade dashboard freshness for correctness on late, out-of-order mobile clicks",
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
      goal: "Lock the throughput numbers and, critically, get the interviewer to confirm that clicks drive billing — that single fact changes every downstream decision.",
      why: "This system looks like generic analytics until you establish that a click is worth money. Every later choice (three layers of dedup, two accuracy tiers) is a direct consequence of that one fact, so surfacing it early is what separates a strong answer from a generic streaming pipeline.",
      steps: [
        { kind: "ASK", text: '**"Do clicks drive advertiser billing (CPC), or is this purely analytics?"** This is the single most important question in the interview — land on "yes, billing" and write **"clicks = $, exactly-once matters"** at the top of the board.' },
        { kind: "ASK", text: '**"What throughput are we sizing for?"** Land on "50K/sec sustained, 200K/sec peak" and **"10M active ads"**. Write both down.' },
        { kind: "SAY", text: 'Propose the two-tier freshness target yourself: **"sub-1-minute dashboard, but the real billing number is T+1 reconciled"**. Wait for a nod before moving on.' },
        { kind: "SAY", text: 'State scope. In: "ingestion", "dedup", "real-time aggregation", "billing reconciliation", "basic fraud filtering". Out: "ad targeting/serving", "full fraud-detection ML", "payment processing". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the volume math out loud: **"4.3B clicks/day × ~200 bytes ≈ 860GB/day raw"**, **"~250GB/day compressed"**. Write the totals on the board.' },
      ],
      grading: "Do they surface the billing implication unprompted or only after a hint? Are the throughput and freshness numbers written down before any boxes get drawn?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "One ingestion endpoint, one immutable raw-click event schema, and the aggregation grain justified with the cardinality math.",
      why: "The interviewer wants to see the schema and the grain chosen deliberately, not defaulted to. Bringing the 14B-key cardinality problem forward before being asked shows sizing discipline.",
      steps: [
        { kind: "WRITE", text: 'Write the ingestion contract: **"POST /click { ad_id, campaign_id, advertiser_id, device_id, ts, geo, referrer, click_id }"** returns **"202 Accepted"**, latency-critical, uncapped.' },
        { kind: "DRAW", text: 'Sketch the raw click event: **"click_id (client-generated idempotency key)"**, **"ad_id"**, **"campaign_id"**, **"event_ts"**, **"geo"**, **"device"**. Say: "This raw event is immutable and archived forever — it\'s the only thing the T+1 reconciliation trusts."' },
        { kind: "SAY", text: 'Justify the aggregation grain: **"1-minute base buckets, rolled up to hour and day"**. "10M ads × 1,440 min/day is 14.4B potential keys if uncapped — the grain plus only materializing keys that got a click keeps that bounded."' },
        { kind: "RULE OUT", text: 'Get ahead of the obvious alternative: "Updating a per-ad counter row directly in Postgres seems simpler, but at 200K/sec it serializes on hot-ad row locks. That\'s why this goes through Kafka and Flink instead." Cross it off.' },
      ],
      grading: "Clear ingestion contract, an immutable raw-event schema explicitly tied to the reconciliation story, and the cardinality math volunteered before being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: ingest/write, stream+batch aggregation, and dashboard reads. Label arrows with throughput and freshness, not just box names.",
      why: "Drawing ingestion, aggregation, and reads as separate lanes proves you understand they have different SLAs and failure domains — and specifically that the real-time and batch aggregation paths are two different jobs feeding two different datasources, not one pipeline with two speeds.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **ingest lane**: Client → LB → Ingestion Service → Redis (dedup check) → Kafka. Label the arrows **"10-min idempotency TTL"**, **"ack into raw_clicks, partitioned by ad_id"**.' },
        { kind: "DRAW", text: 'Add the **aggregation lane** off Kafka, splitting into two: Kafka → Flink → Druid (real-time), labeled **"1-min windows, watermark, ~1 min freshness"**; and Kafka → S3 → Spark → Druid (historical), labeled **"T+1, exact"**.' },
        { kind: "DRAW", text: 'Add the **read lane**: Advertiser Dashboard → Query API → both Druid datasources, labeled **"last-hour approx"** vs **"billing-exact"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because ingestion, aggregation, and reads have different SLAs — and the aggregation lane itself splits into fast-approximate and slow-exact, which is the core tension of this whole system."' },
      ],
      grading: "Three clearly separated lanes, the real-time/batch split drawn explicitly (not glossed over), and an explicit statement of which Druid datasource answers which kind of query.",
    },
    {
      n: 4,
      title: "Deep Dive: Exactly-Once Counting and Dedup",
      minutes: 8,
      goal: "Walk all three duplicate sources — client retry, pipeline restart, bot replay — and the distinct defense for each.",
      why: "This is the signature sub-problem. The interviewer is probing whether you understand that 'exactly-once' isn't one mechanism but a property that has to be defended independently at each layer where duplication can be introduced.",
      steps: [
        { kind: "SAY", text: 'Name the three sources: "Client retries, pipeline restarts, and bot replay all produce duplicate-looking clicks, but they need three different defenses."' },
        { kind: "DRAW", text: 'Draw the Redis check: "click_id computed client-side, checked against Redis with a 10-min TTL. A resend within the window is a no-op."' },
        { kind: "SAY", text: 'Explain Flink exactly-once: "Even a fully deduped input can be double-processed if Flink crashes mid-window. Checkpointed state plus a transactional sink to Druid guarantees each event affects the aggregate exactly once."' },
        { kind: "SAY", text: 'Explain fraud-side rate limiting: "Per-IP/device rate limits run before a click is credited toward billing — the event is still logged raw for later fraud analysis, never silently dropped."' },
        { kind: "RULE OUT", text: '"Relying on just one of these misses the other two failure modes — that\'s why all three layers exist independently."' },
      ],
      grading: "All three duplicate sources named without prompting, a distinct mechanism for each, and the money framing ('this is a billing bug, not noise') stated explicitly.",
    },
    {
      n: 5,
      title: "Deep Dive: Watermarks and Two-Tier Accuracy",
      minutes: 7,
      goal: "Explain event-time windowing with a watermark, then volunteer the real-time-vs-reconciled split as the resolution to the freshness/exactness trade-off.",
      why: "Anyone can say 'stream processing with windows'. The interviewer wants event time vs. processing time reasoned through, and — for the top score — the candidate explicitly naming that freshness and exactness are in tension and this design deliberately runs two pipelines to avoid compromising on either.",
      steps: [
        { kind: "SAY", text: 'Explain event time: "Mobile clicks can be delayed seconds to minutes in-flight. Windowing on event time, not arrival time, keeps a delayed click in its true minute bucket."' },
        { kind: "SAY", text: 'Explain the watermark: "Watermark = max observed event time minus 5 minutes of allowed lateness. A window closes and emits once the watermark passes its end — anything later goes to a side output instead of reopening it."' },
        { kind: "SAY", text: 'Volunteer the two-tier split: "This is exactly why I run two pipelines: the streaming path is fast but provisional, bounded by that watermark; the T+1 batch job re-reads the full raw log with no time pressure and produces the number that actually goes on the invoice."' },
        { kind: "SAY", text: 'Close with the UI implication: "The dashboard has to visibly label the real-time number as an estimate, or advertisers will dispute invoices that never matched what they saw live."' },
      ],
      grading: "Event time vs. processing time explained correctly, the watermark formula stated, and the real-time/T+1 split framed as the resolution to a named trade-off rather than two unrelated jobs.",
    },
    {
      n: 6,
      title: "Wrap: Hot Ads, Fraud, and Close",
      minutes: 5,
      goal: "Name the viral-ad hot-partition fix, touch fraud filtering, push back on one requirement, and close with a one-sentence summary plus a parked-items list.",
      why: "Staff-level signal here is spotting the hot-key problem specific to this domain (one ad going viral) before being asked, and closing like a collaborator who paced the interview rather than one who ran out of time mid-thought.",
      steps: [
        { kind: "SAY", text: 'Bring up hot-ad skew unprompted: "A single viral ad can saturate one Kafka partition and one Flink subtask since both key on ad_id. I\'d salt the key into N shards and combine the partial counts back — the standard hot-key fix applied here."' },
        { kind: "SAY", text: 'Touch fraud briefly: "Basic rate limits catch obvious bot bursts before billing; a full fraud-detection model is out of scope for this design but the raw log preserves everything needed to build one later."' },
        { kind: "SAY", text: 'Push back where useful: "Do advertisers actually need sub-1-minute freshness, or would 5 minutes let me simplify the real-time tier?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a Kafka/Flink/Druid streaming pipeline with layered exactly-once dedup and a two-tier accuracy model — fast approximate for dashboards, T+1 exact for billing. With more time I\'d cover fraud-model integration, cross-region failover, and schema evolution for the aggregation logic."' },
      ],
      grading: "Hot-ad partition skew named unprompted, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working streaming pipeline that hangs together, but treats it like generic analytics rather than a billing-critical system.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: Kafka, a stream processor, a database or 'analytics store'.",
          "Knows to use windowed aggregation instead of a per-click database write.",
          "Adds a cache or queue when asked 'what if it's too slow'.",
          "Can sketch the raw click schema with the obvious fields.",
          "Mentions deduplication when prompted about double-clicking.",
        ],
        gaps: [
          "Doesn't connect clicks to billing unprompted, so exactly-once feels like a nice-to-have instead of a hard requirement.",
          "Picks one dedup mechanism (usually 'a cache') and doesn't distinguish client retries from pipeline restarts from bot replay.",
          "No distinction between a fast dashboard number and an exact billing number — treats them as the same pipeline.",
          "Doesn't reason about event time vs. processing time for late/out-of-order events.",
          "No plan for a single viral ad concentrating load on one partition.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, names the billing implication, and builds layered dedup and windowing with reasons for each choice.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "States early that clicks drive billing and that exactly-once is a financial requirement, not a nice-to-have.",
          "Layers dedup across client idempotency key, Flink checkpointing, and pre-billing rate limits.",
          "Explains event time vs. processing time and the watermark formula correctly.",
          "Separates the real-time approximate view from a T+1 exact reconciliation.",
          "Justifies Kafka, Flink, and Druid each by what they specifically solve, not just 'that's the standard stack'.",
          "Does the cardinality and storage math before being asked.",
          "Names the viral-ad hot-partition risk when probed on scale.",
        ],
        gaps: [
          "Volunteers the two-tier accuracy split only after the interviewer asks 'how exact does this need to be', not proactively.",
          "Doesn't bring up the hot-ad salting fix unless directly asked about a single ad going viral.",
          "Frames the watermark/lateness trade-off in words but doesn't quantify the 5-minute bound or what happens beyond it.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Treats billing correctness as the organizing constraint of the whole design and surfaces every downstream consequence of it before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Names 'clicks are money' in the first five minutes and uses it to justify every subsequent trade-off — dedup layering, the two-tier split, even the UI's obligation to label estimates.",
          "Volunteers the real-time-vs-reconciled split unprompted, framing it as freshness and exactness being fundamentally in tension rather than a bolt-on afterthought.",
          "Brings up the viral-ad hot-partition risk before being asked, with the salt-and-combine fix already sketched.",
          "Explicitly separates dedup mechanisms by which failure mode they address (client, pipeline, adversary) instead of treating dedup as one generic step.",
          "Pushes back on requirements ('do advertisers really need sub-1-minute freshness, or would 5 minutes simplify the real-time tier?').",
          "Closes with a one-sentence summary and an explicit list of what's out of scope (fraud ML, cross-region failover, schema evolution).",
          "Paces the 40 minutes deliberately, parking tangents and returning to them only if time allows.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Writing per-click UPDATE counters into an OLTP database, which serializes on hot-ad row locks and can't survive 200K clicks/sec.",
      "Treating the real-time dashboard number as if it were the billing number, with no reconciliation step described at all.",
      "Deduplicating with a single mechanism (usually 'a cache') and not distinguishing client retries, pipeline restarts, and bot replay as different failure modes.",
      "Windowing on processing time (arrival time) instead of event time, which misplaces delayed mobile clicks into the wrong bucket.",
      "No plan at all for a single ad going viral and saturating one partition.",
      "Never connecting the system to billing, so exactly-once semantics never come up unless the interviewer forces the question.",
      "Silently dropping late or duplicate events instead of routing them somewhere reconcilable (side output, fraud log).",
    ],
    followUps: [
      {
        q: "Why not just make the real-time pipeline exact and skip the batch reconciliation entirely?",
        a: "Because exactness and low latency for out-of-order, delayed data are in direct tension — making the streaming path wait long enough to guarantee every late click has arrived would push its freshness from under a minute to potentially tens of minutes, defeating its purpose. The batch job has no such deadline: it reads the complete, immutable raw log the next day and can apply the final dedup and fraud rules deterministically over the whole dataset. Splitting the two lets each optimize for its own goal instead of both being mediocre.",
      },
      {
        q: "What happens if Kafka goes down for 10 minutes?",
        a: "The Ingestion Service's ack to the client depends on a successful Kafka write, so during an outage clicks either buffer briefly in the ingestion tier with backpressure, or get rejected with a retryable error and the client-side SDK retries later — the client-generated idempotency key makes that safe to retry without double-counting once Kafka recovers. Nothing downstream (Flink, Druid) is affected beyond a gap in fresh data; the T+1 batch job still reconciles correctly once Kafka's backlog drains, because it operates on whatever eventually lands in S3, not on real-time completeness.",
      },
      {
        q: "How would you detect and handle a coordinated bot attack inflating one advertiser's costs?",
        a: "Rate limiting per IP/device is the first line of defense and catches naive bursts, but a coordinated attack across many IPs needs pattern-based fraud scoring — click velocity per user, device fingerprint anomalies, geographic implausibility — which is explicitly out of scope for this design's core but is exactly why every raw click is archived immutably in S3. A fraud model can be layered in later as another consumer of the same raw_clicks topic or the S3 log, retroactively flagging and crediting back fraudulent clicks in the T+1 reconciliation without touching the ingestion or streaming path at all.",
      },
      {
        q: "Why Druid specifically, instead of ClickHouse or a data warehouse like BigQuery?",
        a: "Druid is purpose-built for exactly this shape of workload: high-cardinality, time-partitioned event data that needs both fast ingestion of streaming rollups and sub-second ad-hoc OLAP queries with roaring-bitmap indexes for filters like geo or device. ClickHouse is a very reasonable alternative with similar strengths and would be a fine answer too; BigQuery or a general data warehouse is better suited to the batch/T+1 side (it's what Spark could write into) than to serving a sub-200ms live dashboard, since warehouse query latency is typically seconds, not milliseconds.",
      },
      {
        q: "How do you reprocess historical data if the aggregation logic changes (a bug fix in dedup rules)?",
        a: "This is exactly why the raw click log in S3 is kept immutable and retained for a year — it's the replayable source of truth, independent of any bug in the aggregation logic that consumed it previously. A backfill job (the same Spark logic, corrected) reprocesses the affected date range from S3 and overwrites the corresponding partitions in the Druid historical datasource; because Druid supports atomic segment replacement, the corrected numbers can replace the old ones without a visible gap or double-counting in the meantime.",
      },
      {
        q: "Why key Kafka partitions by ad_id instead of campaign_id or a random key?",
        a: "Partitioning by ad_id keeps all of one ad's clicks in order on a single partition, which Flink's keyed windowed state needs to compute a correct per-ad count without cross-partition coordination — a random key would scatter one ad's clicks across every partition and require an expensive shuffle before aggregation. Campaign_id would work similarly but is coarser (fewer, hotter keys, since one campaign spans many ads), which worsens the skew problem rather than helping it; ad_id gives the finer-grained, more evenly distributed key that the salting fix in the hot-ad case builds on top of.",
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
          "This is a streaming aggregation pipeline where the numbers being aggregated are money. Every design decision downstream of that fact — three layers of dedup, event-time windowing, a deliberately duplicated real-time-vs-reconciled pipeline — exists because a click isn't just a data point, it's a line item on an invoice.",
          "Anchor everything on the core numbers: 50K clicks/sec sustained, 200K/sec peak, 10M active ads, sub-1-minute dashboard freshness, and zero double-count/loss on the T+1 billing number. Every structural choice below is a consequence of these numbers and that one fact, not a preference for a particular tech stack.",
        ],
      },
      {
        heading: "Sizing and the cardinality trap",
        body: [
          "200K clicks/sec peak rules out any single-writer design and motivates partitioning by ad_id across roughly 200 Kafka partitions, each carrying about 1K clicks/sec. The less obvious risk is cardinality: 10M ads × 1,440 minutes/day is 14.4B potential aggregation keys per day if every combination were pre-allocated, when in reality only a small fraction of ads get clicked in any given minute.",
          "The fix is choosing a fixed 1-minute base aggregation grain and only materializing a key on its first click, letting the OLAP layer's rollup handle coarser views (hourly, daily) at query time rather than pre-computing every granularity. Raw storage lands around 860GB/day uncompressed, roughly 250GB/day as Parquet — the number that sizes both S3 retention and the nightly batch job.",
        ],
      },
      {
        heading: "Exactly-once counting: three layers, three failure modes",
        body: [
          "Because clicks drive billing, 'close enough' dedup is a financial bug. Duplicates enter at three independent layers and each needs its own defense: a client-side retry is caught by a click-id idempotency key checked against Redis (10-minute TTL); a Flink restart mid-window is caught by checkpointed exactly-once state and a transactional sink, which guarantees each event affects the aggregate exactly once even across a crash; and bot replay is caught by rate limits applied before a click is credited toward spend, while still being logged raw for later fraud analysis.",
          "No single mechanism covers all three — a cache alone misses pipeline restarts, and checkpointing alone misses bot replay — so the design deliberately stacks all three rather than picking one.",
        ],
      },
      {
        heading: "Event time and watermarks",
        body: [
          "Mobile clicks can be delayed in-flight by seconds to minutes, so aggregation windows on the event's own embedded timestamp rather than server-arrival time, keeping delayed clicks in their true minute bucket. A watermark — the maximum observed event time minus a 5-minute allowed lateness — decides when a window is considered done and emits its result; waiting indefinitely for every possible straggler would mean windows never close and the dashboard never updates.",
          "Events that arrive after their window's watermark has already passed are routed to a side output rather than silently reopening a closed aggregate. They aren't lost — they're folded into the T+1 batch reconciliation, which has no such deadline.",
        ],
      },
      {
        heading: "Two-tier accuracy: the resolution, not an afterthought",
        body: [
          "Freshness and exactness are in tension: making the streaming path wait long enough to guarantee completeness would sacrifice the sub-minute freshness that makes it useful for a live dashboard. So the design runs two pipelines deliberately. The streaming path (Flink → Druid real-time) is fast but provisional, using HyperLogLog for approximate unique counts where exactness isn't worth the memory. The batch path (S3 → Spark → Druid historical) re-reads the complete, immutable raw log the next day with no time pressure, applying final deterministic dedup and fraud rules — its output is the number that actually generates the invoice.",
          "This split has a UI consequence, not just a backend one: the dashboard must visibly label the real-time number as an estimate, or advertisers will dispute an invoice that doesn't match the live number they watched earlier.",
        ],
      },
      {
        heading: "Hot ads, and why Kafka/Flink/Druid over a plain database",
        body: [
          "A single viral ad can send a disproportionate share of traffic to one ad_id-keyed partition and Flink subtask, since both key on the same field. The fix is a salted key (ad_id#shard) that spreads a hot ad's clicks across N partitions, followed by a cheap combine stage that sums the N partial counts back into one true per-ad total — the streaming equivalent of a map-side combiner.",
          "The overall stack choice — Kafka, Flink, Druid, instead of an OLTP database with per-click UPDATE counters — exists because that naive approach serializes on row locks for hot ads at this throughput. Kafka decouples bursty ingestion from steadier downstream processing; Flink provides stateful, exactly-once windowed aggregation that a plain consumer loop doesn't give for free; and Druid's native rollups and bitmap indexes make multi-dimensional dashboard queries fast without scanning raw events at read time.",
        ],
      },
    ],
  },
};
