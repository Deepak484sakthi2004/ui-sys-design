import type { Problem } from "@/lib/types";

export const newsAggregator: Problem = {
  slug: "news-aggregator",
  num: "2.2",
  title: "Design a News Aggregator",
  level: "Medium",
  deepDiveAvailable: true,
  intro: [
    "Design a news aggregator that ingests ~2M articles/day from 50K+ sources, collapses duplicate coverage of the same event into a single story, and serves a personalized feed to 250M DAU at 50K reads/sec peak with sub-200ms p99, while detecting breaking news and pushing alerts within 30 seconds.",
  ],
  hardParts:
    "The hard parts: clustering near-duplicate articles from dozens of outlets without comparing every new article to every recent one, ranking a personalized feed that balances relevance against freshness and source diversity at low latency for hundreds of millions of users, and telling a real breaking-news spike apart from noise within seconds.",
  keyTopics: [
    "MinHash + LSH Deduplication",
    "Story Clustering (Union-Find)",
    "Two-Stage Ranking (Candidates → Score → Diversify)",
    "Streaming Trend Detection (EWMA / Z-Score)",
    "Push Fan-Out for Breaking News",
  ],
  foundationsReferenced: [
    { label: "Locality-Sensitive Hashing", tone: "purple" },
    { label: "Kafka", tone: "orange" },
    { label: "Cassandra / Wide-Column Stores", tone: "blue" },
    { label: "Elasticsearch / Inverted Index", tone: "blue" },
    { label: "Flink / Stream Processing", tone: "orange" },
    { label: "Valkey / Redis", tone: "purple" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "feedsvc", label: "Feed Service", sub: "stateless · personalized", col: 2, row: 1, tone: "green" },
      { id: "feedcache", label: "Feed Cache", sub: "Valkey · precomputed", col: 3, row: 1, tone: "green" },
      {
        id: "ranker",
        label: "Ranking Service",
        sub: "on cache miss",
        mono: "candidates → score → diversify",
        col: 4,
        row: 1,
        tone: "blue",
      },
      { id: "sources", label: "Content Sources", sub: "50K RSS / API / sitemaps", col: 1, row: 2, tone: "slate" },
      { id: "fetch", label: "Fetch Workers", sub: "adaptive polling + webhooks", col: 2, row: 2, tone: "green" },
      { id: "kafkaRaw", label: "Kafka", sub: "raw-articles topic", col: 3, row: 2, tone: "orange" },
      {
        id: "dedupEnrich",
        label: "Dedup & Enrich",
        sub: "cluster + categorize",
        mono: "MinHash → LSH buckets → union-find",
        col: 4,
        row: 2,
        tone: "purple",
      },
      { id: "articleStore", label: "Article Store", sub: "Cassandra · ~2.2B rows", col: 5, row: 2, tone: "blue" },
      { id: "trending", label: "Trending (Flink)", sub: "velocity vs. EWMA baseline", col: 4, row: 3, tone: "orange" },
      { id: "push", label: "Push Service", sub: "APNs / FCM", col: 5, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "feedsvc", label: "feed request", kind: "read" },
      { from: "feedsvc", to: "feedcache", label: "cache lookup", kind: "read" },
      { from: "feedcache", to: "ranker", label: "miss → generate", kind: "read" },
      { from: "ranker", to: "articleStore", label: "candidate fetch", kind: "read" },
      { from: "sources", to: "fetch", label: "poll / webhook", kind: "write" },
      { from: "fetch", to: "kafkaRaw", label: "raw article event", kind: "write" },
      { from: "kafkaRaw", to: "dedupEnrich", label: "consume", kind: "write" },
      { from: "dedupEnrich", to: "articleStore", label: "story_id + metadata", kind: "write" },
      { from: "dedupEnrich", to: "trending", label: "story mention rate", kind: "analytics" },
      { from: "trending", to: "push", label: "spike detected", kind: "analytics" },
      { from: "push", to: "client", label: "breaking-news alert", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · feed serving up to 50K/sec" },
      { kind: "write", text: "write path · ingestion up to 1K articles/sec" },
      { kind: "analytics", text: "async · breaking-news detection & push, never blocks ingestion or feed reads" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Ingest articles from 50K+ RSS/sitemap/API sources on an adaptive schedule", tag: "P0" },
      { id: "FR-02", text: "Extract clean title, body, image, and author from raw HTML (readability parsing)", tag: "P0" },
      { id: "FR-03", text: "Detect near-duplicate coverage of the same event and cluster it into one story", tag: "P0" },
      { id: "FR-04", text: "Categorize articles by topic and extract named entities (people, orgs, places)", tag: "P0" },
      { id: "FR-05", text: "Serve a personalized home feed ranked by relevance, freshness, and diversity", tag: "P0" },
      { id: "FR-06", text: "Serve category/topic feeds and full-text article search", tag: "P0" },
      { id: "FR-07", text: "Detect breaking/trending stories in near real time and push alerts to subscribers", tag: "P1" },
      { id: "FR-08", text: "Let users follow topics, sources, or entities and mute/block sources", tag: "P1" },
      { id: "FR-09", text: "Track engagement (click, dwell time, share) to improve future ranking", tag: "P1" },
      { id: "FR-10", text: "Support a cached, pre-fetched feed for offline/low-bandwidth mobile reading", tag: "P2" },
      { id: "FR-11", text: "Surface source diversity per story (how many distinct outlets are covering it)", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Feed request latency, server-side", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "Ingest-to-searchable latency, publish to indexed", tag: "< 60s" },
      { id: "NFR-03", text: "Breaking-news detection-to-push latency", tag: "p99 < 30s" },
      { id: "NFR-04", text: "Feed read throughput, sustained (peak)", tag: "50K/sec" },
      { id: "NFR-05", text: "Ingestion throughput, sustained (peak)", tag: "1K/sec" },
      { id: "NFR-06", text: "Availability (about 4.4 hrs downtime/year)", tag: "99.95%" },
      { id: "NFR-07", text: "Dedup precision: distinct stories must never merge", tag: "> 98%" },
      { id: "NFR-08", text: "Article and metadata retention", tag: "3 years" },
      { id: "NFR-09", text: "Read-to-write ratio that anchors the whole design", tag: "500:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: articles, stories, and where the bytes go",
      body: [
        "Start from ingestion, not from users. 50K sources produce about 2M raw articles/day. But roughly 10 outlets cover any given real event, so after clustering that collapses to about 200K distinct stories/day — the dedup ratio is the single number that decides how much data the read path actually has to rank and serve.",
        "On the read side, 250M DAU opening the app ~4 times/day is 1B feed requests/day, about 11.6K/sec sustained, with peaks (morning commute, breaking news) reaching 50K/sec. That 500:1 read-to-write ratio is why this is architected like a read-heavy fan-out system with an expensive, careful write path feeding it.",
      ],
      bullets: [
        { lead: "Metadata store", text: "3 years of retention at 2M articles/day is ~2.2B rows. At ~1.5KB per row (title, source, story_id, category, entities, timestamps) that is ~3.3TB — small enough that a wide-column store handles it comfortably." },
        { lead: "Raw content", text: "extracted article text/HTML averages ~30KB. 2.2B articles × 30KB ≈ 66TB, which belongs in object storage (S3), not the hot metadata table." },
        { lead: "Stories vs. articles", text: "the feed shows ~220M stories over 3 years, not 2.2B articles. Ranking, caching, and search all operate on the smaller, deduplicated story count." },
      ],
      pictureTitle: "Where does the data actually live?",
      pictureRows: [
        { label: "Article metadata (Cassandra)", value: "~2.2B rows, ~3.3TB — hot, queried by id", tone: "good" },
        { label: "Raw HTML/text (S3)", value: "~66TB — cold, never queried directly", tone: "neutral" },
        { label: "Distinct stories after dedup", value: "~220M — what ranking and caching operate on", tone: "good" },
      ],
      remember: {
        problem: "How much data does 3 years of ingestion actually produce, and where should it live?",
        solution: "Split hot metadata (Cassandra, ~3.3TB) from cold raw content (S3, ~66TB); rank on the ~220M deduplicated stories, not the 2.2B raw articles.",
        why: "Metadata rows are small and queried constantly; raw HTML is large and read only when a user opens an article, so the two belong in different stores with different cost profiles.",
        tradeoff: "An extra hop (metadata → object storage URL → fetch body) versus one bloated table that would blow out cache and backup costs.",
        failure: "Store raw HTML inline in the metadata table and every scan, backup, and cache eviction gets 20x more expensive than it needs to be.",
        mitigation: "Metadata row holds a pointer (S3 key) to the body; only the ranking/feed path touches metadata, only the reader page touches S3.",
      },
    },
    {
      n: 2,
      title: "Ingestion: adaptive polling, not a fixed crawl loop",
      body: [
        "50K sources do not publish at the same rate. A wire service posts every few seconds; a small blog updates twice a week. Polling all 50K on a fixed interval either hammers slow sources for nothing or misses fast ones for minutes — both are wrong, and during breaking news the minutes matter.",
        "Track each source's historical publish cadence and adjust polling frequency per source: poll aggressively right after a new article appears, back off exponentially when a source goes quiet. Where a source supports push (WebSub/PubSubHubbub, a publisher webhook, a sitemap ping), prefer that entirely — it turns O(sources) polling into O(events) ingestion for the subset that offers it.",
      ],
      bullets: [
        { lead: "Adaptive schedule", text: "per-source poll interval derived from observed cadence, not a global constant — a wire service might be polled every 10s, a low-volume blog every 6 hours." },
        { lead: "Push where possible", text: "WebSub/webhook sources skip polling entirely and land in Kafka the moment they publish, which is what makes the <60s ingest-to-searchable budget achievable for high-value sources." },
        { lead: "Politeness", text: "per-domain concurrency caps and robots.txt compliance so a burst of fetches never looks like a DDoS to a small publisher — and a circuit breaker per source stops hammering a source that starts erroring." },
      ],
      pictureTitle: "Fixed polling vs. adaptive + push",
      pictureRows: [
        { label: "Fixed interval for all 50K sources", value: "wastes budget on slow sources, too slow for fast ones", tone: "bad" },
        { label: "Adaptive per-source interval", value: "polls fast sources often, quiet sources rarely", tone: "good" },
        { label: "Push (WebSub/webhook) where available", value: "near-zero ingest latency, no polling needed", tone: "good" },
      ],
      remember: {
        problem: "Poll 50K sources with wildly different publish rates without wasting fetch budget or missing fast-breaking stories.",
        solution: "Per-source adaptive polling interval based on observed cadence, plus push (WebSub/webhooks) for any source that supports it.",
        why: "A single global interval is always wrong for most sources; cadence-derived intervals put fetch budget where new content actually appears.",
        tradeoff: "More bookkeeping per source (track cadence, adjust interval) versus the simplicity — and the guaranteed staleness or waste — of one fixed loop.",
        failure: "Fixed 5-minute polling on a wire service that publishes every 10 seconds means breaking news sits unseen for up to 5 minutes.",
        mitigation: "Cadence-derived adaptive intervals plus preferring push for high-value sources keeps latency low without polling everything constantly.",
      },
    },
    {
      n: 3,
      title: "Dedup and story clustering: kill the O(n²) comparison",
      body: [
        "The same event gets reported by ~10 outlets within minutes. Naively, clustering means comparing every new article's text to every recent article to find matches — with 2M articles/day that is billions of pairwise comparisons, infeasible at any reasonable latency or cost.",
        "The fix is to never do a full comparison unless two articles are already likely similar. MinHash compresses each article's shingled text into a small fixed-size signature that approximates Jaccard similarity. Locality-Sensitive Hashing (LSH) then buckets signatures so that similar articles land in the same bucket with high probability — you only compare articles inside a shared bucket, turning 'compare to everyone' into 'compare to a handful of candidates.'",
      ],
      bullets: [
        { lead: "MinHash signature", text: "shingle the article text (e.g. 5-word windows), hash each shingle, keep the minimum hash per hash function — a fixed-size signature (~100 values) that approximates similarity without storing the full text." },
        { lead: "LSH bucketing", text: "split the signature into bands; two articles sharing a band land in the same bucket. Only bucket-mates get a full comparison — expected O(1) candidates per new article instead of O(n)." },
        { lead: "Union-find merge", text: "if article A matches B and B matches C, all three belong in one story even if A and C alone wouldn't have matched directly — union-find merges transitively-similar articles into a single story_id cheaply." },
        { lead: "Precision over recall", text: "merging two distinct stories is worse than leaving two duplicates unmerged (NFR-07 sets >98% precision) — tune LSH bands/rows and the confirmation threshold toward not-merging when unsure." },
      ],
      pictureTitle: "O(n²) comparison vs. LSH bucketing",
      pictureRows: [
        { label: "Compare every new article to all recent", value: "billions of comparisons/day — infeasible", tone: "bad" },
        { label: "MinHash → LSH bucket → compare bucket-mates", value: "~O(1) candidates per article", tone: "good" },
        { label: "Union-find across matches", value: "transitively merges A~B~C into one story", tone: "good" },
      ],
      remember: {
        problem: "Cluster near-duplicate articles from dozens of outlets without comparing every new article to every recent one.",
        solution: "MinHash signatures + LSH bucketing to find candidates in ~O(1), then union-find to merge transitively-similar articles into one story.",
        why: "LSH guarantees similar items collide into the same bucket with high probability, so you only ever compare a small candidate set, not the whole corpus.",
        tradeoff: "Approximate similarity (some false positives/negatives) and extra infra (signatures, bucket index) versus exact but computationally infeasible pairwise comparison.",
        failure: "Loose thresholds merge two genuinely different stories into one cluster, which users see as a factual error in the product.",
        mitigation: "Bias LSH bands and the confirmation threshold toward precision (>98%), and monitor merge precision as a first-class metric, not an afterthought.",
      },
    },
    {
      n: 4,
      title: "Ranking: two-stage, then diversify",
      body: [
        "Feed generation is a classic candidate-generation-then-ranking pipeline. Stage one retrieves a few hundred candidate stories cheaply — recent items from followed sources/topics plus a category index lookup. Stage two scores those candidates with a model that blends relevance (user embedding · content embedding), a freshness decay (recency half-life so a 6-hour-old story naturally fades), and predicted engagement (CTR, dwell time).",
        "A pure top-N-by-score feed creates a filter bubble and floods the feed with every angle of the same story from different sources. After scoring, re-rank for diversity: cap how many stories from the same cluster or same source appear consecutively (MMR-style diversification), so relevance and variety are both explicit, tunable objectives — not something the ranking model figures out on its own.",
      ],
      bullets: [
        { lead: "Stage 1 — candidates", text: "cheap retrieval from followed sources/topics and category indexes, a few hundred candidates, no heavy scoring yet." },
        { lead: "Stage 2 — score", text: "relevance (embedding similarity) + freshness decay + predicted engagement, combined into one rank score per candidate." },
        { lead: "Diversify", text: "explicit re-rank pass caps same-cluster and same-source repeats — this is a product requirement (avoid filter bubbles), not just an ML nicety." },
        { lead: "Hybrid caching", text: "precompute and cache feed pages for actively engaged users (push model); cold or rarely-active users fall through to on-demand generation (pull) at request time." },
      ],
      pictureTitle: "Score-only feed vs. score-then-diversify",
      pictureRows: [
        { label: "Rank purely by predicted engagement", value: "top 10 all about one story, one echo chamber", tone: "bad" },
        { label: "Score, then cap same-cluster/source repeats", value: "relevant and varied", tone: "good" },
        { label: "Precompute for active users, generate on-demand for the rest", value: "keeps p99 < 200ms without ranking every user eagerly", tone: "good" },
      ],
      remember: {
        problem: "Rank a personalized feed that is relevant without becoming a filter bubble, fast enough for 50K req/sec.",
        solution: "Two-stage candidate generation + scoring, then an explicit diversity re-rank pass; hybrid precompute/on-demand caching.",
        why: "Cheap retrieval keeps the scoring stage small; separating diversity from relevance scoring makes 'don't show 10 versions of one story' an explicit, testable rule.",
        tradeoff: "Diversification can push a marginally more relevant but same-cluster story down the feed in favor of a more varied one — a deliberate quality tradeoff.",
        failure: "Score-only ranking floods the feed with every outlet's version of the top story and the user sees no other news that hour.",
        mitigation: "Cap same-cluster/source repeats in a dedicated re-rank pass, tuned and monitored as its own metric, not folded silently into the relevance score.",
      },
    },
    {
      n: 5,
      title: "Trending and breaking news: spike vs. noise",
      body: [
        "A real breaking story shows a sudden burst of independent coverage; noise looks like one source reposting or a slow trickle of routine updates. Compute per-story velocity — mentions/new-sources per minute — in a streaming job (Flink) over tumbling windows, then compare that velocity to a smoothed historical baseline (EWMA) and flag a spike with a z-score threshold rather than a raw count threshold, so 'trending' scales correctly for both a niche topic and a global event.",
        "A single spammy or low-quality source should never trigger a breaking-news push on its own. Require corroboration — a minimum number of distinct, reputable sources reporting the same story cluster within the window — before promoting it to 'breaking,' and only then fan out the alert.",
      ],
      bullets: [
        { lead: "Velocity, not raw count", text: "mentions/minute for a story cluster, computed on the deduplicated story stream (from the dedup service), not the raw article firehose." },
        { lead: "EWMA baseline + z-score", text: "compares current velocity to that story's/topic's own recent history, so a spike is relative, not an absolute magic number." },
        { lead: "Corroboration threshold", text: "requires N distinct reputable sources before declaring breaking, filtering out single-source spam or a wire-service auto-repost storm." },
        { lead: "Story-level cooldown", text: "one push per breaking story, not one per new article about it — otherwise a fast-moving story spams the same users repeatedly." },
      ],
      pictureTitle: "Raw count threshold vs. baseline-relative spike",
      pictureRows: [
        { label: "Fixed count threshold ('50 mentions = breaking')", value: "misses niche spikes, over-triggers on global days", tone: "bad" },
        { label: "EWMA baseline + z-score", value: "relative spike, scales to topic and day", tone: "good" },
        { label: "Single-source trigger", value: "one spam source can fire a false alert", tone: "bad" },
        { label: "Require N corroborating sources", value: "filters spam before it reaches push", tone: "good" },
      ],
      remember: {
        problem: "Tell a genuine breaking-news spike apart from noise within seconds, without spam triggering false alerts.",
        solution: "Streaming velocity per story cluster, compared to an EWMA baseline via z-score, gated by a multi-source corroboration threshold.",
        why: "Relative spikes generalize across topics and days; corroboration filters out single-source noise before it becomes a push notification.",
        tradeoff: "Corroboration adds latency (waiting for a second/third source) against the risk of pushing a false alert from one source.",
        failure: "A fixed absolute threshold either misses a real spike in a quiet topic or never triggers on an ordinary day for a globally huge event.",
        mitigation: "Baseline-relative (EWMA/z-score) detection plus a source-diversity gate before promoting a cluster to 'breaking.'",
      },
    },
    {
      n: 6,
      title: "Feed caching and invalidation",
      body: [
        "Ranking every user's feed on every request would not hit p99 < 200ms at 50K req/sec. Precompute and cache feed pages in Valkey for actively engaged users, refreshed on a schedule; a cache miss (cold or rarely-active user) falls through to the Ranking Service to generate on demand. This is the same push/pull hybrid used in large-scale social feeds.",
        "Breaking news is the one event that must bypass the normal refresh cycle: when a story is flagged trending, patch it into the top of relevant cached feeds directly rather than waiting for the next scheduled regeneration, or mark those feeds stale so the next read regenerates within the latency budget instead of serving minutes-old news.",
      ],
      bullets: [
        { lead: "Precompute for hot users", text: "feed pages refreshed on a schedule for actively engaged users, served straight from Valkey with no ranking work on the request path." },
        { lead: "Generate on demand for the rest", text: "cold/rare users regenerate at request time — acceptable because they are a small fraction of total traffic." },
        { lead: "Breaking-news patch", text: "a trending story is injected into cached feeds directly, bypassing the normal refresh cycle so it doesn't wait behind a scheduled regeneration." },
      ],
      pictureTitle: "Regenerate every request vs. precompute + patch",
      pictureRows: [
        { label: "Rank on every feed request", value: "misses p99 < 200ms at 50K req/sec", tone: "bad" },
        { label: "Precompute + serve from Valkey", value: "sub-ms cache hit for active users", tone: "good" },
        { label: "Breaking news patched into cache directly", value: "bypasses the normal refresh cycle", tone: "good" },
      ],
      remember: {
        problem: "Serve a personalized feed at 50K req/sec with p99 < 200ms without ranking on every request.",
        solution: "Precompute and cache feed pages in Valkey for active users; on-demand ranking for cache misses; breaking news patched in directly.",
        why: "Most requests come from a smaller set of frequently-active users whose feeds can be precomputed; ranking on demand for the long tail keeps the system correct without ranking everyone eagerly.",
        tradeoff: "Precomputed feeds can be briefly stale for normal updates — acceptable everywhere except breaking news, which gets an explicit bypass.",
        failure: "Without a bypass path, a breaking story sits behind the next scheduled feed refresh and users miss it for minutes.",
        mitigation: "Direct cache patch for trending stories, decoupled from the normal precompute refresh schedule.",
      },
    },
    {
      n: 7,
      title: "Storage choices: Cassandra, Elasticsearch, S3",
      body: [
        "Three different access patterns need three different stores. Article/story metadata is high-volume key lookups by id with heavy write throughput at ingest — a wide-column store (Cassandra/DynamoDB) fits, time-bucket-partitioned by publish date to avoid hot partitions on trending days. Full-text search and category/topic candidate retrieval need an inverted index — Elasticsearch. Raw HTML/extracted text is large, cold, and never queried directly — object storage (S3).",
        "Once a story cluster settles (a few minutes after publication), article rows are effectively immutable — only a late category correction or entity fix touches them again. That near-write-once pattern is what makes the metadata store's read path simple and cache-friendly, much like an immutable row in a key-value system.",
      ],
      bullets: [
        { lead: "Cassandra for metadata", text: "high ingest write throughput, simple lookups by article_id/story_id, time-bucketed partitions to spread load evenly instead of hammering 'today's' partition." },
        { lead: "Elasticsearch for search", text: "inverted index for keyword search plus filtered category/topic queries feeding the candidate-generation stage of ranking." },
        { lead: "S3 for raw content", text: "cheap, large, cold blobs — read only when a user opens the actual article, never scanned in bulk." },
      ],
      pictureTitle: "One store for everything vs. three purpose-built stores",
      pictureRows: [
        { label: "Single relational DB for metadata + search + blobs", value: "text search and 66TB of HTML overwhelm one system", tone: "bad" },
        { label: "Cassandra (metadata) + Elasticsearch (search) + S3 (blobs)", value: "each store matched to its access pattern", tone: "good" },
      ],
      remember: {
        problem: "Store metadata, full-text search, and raw content at very different volumes and access patterns efficiently.",
        solution: "Cassandra for metadata, Elasticsearch for search/candidate retrieval, S3 for raw HTML/text.",
        why: "Each store is purpose-built for its access pattern; forcing all three into one system means paying for the worst-fit dimension everywhere.",
        tradeoff: "Operating three storage systems instead of one, and keeping them consistent (eventual, via the same ingest pipeline writing to all three).",
        failure: "Cramming 66TB of raw HTML into the same table you run point lookups against blows out cache and backup costs for the hot path.",
        mitigation: "Ingest pipeline fans out writes to all three stores from one place (post-dedup/enrich), keeping them in sync by construction.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's an ingest-and-cluster pipeline feeding a read-heavy personalized feed: dedup collapses 2M raw articles/day into ~200K distinct stories, and the feed serves those stories to 250M DAU.",
      "Dedup uses MinHash + LSH to avoid O(n²) comparisons, then union-find to merge transitively-similar articles into one story.",
      "Ranking is two-stage: cheap candidate retrieval, then score by relevance + freshness + engagement, then an explicit diversity re-rank pass so the feed doesn't become a filter bubble.",
      "Trending is detected as a velocity spike relative to an EWMA baseline, gated by multi-source corroboration so one spam source can't trigger a false breaking-news push.",
      "Feed pages are precomputed and cached for active users; breaking news bypasses the normal refresh cycle and gets patched into the cache directly.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · UP TO 50K/S · P99 < 200MS",
        summary:
          "A feed request hits the cache first. On a hit it's a straight Valkey read. On a miss, the Ranking Service generates the feed on demand from the article store.",
        steps: [
          { label: "Client", note: "opens the app / pulls to refresh" },
          { label: "Feed Service", note: "stateless request handler" },
          { label: "Feed Cache (Valkey)", note: "precomputed for active users" },
          { label: "Ranking Service", note: "miss → candidates → score → diversify" },
          { label: "Article Store", note: "candidate fetch by story_id" },
          { label: "Feed response", note: "ranked, diversified list of stories" },
        ],
      },
      {
        kind: "write",
        title: "WRITE (INGEST) · UP TO 1K ARTICLES/S",
        summary:
          "Sources get fetched (adaptively or via push), land raw in Kafka, then dedup/enrichment assigns each article a story_id and category before it's written to the article store.",
        steps: [
          { label: "Content Sources", note: "50K RSS/API/sitemaps" },
          { label: "Fetch Workers", note: "adaptive polling + webhooks" },
          { label: "Kafka", note: "raw-articles topic" },
          { label: "Dedup & Enrich", note: "MinHash → LSH → union-find; categorize, NER" },
          { label: "Article Store", note: "Cassandra insert with story_id" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · BREAKING NEWS · P99 < 30S DETECT-TO-PUSH",
        summary:
          "Story-level mention rate feeds a streaming trend job. A spike relative to baseline, corroborated by multiple sources, triggers one push per story — never on the ingest or feed-read path.",
        steps: [
          { label: "Dedup & Enrich", note: "emits story mention events" },
          { label: "Flink (Trending)", note: "velocity vs. EWMA baseline, z-score spike" },
          { label: "Corroboration gate", note: "N distinct reputable sources required" },
          { label: "Push Service", note: "story-level cooldown, one alert per story" },
          { label: "Client", note: "breaking-news notification" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "50K sources, 2M raw articles/day, ~10:1 dedup ratio → ~200K stories/day",
          "250M DAU × ~4 opens/day = 1B feed requests/day, ~11.6K/s avg, 50K/s peak",
          "500:1 read-to-write ratio anchors the whole design",
          "Storage: ~2.2B article rows over 3 years, ~3.3TB metadata + ~66TB raw HTML",
          "Latency: p99 < 200ms feed reads, < 60s ingest-to-searchable, p99 < 30s breaking-news push",
          "Dedup precision target: > 98% (merging distinct stories is worse than missing a merge)",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "MinHash + LSH for dedup candidates, not pairwise comparison",
          "Union-find to merge transitively-similar articles into one story",
          "Two-stage ranking: cheap candidate retrieval, then score, then diversify",
          "Cassandra for metadata, Elasticsearch for search, S3 for raw content",
          "Flink streaming velocity + EWMA baseline for trend detection, not fixed thresholds",
          "Precomputed feed cache for active users, on-demand generation for the rest",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Dedup precision over recall — merging two distinct stories is a factual error users see",
          "Diversity re-rank is a separate, explicit step from relevance scoring, not folded into the model",
          "Corroboration gate (N sources) before 'breaking' — one spam source must never trigger a push",
          "Breaking news bypasses the normal feed-cache refresh cycle via a direct patch",
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
      goal: "Land the five numbers that drive every later decision: sources, articles/day, dedup ratio, DAU, and read:write ratio.",
      why: "This is a fan-in/fan-out system (many sources in, many readers out), and the interviewer is checking whether the scale numbers actually shape the design instead of being decoration.",
      steps: [
        { kind: "ASK", text: '**"How many sources, and how many articles per day?"** Land on "50K sources, ~2M raw articles/day." Write **"50K sources, 2M articles/day"** top-left.' },
        { kind: "ASK", text: '**"How much duplicate coverage — does the same event get reported by many outlets?"** Land on "~10:1, so ~200K distinct stories/day." This ratio is what justifies the whole dedup pipeline.' },
        { kind: "ASK", text: '**"How many daily active users, and how often do they open the feed?"** Land on "250M DAU, ~4 opens/day → 1B feed requests/day."' },
        { kind: "SAY", text: 'Do the ratio out loud: **"1B reads/day vs. 2M writes/day is a 500:1 read-to-write ratio — this is architected read-heavy, like a feed system, not like a CRUD app."**' },
        { kind: "SAY", text: 'Propose latency targets: **"p99 < 200ms feed reads"**, **"< 60s ingest-to-searchable"**, **"p99 < 30s for breaking-news detection-to-push."** Wait for a nod, then write them down.' },
      ],
      grading: "Are the five numbers on the board before any box is drawn, and does the 500:1 ratio get stated explicitly as the thing that justifies read-heavy architecture?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Define the read and write surface, and the story/article split in the data model — get the dedup concept onto the board early.",
      why: "The interviewer wants to see the story-vs-article distinction land before the diagram, since it's the concept every later decision (ranking, caching, trending) depends on.",
      steps: [
        { kind: "WRITE", text: 'Write the core endpoints: **"GET /feed?userId"** returns ranked stories, "cache-first, p99 < 200ms". **"GET /story/:id"** returns a story with its source articles. **"GET /search?q"** hits Elasticsearch.' },
        { kind: "DRAW", text: 'Sketch two tables: **"article (article_id PK, story_id, source, url, published_at, category)"** and **"story (story_id PK, canonical_title, first_seen_at, source_count, category)"**. Say: "The feed ranks stories, not raw articles — that\'s what the dedup step buys us."' },
        { kind: "SAY", text: '"Article rows are near-immutable after enrichment settles — only a late category fix touches them again, so reads can be cache-friendly the same way an immutable row is."' },
        { kind: "RULE OUT", text: '"A naive design would rank raw articles and show the same event 10 times in a row — that\'s why story_id, not article_id, is the unit the feed operates on."' },
      ],
      grading: "Story vs. article distinction stated explicitly, endpoints are cache-friendly and clearly named, and the immutability point is made before being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: read (feed serving), write (ingestion), async (trending/push). Label arrows with throughput and latency, not just box names.",
      why: "Separating these three lanes is the whole point — they have different SLAs (feed reads are latency-critical, ingestion is throughput-critical, breaking news is best-effort-but-fast) and conflating them into one blob is the most common mid-level mistake.",
      steps: [
        { kind: "DRAW", text: 'Draw the **read path**: Client → Feed Service → Feed Cache (Valkey) → Ranking Service (on miss) → Article Store. Label **"50K req/s peak"**, **"p99 < 200ms"**.' },
        { kind: "DRAW", text: 'Draw the **write/ingest path** as a separate lane: Content Sources → Fetch Workers → Kafka → Dedup & Enrich → Article Store. Label **"1K articles/s peak"**, **"< 60s to searchable"**.' },
        { kind: "DRAW", text: 'Add the **async path** off Dedup & Enrich: → Flink (Trending) → Push Service → Client, dashed, labeled **"p99 < 30s detect-to-push, never blocks ingestion or reads"**.' },
        { kind: "SAY", text: '"Three lanes because they have three different SLAs: feed reads are latency-critical, ingestion is throughput- and correctness-critical (dedup precision), and breaking news is best-effort but fast."' },
      ],
      grading: "Three clearly separated lanes with arrows labeled by throughput/latency, and an explicit statement that trending/push never sits on the ingest or read path.",
    },
    {
      n: 4,
      title: "Deep Dive: Dedup and Story Clustering",
      minutes: 8,
      goal: "Explain why O(n²) comparison fails, then walk MinHash → LSH → union-find as the fix, with the precision-over-recall framing.",
      why: "This is the signature sub-problem of the whole design. The interviewer is checking whether you can name the actual algorithm (not just 'use ML to dedupe') and reason about the precision/recall tradeoff explicitly.",
      steps: [
        { kind: "SAY", text: '"Naively, clustering means comparing every new article to every recent one — with 2M articles/day that\'s billions of comparisons a day. Infeasible."' },
        { kind: "DRAW", text: 'Draw the pipeline: article text → shingles → **MinHash signature** (~100 values) → **LSH bands** → bucket. "Only articles sharing a bucket get compared directly — expected O(1) candidates, not O(n)."' },
        { kind: "SAY", text: '"Matches merge via **union-find**: if A matches B and B matches C, all three land in one story_id even if A and C alone wouldn\'t have matched."' },
        { kind: "RULE OUT", text: '"Tuning favors precision over recall — merging two distinct stories is a visible factual error; leaving two duplicates unmerged just means one extra row in the feed. That\'s why the NFR is >98% precision, not recall."' },
      ],
      grading: "MinHash and LSH named and explained (not hand-waved as \"use embeddings\"), union-find mentioned for transitive merges, and precision-over-recall stated as a deliberate tuning choice.",
    },
    {
      n: 5,
      title: "Deep Dive: Ranking and Trending",
      minutes: 7,
      goal: "Walk the two-stage ranking pipeline plus the diversity re-rank, then the trend-detection spike logic with the corroboration gate.",
      why: "Anyone can say 'rank by relevance.' The interviewer wants the two-stage structure, the explicit diversity step, and — for trending — a baseline-relative spike detector with a spam-resistance gate.",
      steps: [
        { kind: "SAY", text: '"Ranking is two-stage: cheap candidate retrieval (a few hundred stories from followed sources/topics), then scoring on relevance, freshness decay, and predicted engagement."' },
        { kind: "SAY", text: '"After scoring, an explicit diversity pass caps same-cluster and same-source repeats — otherwise the top of the feed is 10 versions of one story, a filter bubble."' },
        { kind: "SAY", text: '"Trending is a streaming job: per-story velocity compared to an EWMA baseline, flagged on z-score, not a raw count — so it scales to both niche topics and global events."' },
        { kind: "SAY", text: '"One spam source can\'t trigger a push — I require corroboration from N distinct reputable sources before promoting a cluster to \'breaking.\'"' },
      ],
      grading: "Two-stage ranking named explicitly, diversity called out as a separate step, and trend detection framed as baseline-relative with a spam-resistance gate, all volunteered without prompting.",
    },
    {
      n: 6,
      title: "Wrap: Bottlenecks, Tradeoffs, and Close",
      minutes: 5,
      goal: "Name the SLA tiers, the feed-cache bypass for breaking news, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal here is naming the operational edge cases unprompted: what happens to the cache when breaking news hits, and pushing back on requirements where it changes the design.",
      steps: [
        { kind: "SAY", text: '"Feed reads are tier-1, ingestion is tier-2, trending/push is tier-3 — that\'s why trending never sits on the ingest or read path."' },
        { kind: "SAY", text: '"Breaking news is the one case that bypasses the normal feed-cache refresh cycle — it gets patched into cached feeds directly instead of waiting for the next scheduled regeneration."' },
        { kind: "SAY", text: 'Push back where useful: **"Do we need global personalization from day one, or can early categories be un-personalized topic feeds while we bootstrap engagement data?"**' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s an ingest-and-cluster pipeline (MinHash/LSH dedup) feeding a two-stage, diversity-aware ranked feed, with a separate baseline-relative trend detector for breaking news. With more time I\'d cover the engagement-feedback loop into ranking and multi-region ingest failover."' },
      ],
      grading: "Explicit SLA tiers, the cache-bypass for breaking news named unprompted, at least one pushback on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working ingest-and-serve pipeline, but dedup and ranking stay shallow ('use a hash to find duplicates', 'sort by recency').",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: crawler/fetcher, database, cache, and a feed API.",
          "Knows articles need to be deduplicated but proposes exact-match hashing on title/URL.",
          "Adds a cache in front of the feed API once prompted about read scale.",
          "Can describe a queue (Kafka) between ingestion and processing.",
          "Handles 'what about breaking news' by adding a notification service.",
        ],
        gaps: [
          "Exact-match dedup misses near-duplicates (different headline, same event) entirely.",
          "Ranking is 'sort by recency' or 'sort by a single relevance score' with no diversity pass.",
          "No storage-math or dedup-ratio numbers on the board; 'lots of articles' stands in for a real estimate.",
          "Trending is 'count mentions and threshold it' with no baseline or spam resistance.",
          "Doesn't separate read, write, and async paths — draws one blob with everything synchronous.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, names MinHash/LSH for dedup and a two-stage ranking pipeline, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the five core numbers (sources, articles/day, dedup ratio, DAU, read:write) on the board within 5 minutes.",
          "Names MinHash + LSH for dedup and explains why it avoids O(n²) comparisons.",
          "Describes two-stage ranking (candidates then scoring) and mentions a diversity re-rank when asked.",
          "Proposes EWMA/baseline-relative trend detection rather than a fixed count threshold.",
          "Separates read, write, and async paths on the diagram with different SLAs.",
          "Picks Cassandra/Elasticsearch/S3 appropriately for metadata/search/raw content.",
        ],
        gaps: [
          "Mentions the precision-over-recall dedup tradeoff only when asked 'what if two stories get merged incorrectly?'",
          "Volunteers diversity re-ranking only after being asked why the feed looks repetitive.",
          "Doesn't bring up the breaking-news cache-bypass unprompted; treats cache invalidation as an afterthought.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, surfaces the precision/recall and filter-bubble tradeoffs before being asked, and brings operational maturity beyond the core design.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers precision-over-recall as the explicit dedup tuning choice, with the consequence stated in product terms ('users see a factual error, not a missing row').",
          "Names the diversity re-rank as a separate, explicit pass from relevance scoring, framing it as a product requirement, not an ML nicety.",
          "Brings up the corroboration gate for trending unprompted, explaining why a single-source spike must never become a push.",
          "Names the breaking-news cache-bypass as a deliberate exception to the normal precompute/refresh cycle.",
          "Pushes back on requirements ('do we need global personalization from day one, or can we bootstrap with topic feeds?').",
          "States explicit SLA tiers (reads tier-1, ingestion tier-2, trending/push tier-3) and uses them to justify every tradeoff.",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Proposing exact-match (title/URL hash) dedup, which misses the entire point — the same event is reported with different headlines by every outlet.",
      "Ranking by recency or a single score with no diversity step, so the top of the feed becomes 10 articles about one story.",
      "Trending detection based on a fixed mention-count threshold, which either misses niche spikes or never triggers on a huge global day.",
      "No corroboration gate on breaking news, so a single spam or low-quality source can trigger a push storm to millions of users.",
      "Putting trend detection or push notification synchronously on the ingest path, so a Flink hiccup slows down article ingestion.",
      "Treating the feed cache as always-fresh with no bypass path, so breaking news sits behind a scheduled refresh cycle for minutes.",
      "No capacity numbers — dedup ratio, read:write ratio, and storage split are never quantified, so every later decision is a guess.",
    ],
    followUps: [
      {
        q: "How do you keep dedup precision above 98% without missing real duplicates?",
        a: "Tune the LSH band/row split to bias toward precision: more bands with smaller row groups increases the collision probability threshold, meaning items need to be more similar to land in the same bucket, which reduces false merges at the cost of occasionally missing a true duplicate. Pair that with a confirmation step — a full MinHash Jaccard estimate (or embedding cosine similarity for semantically similar but differently-worded coverage) on bucket-mates before committing a merge — and monitor merge precision continuously via a small human-reviewed sample, treating a precision regression as a paging alert, not a weekly report.",
      },
      {
        q: "What happens if the Dedup & Enrich service falls behind during a huge news day?",
        a: "Kafka absorbs the backlog — ingestion from Fetch Workers keeps writing to the raw-articles topic regardless of consumer lag, so no articles are lost. The user-visible effect is a growing ingest-to-searchable latency (the <60s budget slips), and if the dedup service is also the trend-detection input, the breaking-news detection latency slips too. The mitigation is auto-scaling dedup consumers by partition count and prioritizing high-velocity story clusters (ones already showing rapid mention growth) for faster processing, so the most newsworthy content clears the backlog first even under load.",
      },
      {
        q: "Why not just rank by an ML model's raw score and skip the diversity pass?",
        a: "Because relevance and diversity are different objectives that trade off against each other, and folding them into one score makes the tradeoff implicit and hard to tune or debug. A single relevance-maximizing score naturally clusters toward whatever is highest-engagement right now, which is almost always the current top story covered by 10 outlets — so the model 'correctly' produces a filter-bubble feed. A separate re-rank pass makes 'no more than 2 consecutive same-cluster stories' an explicit, testable, independently-tunable rule instead of an emergent and fragile side effect of the ranking model.",
      },
      {
        q: "How would you handle a source that starts publishing fake or manipulated stories to game trending?",
        a: "The corroboration gate is the first line of defense — a single source, however prolific, can't trigger 'breaking' on its own. Beyond that, track a per-source credibility/reliability signal (historical accuracy, editorial standards, how often the source's exclusives get corroborated by others) and weight both ranking and the trending corroboration count by that signal, so five low-credibility sources count for less than two high-credibility ones. This becomes a moderation/trust problem as much as an engineering one, so it also needs a manual override path for the editorial/trust-and-safety team to suppress a cluster.",
      },
      {
        q: "How does the design change for a user with very few followed sources/topics (a new user)?",
        a: "Stage-1 candidate generation for a cold user has almost nothing to retrieve from followed sources, so it falls back to trending/top stories per broad category, which is a much cheaper, non-personalized candidate set. This is also why the feed cache is hybrid: cold users rarely benefit from precomputation (their feed changes with every follow they add) and are cheaper to rank on demand, while active users' feeds are worth precomputing repeatedly since they're read far more often per unit of compute spent generating them.",
      },
      {
        q: "Walk me through what changes at 10x the current scale (500M articles/day, 2.5B DAU).",
        a: "Ingestion: fetch workers and the dedup/LSH bucket index need to shard by source or by content hash so no single bucket index or Kafka partition becomes a bottleneck — LSH bucket lookups stay cheap per-shard as long as bucketing itself is sharded consistently. Ranking: the candidate-generation stage needs stronger pre-filtering (per-region/per-language indexes) since a global few-hundred-candidate retrieval stops being cheap at that volume. Storage: 3.3TB of metadata becomes ~33TB, still comfortably within Cassandra's wide-column model, but raw content in S3 (~660TB) starts to justify tiered storage (S3 Glacier for anything past a recency window) since most reads concentrate on recent articles anyway.",
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
          "This is an ingest-and-cluster pipeline feeding a read-heavy, personalized feed. The core operation on the write side is collapsing many articles about the same event into one story; the core operation on the read side is ranking those stories for a user fast enough to hit p99 < 200ms at 50K req/sec. Trending detection is a third, side-channel path riding on the same deduplicated story stream.",
          "Anchor everything on five numbers: 50K sources, 2M raw articles/day collapsing ~10:1 to ~200K stories/day, 250M DAU generating 1B feed requests/day (a 500:1 read-to-write ratio), and latency budgets of p99 < 200ms reads, < 60s ingest-to-searchable, and p99 < 30s breaking-news detect-to-push. Every structural choice below follows from these numbers.",
        ],
      },
      {
        heading: "Ingestion: adaptive polling over a fixed crawl loop",
        body: [
          "50K sources publish at wildly different rates, so a fixed poll interval is always wrong for most of them. Per-source adaptive intervals — derived from observed publish cadence, tightened right after a new article and backed off when a source goes quiet — put fetch budget where content actually appears. Sources that support push (WebSub, webhooks, sitemap pings) skip polling entirely, which is what makes the sub-60s ingest budget achievable for high-value sources.",
          "Per-domain concurrency caps and robots.txt compliance keep fetching polite to small publishers, and a circuit breaker per source stops the system from hammering one that starts erroring.",
        ],
      },
      {
        heading: "Dedup: MinHash, LSH, and union-find",
        body: [
          "Comparing every new article to every recent one is O(n²) and infeasible at 2M articles/day. MinHash compresses each article's shingled text into a fixed-size signature approximating Jaccard similarity; LSH buckets those signatures so similar articles collide into the same bucket with high probability, and only bucket-mates get a full comparison — expected O(1) candidates per new article, not O(n).",
          "Matches merge via union-find so transitively-similar articles (A matches B, B matches C) land in one story_id even where A and C alone wouldn't match directly. Tuning is biased toward precision over recall (NFR: >98% precision), because merging two distinct stories is a visible factual error, while missing a merge just leaves one extra row a diversity pass will suppress anyway.",
        ],
      },
      {
        heading: "Ranking: two-stage, then diversify",
        body: [
          "Feed generation follows a candidate-generation-then-ranking pattern. A cheap stage-1 retrieves a few hundred candidates from followed sources/topics and category indexes; stage-2 scores those candidates on relevance (embedding similarity), freshness decay, and predicted engagement. An explicit diversity re-rank pass then caps same-cluster and same-source repeats, treating 'don't show 10 versions of one story' as a testable rule rather than an emergent property of the scoring model.",
          "Feed pages are precomputed and cached in Valkey for actively engaged users and refreshed on a schedule; cold or rarely-active users fall through to on-demand ranking-service generation, which keeps p99 < 200ms achievable without ranking every user eagerly on every request.",
        ],
      },
      {
        heading: "Trending: velocity, baselines, and corroboration",
        body: [
          "A real breaking story shows a burst of independent coverage; noise looks like one source reposting or routine trickle. A streaming job (Flink) computes per-story-cluster velocity over tumbling windows and compares it to an EWMA baseline, flagging a spike by z-score rather than a raw count — this scales correctly for both a niche topic and a global event.",
          "A single low-quality or spam source must never trigger a breaking-news push alone: a corroboration gate requires N distinct reputable sources reporting the same cluster within the window before promotion to 'breaking,' and a story-level cooldown ensures one push per story rather than one per new article about it.",
        ],
      },
      {
        heading: "Storage and the async/tier hierarchy",
        body: [
          "Three access patterns, three stores: Cassandra for metadata (high write throughput, simple id lookups, time-bucketed partitions to avoid hot partitions on big news days), Elasticsearch for full-text search and category candidate retrieval, and S3 for the large, cold raw HTML/text. Article rows are near-immutable once a story cluster settles, which keeps the metadata read path simple and cache-friendly.",
          "The whole system is organized around explicit SLA tiers: feed reads are tier-1, ingestion is tier-2, and trending/push is tier-3 — that hierarchy is what justifies every tradeoff, from async fan-out for breaking news to the dedicated cache-bypass path that lets a breaking story skip the normal precompute/refresh cycle.",
        ],
      },
    ],
  },
};
