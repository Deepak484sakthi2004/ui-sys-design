import type { Problem } from "@/lib/types";

export const priceTrackingService: Problem = {
  slug: "price-tracking-service",
  num: "2.3",
  title: "Design a Price Tracking Service",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a price tracking service that ingests prices for 200M products across 50,000 merchants, keeps ~50M actively-watched products fresh within about an hour, and notifies users within 5 minutes of a genuine price drop — all while not getting the crawler's IP range banned and without trusting a merchant's own claim about how big a 'sale' really is.",
  ],
  hardParts:
    "The hard parts: matching the same physical product across merchants who describe it differently (product identity), notifying only the right watchers the instant a price changes without scanning every watch (alert fan-out), and staying fresh and unblocked against thousands of sites that don't want to be scraped — then surviving the one day a year when a huge fraction of watched prices change inside the same hour.",
  keyTopics: [
    "Adaptive Crawl Scheduling",
    "GTIN-First Product Matching",
    "Reverse Watch Index (Fan-Out)",
    "Time-Series Downsampling",
    "Synchronized-Spike Absorption",
  ],
  foundationsReferenced: [
    { label: "ScyllaDB", tone: "purple" },
    { label: "Kafka & Stream Processing", tone: "orange" },
    { label: "Rate Limiting / Token Bucket", tone: "orange" },
    { label: "Inverted Index", tone: "green" },
    { label: "Bloom Filters", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "productsvc", label: "Product Service", sub: "API gateway · reads + watches", col: 2, row: 1, tone: "green" },
      { id: "rediscache", label: "Redis", sub: "hot price cache", col: 3, row: 1, tone: "green" },
      { id: "scylla", label: "ScyllaDB", sub: "price history, source of truth", col: 4, row: 1, tone: "blue" },

      { id: "scheduler", label: "Crawl Scheduler", sub: "adaptive priority queue", col: 1, row: 2, tone: "purple" },
      { id: "crawlers", label: "Crawl Workers", sub: "headless browsers + merchant APIs", col: 2, row: 2, tone: "purple" },
      { id: "rawkafka", label: "Kafka", sub: "raw-price-events", col: 3, row: 2, tone: "orange" },
      { id: "normalizer", label: "Normalizer", mono: "dedupe → canonical id → diff vs last", col: 4, row: 2, tone: "purple" },

      { id: "changekafka", label: "Kafka", sub: "price-changed-events", col: 1, row: 3, tone: "orange" },
      { id: "flink", label: "Flink", sub: "alert matcher", col: 2, row: 3, tone: "orange" },
      { id: "watchidx", label: "Watch Index", sub: "product_id → watchers", col: 3, row: 3, tone: "blue" },
      { id: "notifsvc", label: "Notification Service", sub: "push · email · SMS · webhook", col: 4, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "productsvc", kind: "read" },
      { from: "productsvc", to: "rediscache", label: "~90% hit, sub-50ms", kind: "read" },
      { from: "rediscache", to: "scylla", label: "miss", kind: "read" },
      { from: "scheduler", to: "scylla", label: "staleness + watch count", kind: "read" },
      { from: "productsvc", to: "watchidx", label: "create/delete watch", kind: "write" },

      { from: "scheduler", to: "crawlers", label: "next-crawl due", kind: "write" },
      { from: "crawlers", to: "rawkafka", label: "scraped/API price", kind: "write" },
      { from: "rawkafka", to: "normalizer", kind: "write" },
      { from: "normalizer", to: "scylla", label: "upsert current + append history", kind: "write" },
      { from: "normalizer", to: "rediscache", label: "invalidate/update", kind: "write" },

      { from: "normalizer", to: "changekafka", label: "price-changed event", kind: "analytics" },
      { from: "changekafka", to: "flink", kind: "analytics" },
      { from: "flink", to: "watchidx", label: "match watchers", kind: "analytics" },
      { from: "flink", to: "notifsvc", label: "candidate alerts", kind: "analytics" },
      { from: "notifsvc", to: "client", label: "push/email/SMS · <5min", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · product page & price chart" },
      { kind: "write", text: "ingestion path · crawl → normalize → store" },
      { kind: "analytics", text: "alert path · async, never blocks ingestion or reads" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "productsvc", "scylla"],
      say: "Start with the shape of a read: the Client asks Product Service for a product page, and Product Service reads straight from ScyllaDB. Correct, but every single page view pays a database hit.",
    },
    {
      reveal: ["rediscache"],
      say: "Reads outnumber ingestion writes roughly 3 to 1, so Redis sits in front of Scylla: about 90% of product-page reads are served from cache in well under 50ms, and the database is only touched on a miss.",
    },
    {
      reveal: ["scheduler", "crawlers", "rawkafka", "normalizer"],
      say: "None of that price data appears by itself. A Crawl Scheduler decides what's due next from staleness and watch count, Crawl Workers fetch it — merchant API first, polite scraping fallback — and everything lands in Kafka before the Normalizer dedupes it, resolves the canonical product id, and writes the new price into Scylla, invalidating the cache.",
    },
    {
      reveal: ["changekafka", "flink", "watchidx", "notifsvc"],
      say: "Every price-changed event the Normalizer emits goes onto its own Kafka topic — the buffer that survives a Black Friday spike — then Flink matches it against the reverse Watch Index and hands candidate alerts to the Notification Service, which rate-limits per channel and gets a push out inside 5 minutes.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Track a product's price from a source URL or catalog ID (UPC/ASIN), creating a canonical product entity", tag: "P0" },
      { id: "FR-02", text: "User creates a price alert with a target price or percentage-drop threshold", tag: "P0" },
      { id: "FR-03", text: "Detect a real price change and notify watching users via push, email, or webhook", tag: "P0" },
      { id: "FR-04", text: "Serve the current lowest price and a full price-history chart for a product", tag: "P0" },
      { id: "FR-05", text: "Ingest prices from merchant APIs (e.g. Amazon PA-API, Google Shopping) where available, web scraping as fallback", tag: "P0" },
      { id: "FR-06", text: "Adaptive crawl scheduling: poll high-watch and volatile products more often than long-tail products", tag: "P0" },
      { id: "FR-07", text: "Deduplicate and match the same physical product across multiple merchants and URLs", tag: "P1" },
      { id: "FR-08", text: "Detect and flag fake 'was-price' inflation (list-price manipulation before a claimed sale)", tag: "P1" },
      { id: "FR-09", text: "Multi-currency and regional price normalization for cross-merchant comparison", tag: "P1" },
      { id: "FR-10", text: "Search and browse products by category, showing current lowest price across merchants", tag: "P1" },
      { id: "FR-11", text: "Users manage their watch list (create/pause/delete) and notification channel preferences", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Price-drop notification latency, detection to push sent", tag: "p99 < 5 min" },
      { id: "NFR-02", text: "Crawl freshness for the watched tier (~50M products)", tag: "<= 60 min stale" },
      { id: "NFR-03", text: "Crawl freshness for the long-tail tier (~150M products)", tag: "<= 24h stale" },
      { id: "NFR-04", text: "Product-page read latency (cached current price + chart)", tag: "p99 < 150ms" },
      { id: "NFR-05", text: "Alert-match throughput at peak (flash sales, Black Friday)", tag: "50K/sec" },
      { id: "NFR-06", text: "Price-history durability: no lost samples once ingested", tag: "zero loss" },
      { id: "NFR-07", text: "Read-path availability (about 4.4h downtime/year)", tag: "99.95%" },
      { id: "NFR-08", text: "Scrape success rate per merchant domain (avoid bot-blocking)", tag: "> 95%" },
      { id: "NFR-09", text: "Read (page views) to crawl-ingestion-write ratio that anchors the design", tag: "~3:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: how much crawl throughput does 200M products need?",
      body: [
        "Polling all 200M products at the same cadence is both wasteful and impossible: a widget that changes price twice a year doesn't need a 15-minute check, and checking everything that often would need a crawler fleet an order of magnitude bigger than the traffic justifies. Split the catalog into tiers by how much anyone actually cares, and let cadence fall out of that.",
        "Watched tier: ~50M products with at least one active alert, polled every 60 minutes, gives 50M / 3,600s ≈ 13,900 checks/sec. Long-tail tier: the remaining ~150M products (kept fresh only for search results), polled every 24 hours, gives 150M / 86,400s ≈ 1,700 checks/sec. Combined steady-state throughput is about 16K checks/sec — a number you can staff a crawl fleet and proxy pool against, instead of guessing.",
      ],
      bullets: [
        { lead: "Uniform 15-min polling", text: "would need 200M / 900s ≈ 222K checks/sec sustained — an unaffordable fleet, and mostly wasted on products nobody is watching." },
        { lead: "Watched tier (60 min)", text: "50M products × 1 check/hour ≈ 13,900/sec. This is where the freshness SLA actually matters, because it's what feeds the alert pipeline." },
        { lead: "Long-tail tier (24h)", text: "150M products × 1 check/day ≈ 1,700/sec. Good enough for search-result pricing; nobody is waiting on it." },
        { lead: "Priority score", text: "each product's next-crawl time is a function of watch_count, price volatility (how often it has changed historically), and time since last check — not a flat interval." },
      ],
      pictureTitle: "Uniform polling vs. tiered polling",
      pictureRows: [
        { label: "Uniform 15-min for all 200M", value: "≈222K checks/sec — unaffordable", tone: "bad" },
        { label: "Watched tier, 60 min (50M)", value: "≈13,900 checks/sec", tone: "good" },
        { label: "Long-tail tier, 24h (150M)", value: "≈1,700 checks/sec", tone: "good" },
        { label: "Combined steady state", value: "≈16K checks/sec", tone: "neutral" },
      ],
      remember: {
        problem: "Poll 200M products for price changes without an unaffordable crawl fleet.",
        solution: "Tier by watch count and volatility: watched tier every 60 min, long-tail every 24h, driven by a priority score, not a flat interval.",
        why: "Uniform polling wastes budget on products nobody is watching and still isn't fast enough for the ones people care about.",
        tradeoff: "Long-tail products can show a stale price for up to a day; that's fine because nobody has an alert on them.",
        failure: "Flat 15-min polling for everything needs ~222K checks/sec, roughly 14× the tiered steady-state number.",
        mitigation: "Recompute each product's priority score after every crawl so a suddenly-popular item gets promoted into the watched tier automatically.",
      },
    },
    {
      n: 2,
      title: "Product identity: kill three options, defend one",
      body: [
        "Two merchants list the same headphones under different titles: \"Sony WH-1000XM5 Wireless Headphones - Black\" and \"Sony WH1000XM5 Bluetooth Headset, Black\". If the system can't recognize these as one product, price comparison and 'lowest ever' history are both broken. Put the candidates on the board and rule them out one at a time.",
        "The winner isn't a single trick, it's a fallback chain with a confidence score: try the reliable signal first, fall back to a fuzzy one, and refuse to guess when confidence is low.",
      ],
      bullets: [
        { lead: "Exact title match", text: "misses the vast majority of true duplicates because merchants format titles differently. Rejected as a primary key." },
        { lead: "Merchant SKU/MPN as global key", text: "not standardized across sellers, often missing, and sometimes reused for different variants. Rejected as a sole key." },
        { lead: "Fuzzy title similarity alone", text: "catches more real duplicates but also merges different variants (a different color or storage size) into one product. Accepted only as one signal, never the decision." },
        { lead: "GTIN/UPC/EAN barcode first, fuzzy fallback second", text: "when a barcode is present (~70% of listings) it's an authoritative global key. When it's missing, narrow candidates by category + brand + price-band, score similarity with a classifier, and route anything below a confidence threshold to a review queue instead of guessing. Winner." },
      ],
      pictureTitle: "Product matching: kill three, keep one",
      pictureRows: [
        { label: "Exact title match", value: "misses most real duplicates → reject", tone: "bad" },
        { label: "SKU/MPN as key", value: "not standardized, often missing → reject", tone: "bad" },
        { label: "Fuzzy title alone", value: "merges distinct variants → signal only", tone: "neutral" },
        { label: "UPC/GTIN + fuzzy fallback + threshold", value: "authoritative when present, safe when not → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Recognize the same physical product across merchants who describe it differently.",
        solution: "GTIN/UPC as the primary key when present; category+brand+price-band narrowing plus a similarity classifier when it isn't, with a confidence threshold.",
        why: "A barcode is a real-world unique identifier; fuzzy matching alone trades false merges for false splits depending on the threshold.",
        tradeoff: "Low-confidence matches go to a review queue instead of auto-merging, which means some products stay split for a while.",
        failure: "Auto-merging on fuzzy title similarity alone silently combines two different variants into one price history.",
        mitigation: "Never merge below the confidence threshold; create a new canonical product and let a review queue (human or a stronger model) resolve it later.",
      },
    },
    {
      n: 3,
      title: "Staying unblocked: merchant APIs first, polite scraping second",
      body: [
        "Fetching a price is not just a GET request — most large merchants actively try to detect and block automated traffic. Prefer official channels wherever they exist, and treat scraping as a fallback that must behave like a good citizen, because getting an IP range banned takes down every product on that merchant at once.",
      ],
      bullets: [
        { lead: "Merchant APIs first", text: "Amazon PA-API, Google Shopping Content API, and affiliate network feeds give structured data, higher rate limits, and no legal ambiguity. Use them wherever a merchant offers one." },
        { lead: "Polite scraping fallback", text: "obey robots.txt and crawl-delay, use a distributed proxy pool so no single IP looks like a bot, and only spin up a headless browser (e.g. Playwright) for JS-rendered pages — static HTML fetches are cheaper and preferred when they work." },
        { lead: "Per-domain circuit breaker", text: "track success rate per merchant domain; if it spikes downward, back off automatically instead of hammering a site that's already blocking you and risking the whole IP range." },
        { lead: "Cache aggressively", text: "never re-fetch a page whose content hasn't changed since the last check; conditional requests (ETag/Last-Modified) cut wasted fetches." },
      ],
      pictureTitle: "How a price actually gets fetched",
      pictureRows: [
        { label: "Merchant API (e.g. Amazon PA-API)", value: "structured, high rate limit → preferred", tone: "good" },
        { label: "Static HTML scrape", value: "cheap, breaks on redesign → fallback", tone: "neutral" },
        { label: "Headless browser scrape", value: "handles JS pages, slow & costly → last resort", tone: "neutral" },
        { label: "No per-domain throttling", value: "IP range banned within hours → reject", tone: "bad" },
      ],
      remember: {
        problem: "Fetch prices from thousands of merchants who don't want to be scraped, without getting banned.",
        solution: "Official APIs first; polite, rate-limited, proxy-rotated scraping second, with a per-domain circuit breaker.",
        why: "One merchant's block is cheap to absorb; a shared-IP-range ban takes every merchant using that pool down at once.",
        tradeoff: "Politeness (rate limits, backoff) caps how fast a single merchant can be crawled, which is exactly why tiered scheduling matters.",
        failure: "An unthrottled scraper gets an entire proxy pool blacklisted, silently freezing prices for every product on that domain.",
        mitigation: "Per-domain success-rate monitoring with automatic backoff, plus preferring merchant APIs so scraping is the exception, not the rule.",
      },
    },
    {
      n: 4,
      title: "Storing 2 years of price history without unbounded growth",
      body: [
        "A price is a timestamped fact about a product; the natural shape is a wide row: partition key = product_id, clustering key = timestamp descending. 'What's the current price' is a read of the first row in the partition; 'show me the chart' is a range scan. The problem is that keeping every raw sample forever grows without bound, regardless of how disciplined the crawl schedule is.",
      ],
      bullets: [
        { lead: "Wide-row layout", text: "ScyllaDB partitioned by product_id, clustered by timestamp — current price and history live in the same physical shape, no separate table needed." },
        { lead: "30-day raw window", text: "at ~16K writes/sec × ~150 bytes, raw samples run about 6TB before replication (≈18TB at RF=3) for a rolling 30 days." },
        { lead: "Downsample after 30 days", text: "collapse older samples into daily min/max/avg rollups. 200M products × 730 days of rollups is roughly another 6TB (≈18TB at RF=3) — bounded no matter how the raw retention window is sized." },
        { lead: "Immutable appends", text: "a price sample, once written, never changes — the same write-once shape that makes replica reads cheap and safe, whether the store is Scylla, Cassandra, or a columnar store like ClickHouse for chart queries." },
      ],
      pictureTitle: "Bounding 2 years of price history",
      pictureRows: [
        { label: "Keep every raw sample forever", value: "unbounded growth → reject", tone: "bad" },
        { label: "Raw samples, 30-day window", value: "≈6TB (18TB at RF=3), fresh detail", tone: "good" },
        { label: "Daily rollups, 2-year retention", value: "≈6TB (18TB at RF=3), bounded", tone: "good" },
        { label: "Overwrite in place, no history", value: "loses 'lowest price ever' feature", tone: "bad" },
      ],
      remember: {
        problem: "Keep 2 years of price history for 200M products without storage growing without bound.",
        solution: "Wide rows (product_id partition, timestamp clustering) with a 30-day raw window, downsampled to daily rollups after.",
        why: "Recent history needs full resolution for the chart's zoomed-in view; old history only needs min/max/avg for 'lowest ever' and trend lines.",
        tradeoff: "Old data loses intra-day granularity — you can't answer 'what was the price at 3pm 400 days ago', only the day's min/max/avg.",
        failure: "Storing every raw sample forever turns a bounded 12TB (RF=3) footprint into an ever-growing one that eventually forces an emergency migration.",
        mitigation: "A scheduled rollup job (not ad hoc) compacts anything past the 30-day window before it ever becomes a capacity emergency.",
      },
    },
    {
      n: 5,
      title: "Alert fan-out: the watch index, not a full scan",
      body: [
        "When a price changes, the naive approach is to scan every active watch and check if it matches — that's O(all watches) work per event, and at thousands of price-change events per second against 80M watches, it's not close to feasible. The fix is the same shape as any fan-out problem: build a reverse index once, and pay only for the work that event actually needs.",
      ],
      bullets: [
        { lead: "Reverse index by product_id", text: "a table (Scylla/Cassandra, hot entries cached in Redis) mapping product_id → list of {user_id, threshold, channel}. A price-changed event looks up exactly one partition." },
        { lead: "O(watchers of this product), not O(all watches)", text: "a niche product with 3 watchers costs 3 lookups; the reverse index never touches the other 79,999,997 watches in the system." },
        { lead: "Write-time cost, read-time payoff", text: "creating or deleting a watch means writing into this index too — a small, cheap write in exchange for a cheap read on the hot alert path." },
        { lead: "Threshold check happens after the lookup", text: "the index narrows to 'who's watching this product', then a comparison decides who actually crossed their target price or percentage-drop threshold." },
      ],
      pictureTitle: "Who gets notified when a price changes?",
      pictureRows: [
        { label: "Scan all 80M watches per event", value: "infeasible at thousands of events/sec", tone: "bad" },
        { label: "Reverse index: product_id → watchers", value: "O(watchers of this product) per event", tone: "good" },
        { label: "Redis cache of hot products' watcher lists", value: "shaves the lookup for viral price drops", tone: "good" },
      ],
      remember: {
        problem: "Find the right subset of 80M watches to notify on every price change, fast.",
        solution: "A reverse index keyed by product_id, listing its watchers, looked up once per price-changed event.",
        why: "Fan-out problems are solved by inverting the relationship you query most: 'who watches this product' beats 'scan every watch'.",
        tradeoff: "Every watch create/delete now writes to two places (the watch record and the reverse index) to keep them in sync.",
        failure: "Scanning all watches per event doesn't scale past a trivial event rate; latency and cost both blow up together.",
        mitigation: "Cache hot products' watcher lists in Redis so a viral price drop doesn't hammer the Scylla-backed index.",
      },
    },
    {
      n: 6,
      title: "The load-bearing risk: synchronized price drops",
      body: [
        "The alert pipeline's steady-state sizing assumes price changes trickle in — on a normal day only about 5% of checks yield a real delta, so roughly 800 change-events/sec against a 16K checks/sec crawl rate. That assumption breaks hard on days like Black Friday, when a large share of the watched tier drops price within the same hour because merchants flip sale prices at the same clock time. Name this out loud, quantify it, and provision for the burst, not just the average.",
      ],
      bullets: [
        { lead: "Normal day", text: "≈800 price-changed events/sec, well within steady-state Flink and notification capacity." },
        { lead: "Synchronized spike", text: "a large fraction of the ~50M watched tier can change within the same hour window, pushing change-event throughput toward the provisioned peak of 50K/sec — a ~60× jump, not a gradual ramp." },
        { lead: "Downstream providers have their own ceilings", text: "APNs, SES, and Twilio all rate-limit; blasting notifications directly into them during a spike gets the notification service itself throttled or banned." },
        { lead: "Kafka absorbs the burst", text: "the raw and change-event topics buffer the spike so Flink and the notification service can drain it at a sustainable rate instead of falling over synchronously with the merchants." },
      ],
      pictureTitle: "What happens on Black Friday?",
      pictureRows: [
        { label: "Normal day", value: "≈800 change-events/sec, steady trickle", tone: "good" },
        { label: "Synchronized spike (flash sale)", value: "up to 50K change-events/sec, ~60× jump", tone: "bad" },
        { label: "Notification providers (APNs/SES/Twilio)", value: "have their own rate limits — queue, don't blast", tone: "neutral" },
        { label: "Kafka buffer + per-channel rate limiter", value: "absorbs the burst, drains at a safe rate", tone: "good" },
      ],
      remember: {
        problem: "The alert pipeline is sized for a trickle, but real sale events cause a synchronized spike.",
        solution: "Provision for a quantified burst (50K/sec), buffer in Kafka, and rate-limit outbound notifications per provider.",
        why: "Merchants flip sale prices at the same clock time, so 'average load' massively understates the worst hour of the year.",
        tradeoff: "Peak capacity sits mostly idle 364 days a year — the cost of not falling over on the one day that matters most.",
        failure: "Sizing only for the ~800/sec average means Black Friday either drops alerts or gets the service throttled by its own notification providers.",
        mitigation: "Kafka as a shock absorber, dedup per user+threshold so re-checks in the burst window don't double-notify, and a rate-limited queue per notification channel.",
      },
    },
    {
      n: 7,
      title: "Price integrity: catching a fake 'was' price",
      body: [
        "A merchant can inflate the 'was' or 'list' price right before a 'sale' so the discount looks bigger than it is — a known dark pattern, and in several jurisdictions a regulated one (reference-pricing rules). If the service just echoes the merchant's claimed savings, it's repeating misinformation, not tracking a price. The service's own history is what turns a chart into a trust signal.",
      ],
      bullets: [
        { lead: "Don't trust the merchant's 'was' price", text: "it's marketing copy, not a fact the service observed." },
        { lead: "Use tracked history as the baseline", text: "the lowest price this service actually observed over the last 30-90 days is the honest reference point for 'is this really a deal'." },
        { lead: "Flag large divergence", text: "when a merchant's claimed 'was' price is far above the tracked baseline, flag or downrank the listing instead of amplifying the inflated discount." },
        { lead: "This is the product's moat", text: "the price-history teardown above isn't just a chart feature — it's the data that makes price-integrity claims possible at all." },
      ],
      pictureTitle: "Whose 'was' price do you trust?",
      pictureRows: [
        { label: "Trust merchant's displayed 'was' price", value: "merchant can inflate it → reject", tone: "bad" },
        { label: "Use our own 90-day tracked low as baseline", value: "an observed fact, not a claim → good", tone: "good" },
        { label: "Flag large merchant-vs-baseline divergence", value: "catches manipulation before users see it", tone: "good" },
      ],
      remember: {
        problem: "A merchant's claimed discount can be inflated by lying about the 'was' price.",
        solution: "Use the service's own tracked price history as the reference baseline, not the merchant's claim.",
        why: "The service observed the real price over time; the merchant's 'was' price is marketing copy it controls unilaterally.",
        tradeoff: "A genuinely new product with no tracked history has no honest baseline yet, so integrity checks phase in as history accumulates.",
        failure: "Echoing merchant-supplied discount percentages without a baseline turns the service into a distributor of misleading claims.",
        mitigation: "Flag or downrank listings where the claimed 'was' price diverges sharply from the tracked 30-90 day low.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's an ingestion pipeline wrapped around a key-value price lookup: crawl, normalize, diff, store, and only then decide who to tell.",
      "Crawl cadence is tiered by watch count and volatility, not uniform, because polling all 200M products at the same rate is both wasteful and infeasible.",
      "Alerts are found with a reverse index (product_id → watchers), not a scan of every watch, the same shape as any fan-out problem.",
      "The whole alert pipeline is sized for a quantified burst (synchronized sale-day price drops), not just the steady-state trickle.",
      "Price integrity comes from the service's own tracked history, never from trusting a merchant's claimed 'was' price.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · PRODUCT PAGE & CHART",
        summary:
          "A user opens a product page. The request checks Redis first for the current price, and only falls through to ScyllaDB on a cache miss.",
        steps: [
          { label: "Client", note: "opens a tracked product's page" },
          { label: "Product Service", note: "API gateway, ~48K/sec reads at peak" },
          { label: "Redis", note: "~90% hit, sub-50ms" },
          { label: "ScyllaDB", note: "miss → current price + history range scan" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · INGESTION · ~16K CHECKS/SEC",
        summary:
          "The scheduler decides what's due, workers fetch it (API first, polite scraping fallback), and the normalizer resolves identity before anything is stored.",
        steps: [
          { label: "Crawl Scheduler", note: "priority = watch count + volatility + staleness" },
          { label: "Crawl Workers", note: "merchant API preferred, headless/proxy fallback" },
          { label: "Kafka", note: "raw-price-events" },
          { label: "Normalizer", note: "canonical product_id, diff vs last price; Bloom filter rejects already-seen raw duplicates before the Scylla check" },
          { label: "ScyllaDB + Redis", note: "append history, upsert current, invalidate cache" },
        ],
      },
      {
        kind: "analytics",
        title: "ALERT · ASYNC, NEVER BLOCKS INGESTION",
        summary:
          "A real price change emits an event; the alert path fans out to only the watchers of that product, then rate-limits delivery per channel.",
        steps: [
          { label: "Normalizer", note: "emits price-changed only on a real delta" },
          { label: "Kafka", note: "price-changed-events, buffers the sale-day burst" },
          { label: "Flink", note: "alert matcher, threshold comparison" },
          { label: "Watch Index", note: "product_id → watchers, O(watchers of this product)" },
          { label: "Notification Service", note: "dedup, per-channel rate limit, <5min p99" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "200M products, 50K merchants, 50M watched, 80M active watches",
          "Crawl throughput: ~13.9K/sec watched (60min) + ~1.7K/sec long-tail (24h) ≈ 16K/sec",
          "Product-page reads ≈ 48K/sec at peak (~3:1 vs. ~16K/sec ingestion writes)",
          "Normal-day change events: ~800/sec (≈5% of checks); Black Friday burst: up to 50K/sec",
          "Price history: 30-day raw ≈6TB (18TB at RF=3) + 2yr daily rollups ≈6TB (18TB at RF=3)",
          "Notification latency p99 < 5 min; product-page read p99 < 150ms",
          "Scrape success rate target > 95% per merchant domain",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Tiered adaptive crawl schedule, not uniform polling",
          "GTIN/UPC first for product identity, fuzzy match + confidence threshold as fallback",
          "Merchant APIs preferred over scraping; scraping is rate-limited and proxy-rotated",
          "Wide-row time series (product_id partition, timestamp clustering) with downsampling after 30 days",
          "Reverse watch index (product_id → watchers) instead of scanning all watches",
          "Kafka buffers the alert pipeline so sale-day spikes don't overwhelm Flink or notification providers",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Synchronized-spike (Black Friday) is the load-bearing risk on the alert pipeline",
          "Price integrity: use tracked history as the baseline, never trust merchant 'was' price",
          "Per-domain circuit breaker so one merchant's block doesn't take down the whole proxy pool",
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
      goal: "Lock the catalog size, watch count, and freshness/notification SLAs before drawing anything.",
      why: "Every later decision — crawl tiering, storage shape, alert burst capacity — is a consequence of these numbers, not a matter of taste.",
      steps: [
        { kind: "ASK", text: '**How many products, and how many are actually watched?** Land on "200M products, 50M watched, 80M active watches" and write **"200M / 50M watched / 80M watches"** on the board.' },
        { kind: "ASK", text: 'Next: **"What\'s the freshness SLA?"** Land on "watched tier <= 60 min stale, long-tail <= 24h", and **"notification p99 < 5 min from detection"**.' },
        { kind: "SAY", text: 'State scope. In: "ingestion, product identity, adaptive crawl, alert fan-out, price history, notifications". Out: "payments, checkout, browser extension client". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the crawl-throughput math out loud: **"50M watched / 3600s ≈ 13.9K/sec"**, **"150M long-tail / 86400s ≈ 1.7K/sec"**, **"≈16K checks/sec steady state"**. Reads run roughly 3× that, **"≈48K/sec"**, off the read-to-ingestion-write ratio. Write the totals down.' },
      ],
      grading: "Are the freshness and notification SLAs pinned in numbers, and is crawl throughput derived from the catalog split rather than guessed?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "A handful of endpoints, an immutable price-sample row, and the tiered-schedule justification stated up front.",
      why: "Committing to a small surface and a write-once row signals you know this is a time-series ingestion problem with a KV read on top, not a CRUD app.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /watch { productId, threshold }"**, **"GET /products/:id"** returns current price + chart, **"POST /products { url | upc }"** starts tracking a new product.' },
        { kind: "DRAW", text: 'Sketch the price-sample row: **"product_id (partition key)"**, **"observed_at (clustering key, desc)"**, **"price"**, **"currency"**, **"merchant_id"**. Say: "Samples never change after insert — a new price is a new row, not an update."' },
        { kind: "SAY", text: 'State the tiering up front: "watched products, ~50M, get polled every 60 minutes; the other ~150M get polled once a day. Priority isn\'t flat, it\'s watch count plus volatility plus staleness."' },
      ],
      grading: "Crisp endpoints, an immutable row shape, and the tiering decision stated before being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: read, ingestion (write), and alert (async). Traffic numbers on the arrows, not just box names.",
      why: "Drawing ingestion and alerting as separate lanes from the read path proves you understand they have completely different SLAs and failure domains — an ingestion hiccup should never show up as a slow product page.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read lane**: Client → Product Service → Redis → ScyllaDB. Label **"~90% Redis hit, sub-50ms"**, **"miss → Scylla range scan"**.' },
        { kind: "DRAW", text: 'Add the **ingestion lane**: Crawl Scheduler → Crawl Workers → Kafka → Normalizer → ScyllaDB + Redis invalidation. Label **"~16K checks/sec"**, **"merchant API first, scrape fallback"**.' },
        { kind: "DRAW", text: 'Add the **alert lane** dropping off the Normalizer: → Kafka (price-changed-events) → Flink → Watch Index → Notification Service → channels. Label **"price-changed only"**, **"async, <5min p99"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes, three SLAs — reads are latency-critical for users, ingestion is throughput-critical for freshness, and alerting is correctness-critical: it must find the right subset of watchers, fast, without ever blocking ingestion."' },
      ],
      grading: "Three clearly separated lanes, arrows carrying real numbers, and an explicit statement that alerting never blocks ingestion.",
    },
    {
      n: 4,
      title: "Deep Dive: Product Identity and Staying Unblocked",
      minutes: 8,
      goal: "Defend the GTIN-first matching chain, and show the merchant-API-first / polite-scraping-fallback story.",
      why: "This is the signature ingestion sub-problem: unifying the same product across merchants who describe it differently, and doing it without getting the crawler blocked.",
      steps: [
        { kind: "SAY", text: 'Walk the matching chain: "GTIN/UPC is the primary key when present, about 70% of listings. Without one, narrow by category, brand, and price band, then score similarity with a classifier."' },
        { kind: "RULE OUT", text: 'One line each: **exact title match** → misses most duplicates. **SKU/MPN as key** → not standardized. **fuzzy title alone** → merges distinct variants. Cross each off.' },
        { kind: "SAY", text: 'Explain the confidence threshold: "Below the threshold we don\'t guess — we create a new canonical product and route it to a review queue."' },
        { kind: "SAY", text: 'Cover fetching: "Merchant APIs first — Amazon PA-API, Google Shopping. Where there\'s no API, polite scraping: robots.txt, proxy rotation, headless browser only for JS pages, and a per-domain circuit breaker so one merchant\'s block doesn\'t take the whole proxy pool down."' },
      ],
      grading: "The matching fallback chain stated with a confidence threshold (not a single trick), and the API-first/scrape-fallback story with a per-domain circuit breaker.",
    },
    {
      n: 5,
      title: "Deep Dive: Alert Fan-Out and the Synchronized Spike",
      minutes: 7,
      goal: "Walk the reverse watch index, then volunteer the Black Friday burst as the load-bearing risk.",
      why: "Anyone can say 'send a notification'. The interviewer wants an O(watchers-of-this-product) lookup, and — for the top score — the candidate quantifying the synchronized-spike risk before being asked.",
      steps: [
        { kind: "SAY", text: 'Explain the index: "A reverse index, product_id → watchers, so a price-changed event costs O(watchers of this product), not O(all 80M watches)."' },
        { kind: "SAY", text: 'Volunteer the spike: "This is sized for a trickle — about 800 change-events/sec normally. On Black Friday, a large share of the watched tier can change within the same hour, pushing that toward 50K/sec, a ~60× jump."' },
        { kind: "SAY", text: 'Name the mitigation: "Kafka buffers the burst so Flink and the notification service drain it at a safe rate, and outbound notifications are rate-limited per provider because APNs, SES, and Twilio all have their own ceilings."' },
      ],
      grading: "The reverse index explained without prompting, and the synchronized-spike risk quantified in numbers, not just 'traffic goes up'.",
    },
    {
      n: 6,
      title: "Wrap: Price Integrity, Bottlenecks, and Close",
      minutes: 5,
      goal: "Bring up price integrity unprompted, name the SLA tiers, push back on a requirement, and close with a one-sentence summary.",
      why: "Staff-level signal here is treating 'is this deal real' as part of the design, not an afterthought, plus the operational maturity to pace and close the interview cleanly.",
      steps: [
        { kind: "SAY", text: 'Bring up integrity unprompted: "We never trust a merchant\'s claimed \'was\' price — we use our own 30-90 day tracked low as the baseline and flag large divergence."' },
        { kind: "SAY", text: 'State the tiers: "Reads are tier-1, ingestion is tier-2, alerting is tier-3 in terms of what can degrade first — that hierarchy is what justifies Kafka as a shock absorber."' },
        { kind: "SAY", text: 'Push back where useful: "Do we really need 60-minute freshness for all 50M watched products, or just the top decile by watch count? That changes the crawl budget a lot."' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a tiered crawl-and-normalize pipeline feeding an immutable price history, with a reverse index for fast alert fan-out and its own tracked baseline for price integrity. With more time I\'d cover currency/regional pricing and the merchant onboarding flow."' },
      ],
      grading: "Price integrity volunteered without prompting, explicit tiers, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working pipeline — crawl, store, notify — but the crawl cadence, product matching, and alert cost stay hand-wavy.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: a crawler, a database, a queue, a notification worker.",
          "Knows prices need a history table, not just a single current-price field.",
          "Adds a cache in front of the database for product-page reads.",
          "Can write the watch/alert endpoints and a basic price row schema.",
          "Handles 'what if two merchants sell the same thing' by saying 'match on title'.",
        ],
        gaps: [
          "Polls every product on the same fixed interval, without a tiering or priority argument.",
          "Product matching stops at 'fuzzy string match', with no fallback chain or confidence threshold.",
          "Alert matching is described as 'check the watches', without addressing the scan-cost problem.",
          "No anti-blocking story — scraping is assumed to just work.",
          "No mention of storage growth or downsampling for 2 years of history.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, tiers the crawl schedule, defends product matching with a fallback chain, and builds a reverse index for alerts.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the catalog size, watch count, and freshness/notification SLAs on the board within the first 5 minutes.",
          "Tiers the crawl schedule by watch count and volatility, with real throughput numbers.",
          "Defends GTIN-first product matching with a fuzzy fallback and a confidence threshold.",
          "Builds a reverse watch index (product_id → watchers) instead of scanning all watches.",
          "Explains merchant-API-first, polite-scraping-fallback, with a per-domain circuit breaker.",
          "Separates ingestion, read, and alert paths as distinct lanes with distinct SLAs.",
          "Mentions downsampling for bounded price-history storage.",
        ],
        gaps: [
          "Volunteers the synchronized-spike (Black Friday) risk only after being prompted, not on their own.",
          "Doesn't bring up price integrity (fake 'was' price) unless asked directly.",
          "Quantifies the burst in words ('traffic spikes') rather than numbers ('~60× jump to 50K/sec').",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, names the load-bearing risk before being asked, and treats price integrity as core to the design, not a nice-to-have.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the synchronized-spike risk unprompted, with a quantified failure mode (~800/sec average to ~50K/sec burst, a ~60× jump).",
          "Brings up price integrity (own tracked baseline vs. merchant-claimed 'was' price) as a core design element, not an afterthought.",
          "Defines explicit SLA tiers (reads, ingestion, alerting) and uses that hierarchy to justify Kafka buffering and rate-limited notification delivery.",
          "Pushes back on requirements ('do we need 60-min freshness for all 50M watched, or just the top decile?').",
          "Names the write-time cost of the reverse watch index (every watch create/delete writes two places) as a deliberate trade-off, not a surprise.",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
          "Paces the 40 minutes, parks tangents (currency normalization, merchant onboarding), and returns to them only if time allows.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Polling all 200M products on a fixed interval with no tiering by watch count or volatility.",
      "Product matching that's just 'fuzzy string match the titles', with no fallback chain and no confidence threshold — silently merges different variants.",
      "Scanning every watch on every price change instead of a reverse index keyed by product_id.",
      "No anti-blocking plan, treating scraping as if merchants have no incentive to detect and block it.",
      "Trusting a merchant's displayed 'was' price as the source of truth for a claimed discount.",
      "Putting alert delivery on the same critical path as ingestion, so a notification-provider slowdown delays the next crawl cycle.",
      "No burst-capacity story for the alert pipeline — sizing only for the steady-state trickle.",
    ],
    followUps: [
      {
        q: "Why ScyllaDB for price history instead of a relational database or a pure time-series DB like InfluxDB?",
        a: "The access pattern is a classic wide-row shape — partition by product_id, cluster by timestamp — which Scylla/Cassandra serve natively at high write throughput with tunable consistency. A relational database would need constant reindexing and struggles at ~16K sustained writes/sec with 2 years of retention. A dedicated time-series DB (InfluxDB, TimescaleDB) is a reasonable alternative for the rollup/analytics side, but the operational simplicity of one store handling both current-price reads and history range-scans, at the multi-region scale this needs, favors Scylla here; ClickHouse is a good complementary choice specifically for the downsampled rollup tier if chart-query patterns get more analytical.",
      },
      {
        q: "What happens if the crawl scheduler falls behind during a traffic spike?",
        a: "Falling behind means watched-tier products drift past the 60-minute freshness target — that's a degraded-but-safe state, not an outage, because stale price data is still usable data, just older. The priority score naturally self-corrects: products with the longest time-since-last-check bubble to the top of the queue, so the system catches back up on its own once crawl capacity frees up, rather than needing a manual intervention.",
      },
      {
        q: "How do you avoid double-notifying a user when a price bounces around during a burst?",
        a: "Dedup by user_id + product_id + threshold within a short window (e.g. once every few minutes), and only notify again if the price crosses back above the threshold and then below it a second time — a re-check that finds the same already-notified drop is a no-op. The notification log itself is the source of truth for 'have we already told this user about this crossing', so retries and re-processed events in Flink don't cause duplicate sends.",
      },
      {
        q: "Why not just re-check a product's price the moment someone sets a watch on it?",
        a: "That's a reasonable addition, not a replacement for scheduled polling — it improves perceived freshness for the specific product the user just cared about, but the priority score should still promote that product into a faster tier going forward, because a single ad hoc check doesn't help the next user who watches it. It also has to respect the same per-domain rate limits as scheduled crawls, so a burst of new watches on one merchant's products can't be used to bypass politeness limits.",
      },
      {
        q: "How would you extend this to detect a fake 'was' price without enough tracked history yet?",
        a: "For a brand-new product with no baseline, fall back to cross-merchant comparison — if five other merchants sell the same canonical product (via the identity-matching pipeline) at a similar price, a claimed 'was' price wildly above all of them is suspicious even without historical data. As the service accumulates its own 30-90 day history on that product, the tracked baseline takes over as the primary signal and the cross-merchant check becomes a secondary corroboration rather than the only one.",
      },
      {
        q: "What's the failure mode if the product-identity matcher gets it wrong?",
        a: "Two failure directions, and they're asymmetric. A false merge (treating two different products as one) corrupts price history and can show a wildly wrong 'lowest ever' price, which is the worse outcome because it actively misleads users. A false split (treating the same product as two) just means duplicate listings and a slightly worse comparison experience. That asymmetry is exactly why the confidence threshold is tuned conservatively — refusing to merge and routing to review is cheaper than an incorrect merge.",
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
          "This is a tiered ingestion pipeline feeding an immutable price history, with a reverse index on top for fast alert fan-out. The expensive parts — adaptive crawl scheduling, product identity matching, anti-blocking — all exist to keep that history accurate and fresh; the alert path and the read path both just consume it.",
          "Anchor everything on a handful of numbers: 200M products, 50M watched, 80M active watches, ~16K checks/sec steady-state ingestion, and a 5-minute p99 notification SLA. Every structural choice below is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing and adaptive crawl tiering",
        body: [
          "Uniform polling of all 200M products at a useful cadence (say 15 minutes) needs roughly 222K checks/sec — infeasible and mostly wasted on products nobody watches. Splitting into a watched tier (~50M, 60-minute cadence, ~13.9K/sec) and a long-tail tier (~150M, 24-hour cadence, ~1.7K/sec) gets steady-state throughput down to a staffable ~16K checks/sec.",
          "Cadence isn't actually a fixed interval per tier — it's a priority score combining watch count, historical volatility, and time since last check, recomputed after every crawl, so a suddenly-popular product gets promoted automatically instead of waiting for a manual tier change.",
        ],
      },
      {
        heading: "Product identity without guessing",
        body: [
          "The same physical product shows up under different titles on different merchants, so a scraped listing needs to resolve to a canonical product_id. GTIN/UPC/EAN, present on roughly 70% of listings, is the authoritative primary key. When it's missing, narrow candidates by category, brand, and price band, score similarity with a classifier, and only auto-merge above a confidence threshold — below it, create a new product and route to review rather than guess.",
          "Exact title matching misses most real duplicates; SKU/MPN isn't standardized across sellers; fuzzy title matching alone merges distinct variants. The fallback chain with a confidence gate is what avoids both failure directions — false merges (which corrupt price history) and false splits (which just mean duplicate listings).",
        ],
      },
      {
        heading: "Fetching data without getting blocked",
        body: [
          "Merchant APIs (Amazon PA-API, Google Shopping Content API, affiliate feeds) are preferred wherever they exist: structured, high rate limits, no ambiguity. Where no API exists, scraping falls back to static HTML first, a headless browser only for JS-rendered pages, robots.txt and crawl-delay respected, and a rotating proxy pool so requests don't concentrate on one IP.",
          "A per-domain circuit breaker tracks success rate and backs off automatically on a spike in blocks, because an unthrottled scraper risks getting an entire shared proxy pool banned — taking every merchant on that pool offline at once, not just the one that objected.",
        ],
      },
      {
        heading: "Bounded storage for 2 years of history",
        body: [
          "Prices are stored as a wide row: product_id as partition key, timestamp as clustering key, immutable on write. Raw samples are kept for a 30-day rolling window (~6TB, ~18TB at RF=3), then collapsed into daily min/max/avg rollups for the remaining retention (~730 days, another ~6TB/~18TB at RF=3) — bounding storage growth regardless of crawl frequency, at the cost of losing intra-day granularity for anything older than a month.",
        ],
      },
      {
        heading: "Alert fan-out and the synchronized-spike risk",
        body: [
          "A price-changed event looks up a reverse index (product_id → watchers) instead of scanning all 80M watches — O(watchers of this product), the same shape as any fan-out problem, paid for by a small extra write whenever a watch is created or deleted.",
          "The pipeline's steady-state sizing (~800 change-events/sec, about 5% of checks) is not the number that matters most. On a day like Black Friday, a large share of the watched tier can change price within the same hour, pushing throughput toward a provisioned peak of 50K/sec — a ~60× jump. Kafka buffers that burst, and outbound notifications are rate-limited per provider (APNs, SES, Twilio all have their own ceilings) so the notification service degrades gracefully instead of getting throttled by the very providers it depends on. Price integrity closes the loop: the service's own 30-90 day tracked low, not the merchant's claimed 'was' price, is the baseline for deciding whether a discount is real.",
        ],
      },
    ],
  },
};
