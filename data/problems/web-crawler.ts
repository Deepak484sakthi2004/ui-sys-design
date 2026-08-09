import type { Problem } from "@/lib/types";

export const webCrawler: Problem = {
  slug: "web-crawler",
  num: "2.4",
  title: "Design a Web Crawler",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a web crawler that discovers and fetches a 10-billion-page corpus, sustaining 10,000 fetches/sec across millions of distinct hosts, while never hammering any single site, never re-fetching a URL it has already seen, and refreshing already-indexed pages on a freshness schedule instead of a one-shot batch.",
  ],
  hardParts:
    "The hard parts: enforcing per-host politeness across a horizontally-scaled fleet without a global lock, deduplicating both URLs and near-duplicate content at a scale where an exact index doesn't fit in memory, and prioritizing 10B+ URLs in a frontier that stays fair so no single host or crawler trap consumes the whole fetch budget.",
  keyTopics: [
    "Mercator-Style URL Frontier (Front/Back Queues)",
    "Politeness via Consistent Hashing",
    "Bloom Filter Seen-URL Dedup",
    "SimHash Near-Duplicate Detection",
    "Change-Rate-Weighted Recrawl Scheduling",
  ],
  foundationsReferenced: [
    { label: "Bloom Filters", tone: "green" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Kafka", tone: "orange" },
    { label: "HDFS / S3", tone: "blue" },
    { label: "Token Bucket Rate Limiting", tone: "purple" },
    { label: "MapReduce / Batch Processing", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "seeds", label: "Seed URLs", col: 1, row: 1, tone: "slate" },
      {
        id: "frontier",
        label: "URL Frontier",
        sub: "priority front queues",
        mono: "1 back queue per host (Mercator)",
        col: 2,
        row: 1,
        tone: "purple",
      },
      { id: "hostqueue", label: "Host Router", sub: "consistent hashing → worker", col: 2, row: 2, tone: "purple" },
      { id: "politeness", label: "Politeness Throttle", sub: "token bucket, min-delay/host", col: 3, row: 2, tone: "purple" },
      { id: "fetcher", label: "Fetcher Pool", sub: "async workers · cached DNS + robots.txt", col: 3, row: 1, tone: "green" },
      { id: "parser", label: "Parser / Extractor", sub: "HTML → links + text", col: 4, row: 1, tone: "green" },
      { id: "seenurl", label: "Seen-URL Filter", sub: "Bloom filter, ~100B entries", col: 5, row: 1, tone: "orange" },
      { id: "contentstore", label: "Content Store", sub: "S3 / HDFS, immutable blobs", col: 4, row: 2, tone: "slate" },
      { id: "simhash", label: "Near-Dup Filter", sub: "SimHash, Hamming ≤3", col: 5, row: 2, tone: "orange" },
      { id: "kafka", label: "New-URL Queue", sub: "Kafka", col: 2, row: 3, tone: "orange" },
      { id: "index", label: "Indexing Pipeline", sub: "downstream search index", col: 4, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "seeds", to: "frontier", label: "seed load", kind: "write" },
      { from: "frontier", to: "hostqueue", label: "dequeue by priority", kind: "read" },
      { from: "hostqueue", to: "politeness", label: "consistent-hash → owning worker", kind: "read" },
      { from: "politeness", to: "fetcher", label: "release at min-delay", kind: "read" },
      { from: "fetcher", to: "parser", label: "HTML response", kind: "read" },
      { from: "parser", to: "contentstore", label: "raw content", kind: "analytics" },
      { from: "contentstore", to: "simhash", label: "hash & compare", kind: "analytics" },
      { from: "simhash", to: "index", label: "unique pages only", kind: "analytics" },
      { from: "parser", to: "seenurl", label: "extracted links", kind: "write" },
      { from: "seenurl", to: "kafka", label: "new URLs only (~90%+ filtered)", kind: "write" },
      { from: "kafka", to: "frontier", label: "re-enqueue, computed priority", kind: "write" },
    ],
    legend: [
      { kind: "read", text: "fetch/crawl path · 10K pages/sec" },
      { kind: "write", text: "discovery path · new URLs flow back into the frontier" },
      { kind: "analytics", text: "content pipeline · dedup + indexing, off the fetch path" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Crawl seed URLs and recursively discover and fetch linked pages", tag: "P0" },
      { id: "FR-02", text: "Respect robots.txt (disallow rules and crawl-delay) per host", tag: "P0" },
      { id: "FR-03", text: "Enforce per-host politeness: bounded concurrency and a minimum delay between requests to the same host", tag: "P0" },
      { id: "FR-04", text: "Deduplicate URLs already crawled or already queued (exact-URL dedup)", tag: "P0" },
      { id: "FR-05", text: "Detect near-duplicate or mirrored content so the same content isn't reprocessed under different URLs", tag: "P0" },
      { id: "FR-06", text: "Prioritize URLs in the frontier by estimated importance and freshness need", tag: "P0" },
      { id: "FR-07", text: "Extract, normalize, and canonicalize links from crawled pages", tag: "P0" },
      { id: "FR-08", text: "Recrawl already-indexed pages periodically based on estimated change frequency", tag: "P1" },
      { id: "FR-09", text: "Detect and contain crawler traps (infinite URL spaces, session-id loops)", tag: "P1" },
      { id: "FR-10", text: "Store raw page content and metadata for downstream indexing", tag: "P1" },
      { id: "FR-11", text: "Support pluggable content-type filters (skip non-HTML unless configured)", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Sustained crawl (fetch) throughput", tag: "10K pages/sec" },
      { id: "NFR-02", text: "Minimum delay between requests to the same host (politeness default)", tag: "1-2s/host" },
      { id: "NFR-03", text: "Seen-URL Bloom filter membership check latency", tag: "p99 < 1ms" },
      { id: "NFR-04", text: "Average recrawl interval across the corpus, tiered by change rate", tag: "~30 days" },
      { id: "NFR-05", text: "Crawl pipeline availability", tag: "99.9%" },
      { id: "NFR-06", text: "Storage footprint for compressed raw HTML at 10B pages", tag: "~1PB" },
      { id: "NFR-07", text: "Exact-URL dedup correctness: false positives acceptable, false negatives are not", tag: "zero false negatives" },
      { id: "NFR-08", text: "Crawler-trap containment cap on URLs crawled per host per day", tag: "bounded/host/day" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: where does 10K pages/sec even come from?",
      body: [
        "Before picking any component, derive the throughput target from the corpus size and the freshness promise, not from a guess. A 10B-page corpus with a 30-day average refresh means every page must be re-fetched roughly once a month just to stay current — that alone is a real number, and new-page discovery sits on top of it.",
      ],
      bullets: [
        { lead: "10B pages / 30-day refresh", text: "≈ 10,000,000,000 / 2,592,000 seconds ≈ 3,900 pages/sec just to keep the existing corpus fresh." },
        { lead: "New-page discovery", text: "roughly doubles that baseline, so the target is rounded up to 10,000 pages/sec sustained." },
        { lead: "Storage", text: "10B pages × ~100KB compressed HTML ≈ 1PB, held on HDFS or S3 with the crawl metadata alongside it." },
      ],
      pictureTitle: "Where does 10K pages/sec come from?",
      pictureRows: [
        { label: "10B pages / 30-day refresh", value: "~3,900 pages/sec baseline", tone: "neutral" },
        { label: "+ new-page discovery budget", value: "~2× baseline", tone: "neutral" },
        { label: "Target sustained rate", value: "10,000 pages/sec", tone: "good" },
      ],
      remember: {
        problem: "How fast must the crawler fetch to keep a 10B-page corpus fresh?",
        solution: "~3,900 pages/sec just for a 30-day refresh cycle; round up to 10K pages/sec sustained to also fund new-page discovery.",
        why: "Freshness is a corpus-wide budget — size divided by refresh interval — not a per-page number, so it has to be computed before choosing worker counts.",
        tradeoff: "A tighter refresh interval (e.g., 7 days) roughly quadruples required throughput and hardware.",
        failure: "Undersizing throughput means the crawler permanently falls behind and the corpus goes stale.",
        mitigation: "Tier pages by priority (news sites refresh hourly, static pages refresh monthly) so the average, not the worst case, drives capacity.",
      },
    },
    {
      n: 2,
      title: "The URL frontier: Mercator's front/back queues",
      body: [
        "A frontier has to satisfy two axes at once — serve high-priority URLs first, and never let two in-flight requests hit the same host. One queue design can't do both, so Mercator splits the concerns: front queues carry priority, back queues carry politeness, and a mapping table connects them.",
      ],
      bullets: [
        { lead: "Front queues", text: "bucket URLs by priority score. A biased random selection favors the high-priority buckets so no queue starves, but low-priority URLs still get served eventually." },
        { lead: "Back queues", text: "each holds URLs for exactly one host at a time, dequeued strictly FIFO — guaranteeing only one in-flight request per host regardless of how the front queues are organized." },
        { lead: "Next-eligible-time heap", text: "a back queue only becomes eligible to feed a worker once its host's politeness delay has elapsed; a min-heap keyed on next-fetch-time drives refills from the front queues." },
      ],
      pictureTitle: "Why two layers of queues, not one?",
      pictureRows: [
        { label: "Single global priority queue", value: "top host dominates → violates politeness", tone: "bad" },
        { label: "Front queues only (priority)", value: "no per-host isolation", tone: "bad" },
        { label: "Front + back (Mercator)", value: "priority AND one host per queue", tone: "good" },
      ],
      remember: {
        problem: "Serve URLs by priority while guaranteeing one host is never hit twice concurrently.",
        solution: "Mercator's two-tier frontier: front queues bucket by priority; back queues each hold exactly one host, refilled from front queues by biased selection.",
        why: "Priority and politeness are different axes — one queue design can't satisfy both, so the concerns are split into two layers.",
        tradeoff: "More bookkeeping (a host-to-back-queue routing table) in exchange for guaranteed per-host isolation.",
        failure: "A single FIFO or single priority queue lets one large host's URLs monopolize workers and blow through rate limits.",
        mitigation: "Maintain a min-heap of next-eligible-fetch-time per host so a back queue only surfaces once its politeness delay has elapsed.",
      },
    },
    {
      n: 3,
      title: "Politeness at fleet scale: consistent hashing, not a global lock",
      body: [
        "With thousands of workers spread across many machines, the crawler still has to guarantee that only one worker ever fetches from example.com at a time and respects its crawl-delay — without checking a shared coordination service on every single fetch, which would itself become the bottleneck at 10K fetches/sec.",
      ],
      bullets: [
        { lead: "Consistent hash host → worker", text: "the same host always routes to the same worker, so that worker locally owns the token bucket / rate limiter for every host it's responsible for. No cross-machine coordination per fetch." },
        { lead: "A global rate-limit DB", text: "checked before every fetch would add a network round trip at 10K/sec and become the new bottleneck. Rejected." },
        { lead: "Scaling out", text: "consistent hashing reshuffles only ~1/N hosts when a worker is added or removed, instead of rehashing the whole fleet like modulo hashing would." },
      ],
      pictureTitle: "Where does the politeness decision live?",
      pictureRows: [
        { label: "Global rate-limit DB per fetch", value: "network hop × 10K/s → bottleneck", tone: "bad" },
        { label: "Consistent hash → local token bucket", value: "in-memory decision, no coordination", tone: "good" },
      ],
      remember: {
        problem: "Enforce per-host politeness across a horizontally-scaled worker fleet.",
        solution: "Consistent-hash each host to one worker; that worker owns the host's token bucket in memory.",
        why: "Politeness is a per-host, in-order constraint — pinning a host to one worker turns a distributed coordination problem into a local one.",
        tradeoff: "Hosts aren't perfectly load-balanced across workers (a few huge sites can skew one worker), so cap in-flight URLs per host too.",
        failure: "A per-fetch call to a shared rate-limit store adds a network hop at 10K fetches/sec and becomes the bottleneck.",
        mitigation: "Consistent hashing bounds reshuffling on scale-out to ~1/N hosts, and per-host in-flight caps stop one giant site from starving a worker.",
      },
    },
    {
      n: 4,
      title: "Exact dedup at scale: a Bloom filter, not a database",
      body: [
        "The crawler discovers far more raw links than it will ever fetch — most are already seen. Checking a relational or key-value store before enqueueing every discovered link would mean a lookup per link at a volume of 100B+ links/day. A sharded Bloom filter answers 'have I seen this URL' in memory with a tunable, small false-positive rate and zero false negatives.",
      ],
      bullets: [
        { lead: "Sizing", text: "for ~100B seen URLs at 1% false-positive rate, m ≈ n × 9.6 bits ≈ 120GB — versus terabytes for an exact hash set with pointers." },
        { lead: "Failure mode", text: "a false positive silently drops a genuinely new URL — acceptable at web scale, since the same page is usually reachable from another inbound link. A false negative (letting a duplicate back in) never happens." },
        { lead: "Sharding", text: "the bit array is partitioned by URL hash across nodes, so no single machine holds the whole filter." },
      ],
      pictureTitle: "Bloom filter vs. exact index for seen-URLs",
      pictureRows: [
        { label: "Exact hash set, 100B URLs", value: "~terabytes of RAM", tone: "bad" },
        { label: "DB lookup per discovered link", value: "network round-trip × 100B/day", tone: "bad" },
        { label: "Sharded Bloom filter, 1% FP", value: "~120GB, in-memory, no false negatives", tone: "good" },
      ],
      remember: {
        problem: "Reject already-seen URLs out of 100B+ discovered links/day without an unbounded index.",
        solution: "A sharded Bloom filter sized for the seen-URL count at ~1% false-positive rate.",
        why: "Bloom filters trade a small, tunable false-positive rate for O(1), space-efficient membership tests with zero false negatives.",
        tradeoff: "Occasionally drops a genuinely new URL (false positive) — acceptable when the corpus is billions of pages and a missed page is usually found again via another inbound link.",
        failure: "An exact in-memory set at this cardinality needs terabytes of RAM; a DB-backed check adds a network round trip per discovered link.",
        mitigation: "Size the filter for the real cardinality, monitor the observed false-positive rate, and resize/rebuild before it drifts above target.",
      },
    },
    {
      n: 5,
      title: "Near-duplicate content and crawler traps",
      body: [
        "URL-level dedup doesn't catch mirrors, tracking-parameter variants, or the same article served under a session-scoped URL. SimHash fingerprints content so near-identical pages can be caught even under different URLs, while a separate, explicit containment plan keeps a single misbehaving host from eating the entire fetch budget.",
      ],
      bullets: [
        { lead: "SimHash", text: "a 64-bit fingerprint over content shingles such that near-duplicate documents differ by only a few bits (Hamming distance ≤3)." },
        { lead: "LSH banding", text: "splits the fingerprint into bands so only documents sharing a band get compared, avoiding an O(n²) scan across billions of pages." },
        { lead: "Crawler traps", text: "infinite calendar pages, auto-generated URLs, session-id loops — contained with a per-host-per-day URL cap, a crawl-depth cap, and canonicalization that strips session/tracking parameters before a URL ever reaches the frontier." },
      ],
      pictureTitle: "Catching what URL dedup misses",
      pictureRows: [
        { label: "Exact URL dedup only", value: "misses mirrors, tracking-param variants", tone: "bad" },
        { label: "+ SimHash near-dup (Hamming ≤3)", value: "catches near-identical content", tone: "good" },
        { label: "+ per-host/day cap & canonicalization", value: "contains crawler traps", tone: "good" },
      ],
      remember: {
        problem: "Avoid re-crawling and re-indexing content that's identical or near-identical under a different URL, and avoid infinite URL spaces.",
        solution: "SimHash + LSH banding for near-duplicate content; per-host crawl caps and URL canonicalization for traps.",
        why: "URL-level dedup only catches byte-identical URLs; content-level near-dup and trap containment need separate mechanisms.",
        tradeoff: "SimHash comparisons and canonicalization add CPU per page in exchange for a much smaller, cleaner index.",
        failure: "Without a per-host cap, a single calendar or session-id trap can consume the entire crawl budget on one worthless host.",
        mitigation: "Hard-cap URLs crawled per host per day and crawl depth, and canonicalize away known tracking/session parameters before frontier insertion.",
      },
    },
    {
      n: 6,
      title: "DNS and robots.txt: the fetch-time overhead nobody budgets for",
      body: [
        "At 10K fetches/sec, resolving DNS and checking robots.txt on every single request would overwhelm nameservers and robots endpoints and double or triple per-fetch latency. Both are effectively static for hours at a time, so caching converts a per-request cost into a per-host-per-day cost.",
      ],
      bullets: [
        { lead: "DNS", text: "run a dedicated async resolver with its own TTL-respecting cache instead of hitting OS resolvers per fetch; a fresh lookup on every request would overload the resolver at this rate." },
        { lead: "robots.txt", text: "fetched once per host per cache TTL (commonly 24h), not on every page fetch — and the robots.txt fetch itself counts against that host's politeness budget." },
        { lead: "Fail-safe default", text: "a robots.txt fetch failure defaults to a conservative policy (disallow or back off), never to an implicit allow." },
      ],
      pictureTitle: "What happens on every fetch, cached vs. not",
      pictureRows: [
        { label: "DNS resolved fresh per request", value: "resolver overload at 10K/s", tone: "bad" },
        { label: "DNS cached, async prefetch", value: "sub-ms lookup, no bottleneck", tone: "good" },
        { label: "robots.txt fetched per page", value: "doubles requests to every host", tone: "bad" },
        { label: "robots.txt cached 24h per host", value: "one fetch amortized over thousands of pages", tone: "good" },
      ],
      remember: {
        problem: "Keep DNS resolution and robots.txt checks from becoming the crawler's real bottleneck.",
        solution: "A dedicated, cached async DNS resolver, and a per-host robots.txt cache with a 24h TTL.",
        why: "Both are effectively static for hours at a time, so caching converts a per-request cost into a per-host-per-day cost.",
        tradeoff: "Cached robots.txt can be briefly stale after a site changes its rules — bounded by the TTL.",
        failure: "Uncached DNS/robots checks at 10K fetches/sec overwhelm resolvers and robots endpoints and slow every fetch.",
        mitigation: "TTL-bound caches for both, and a conservative default (skip/back off) when a robots.txt fetch fails.",
      },
    },
    {
      n: 7,
      title: "Freshness scheduling: recrawl priority isn't FIFO",
      body: [
        "Pages don't all change at the same rate — a news homepage changes hourly, most pages barely change at all. Recrawl scheduling estimates each page's change frequency from observed content-hash diffs over time and feeds that estimate back into the frontier's priority score, rather than applying a flat 'recrawl everything every 30 days' policy.",
      ],
      bullets: [
        { lead: "Content-hash tracking", text: "a changed hash between crawls shortens the estimated recrawl interval; an unchanged hash lengthens it." },
        { lead: "Priority tiers", text: "breaking news and high-authority hubs get short intervals; long-tail static pages get long intervals, spending the fetch budget where it matters." },
        { lead: "Feedback into the frontier", text: "the computed next-crawl-time becomes part of the front-queue priority score directly, not a separate scheduler bolted on the side." },
      ],
      pictureTitle: "Flat recrawl vs. change-rate-weighted recrawl",
      pictureRows: [
        { label: "Flat 30-day recrawl for all pages", value: "wastes budget on static pages", tone: "bad" },
        { label: "Change-rate-weighted recrawl", value: "news hourly, static monthly+", tone: "good" },
      ],
      remember: {
        problem: "Spend a fixed fetch budget where freshness actually matters instead of uniformly.",
        solution: "Estimate per-page change frequency from historical content-hash diffs and set next-crawl-time accordingly.",
        why: "The web's change rate is extremely skewed — a uniform interval either wastes budget on static pages or under-refreshes fast-changing ones.",
        tradeoff: "Requires storing and comparing historical content hashes per page, and the estimate is unreliable until enough history accumulates.",
        failure: "A flat recrawl interval either burns fetch budget on pages that never change or lets fast-changing pages go stale.",
        mitigation: "Start new pages at a default interval, then tighten or loosen it based on the observed change hash over the first few crawls.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a distributed BFS over the web: pull a URL from a priority frontier, fetch it politely, extract links, dedup, and feed new URLs back in.",
      "Politeness is the hard constraint: pin each host to one worker via consistent hashing so per-host rate limits are enforced locally, with zero global coordination per fetch.",
      "Dedup happens at two layers: a sharded Bloom filter for exact seen-URLs, and SimHash for near-duplicate content that slips past URL-level checks.",
      "The frontier is Mercator-style: front queues carry priority, back queues carry one host each, so priority and politeness are solved as separate concerns.",
      "Crawler traps and freshness are the operational tail: cap URLs per host per day, canonicalize tracking params, and recrawl by estimated change rate instead of a flat interval.",
    ],
    flows: [
      {
        kind: "read",
        title: "CRAWL/FETCH · 10K PAGES/SEC",
        summary:
          "A worker pulls the next eligible host's URL off the frontier, resolves DNS and checks robots.txt from cache, fetches politely, and hands the page to the parser.",
        steps: [
          { label: "URL Frontier", note: "dequeue by priority + politeness" },
          { label: "Host Router", note: "consistent hash → owning worker" },
          { label: "Politeness Throttle", note: "wait for token / min-delay" },
          { label: "Fetcher Pool", note: "cached DNS + cached robots.txt, HTTP fetch" },
          { label: "Parser", note: "HTML → links + text" },
        ],
      },
      {
        kind: "write",
        title: "DISCOVERY · NEW URLS BACK INTO THE FRONTIER",
        summary:
          "Every fetched page yields links. Most are already seen; the ones that survive dedup and canonicalization get queued for a future crawl.",
        steps: [
          { label: "Parser", note: "extract raw links" },
          { label: "Canonicalize", note: "strip session/tracking params, resolve relative URLs" },
          { label: "Seen-URL Bloom Filter", note: "reject ~90%+ already-seen" },
          { label: "New-URL Queue", note: "Kafka buffers the survivors" },
          { label: "URL Frontier", note: "enqueue with computed priority" },
        ],
      },
      {
        kind: "analytics",
        title: "CONTENT PIPELINE · OFF THE FETCH PATH",
        summary:
          "Raw content lands in blob storage and is checked for near-duplicates before it ever reaches the index, so the fetch loop never waits on indexing.",
        steps: [
          { label: "Content Store", note: "raw HTML, compressed, immutable per crawl" },
          { label: "Near-Dup Filter", note: "SimHash, Hamming distance ≤3 → drop as duplicate" },
          { label: "Indexing Pipeline", note: "unique pages only" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "10B page corpus, 10K pages/sec sustained fetch rate (~860M/day)",
          "Freshness: ~30-day average recrawl, tiered by change rate (news: hourly, static: months)",
          "Storage: ~100KB compressed HTML/page × 10B ≈ 1PB on HDFS/S3",
          "Seen-URL Bloom filter: ~100B entries, 1% FP ≈ ~120GB, sharded",
          "SimHash: 64-bit fingerprint, near-dup at Hamming distance ≤3",
          "Politeness default: 1-2s between requests to the same host, capped concurrent connections/host",
          "Crawler trap cap: bounded URLs crawled per host per day",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Mercator two-tier frontier: priority front queues + one-host-per-back-queue",
          "Consistent-hash host → worker, so politeness is a local decision, not a global lock",
          "Bloom filter for exact-URL dedup, not a DB lookup per discovered link",
          "SimHash + LSH banding for near-duplicate content, not brute-force comparison",
          "Dedicated cached async DNS resolver + per-host robots.txt cache (24h TTL)",
          "Change-rate-weighted recrawl priority, not a flat interval",
          "Content pipeline (storage, near-dup, indexing) fully async off the fetch loop",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Politeness across a distributed fleet is the signature hard part — say how you avoid a global lock",
          "Bloom filter false positives (dropped new URL) are the accepted failure mode; false negatives never happen",
          "Crawler traps need an explicit, named containment plan (per-host cap, canonicalization, depth cap)",
          "Freshness is a corpus-wide budget (size / interval), computed, not assumed",
          "robots.txt and DNS are cached per host, not re-checked on every fetch",
          "Frontier priority and politeness are solved as two separate layers (front/back queues)",
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
      goal: "Before drawing anything, get the corpus size, refresh interval, and derived throughput on the board, plus a scoped in/out list. The point is to make the interviewer confirm scope out loud.",
      why: "The interviewer is checking whether you drive the design from numbers. Frontier design, Bloom filter sizing, and worker count all fall out of the throughput target, so locking it first is what separates an engineer from someone guessing.",
      steps: [
        { kind: "ASK", text: '**"What\'s the target corpus size and refresh interval?"** Land on "10B pages, ~30-day average refresh". Write **"10B pages, 30d refresh"** top-left.' },
        { kind: "ASK", text: 'Next ask: **"Is this a single crawl or continuous?"** Land on "continuous, always-on crawl, not a one-shot batch job". Write **"continuous"** underneath.' },
        { kind: "SAY", text: 'Derive throughput yourself: **"10B pages / 30-day refresh ≈ 3,900 pages/sec baseline; round up to 10K/sec sustained to also fund new-page discovery."** Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "frontier, politeness, URL + content dedup, fetch/parse, freshness scheduling". Out: "ranking/search internals, spam/malware filtering, JS rendering for SPA sites". "Let me know if you\'d like me to come back to any of those." Wait for confirmation.' },
        { kind: "WRITE", text: 'Do the storage math out loud: **"10B pages × ~100KB compressed HTML ≈ 1PB"**, held on HDFS/S3. Write the total on the board.' },
      ],
      grading: "Senior judgment. Are you deriving throughput from corpus size and refresh interval, parking out-of-scope items deliberately, and writing the numbers down instead of keeping them in your head?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Define the frontier-entry contract and the page record, and get ahead of the obvious 'just use one queue' alternative before it's suggested.",
      why: "The interviewer wants to see you commit to a data model that already implies the hard decisions — two dedup keys, a priority score, a next-crawl-time — instead of discovering them mid-design.",
      steps: [
        { kind: "WRITE", text: 'Write the frontier entry: **"{ url, priority_score, host, next_eligible_time, depth }"**.' },
        { kind: "DRAW", text: 'Sketch the page record: **"{ url_hash (PK), canonical_url, content_hash, simhash_fingerprint, last_crawled_at, next_crawl_at, http_status }"**.' },
        { kind: "SAY", text: '"Two dedup keys, not one: url_hash for exact-URL identity, simhash_fingerprint for near-duplicate content — different questions, different structures."' },
        { kind: "RULE OUT", text: '"A single global FIFO queue of URLs is the naive answer, but it can\'t express priority and per-host isolation at the same time — that\'s why Mercator splits it into front and back queues." Cross it off.' },
      ],
      grading: "Crisp frontier-entry and page-record schemas, both dedup keys named explicitly, and the single-queue alternative ruled out before being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: fetch, discovery, content pipeline. Label the arrows with the mechanism (consistent hash, token bucket, ~90% rejected), not just box names.",
      why: "Drawing fetch, discovery, and the content pipeline as separate lanes proves you understand they have different SLAs — the interviewer is checking that indexing never sits on the fetch loop.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **fetch lane**: Seed URLs → URL Frontier → Host Router → Politeness Throttle → Fetcher Pool → Parser. Label the arrows **"priority + politeness order"**, **"consistent hash"**, **"token bucket"**.' },
        { kind: "DRAW", text: 'Add the **discovery lane**: Parser → Seen-URL Bloom Filter → New-URL Queue (Kafka) → back into the Frontier, labeled **"~90%+ rejected as already-seen"**.' },
        { kind: "DRAW", text: 'Add the **content pipeline lane**, dashed: Parser → Content Store → Near-Dup Filter (SimHash) → Indexing Pipeline, labeled **"off the fetch path"**.' },
        { kind: "SAY", text: '"Three lanes because fetching, discovery, and indexing have different SLAs — fetch is the tight loop, discovery feeds it back, indexing is fully async and never blocks a fetch."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with the mechanism, and an explicit statement that indexing never blocks a fetch.",
    },
    {
      n: 4,
      title: "Deep Dive: Frontier and Politeness",
      minutes: 8,
      goal: "Show the Mercator front/back queue split and defend consistent-hash-based politeness at fleet scale.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can enforce per-host politeness across a distributed fleet without a global lock, and can name why a naive rate-limit DB fails.",
      steps: [
        { kind: "DRAW", text: 'Draw the two-tier frontier: F front queues (priority buckets) → mapping table → B back queues (one host each). "A back queue is only eligible once its host\'s next-eligible-time has passed."' },
        { kind: "SAY", text: '"Politeness at fleet scale: consistent-hash each host to one worker, so the token bucket for that host lives on exactly one machine — no cross-machine lock per fetch."' },
        { kind: "SAY", text: '"Consistent hashing also bounds the blast radius of scaling: adding or removing a worker reshuffles only ~1/N hosts, unlike modulo hashing which reshuffles almost everything."' },
        { kind: "RULE OUT", text: '"A single global rate-limit DB checked before every fetch adds a network hop at 10K fetches/sec and becomes the bottleneck itself." Cross it off.' },
      ],
      grading: "The two-tier frontier on the board, consistent-hash politeness explained without prompting, and a one-line rejection of the global-lock alternative.",
    },
    {
      n: 5,
      title: "Deep Dive: Dedup and Crawler Traps",
      minutes: 7,
      goal: "Walk the Bloom filter sizing, SimHash near-dup detection, and a named crawler-trap containment plan.",
      why: "Anyone can say 'check if we've seen it before'. The interviewer wants real sizing math (Bloom filter memory), a near-duplicate mechanism beyond URL equality, and a concrete trap containment number.",
      steps: [
        { kind: "SAY", text: '"Exact dedup: a sharded Bloom filter over ~100B seen URLs, sized for ~1% false-positive rate, about 120GB total, with zero false negatives."' },
        { kind: "SAY", text: '"Near-dup: SimHash gives a 64-bit fingerprint per page; documents within Hamming distance 3 are treated as duplicates, compared via LSH banding, not brute force."' },
        { kind: "SAY", text: '"Crawler traps get an explicit containment plan: cap URLs crawled per host per day, cap crawl depth, canonicalize away session/tracking params before a URL ever reaches the frontier."' },
        { kind: "RULE OUT", text: '"A DB lookup per discovered link, or an exact in-memory hash set at this cardinality — both too expensive at 100B+ links/day." Cross both off.' },
      ],
      grading: "Bloom filter sizing math on the board, SimHash explained as content-level (not URL-level) dedup, and a quantified trap-containment cap.",
    },
    {
      n: 6,
      title: "Wrap: Tiers, Freshness, and Close",
      minutes: 5,
      goal: "Name the SLA tiers, bring up freshness scheduling unprompted, push back on scope, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: explicit tiers that justify async boundaries, freshness scheduling volunteered rather than assumed, and a close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: '"Fetch is tier-1, discovery/dedup is tier-2, indexing is tier-3 — that\'s why indexing runs fully async off the fetch path."' },
        { kind: "SAY", text: 'Bring up freshness unprompted: "Recrawl priority is weighted by observed change rate, not a flat interval, so the fetch budget goes where it actually matters."' },
        { kind: "SAY", text: 'Push back where useful: "Do we really need a general-purpose crawler, or is this scoped to one domain or vertical? That changes politeness defaults and whether we need JS rendering."' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a distributed BFS with a politeness-aware, priority frontier and two layers of dedup. With more time I\'d cover JS-rendered pages, spam/quality filtering, and incremental index merge."' },
      ],
      grading: "Explicit SLA tiers, freshness scheduling volunteered, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working crawler loop — queue, fetch, extract, re-queue — but politeness and dedup stay shallow and un-quantified.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Describes a basic BFS crawler: pull a URL, fetch it, extract links, add them to a queue.",
          "Knows to check robots.txt and add some delay between requests.",
          "Picks a hash set or database for dedup without considering scale.",
          "Mentions a database or index for storing crawled pages.",
          "Handles 'what about duplicates' by adding a check before insert.",
        ],
        gaps: [
          "Doesn't separate priority from politeness — assumes one queue can do both.",
          "No plan for enforcing politeness across multiple machines, only a single-process rate limit.",
          "Dedup via a DB lookup or unsharded hash set, with no size math at billions of URLs.",
          "Only mentions exact-URL dedup, never near-duplicate content.",
          "No plan for crawler traps or infinite URL spaces.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks the Mercator frontier and consistent-hash politeness with reasons, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes throughput, storage, and freshness numbers on the board within the first 5 minutes.",
          "Proposes a Mercator-style front/back queue frontier and can explain why one queue can't do both jobs.",
          "Uses consistent hashing to pin hosts to workers so politeness is enforced locally.",
          "Uses a Bloom filter for exact-URL dedup with a rough size estimate.",
          "Mentions SimHash or a similar technique for near-duplicate detection when prompted.",
          "Separates fetch, discovery, and indexing into different async stages.",
          "Names DNS and robots.txt caching as fetch-time optimizations.",
        ],
        gaps: [
          "Volunteers near-duplicate detection only after being asked about mirrors or duplicate content.",
          "Doesn't proactively size the Bloom filter (memory math) unless pushed.",
          "Mentions crawler-trap containment but without a concrete per-host cap number.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, names politeness-at-fleet-scale as the signature hard part unprompted, and brings sizing and operational maturity that goes beyond the mechanism itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers politeness-at-fleet-scale as the hardest part of the design, with consistent hashing and a quantified reshuffle cost (~1/N hosts on scale-out).",
          "Sizes the Bloom filter with real numbers (~100B entries, ~120GB at 1% FP) unprompted.",
          "Names crawler traps and freshness scheduling unprompted, each with a concrete containment number (cap per host/day, change-rate-weighted recrawl).",
          "Defines explicit tiers — fetch tier-1, discovery/dedup tier-2, indexing tier-3 — and uses that hierarchy to justify every async boundary.",
          "Pushes back on scope ('general web crawler vs. a scoped vertical crawler changes politeness defaults and JS-rendering needs').",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
          "Treats the interviewer as a collaborator: paces the 40 minutes, parks tangents, returns to them only if there's room.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Treating the frontier as a single FIFO or single priority queue — it can't express priority and per-host isolation at the same time.",
      "A global rate-limit check (DB or lock) on every single fetch at 10K/sec — becomes the bottleneck it was meant to prevent.",
      "Dedup via a DB lookup or unsharded in-memory set with no size math at 100B+ discovered links.",
      "Only checking URL equality and never mentioning near-duplicate content (mirrors, tracking-param variants, session IDs).",
      "No crawler-trap containment — a single infinite calendar page can consume the entire crawl budget.",
      "Re-resolving DNS or re-fetching robots.txt on every single page request instead of caching per host.",
      "No freshness or recrawl story — treating the crawl as a one-shot batch job instead of a continuous process with a refresh budget.",
    ],
    followUps: [
      {
        q: "Why not just use a single central rate limiter (Redis) checked before every fetch?",
        a: "Because that check becomes a network round trip on every one of 10,000 fetches per second, and the shared store becomes the bottleneck the design was trying to avoid. Consistent-hashing each host to one worker lets that worker own the host's token bucket in memory, so the politeness decision is a local, in-process check with no network hop, and only ~1/N hosts get reshuffled when the fleet scales up or down.",
      },
      {
        q: "What happens when a host is down or extremely slow?",
        a: "The fetcher uses bounded timeouts and never blocks a worker waiting on one slow host — a per-host circuit breaker backs off exponentially on repeated failures or timeouts, deprioritizing that host in the frontier rather than retrying it in a tight loop. Because fetches are async and hosts are isolated in their own back queues, one dead site degrades only its own crawl rate, not the whole worker pool.",
      },
      {
        q: "How do you handle JavaScript-heavy single-page apps that need rendering to reveal links?",
        a: "Headless-browser rendering (e.g., a Chromium pool) is orders of magnitude more expensive per page — seconds instead of milliseconds — so it's never the default path. Hosts get flagged as JS-heavy (via a static-HTML link-count heuristic or a known-framework signature) and routed to a small, separate rendering pool, keeping the cost isolated instead of paying it for every one of 10B pages.",
      },
      {
        q: "How would you detect and handle a crawler trap in practice?",
        a: "Cap URLs crawled per host per day and cap crawl depth as hard limits, then monitor per-host discovered-URL growth: if a host's URL count grows superlinearly relative to unique content (near-identical SimHash fingerprints across thousands of 'different' URLs), flag it and throttle or quarantine that host rather than continuing to feed it fetch budget.",
      },
      {
        q: "How do you prioritize which pages to crawl first?",
        a: "The front-queue priority score combines estimated importance (an inbound-link/PageRank-like signal), freshness need (the page's estimated change rate), and seed/source trust. A newly discovered link from a high-authority hub gets bucketed into a high-priority front queue; a long-tail static page discovered once gets a low-priority bucket and a long recrawl interval.",
      },
      {
        q: "What if the Bloom filter's false-positive rate creeps up over time?",
        a: "A Bloom filter's false-positive rate rises as it fills past its designed capacity, so the observed FP rate is monitored against the target as entries grow. Before it degrades meaningfully, the filter is resized (a larger bit array) or further sharded — this is a planned capacity event, the same way the URL shortener's counter rollover is planned, not an emergency.",
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
          "This is a distributed breadth-first search over the web with two hard constraints layered on top: never hit a host too fast, and never do the same work twice. Everything expensive in the design — the two-tier frontier, consistent-hash politeness, the Bloom filter, SimHash — exists to keep that BFS honest at 10 billion pages and 10,000 fetches/sec.",
          "Anchor everything on the numbers: 10B page corpus, ~30-day average refresh, 10K pages/sec sustained fetch rate, ~1PB of compressed storage. Every structural choice below is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing and the throughput target",
        body: [
          "10B pages divided by a 30-day refresh interval is ~3,900 pages/sec just to keep the existing corpus fresh; new-page discovery roughly doubles that, landing on a 10K pages/sec sustained target. Storage follows the same kind of arithmetic: ~100KB of compressed HTML per page × 10B pages ≈ 1PB, held on HDFS or S3 alongside per-page crawl metadata.",
        ],
      },
      {
        heading: "The frontier: priority and politeness as two layers",
        body: [
          "A single queue can't serve high-priority URLs first and also guarantee no host gets hit twice concurrently — those are different axes. Mercator's answer is two tiers: front queues bucket URLs by priority with biased selection favoring the high-priority buckets, and back queues each hold exactly one host's URLs, dequeued strictly FIFO. A back queue is only eligible to feed a worker once its host's politeness delay has elapsed, tracked in a min-heap of next-eligible-fetch-time.",
        ],
      },
      {
        heading: "Politeness at fleet scale",
        body: [
          "The real difficulty isn't respecting one host's crawl-delay — it's doing that across a horizontally-scaled fleet of workers without a coordination service on the hot path. Consistent-hashing each host to a single worker solves this: that worker owns the host's token bucket in memory, so the politeness check is local and adds no network hop. Scaling the fleet up or down only reshuffles ~1/N hosts, unlike modulo hashing which would reshuffle almost everything. A global rate-limit database checked before every fetch was the tempting alternative, but at 10K fetches/sec it becomes the bottleneck it was meant to prevent.",
        ],
      },
      {
        heading: "Dedup: exact URLs and near-duplicate content",
        body: [
          "URL-level dedup uses a sharded Bloom filter sized for ~100B seen URLs at a 1% false-positive rate — about 120GB total, versus terabytes for an exact in-memory set or a per-link database lookup at this cardinality. A false positive silently drops a genuinely new URL, which is acceptable since the same page is usually reachable via another inbound link; a false negative, letting a duplicate back in, never happens by construction.",
          "URL equality doesn't catch mirrors or tracking-parameter variants of the same content, so SimHash fingerprints each page's content into 64 bits, and documents within Hamming distance 3 are treated as near-duplicates, compared efficiently via LSH banding rather than brute force across billions of fingerprints. Crawler traps — infinite calendar pages, session-id loops — get a separate, explicit containment plan: a hard cap on URLs crawled per host per day, a crawl-depth cap, and canonicalization that strips session and tracking parameters before a URL ever reaches the frontier.",
        ],
      },
      {
        heading: "Freshness, caching, and the async content pipeline",
        body: [
          "DNS resolution and robots.txt checks are both effectively static for hours at a time, so a dedicated async DNS resolver with its own cache and a per-host robots.txt cache (24h TTL) convert per-request costs into per-host-per-day costs — uncached, both would overwhelm their respective endpoints at 10K fetches/sec. Recrawl priority is weighted by each page's observed change rate (via content-hash diffs over time) rather than a flat interval, so the fetch budget concentrates on pages that actually change.",
          "Fetch is tier-1, discovery/dedup is tier-2, indexing is tier-3: raw content lands in blob storage, gets checked for near-duplicates, and flows into the indexing pipeline entirely asynchronously, so a slow or down indexing stage never adds latency to the fetch loop.",
        ],
      },
    ],
  },
};
