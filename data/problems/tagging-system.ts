import type { Problem } from "@/lib/types";

export const taggingSystem: Problem = {
  slug: "tagging-system",
  num: "4.1",
  title: "Design a Tagging System",
  level: "Medium",
  deepDiveAvailable: true,
  intro: [
    "Design a tagging system that lets any entity — a photo, document, product listing, or support ticket — carry a set of free-form or curated tags: 5B tagged entities, ~15B tag associations across 25M unique tags, sustaining 50K new taggings/sec, serving 300K 'browse by tag' reads/sec and 80K autocomplete lookups/sec at sub-50ms p99, while a handful of tags like 'photography' attach to tens of millions of entities each.",
  ],
  hardParts:
    "The hard parts: keeping a bidirectional index (entity→tags and tag→entities) consistent at billions of rows without cross-partition transactions, surviving the hot-partition problem when a small number of tags attach to a huge fraction of all content, and serving typo-tolerant, freshness-sensitive autocomplete over tens of millions of tag names.",
  keyTopics: [
    "Bidirectional Index (Forward + Inverted)",
    "Hot-Partition Bucketing for Skewed Tags",
    "Async Fan-Out via Kafka + Flink",
    "Prefix Search for Autocomplete",
    "Tag Canonicalization & Synonyms",
  ],
  foundationsReferenced: [
    { label: "Cassandra / ScyllaDB Wide Rows", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Kafka", tone: "orange" },
    { label: "Redis Sorted Sets", tone: "purple" },
    { label: "Inverted Index", tone: "blue" },
    { label: "Eventual Consistency", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "lb", label: "LB / API Gateway", col: 2, row: 1, tone: "slate" },
      {
        id: "browse_svc",
        label: "Browse Service",
        sub: "by-tag query · 300K/s",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "valkey", label: "Valkey", sub: "hot-tag page cache", col: 4, row: 1, tone: "green" },
      {
        id: "scylla_inv",
        label: "ScyllaDB",
        sub: "tag → entity posting list",
        mono: "bucketed by tag_id + time",
        col: 5,
        row: 1,
        tone: "blue",
      },
      {
        id: "autocomplete_svc",
        label: "Autocomplete Service",
        sub: "typeahead · 80K/s · p99<50ms",
        mono: "Redis ZRANGEBYLEX prefix scan",
        col: 3,
        row: 2,
        tone: "green",
      },
      {
        id: "trending",
        label: "Trending Store",
        sub: "Redis sorted set, decaying score",
        col: 5,
        row: 2,
        tone: "blue",
      },
      { id: "kafka", label: "Kafka", sub: "tag-change events", col: 2, row: 3, tone: "orange" },
      {
        id: "flink",
        label: "Flink",
        sub: "fan-out: index + trie + trending",
        col: 4,
        row: 3,
        tone: "orange",
      },
      {
        id: "tag_svc",
        label: "Tagging Service",
        sub: "normalize + write · 50K/s",
        mono: "alias → canonical tag_id",
        col: 2,
        row: 4,
        tone: "purple",
      },
      {
        id: "forward_store",
        label: "Cassandra",
        sub: "entity_id → tags (forward index)",
        col: 3,
        row: 4,
        tone: "blue",
      },
    ],
    edges: [
      { from: "client", to: "lb", kind: "read" },
      { from: "lb", to: "browse_svc", kind: "read" },
      { from: "browse_svc", to: "valkey", label: "~70% hit", kind: "read" },
      { from: "valkey", to: "scylla_inv", label: "miss · read 1-2 buckets", kind: "read" },
      { from: "lb", to: "autocomplete_svc", kind: "read" },
      { from: "autocomplete_svc", to: "valkey", label: "prefix cache", kind: "read" },
      { from: "autocomplete_svc", to: "trending", label: "rank suggestions", kind: "read" },
      { from: "lb", to: "tag_svc", kind: "write" },
      { from: "tag_svc", to: "forward_store", label: "sync write · quorum", kind: "write" },
      { from: "tag_svc", to: "kafka", label: "async fan-out event", kind: "analytics" },
      { from: "kafka", to: "flink", kind: "analytics" },
      { from: "flink", to: "scylla_inv", label: "append to posting list", kind: "analytics" },
      { from: "flink", to: "autocomplete_svc", label: "refresh prefix trie", kind: "analytics" },
      { from: "flink", to: "trending", label: "increment decaying score", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · 300K browse/s + 80K autocomplete/s" },
      { kind: "write", text: "write path · 50K taggings/s" },
      { kind: "analytics", text: "async fan-out · index, trie, and trending catch up within seconds" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Attach one or more tags to an entity", tag: "P0" },
      { id: "FR-02", text: "Remove a tag from an entity", tag: "P0" },
      { id: "FR-03", text: "List all tags on a given entity (forward lookup)", tag: "P0" },
      { id: "FR-04", text: "Browse/paginate all entities carrying a given tag, newest first", tag: "P0" },
      { id: "FR-05", text: "Autocomplete tag names by prefix as the user types", tag: "P0" },
      { id: "FR-06", text: "Normalize tags (case-fold, trim, unicode-normalize) to a canonical tag id", tag: "P0" },
      { id: "FR-07", text: "Support tag synonyms/aliases that resolve to one canonical tag", tag: "P1" },
      { id: "FR-08", text: "Multi-tag AND/OR queries (entities matching tag A and tag B)", tag: "P1" },
      { id: "FR-09", text: "Trending/popular tags leaderboard, global and per-category", tag: "P1" },
      { id: "FR-10", text: "Tag moderation: block or merge spam/duplicate tags after creation", tag: "P1" },
      { id: "FR-11", text: "Expose per-entity tag count and per-tag entity count via API", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Browse-by-tag read latency", tag: "p99 < 80ms" },
      { id: "NFR-02", text: "Autocomplete latency", tag: "p99 < 50ms" },
      { id: "NFR-03", text: "Tagging write throughput, sustained (150K/sec burst)", tag: "50K/sec" },
      { id: "NFR-04", text: "Browse-by-tag read throughput, sustained", tag: "300K/sec" },
      { id: "NFR-05", text: "Availability (about 52 min downtime per year)", tag: "99.99%" },
      { id: "NFR-06", text: "Durability: never lose a committed tag association", tag: "zero loss" },
      { id: "NFR-07", text: "Index freshness, from write ack to browse-visible", tag: "< 5s" },
      { id: "NFR-08", text: "Read-to-write ratio that anchors the whole design", tag: "6:1" },
      { id: "NFR-09", text: "Hot-tag ceiling: largest tags must stay servable", tag: "10M+ entities/tag" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why you need two indexes, not one",
      body: [
        "A tagging system answers two opposite questions: 'what tags does this entity have' and 'what entities have this tag'. The first is a small, bounded lookup — an entity rarely carries more than 20-30 tags. The second can return tens of millions of results for a popular tag. No single table layout serves both efficiently, so you size and build two indexes: a forward index (entity_id → tags) and an inverted index (tag_id → entity_ids).",
        "Do the math out loud. 15B tag associations at roughly 50 bytes per row (entity_id + tag_id + timestamp + overhead) is about 750GB for the forward index alone. The inverted index stores the same associations again, grouped the other way, plus posting-list overhead, so call it another 1TB. At RF=3 for durability, total storage across both stores lands around 5TB. The 25M-row tag dictionary (canonical names, synonyms) is tiny by comparison, a couple of GB, but it has to be globally consistent since every write consults it.",
      ],
      bullets: [
        { lead: "Forward index", text: "entity_id → tags, answers 'show me this photo's tags'. Small, bounded, cheap to keep strongly consistent." },
        { lead: "Inverted index", text: "tag_id → entity_ids, answers 'show me everything tagged javascript'. Can be tens of millions of rows for one tag." },
        { lead: "Two stores, one truth", text: "the forward index is written synchronously and is the source of truth; the inverted index is derived and allowed to lag by a stated SLA." },
      ],
      pictureTitle: "Two directions, two indexes",
      pictureRows: [
        { label: "Forward index (~750GB)", value: "entity → tags, bounded per row", tone: "good" },
        { label: "Inverted index (~1TB)", value: "tag → entities, unbounded per row", tone: "neutral" },
        { label: "Tag dictionary (~2GB)", value: "25M canonical tags + aliases", tone: "good" },
      ],
      remember: {
        problem: "One data set, two opposite query directions, at very different fan-out.",
        solution: "Maintain a forward index (entity→tags, sync, authoritative) and an inverted index (tag→entities, async, derived).",
        why: "A forward row is bounded (~20-30 tags); an inverted row can be tens of millions of entities. Neither layout serves the other question well.",
        tradeoff: "You store the associations twice (~2x space) and accept a convergence window between the two.",
        failure: "A single denormalized table tries to serve both directions and either the entity lookup or the tag browse degrades badly at scale.",
        mitigation: "Write forward synchronously; fan out to the inverted index asynchronously with a named freshness SLA.",
      },
    },
    {
      n: 2,
      title: "Tag-to-entity lookups: kill three options, defend one",
      body: [
        "The 'browse by tag' query is the one that breaks naive designs first, because a popular tag's result set is enormous and must still paginate cheaply. Put the candidates on the board and rule them out one at a time.",
      ],
      bullets: [
        { lead: "SQL JOIN over a junction table", text: "fine at small scale, but a 15B-row join, plus a WHERE on a value with millions of matches, means scanning and sorting a huge result set on every page. Rejected." },
        { lead: "RDBMS secondary index on the tag column", text: "the index itself becomes a giant shared structure; every write to a popular tag updates the same hot B-tree pages, and pagination re-scans from the top each time. Rejected." },
        { lead: "Search engine as source of truth", text: "Elasticsearch is excellent for ranked, fuzzy search, but using it as the durable system of record for a simple sequential paginated feed at 15B documents makes recovery and reindexing painfully expensive. Rejected as primary store." },
        { lead: "Wide-column inverted index (ScyllaDB/Cassandra)", text: "partition key = tag_id (+ bucket), clustering key = time. Each tag's posting list lives in its own partition, pagination is a native clustering-key range scan, and there's no shared B-tree to contend on. Winner." },
      ],
      pictureTitle: "Tag-to-entity lookup: kill three, keep one",
      pictureRows: [
        { label: "SQL JOIN, junction table", value: "full scan of millions of matches → reject", tone: "bad" },
        { label: "RDBMS secondary index", value: "hot shared B-tree pages → reject", tone: "bad" },
        { label: "Search engine as source of truth", value: "expensive recovery at 15B docs → reject", tone: "bad" },
        { label: "Wide-column inverted index", value: "per-tag partitions, native pagination → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Paginate cheaply through a tag's entity list when that list can be tens of millions long.",
        solution: "Wide-column inverted index: partition key = tag_id(+bucket), clustering key = time, native range-scan pagination.",
        why: "Each tag gets its own partition(s), so one hot tag's traffic never contends with a shared index structure.",
        tradeoff: "You give up JOIN flexibility and ranked relevance scoring in exchange for cheap, predictable pagination.",
        failure: "A shared secondary index or a naive JOIN turns every popular-tag browse into a full scan.",
        mitigation: "Model the query as a partition-scoped range scan from the start, not an index lookup bolted onto a relational table.",
      },
    },
    {
      n: 3,
      title: "Hot-tag partitions: the load-bearing risk",
      body: [
        "Tag popularity follows a Zipf-like skew: a small number of tags ('photography', 'food', 'javascript') attach to tens of millions of entities, while the long tail has a handful each. A naive inverted index with partition key = tag_id blows straight past a healthy partition size (a few hundred thousand rows / ~100MB before performance degrades) for the biggest tags by two to three orders of magnitude — every read and write for that tag lands on the same replica set, a classic hot partition.",
        "The fix is to bucket the posting list: partition key becomes tag_id + bucket, where bucket is a time window (e.g. per day) or a hash of the entity id modulo N. Browsing is usually recency-ordered, so time-bucketing is the natural choice — a 'newest first' page only has to read the most recent bucket or two, and older buckets are touched only as the user paginates deeper. Bucket count is adaptive: a cold tag gets one bucket, a top-0.1% tag gets hundreds.",
      ],
      bullets: [
        { lead: "Naive tag_id partition key", text: "fails for the biggest tags, concentrating all reads and writes for that tag on one replica set." },
        { lead: "Bucket by time", text: "matches the recency-ordered browse pattern; a first page reads 1-2 buckets, not the whole history." },
        { lead: "Adaptive bucket count", text: "cold tags stay at 1 bucket (no wasted fan-out); hot tags scale to hundreds automatically as volume grows." },
      ],
      pictureTitle: "What happens without bucketing?",
      pictureRows: [
        { label: "Cold tag, 1 bucket", value: "single partition, no contention", tone: "good" },
        { label: "Hot tag, unbucketed", value: "one partition, 10M+ rows → hot replica set", tone: "bad" },
        { label: "Hot tag, bucketed by day", value: "hundreds of partitions, browse reads 1-2", tone: "good" },
      ],
      remember: {
        problem: "A single popular tag's posting list can be 100-1000x larger than a healthy partition.",
        solution: "Bucket the inverted-index partition key by tag_id + time window, with the bucket count scaling to the tag's volume.",
        why: "Time-bucketing matches recency-ordered browsing, so a page read touches only the newest bucket(s), not the whole list.",
        tradeoff: "Reads that need older history must fan out across more buckets; bucket count needs monitoring and rebalancing.",
        failure: "Unbucketed hot tags overload one replica set, causing latency spikes for every user browsing that tag.",
        mitigation: "Monitor per-tag write rate and grow bucket count proactively before a tag's partition crosses the size ceiling.",
      },
    },
    {
      n: 4,
      title: "Async fan-out: one write, four downstream systems",
      body: [
        "A single tagging action logically touches four places: the forward index, the inverted index, the autocomplete structure, and the trending counters. Wrapping all four in one distributed transaction would need cross-store coordination at 50K writes/sec — far too slow and fragile. Instead, split the write into a synchronous half and an asynchronous half.",
        "The Tagging Service writes the forward index synchronously (quorum write, source of truth) and acknowledges the client immediately. It then publishes a tag-changed event to Kafka. A Flink job consumes that stream and fans a single event out to update the inverted index, refresh the autocomplete prefix structure, and bump the trending counters. Consumers are idempotent, keyed by a dedupe id, so at-least-once redelivery after a crash never double-counts or duplicates a posting-list entry.",
      ],
      bullets: [
        { lead: "Sync boundary", text: "only the forward index write sits between the client and its acknowledgment; everything else happens after." },
        { lead: "Idempotent consumers", text: "each event carries a dedupe key so Flink retries or redelivery can't double-apply an update." },
        { lead: "Freshness is the price", text: "browse and autocomplete lag the forward index by up to the stated SLA (< 5s), which is the trade for skipping a distributed transaction." },
        { lead: "Degraded, not down", text: "if Kafka backs up, tagging writes keep succeeding; browse and autocomplete simply lag further until it drains." },
      ],
      pictureTitle: "Sync vs. async boundary",
      pictureRows: [
        { label: "Forward index write", value: "synchronous, quorum, source of truth", tone: "good" },
        { label: "Inverted index, trie, trending", value: "async via Kafka + Flink, < 5s lag", tone: "neutral" },
        { label: "Kafka backlog", value: "writes still succeed, reads just lag", tone: "neutral" },
      ],
      remember: {
        problem: "One logical write needs to update four physically separate stores.",
        solution: "Write the forward index synchronously; fan out to the rest via Kafka + Flink asynchronously.",
        why: "A distributed transaction across four heterogeneous stores can't sustain 50K writes/sec at acceptable latency.",
        tradeoff: "Browse and autocomplete results can be up to ~5s stale relative to a just-acknowledged write.",
        failure: "A crashed consumer that isn't idempotent can double-count a trending score or duplicate a posting-list row on redelivery.",
        mitigation: "Dedupe-keyed, idempotent consumers plus Flink checkpointing so at-least-once delivery behaves like exactly-once downstream.",
      },
    },
    {
      n: 5,
      title: "Autocomplete: latency and freshness over fuzzy matching",
      body: [
        "Autocomplete has to scan prefixes across 25M tag names in under 50ms p99, ranked by popularity, and a brand-new trending tag needs to appear within seconds, not after a nightly reindex. Two real options: a full-text search engine like Elasticsearch with edge n-gram analyzers (flexible, typo-tolerant, but heavier to operate and slower to reflect a just-created tag), or an in-memory prefix structure such as a Redis sorted set keyed by lexicographic tag name.",
        "We pick the Redis sorted set for the hot path: ZRANGEBYLEX gives a lexicographic range scan in O(log N + M), trivially updated the moment a new tag's Kafka event is consumed, no batch reindex wait. It has no built-in fuzzy/typo tolerance, so that becomes a secondary fallback layer — only invoked when the exact-prefix scan comes back empty — rather than the primary path, protecting the latency budget for the common case.",
      ],
      bullets: [
        { lead: "ZRANGEBYLEX prefix scan", text: "sorted lexicographic range read, millisecond latency, and the update path is a simple ZADD, no reindex step." },
        { lead: "Popularity ranking", text: "suggestions are ordered by a score derived from recent tag-usage volume, so trending tags float to the top within a prefix." },
        { lead: "Typo tolerance as fallback", text: "only triggered on an empty exact-prefix result, keeping the primary path free of expensive fuzzy matching." },
        { lead: "Freshness by construction", text: "a new tag enters the trie the moment its first Kafka event is consumed by Flink — no separate reindex pipeline to keep in sync." },
      ],
      pictureTitle: "Autocomplete: latency+freshness vs. fuzzy matching",
      pictureRows: [
        { label: "Redis ZRANGEBYLEX", value: "ms latency, instant freshness, no typo tolerance", tone: "good" },
        { label: "Elasticsearch edge n-gram", value: "typo-tolerant, heavier ops, slower freshness", tone: "neutral" },
        { label: "Fallback fuzzy match", value: "only on empty exact-prefix result", tone: "used" },
      ],
      remember: {
        problem: "Prefix-match 25M tag names in under 50ms with near-instant freshness for new tags.",
        solution: "Redis sorted set with ZRANGEBYLEX as the primary path, popularity-scored; fuzzy match only as a fallback.",
        why: "A sorted-set range scan is faster and fresher to update than a search-engine reindex cycle.",
        tradeoff: "No built-in typo tolerance on the hot path — mistyped prefixes need a separate, slower fallback.",
        failure: "Relying on Elasticsearch alone for the hot path means a newly created or newly trending tag can lag behind a reindex cycle.",
        mitigation: "Update the sorted set inline with the same Kafka/Flink fan-out that updates the inverted index, so freshness is a side effect, not a separate job.",
      },
    },
    {
      n: 6,
      title: "Canonicalization: collapsing 'JS', 'js', and 'JavaScript' into one tag",
      body: [
        "Free-form tagging produces near-duplicates: 'javascript', 'JavaScript', 'JS', 'java-script' all mean the same thing to a user but look like four different tags to a database. Normalize at write time — lowercase, trim whitespace, unicode NFKC-normalize — to collapse the trivial variants automatically, then resolve the normalized string against an alias table that maps to a single canonical tag_id.",
        "A genuinely new tag name gets a fresh canonical id. A later moderation step can merge two canonical tags that turned out to be duplicates (say 'nodejs' and 'node.js') by rewriting the alias table to point both at one id — the 15B historical association rows are never touched; they simply start resolving through the updated alias the next time they're read.",
      ],
      bullets: [
        { lead: "Write-time normalization", text: "case-fold, trim, and unicode-normalize before the alias lookup, so trivial variants never even reach the alias table as distinct entries." },
        { lead: "Alias table", text: "a small, globally consistent map from normalized string → canonical tag_id, consulted on every write." },
        { lead: "Merges rewrite aliases, not history", text: "correcting a duplicate tag is a change to the (tiny) alias table, not a rewrite of billions of association rows." },
      ],
      pictureTitle: "Four spellings, one canonical tag",
      pictureRows: [
        { label: "\"JavaScript\", \"js\", \"JS\"", value: "normalize → alias lookup → same tag_id", tone: "good" },
        { label: "Late-discovered duplicate", value: "merge = rewrite alias table entry", tone: "neutral" },
        { label: "15B historical rows", value: "never rewritten on a merge", tone: "good" },
      ],
      remember: {
        problem: "Free-form input creates near-duplicate tags that should be one tag.",
        solution: "Normalize at write time, resolve through an alias table to one canonical tag_id; merges edit the alias table only.",
        why: "Keeping historical rows untouched on a merge avoids rewriting billions of rows every time moderation finds a duplicate.",
        tradeoff: "Every write pays an extra alias-table lookup, and the alias table itself must stay globally consistent.",
        failure: "Without canonicalization, browse-by-tag results for 'javascript' silently miss everything tagged 'JS'.",
        mitigation: "Normalize before dictionary lookup, and treat tag merges as an alias-table operation rather than a data migration.",
      },
    },
    {
      n: 7,
      title: "Trending: recency-weighted popularity, not lifetime totals",
      body: [
        "'What's trending right now' is a different question from 'what's the most-used tag ever' — a tag used heavily this hour should outrank one with a huge lifetime total but no recent activity. The same Flink job that fans out inverted-index and trie updates also increments a Redis sorted set with a time-decayed score per tag, so old volume fades out of the ranking automatically instead of requiring a separate cleanup job.",
      ],
      bullets: [
        { lead: "Decaying score", text: "each tag-usage event bumps the score, and the score decays over a rolling window, so yesterday's spike stops dominating today's leaderboard." },
        { lead: "O(log N) top-K reads", text: "a sorted set gives cheap 'give me the top 20 trending tags right now' reads with no separate aggregation query." },
        { lead: "Feeds autocomplete too", text: "the same trending score is used to rank autocomplete suggestions within a prefix, so a temporarily hot tag surfaces first." },
      ],
      pictureTitle: "Lifetime total vs. trending score",
      pictureRows: [
        { label: "Lifetime total", value: "huge historical tag, no recent activity", tone: "neutral" },
        { label: "Decaying trending score", value: "recent spike outranks old volume", tone: "good" },
        { label: "Used to rank autocomplete", value: "hot tags surface first within a prefix", tone: "used" },
      ],
      remember: {
        problem: "Rank 'trending now' without a huge lifetime total permanently dominating the leaderboard.",
        solution: "A Redis sorted set with a time-decayed score, updated by the same async fan-out job.",
        why: "Decay makes recent volume outweigh stale historical volume without a separate batch cleanup job.",
        tradeoff: "The decay window/rate is a tuning knob — too aggressive and short bursts dominate; too slow and it barely differs from lifetime totals.",
        failure: "A raw lifetime counter never lets a newly-hot tag overtake an old, no-longer-active one.",
        mitigation: "Tune the decay window against real usage data and reuse the same score to rank autocomplete suggestions.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a bidirectional index problem: a forward index (entity→tags) answers 'what tags does this have', an inverted index (tag→entities) answers 'what has this tag', and they're kept eventually consistent, not transactionally consistent.",
      "The forward index is written synchronously and is the source of truth; the inverted index, autocomplete trie, and trending counters update asynchronously via Kafka and Flink, lagging by up to ~5 seconds.",
      "A handful of tags attach to tens of millions of entities, so the inverted index's partition key is bucketed by tag_id + time, not a bare tag_id, to avoid a hot partition.",
      "Autocomplete favors a Redis sorted set (ZRANGEBYLEX) over a search engine for the hot path, because freshness and latency matter more than typo tolerance for the common case.",
      "Tag canonicalization (normalize + alias table) collapses near-duplicate spellings into one tag_id, and merges rewrite the alias table, never the billions of historical rows.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · BROWSE BY TAG · 300K/S",
        summary:
          "A browse request checks a page-level cache first, then reads the one or two most recent buckets of that tag's posting list from the inverted index.",
        steps: [
          { label: "Client", note: "opens a tag page or filter" },
          { label: "LB / API Gateway", note: "routes to Browse Service" },
          { label: "Browse Service", note: "stateless, paginated" },
          { label: "Valkey", note: "~70% hit on recent pages" },
          { label: "ScyllaDB", note: "miss → read 1-2 time buckets of the posting list" },
          { label: "Paginated response", note: "newest-first, cursor for next page" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · TAG AN ENTITY · 50K/S",
        summary:
          "The Tagging Service normalizes the tag, resolves it to a canonical id, writes the forward index synchronously, and only then emits an async event for everything else to catch up.",
        steps: [
          { label: "Client", note: "submits entity_id + tag string(s)" },
          { label: "Tagging Service", note: "normalize, unicode NFKC, alias lookup" },
          { label: "Tag dictionary", note: "resolve to canonical tag_id" },
          { label: "Cassandra forward store", note: "quorum write, source of truth" },
          { label: "Ack to client", note: "write is durable at this point" },
          { label: "Kafka", note: "publish tag-changed event, async" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC FAN-OUT · UPDATES INDEX, TRIE, AND TRENDING",
        summary:
          "One Kafka event drives three downstream updates in parallel. None of them can block or slow the write that already succeeded.",
        steps: [
          { label: "Kafka", note: "tag-changed event, dedupe key" },
          { label: "Flink", note: "idempotent consumer, checkpointed" },
          { label: "ScyllaDB inverted index", note: "append entity_id to the tag's current bucket" },
          { label: "Redis prefix trie", note: "ZADD, tag now autocompletable" },
          { label: "Trending sorted set", note: "increment decaying score" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "5B tagged entities, 15B tag associations, 25M unique tags",
          "Storage: ~750GB forward index, ~1TB inverted index, ~5TB at RF=3",
          "50K taggings/sec sustained (150K burst), 300K browse reads/sec, 80K autocomplete/sec",
          "Latency: browse p99 < 80ms, autocomplete p99 < 50ms",
          "Freshness: write-ack to browse-visible < 5s",
          "Skew: top 0.1% of tags cover ~40% of all associations",
          "Partitions capped near ~100K rows; hot tags split into hundreds of time buckets",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Forward index sync + source of truth; inverted index, trie, trending async via Kafka/Flink",
          "Wide-column inverted index (ScyllaDB) bucketed by tag_id + time, not a bare tag_id",
          "Idempotent, dedupe-keyed consumers so at-least-once behaves like exactly-once downstream",
          "Redis sorted set (ZRANGEBYLEX) for autocomplete, favoring latency and freshness over fuzzy matching",
          "Normalize + alias table resolves synonyms to one canonical tag_id before any index write",
          "Trending as a time-decayed Redis sorted set fed by the same async pipeline, not a separate job",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Hot-partition skew is the load-bearing risk in this design — name it and quantify it",
          "The eventual-consistency window (<5s) is the deliberate trade for skipping a 4-store distributed transaction",
          "Tag merges rewrite the alias table only, never the 15B historical association rows",
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
      goal: "Get five numbers and the read/write asymmetry on the board before drawing anything.",
      why: "Every later decision — bucketing strategy, which store backs autocomplete, the freshness SLA — falls out of these numbers. Locking them first signals you drive the design from data, not habit.",
      steps: [
        { kind: "ASK", text: '**"What\'s the read:write ratio?"** Land on "300K browse reads/sec, 50K taggings/sec, roughly 6:1". Write **"300K r/s, 50K w/s, 6:1"** in the corner.' },
        { kind: "ASK", text: 'Ask **"How skewed is tag popularity?"** Land on Zipf-like: a handful of tags cover a huge share of associations. Write **"top 0.1% of tags ≈ 40% of associations"**.' },
        { kind: "SAY", text: 'Propose latency targets yourself: **"browse p99 < 80ms"**, **"autocomplete p99 < 50ms"**. Wait for a nod, then write them down.' },
        { kind: "SAY", text: 'State scope. In: "tagging, browse-by-tag, autocomplete, canonicalization, trending". Out: "moderation UI, spam ML, billing". "I\'ll come back to those if there\'s time." Wait for confirmation.' },
        { kind: "WRITE", text: 'Do storage math out loud: **"15B associations × ~50 bytes ≈ 750GB forward, ~1TB inverted, ~5TB at RF=3"**. Write the totals on the board.' },
      ],
      grading: "Are the five numbers on the board within 5 minutes, and is the Zipf skew called out before it's asked about?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two data directions, two schemas, canonicalization named up front.",
      why: "Committing to a forward + inverted split immediately, rather than backing into it later, is the single strongest signal that you understand the shape of this problem.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /entities/:id/tags { tags: [] }"**, **"DELETE /entities/:id/tags/:tag"**, **"GET /entities/:id/tags"**, **"GET /tags/:tag/entities?cursor="**, **"GET /tags/autocomplete?prefix="**.' },
        { kind: "DRAW", text: 'Sketch both rows: forward = **"entity_id (PK), tags: list<tag_id>"**; inverted = **"tag_id + bucket (PK), entity_id + ts (clustering)"**. Say: "Two schemas because the two query directions have completely different fan-out."' },
        { kind: "SAY", text: 'Name canonicalization immediately: "Every write normalizes the string and resolves it through an alias table to one canonical tag_id before either schema sees it."' },
        { kind: "RULE OUT", text: '"A single junction table with a secondary index on tag looks simpler, but a popular tag\'s row set is 10M+, and pagination against a shared B-tree index degrades badly. That\'s why the inverted index is its own bucketed store." Cross it off.' },
      ],
      grading: "Two distinct schemas on the board, canonicalization mentioned unprompted, and the junction-table alternative explicitly ruled out.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram, three lanes: browse read, tag write, async fan-out.",
      why: "Separating the synchronous write from the asynchronous fan-out is the core architectural decision. A candidate who draws one blob misses that the forward write can't wait on three other stores.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → LB → Browse Service → Valkey (~70% hit) → ScyllaDB inverted index, reading 1-2 time buckets. Label arrows with hit rates, not box names.' },
        { kind: "DRAW", text: 'Add the **write path** as its own lane: Client → LB → Tagging Service → normalize/canonicalize → Cassandra forward store, **"quorum write, ack here"**.' },
        { kind: "DRAW", text: 'Add the **async fan-out** dropping off the Tagging Service: → Kafka → Flink → (ScyllaDB inverted index, Redis trie, Redis trending), dashed, labeled **"< 5s freshness, never blocks the write ack"**.' },
        { kind: "SAY", text: 'Narrate the split: "The client gets acknowledged the moment the forward write lands. Everything a browsing or autocompleting user sees catches up within seconds, not synchronously."' },
      ],
      grading: "Three clearly separated lanes, the sync/async boundary drawn explicitly at the Tagging Service, and a stated freshness number on the async lane.",
    },
    {
      n: 4,
      title: "Deep Dive: Hot-Tag Partitioning",
      minutes: 8,
      goal: "Show the naive partition key failing, then the time-bucketed fix, with numbers.",
      why: "This is the signature sub-problem. The interviewer wants to see you name the skew, quantify why a bare tag_id partition key fails, and defend a concrete bucketing scheme.",
      steps: [
        { kind: "SAY", text: '"Partition size has a practical ceiling, roughly a few hundred thousand rows. A bare tag_id partition key for a top tag with 10M+ entities blows past that by 100x — every read and write for that tag hits one replica set."' },
        { kind: "DRAW", text: 'Draw the fix: partition key = **"tag_id + bucket"**, bucket = time window. "Browsing is newest-first, so a first page only reads the latest bucket or two."' },
        { kind: "SAY", text: '"Bucket count is adaptive — cold tags get one bucket, hot tags scale to hundreds as their write volume grows. We monitor per-tag write rate and grow buckets proactively."' },
        { kind: "RULE OUT", text: '"Hashing entity_id into a fixed N buckets is an alternative to time-bucketing, but it scatters recency-ordered reads across all N buckets on every page. Time-bucketing matches the actual access pattern better." Cross it off as the primary scheme.' },
      ],
      grading: "The partition-size ceiling stated as a number, the bucketed fix drawn with a clustering-key detail, and the alternative (hash bucketing) named and compared.",
    },
    {
      n: 5,
      title: "Deep Dive: Autocomplete and Trending",
      minutes: 7,
      goal: "Defend Redis ZRANGEBYLEX over a search engine for the hot path, and connect trending's decay to autocomplete ranking.",
      why: "Anyone can say 'add Elasticsearch'. The interviewer wants to see the latency-vs-freshness-vs-typo-tolerance trade-off reasoned through explicitly.",
      steps: [
        { kind: "SAY", text: '"Autocomplete needs sub-50ms prefix scans over 25M names, and a brand-new tag has to show up within seconds. A Redis sorted set with ZRANGEBYLEX gives both; Elasticsearch\'s edge n-gram approach is more typo-tolerant but heavier to keep fresh."' },
        { kind: "SAY", text: '"Typo tolerance becomes a fallback layer, only triggered when the exact-prefix scan is empty, so it never costs latency on the common case."' },
        { kind: "SAY", text: '"Trending uses the same async pipeline: a time-decayed score in a sorted set, so a recent spike outranks stale lifetime volume, and that same score ranks autocomplete suggestions within a prefix."' },
        { kind: "SAY", text: '"Both structures update inline off the same Kafka event that updates the inverted index — freshness is a side effect of one pipeline, not a second job to keep in sync."' },
      ],
      grading: "The latency/freshness/typo-tolerance trade-off stated explicitly, typo tolerance framed as fallback not primary, and trending tied back to the same fan-out pipeline.",
    },
    {
      n: 6,
      title: "Wrap: Consistency, Canonicalization, and Close",
      minutes: 5,
      goal: "Name the consistency model, the merge story, and close with a summary plus what you'd cover with more time.",
      why: "Staff-level signal here is being explicit about what's strongly consistent versus eventually consistent, and treating tag merges as a design decision rather than an afterthought.",
      steps: [
        { kind: "SAY", text: '"Forward index is strongly consistent, source of truth. Inverted index, trie, and trending are eventually consistent, bounded by a <5s SLA. I\'d put that on a dashboard as a real SLO, not just a hope."' },
        { kind: "SAY", text: '"Tag merges — when moderation finds \'nodejs\' and \'node.js\' are duplicates — rewrite one alias table entry. The 15B historical rows never move." Bring this up unprompted.' },
        { kind: "SAY", text: 'Push back where useful: "Do we need global trending, or per-category? That changes whether it\'s one sorted set or a few thousand." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a bidirectional index kept consistent via async fan-out, with bucketing to survive hot tags and a Redis-backed autocomplete tuned for freshness. With more time I\'d cover moderation workflows and abuse/spam tag detection."' },
      ],
      grading: "Explicit strong-vs-eventual consistency statement, merge story volunteered, at least one pushback on requirements, and a crisp closing summary with parked items.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working forward+inverted index but treats consistency and skew as details rather than design drivers.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Identifies the need for both a forward and an inverted index when prompted.",
          "Picks a reasonable store (Cassandra, DynamoDB, or Postgres) for tag storage.",
          "Adds a cache in front of reads once asked about latency.",
          "Handles autocomplete by suggesting 'use Elasticsearch' without further detail.",
          "Writes the basic CRUD endpoints for tagging and untagging.",
        ],
        gaps: [
          "Doesn't do the storage math out loud, or hand-waves scale.",
          "Uses a bare tag_id as the partition key with no idea it will hot-spot.",
          "Treats the whole write (forward + inverted + trie + trending) as one synchronous operation.",
          "No canonicalization — 'JS' and 'JavaScript' are just two different tags.",
          "Autocomplete design stops at 'search engine' with no latency or freshness reasoning.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the bidirectional-index design end-to-end, names the hot-tag risk, and defends the async fan-out with numbers.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes storage, QPS, and latency numbers on the board within the first 5 minutes.",
          "Splits forward (sync, source of truth) from inverted (async, derived) without prompting.",
          "Buckets the inverted index by tag_id + time and can explain why a bare tag_id fails.",
          "Picks Redis ZRANGEBYLEX over Elasticsearch for autocomplete and gives a latency/freshness reason.",
          "Adds canonicalization with an alias table and explains how a later merge works.",
          "Names Kafka + Flink for fan-out and mentions idempotent consumers when asked.",
        ],
        gaps: [
          "Names the hot-tag skew only after the interviewer probes latency under a viral tag, not on their own.",
          "Quantifies freshness as 'eventually consistent' without a concrete SLA number until asked.",
          "Doesn't proactively connect the trending score to autocomplete ranking.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Treats hot-tag skew as the load-bearing risk from minute one, and reasons about every trade-off in terms of a stated SLA.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the Zipf-skew number (top 0.1% of tags ≈ 40% of associations) before being asked why bucketing matters.",
          "States the eventual-consistency SLA (<5s) as a deliberate trade against a 4-store distributed transaction, not an apology.",
          "Frames tag merges as an alias-table operation and volunteers that historical rows never move.",
          "Connects the async fan-out, the autocomplete trie, and the trending leaderboard as three consumers of one event stream, not three separate systems.",
          "Pushes back on requirements ('global trending or per-category? that changes the fan-out width').",
          "Adaptive bucket count named as an operational concern with a monitoring signal (per-tag write rate), not just a static design choice.",
          "Closes with a one-sentence summary and an explicit list of what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Using a bare tag_id as the inverted-index partition key with no bucketing plan — the first viral tag hot-spots one replica set.",
      "Wrapping the forward write, inverted write, trie update, and trending update in one synchronous transaction across four stores.",
      "No canonicalization step, so 'javascript', 'JS', and 'JavaScript' silently fragment browse results across three different tags.",
      "Treating Elasticsearch as the durable source of truth for tag associations instead of a derived, rebuildable index.",
      "Quoting a freshness or hit-rate number with no basis — if you can't say why browse lags by 5s, it's a guess, not a design.",
      "No idempotency story for the Kafka/Flink consumers, so a crash-and-retry silently double-counts trending or duplicates a posting-list row.",
      "Designing tag merges as a batch rewrite of historical association rows instead of an alias-table update.",
    ],
    followUps: [
      {
        q: "Why not just use Elasticsearch for everything — storage, browse, and autocomplete?",
        a: "Elasticsearch is excellent at ranked, fuzzy search, but using it as the durable system of record for 15B simple tag associations makes recovery and full reindexing expensive, and a straightforward 'newest-first, paginated' browse doesn't need relevance scoring at all. The design keeps Elasticsearch-style capability (or a lighter prefix structure) scoped to what actually needs fuzzy/ranked search — autocomplete — and uses a wide-column store as the durable, cheaply-paginated source for both directions of the tag index.",
      },
      {
        q: "What happens when a tag goes viral mid-day and its write rate spikes 100x?",
        a: "The adaptive bucketing scheme is the safety valve: bucket count for that tag_id grows in response to monitored write rate, splitting the posting list across more partitions before any single one crosses the size/throughput ceiling. In the interim, the Flink consumer for that tag's events can also apply backpressure or batch more aggressively, and the forward-index write path is unaffected since it never depended on the inverted index's bucket count.",
      },
      {
        q: "How do you handle a tag merge — say 'nodejs' and 'node.js' turn out to be duplicates?",
        a: "Moderation updates the alias table so both normalized strings resolve to the same canonical tag_id going forward. The 15B historical association rows are never rewritten; the next time any of them is read, it resolves through the updated alias. The one operational wrinkle is the inverted index posting lists for the two old tag_ids now need to be merged (or simply queried together) for a period, which is a background compaction job, not a blocking migration.",
      },
      {
        q: "Why is the forward index synchronous but the inverted index asynchronous, rather than the other way around?",
        a: "The forward index is what the writing client cares about immediately — 'did my tag get saved' — and it's small and bounded, so a synchronous quorum write is cheap. The inverted index serves other users browsing later, tolerates a few seconds of staleness without anyone noticing, and is the expensive, fan-out-heavy side of the write. Making the cheap, user-facing side synchronous and the expensive, other-users-facing side asynchronous is what lets the write path hit 50K/sec without a distributed transaction.",
      },
      {
        q: "How would you support multi-tag AND queries, like 'entities tagged both javascript and tutorial'?",
        a: "Fetch each tag's posting list independently (they're already time-ordered per bucket) and intersect them, typically starting from the smaller/rarer tag's list to minimize work, walking both in sorted order like a merge-join. For very popular tag pairs this can be precomputed and cached, but for the general case a bounded-size merge-join over bucketed, sorted posting lists is cheap enough to run per-request.",
      },
      {
        q: "What's the failure mode if Kafka goes down for 10 minutes?",
        a: "Tagging writes keep succeeding because they only depend on the forward index, so nothing on the write path breaks. Browse-by-tag and autocomplete results simply lag further behind — a tag applied during the outage won't show up in browse or suggestions until Kafka recovers and Flink catches up on the backlog. That's the explicit trade the async fan-out makes: a downstream outage degrades freshness, it never takes down the write path or the read path for already-indexed content.",
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
          "This is a bidirectional index problem wearing a tagging UI. The core tension is that 'what tags does this entity have' and 'what entities have this tag' are opposite-fan-out queries over the same data, and no single schema serves both well at billions of rows.",
          "Anchor everything on the numbers: 5B entities, 15B associations, 25M unique tags, 50K writes/sec, 300K browse reads/sec, 80K autocomplete/sec, sub-5s freshness. Every structural choice below is a consequence of these, not a preference.",
        ],
      },
      {
        heading: "Two indexes, one source of truth",
        body: [
          "The forward index (entity_id → tags) is small per row, strongly consistent, and written synchronously — it's what the writing client is actually waiting on. The inverted index (tag_id → entity_ids) can be enormous per row for popular tags and is derived, written asynchronously, allowed to lag by a stated SLA.",
          "Storage: ~750GB forward, ~1TB inverted, ~5TB total at RF=3. The tag dictionary (canonical names + aliases) is a couple of GB but must be consulted, consistently, on every single write.",
        ],
      },
      {
        heading: "Surviving hot-tag skew",
        body: [
          "Tag popularity is heavily skewed: the top 0.1% of tags cover roughly 40% of all associations. A bare tag_id partition key in a wide-column store would put a top tag's entire 10M+-row posting list on one replica set — a hot partition that degrades every reader and writer touching that tag.",
          "The fix is bucketing the partition key by tag_id + time window, matched to the recency-ordered browse access pattern, with bucket count scaling adaptively to each tag's actual write volume. Cold tags cost nothing extra; hot tags spread themselves across hundreds of partitions automatically.",
        ],
      },
      {
        heading: "Async fan-out and the consistency boundary",
        body: [
          "A tagging write logically touches four stores: forward index, inverted index, autocomplete trie, and trending counters. Coordinating all four synchronously at 50K writes/sec isn't viable, so only the forward write is synchronous; a Kafka event drives the other three through an idempotent, checkpointed Flink job.",
          "This makes the consistency model explicit and defensible: strongly consistent where the writer needs it (their own tag saved), eventually consistent (< 5s) where other users are reading derived views. A Kafka backlog degrades freshness, never correctness or write availability.",
        ],
      },
      {
        heading: "Autocomplete and trending as one pipeline",
        body: [
          "Autocomplete favors a Redis sorted set with ZRANGEBYLEX over a search-engine index for the primary path, trading typo tolerance (pushed to a fallback layer) for near-instant freshness and millisecond latency. Trending uses the same fan-out event stream to maintain a time-decayed score in another sorted set, so recent volume outranks stale lifetime totals — and that same score ranks autocomplete suggestions within a prefix.",
          "Framing both as consumers of one Kafka event stream, rather than two separately-synced systems, is what keeps freshness a side effect of the architecture instead of an ongoing operational burden.",
        ],
      },
      {
        heading: "Canonicalization and the cost of a tag merge",
        body: [
          "Write-time normalization (case-fold, trim, unicode NFKC) plus an alias table collapses spelling variants into one canonical tag_id before either index sees the write. When moderation later discovers two canonical tags are duplicates, the fix is a rewrite of one alias-table entry, not a migration of billions of historical association rows — old rows simply resolve through the updated alias on their next read.",
        ],
      },
    ],
  },
};
