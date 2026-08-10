import type { Problem } from "@/lib/types";

export const youtubeTopK: Problem = {
  slug: "youtube-top-k",
  num: "2.8",
  title: "Design YouTube Top K",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design the system behind YouTube's trending shelf: turn a firehose of ~60K view events/sec (peaking near 300K/sec during viral or live moments) into ranked top-K lists of videos per region, per category, and per sliding time window (last 1 hour, last 24 hours), refreshed within 60 seconds, across roughly 400 concurrent leaderboards.",
  ],
  hardParts:
    "The hard parts: maintaining an approximate top-K over a video catalog too large to keep an exact counter per video, keeping that top-K correct over sliding time windows instead of lifetime totals, and merging per-shard approximations into one globally-correct ranking without recreating a single point of contention.",
  keyTopics: [
    "Count-Min Sketch & Heavy Hitters",
    "Distributed Top-K Merge",
    "Sliding Time-Window Buckets",
    "Kafka Partitioning Strategy",
    "Lambda Architecture (Speed + Batch)",
  ],
  foundationsReferenced: [
    { label: "Count-Min Sketch", tone: "purple" },
    { label: "Kafka Partitioning", tone: "orange" },
    { label: "Flink Windowing", tone: "orange" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Redis / Valkey Sorted Sets", tone: "purple" },
    { label: "Lambda Architecture", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "watches + browses", col: 1, row: 2, tone: "slate" },
      { id: "cdn", label: "CDN", sub: "~40% hit, 30s TTL", col: 2, row: 1, tone: "green" },
      {
        id: "trending_api",
        label: "Trending API",
        sub: "stateless · reads leaderboard",
        col: 3,
        row: 1,
        tone: "green",
      },
      {
        id: "valkey",
        label: "Valkey ZSETs",
        sub: "top-K per region×category×window",
        mono: "~400 leaderboards · ZREVRANGE",
        col: 4,
        row: 1,
        tone: "purple",
      },
      {
        id: "ingest_api",
        label: "Ingest API",
        sub: "validate + dedupe",
        mono: "Bloom filter, 30s cooldown",
        col: 2,
        row: 3,
        tone: "green",
      },
      { id: "kafka", label: "Kafka", sub: "view-events · 256 partitions", col: 3, row: 3, tone: "orange" },
      {
        id: "flink",
        label: "Flink",
        sub: "per-shard CMS + heavy-hitters",
        mono: "1-min tumbling windows",
        col: 4,
        row: 3,
        tone: "orange",
      },
      {
        id: "merger",
        label: "Merge Job",
        sub: "union shard candidates",
        mono: "~30s cadence",
        col: 5,
        row: 3,
        tone: "orange",
      },
      { id: "lake", label: "S3 Data Lake", sub: "raw event archive", col: 5, row: 4, tone: "blue" },
      { id: "spark", label: "Spark Batch", sub: "hourly exact reconciliation", col: 3, row: 4, tone: "blue" },
    ],
    edges: [
      { from: "client", to: "cdn", label: "GET /trending", kind: "read" },
      { from: "cdn", to: "trending_api", label: "miss", kind: "read" },
      { from: "trending_api", to: "valkey", label: "ZREVRANGE top-K", kind: "read" },
      { from: "client", to: "ingest_api", label: "view event · ~60K/s avg, 300K/s peak", kind: "write" },
      { from: "ingest_api", to: "kafka", label: "validated events", kind: "write" },
      { from: "kafka", to: "flink", label: "consume, partitioned", kind: "analytics" },
      { from: "flink", to: "merger", label: "per-shard candidates (~2K each)", kind: "analytics" },
      { from: "merger", to: "valkey", label: "write ranked top-K", kind: "analytics" },
      { from: "kafka", to: "lake", label: "S3 sink connector", kind: "analytics" },
      { from: "lake", to: "spark", label: "hourly batch job", kind: "analytics" },
      { from: "spark", to: "valkey", label: "reconciled exact counts", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · 50K trending reads/s" },
      { kind: "write", text: "write path · up to 300K view events/s" },
      { kind: "analytics", text: "analytics · async, never blocks a view event or a read" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "ingest_api", "kafka"],
      say: "Start with the write skeleton: a client's view event hits a stateless Ingest API, gets validated and deduped, then durably lands in Kafka. That's the entire synchronous write path — up to 300K/s — and nothing downstream of Kafka can ever block it.",
    },
    {
      reveal: ["cdn", "trending_api", "valkey"],
      say: "Reads go the other direction: a trending-page request hits the CDN first, falls through to a stateless Trending API on a miss, which does one ZREVRANGE against a precomputed Valkey ZSET. No aggregation ever happens on a read.",
    },
    {
      reveal: ["flink", "merger"],
      say: "Kafka fans out to Flink, which keeps a fixed-size Count-Min Sketch and heavy-hitters candidate list per shard per 1-minute bucket. A Merge Job unions every shard's over-fetched candidates into one correct global ranking every ~30s and writes it straight into that same Valkey ZSET.",
    },
    {
      reveal: ["lake", "spark"],
      say: "Kafka also sinks raw events into an S3 data lake. Every completed hour, a Spark batch job recomputes exact counts from that archive and overwrites the approximate leaderboard in Valkey — freshness from the speed layer, correctness from the batch layer.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Return the current top K trending videos globally, refreshed near-real-time", tag: "P0" },
      { id: "FR-02", text: "Return top K trending videos scoped to a region (country/locale)", tag: "P0" },
      { id: "FR-03", text: "Return top K trending videos scoped to a category (Music, Gaming, News, ...)", tag: "P0" },
      { id: "FR-04", text: "Support combined region + category filters (e.g., \"Gaming in India\")", tag: "P1" },
      { id: "FR-05", text: "Support multiple sliding time windows: last 1 hour and last 24 hours", tag: "P0" },
      { id: "FR-06", text: "Filter out fraudulent or bot-driven views before they count toward ranking", tag: "P0" },
      { id: "FR-07", text: "A new video must be able to enter a trending list within minutes of receiving views", tag: "P1" },
      { id: "FR-08", text: "Periodically reconcile approximate counts against exact counts computed from raw logs", tag: "P1" },
      { id: "FR-09", text: "Support K up to 1000 per leaderboard, paginated in the API", tag: "P2" },
      { id: "FR-10", text: "Expose an internal read API so recommendations/home-page services can query current leaderboards", tag: "P1" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Trending-page read latency, cache hit, server-side", tag: "p99 < 50ms" },
      { id: "NFR-02", text: "Leaderboard freshness: view event to a visible rank change", tag: "< 60s" },
      { id: "NFR-03", text: "Sustained view-event ingest throughput, peak", tag: "300K/sec" },
      { id: "NFR-04", text: "Count accuracy vs. exact ground truth (approximate layer)", tag: "within ~1%" },
      { id: "NFR-05", text: "Availability of the trending read path", tag: "99.95%" },
      { id: "NFR-06", text: "Concurrently maintained leaderboards (region × category + global)", tag: "~400" },
      { id: "NFR-07", text: "Leaderboard read throughput, sustained", tag: "50K/sec" },
      { id: "NFR-08", text: "Batch reconciliation lag behind wall clock", tag: "< 90 min" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why you can't just keep an exact counter per video",
      body: [
        "The obvious first idea is one counter per (region, category, video) touched in a window. The problem is cardinality: the number of distinct videos that get any view in a given window is unbounded and spikes unpredictably — a live sporting event or a viral clip can 10x the distinct-video count in a single minute. Sizing an exact hashmap for that means sizing for a worst case you can't bound in advance.",
        "A Count-Min Sketch flips the trade: instead of one entry per key, it's a fixed w×d grid of counters (say width 2048, depth 7, about 56KB) per shard per 1-minute bucket. Its memory is constant no matter how many distinct videos show up that minute. You give up exactness for a small, bounded over-count error in exchange for a hard, predictable memory ceiling — across roughly 256 stream shards and ~84 live buckets (60 one-minute buckets for the 1h window plus 24 hourly rollups for the 24h window), that's about 1.2GB cluster-wide, comfortably inside Flink's managed state.",
      ],
      bullets: [
        { lead: "Exact hashmap", text: "one counter per (region, category, video) touched in the window. Memory grows with however many distinct videos got a view — during a viral live event that cardinality spikes unpredictably, so you'd have to provision for a worst case you can't bound." },
        { lead: "Count-Min Sketch", text: "a fixed w×d grid of counters (width ~2048, depth 7, ≈56KB) per shard per 1-minute bucket. Memory is constant no matter how many distinct videos appear that minute — you trade a small, bounded over-count error for a hard memory ceiling." },
        { lead: "Per-cluster footprint", text: "256 stream shards × ~84 live buckets (60 one-minute buckets for the 1h window, 24 rolled-up hourly buckets for the 24h window) × 56KB ≈ 1.2GB, comfortably inside Flink's managed state." },
      ],
      pictureTitle: "Exact counters vs. a fixed-size sketch",
      pictureRows: [
        { label: "Exact per-video hashmap", value: "grows unbounded with distinct videos seen", tone: "bad" },
        { label: "Count-Min Sketch (w=2048, d=7)", value: "~56KB, fixed regardless of cardinality", tone: "good" },
        { label: "Cluster-wide footprint", value: "256 shards × ~84 buckets ≈ 1.2GB", tone: "good" },
      ],
      remember: {
        problem: "Can you keep one exact counter per video per leaderboard-window?",
        solution: "No — use a fixed-size Count-Min Sketch per shard per time bucket instead of an unbounded exact hashmap.",
        why: "CMS memory is constant regardless of how many distinct videos appear; an exact hashmap's memory scales with cardinality, which spikes unpredictably during viral events.",
        tradeoff: "You accept a small, bounded over-count error in exchange for a hard, predictable memory ceiling.",
        failure: "Sizing an exact hashmap for 'normal' cardinality gets blown out the first time a live event or viral clip 10x's the distinct-video count in a bucket.",
        mitigation: "Fix the sketch dimensions from an (ε, δ) error target up front, independent of traffic, and monitor actual error against that target.",
      },
    },
    {
      n: 2,
      title: "Killing three designs for global top-K, keeping one",
      body: [
        "Every shard sees only a slice of the traffic, so the real question is how per-shard views become one globally-correct ranking. Put four candidates on the board and rule out three of them.",
      ],
      bullets: [
        { lead: "Single global counter (Redis INCR per video)", text: "every view for a hot video becomes a write to the same key from every shard — a viral video creates a hot-key bottleneck on one Redis node, and you still haven't solved windowing or the region×category cross-product. Rejected." },
        { lead: "Recompute top-K by sorting raw logs on demand", text: "scanning billions of raw events per leaderboard per refresh is far too slow for a <60s freshness target, and it gets slower exactly when traffic — and interest in trending — is highest. Rejected." },
        { lead: "Each shard reports only its own local top-K", text: "a video ranked #1 on every shard with modest counts can beat a video that's #1 on only two shards with huge counts — but a video that's just below each shard's local cutoff everywhere can also be globally huge and never surface. Local top-K alone is provably not enough. Rejected." },
        { lead: "Each shard over-fetches (top ~2K, not top K) + a merge step", text: "every shard emits candidates well beyond what it needs for its own ranking; a merge job unions these candidate sets, re-sums each candidate's estimated count across every shard's sketch, and only then sorts. As long as the over-fetch factor is large enough relative to the true skew, the true top-K is guaranteed to land in the union. Winner." },
      ],
      pictureTitle: "Distributed top-K: kill three, keep one",
      pictureRows: [
        { label: "Global Redis INCR per video", value: "hot-key bottleneck on viral videos", tone: "bad" },
        { label: "Recompute from raw logs", value: "too slow for <60s freshness", tone: "bad" },
        { label: "Local top-K per shard, no merge", value: "provably misses some true winners", tone: "bad" },
        { label: "Over-fetch (~2K) + merge across shards", value: "WINNER", tone: "good" },
      ],
      remember: {
        problem: "How do per-shard rankings become one correct global top-K?",
        solution: "Each shard emits a generously over-sized candidate list (~2K, not just top K); a merge job unions the lists, re-sums each candidate across every shard, then sorts.",
        why: "A video's true global rank can't be determined from any single shard's local top-K alone — it can be just under the cutoff everywhere and still be a true winner overall.",
        tradeoff: "Over-fetching costs extra network and CPU in the merge step to buy a correctness guarantee that plain local top-K can't give.",
        failure: "Trusting each shard's local top-K directly silently drops legitimate trending videos that are 'moderately popular everywhere' rather than 'huge on one shard.'",
        mitigation: "Tune the over-fetch factor against observed traffic skew and alert if the merge job's candidate set stops changing rank order between refreshes (a sign the factor is too small).",
      },
    },
    {
      n: 3,
      title: "Sliding windows via time-bucket rollups",
      body: [
        "Trending needs a window, not a lifetime score. A single ever-incrementing counter per video would never let old popularity decay — a video that got 10M views two months ago would still outrank today's clips forever. Sketches solve this the same way they solve merging: they're mergeable, so windowing is cheap arithmetic on rolled-up buckets instead of rescanning history.",
      ],
      bullets: [
        { lead: "Why not one running total", text: "a single ever-incrementing counter per video never lets old popularity decay — a video that got 10M views two months ago would still outrank today's trending clips forever. Trending needs a window, not a lifetime score." },
        { lead: "1-minute tumbling buckets", text: "each shard closes out a fresh CMS + candidate list every 60 seconds. The 1-hour window is the sum of the last 60 closed buckets." },
        { lead: "Hourly rollups for 24h", text: "keeping 1,440 one-minute buckets alive for a day is wasteful; instead, every 60 one-minute buckets get merged (sketches are mergeable — summing two CMS grids of the same dimensions gives the sketch of the union) into one hourly bucket, and the 24-hour window sums the last 24 of those." },
        { lead: "Sliding, not tumbling, at read time", text: "the window itself slides every minute (drop the oldest bucket, add the newest) even though the underlying buckets are tumbling and fixed — that's what makes 'last 1 hour' actually mean the last 60 minutes, not a fixed clock hour." },
      ],
      pictureTitle: "1h and 24h windows from rolled-up buckets",
      pictureRows: [
        { label: "1h window", value: "sum of last 60 one-minute buckets", tone: "neutral" },
        { label: "24h window", value: "sum of last 24 hourly-rolled-up buckets", tone: "neutral" },
        { label: "Old bucket expires", value: "drops out automatically, no decay logic needed", tone: "good" },
      ],
      remember: {
        problem: "Rank by recent popularity, not lifetime views, without rescanning history.",
        solution: "Fixed-size tumbling buckets (1-minute) that mergeable sketches roll up into hourly buckets; windows are the sum of the last N live buckets.",
        why: "Sketches are mergeable by construction (summing two same-shaped CMS grids yields the CMS of the combined stream), so rollups are cheap arithmetic, not recomputation.",
        tradeoff: "You lose sub-minute precision on exactly when a bucket's views happened, which is fine for a trending ranking.",
        failure: "A single lifetime running counter never lets old hits fall off the list, so trending degenerates into 'all-time popular.'",
        mitigation: "Expire the oldest bucket every time a new one closes; the window width is enforced by bucket count, not by per-event timestamps.",
      },
    },
    {
      n: 4,
      title: "The merge job and why serving stays cheap",
      body: [
        "Aggregation and serving are deliberately separate jobs. The merge/re-rank runs on a fixed cadence in the background; the read path never aggregates anything, it just returns whatever the last merge cycle produced.",
      ],
      bullets: [
        { lead: "Merge job, not merge-on-read", text: "the merge/re-rank runs on a fixed ~30s cadence in the background and writes a finished ranked list into Valkey; the read path never does any aggregation, it's a single ZREVRANGE against a precomputed sorted set." },
        { lead: "Valkey ZSET per leaderboard", text: "one sorted set per (region, category, window) — about 400 of them — each capped at ~1000 members. Total footprint across all leaderboards is tens of megabytes, trivially cheap once the heavy lifting happened upstream." },
        { lead: "Freshness and cache TTL are the same number", text: "CDN-caching the trending page for 30s and refreshing the merge job every 30s means the cache never serves data staler than the pipeline itself produces — the two numbers are chosen together, not independently." },
      ],
      pictureTitle: "Serving is cheap because aggregation already happened",
      pictureRows: [
        { label: "Merge job", value: "runs every ~30s, writes ranked lists", tone: "neutral" },
        { label: "Valkey ZSET read", value: "ZREVRANGE, O(log N + K), no aggregation on read", tone: "good" },
        { label: "~400 leaderboards, ~1000 members each", value: "tens of MB total", tone: "good" },
      ],
      remember: {
        problem: "Serve 50K trending reads/sec without redoing aggregation per request.",
        solution: "A background merge job writes a precomputed, ranked Valkey ZSET per leaderboard; reads are a single ZREVRANGE.",
        why: "Precomputing on a fixed cadence means read latency is decoupled from how expensive the aggregation was to produce.",
        tradeoff: "Reads are only as fresh as the last merge cycle — you're trading true real-time for cheap, predictable read latency.",
        failure: "Aggregating on every read would mean the trending page gets slower exactly when it's most popular, since viral moments drive both view volume and page views.",
        mitigation: "Match the CDN cache TTL to the merge cadence so the two staleness sources don't compound.",
      },
    },
    {
      n: 5,
      title: "Fraud and bot filtering at ingest, not after",
      body: [
        "Trending is a visibility mechanism — anyone who can cheaply inflate a view count can buy their way onto the homepage. Filtering has to happen before an event reaches the sketches, because a sketch that already absorbed fraudulent events can't cleanly un-absorb them.",
      ],
      bullets: [
        { lead: "Why this can't be an afterthought", text: "trending is a visibility mechanism — anyone who can cheaply inflate a view count can buy their way onto the homepage. Filtering has to happen before an event reaches the sketches, because a sketch that already absorbed fraudulent events can't cleanly un-absorb them." },
        { lead: "Per-(user, video) cooldown", text: "a Bloom filter (or short-TTL cache entry) at the Ingest API suppresses repeat views from the same viewer/session within a rolling window (tens of seconds), so refresh-spamming a single video doesn't multiply its count." },
        { lead: "Coarser signals, out of scope here", text: "IP-reputation, device-fingerprint, and behavioral bot detection live in a separate anti-abuse service upstream of ingest; this system's job is to trust that upstream verdict and apply only the dedupe/cooldown layer, not to reimplement fraud detection." },
        { lead: "Trending counts ≠ official view counts", text: "the counts feeding this system are tuned for ranking robustness, not billing or the number shown on the watch page — those have their own, stricter pipeline. Say this explicitly so the interviewer doesn't think you're conflating the two." },
      ],
      pictureTitle: "Where fraud filtering has to sit",
      pictureRows: [
        { label: "Filter before Kafka (ingest)", value: "bad events never reach the sketches", tone: "good" },
        { label: "Filter after aggregation", value: "can't cleanly subtract an already-merged sketch", tone: "bad" },
        { label: "Trending counts", value: "separate from monetized/official view counts", tone: "neutral" },
      ],
      remember: {
        problem: "Stop fraudulent views from gaming the trending list.",
        solution: "Dedupe/cooldown per (user, video) at the Ingest API, before events reach Kafka or the sketches; rely on an upstream anti-abuse service for harder signals.",
        why: "Sketches can't be cleanly un-absorbed once polluted, so filtering has to happen before aggregation, not after.",
        tradeoff: "A short cooldown window can also suppress a small number of legitimate rapid rewatches, a deliberate false-positive trade.",
        failure: "Filtering only at read time, or relying purely on after-the-fact volume anomaly detection, lets a coordinated view-bot ride a video onto trending before anyone notices.",
        mitigation: "Keep dedupe/cooldown cheap and synchronous at ingest, and treat trending's view counts as intentionally separate from the stricter, slower official view-count pipeline.",
      },
    },
    {
      n: 6,
      title: "Lambda architecture: speed layer meets batch layer",
      body: [
        "CMS and heavy-hitters both have a bounded but nonzero error, and the merge job's over-fetch factor is tuned against expected skew, not proven for every adversarial traffic pattern. Left alone forever, small errors and edge cases accumulate — so a second, slower layer exists to catch them.",
      ],
      bullets: [
        { lead: "Why the sketch layer alone isn't enough", text: "CMS and heavy-hitters both have a bounded but nonzero error, and the merge job's over-fetch factor is tuned against expected skew, not proven for every adversarial traffic pattern. Left alone forever, small errors and edge cases accumulate." },
        { lead: "Speed layer", text: "Flink + sketches + the 30s merge job, optimized for freshness (<60s) at the cost of exactness." },
        { lead: "Batch layer", text: "every completed hour, a Spark job reads the raw, already-archived events for that hour from the S3 data lake and computes exact top-K, then overwrites the approximate result for that window in Valkey." },
        { lead: "Two layers, one output surface", text: "the Trending API never knows which layer produced a given leaderboard's current numbers — the client-facing contract is just 'a ranked list', with speed-layer freshness upgraded to batch-layer exactness roughly an hour later." },
      ],
      pictureTitle: "Speed layer for freshness, batch layer for correctness",
      pictureRows: [
        { label: "Speed layer (Flink + sketches)", value: "<60s fresh, ~1% error", tone: "used" },
        { label: "Batch layer (Spark, hourly)", value: "exact, arrives ~60-90 min later", tone: "good" },
        { label: "Serving layer (Valkey)", value: "always serves whichever is freshest so far", tone: "neutral" },
      ],
      remember: {
        problem: "Approximate counts drift; exact recomputation is too slow to be the primary path.",
        solution: "Lambda architecture: a fast approximate speed layer serves live traffic, a slower exact batch layer reconciles each completed window afterward.",
        why: "Freshness and exactness pull in opposite directions; running both lets each layer optimize for one.",
        tradeoff: "The system briefly (for ~60-90 minutes) serves numbers it knows are approximate, and needs two code paths that must agree on schema.",
        failure: "Running only the speed layer means small sketch errors and edge-case bugs compound silently forever with no ground-truth check.",
        mitigation: "Always overwrite the approximate leaderboard with the batch job's exact result once it's ready, and alert if the two ever diverge past the sketch's stated error bound.",
      },
    },
    {
      n: 7,
      title: "Partitioning: what should the Kafka key be?",
      body: [
        "The write path's sharding key shapes everything downstream. Partition by video_id and one video's events always land together, which sounds simpler — until a viral video means one partition (and one Flink task) absorbs a disproportionate share of the 300K/sec peak, recreating the exact hot-key problem sharding was supposed to solve. Partition randomly and load spreads evenly, but now no shard alone has the true count for anything, which is precisely why the merge-based design from Teardown 2 has to exist.",
      ],
      bullets: [
        { lead: "Partition by video_id", text: "keeps one video's full count in one partition — but a viral video means one partition (and one Flink task) absorbs a disproportionate share of the 300K/sec peak, recreating the exact hot-key problem sharding was supposed to solve." },
        { lead: "Partition randomly (by event_id)", text: "spreads every video's events evenly across all 256 partitions regardless of popularity, so no single shard is ever the bottleneck — but now no single shard has the true count for anything, which is exactly why the merge-across-shards design (Teardown 2) exists." },
        { lead: "The two choices are coupled", text: "random partitioning is only viable because the merge job is designed to handle it; if you partitioned by video_id you wouldn't need the over-fetch-and-merge trick at all, but you'd be back to unbounded per-partition hot-key risk. Say this connection explicitly — it shows the two decisions were made together." },
      ],
      pictureTitle: "Partition key: trade hot-key risk for merge complexity",
      pictureRows: [
        { label: "Partition by video_id", value: "simple counting, but viral = hot partition", tone: "bad" },
        { label: "Partition randomly (event_id)", value: "even load, but requires cross-shard merge", tone: "good" },
      ],
      remember: {
        problem: "Choose a Kafka partition key when a small number of videos can dominate traffic.",
        solution: "Partition randomly by event_id, not by video_id, and rely on the merge-based top-K design to reassemble per-video totals.",
        why: "Video popularity is Zipfian — partitioning by video_id turns 'this video went viral' directly into 'this one partition is overloaded.'",
        tradeoff: "Random partitioning means no single shard ever has an exact count for any video, which is exactly why the sketch + merge machinery from Teardown 2 has to exist.",
        failure: "Partitioning by video_id looks simpler until the first viral moment saturates one Flink task while the other 255 sit idle.",
        mitigation: "Partition randomly, size the merge job's over-fetch factor for the real traffic skew, and monitor per-partition load to confirm it stays flat under a viral spike.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a streaming aggregation problem, not a database problem: turn a firehose of view events into ranked top-K lists per region, category, and time window, without ever storing an exact counter per video.",
      "Count-Min Sketch and Space-Saving heavy-hitters give a fixed memory footprint per shard per time bucket, no matter how many distinct videos show up — the accuracy is bounded, not exact.",
      "Sliding 1-hour and 24-hour windows come from summing rolled-up 1-minute and 1-hour buckets, not from a lifetime running total or a rescan of raw history.",
      "A background merge job (every ~30s) unions each shard's over-fetched candidate list into one correct global ranking and writes it into a precomputed Valkey ZSET, so reads are a single ZREVRANGE.",
      "An hourly Spark batch job recomputes exact counts from the raw archive and overwrites the approximate result — freshness from the speed layer, correctness from the batch layer.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 50K/S · P99 < 50MS",
        summary:
          "A trending-page load hits the CDN first. On a miss, the Trending API does a single lookup against a precomputed, already-ranked leaderboard — no aggregation ever happens on the read path.",
        steps: [
          { label: "Client", note: "opens the trending shelf" },
          { label: "CDN", note: "~40% hit, 30s TTL matched to merge cadence" },
          { label: "Trending API", note: "stateless" },
          { label: "Valkey ZSET", note: "ZREVRANGE region×category×window" },
          { label: "Response", note: "ranked list, no server-side aggregation" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · UP TO 300K/S",
        summary:
          "A view event is validated and deduped, then durably lands in Kafka. Nothing synchronous happens beyond that — all ranking logic lives off this path.",
        steps: [
          { label: "Client", note: "emits a view event" },
          { label: "Ingest API", note: "Bloom-filter cooldown, per (user, video)" },
          { label: "Kafka", note: "256 partitions, keyed randomly by event_id" },
        ],
      },
      {
        kind: "analytics",
        title: "ANALYTICS · SPEED LAYER (~30S) + BATCH LAYER (~HOURLY)",
        summary:
          "Two layers reconcile into the same store. Flink keeps things fresh with bounded-error sketches; Spark periodically overwrites with the exact answer.",
        steps: [
          { label: "Kafka", note: "view-events, partitioned randomly by event_id" },
          { label: "Flink", note: "per-shard CMS + heavy-hitters, 1-min tumbling buckets" },
          { label: "Merge Job", note: "unions ~2K candidates/shard, ~30s cadence" },
          { label: "Valkey ZSET", note: "writes ranked top-K per leaderboard" },
          { label: "S3 Data Lake", note: "Kafka sink archives raw events" },
          { label: "Spark Batch", note: "hourly job overwrites with exact counts" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "~60K views/sec average, ~300K/sec peak (viral/live events)",
          "~400 leaderboards: ~20 regions × ~20 categories, plus global",
          "Windows: last 1h (60×1-min buckets) and last 24h (24×1h rolled-up buckets)",
          "CMS per shard per bucket: width 2048 × depth 7 ≈ 56KB; ~256 shards × ~84 live buckets ≈ 1.2GB cluster-wide",
          "Merge cadence ~30s; CDN cache TTL matched to 30s",
          "Read: ~50K/sec, p99 < 50ms on a precomputed ZSET",
          "Batch reconciliation lag: ~60-90 min behind wall clock",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Count-Min Sketch + Space-Saving heavy-hitters, not exact per-video counters",
          "Kafka partitioned randomly by event_id, not by video_id, to avoid viral hot partitions",
          "Each shard over-fetches (~2K candidates), merge job unions + re-sums before ranking",
          "Sliding windows from mergeable, rolled-up fixed buckets, not a lifetime counter",
          "Fraud/dedupe cooldown at ingest, before events reach the sketches",
          "Lambda architecture: Flink speed layer + hourly Spark batch layer reconciling into the same Valkey ZSETs",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Local per-shard top-K alone is provably insufficient for global top-K — that's the whole reason the merge step exists",
          "The skew assumption is load-bearing twice: it's why random partitioning doesn't need per-video hot-key handling, and why the over-fetch factor is tunable, not worst-case-proof",
          "Trending counts are deliberately separate from official/monetized view counts",
          "Freshness (speed layer) and correctness (batch layer) are different layers, not different bugs to fix in one system",
          "Read path is dumb on purpose: aggregation already happened, so serving is a single ZREVRANGE",
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
      goal: "Pin down the ranking signal, the breakdown dimensions, and five numbers before drawing anything.",
      why: "This system has a lot of moving parts, and every one of them (sketch size, shard count, merge cadence) falls out of a small set of numbers and product decisions. Locking them first keeps the rest of the interview from becoming guesswork.",
      steps: [
        { kind: "ASK", text: '**What signal are we ranking by — raw view count, watch time, or an engagement score?** Land on "raw view count" as the primary signal for this design, and note that watch-time/engagement weighting is a drop-in generalization (same sketches, weighted increments) you can mention later if there\'s time.' },
        { kind: "ASK", text: '**Global-only, or region and category breakdowns too?** Land on "yes to both, and combinations of the two" — that\'s what turns this into a fan-out of leaderboards, not just one.' },
        { kind: "SAY", text: 'Propose the windows yourself: **"last 1 hour"** and **"last 24 hours"**, refreshed near-real-time, not truly instant. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "ingest, approximate counting, windowing, ranking, serving". Out: "personalized recommendations, engagement-weighted scoring, the monetized/official view-count pipeline". "I\'ll flag if any of those matter for what you want to probe."' },
        { kind: "WRITE", text: 'Put the five numbers on the board: **"~60K views/sec avg, ~300K/sec peak"**, **"~400 leaderboards (region × category + global)"**, **"top 1000 per leaderboard"**, **"<60s freshness"**, **"50K reads/sec"**.' },
      ],
      grading: "Senior judgment. Are the ranking signal, breakdown dimensions, and five core numbers all pinned on the board before any box gets drawn?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two endpoints, one event schema, and an explicit statement that there is no per-video row anywhere in this system.",
      why: "The interviewer wants to see you commit to a streaming shape instead of reaching for CRUD. Naming the partition key here (event_id, not video_id) up front also sets up the deep dive without derailing it.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /view { videoId, userId, region, category, ts }"** (fire-and-forget, called by playback clients), **"GET /trending?region=&category=&window=1h|24h&k=200"** returns a ranked list.' },
        { kind: "DRAW", text: 'Sketch the view event: **"video_id, user_id, region, category, event_id, ts"**. Say out loud: "event_id is what I\'ll partition Kafka on, not video_id — that\'s a deliberate choice I\'ll justify in the deep dive."' },
        { kind: "SAY", text: 'Justify why there\'s no per-video row anywhere: "Nothing in this system stores a durable exact counter per video. The write path is a stream, the read path is a precomputed ranked list — there\'s no CRUD entity called Video Count."' },
        { kind: "RULE OUT", text: 'Get ahead of the obvious wrong answer: "A SQL table with a view_count column and an UPDATE ... SET view_count = view_count + 1 on every view would serialize writes to the same row per video and can\'t express sliding windows at all. Rejected before I even get to scale."' },
      ],
      grading: "Crisp endpoint names, an event schema (not a row schema), and an explicit rejection of the naive UPDATE-a-counter approach.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 8,
      goal: "One diagram with three labeled lanes: read, write, and the async analytics lane where all the ranking intelligence lives.",
      why: "Drawing analytics as its own lane, clearly off the critical path of both reads and writes, is the single most important structural signal in this design. It proves you know the write path just needs durability and the read path just needs a fast lookup.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → CDN → Trending API → Valkey ZSET. Label the arrow **"ZREVRANGE, top-K"**, not the boxes.' },
        { kind: "DRAW", text: 'Lay down the **write path**: Client → Ingest API → Kafka. Label it **"~300K/sec peak, validated + deduped"**.' },
        { kind: "DRAW", text: 'Add the **analytics/background lane**: Kafka → Flink (per-shard CMS + heavy-hitters) → Merge Job → Valkey, plus Kafka → S3 → Spark (hourly) → Valkey. Dashed, labeled **"async, ~30s and ~hourly cadences"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes, three different jobs: reads are latency-critical and dumb by design, writes are high-volume and just need to land durably, and the analytics lane is where all the actual ranking intelligence lives — off the critical path of both."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with throughput and cadence rather than box names, and an explicit statement that ranking logic never sits on the read or write path.",
    },
    {
      n: 4,
      title: "Deep Dive: Approximate Counting and the Merge Step",
      minutes: 10,
      goal: "Show the Count-Min Sketch, explain why local per-shard top-K fails, and defend the over-fetch-and-merge fix.",
      why: "This is the signature sub-problem. The interviewer is probing whether you understand that distributed top-K is not 'just merge the local top-Ks' and can quantify the memory trade-off of an approximate structure.",
      steps: [
        { kind: "SAY", text: 'Explain why exact per-video counters don\'t work: "The set of distinct videos touched in a window is unbounded and spikes during viral events — I want a data structure whose memory is fixed regardless of that cardinality."' },
        { kind: "DRAW", text: 'Sketch the CMS grid: **"width 2048 × depth 7 ≈ 56KB"**, one per shard per 1-minute bucket. "Bounded error, in exchange for a hard memory ceiling."' },
        { kind: "SAY", text: 'Explain the distributed top-K trap: "If each shard just reports its own local top-K and I merge those lists, I can silently miss a video that\'s moderately popular on every shard but never makes any single shard\'s local cutoff. Local top-K isn\'t globally correct."' },
        { kind: "SAY", text: 'Give the fix: "Each shard over-fetches — reports its top ~2K, not top K — and a merge job unions those candidate sets, re-sums each candidate across every shard\'s sketch, and only then ranks. The over-fetch factor is tuned against real traffic skew."' },
        { kind: "RULE OUT", text: '"A single global Redis INCR per video" → hot-key bottleneck the moment a video goes viral, and doesn\'t solve windowing either. Cross it off.' },
      ],
      grading: "The CMS dimensions on the board with a memory estimate, and the distributed top-K correctness gap named and fixed without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: Windows and Fraud",
      minutes: 7,
      goal: "Explain bucket rollups for sliding windows, then volunteer the fraud/dedupe layer and the trending-vs-official-count distinction.",
      why: "Anyone can say 'use a time window'. The interviewer wants the mergeable-bucket mechanism with numbers, plus the operational maturity to bring up fraud and scope boundaries before being asked.",
      steps: [
        { kind: "SAY", text: 'Explain bucket rollups: "1-minute tumbling buckets; the 1-hour window sums the last 60. Every 60 one-minute buckets merge into one hourly bucket — sketches are mergeable, so that\'s just addition — and the 24-hour window sums the last 24 of those."' },
        { kind: "SAY", text: 'State why not a lifetime counter: "A running total never lets old popularity decay, so a video from months ago would outrank everything current forever."' },
        { kind: "SAY", text: 'Cover fraud: "A per-(user, video) cooldown at the Ingest API, before events reach Kafka, suppresses refresh-spam. Anything past a basic dedupe — bot detection, IP reputation — I\'d push to an upstream anti-abuse service and just trust its verdict here."' },
        { kind: "SAY", text: 'Draw the scope line explicitly: "These are trending-ranking counts, not the official view count shown on the watch page or used for monetization — that\'s a separate, stricter pipeline."' },
      ],
      grading: "Bucket rollups explained mechanically (not just 'use a sliding window'), and fraud filtering plus the scope boundary volunteered without prompting.",
    },
    {
      n: 6,
      title: "Wrap: Batch Reconciliation, Trade-offs, and Close",
      minutes: 5,
      goal: "Name the Lambda architecture, connect the partitioning decision back to the merge design, push back once, and close cleanly.",
      why: "Staff-level signal here is seeing the whole system as a set of coupled decisions rather than a list of independent components — and closing with discipline instead of trailing off.",
      steps: [
        { kind: "SAY", text: 'Bring up the batch layer unprompted: "Sketches have bounded but nonzero error, so every completed hour a Spark job recomputes exact counts from the raw archive in S3 and overwrites the approximate leaderboard. That\'s a Lambda architecture — speed layer for freshness, batch layer for correctness."' },
        { kind: "SAY", text: 'Name the coupling: "We partition Kafka randomly, by event_id, specifically because the merge-based design can absorb that — if we\'d partitioned by video_id instead we wouldn\'t need the merge step, but we\'d be exposed to hot partitions on every viral video."' },
        { kind: "SAY", text: 'Push back where useful: "Does the trending shelf really need sub-minute freshness, or is a 60-second lag actually fine? That changes how aggressively I\'d tune the merge cadence versus cost."' },
        { kind: "SAY", text: 'Close in one sentence and list what\'s parked: "It\'s a streaming aggregation system — fixed-size approximate counters, mergeable sliding windows, and a batch layer for ground truth. With more time I\'d cover engagement-weighted ranking, personalization, and the official view-count pipeline."' },
      ],
      grading: "The Lambda architecture and the partitioning/merge coupling both stated explicitly, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a streaming design that mostly hangs together, but the approximate-counting and distributed-correctness pieces stay vague or absent.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Proposes a streaming pipeline (Kafka + a stream processor) instead of batch-recomputing from a database on every request.",
          "Knows a naive per-video counter table doesn't scale and reaches for 'some kind of cache' or 'a Redis sorted set' for the leaderboard.",
          "Understands the need for time windows, even if implemented as 'query WHERE timestamp > now - 1h' against raw events.",
          "Adds a queue between ingestion and processing when prompted.",
          "Recognizes that reads (trending page) should be served from a precomputed/cached structure, not computed live.",
        ],
        gaps: [
          "Doesn't know or reach for Count-Min Sketch / heavy-hitters; assumes an exact counter per video is fine until pushed on cardinality.",
          "Doesn't realize local per-shard top-K isn't globally correct — assumes 'just take the top-K from each shard and merge' without checking the guarantee.",
          "No plan for fraud/bot views; treats every event as legitimate.",
          "Windowing via raw-timestamp range queries doesn't scale and isn't volunteered as a problem.",
          "No distinction between a fast/approximate path and a slower/exact reconciliation path.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, reaches for the right approximate structures unprompted, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Reaches for Count-Min Sketch and/or Space-Saving heavy-hitters unprompted, and can explain the memory-vs-error trade-off in plain terms.",
          "Identifies that local per-shard top-K is not sufficient and proposes an over-fetch-and-merge scheme.",
          "Designs sliding windows via mergeable, rolled-up fixed buckets, not a lifetime counter or raw rescans.",
          "Chooses random/hashed Kafka partitioning specifically to avoid hot partitions from viral videos, and connects that choice to why merge-based aggregation is necessary.",
          "Separates the read path (precomputed Valkey ZSET) from the write/aggregation path clearly, with numbers for both.",
          "Adds a dedupe/cooldown layer at ingest for fraud.",
        ],
        gaps: [
          "Mentions batch reconciliation only if the interviewer asks 'what if the sketch drifts?' rather than volunteering it.",
          "Quantifies memory footprint in vague terms ('small') rather than doing the fixed-size-per-bucket math.",
          "Doesn't explicitly connect the partitioning-key choice to the hot-key/merge trade-off unless prompted.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats the design as a set of coupled decisions rather than independent components, and surfaces risk and scope before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the Lambda-architecture split (speed layer for freshness, batch layer for correctness) unprompted, and states the reconciliation lag as a number.",
          "Names the coupling between partition key choice and the merge-based design explicitly — 'we partition randomly *because* the merge step can handle it, and that's why we don't need per-video hot-key handling.'",
          "States the skew assumption underlying the over-fetch factor as a named, monitored risk, not an implicit hope.",
          "Explicitly separates trending counts from monetized/official view counts, heading off a scope-confusion question before it's asked.",
          "Matches cache TTL to merge cadence deliberately and explains why the two numbers are chosen together.",
          "Pushes back on requirements ('do we need per-minute freshness, or is 60s actually fine for a trending shelf?') and treats them as negotiable.",
          "Closes with a one-sentence system summary and a named list of what's out of scope (engagement-weighted ranking, personalization, official view counts).",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Proposing an exact counter (e.g., Redis INCR) per video as the primary counting mechanism without addressing cardinality or hot-key risk.",
      "Assuming each shard's local top-K can just be merged/concatenated into the global top-K without justification — this is provably wrong.",
      "Using a single lifetime running total instead of a real sliding window, so old popular videos never fall off trending.",
      "No fraud/bot filtering at all — treating every incoming view event as trustworthy.",
      "Aggregating on the read path (computing the leaderboard live per trending-page request) instead of precomputing it.",
      "Partitioning Kafka by video_id without acknowledging the hot-partition risk from viral content.",
      "No mention of accuracy/error bounds when using approximate structures — presenting sketch output as if it were exact.",
    ],
    followUps: [
      {
        q: "Why Count-Min Sketch instead of just tracking exact counts for the videos you already suspect are popular?",
        a: "Because you don't know in advance which videos will be popular — that's the whole point of trending. A sketch handles the full, unbounded key space with fixed memory regardless of which keys turn out to matter. Space-Saving/heavy-hitters is layered on top specifically to also track which keys are currently the candidates, not just to estimate the frequency of a key you've already decided to watch.",
      },
      {
        q: "What happens if the over-fetch factor in the merge step is too small?",
        a: "You silently miss true winners: a video that's moderately popular on every shard but never crosses any single shard's local cutoff simply never enters the candidate union, so it can't surface no matter how big its true global count is. The mitigation is to tune the factor against observed traffic skew, monitor for rank churn near the cutoff as an early warning, and let the hourly batch layer catch anything the speed layer missed.",
      },
      {
        q: "How would you rank by watch time or an engagement score instead of raw view count?",
        a: "The architecture doesn't change, only the increment. Count-Min Sketch supports arbitrary positive increments, not just +1 per event, so you'd add watch-time-in-seconds (or a computed engagement score) per event instead of counting occurrences. Heavy-hitters generalizes the same way. The ranking dimension changes; the sketching, windowing, and merge machinery stays identical.",
      },
      {
        q: "How do you handle a brand-new video that should trend fast?",
        a: "Fixed 1-minute buckets give visibility within a couple of minutes — there's no cold-start lag from a longer batch window, since the heavy-hitters candidate list picks up any video crossing the tracked threshold within the current bucket, with zero dependency on the video's history. A brand-new video is treated exactly the same as any other key; there's no separate 'new video' code path.",
      },
      {
        q: "What if two regions disagree on what's trending for the same video?",
        a: "They're independent leaderboards — region is part of the key, not something computed centrally and then split. Each region's leaderboard is aggregated purely over that region's own view events, so there's nothing to reconcile between them; a video can legitimately be #1 in one region and absent from another's top 1000.",
      },
      {
        q: "How would you extend this to detect why something is trending (velocity, not just volume)?",
        a: "Compare consecutive bucket counts instead of the absolute window sum — for example, rank by (count in the most recent 10 minutes) divided by (count in the prior 10 minutes) to surface acceleration. That's a different, secondary ranking signal layered on the same bucketed infrastructure; the buckets you already maintain for windowing are exactly what you need for a rate-of-change comparison.",
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
          "This is a streaming aggregation system with a side of serving, not a database problem. The core operation — resolve a firehose of view events into a ranked top-K per (region, category, window) — is fundamentally about bounding memory and coordination cost while approximating an answer that's fresh enough to be useful within seconds.",
          "Anchor everything on five numbers: ~60K views/sec average (~300K/sec peak), ~400 leaderboards, top 1000 per leaderboard, <60s freshness, and 50K reads/sec. Every structural choice below — sketch size, partition key, merge cadence — is a consequence of these numbers.",
        ],
      },
      {
        heading: "Sizing: why fixed-size sketches, not exact counters",
        body: [
          "An exact counter per (region, category, video) touched in a window has unbounded memory, because the number of distinct videos touched spikes unpredictably during viral or live events. A Count-Min Sketch trades that for a fixed w×d grid (width 2048, depth 7, ≈56KB) per shard per 1-minute bucket — memory constant regardless of cardinality, in exchange for a small, bounded over-count error.",
          "Across ~256 stream shards and ~84 live buckets (60 one-minute buckets for the 1h window, 24 hourly rollups for the 24h window), the whole cluster's sketch footprint lands around 1.2GB — trivial next to the alternative of an unbounded exact hashmap sized for a worst case you can't predict.",
        ],
      },
      {
        heading: "Partitioning and the distributed top-K problem",
        body: [
          "Kafka is partitioned randomly by event_id, not by video_id, specifically to avoid a viral video overwhelming a single partition and Flink task. That choice only works because the aggregation design tolerates it: since no single shard sees all of any video's events, local per-shard top-K is provably not the same as global top-K — a video can be moderately popular on every shard and never cross any single shard's local cutoff, yet still be a true global winner.",
          "The fix is over-fetch and merge: each shard reports a generous candidate list (~2K, not just top K), a merge job unions those lists across all shards, re-sums each candidate's estimated frequency, and only then ranks. The partitioning decision and the merge design were made together — you couldn't make one without the other.",
        ],
      },
      {
        heading: "Sliding windows from mergeable buckets",
        body: [
          "A lifetime running counter never lets old popularity decay, so trending needs real windows. 1-minute tumbling buckets close out per shard; the 1-hour window sums the last 60. Every 60 one-minute buckets roll up (via sketch mergeability — summing two same-shaped CMS grids yields the CMS of the combined stream) into an hourly bucket, and the 24-hour window sums the last 24 of those.",
          "The window slides every minute even though the underlying buckets are fixed and tumbling: drop the oldest, add the newest. That's what makes 'last 1 hour' mean the trailing 60 minutes rather than a fixed clock hour.",
        ],
      },
      {
        heading: "Serving, fraud, and the two-tier count model",
        body: [
          "A background merge job (~30s cadence) writes a finished, ranked list into a Valkey ZSET per leaderboard; the read path is a single ZREVRANGE, with CDN cache TTL matched to the merge cadence so the two staleness sources don't compound. Serving is cheap precisely because all the aggregation work already happened upstream.",
          "Fraud filtering — a per-(user, video) cooldown — sits at the Ingest API, before events reach Kafka or the sketches, because a sketch that's already absorbed fraudulent events can't be cleanly corrected afterward. These counts are explicitly separate from the official/monetized view-count pipeline, which has its own, stricter guarantees.",
        ],
      },
      {
        heading: "Lambda architecture: speed layer meets batch layer",
        body: [
          "Sketches have bounded but nonzero error, and the merge job's over-fetch factor is tuned against expected skew rather than proven for every adversarial pattern — so a second layer exists to catch drift. The Flink-based speed layer optimizes for freshness (<60s); every completed hour, a Spark batch job recomputes exact top-K from the raw archive in S3 and overwrites the approximate leaderboard in Valkey.",
          "The Trending API never distinguishes which layer produced a given number — the client-facing contract is just 'a ranked list', with speed-layer freshness quietly upgraded to batch-layer exactness roughly an hour later. That's the whole point of running two layers instead of trying to make one layer do both jobs.",
        ],
      },
    ],
  },
};
