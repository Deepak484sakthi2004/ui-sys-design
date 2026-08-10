import type { Problem } from "@/lib/types";

export const searchAutocomplete: Problem = {
  slug: "search-autocomplete",
  num: "6.3",
  title: "Design a Search Autocomplete",
  level: "Medium",
  deepDiveAvailable: true,
  intro: [
    "Design a search autocomplete (typeahead) system that suggests the top-10 completions for a prefix as a user types, serving 100K requests/sec at sub-20ms p99 server-side, over a corpus of 1B distinct historical queries, while surfacing breaking, spiking queries within about a minute of them starting to trend.",
  ],
  hardParts:
    "The hard parts: ranking millions of candidates per prefix cheaply enough to answer in single-digit milliseconds, blending a slow-moving historical popularity signal with a fast-moving real-time trending one, and sharding the index so a hash spreads load evenly without splitting any single prefix's answer across machines.",
  keyTopics: [
    "Precomputed Top-K Trie",
    "Prefix Sharding & Hot-Shard Replicas",
    "Real-Time Trend Blend (decayed counters)",
    "Offline Batch Rebuild",
    "Client Debounce & Cancellation",
  ],
  foundationsReferenced: [
    { label: "Tries (Prefix Trees)", tone: "green" },
    { label: "Consistent Hashing", tone: "blue" },
    { label: "Valkey / Redis", tone: "purple" },
    { label: "Kafka", tone: "orange" },
    { label: "MapReduce / Spark Batch Jobs", tone: "blue" },
    { label: "Exponential Decay Counters", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "types a query, debounced ~120ms", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "API Gateway", sub: "regional LB", col: 2, row: 1, tone: "slate" },
      {
        id: "acsvc",
        label: "Autocomplete Service",
        sub: "stateless · 100K/s",
        mono: "prefix → shard hash",
        col: 3,
        row: 1,
        tone: "green",
      },
      {
        id: "trieshard",
        label: "Trie Shard Cluster",
        sub: "~500 shards · in-memory",
        mono: "top-10 precomputed / node",
        col: 4,
        row: 1,
        tone: "blue",
      },
      { id: "trendcache", label: "Trending Cache", sub: "Valkey · decayed scores", col: 5, row: 1, tone: "purple" },

      { id: "searchsvc", label: "Search Service", sub: "logs submitted queries", col: 1, row: 2, tone: "slate" },
      { id: "kafka", label: "Kafka", sub: "query-submitted events", col: 2, row: 2, tone: "orange" },
      { id: "flink", label: "Flink", sub: "1-min windows · exp decay", col: 3, row: 2, tone: "orange" },

      { id: "s3", label: "Query Log Archive", sub: "S3 / HDFS · full history", col: 2, row: 3, tone: "slate" },
      { id: "spark", label: "Spark Batch Job", sub: "daily rebuild", col: 3, row: 3, tone: "purple" },
      {
        id: "triebuild",
        label: "Trie Builder",
        sub: "merge top-K bottom-up",
        mono: "bottom-up top-10 merge",
        col: 4,
        row: 3,
        tone: "purple",
      },
    ],
    edges: [
      { from: "client", to: "gateway", kind: "read" },
      { from: "gateway", to: "acsvc", kind: "read" },
      { from: "acsvc", to: "trieshard", label: "historical top-10", kind: "read" },
      { from: "acsvc", to: "trendcache", label: "trending blend", kind: "read" },
      { from: "client", to: "searchsvc", label: "on submit / click", kind: "write" },
      { from: "searchsvc", to: "kafka", kind: "write" },
      { from: "kafka", to: "flink", kind: "analytics" },
      { from: "flink", to: "trendcache", label: "<1 min freshness", kind: "analytics" },
      { from: "kafka", to: "s3", label: "archive", kind: "analytics" },
      { from: "s3", to: "spark", kind: "analytics" },
      { from: "spark", to: "triebuild", kind: "analytics" },
      { from: "triebuild", to: "trieshard", label: "daily snapshot swap", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · 100K autocomplete requests/s" },
      { kind: "write", text: "write path · submitted queries logged" },
      { kind: "analytics", text: "analytics · trending blend + daily batch rebuild, never blocks a request" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "gateway", "acsvc"],
      say: "Skeleton first: a client, a regional gateway, and a stateless Autocomplete Service. Every request is a prefix in, top-10 out — nothing here holds state yet.",
    },
    {
      reveal: ["trieshard"],
      say: "The Autocomplete Service hashes the prefix to pick one of ~500 trie shards, each an in-memory store of top-10 suggestions already precomputed offline. A read is a lookup, never a live search.",
    },
    {
      reveal: ["trendcache"],
      say: "Historical popularity alone is stale by up to a day, so every request also asks a Valkey trending cache holding decayed scores, and the service blends the two before responding.",
    },
    {
      reveal: ["searchsvc", "kafka"],
      say: "The real write signal isn't a keystroke, it's a submitted search or a clicked suggestion. The Search Service logs it once and drops it on Kafka — that's the only thing every downstream pipeline reads from.",
    },
    {
      reveal: ["flink"],
      say: "Flink consumes that same Kafka stream in 1-minute decayed windows and writes straight into the trending cache, so a spiking query can reach the top-10 in under a minute.",
    },
    {
      reveal: ["s3", "spark", "triebuild"],
      say: "In parallel, Kafka archives every event to the Query Log Archive. Once a day, Spark rebuilds the whole trie from that archive, a builder merges top-10 bottom-up, and the new snapshot swaps into the shard cluster.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Suggest the top-10 completions for a prefix as the user types", tag: "P0" },
      { id: "FR-02", text: "Rank suggestions by historical search popularity", tag: "P0" },
      { id: "FR-03", text: "Blend in a real-time trending signal so spiking queries surface within ~1 minute", tag: "P0" },
      { id: "FR-04", text: "Normalize prefixes (case-insensitive, accent-insensitive, trimmed) before matching", tag: "P0" },
      { id: "FR-05", text: "Filter suggestions for profanity, spam, and PII before they can ever be served", tag: "P0" },
      { id: "FR-06", text: "Debounce and cancel in-flight requests on the client as the user keeps typing", tag: "P1" },
      { id: "FR-07", text: "Personalize results by boosting a user's own recent searches", tag: "P1" },
      { id: "FR-08", text: "Support partial multi-word prefix matching, not just whole-word starts", tag: "P1" },
      { id: "FR-09", text: "Track impressions and clicks per suggestion to feed ranking", tag: "P1" },
      { id: "FR-10", text: "Return a sane fallback (e.g. generic trending list) for a cold/never-seen prefix", tag: "P2" },
      { id: "FR-11", text: "Support per-region/locale trending lists", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Suggestion lookup latency, server-side", tag: "p99 < 20ms" },
      { id: "NFR-02", text: "End-to-end latency including client debounce and network", tag: "< 100ms" },
      { id: "NFR-03", text: "Peak autocomplete request throughput", tag: "100K/sec" },
      { id: "NFR-04", text: "Trending-signal freshness, click to surfaced suggestion", tag: "< 1 min" },
      { id: "NFR-05", text: "Full historical index rebuild cadence", tag: "daily" },
      { id: "NFR-06", text: "Availability (about 52 min downtime per year)", tag: "99.99%" },
      { id: "NFR-07", text: "Distinct historical queries logged (corpus size, pre-filter)", tag: "1B" },
      { id: "NFR-08", text: "Autocomplete requests to submitted-search ratio", tag: "20:1" },
      { id: "NFR-09", text: "Suggestions returned per request", tag: "top 10" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing the index: how big is a precomputed trie?",
      body: [
        "Before picking a data structure, size it. Query logs hold roughly 1B distinct strings ever searched, but most of that is a one-off long tail: someone typo'd something once and it never repeats. What actually needs to be indexed for autocomplete is the set of queries popular enough that suggesting them is worth the memory — say anything searched 5+ times in a trailing 90-day window. That knocks 1B distinct queries down to roughly 50M 'indexable' queries, the same long-tail cut a hot-key cache makes, applied at index-build time instead of read time.",
        "At an average query length of 18 characters, 50M queries is ~900M characters of raw text, but a trie shares prefixes, so the actual node count comes in far lower — call it ~200M nodes once branches like 'how to' collapse into one shared path. Precomputing the top-10 suggestions at every node (that's the whole point, see below) adds ~320 bytes per node (10 strings + scores), so the full index is roughly 200M × 320B ≈ 64GB. That fits comfortably distributed across a few hundred shards, sized more for throughput than for capacity.",
      ],
      bullets: [
        { lead: "1B logged, 50M indexed", text: "the Zipf-style long tail is cut at index time: one-off queries never repeat, so indexing them wastes memory without improving the hit rate." },
        { lead: "~200M trie nodes", text: "shared prefixes mean node count is well below raw character count — 'how to' and 'how do i' only diverge after 6 characters." },
        { lead: "~64GB total index", text: "200M nodes × ~320 bytes (10 precomputed suggestions + scores) per node. Small enough to replicate, not small enough for one box." },
        { lead: "Shard for throughput, not just size", text: "64GB fits on a handful of machines, but 100K req/sec doesn't — shard count is set by request rate, not by GB." },
      ],
      pictureTitle: "Sizing the trie: 1B logs → 64GB served",
      pictureCaption: "capacity path: 1B logged → 50M indexable (5+ hits/90d) → ~200M compressed nodes → ~64GB precomputed",
      pictureRows: [
        { label: "1B distinct queries ever logged", value: "long tail, most never repeat", tone: "neutral" },
        { label: "~50M indexed (5+ hits/90d)", value: "the long tail cut, at index time", tone: "good" },
        { label: "~200M trie nodes after sharing", value: "prefix compression, not raw chars", tone: "good" },
        { label: "~64GB precomputed top-10 index", value: "shardable across a few hundred nodes", tone: "neutral" },
      ],
      remember: {
        problem: "How big is the index, and what actually needs to be in it?",
        solution: "Cut the long tail at index time (5+ hits/90d ≈ 50M of 1B queries), build a trie, share prefixes down to ~200M nodes, precompute top-10 per node ≈ 64GB.",
        why: "Indexing a query that never repeats wastes memory and never helps a hit rate; prefix sharing is what keeps 50M queries from costing 900M characters of nodes.",
        tradeoff: "A one-off rare-but-real query never gets suggested, even if it would've been exactly what one user wanted.",
        failure: "Index every logged query verbatim and the trie balloons past what fits in memory, forcing runtime sharding decisions driven by capacity instead of throughput.",
        mitigation: "Threshold at index-build time (Spark job), not at read time, so the cut is a deliberate, tunable knob, not an emergent memory crisis.",
      },
    },
    {
      n: 2,
      title: "The read path: kill two data structures, defend one",
      body: [
        "A request is a prefix, the response is 10 ranked strings, and the read budget is single-digit milliseconds server-side. Three candidates handle that shape very differently once you ask what happens for a short, common prefix like 'a' or 'how'.",
        "The naive version of a trie — walk to the prefix node, then DFS the subtree collecting leaves — looks correct on a whiteboard and fails immediately in production, because the subtree under a common prefix can have millions of descendants. Ranking has to already be done before the request arrives.",
      ],
      bullets: [
        { lead: "Sorted list + binary search", text: "binary search finds the range of strings starting with the prefix in O(log n), but that range can be enormous for a short prefix, and you still have to scan it to find the top-10 by popularity. Rejected: correctness without bounded read cost." },
        { lead: "Naive trie, DFS at read time", text: "walk to the prefix node, then depth-first search the subtree for the highest-scored leaves. For a popular short prefix that subtree is huge, so the read cost is unbounded and violates the latency budget. Rejected." },
        { lead: "Precomputed top-K, trie built offline", text: "during the offline build, merge each node's top-10 up from its children (a child's best candidates can only ever be beaten by, not replaced by, a sibling's), so every node already holds its answer before a single request arrives. Winner." },
        { lead: "Serving layer is often flattened", text: "in production the trie is usually a build-time tool, not the runtime store — the precomputed top-10 per prefix gets flattened into a plain key-value lookup (Redis key = prefix, value = ranked list), because a flat GET beats walking pointers over the network." },
      ],
      pictureTitle: "Read path: kill two, keep one",
      pictureRows: [
        { label: "Sorted list + binary search", value: "still must rank the whole matching range → reject", tone: "bad" },
        { label: "Naive trie, DFS at read time", value: "unbounded subtree scan for 'a', 'how' → reject", tone: "bad" },
        { label: "Precomputed top-K (offline merge)", value: "O(1)-ish read, ranking already done → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Return ranked top-10 completions for a prefix in single-digit ms.",
        solution: "Precompute top-10 at every trie node offline (bottom-up merge from children); the read path is a lookup, not a search.",
        why: "Ranking is expensive (needs the whole corpus); lookups need to be cheap and bounded. Doing the expensive part once, offline, is what makes the cheap part possible.",
        tradeoff: "Suggestions can only be as fresh as the last precompute — solved by a separate real-time layer, not by this one.",
        failure: "DFS-at-read-time on a popular prefix ('how', 'a') scans a subtree with millions of descendants and blows the latency budget on exactly the queries that matter most.",
        mitigation: "Merge top-K bottom-up at build time; serve the precomputed list as a flat lookup, often literally a Redis GET by prefix key.",
      },
    },
    {
      n: 3,
      title: "Sharding the trie: hashing beats hot shards, mostly",
      body: [
        "64GB and 100K req/sec both need to be split across machines, but they split differently. Capacity says any reasonable shard count works; throughput says shard boundaries matter, because query traffic is itself Zipf-distributed — prefixes like 'how', 'what', and 'best' get vastly more requests than 'xq'.",
        "Shard by a hash of the prefix string, not by its literal first characters. Hashing spreads the lexical buckets evenly across machines so no single machine owns 'everything starting with h'. But hashing only fixes machine-level skew — a single popular prefix still routes to the same shard every time (it has to, or you'd need a scatter-gather read), so that one shard's replica count has to be sized to its own observed QPS, not the cluster average.",
      ],
      bullets: [
        { lead: "Shard by hash of the prefix", text: "not by literal first letters — lexical sharding puts every 'h' word on one machine, hash sharding spreads them out while still routing a given prefix to the same shard every time." },
        { lead: "Consistency matters more than balance", text: "a prefix's top-10 must live entirely on one shard. Splitting it across shards would force a scatter-gather merge on every read, defeating the point of precomputing." },
        { lead: "Hot shards still happen", text: "one popular prefix can still dominate its shard's QPS even after hashing. Fix with per-shard replica counts proportional to observed traffic, not a uniform replica count." },
        { lead: "~500 shards, sized for throughput", text: "64GB alone would fit on a dozen boxes; 100K req/sec with headroom for hot shards is what actually drives the shard count up." },
      ],
      pictureTitle: "Why hashing, not lexical sharding",
      pictureRows: [
        { label: "Lexical shard ('h' → one box)", value: "'how', 'how to' pile onto one machine", tone: "bad" },
        { label: "Hash of full prefix string", value: "spreads buckets evenly, still consistent", tone: "good" },
        { label: "One popular prefix, one shard", value: "still needs extra replicas for that shard", tone: "neutral" },
      ],
      remember: {
        problem: "Split a 64GB index and 100K req/sec across many machines without splitting a single prefix's answer across two of them.",
        solution: "Hash the full prefix string to pick a shard (not lexical first-letter buckets); give hot shards extra replicas sized to their own observed QPS.",
        why: "A prefix's top-10 must be fully on one shard to avoid a scatter-gather read; hashing prevents 'h'-heavy lexical clustering but can't erase genuine popularity skew.",
        tradeoff: "Extra replicas for hot shards cost machines that sit idle most of the time, for headroom you only need during a traffic spike.",
        failure: "Lexical sharding overloads whichever machine holds the most common starting letters; uniform replica counts underserve the shard that owns 'how'.",
        mitigation: "Monitor per-shard QPS and rebalance replica counts continuously, the same operational move as any hot-key problem.",
      },
    },
    {
      n: 4,
      title: "Freshness: blending a daily trie with a 1-minute trend",
      body: [
        "The precomputed trie is only as fresh as its last batch rebuild, and that rebuild runs once a day over the full Query Log Archive because reprocessing 1B distinct historical queries isn't cheap. That is much too slow for a breaking-news query that goes from zero to a million searches in twenty minutes — by the time tomorrow's rebuild runs, the spike may already be over.",
        "Run a second, much smaller and much faster pipeline alongside the batch one. Every submitted query streams through Kafka to Flink, which aggregates in short (1-minute) tumbling windows with exponential time decay, so a query's score rises fast when it spikes and fades on its own once interest cools, no manual cleanup required. That trending signal is small (a rolling top-K per prefix, not the whole corpus) and lives in a Trending Cache. The Autocomplete Service queries both the trie and the trending cache on every request and merges them, giving a spiking query a path to the top-10 in under a minute instead of under a day.",
      ],
      bullets: [
        { lead: "Batch trie: broad, stale", text: "daily rebuild, covers the whole 50M-query corpus, but a same-day spike doesn't exist in it yet." },
        { lead: "Trending cache: narrow, fresh", text: "1-minute windows with exponential decay, covers only what's moving right now, but reflects it almost immediately." },
        { lead: "Merge at read time, not build time", text: "the Autocomplete Service queries both stores per request and blends the results, rather than trying to keep one single always-fresh structure." },
        { lead: "Decay is the cleanup mechanism", text: "exponential decay means a spike's score falls on its own as attention moves on — no separate expiry job needed for the trending cache." },
      ],
      pictureTitle: "Two clocks: daily trie vs 1-minute trend",
      pictureRows: [
        { label: "Batch trie rebuild", value: "daily, full 50M-query corpus", tone: "neutral" },
        { label: "Trending cache (Flink, decay)", value: "~1 min freshness, narrow top-K", tone: "good" },
        { label: "Merged at read time", value: "Autocomplete Service queries both", tone: "good" },
        { label: "No blend, trie only", value: "breaking news invisible for up to 24h", tone: "bad" },
      ],
      remember: {
        problem: "A daily batch rebuild is too slow for a query that spikes in minutes.",
        solution: "Run a second fast pipeline (Kafka → Flink, 1-min decayed windows → Trending Cache) alongside the daily trie, and merge both at read time.",
        why: "Freshness and breadth trade off against each other; rather than pick one, serve two purpose-built stores and blend them per request.",
        tradeoff: "Two pipelines to build, run, and reconcile instead of one — plus a merge/re-rank step on every read.",
        failure: "Relying on the trie alone means breaking news doesn't surface in autocomplete until the next day's rebuild, well after the spike has passed.",
        mitigation: "Exponential decay self-cleans the trending cache, so the fast path never needs its own expiry job, only its own storage budget.",
      },
    },
    {
      n: 5,
      title: "Filtering and personalization: what happens before a suggestion is shown",
      body: [
        "Suggestions are generated automatically from what millions of strangers typed and searched, which means the raw top-10 for some prefix can include profanity, slurs, spam, or someone's leaked personal data, entirely by accident of popularity. That can't be filtered at read time — the budget is single-digit milliseconds and a classifier doesn't fit — so filtering happens in the same offline pipeline that builds the index, before a bad string can ever become a precomputed answer.",
        "Personalization is the opposite shape: it's specific to one user, so it can't live in the shared corpus at all. The Autocomplete Service applies it as a thin final re-rank step after merging the trie and trending results — boosting a user's own recent searches slightly — so one person's unusual queries never leak into the suggestions shown to everyone else.",
      ],
      bullets: [
        { lead: "Filter at build time, not read time", text: "a blocklist plus a classifier runs inside the Spark batch job, so profanity, spam, and PII never make it into the precomputed top-K in the first place." },
        { lead: "Read-time budget can't afford a classifier", text: "running an ML filter per request would blow the sub-20ms server budget; filtering has to be a one-time cost, amortized over every future read." },
        { lead: "Personalization is a per-request re-rank", text: "applied by the Autocomplete Service after merging the shared trie + trending results, using only that user's own recent history." },
        { lead: "Shared corpus stays shared", text: "personalization never gets written back into the global trie or trending cache — one person's boost can't become everyone's default." },
      ],
      pictureTitle: "Where filtering and personalization happen",
      pictureRows: [
        { label: "Profanity / spam / PII filter", value: "offline, at index build time", tone: "good" },
        { label: "Same filter at read time", value: "too slow for the 20ms budget → reject", tone: "bad" },
        { label: "Personalization (user boost)", value: "per-request re-rank, not written back", tone: "good" },
      ],
      remember: {
        problem: "Automatically generated suggestions can surface offensive, spammy, or private strings, and every user still wants their own signal reflected.",
        solution: "Filter offline at index build time (blocklist + classifier); personalize online as a final per-request re-rank, never fed back into the shared corpus.",
        why: "Filtering is a one-time, amortizable cost that doesn't fit the read budget; personalization is inherently per-user and would pollute the shared index if written back.",
        tradeoff: "Offline filtering means a newly-bad viral phrase can still slip through until the next rebuild catches it.",
        failure: "Skip offline filtering and the system will, eventually, precompute and confidently suggest something offensive or someone's leaked private data to millions of users.",
        mitigation: "Blocklist plus classifier in the batch job, with a fast manual takedown path outside the normal rebuild cadence for anything reported urgently.",
      },
    },
    {
      n: 6,
      title: "The client contract: why 100K/sec isn't 500K/sec",
      body: [
        "A user typing a 10-character query fires a keystroke event 10 times, and without any client-side discipline that's 10 network requests for one search — the request volume the backend has to survive is set as much by client behavior as by user count. This is the cheapest lever in the whole design, and it belongs on the board before any server capacity numbers are trusted.",
        "Three small client rules do most of the work: debounce roughly 100-150ms after the last keystroke before firing (most people type faster than that between characters), cancel any in-flight request the instant a new one fires so a slow response for 'ho' can't overwrite the fresh one for 'how', and require a minimum prefix length (commonly 2 characters) before requesting at all, since a 1-character prefix is simultaneously the highest-fanout and least-useful request in the system.",
      ],
      bullets: [
        { lead: "Debounce ~100-150ms", text: "collapses a burst of keystrokes into roughly one request per pause, cutting request volume by roughly the average typing burst length." },
        { lead: "Cancel in-flight requests", text: "without this, a slow response for an earlier, shorter prefix can arrive after a faster response for the current one and flicker the wrong suggestions onto the screen." },
        { lead: "Minimum prefix length (2 chars)", text: "a single character is the single hottest possible shard key and the suggestions are the least useful — not worth the request." },
        { lead: "This is a contract, not a hint", text: "the backend's 100K/sec design number assumes these client rules hold; without them the real number is several times higher." },
      ],
      pictureTitle: "What debounce buys you",
      pictureRows: [
        { label: "No debounce, no cancel", value: "~1 request per keystroke, races on screen", tone: "bad" },
        { label: "Debounce ~120ms", value: "collapses a typing burst to ~1 request", tone: "good" },
        { label: "Cancel in-flight on new keystroke", value: "stops a stale response from winning", tone: "good" },
        { label: "Min 2-char prefix", value: "skips the hottest, least useful requests", tone: "good" },
      ],
      remember: {
        problem: "Naive per-keystroke requests multiply true user demand into far more backend traffic than user count would suggest.",
        solution: "Debounce ~100-150ms, cancel in-flight requests on every new keystroke, and require a minimum 2-character prefix before firing at all.",
        why: "Most of a typing burst never needs its own round trip; only the pause matters, and a stale response for a shorter prefix must never win a race against a fresher one.",
        tradeoff: "Debounce adds a small, deliberate delay before the very first suggestion appears — a UX cost paid for a large traffic reduction.",
        failure: "Skip cancellation and a slow response for an earlier keystroke can land after a fast response for the current one, flashing wrong suggestions onto the screen.",
        mitigation: "Treat debounce, cancellation, and minimum prefix length as part of the system's contract, not an optional client nicety — write them on the board with the server capacity numbers.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a prefix lookup with the ranking already done: an offline job precomputes the top-10 for every prefix so the read path is just a fetch, not a search.",
      "The index has two clocks — a daily batch rebuild for broad historical popularity, and a 1-minute decayed trending cache for anything spiking right now — merged at read time.",
      "Sharding is by a hash of the prefix so a given prefix's answer always lives whole on one shard, with extra replicas for shards that own unusually popular prefixes.",
      "Filtering for profanity, spam, and PII happens offline at index build time, because the read budget is too tight for a classifier per request.",
      "Client debounce, request cancellation, and a minimum prefix length are part of the contract — they're what keeps 100K/sec from actually being 500K/sec.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 100K/S · SUB-20MS P99",
        summary:
          "A keystroke, after debounce, asks one shard for the historical top-10 and the trending cache for anything spiking right now, then merges and re-ranks before returning.",
        steps: [
          { label: "Client", note: "debounced ~120ms, cancels prior in-flight request" },
          { label: "API Gateway", note: "regional LB" },
          { label: "Autocomplete Service", note: "hashes prefix → shard" },
          { label: "Trie Shard Cluster", note: "precomputed top-10, in-memory" },
          { label: "Trending Cache", note: "Valkey, ~1 min freshness" },
          { label: "Merge + filter + personalize", note: "re-rank, boost user's own recent searches" },
          { label: "Response", note: "top-10 ranked suggestions" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · SUBMITTED QUERY LOGGED",
        summary:
          "A submitted search or a clicked suggestion is the real popularity signal, not a keystroke — it's logged once, then fans out to both the real-time and batch pipelines.",
        steps: [
          { label: "Client", note: "on submit or suggestion click" },
          { label: "Search Service", note: "logs the query + which suggestion was clicked" },
          { label: "Kafka", note: "query-submitted event stream" },
          { label: "downstream", note: "feeds both the trending pipeline and the archive" },
        ],
      },
      {
        kind: "analytics",
        title: "ANALYTICS · TRENDING + DAILY REBUILD",
        summary:
          "Two consumers read the same Kafka stream at two speeds: Flink keeps a fast, self-decaying trending signal; Spark rebuilds the full precomputed trie once a day from the archive.",
        steps: [
          { label: "Kafka", note: "query-submitted events" },
          { label: "Flink", note: "1-min windows, exponential decay" },
          { label: "Trending Cache", note: "<1 min freshness, narrow top-K" },
          { label: "Query Log Archive", note: "S3/HDFS, full history" },
          { label: "Spark Batch Job", note: "daily rebuild" },
          { label: "Trie Builder", note: "merge top-10 bottom-up, snapshot swap" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "1B distinct queries logged, ~50M indexed (5+ hits/90d cut)",
          "~200M trie nodes after prefix sharing, ~64GB precomputed top-10 index",
          "100K autocomplete requests/sec peak, sub-20ms p99 server-side",
          "Trending freshness < 1 min (Flink, 1-min decayed windows); full rebuild daily",
          "~500 shards, sized by QPS headroom, not raw GB",
          "Top-10 suggestions returned per request",
          "Min 2-char prefix, ~120ms client debounce",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Precompute top-10 at every trie node offline; the read path is a lookup, not a DFS",
          "Shard by hash of the full prefix, not lexical first letters; extra replicas for hot shards",
          "Two-clock freshness: daily batch trie + 1-min decayed trending cache, merged at read time",
          "Filter profanity/spam/PII at index build time, never on the read path",
          "Personalization is a per-request re-rank on top of the shared corpus, never written back into it",
          "Client owns debounce, request cancellation, and minimum prefix length as a contract",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "A naive trie DFS at read time is unbounded for popular prefixes ('how', 'a') — ranking must be precomputed",
          "Query traffic is itself Zipf-distributed, so hashing alone doesn't erase hot-shard skew",
          "Exponential decay is what lets the trending cache clean itself up without a separate expiry job",
          "Debounce and cancellation are a traffic-shaping contract, not just UX polish — the 100K/sec number assumes them",
          "Filtering happens offline because the read budget (sub-20ms) can't fit a classifier",
          "A prefix's full top-10 must live on one shard — never scatter-gather a suggestion list",
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
      goal: "Get five numbers and the freshness expectation on the board before drawing anything, so the interviewer confirms scope out loud.",
      why: "Every later decision (index size, shard count, freshness pipeline) falls out of these numbers. Locking them first is what separates a driven design from a guessed one.",
      steps: [
        { kind: "ASK", text: '**Is this dominated by reads or writes?** Walk them to "100K autocomplete requests/sec" against "maybe 5K submitted-searches/sec" — that\'s roughly a 20:1 ratio, and write **"100K r/s, ~5K submits/s, 20:1"** in the top-left corner.' },
        { kind: "ASK", text: 'Ask **"How fresh does trending need to be?"** Land on "breaking news should surface within about a minute", and write **"< 1 min trending, daily full rebuild"** underneath.' },
        { kind: "SAY", text: 'Propose the latency budget yourself: **"sub-20ms p99 server-side"**, **"sub-100ms end-to-end including client debounce"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "prefix ranking", "the precomputed index", "the trending blend", "filtering", "client debounce contract". Out: "the search-results ranking itself", "spell-correction", "voice input". "Let me know if you want me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the sizing out loud: **"1B distinct queries logged, cut to ~50M worth indexing"**, **"~200M trie nodes after prefix sharing"**, **"~64GB precomputed index"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, parking out-of-scope items deliberately, and locking latency and freshness budgets before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Contract",
      minutes: 5,
      goal: "One read endpoint, a clear statement of what the real write signal is, and the precomputed-record shape, before anyone suggests a live DFS.",
      why: "The interviewer wants to see you commit to a tiny read surface and correctly identify that the write signal is a submission or click, not a keystroke — a common early mistake.",
      steps: [
        { kind: "WRITE", text: 'Write the one endpoint that matters: **"GET /suggest?q=<prefix>&user=<id>"** returns **"{ suggestions: [ {text, score} × 10] }"**, "read-only, uncapped, latency-critical".' },
        { kind: "SAY", text: 'Say what the write side really is: "There\'s no explicit write endpoint for the index — the real write is a submitted search or a clicked suggestion, logged by a Search Service, not requested by the client that\'s typing."' },
        { kind: "DRAW", text: 'Sketch the precomputed record: **"prefix (implicit, the trie path)"**, **"top-10 [ {text, score} ]"**, **"last_updated"**. Say: "Every node already holds its answer before a request arrives — that\'s the whole design."' },
        { kind: "RULE OUT", text: 'Get ahead of the obvious wrong answer: "Ranking at read time with a live DFS over the trie subtree is unbounded for a popular prefix like \'how\' — that has to be precomputed, not computed on demand."' },
      ],
      grading: "Crisp endpoint, correct identification of the real write signal, and the precomputed-record shape brought forward unprompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: read, write, and background/analytics. Label arrows with the clock each lane runs on.",
      why: "Drawing read, write, and background as separate lanes proves you understand they run on different clocks — milliseconds, per-submission, and minutes-to-days — and therefore need different infra.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read lane**: Client → API Gateway → Autocomplete Service → Trie Shard Cluster + Trending Cache → merge → response. Label arrows **"hash(prefix) → shard"**, **"historical top-10"**, **"trending blend"**.' },
        { kind: "DRAW", text: 'Add the **write lane**: Client → Search Service → Kafka, labeled **"on submit / click, not on keystroke"**.' },
        { kind: "DRAW", text: 'Add the **analytics/background lane** off Kafka: → Flink → Trending Cache (labeled **"1-min decay"**), and → Query Log Archive → Spark → Trie Builder → back into Trie Shard Cluster (labeled **"daily snapshot swap"**).' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they run on three different clocks — the read lane is milliseconds, the write lane is per-submission, and the background lane is one minute for trending and one day for the full rebuild."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with the clock speed each one runs on, and an explicit statement of why they're separate.",
    },
    {
      n: 4,
      title: "Deep Dive: Precomputed Trie & Sharding",
      minutes: 8,
      goal: "Show the bottom-up top-K merge and the hash-based sharding, and defend both against the obvious naive alternatives.",
      why: "This is the signature sub-problem. The interviewer is probing whether you understand that ranking must happen offline and that sharding needs to preserve per-prefix consistency, not just balance load.",
      steps: [
        { kind: "SAY", text: 'State the core trick: "Every trie node\'s top-10 is computed once, offline, by merging each child\'s top-10 up the tree — a read is a lookup at the node you already walked to, not a search from there."' },
        { kind: "DRAW", text: "Sketch the merge: a node with children c1, c2, c3, each holding their own top-10; the parent's top-10 is the best 10 across all children's top-10s, not a full re-scan of the subtree." },
        { kind: "SAY", text: 'Explain sharding: "Shard by a hash of the full prefix string, not lexical first letters — that spreads \'h\'-heavy traffic across machines, while a given prefix always lands on the same shard so its top-10 never has to be scatter-gathered."' },
        { kind: "RULE OUT", text: "One line each: **Binary search on a sorted list** → still has to rank the matching range at read time. **Naive DFS trie** → unbounded subtree scan for common prefixes." },
        { kind: "SAY", text: 'Name the residual risk: "Hashing fixes machine-level skew, not popularity skew — one shard can still own \'how\' and needs its own extra replicas sized to its own QPS."' },
      ],
      grading: "The bottom-up merge explained without prompting, hash sharding defended against lexical sharding, and the hot-shard residual risk named unprompted.",
    },
    {
      n: 5,
      title: "Deep Dive: Freshness — Batch vs Trending Blend",
      minutes: 7,
      goal: "Explain the two-pipeline freshness model and why merging at read time beats trying to keep one structure always fresh.",
      why: "Anyone can say 'rebuild more often.' The interviewer wants a quantified two-clock model, and — for the top score — the candidate volunteering the breaking-news failure mode before being asked.",
      steps: [
        { kind: "SAY", text: 'State the tension: "The full trie only rebuilds daily, because reprocessing the whole indexed corpus isn\'t cheap — but a breaking-news query can spike from zero in twenty minutes. Relying on the daily trie alone means it\'s invisible until tomorrow."' },
        { kind: "DRAW", text: 'Add the fast path: Kafka → Flink, 1-minute tumbling windows, exponential decay → Trending Cache. Say: "Decay means the score fades on its own as interest cools — no separate cleanup job."' },
        { kind: "SAY", text: 'Explain the merge: "The Autocomplete Service queries both the trie shard and the trending cache on every request and blends them — broad-but-stale plus narrow-but-fresh, merged at read time rather than trying to keep one structure always current."' },
        { kind: "SAY", text: 'Volunteer the failure mode unprompted: "Without the trending cache, a query that spikes today doesn\'t show up in autocomplete until after tomorrow\'s rebuild — by then the spike may be over."' },
      ],
      grading: "Two-clock model stated with numbers, the read-time merge explained clearly, and the breaking-news failure mode volunteered rather than pulled out by a follow-up.",
    },
    {
      n: 6,
      title: "Wrap: Filtering, Personalization, Client Contract, Close",
      minutes: 5,
      goal: "Name where filtering and personalization live, bring up the client contract unprompted, and close with a one-sentence summary plus a parked-items list.",
      why: "Staff-level signal is treating filtering, personalization, and client behavior as load-bearing design decisions rather than afterthoughts, and closing the interview like a collaborator instead of running out the clock.",
      steps: [
        { kind: "SAY", text: '"Profanity, spam, and PII filtering happens inside the Spark batch job, offline — the read budget is 20ms, far too tight for a classifier per request."' },
        { kind: "SAY", text: '"Personalization is a thin per-request re-rank in the Autocomplete Service after merging trie and trending results — a user\'s own recent searches get a small boost, and it\'s never written back into the shared corpus."' },
        { kind: "SAY", text: '"None of the server numbers hold without debounce, request cancellation, and a minimum prefix length on the client — that\'s the cheapest traffic reduction in the whole system, and it belongs on the board."' },
        { kind: "SAY", text: '"It\'s a precomputed prefix lookup with two freshness clocks blended at read time. With more time I\'d cover spell-correction, multi-word reordering, and per-locale trending lists."' },
      ],
      grading: "Filtering and personalization correctly located, the client contract named unprompted, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but the numbers and the read-time cost of ranking stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: a cache/store in front of the ranking, a queue for logging searches, and a trie if prompted.",
          "Knows suggestions should be ranked by popularity and can sketch a simple frequency counter.",
          "Picks a trie as 'the' data structure without being pushed on read-time cost.",
          "Adds a cache in front of the store once told reads dominate.",
          "Handles 'what about trending' by saying 'recompute more often'.",
        ],
        gaps: [
          "Never quantifies index size or shard count — 'store it in a trie' with no numbers behind it.",
          "Doesn't notice that a naive trie DFS at read time is unbounded for a popular prefix.",
          "Treats 'recompute more often' as the whole answer to freshness, with no real-time pipeline.",
          "No client-side story — assumes every keystroke is a request with no debounce or cancellation.",
          "Filtering, if mentioned at all, is 'add a blocklist' with no notion of where it runs.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks precomputation as the core trick unprompted, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes QPS, index size, and latency budget on the board within the first 5-8 minutes.",
          "States precomputed top-K as the core trick, unprompted: rank offline, read is a lookup.",
          "Shards by hash of the prefix and explains why lexical sharding is worse.",
          "Proposes a two-pipeline freshness model: batch rebuild plus a faster trending signal.",
          "Separates filtering (offline, shared) from personalization (online, per-user, not written back).",
          "Mentions client debounce and cancellation as part of the design, not an afterthought.",
        ],
        gaps: [
          "Volunteers the trending pipeline only after being asked how fresh 'trending' really is.",
          "Doesn't quantify the hot-shard problem — knows it exists but can't say how it's mitigated with numbers.",
          "Exponential decay is named but not explained as the thing that avoids a separate cleanup job.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, quantifies every failure mode before being asked, and brings operational maturity that goes beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the two-clock freshness model (daily batch + 1-min decayed trending) before being asked, and explains why merging at read time beats trying to keep one structure always fresh.",
          "Quantifies the hot-shard mitigation: hashing fixes machine skew, replica count per shard fixes popularity skew, and explains why those are different problems.",
          "Frames the client debounce/cancellation contract as load-bearing for the 100K/sec number, not a UX nicety, and states the multiplier it's protecting against.",
          "Separates filtering (build-time, shared) from personalization (read-time, per-user, never written back) without being asked, and explains why swapping them would break something.",
          "Pushes back on requirements: 'do we need per-user personalization on every request, or just a login-gated feature?' — treats scope as negotiable.",
          "Closes with a one-sentence summary and an explicit list of what's out of scope, pacing the interview like a collaborator.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Proposing a live DFS over the trie subtree at read time as 'the' design, with no acknowledgment that a popular prefix's subtree is huge.",
      "Treating a keystroke as the write signal instead of a submitted search or click — that inflates both the request volume and the popularity data with noise.",
      "No client-side debounce or cancellation story, so the 100K/sec design number is actually several times too low.",
      "Filtering suggestions at read time with a classifier, blowing the sub-20ms budget on every single request instead of once at index-build time.",
      "Writing a user's personalization signal back into the shared trie or trending cache, so one person's odd searches leak into everyone else's suggestions.",
      "No freshness story beyond 'rebuild more often' — no distinction between a broad daily rebuild and a narrow, fast trending signal.",
      "Sharding lexically (by first letter) and never noticing that 'h' or 's' words dominate a single machine.",
    ],
    followUps: [
      {
        q: "Why precompute the top-10 at every trie node instead of ranking at read time?",
        a: "Ranking needs to see the whole relevant subtree to know what's actually best, and for a popular prefix that subtree can have millions of descendants — doing that per request blows the sub-20ms budget on exactly the queries that matter most. Precomputing bottom-up at build time (each node's top-10 is the best 10 across its children's top-10s) means every node already holds its answer, so a read is a lookup at the node you walked to, not a search from there.",
      },
      {
        q: "How do you keep the trending cache from growing forever?",
        a: "Exponential decay does the cleanup for free — a query's score is weighted by recency, so it rises fast on a spike and fades on its own as attention moves elsewhere, with no separate expiry job needed. The cache also only ever holds a narrow top-K per prefix window, not the full corpus, so its footprint stays small regardless of how much total query volume flows through Kafka.",
      },
      {
        q: "What happens if a shard goes down?",
        a: "Each shard is replicated (more replicas for hot shards, sized to their own observed QPS), so a request just fails over to another replica of the same shard — availability doesn't depend on any single machine. Because the index is read-only and rebuilt from the batch pipeline plus the trending cache, a lost replica is trivially replaceable by resyncing from the last snapshot, unlike a stateful write-heavy store where a lost replica risks data loss.",
      },
      {
        q: "Why not just increase the batch rebuild frequency instead of building a separate trending pipeline?",
        a: "Reprocessing the full ~50M-query indexed corpus is expensive by design — that's exactly why it only runs daily. Running it hourly doesn't get you to under a minute of freshness, and running it every minute means paying the full-corpus cost 1,440 times a day for almost no benefit, since 99.9% of the corpus doesn't change minute to minute. A narrow, purpose-built trending pipeline (only the queries currently spiking) is orders of magnitude cheaper than shrinking the batch window.",
      },
      {
        q: "How would personalization scale if every user got a fully personalized suggestion list?",
        a: "That would mean storing and serving a separate top-10 per user rather than a shared corpus, which turns a 64GB shared index into something that scales with user count instead of query count — untenable at scale. The design instead keeps one shared corpus and applies personalization as a thin final re-rank (boost a user's own recent searches slightly) on top of the shared merge, so personalization cost stays O(a few recent searches) per request instead of O(full corpus) per user.",
      },
      {
        q: "What's the actual failure mode if the client doesn't debounce?",
        a: "Every keystroke becomes its own request, so a 10-character query goes from roughly one request to as many as ten, multiplying the true request volume several-fold beyond the 100K/sec design number. Worse, without request cancellation, a slower response for an earlier, shorter prefix can arrive after a faster response for the current one, flashing stale suggestions onto the screen — a correctness bug on top of a capacity bug.",
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
          "This is a prefix-lookup system where all the expensive work — ranking, filtering, freshness — happens offline, so the read path is nearly free. The core operation, turn a typed prefix into 10 ranked suggestions, is a lookup once precomputation is done; everything else in the design exists to make that precomputation correct, fresh, and safe to show to millions of strangers.",
          "Anchor on the numbers: 1B logged queries cut to ~50M indexed, ~64GB precomputed index, 100K requests/sec, sub-20ms p99, trending freshness under a minute, full rebuild daily. Every structural choice below follows from these, not from a preference for tries.",
        ],
      },
      {
        heading: "Sizing and the long-tail cut",
        body: [
          "Base sizing on repeat value, not raw log volume: a query that was searched once will probably never be searched again, so indexing it buys nothing. Cutting to queries with 5+ hits in a trailing 90-day window takes 1B distinct logged queries down to roughly 50M worth indexing.",
          "At ~18 characters average and heavy prefix sharing, 50M queries compress to roughly 200M trie nodes. Precomputing the top-10 suggestions at each node (10 strings + scores, ~320 bytes) brings the total index to roughly 64GB — small enough to replicate widely, large enough that no single machine holds it all.",
        ],
      },
      {
        heading: "The core trick: precompute, don't search",
        body: [
          "A trie answers 'what starts with this prefix' cheaply, but it doesn't answer 'what are the best 10 things that start with this prefix' cheaply — that needs ranking, and ranking needs to see the whole matching subtree, which can be enormous for a common prefix. The fix is to do that ranking once, offline, not on every request.",
          "Each node's top-10 is computed bottom-up: merge each child's own top-10 up through the tree, keeping only the best 10 candidates seen so far at each level. By the time the trie is built, every node already holds the answer to 'what's best under me' — a read becomes walk-to-node-and-return, not walk-to-node-and-then-search.",
        ],
      },
      {
        heading: "Sharding: hash the prefix, watch the hot ones",
        body: [
          "The 64GB index and the 100K req/sec load split across machines differently. Storage alone would fit on a dozen boxes; throughput and headroom for skewed traffic is what pushes shard count into the hundreds. Shard by a hash of the full prefix string — not by literal first letters — so lexically clustered traffic ('h', 's' words) doesn't pile onto one machine.",
          "Hashing fixes machine-level imbalance but can't erase genuine popularity skew: a single very popular prefix routes to the same shard every time (it has to, so its precomputed top-10 doesn't need a scatter-gather read), and that shard needs its own replica count sized to its own observed QPS, not a cluster-wide average.",
        ],
      },
      {
        heading: "Two clocks: daily batch, one-minute trend",
        body: [
          "The full trie rebuilds once a day because reprocessing the entire indexed corpus is expensive, but a breaking-news query can spike in minutes — far faster than the batch clock. Rather than shrink the batch window (which would mean paying the full-corpus cost far more often for almost no benefit), run a second, narrow, fast pipeline: Kafka streams every submitted query to Flink, which aggregates in 1-minute tumbling windows with exponential time decay.",
          "The trending signal is small — a rolling top-K per prefix, not the whole corpus — and self-cleaning, since decay fades a query's score once interest cools without any explicit expiry job. The Autocomplete Service queries the trie and the trending cache on every request and merges them, so a spike surfaces in under a minute while the broad historical ranking still comes from the day-old trie.",
        ],
      },
      {
        heading: "Safety and the client contract",
        body: [
          "Two more layers sit around the core lookup. Filtering (profanity, spam, PII) happens inside the offline batch job, because the read path's sub-20ms budget can't afford a classifier per request and because a bad string, once precomputed, would otherwise get served to millions of people automatically. Personalization runs the opposite direction — a thin per-request re-rank in the Autocomplete Service, using only that one user's recent searches, and it's never written back into the shared corpus.",
          "None of the server-side numbers hold without client discipline: debouncing roughly 100-150ms after the last keystroke, cancelling any in-flight request the moment a new one fires, and refusing to request below a minimum prefix length. Skip these and the true request volume is several times the 100K/sec design number, and stale responses can race fresh ones onto the screen.",
        ],
      },
    ],
  },
};
