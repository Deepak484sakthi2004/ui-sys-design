import type { Problem } from "@/lib/types";

export const yelp: Problem = {
  slug: "yelp",
  num: "6.5",
  title: "Design Yelp",
  level: "Medium",
  deepDiveAvailable: true,
  intro: [
    "Design a local-business search and review platform covering 50M businesses and ~300M reviews, serving 20K geo-constrained searches/sec with a p99 under 200ms, while accepting 1K review writes/sec (5K peak) and keeping the displayed star rating fast to read and honest against fake reviews.",
  ],
  hardParts:
    "The hard parts: making 'near me' a cheap query instead of a scatter-gather across every shard, keeping the visible average rating both O(1) to read and correct as fraud detection reclassifies reviews after the fact, and absorbing the extreme skew of one viral business or one dense metro without melting a single shard.",
  keyTopics: [
    "Geo-Sharded Search (S2 / Geohash)",
    "Denormalized Rating Aggregates",
    "CDC-Driven Async Fan-out",
    "Recommended vs. Filtered Reviews",
    "Zipf Hot Spots (Businesses & Metros)",
  ],
  foundationsReferenced: [
    { label: "Elasticsearch / Lucene", tone: "purple" },
    { label: "Geohashing / S2 Cells", tone: "green" },
    { label: "CDC (Change Data Capture)", tone: "orange" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "CAP Theorem", tone: "blue" },
    { label: "Valkey / Redis", tone: "purple" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "lb", label: "Regional LB", col: 2, row: 1, tone: "slate" },
      {
        id: "search_svc",
        label: "Search Service",
        sub: "geo + text · 20K qps",
        mono: "resolve query → geo-cell(s)",
        col: 3,
        row: 2,
        tone: "green",
      },
      { id: "es", label: "Elasticsearch", sub: "sharded by geography", col: 4, row: 2, tone: "green" },
      { id: "cache", label: "Redis", sub: "~90% detail-page hit", col: 5, row: 2, tone: "green" },
      { id: "review_svc", label: "Review Service", sub: "rate limit + dedup", col: 2, row: 3, tone: "purple" },
      {
        id: "primary_db",
        label: "Primary DB",
        sub: "sharded by business_id",
        mono: "sum_rating · review_count",
        col: 4,
        row: 3,
        tone: "blue",
      },
      { id: "cdc", label: "Kafka (CDC)", col: 2, row: 4, tone: "orange" },
      { id: "fraud", label: "Fraud / ML Scorer", sub: "async, minutes-scale", col: 3, row: 4, tone: "orange" },
      { id: "aggregator", label: "Rating Aggregator", sub: "signed delta, not recompute", col: 4, row: 4, tone: "orange" },
      { id: "indexer", label: "Indexer", sub: "near-real-time upsert", col: 5, row: 4, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "lb", kind: "read" },
      { from: "lb", to: "search_svc", label: "20K qps", kind: "read" },
      { from: "search_svc", to: "es", label: "geo-cell prefix query", kind: "read" },
      { from: "search_svc", to: "cache", label: "hydrate card", kind: "read" },
      { from: "cache", to: "primary_db", label: "miss", kind: "read" },
      { from: "lb", to: "review_svc", label: "~1K/s, 5K peak", kind: "write" },
      { from: "review_svc", to: "primary_db", label: "insert review", kind: "write" },
      { from: "primary_db", to: "cdc", label: "CDC / binlog", kind: "analytics" },
      { from: "cdc", to: "fraud", label: "score review", kind: "analytics" },
      { from: "cdc", to: "indexer", label: "reindex business", kind: "analytics" },
      { from: "cdc", to: "aggregator", label: "review event", kind: "analytics" },
      { from: "fraud", to: "aggregator", label: "recommended flag", kind: "analytics" },
      { from: "aggregator", to: "primary_db", label: "update denormalized rating", kind: "write" },
      { from: "aggregator", to: "cache", label: "invalidate on write", kind: "write" },
      { from: "indexer", to: "es", label: "near-real-time upsert", kind: "write" },
    ],
    legend: [
      { kind: "read", text: "read path · 20K searches/s" },
      { kind: "write", text: "write path · 1K review writes/s (5K peak)" },
      { kind: "analytics", text: "async · fraud, aggregation, reindex — never blocks a write" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "lb", "search_svc", "review_svc"],
      say: "Two stateless services behind a regional load balancer, search and review, so a spike in review writes can never slow down a search.",
    },
    {
      reveal: ["es", "primary_db"],
      say: "Each service gets its own store: Elasticsearch, sharded by geography so a local query never scatter-gathers, and a primary DB sharded by business_id holding the source-of-truth rows plus the denormalized rating.",
    },
    {
      reveal: ["cache"],
      say: "Detail-page reads are heavily Zipf-skewed, so Redis sits in front of the primary DB, catching about 90 percent of hydration calls before they ever touch the database.",
    },
    {
      reveal: ["cdc"],
      say: "Every write to the primary DB streams out through CDC — that's the seam that lets everything downstream stay off the write's critical path.",
    },
    {
      reveal: ["fraud", "aggregator", "indexer"],
      say: "Three consumers fan out from that one stream: fraud scoring that can reclassify a review days later, a rating aggregator that applies signed deltas and also invalidates the cache, and an indexer that keeps Elasticsearch near-real-time — none of them ever block a write.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Search businesses by free-text query + location (GPS, address, or city) with a radius", tag: "P0" },
      { id: "FR-02", text: "Filter and sort results by category, price, star rating, distance, and 'open now'", tag: "P0" },
      { id: "FR-03", text: "Business detail page: name, address, hours, category, photos, phone, aggregate rating + count", tag: "P0" },
      { id: "FR-04", text: "Submit a 1-5 star rating + text review (+ optional photos), one review per (user, business)", tag: "P0" },
      { id: "FR-05", text: "Edit or delete your own review", tag: "P1" },
      { id: "FR-06", text: "Aggregate rating shown per business, computed only from 'recommended' (non-fraud) reviews", tag: "P0" },
      { id: "FR-07", text: "Automated fraud/spam detection that filters suspicious reviews out of the visible average", tag: "P0" },
      { id: "FR-08", text: "Typeahead/autocomplete for business name and category while typing", tag: "P1" },
      { id: "FR-09", text: "Business owners can claim a listing and edit hours/photos/menu", tag: "P1" },
      { id: "FR-10", text: "Check-ins and a lightweight 'trending nearby' signal", tag: "P2" },
      { id: "FR-11", text: "Rank results by a blend of text relevance, distance, and rating/popularity, not distance alone", tag: "P0" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Search latency, server-side", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "Business detail page load, cache hit", tag: "p99 < 50ms" },
      { id: "NFR-03", text: "Search throughput, sustained globally", tag: "20K qps" },
      { id: "NFR-04", text: "Review write throughput, sustained (peak in parens)", tag: "1K/s (5K peak)" },
      { id: "NFR-05", text: "Availability (about 4.4h downtime/year)", tag: "99.95%" },
      { id: "NFR-06", text: "Review durability: no data loss once accepted", tag: "zero loss" },
      { id: "NFR-07", text: "Visible rating-aggregate freshness, from write/reclassify to display", tag: "< 60s" },
      { id: "NFR-08", text: "Read-to-write ratio that anchors the whole design", tag: "~20:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why 'near me' can't just be a WHERE clause",
      body: [
        "A naive query — WHERE lat BETWEEN x1 AND x2 AND lon BETWEEN y1 AND y2, then filter by haversine distance — sounds fine until you notice a B-tree index only makes one predicate cheap. Combined with the other dimension it still degrades to scanning a wide candidate box before the real circular filter even runs, on a table of 50M rows, 20K times a second. The fix is to stop treating latitude and longitude as two independent dimensions.",
        "Geohashing (or Google's S2 cells) maps a (lat, lon) pair onto a space-filling curve, so nearby points end up sharing a common string prefix. 'Near' becomes a prefix range query on a single sorted index instead of two independent range predicates — but only if you also handle the boundary problem: a point one meter across a cell edge is technically in a different cell.",
      ],
      bullets: [
        { lead: "Two independent B-tree ranges", text: "a composite index only makes one predicate cheap; combined with the other it still scans a wide candidate box before the real haversine filter runs." },
        { lead: "Geohash / S2 cell", text: "maps (lat, lon) to a 1-D string that preserves locality, turning 'near' into a prefix match on one sorted index." },
        { lead: "Boundary problem", text: "a point just across a cell edge is technically a different cell string, so a correct radius query touches the center cell plus its ~8 neighbors, not one." },
        { lead: "Precision tradeoff", text: "geohash length 6 ≈ a 1.2km × 0.6km cell; too coarse and you fan out to fewer, huge cells; too fine and a query needs to touch hundreds of tiny ones." },
      ],
      pictureTitle: "Why 'near me' can't just be a WHERE clause",
      pictureRows: [
        { label: "lat BETWEEN + lon BETWEEN", value: "scans a wide box, then filters by haversine", tone: "bad" },
        { label: "geohash/S2 prefix range", value: "one sorted index, true locality", tone: "good" },
        { label: "query only the exact cell", value: "misses points just across the boundary", tone: "bad" },
        { label: "query cell + 8 neighbors", value: "correct radius coverage", tone: "good" },
      ],
      remember: {
        problem: "A 2D 'find businesses near me' query can't be served by a normal B-tree index.",
        solution: "Encode (lat, lon) into a geohash/S2 cell id so proximity becomes a 1-D prefix range query.",
        why: "A space-filling curve keeps nearby points as nearby strings, turning two independent range predicates into one sorted-index lookup.",
        tradeoff: "Must query the cell plus its ~8 neighbors to avoid losing points just across a boundary, and pick a cell size that balances fan-out against precision.",
        failure: "Querying only the exact cell silently drops real nearby results sitting just across the edge.",
        mitigation: "Always expand the query to the neighboring ring of cells at the chosen precision level.",
      },
    },
    {
      n: 2,
      title: "Geo-sharding the search index, not by business id",
      body: [
        "Elasticsearch's default shard-by-document-id pattern spreads NYC and Tokyo restaurants evenly across every shard. At 50M businesses and 20K qps, that means 'sushi in NYC' scatter-gathers across every single shard, and p99 is set by the slowest of N — doing hundreds of times more work than the query actually needs.",
        "Because more than 95% of searches carry an implicit or explicit location, shard the index by geography — metro region or a coarse geo-cell — instead of by id hash. NYC lives on 2-3 shards; a NYC query only touches those. This is the same load-bearing move as region-prefixed IDs in a URL shortener: exploit the one dimension almost every request already has.",
      ],
      bullets: [
        { lead: "Shard by business_id hash (default)", text: "balances write load evenly, but every search touches every shard — reject for a search-heavy read path." },
        { lead: "Shard by metro / coarse geo-cell", text: "NYC lives on 2-3 shards, Tokyo lives on different ones; a local query only fans out to the shards that could possibly answer it." },
        { lead: "Skew risk", text: "NYC and SF have far more businesses than rural shards, so geo-shards need independent sizing — more replicas for dense metros, not a uniform shard count." },
        { lead: "Cross-shard edge cases", text: "a search near a metro boundary still queries 2 shards instead of 1, but that's 2, not 200." },
      ],
      pictureTitle: "Shard the search index by geography, not by ID hash",
      pictureRows: [
        { label: "Shard by business_id hash", value: "every query scatter-gathers all N shards", tone: "bad" },
        { label: "Shard by metro / geo-cell", value: "a local query touches 2-3 shards", tone: "good" },
        { label: "Dense metro (NYC, SF)", value: "needs more replicas than a rural shard", tone: "neutral" },
      ],
      remember: {
        problem: "Search queries scatter-gather across every shard because the index is sharded by business_id hash.",
        solution: "Shard the search index by geography (metro region / coarse geo-cell) instead of by id.",
        why: "Over 95% of searches carry a location, so co-locating nearby businesses turns a global fan-out into a 2-3 shard query.",
        tradeoff: "Geo-shards are unevenly sized (NYC vs. a rural county) and need independent capacity, unlike a uniform hash shard.",
        failure: "ID-hash sharding makes every query touch every shard, so p99 search latency is set by your slowest shard, always.",
        mitigation: "Size shards/replicas per metro density and route by the same geo-cell used to build the index.",
      },
    },
    {
      n: 3,
      title: "Ranking: relevance, distance decay, and a trustworthy rating",
      body: [
        "Ranking by distance alone surfaces the nearest 2.1-star dive over a slightly farther 4.8-star gem. Combine text relevance (BM25 over name, category tags, and review text), a distance-decay function that degrades smoothly past 1-2km instead of a hard cutoff, and the rating itself weighted by a confidence term so a handful of reviews can't outrank an established business.",
        "Hard filters — open-now, price, category — run first, cheaply, to shrink the candidate set before the expensive scoring runs over it.",
      ],
      bullets: [
        { lead: "Text relevance (BM25)", text: "matches query terms against name, category tags, and review text — what makes 'cheap tacos' find a business tagged 'Mexican, $' with no exact name match." },
        { lead: "Distance decay, not a hard cutoff", text: "score degrades smoothly past ~1-2km, so a slightly-farther great business can still outrank a mediocre one next door." },
        { lead: "Rating needs a confidence term", text: "a naive average lets a 5.0 from 2 reviews beat a 4.6 from 800; weight the rating by review count (a Bayesian/Wilson-style adjustment) so small samples don't dominate." },
        { lead: "Filters narrow before ranking", text: "open-now, price, and category are cheap boolean checks applied first, so scoring only runs over businesses that could actually be shown." },
      ],
      pictureTitle: "What goes into the ranking score?",
      pictureRows: [
        { label: "Text relevance (BM25)", value: "matches name / category / review text", tone: "used" },
        { label: "Distance decay", value: "smooth falloff past ~1-2km, not a cutoff", tone: "used" },
        { label: "Rating × confidence(review count)", value: "5.0 from 2 reviews loses to 4.6 from 800", tone: "used" },
        { label: "Open-now / price filters", value: "applied before scoring, not after", tone: "neutral" },
      ],
      remember: {
        problem: "Ranking by distance alone surfaces the nearest bad business over a slightly farther great one.",
        solution: "Blend BM25 text relevance, a distance-decay function, and a review-count-weighted rating into one score, with hard filters applied first.",
        why: "Each signal alone is gameable or wrong: nearest ignores quality, raw average ignores sample size.",
        tradeoff: "Tuning the blend weights is an ongoing product decision — it directly shapes which businesses get visibility.",
        failure: "An unweighted average lets a handful of 5-star reviews (real or fake) outrank an established business with hundreds of good ones.",
        mitigation: "Use a review-count-aware confidence adjustment and keep the weighting tunable and monitored.",
      },
    },
    {
      n: 4,
      title: "Denormalized ratings and the 'recommended reviews' twist",
      body: [
        "Computing AVG(rating) from the reviews table on every page view means a scan that grows forever — unacceptable at 20K qps on detail pages. The standard fix is a denormalized counter: store sum_rating and review_count on the business row, updated on write, so a read is one row lookup.",
        "The twist is that not every review counts. An ML fraud/quality filter decides which reviews are 'recommended,' and that classification can flip after the fact — a review can be provisionally visible today and reclassified as fraud days later once the model has more signal. So the counter can't be increment-only; it has to move in either direction as reviews get reclassified.",
      ],
      bullets: [
        { lead: "Naive: AVG() on every read", text: "a full scan of a growing reviews table on every one of 20K/sec detail-page views — doesn't scale past a few thousand reviews per business." },
        { lead: "Denormalized counter", text: "store sum and count on the business row; a read is now a single-row lookup, not an aggregation query." },
        { lead: "Reviews aren't static", text: "the fraud model can flip a review's recommended status after the fact, so the counter must support decrement-and-recompute, not just increment." },
        { lead: "Two counters", text: "a visible (recommended-only) sum/count drives the public average; a shadow full sum/count feeds internal signals like fraud rate — the two diverge on purpose." },
      ],
      pictureTitle: "Where does the rating a user sees come from?",
      pictureRows: [
        { label: "AVG(rating) on every read", value: "full scan, doesn't scale", tone: "bad" },
        { label: "Denormalized sum/count on the row", value: "O(1) read, updated on write", tone: "good" },
        { label: "Review reclassified as fraud later", value: "counter must move down, not just up", tone: "neutral" },
        { label: "Visible vs. shadow counters", value: "public average excludes non-recommended reviews", tone: "used" },
      ],
      remember: {
        problem: "The average rating a user sees must be O(1) to read but can't be increment-only, because reviews get reclassified after the fact.",
        solution: "A denormalized (sum, count) pair on the business row, updated asynchronously by a CDC-driven aggregator applying signed deltas as reviews are written or reclassified.",
        why: "Detail pages are read far more than reviews are written, so the read must be a single-row lookup — but fraud classification isn't final at write time, so the aggregate has to be revisable.",
        tradeoff: "The visible average lags the true state of the world by the aggregation pipeline's freshness window (seconds to about a minute).",
        failure: "A pure increment-on-write counter can't retract a review later flagged as fraud, so the public average silently includes reviews the anti-fraud system already rejected.",
        mitigation: "Route every review write and every reclassification event through one CDC/Kafka pipeline into one aggregator, always updating via a signed delta, never an unconditional set.",
      },
    },
    {
      n: 5,
      title: "Fraud/spam scoring off the write path",
      body: [
        "A review submission has to return fast — it's the write critical path, and users expect it to appear immediately. Real fraud detection (account age, review velocity, IP/device clustering, incentivized-review language patterns, cross-business collusion) is too expensive to run synchronously inside that transaction.",
        "So the write path does cheap, fast checks only and commits immediately; the expensive ML scoring runs asynchronously off the same Kafka event stream and can later flip a review's recommended flag — exactly the reclassification the rating aggregator has to absorb.",
      ],
      bullets: [
        { lead: "Fast path: cheap heuristics only", text: "rate limiting, basic bot/duplicate detection, and a review-per-(user,business) uniqueness check — all sub-10ms — are the only things allowed to block the write." },
        { lead: "Slow path: async ML scoring", text: "account age, review velocity, IP/device fingerprint clustering, and text-similarity-to-known-spam run off the CDC stream, seconds to minutes after the review lands." },
        { lead: "The review is live before it's judged", text: "a new review shows up immediately and can be reclassified afterward, which is why a business's review count can quietly move down days later." },
        { lead: "Never block the write for a model call", text: "the review write is tier-1; the fraud model is tier-2 and must never add its latency to the submission path." },
      ],
      pictureTitle: "What runs synchronously vs. async on a review write?",
      pictureRows: [
        { label: "Rate limit + duplicate check", value: "sub-10ms, blocks the write", tone: "used" },
        { label: "ML fraud/quality scoring", value: "async off Kafka, seconds to minutes later", tone: "neutral" },
        { label: "Score on the write path", value: "adds model latency to every submission", tone: "bad" },
        { label: "Review reclassified after the fact", value: "feeds back into the rating aggregator", tone: "good" },
      ],
      remember: {
        problem: "Fraud detection is too expensive to run inside the review-write transaction, but reviews still need to be policed.",
        solution: "Cheap synchronous checks (rate limit, duplicate) gate the write; expensive ML scoring runs asynchronously off Kafka and can reclassify a review after it's already live.",
        why: "The write path is tier-1 and latency-sensitive; a fraud model call is tier-2 work that must never block it.",
        tradeoff: "A fraudulent review can be visible — and count toward the average — for the window between submission and async scoring.",
        failure: "Running the full fraud model synchronously turns every review submission into a multi-hundred-millisecond call and couples write availability to model-serving availability.",
        mitigation: "Keep the fast path to boolean rate-limit/duplicate checks only, and let the async reclassification pipeline correct the record within its freshness SLA.",
      },
    },
    {
      n: 6,
      title: "Caching hot businesses and hot cities",
      body: [
        "Business detail pages are heavily Zipf-distributed — the top 'best of the city' restaurant gets orders of magnitude more views than a median business, and a viral moment (a TikTok review, a celebrity visit) can spike one business's traffic 100x in minutes.",
        "Cache detail pages in Redis, but invalidate on the aggregator's write event rather than a pure TTL — a stale rating right after a business gets a wave of new reviews is a trust problem, not just a UX one.",
      ],
      bullets: [
        { lead: "Zipf reads, same as any consumer product", text: "a small set of 'best of the city' businesses account for a hugely disproportionate share of page views; caching those few pages absorbs most read load." },
        { lead: "Event-driven invalidation, not just TTL", text: "when the rating aggregator updates a business's denormalized counters, it also invalidates that business's cache entry, so a review doesn't wait a full TTL window to show up." },
        { lead: "Viral spike on one business", text: "a single business can flash to far more traffic than its geo-shard would predict; a thin in-process/edge cache layer in front of shared Redis absorbs it, the same pattern as any hot key." },
        { lead: "City-level hot spots", text: "dense metro geo-shards (NYC, SF) carry proportionally more search and detail-page traffic than sparse ones, so capacity planning has to be per-shard, not uniform." },
      ],
      pictureTitle: "Absorbing Zipf traffic on business pages",
      pictureRows: [
        { label: "Top 'best of city' businesses", value: "disproportionate share of page views", tone: "neutral" },
        { label: "TTL-only cache", value: "a fresh 1-star review can take minutes to show", tone: "bad" },
        { label: "Event-driven invalidation on write", value: "cache refreshed the moment the aggregate changes", tone: "good" },
        { label: "Single viral business", value: "same in-process + edge pattern as any hot key", tone: "used" },
      ],
      remember: {
        problem: "Business page traffic is heavily skewed (Zipf) and a stale cached rating right after a review write is a trust problem.",
        solution: "Cache detail pages in Redis, plus a thin in-process layer for viral spikes, and invalidate on the same event that updates the rating aggregator, not just on TTL.",
        why: "A few businesses account for most reads, so caching them absorbs the bulk of load; but ratings are trust-sensitive, so an 'eventually consistent within a TTL window' cache isn't good enough right after a review lands.",
        tradeoff: "Event-driven invalidation adds a dependency from the write/aggregation pipeline into the cache layer, more moving parts than a pure TTL cache.",
        failure: "A pure TTL cache can show a stale rating for minutes right after a business gets a burst of new reviews, exactly when users are most likely looking.",
        mitigation: "Have the same aggregator that updates the denormalized counters also emit a cache invalidation/refresh for that business_id.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a geo-constrained search problem wrapped around a read-heavy review store: find nearby businesses fast, then show a rating that's trustworthy, not just an unfiltered average.",
      "The search index is sharded by geography, not by business id, because almost every query already carries a location — that's what keeps a query from scatter-gathering across every shard.",
      "Ranking blends text relevance, distance decay, and a review-count-weighted rating, so the nearest mediocre business doesn't beat a slightly farther great one.",
      "The visible average rating comes from a denormalized counter that only counts 'recommended' reviews, updated asynchronously by a CDC pipeline that can move the count in either direction as fraud scoring reclassifies reviews.",
      "Fraud detection runs entirely off the write path — the review commits fast, and an async ML model can reclassify it minutes later.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 20K/S · P99 < 200MS",
        summary:
          "A search carries a location almost every time, so it's routed straight to the shard(s) that could actually answer it instead of fanning out globally.",
        steps: [
          { label: "Client", note: "types 'sushi' with GPS or a city" },
          { label: "Regional LB", note: "routes to a nearby search pod" },
          { label: "Search Service", note: "resolves query to geo-cell(s)" },
          { label: "Elasticsearch", note: "geo-sharded, 2-3 shards touched, not all" },
          { label: "Rank & filter", note: "BM25 × distance decay × rating confidence" },
          { label: "Redis", note: "hydrate business cards, ~90% hit" },
          { label: "Response", note: "ranked list with rating, distance, price" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · 1K/S (5K PEAK)",
        summary:
          "The write only has to survive fast, cheap checks; everything expensive about judging the review happens later, off this path.",
        steps: [
          { label: "Client", note: "submits star rating + text (+ photos)" },
          { label: "Regional LB", note: "nearby region" },
          { label: "Review Service", note: "rate limit + duplicate (user,business) check, sub-10ms" },
          { label: "Primary DB", note: "insert review row, durable commit" },
          { label: "CDC / Kafka", note: "binlog event, async — review is already live" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · AGGREGATION, FRAUD, REINDEX · NEVER BLOCKS A WRITE",
        summary:
          "One CDC stream fans out to three independent consumers — fraud scoring, rating aggregation, and search reindexing — none of which can slow down a review submission.",
        steps: [
          { label: "Kafka (CDC)", note: "one review-write event" },
          { label: "Fraud / ML Scorer", note: "seconds-minutes later, can flip the recommended flag" },
          { label: "Rating Aggregator", note: "applies signed delta to sum/count, not a full recompute" },
          { label: "Indexer", note: "near-real-time upsert into Elasticsearch" },
          { label: "Business row + search index", note: "both converge within the freshness SLA" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "50M businesses, ~300M reviews (~6/business avg)",
          "Search: 20K qps sustained, p99 < 200ms",
          "Reviews: 1K/sec sustained writes, 5K/sec peak",
          "Read:write ratio ~20:1 anchors the whole design",
          "Geo-cell size: geohash/S2 precision 6 ≈ 1.2km × 0.6km",
          "Rating aggregate freshness target: < 60s",
          "Redis holds the hot fraction of businesses, ~90% detail-page hit rate",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Search index sharded by geography (metro/geo-cell), not by business_id hash",
          "Ranking = BM25 text relevance × distance decay × review-count-weighted rating, filters first",
          "Denormalized (sum, count) rating on the business row, not AVG() at read time",
          "Two counters: visible (recommended-only) vs. shadow (full) — average is filtered, not raw",
          "Fraud scoring is fully async off Kafka/CDC, never on the review write path",
          "Cache invalidation on the aggregator's write event, not just a TTL",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Query the geo-cell plus its ~8 neighbors, not just the exact cell, to avoid dropping boundary results",
          "The public average rating is not the true average — it's the average of reviews the fraud model currently trusts",
          "A review can be reclassified days after posting, so the aggregate must support signed deltas, not just increment",
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
      goal: "Get five numbers and three product decisions on the board before drawing anything, so nothing surprises you later.",
      why: "Every later decision (geo-shard size, cache size, ranking weights) is a consequence of these numbers, not a preference. Locking them first is what separates driving the design from guessing at it.",
      steps: [
        { kind: "ASK", text: '**Is this read-heavy or write-heavy?** Walk them to "20K searches/sec" vs "1K review writes/sec", a "~20:1" ratio. Write **"20K r/s search, 1K w/s reviews, 20:1"** in the top-left corner.' },
        { kind: "ASK", text: 'Next: **"Are searches global or local?"** Land on "almost every search carries a location — metro-local, not global fan-out". Write **"location-scoped, not global"** underneath.' },
        { kind: "SAY", text: 'Propose latency targets yourself: **"search p99 < 200ms"**, **"cached detail page p99 < 50ms"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "geo search", "ranking", "review writes", "rating aggregation", "fraud filtering". Out: "payments", "messaging", "ads". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the storage math out loud: **"50M businesses × ~2KB ≈ 100GB"**, **"300M reviews × ~1KB ≈ 300GB"**, **"replicated 3x for durability"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, parking out-of-scope items deliberately, and locking the latency budget before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two or three endpoints, one denormalized row, and the geo-cell precomputed on the business row.",
      why: "The interviewer wants to see you commit to a small surface and defend the denormalization choice before being asked — it's the tell that you already know AVG() at read time doesn't scale.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"GET /search?q=&lat=&lon=&radius=&filters"** → ranked list. **"GET /business/:id"** → detail + aggregate. **"POST /business/:id/reviews { rating, text, photos? }"** → review id, rate-limited per user.' },
        { kind: "DRAW", text: 'Sketch the business row: **"id, name, geo_cell, category, hours"**, **"sum_rating, review_count_visible, review_count_total"**. Sketch the review row: **"id, business_id, user_id, rating, text, recommended (bool), created_at"**.' },
        { kind: "SAY", text: '"The geo-cell is precomputed and stored on the row, not derived at query time — so indexing and search both use the same value without recomputing a geohash on every write or every query."' },
        { kind: "RULE OUT", text: '"AVG(rating) at read time doesn\'t scale past a few thousand reviews per business — I\'ll denormalize sum and count on the row instead." Cross it off before it gets suggested.' },
      ],
      grading: "Crisp endpoint names, a two-table data model, and the denormalized-counter decision volunteered before being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: read (search), write (review), and async (fraud/aggregation/reindex).",
      why: "Drawing these as separate lanes proves you understand they have different SLAs. Candidates who draw one blob miss that fraud scoring and aggregation must never sit on the review-write path.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read lane**: Client → Regional LB → Search Service → Elasticsearch (geo-sharded) → rank/filter → Redis. Label arrows **"2-3 shards touched"**, **"~90% cache hit"**, not the boxes.' },
        { kind: "DRAW", text: 'Add the **write lane**: Client → Regional LB → Review Service (rate limit + dedup) → Primary DB, labeled **"1K/s, 5K peak · sub-10ms checks only"**.' },
        { kind: "DRAW", text: 'Add the **async lane** dropping off the Primary DB via CDC: → Kafka → {Fraud Scorer, Rating Aggregator, Indexer} → back into Primary DB and Elasticsearch, dashed, labeled **"never blocks a write"**.' },
        { kind: "SAY", text: '"Three lanes because they have three different SLAs — search and review writes are latency-critical, fraud scoring and aggregation are async and best-effort within a freshness window."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with shard counts / hit rates / latency budgets, and an explicit statement that fraud/aggregation never sit on the write path.",
    },
    {
      n: 4,
      title: "Deep Dive: Geo Search and Ranking",
      minutes: 8,
      goal: "Show geohash/S2 encoding, the boundary-neighbor fix, the geo-sharding decision, and the ranking formula.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can turn a 2D proximity query into something a normal index can answer, and whether you know why the index shard key matters as much as the query itself.",
      steps: [
        { kind: "DRAW", text: 'Draw a geo-cell grid: "geohash/S2, precision 6 ≈ 1.2km × 0.6km". "A point just across the edge is a different cell string, so I query the cell plus its ~8 neighbors and post-filter by real distance."' },
        { kind: "SAY", text: '"The search index is sharded by metro/geo-cell, not business_id hash — because 95%+ of queries carry a location, this turns a scatter-gather across every shard into a 2-3 shard query."' },
        { kind: "SAY", text: '"Ranking blends BM25 text relevance, a distance-decay function past ~1-2km, and rating weighted by a review-count confidence term. Filters — open-now, price — run first to shrink the candidate set."' },
        { kind: "RULE OUT", text: '"Shard by business_id hash" → every query touches every shard, reject for a search-heavy path. "Rank by distance alone" → nearest bad business beats a slightly farther great one, reject.' },
      ],
      grading: "The geo-cell + neighbor-ring detail on the board, the geo-sharding decision defended with a number (2-3 vs. N shards), and the ranking formula named without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: Rating Aggregation and Fraud",
      minutes: 7,
      goal: "Walk the denormalized counter, the visible-vs-shadow split, and the async fraud pipeline that can reclassify a live review.",
      why: "Anyone can say 'cache the average'. The interviewer wants the reclassification wrinkle — that the counter must support signed deltas in either direction, not just increments — volunteered, not extracted.",
      steps: [
        { kind: "SAY", text: '"A denormalized sum/count on the business row makes reads O(1). But reviews aren\'t static — the fraud model can reclassify a live review days later, so the counter needs signed deltas, not just increments."' },
        { kind: "SAY", text: '"I keep two counters: a visible one (recommended-only) that drives the public average, and a shadow full one for internal signals like fraud rate. The public number is filtered, not raw."' },
        { kind: "SAY", text: '"The review-write path only runs cheap checks — rate limit, duplicate (user, business). Real fraud scoring (velocity, IP clustering, text similarity) runs async off Kafka, seconds to minutes later, and can flip the flag."' },
        { kind: "SAY", text: '"Freshness target is under 60 seconds from a write or reclassification to the visible average updating — that\'s eventual consistency by design, not a bug."' },
      ],
      grading: "The visible-vs-shadow counter split named unprompted, the signed-delta requirement explained, and the async fraud pipeline explicitly kept off the write path.",
    },
    {
      n: 6,
      title: "Wrap: Hot Spots, Tiers, and Close",
      minutes: 5,
      goal: "Name the SLA tiers, the Zipf/viral-business caching story, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: naming hot-spot risk before being asked, framing capacity per-metro rather than uniform, and a clean close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: '"Search and review-write are tier-1, latency-critical. Fraud scoring and aggregation are tier-2/3, async and best-effort within the freshness SLA — that hierarchy is what justifies keeping them off the hot path."' },
        { kind: "SAY", text: '"Business page traffic is Zipf — a few \'best of the city\' pages dominate, and a viral moment can spike one business 100x. I cache in Redis plus a thin in-process layer, invalidated on the aggregator\'s write event, not just a TTL."' },
        { kind: "SAY", text: '"Dense metros like NYC or SF need more shard/replica capacity than a rural geo-cell — capacity planning has to be per-shard, not uniform."' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a geo-sharded search system wrapped around a fraud-aware, denormalized rating store. With more time I\'d cover photo storage/CDN, business-owner claim flow, and abuse beyond review fraud."' },
      ],
      grading: "Explicit SLA tiers, the Zipf/hot-spot risk volunteered with a concrete mitigation, per-metro capacity named, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but the geo and fraud-related tradeoffs stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, cache (usually 'Redis'), a database, and Elasticsearch if prompted.",
          "Picks geohash/S2 if prompted for how to store location, and knows what a radius query is.",
          "Knows searches dominate writes and adds a cache layer in front of the DB.",
          "Can write 2-3 endpoints and a two-table schema for businesses and reviews.",
          "Handles fraud by saying 'add a spam filter' when asked.",
        ],
        gaps: [
          "Doesn't discuss how the search index is sharded — treats Elasticsearch as a generic box.",
          "Computes the average rating with AVG() at read time, or a single increment-only counter.",
          "No mention of async fraud scoring or review reclassification.",
          "No hot-spot/Zipf discussion for viral businesses or dense metros.",
          "Multi-region or per-metro capacity is only added if directly asked.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks defaults with reasons, names tradeoffs when asked, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes qps, storage, and latency targets on the board within the first 5 minutes.",
          "Picks geo-sharding over business_id-hash sharding for the search index and can give a one-line reason.",
          "States the ranking formula (relevance × distance decay × rating confidence) without needing it drawn out of them.",
          "Denormalized (sum, count) rating counter, explained as O(1) read vs. O(n) aggregation.",
          "Keeps fraud scoring async off the review-write path.",
          "Acknowledges the Zipf/hot-business caching story when asked.",
        ],
        gaps: [
          "Volunteers the geo-cell boundary/neighbor-ring detail only after being asked, not on their own.",
          "Doesn't proactively raise that reviews get reclassified — treats the rating counter as increment-only until pushed.",
          "Quantifies failure modes in words ('cache gets stale') rather than numbers ('~60s freshness window').",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces risks before being asked, and brings operational maturity beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the geo-cell boundary problem unprompted, including the 'query the neighbor ring' fix, before the interviewer probes for edge cases.",
          "Names the visible-vs-shadow rating counter split as the load-bearing design decision and quantifies the ~60s staleness window.",
          "Defines explicit SLA tiers (search/write tier-1, fraud/aggregation tier-2/3) and uses that hierarchy to justify every async decision.",
          "Frames per-metro shard capacity as a planning problem, not an afterthought — dense metros get more replicas by design.",
          "Pushes back on requirements where useful ('does the rating need to update within 60s, or is a few minutes fine if it simplifies the pipeline?').",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
          "Treats the interviewer as a collaborator: paces the 40 minutes, parks tangents, returns to them only if there's room.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Sharding the search index by business_id hash and not noticing every query now scatter-gathers all shards.",
      "Computing AVG(rating) from the reviews table on every page view instead of a denormalized counter.",
      "Running fraud/ML scoring synchronously inside the review-write transaction.",
      "Treating the visible average rating as if it includes every review ever written, ignoring that fraud filtering changes what counts.",
      "No mention of the geo-cell boundary problem — querying only the exact cell and silently dropping nearby results.",
      "No hot-spot/Zipf story for viral businesses or dense metros; assuming uniform load across all shards and caches.",
      "Designing with no scale numbers, so shard count, cache size, and index size are all guesses.",
    ],
    followUps: [
      {
        q: "Why shard the search index by geography instead of the usual id-hash?",
        a: "Because nearly every query carries a location, id-hash sharding forces a scatter-gather across every shard for every query — you'd pay the tail latency of the slowest of N shards on 100% of searches. Geo-sharding co-locates businesses that could actually appear in the same result set, cutting fan-out from N shards to 2-3, at the cost of uneven shard sizing across dense vs. sparse metros, which you handle with per-shard replica counts instead of uniform capacity.",
      },
      {
        q: "What happens if a review gets reclassified as fraud after the average rating already reflects it?",
        a: "The fraud/ML scorer emits a reclassification event on the same CDC stream used for new reviews. The rating aggregator applies a negative delta to the visible sum/count, removing that review's contribution, while leaving it in the shadow full counters for internal tracking. The business's displayed average moves within the ~60s freshness window. This is exactly why the aggregate can't be a simple increment-only counter — it has to accept deltas in either direction.",
      },
      {
        q: "How do you avoid missing nearby results at a geo-cell boundary?",
        a: "Query the target cell plus its ring of ~8 neighboring cells at the chosen precision level, then post-filter by true haversine distance. A point one meter across a cell boundary produces a different cell string but can still be well inside the search radius, so a single-cell prefix query would silently drop it — the neighbor-ring expansion is what makes the geohash/S2 approach correct, not just fast.",
      },
      {
        q: "Why not just re-run AVG(rating) on read since the page is cached anyway?",
        a: "Caching hides the cost most of the time, but the cache still has to be filled or refreshed on every write and every reclassification event, and at 300M+ reviews growing continuously, the aggregation query used to fill it becomes the bottleneck. A denormalized (sum, count) pair on the row is O(1) to read and O(1) to update via a delta, independent of how many reviews exist for that business.",
      },
      {
        q: "How do you keep one viral business from melting your cache or search tier?",
        a: "An in-process/local cache layer in front of shared Redis absorbs the spike the same way a per-pod LRU absorbs a viral short URL — every app server serves the hot business's page from local memory for a short TTL, so the spike never concentrates on one Redis shard or one Elasticsearch shard. The geo-shard that business lives on doesn't need to be resized just because one business inside it went viral.",
      },
      {
        q: "Is this system strongly or eventually consistent for ratings?",
        a: "Eventually consistent by design, with a target freshness of under about 60 seconds from write (or reclassification) to a visible average update. Strong consistency would mean synchronously recomputing the aggregate and blocking the review write on it, which conflicts with keeping the write path fast and keeping fraud scoring — which is what determines whether a review even counts — fully off that path.",
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
          "This is a geo-constrained search problem wrapped around a read-heavy, fraud-aware review store. The core read — find nearby businesses ranked by relevance, distance, and a trustworthy rating — has to run at 20K qps with sub-200ms p99, and the core write — accept a review — has to commit fast while the expensive judgment about whether that review should count happens later.",
          "Anchor everything on five numbers: 50M businesses, ~300M reviews, 20K searches/sec, 1K review writes/sec (5K peak), and a ~20:1 read:write ratio. Every structural choice below is a consequence of these numbers.",
        ],
      },
      {
        heading: "Geo-indexing and the boundary problem",
        body: [
          "A normal B-tree index can't cheaply answer a 2D radius query — lat and lon are independent predicates, and combining them still degrades to scanning a wide box before a real haversine filter runs. Geohashing or S2 cells fix this by mapping (lat, lon) onto a space-filling curve, so nearby points share a string prefix and 'near' becomes a single sorted-index prefix range query.",
          "That only works correctly if you also query the neighboring ring of cells, not just the exact one — a point just across a cell boundary is a different cell string but can still be inside the search radius. Precision is a tradeoff: geohash-6 gives roughly 1.2km × 0.6km cells, coarse enough to avoid excessive fan-out, fine enough to keep result sets tight.",
        ],
      },
      {
        heading: "Sharding the search index by geography",
        body: [
          "Elasticsearch's default id-hash sharding spreads every metro's businesses evenly across all shards, which means a location-scoped query has to scatter-gather across every shard — hundreds of times more work than the query needs, with p99 set by the slowest shard. Since 95%+ of searches carry a location, shard the index by metro/geo-cell instead: a NYC query only touches NYC's 2-3 shards.",
          "This is the same load-bearing move as region-prefixed IDs in a URL shortener — exploit the one dimension almost every request already has. The cost is that geo-shards are unevenly sized; dense metros like NYC and SF need proportionally more replicas than a sparse rural shard, so capacity planning has to be per-shard.",
        ],
      },
      {
        heading: "Ranking: relevance, distance, and a trustworthy rating",
        body: [
          "Distance alone is the wrong ranking signal — the nearest business isn't necessarily the best one. Combine BM25 text relevance over name/category/review text, a distance-decay function that degrades smoothly rather than hard-cutting at the radius, and the rating itself weighted by a review-count confidence term so a 5.0 from two reviews doesn't outrank a 4.6 from eight hundred.",
          "Hard filters — open-now, price, category — run first as cheap boolean checks, shrinking the candidate set before the more expensive scoring runs over it.",
        ],
      },
      {
        heading: "Denormalized ratings and the recommended-reviews twist",
        body: [
          "AVG(rating) at read time doesn't scale once a business has thousands of reviews and the page is viewed at 20K qps globally, so the average is denormalized into (sum, count) on the business row — an O(1) read. The wrinkle unique to a review platform is that not every review counts toward that average: an async ML fraud/quality filter decides which reviews are 'recommended,' and that decision can flip after the review is already live.",
          "So the counter can't be increment-only. A CDC pipeline carries both new-review events and reclassification events into a rating aggregator that applies signed deltas, maintaining a visible (recommended-only) counter that drives the public average and a shadow (full) counter for internal signals — the average a user sees is the average of reviews the fraud model currently trusts, not literally every review ever written.",
        ],
      },
      {
        heading: "Fraud off the write path, and caching hot spots",
        body: [
          "The review write is tier-1: only cheap checks (rate limiting, duplicate detection) are allowed to block it. Real fraud scoring — account age, review velocity, IP/device clustering, text-similarity to known spam — runs asynchronously off the same CDC stream feeding the rating aggregator, and can reclassify a review minutes to days later.",
          "Business-page traffic is heavily Zipf-distributed, and a viral moment can spike one business's traffic 100x. Cache detail pages in Redis with a thin in-process layer for viral spikes, and invalidate on the rating aggregator's write event rather than a pure TTL, so a freshly-submitted review doesn't sit stale behind a cache for a full TTL window.",
        ],
      },
    ],
  },
};
