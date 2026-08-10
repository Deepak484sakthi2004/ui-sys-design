import type { Problem } from "@/lib/types";

export const urlShortener: Problem = {
  slug: "design-url-shortener",
  num: "1.1",
  title: "Design a URL Shortener",
  level: "Easy",
  deepDiveAvailable: true,
  intro: [
    "Design a URL shortener that stores 10 billion short URLs, serves 100K redirects/sec globally with sub-5ms p99 server-side on cache hit, supports custom aliases and expiration, and runs click analytics without touching redirect latency.",
  ],
  hardParts:
    "The hard parts: generating unique IDs without cross-region coordination, absorbing viral hot keys, and keeping the cache hit rate honest when traffic drifts away from a Zipf distribution.",
  keyTopics: [
    "Region-Prefixed Counter IDs",
    "Bijective Shuffle (Feistel)",
    "Three-Layer Caching",
    "Multi-Region Active-Active",
    "Read-Heavy System",
  ],
  foundationsReferenced: [
    { label: "ScyllaDB", tone: "purple" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "LSM Trees vs B-Trees", tone: "blue" },
    { label: "Paxos", tone: "orange" },
    { label: "Valkey / Redis", tone: "purple" },
    { label: "Exactly-Once Processing", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "cdn", label: "CDN", sub: "~25% hit", col: 1, row: 1, tone: "green" },
      { id: "client", label: "Client", col: 1, row: 2, tone: "slate" },
      { id: "lb", label: "Regional LB", col: 2, row: 2, tone: "slate" },
      {
        id: "redirect",
        label: "Redirect Service",
        sub: "stateless · 100K/s",
        mono: "in-proc LRU · 10s TTL",
        col: 3,
        row: 2,
        tone: "green",
      },
      { id: "valkey", label: "Valkey", sub: "~150M hot keys", col: 4, row: 2, tone: "green" },
      { id: "kafka", label: "Kafka", col: 3, row: 3, tone: "orange" },
      { id: "flink", label: "Flink", col: 4, row: 3, tone: "orange" },
      { id: "clickhouse", label: "ClickHouse", col: 5, row: 3, tone: "orange" },
      {
        id: "create",
        label: "Create Service",
        mono: "counter → Feistel → B62",
        col: 2,
        row: 4,
        tone: "purple",
      },
      {
        id: "scylla",
        label: "ScyllaDB",
        sub: "3 regions · RF=3",
        mono: "immutable rows",
        col: 5,
        row: 4,
        tone: "blue",
      },
    ],
    edges: [
      { from: "client", to: "cdn", kind: "read" },
      { from: "cdn", to: "lb", label: "miss", kind: "read" },
      { from: "client", to: "lb", kind: "read" },
      { from: "lb", to: "redirect", kind: "read" },
      { from: "redirect", to: "valkey", label: "~80%", kind: "read" },
      { from: "valkey", to: "scylla", label: "miss · LOCAL_ONE", kind: "read" },
      { from: "redirect", to: "kafka", label: "async", kind: "analytics" },
      { from: "kafka", to: "flink", kind: "analytics" },
      { from: "flink", to: "clickhouse", kind: "analytics" },
      { from: "lb", to: "create", label: "1K/s", kind: "write" },
      { from: "create", to: "scylla", label: "insert · LOCAL_QUORUM · per-row TTL", kind: "write" },
    ],
    legend: [
      { kind: "read", text: "read path · 100K redirects/s" },
      { kind: "write", text: "write path · 1K creates/s" },
      { kind: "analytics", text: "analytics · async, never blocks a redirect" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "lb", "redirect", "create"],
      say: "Two stateless services behind a regional load balancer. Reads and writes never share a path, and at 100 to 1 read-to-write, the redirect side is the one that has to be fast.",
    },
    {
      reveal: ["cdn", "valkey"],
      say: "Reads outnumber writes 100 to 1, so this is a cache problem. Three layers sit in front of the database: CDN at the edge, an in-process LRU inside each pod, and a shared Valkey cluster. Target: sub-5ms p99 on a hit.",
    },
    {
      reveal: ["scylla"],
      say: "ScyllaDB stores immutable rows across 3 regions. Each region mints codes from its own prefixed counter range, shuffled by a keyed Feistel and Base62-encoded, so regions never coordinate on the write path.",
    },
    {
      reveal: ["kafka", "flink", "clickhouse"],
      say: "The redirect drops a click event into Kafka and moves on. Analytics is fire and forget: a Kafka outage costs some analytics events, never a redirect.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Create a short URL from a long URL, returning a unique 7-character code", tag: "P0" },
      { id: "FR-02", text: "Redirect a short code to the original URL via HTTP 302 (301 opt-in for SEO)", tag: "P0" },
      { id: "FR-03", text: "Custom aliases: user-chosen short codes, globally unique", tag: "P0" },
      { id: "FR-04", text: "Expiration: optional TTL per URL (1 day, 7 days, 30 days, 1 year, never)", tag: "P0" },
      { id: "FR-05", text: "API-key authentication for creates, with per-key rate limiting", tag: "P0" },
      { id: "FR-06", text: "Click analytics: total clicks, clicks over time, geographic breakdown", tag: "P1" },
      { id: "FR-07", text: "Referrer and device tracking per click", tag: "P1" },
      { id: "FR-08", text: "Bulk creation via API (up to 1000 URLs per request)", tag: "P1" },
      { id: "FR-09", text: "URL deletion by the owner", tag: "P1" },
      { id: "FR-10", text: "Link preview page (destination, owner, click count) without redirecting", tag: "P2" },
      { id: "FR-11", text: "QR code generation for any short URL", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Redirect latency on cache hit, server-side", tag: "p99 < 5ms" },
      { id: "NFR-02", text: "Redirect latency on cache miss, server-side", tag: "p99 < 15ms" },
      { id: "NFR-03", text: "Redirect throughput, sustained globally", tag: "100K/sec" },
      { id: "NFR-04", text: "Create throughput, sustained (10K burst)", tag: "1K/sec" },
      { id: "NFR-05", text: "Availability (about 52 min downtime per year)", tag: "99.99%" },
      { id: "NFR-06", text: "Durability: no data loss for non-expired URLs", tag: "zero loss" },
      { id: "NFR-07", text: "Analytics freshness, from click to dashboard", tag: "< 5s" },
      { id: "NFR-08", text: "Read-to-write ratio that anchors the whole design", tag: "100:1" },
      { id: "NFR-09", text: "Short code length (Base62, 62⁷ ≈ 3.5T codes)", tag: "7 chars" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why exactly 7 characters?",
      body: [
        "Before choosing how to generate codes, prove 7 characters is even enough. Each character is Base62, that is 0-9, a-z, A-Z, so 62 options per slot. Seven slots is 62⁷, about 3.5 trillion combinations. We need 10 billion. That is 10B divided by 3.5T, roughly 0.3% of the space, so 7 characters is not just enough, it is about 350 times more than we need.",
      ],
      bullets: [
        { lead: "6 characters", text: "is only 62⁶ = 56B. That covers 10B today but leaves almost no headroom, so one growth spurt breaks it." },
        { lead: "8 characters", text: "is 62⁸ = 218T, far more than we need now. We hold it in reserve for the exhaustion plan instead of paying for longer URLs today." },
        { lead: "62⁷ ≈ 2⁴²", text: "which is why the internal ID is exactly 42 bits. The character count and the bit width are the same fact in two units." },
      ],
      pictureTitle: "Does a 7-char code fit 10B URLs?",
      pictureCaption: "capacity: 7 chars = 62⁷ = 3.5 trillion · used: 10B = 0.3% (thin amber sliver, ~350× headroom)",
      pictureRows: [
        { label: "6 chars = 62⁶ ≈ 56B", value: "too tight: one growth spurt breaks it", tone: "bad" },
        { label: "8 chars = 62⁸ ≈ 218T", value: "held in reserve for the rollover", tone: "good" },
      ],
      remember: {
        problem: "Is a 7-char code enough for 10B URLs?",
        solution: "Yes — 62⁷ ≈ 3.5T codes; 10B is ~0.3% of that, about 350× headroom.",
        why: "Each Base62 slot has 62 options; 7 slots ⇒ 62⁷ ≈ 2⁴² ≈ 4.4T addressable, ~3.5T usable.",
        tradeoff: "6 chars (56B) is too tight for growth; 8 chars (218T) makes every URL longer for headroom you don't need yet.",
        failure: "Undersize to 6 chars and a single growth spurt exhausts the space, forcing an emergency migration.",
        mitigation: "Ship 7 chars, hold 8 in reserve, and trigger the rollover at 90% counter utilization as a rehearsed step.",
      },
    },
    {
      n: 2,
      title: "ID generation: kill three options, defend one",
      body: [
        "We need 10B unique 7-char codes created across 3 regions with no coordination on the write path. A cross-region lock per create would add 100ms or more of cross-region (WAN, wide-area network) latency to every write, so the generator must never be able to produce the same code twice. Put the candidates on the board and rule them out one at a time.",
      ],
      bullets: [
        { lead: "UUID", text: "128 bits encodes to 22 Base62 characters. The short URL is 3× longer, which defeats the whole point. Rejected." },
        { lead: "Random + check", text: "generate a random code, then read the DB to confirm it is free. That is a DB read on every single write, so the write path becomes read-heavy under load. Rejected." },
        { lead: "Hash truncation", text: "hash the long URL and keep 42 bits. The birthday paradox (collisions show up near the square root of the space) means two URLs collide after only ~2M inserts, not 4.4T. Rejected." },
        { lead: "Counter", text: "a plain incrementing number is unique and free to produce, but sequential codes are guessable, so anyone can walk /00001, /00002 and scrape every link. Partially accepted." },
        { lead: "Region-prefixed counter + Feistel", text: "the top 4 bits are the region id (16 regions), the low 38 bits are that region's own counter (~275B each). Two regions can never collide because their top bits differ. Then run the 42-bit value through a Feistel shuffle (a reversible scramble that turns 1, 2, 3 into unguessable values and never collides) before Base62. Winner." },
      ],
      pictureTitle: "ID generation: kill three, keep one",
      pictureRows: [
        { label: "UUID", value: "22 chars, 3× longer → reject", tone: "bad" },
        { label: "Random + check", value: "1 DB read per write → reject", tone: "bad" },
        { label: "Hash truncation", value: "collides at ~2M (birthday) → reject", tone: "bad" },
        { label: "Counter", value: "unique but guessable → partial", tone: "neutral" },
        { label: "Counter + Feistel", value: "unique + unguessable → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Unique 7-char codes, no cross-region coordination.",
        solution: "Region-prefixed counter (4-bit region + 38-bit local counter) → Feistel shuffle → Base62.",
        why: "Disjoint region prefixes make cross-region collisions impossible without a lock; Feistel makes the sequential counter unguessable while staying bijective (never collides).",
        tradeoff: "You give up human-meaningful/sequential codes and add a tiny per-create shuffle, for zero WAN coordination on writes.",
        failure: "A naked counter is guessable; UUID triples URL length; hash truncation collides at ~2M via the birthday paradox.",
        mitigation: "Prefetch counter ranges (100K per pod ≈ 3 min headroom) so a brief Scylla blip doesn't stall creates.",
      },
    },
    {
      n: 3,
      title: "Three-layer caching: how sub-5ms is actually met",
      body: [
        "A redirect is a key-value lookup, and the whole latency budget is spent deciding who answers it. Put three caches in front of the database and only touch the database when none of them knows the code. Each layer is cheaper and closer than the one behind it.",
      ],
      bullets: [
        { lead: "CDN edge", text: "absorbs ~25% of redirects at the edge with a short 302 cache, closest to the user and never even reaches your servers." },
        { lead: "In-process LRU", text: "a per-pod map with a 10s TTL. A hit here is a memory read, single-digit microseconds, no network hop at all." },
        { lead: "Valkey", text: "a shared cache holding ~150M hot keys, catching ~80% of whatever slips past the first two layers." },
        { lead: "ScyllaDB", text: "the source of truth, touched only on a full miss. Rows are immutable, so a stale cache read is impossible — the value never changes after insert." },
      ],
      pictureTitle: "Who answers a redirect?",
      pictureRows: [
        { label: "CDN edge (~25%)", value: "302 cached at edge, 0 server hops", tone: "good" },
        { label: "In-process LRU (10s TTL)", value: "memory read, single-digit µs", tone: "good" },
        { label: "Valkey (~150M keys, ~80%)", value: "one network hop, sub-ms", tone: "good" },
        { label: "ScyllaDB (full miss)", value: "LOCAL_ONE read, sub-15ms p99", tone: "neutral" },
      ],
      remember: {
        problem: "Meet sub-5ms p99 on a read-heavy redirect path.",
        solution: "Layer CDN → in-process LRU → Valkey → ScyllaDB; the DB is touched only on a full miss.",
        why: "Each layer is closer and cheaper; immutable rows mean cache staleness can't cause a wrong redirect.",
        tradeoff: "More moving parts and cache memory in exchange for keeping the DB off the hot path.",
        failure: "If hit rate collapses, every redirect falls through to Scylla and p99 blows past the 15ms miss budget.",
        mitigation: "Size Valkey for ~150M hot keys and keep spare Scylla capacity for the cache-cold case.",
      },
    },
    {
      n: 4,
      title: "Hot keys and the Zipf assumption (the load-bearing risk)",
      body: [
        "The cache math only works because traffic follows a Zipf distribution: a few links get the overwhelming majority of clicks, so a modest cache covers most requests. That assumption is the single load-bearing bet in the design — say it out loud, quantify what happens if it breaks, and keep spare capacity for when it does.",
      ],
      bullets: [
        { lead: "Viral hot key", text: "one link can land 100K req/sec on a single Valkey shard whose ceiling is ~50K ops/sec. The in-process LRU is what absorbs this: every pod serves the hot key from memory." },
        { lead: "Traffic goes uniform", text: "if the distribution flattens, top-150M coverage drops from ~80% to ~30%, and Scylla read traffic roughly triples. Quantify it in numbers, not just 'cache drops'." },
        { lead: "Watch it", text: "monitor the real hit rate against the assumed one; treat a sustained drop as a capacity event, not a surprise." },
      ],
      pictureTitle: "What if traffic stops being Zipf?",
      pictureRows: [
        { label: "Zipf holds", value: "~80% coverage, cache carries the load", tone: "good" },
        { label: "Traffic flattens", value: "~30% coverage, ~3× Scylla read load", tone: "bad" },
        { label: "Viral single key", value: "in-proc LRU serves it from every pod", tone: "neutral" },
      ],
      remember: {
        problem: "Cache hit rate depends on a traffic assumption you don't control.",
        solution: "Name the Zipf assumption, absorb hot keys in the in-process LRU, keep spare Scylla headroom.",
        why: "A few links get most clicks, so a small cache covers most reads — until the distribution flattens.",
        tradeoff: "Spare capacity costs money but is the insurance against a non-Zipf day.",
        failure: "Uniform traffic triples DB load; a single viral key melts one Valkey shard (~50K ops/sec ceiling).",
        mitigation: "Per-pod LRU for viral keys, hit-rate monitoring, and provisioned Scylla headroom for the cold case.",
      },
    },
    {
      n: 5,
      title: "Multi-region active-active: who owns uniqueness?",
      body: [
        "Every region serves both reads and writes, so uniqueness must survive without a global lock. Split the problem: region-prefixed counters keep generated codes disjoint by construction, while custom aliases — where a human picks the string — are the one case that needs coordination, and they go through a single leader region.",
      ],
      bullets: [
        { lead: "Generated codes", text: "disjoint region prefixes mean two regions can never mint the same code, no coordination required." },
        { lead: "Custom aliases", text: "routed to one leader region so 'globally unique' is enforced in one place. Paxos across the WAN is too slow to sit on every create." },
        { lead: "Say which handles which", text: "the interviewer wants to hear that generated codes and custom aliases have different consistency stories." },
      ],
      pictureTitle: "Uniqueness in active-active",
      pictureRows: [
        { label: "Generated code", value: "region prefix → disjoint, no lock", tone: "good" },
        { label: "Custom alias", value: "single leader region enforces uniqueness", tone: "neutral" },
        { label: "Paxos across WAN", value: "too slow for the create path", tone: "bad" },
      ],
      remember: {
        problem: "Keep codes globally unique with no cross-region lock on writes.",
        solution: "Region-prefixed counters for generated codes; a single leader region for custom aliases.",
        why: "Disjoint prefixes make collisions impossible; only human-chosen aliases actually need a coordination point.",
        tradeoff: "Custom-alias creates pay a hop to the leader region; generated creates pay nothing.",
        failure: "A shared global counter or WAN Paxos on every create adds 100ms+ to writes.",
        mitigation: "Keep the leader-region path only for aliases; everything else stays local.",
      },
    },
    {
      n: 6,
      title: "Analytics off the redirect path",
      body: [
        "Click analytics is tier-3; a redirect is tier-1. Never let the analytics write sit on the 302. The redirect fires a click event into Kafka and returns immediately — if Kafka is down, redirects keep working. A separate streaming job aggregates on a time window and lands the results for reporting.",
      ],
      bullets: [
        { lead: "Fire and forget", text: "the Redirect Service emits a click event without waiting, using a bounded buffer (~32MB) that drops on overflow rather than blocking the redirect." },
        { lead: "Aggregate to the side", text: "Flink groups clicks in 5s tumbling windows and writes 100K–500K row batches to ClickHouse plus a counter table." },
        { lead: "Freshness, not latency", text: "the SLA is < 5s from click to dashboard — freshness of a side pipeline, never added to the redirect budget." },
      ],
      pictureTitle: "Why analytics never blocks a 302",
      pictureRows: [
        { label: "On the redirect path", value: "Kafka blip adds latency to every 302", tone: "bad" },
        { label: "Async into Kafka", value: "redirect returns, analytics catches up", tone: "good" },
        { label: "Kafka down", value: "redirects keep serving, clicks dropped", tone: "neutral" },
      ],
      remember: {
        problem: "Run click analytics without touching redirect latency.",
        solution: "Emit to Kafka async; Flink aggregates in 5s windows into ClickHouse + a counter table.",
        why: "Redirects are tier-1, analytics tier-3; a lower tier must never add latency to a higher one.",
        tradeoff: "You may drop a few click events on overflow rather than ever slowing a redirect.",
        failure: "Analytics on the hot path means a Kafka/ClickHouse outage degrades or drops redirects.",
        mitigation: "Bounded async buffer that drops on overflow; treat the pipeline as best-effort with < 5s freshness.",
      },
    },
    {
      n: 7,
      title: "Why ScyllaDB, and why immutable rows matter",
      body: [
        "The store is a giant key-value map: ~10B rows, ~5TB raw, ~15TB at RF=3, on ~20 nodes per DC. The choice that unlocks the latency budget is making rows immutable — write once on create, never update — which is what lets reads use LOCAL_ONE from any nearby replica without risking a stale answer.",
      ],
      bullets: [
        { lead: "Immutable rows", text: "a code maps to one long URL forever, so a read from the closest replica can't be stale. That is what makes LOCAL_ONE reads safe." },
        { lead: "Write path", text: "LOCAL_QUORUM on insert with a per-row TTL for expiration; durability without waiting on the other regions." },
        { lead: "Scylla vs Cassandra/Dynamo", text: "same wide-column model, C++ implementation for lower and more predictable tail latency, and you keep control of the multi-region topology." },
      ],
      pictureTitle: "Immutable rows unlock cheap reads",
      pictureRows: [
        { label: "Insert", value: "LOCAL_QUORUM, per-row TTL", tone: "neutral" },
        { label: "Read", value: "LOCAL_ONE, any nearby replica", tone: "good" },
        { label: "Update", value: "never happens — rows are immutable", tone: "good" },
      ],
      remember: {
        problem: "Serve 100K reads/sec at low tail latency from a durable store.",
        solution: "ScyllaDB, immutable rows, LOCAL_QUORUM writes, LOCAL_ONE reads.",
        why: "If a row never changes, the nearest replica is always correct — so reads need no quorum.",
        tradeoff: "No in-place edits; a 'change' is a new code, not an update.",
        failure: "Mutable rows would force quorum reads to avoid staleness, blowing the latency budget.",
        mitigation: "Model the URL as write-once; use per-row TTL for expiration instead of updates.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It is mostly a read-heavy key-value store: look up a short code, return the long URL fast. Analytics runs to the side so it never slows a redirect.",
      "Short codes come from a per-region counter plus a Feistel shuffle, so each region makes unique codes without coordinating with the others.",
      "Three cache layers keep a cache hit under 5ms at p99 (the slowest 1 percent of requests).",
      "Click analytics is sent and not waited on, so redirects keep working even when Kafka is down.",
      "The whole design rests on one assumption, that traffic follows Zipf (a few links get most clicks), which keeps the cache hit rate high; we watch it and keep spare capacity.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 100K/S · SUB-5MS P99",
        summary:
          "A click hits the CDN first. If the CDN doesn't have it, the request asks three caches in order. The database only gets touched when none of the caches knows the answer.",
        steps: [
          { label: "Client", note: "browser opens the short URL" },
          { label: "CDN", note: "~25% hit, 302 at edge" },
          { label: "Regional LB", note: "routes to a nearby pod" },
          { label: "Redirect Service", note: "stateless lookup" },
          { label: "in-process LRU", note: "10s TTL" },
          { label: "Valkey", note: "~150M hot keys · ~80% of remainder" },
          { label: "ScyllaDB", note: "LOCAL_ONE, immutable rows" },
          { label: "302 Location header", note: "send the browser to the long URL" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · 1K/S",
        summary:
          "Each server already has a batch of new short codes ready in memory, so making one is free. The code gets jumbled so it doesn't look sequential, then saved to the database and never changed.",
        steps: [
          { label: "Client", note: "submits a long URL" },
          { label: "Regional LB", note: "nearby region" },
          { label: "Create Service", note: "allocates the ID" },
          { label: "local counter", note: "LWT-prefetched 100K range from counter_ranges, ~3 min headroom" },
          { label: "Feistel shuffle", note: "42-bit, keyed, makes the code non-sequential" },
          { label: "Base62 encode", note: "7 chars" },
          { label: "ScyllaDB insert", note: "LOCAL_QUORUM, per-row TTL" },
        ],
      },
      {
        kind: "analytics",
        title: "ANALYTICS · RUNS ON THE SIDE, NEVER BLOCKS A REDIRECT",
        summary:
          "The redirect drops a click into Kafka and moves on. It never waits for analytics, so even if Kafka is down, redirects keep working. A separate job groups clicks every 5 seconds and saves them for reports.",
        steps: [
          { label: "Redirect Service", note: "emits a click event" },
          { label: "Kafka", note: "sent without waiting, 32MB buffer, drops on overflow" },
          { label: "Flink", note: "5s tumbling windows" },
          { label: "ClickHouse + Cassandra counter table", note: "100K–500K row batches" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "10B URLs stored, 100K reads/sec, 1K writes/sec, 100:1 ratio",
          "7 Base62 chars = 62⁷ ≈ 3.5T codes, packed in 42 bits (2⁴² ≈ 4.4T, slight overhead). 10B URLs = 0.3% utilization.",
          "ID layout: 4 bits region + 38 bits counter (~275B per region)",
          "Storage: 5TB raw, 15TB at RF=3, ~20 ScyllaDB nodes per DC",
          "Latency: sub-5ms p99 cache hit, sub-15ms on miss",
          "Cache hit rates: CDN ~25%, Valkey ~80% of remainder",
          "Range allocation: 100K IDs per pod, ~3 min of ID headroom if Scylla is briefly unavailable",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Region-prefixed counter, not random-and-retry, not hash truncation",
          "Feistel shuffle before Base62 so codes look random and never collide",
          "ScyllaDB with LOCAL_QUORUM writes, LOCAL_ONE reads (rows immutable)",
          "Three-layer cache: CDN, in-process LRU, Valkey, then Scylla",
          "Custom aliases routed to one leader region (Paxos doesn't span WAN)",
          "Async analytics: Kafka, Flink 5s windows, ClickHouse",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Zipf-distribution assumption is the load-bearing risk on cache hit rate",
          "8-char rollover at 90% counter utilization, rehearsable not emergency",
          "Redirects are tier-1, analytics is tier-3, a deliberate SLA hierarchy",
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
      goal: "Before you draw anything, get five numbers and three product decisions on the board. The point is to make the interviewer confirm scope out loud, so nothing surprises you later.",
      why: "Numbers are not trivia here. The interviewer is checking whether you drive the design from data. Every later decision (cache size, shard count, ID width) falls out of these five numbers, so locking them first is what separates an engineer from someone guessing.",
      steps: [
        { kind: "ASK", text: '**Is this read-heavy or write-heavy?** Walk them to "100K reads/sec", "1K writes/sec", "100:1 ratio". Write **"100K r/s, 1K w/s, 100:1"** in the top-left corner of the board.' },
        { kind: "ASK", text: 'Next ask: **"Single-region or global?"** Land on "active-active across 3 regions", where every region serves both reads and writes, and write **"AA, 3 regions"** under the requests-per-second line.' },
        { kind: "SAY", text: 'Propose the latency target yourself: **"sub-5ms p99 server-side on cache hit"**, **"sub-15ms on miss"**. Wait for them to nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "ID generation", "the redirect path", "custom aliases", "expiration", "async analytics". Out: "auth", "abuse and malware scanning", "billing". "Let me know if you\'d like me to come back to any of those." Wait for confirmation before moving on.' },
        { kind: "WRITE", text: 'Do the storage math out loud: **"10B rows × ~500 bytes each = ~5TB raw"**, **"15TB at RF=3, three copies of the data"**, **"fits on ~20 ScyllaDB nodes per DC"**. Write the totals on the board. Don\'t keep numbers in your head if you can write them down.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, parking out-of-scope items deliberately, and locking the latency budget before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two endpoints, one immutable row, code length justified with math. Get ahead of the obvious alternatives before they get suggested.",
      why: "The interviewer wants to see you commit to a tiny surface and defend it. Two endpoints and one immutable row signal you know this is a key-value lookup, not a CRUD app. Bringing the 62⁷ math forward shows you size before you build.",
      steps: [
        { kind: "WRITE", text: 'Write the two endpoints: **"POST /shorten { longUrl, ttl?, alias? }"** returns **"{ shortCode }"**, "rate-limited per IP". **"GET /:code"** returns "a 302 with the Location header", "uncapped and latency-critical".' },
        { kind: "DRAW", text: 'Sketch the row: **"short_code (PK, 7-char string)"**, **"long_url"**, **"created_at"**, **"ttl_seconds"**, **"origin_region"**. Say it out loud: "Rows never change after insert, which is what lets me use LOCAL_ONE reads (from any nearby copy) later." "A stale read is not even possible if the row never changes."' },
        { kind: "SAY", text: 'Justify code length: **"62⁷ ≈ 3.5T codes"**, "counter is 42 bits since 62⁷ ≈ 2⁴²", "2⁴² is 4.4T". Write **"62⁷ ≈ 3.5T, plenty of headroom"** on the board.' },
        { kind: "RULE OUT", text: 'Get ahead of the alternatives: "A UUID is 128 bits = 22 Base62 characters, so 3× longer URLs. Defeats the point." "Hash truncation collides at 42 bits via the birthday paradox after only 2M URLs." Cross both off.' },
      ],
      grading: "Crisp endpoint names, a one-row data model, and you bringing the math forward instead of waiting to be asked for it.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled paths: read, write, analytics. Label the arrows with traffic shares and latency budgets, not box names.",
      why: "Drawing read, write, and analytics as separate lanes is the whole point. It proves you understand they have different requirements (latency, throughput, durability) and so need different infra. Candidates who draw one blob miss that analytics must never sit on the redirect path.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path** left to right: Client → CDN → Regional LB → Redirect Service → in-process LRU → Valkey → ScyllaDB → 302. Label the arrows **"~25% at CDN"**, **"~80% at Valkey"**, **"LOCAL_ONE"**, not the boxes.' },
        { kind: "DRAW", text: 'Add the **write path** as a separate lane: Client → Regional LB → Create Service → ScyllaDB, labeled **"1K/s · LOCAL_QUORUM · per-row TTL"**.' },
        { kind: "DRAW", text: 'Add the **analytics path** dropping off the Redirect Service: → Kafka → Flink → ClickHouse, dashed, labeled **"async, never blocks a redirect"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different SLAs — redirects are latency-critical tier-1, creates are tier-2, analytics is best-effort tier-3."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with traffic share and latency budget, and an explicit statement that analytics never sits on the redirect path.",
    },
    {
      n: 4,
      title: "Deep Dive: ID Generation",
      minutes: 8,
      goal: "Show the region-prefixed counter and the Feistel shuffle, and defend why every alternative loses.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can generate globally unique, unguessable codes with zero cross-region coordination — and quantify why UUID, random+check, and hash truncation all fail.",
      steps: [
        { kind: "DRAW", text: 'Draw the 42-bit layout: **"4 bits region | 38 bits counter"** — 16 regions, ~275B codes each. "Two regions can never collide because their top bits differ."' },
        { kind: "SAY", text: 'Explain the Feistel shuffle: "A reversible, keyed scramble on the 42-bit value. Turns sequential 1, 2, 3 into unguessable codes, and because it is a bijection it never creates a collision." Then Base62-encode to 7 chars.' },
        { kind: "SAY", text: 'Explain range prefetch: "Each pod claims a 100K-ID range from a counter_ranges table via a lightweight transaction, ~3 min of headroom, so a brief Scylla blip doesn\'t stall creates."' },
        { kind: "RULE OUT", text: 'One line each: **UUID** → 22 chars, 3× longer. **Random+check** → a DB read per write. **Hash truncation** → birthday collision at ~2M. **Naked counter** → guessable, scrapeable.' },
      ],
      grading: "The bit layout on the board, Feistel explained as bijective-and-unguessable without prompting, and a one-line rejection for each alternative.",
    },
    {
      n: 5,
      title: "Deep Dive: Caching and Hot Keys",
      minutes: 7,
      goal: "Walk the three cache layers with hit-rate estimates, then volunteer the Zipf assumption and the viral-key failure mode.",
      why: "Anyone can say 'add a cache'. The interviewer wants layered caching with numbers, and — for the top score — the candidate naming Zipf as the load-bearing risk before being asked.",
      steps: [
        { kind: "SAY", text: 'Walk the layers with numbers: "CDN ~25% at the edge, in-process LRU at 10s TTL for microsecond hits, Valkey holding ~150M hot keys for ~80% of the remainder, then Scylla on a full miss."' },
        { kind: "SAY", text: 'Volunteer the assumption: "This all rests on traffic being Zipf. If it flattens, top-150M coverage drops from ~80% to ~30% and Scylla read load roughly triples." Quantify in numbers, not words.' },
        { kind: "SAY", text: 'Handle the viral key: "A single hot link can hit 100K req/sec against one Valkey shard whose ceiling is ~50K ops/sec. The in-process LRU absorbs it — every pod serves it from memory."' },
        { kind: "SAY", text: 'Close with the operational move: "We monitor real hit rate vs. assumed, and keep spare Scylla headroom for the cold case."' },
      ],
      grading: "Layered cache with hit-rate estimates, the Zipf assumption volunteered and quantified, and a concrete hot-key plan beyond 'use Redis'.",
    },
    {
      n: 6,
      title: "Wrap: Bottlenecks, Tiers, and Rollover",
      minutes: 5,
      goal: "Name the SLA tiers, the counter-exhaustion plan, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: explicit SLA tiers used to justify trade-offs, the 7→8 char rollover framed as rehearsed rather than an emergency, and a clean close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: 'State the tiers: "Redirects tier-1, creates tier-2, analytics tier-3 — that hierarchy is what justifies keeping analytics off the redirect path."' },
        { kind: "SAY", text: 'Bring up rollover unprompted: "At 90% counter utilization we roll from 7 to 8 chars. It is a rehearsed operational step, not an emergency, because 8 chars is already held in reserve at 62⁸ = 218T."' },
        { kind: "SAY", text: 'Push back where useful: "Do we really need 100K/sec globally, or 100K/sec per region? That changes the shard count." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a read-heavy KV store with layered caching, region-prefixed Feistel IDs, and side-channel analytics. With more time I\'d cover auth, abuse scanning, and the deletion/expiry GC path."' },
      ],
      grading: "Explicit SLA tiers, the rollover framed as rehearsable, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but the trade-offs and the numbers stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, cache (usually 'Redis'), database, and a CDN if prompted.",
          "Picks Base62 encoding for short codes and can explain why it's shorter than hex.",
          "Knows reads dominate writes and adds a cache layer in front of the DB.",
          "Can write the two endpoints (POST /shorten and GET /:code) and a single-row schema.",
          "Handles 'what about analytics' by adding a queue and a worker.",
        ],
        gaps: [
          "Doesn't do the storage math out loud, or just says 'lots of data'.",
          "Picks UUID or random+retry without realizing the cost of either.",
          "Cache is a single layer with no hit-rate estimate.",
          "Hot-key handling stops at 'use Redis' with no plan for viral bursts.",
          "Multi-region is added only if asked, and usually as 'put a load balancer in front'.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks defaults with reasons, names trade-offs when asked, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the QPS, storage, and latency targets on the board within the first 5 minutes.",
          "Picks region-prefixed counter over random and hash truncation, and can give a one-line reason for each rejection.",
          "Layered cache (CDN, in-process, Valkey) with rough hit-rate estimates.",
          "Explains Feistel shuffle for unguessable codes without prompting.",
          "Routes custom aliases through a single leader region and explains why Paxos doesn't span WAN cheaply.",
          "Acknowledges the Zipf assumption when asked about cache behavior.",
          "Names the analytics-vs-redirect tier-1 trade-off and defends it.",
        ],
        gaps: [
          "Volunteers the Zipf risk only after the interviewer hints at it, not on their own.",
          "Doesn't bring up the counter-exhaustion plan unless time runs out.",
          "Quantifies the failure mode in words ('cache drops') but not in numbers ('3× Scylla load').",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces risks before being asked, and brings operational maturity that goes beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the Zipf assumption as the load-bearing risk in the design, with a quantified failure mode (top-150M coverage drops from 80% to 30%, Scylla traffic triples).",
          "Brings up the counter-exhaustion plan unprompted, with the 90% threshold framed as rehearsable rather than emergency.",
          "Defines explicit SLA tiers: redirects tier-1, creates tier-2, analytics tier-3, and uses that hierarchy to justify each trade-off.",
          "Pushes back on requirements where appropriate ('do we really need 100K/sec globally, or 100K/sec per region?').",
          "Names operational rehearsal of the 7-to-8 character rollover, not just the technical mechanism.",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover if there were more time.",
          "Treats the interviewer as a collaborator: paces the 40 minutes, parks tangents, comes back to them only if there's room.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Reaching for a UUID without noting it is 22 Base62 characters and triples the length of the short URL, which defeats the product.",
      "Treating Valkey as the source of truth instead of a cache that sits in front of ScyllaDB. A cache eviction must never lose a URL.",
      "Putting the analytics write on the redirect path, so a brief Kafka or ClickHouse outage adds latency to every 302 or takes redirects down.",
      "Going multi-region without a consistency story. Region-prefixed counters keep codes disjoint; a leader region keeps custom aliases unique. Say which handles which.",
      "No hot-key plan, so the first viral link lands 100K req/sec on a single Valkey shard whose ceiling is ~50K ops/sec.",
      "Quoting a cache hit rate with no basis. If you never name Zipf or what happens when traffic goes uniform, the 80% number is just a guess.",
      "Designing with no capacity numbers, so cache size, shard count, and ID width all become guesses instead of consequences of the scale.",
    ],
    followUps: [
      {
        q: "Why ScyllaDB and not Cassandra or DynamoDB?",
        a: "Same wide-column, LSM-based model as Cassandra but a C++ implementation with lower, more predictable tail latency, and you keep full control of the multi-region topology and consistency levels (LOCAL_QUORUM/LOCAL_ONE). DynamoDB is a managed option, but you lose that topology control and pay per-request at 100K reads/sec; here the access pattern is a dead-simple immutable KV lookup, which Scylla serves at lower and more predictable p99.",
      },
      {
        q: "What happens if cache hit rate drops below 60%?",
        a: "That means traffic has drifted off the Zipf assumption. Coverage of the top-150M keys falls, more redirects fall through to Scylla, and read load rises roughly linearly with the miss rate — a flat distribution can triple Scylla reads. The plan: monitor real vs. assumed hit rate, keep provisioned Scylla headroom for exactly this case, and lean on the per-pod in-process LRU which still absorbs the hottest keys regardless of distribution.",
      },
      {
        q: "What if the counter runs out?",
        a: "Each region owns ~275B codes (38-bit counter), so exhaustion is far off, but the plan is rehearsed: at 90% utilization roll the code length from 7 to 8 characters. 8 chars is 62⁸ = 218T, already held in reserve, so it's a planned operational change — new codes get one char longer, old codes are unaffected — not an emergency migration.",
      },
      {
        q: "Why not random short codes with a uniqueness check?",
        a: "Because the check is a DB read on every single write, which turns a 1K/sec write path into a read-heavy one and gets worse as the space fills (more retries near saturation). The region-prefixed counter is unique by construction with zero reads, and the Feistel shuffle gives you the unguessability you wanted from randomness without the collision checking.",
      },
      {
        q: "Walk me through what happens when a viral link breaks the cache.",
        a: "A single hot code can spike to 100K req/sec against one Valkey shard whose ceiling is ~50K ops/sec. The in-process LRU is what saves you: with a 10s TTL, each Redirect pod caches the hot key locally and serves it from memory, so the load is spread across all pods and never concentrates on one Valkey shard. Valkey and Scylla only see one refill per pod per TTL window.",
      },
      {
        q: "How do custom aliases work in a multi-region active-active design?",
        a: "Generated codes are safe because region prefixes are disjoint, but a human-chosen alias could be requested in two regions at once, so 'globally unique' needs a coordination point. Route alias creation to a single leader region that enforces uniqueness (a conditional insert). WAN Paxos on every create would be too slow, so only aliases — a small fraction of creates — pay the cross-region hop; generated codes stay fully local.",
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
          "This is a read-heavy key-value store with a side channel. The core operation — resolve a 7-character code to a long URL — is a single-key lookup, and everything expensive (ID generation, caching, analytics) exists to keep that lookup fast, unique, and cheap at 100K/sec across three regions.",
          "Anchor everything on five numbers: 10B URLs, 100K reads/sec, 1K writes/sec, 100:1 read:write, and a sub-5ms p99 on cache hit. Every structural choice below is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing and the 7-character code",
        body: [
          "Base62 gives 62 options per character, so 62⁷ ≈ 3.5 trillion codes — and 10B is ~0.3% of that, roughly 350× headroom. 62⁷ ≈ 2⁴², which is why the internal ID is exactly 42 bits: the character count and the bit width are the same fact in two units.",
          "6 chars (56B) is too tight — one growth spurt exhausts it. 8 chars (218T) is held in reserve for the rollover rather than paid for today. Storage: 10B rows × ~500 bytes ≈ 5TB raw, 15TB at RF=3, ~20 ScyllaDB nodes per DC.",
        ],
      },
      {
        heading: "ID generation without coordination",
        body: [
          "A cross-region lock per create would add 100ms+ of WAN latency to every write, so the generator must be collision-free by construction. The 42-bit ID is split 4 bits region + 38 bits counter: 16 regions, ~275B codes each, disjoint by prefix so two regions can never collide.",
          "A naked counter is guessable, so the 42-bit value goes through a Feistel shuffle — a reversible, keyed scramble that turns sequential values into unguessable ones and, being a bijection, never introduces a collision. Then Base62-encode to 7 chars. Pods prefetch 100K-ID ranges (~3 min headroom) so a brief Scylla blip doesn't stall creates. UUID (22 chars), random+check (a read per write), and hash truncation (birthday collisions at ~2M) all lose.",
        ],
      },
      {
        heading: "The three-layer read path",
        body: [
          "CDN absorbs ~25% at the edge with a short 302 cache. An in-process LRU (10s TTL) serves microsecond hits with no network hop and is what absorbs viral keys across all pods. Valkey holds ~150M hot keys and catches ~80% of the remainder. ScyllaDB is touched only on a full miss.",
          "The unlock is immutable rows: a code maps to one URL forever, so reads use LOCAL_ONE from the nearest replica with no risk of staleness, and writes use LOCAL_QUORUM with a per-row TTL for expiration. This is the whole reason the sub-5ms hit / sub-15ms miss budget is achievable.",
        ],
      },
      {
        heading: "The load-bearing risk: Zipf",
        body: [
          "The cache math only holds because a few links get most clicks (Zipf). Name this out loud. If traffic flattens, top-150M coverage drops from ~80% to ~30% and Scylla read load roughly triples. A single viral key can hit 100K req/sec against one Valkey shard whose ceiling is ~50K ops/sec — the per-pod LRU is the mitigation.",
          "Operationally: monitor real hit rate vs. assumed, keep spare Scylla headroom, and treat a sustained drop as a capacity event rather than a surprise.",
        ],
      },
      {
        heading: "Analytics as a side channel, and SLA tiers",
        body: [
          "Redirects are tier-1, creates tier-2, analytics tier-3. The redirect emits a click into Kafka without waiting (bounded buffer, drops on overflow) and returns immediately, so a Kafka or ClickHouse outage never touches redirect latency. Flink aggregates in 5s tumbling windows into ClickHouse plus a counter table, meeting a < 5s freshness SLA.",
          "That explicit tier hierarchy is what justifies every trade-off: it's why analytics is best-effort, why creates can pay a leader-region hop for custom aliases, and why redirects get the whole caching budget.",
        ],
      },
    ],
  },
};
