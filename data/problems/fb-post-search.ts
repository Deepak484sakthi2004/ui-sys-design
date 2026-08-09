import type { Problem } from "@/lib/types";

export const fbPostSearch: Problem = {
  slug: "fb-post-search",
  num: "6.1",
  title: "Design FB Post Search",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design search over Facebook posts and comments for roughly 3B users: a corpus of hundreds of billions of items growing by ~500M new posts/comments a day, serving ~1.5B searches/day (~20K qps sustained, ~60K qps peak), where a new post must become searchable within about 10 seconds and every single result must be filtered to only what the specific searcher is allowed to see.",
  ],
  hardParts:
    "The hard parts: making privacy filtering part of the index intersection itself instead of a slow post-filter over billions of candidates, keeping a graph-scale inverted index freshly mutable while ingesting hundreds of millions of edits a day (classic inverted indexes assume near-immutable batches), and ranking on text relevance plus social-graph proximity plus recency without the extra graph lookups blowing the latency budget.",
  keyTopics: [
    "Graph-Aware Inverted Index (Unicorn)",
    "Privacy-as-Postings-List Intersection",
    "Owner-Based (Vertical) Sharding",
    "Near-Real-Time Segment Refresh",
    "Two-Stage Retrieve-then-Rerank",
  ],
  foundationsReferenced: [
    { label: "Inverted Index", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Kafka / Change Log", tone: "orange" },
    { label: "Graph Databases", tone: "purple" },
    { label: "Bloom Filters", tone: "blue" },
    { label: "LSM Trees vs B-Trees", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client-write", label: "Client", sub: "compose post", col: 1, row: 1, tone: "slate" },
      { id: "post-svc", label: "Post Service", sub: "validate + write", col: 2, row: 1, tone: "green" },
      { id: "tao", label: "TAO", sub: "graph store of record", mono: "posts + edges + privacy", col: 3, row: 1, tone: "purple" },
      { id: "log", label: "Kafka / Scribe", sub: "change log", col: 3, row: 2, tone: "orange" },
      { id: "indexer", label: "Indexing Tier", sub: "tokenize + ACL terms", col: 4, row: 2, tone: "orange" },
      { id: "unicorn", label: "Unicorn Shards", sub: "in-mem posting lists", mono: "text ∩ graph postings", col: 5, row: 2, tone: "green" },
      { id: "search-client", label: "Client", sub: "search query", col: 1, row: 3, tone: "slate" },
      { id: "query-svc", label: "Query Service", sub: "parse · spellcheck · expand", col: 2, row: 3, tone: "blue" },
      { id: "aggregator", label: "Broker / Aggregator", sub: "fan-out + merge", col: 3, row: 3, tone: "blue" },
      { id: "ranker", label: "Ranking Service", sub: "ML rerank", col: 4, row: 3, tone: "blue" },
      { id: "privacy-check", label: "Privacy Service", sub: "secondary ACL check", col: 5, row: 3, tone: "purple" },
    ],
    edges: [
      { from: "client-write", to: "post-svc", kind: "write" },
      { from: "post-svc", to: "tao", label: "sync write", kind: "write" },
      { from: "tao", to: "log", label: "CDC", kind: "analytics" },
      { from: "log", to: "indexer", kind: "analytics" },
      { from: "indexer", to: "unicorn", label: "posting updates · ~10s freshness", kind: "analytics" },
      { from: "search-client", to: "query-svc", kind: "read" },
      { from: "query-svc", to: "aggregator", kind: "read" },
      { from: "aggregator", to: "unicorn", label: "fan-out · text ∩ ACL postings", kind: "read" },
      { from: "aggregator", to: "ranker", label: "merged top-K", kind: "read" },
      { from: "ranker", to: "privacy-check", label: "final rerank", kind: "read" },
      { from: "privacy-check", to: "search-client", label: "results", kind: "read" },
    ],
    legend: [
      { kind: "read", text: "read path · search query, privacy-filtered results" },
      { kind: "write", text: "write path · post created, canonical store" },
      { kind: "analytics", text: "async indexing pipeline · never blocks the post write" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Full-text search over post and comment content", tag: "P0" },
      { id: "FR-02", text: "Only return posts the searcher is authorized to see, per Facebook's privacy model (public, friends, friends-of-friends, custom lists, groups)", tag: "P0" },
      { id: "FR-03", text: "New, edited, and deleted posts reflected in search results within seconds", tag: "P0" },
      { id: "FR-04", text: "Rank results by text relevance, recency, and social-graph proximity to the searcher", tag: "P0" },
      { id: "FR-05", text: "Handle post deletion and edits idempotently so the index never serves stale or removed content", tag: "P0" },
      { id: "FR-06", text: "Filter results by time range, post type (photo/video/text/link), and tagged people", tag: "P1" },
      { id: "FR-07", text: "Scope a search to a specific user's timeline or a specific group", tag: "P1" },
      { id: "FR-08", text: "Typeahead / autocomplete suggestions as the user types a query", tag: "P1" },
      { id: "FR-09", text: "Support phrase match and excluded terms via internal query rewriting", tag: "P1" },
      { id: "FR-10", text: "Paginate results with stable ordering across pages", tag: "P1" },
      { id: "FR-11", text: "Spell correction and synonym expansion", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Search query latency, end to end", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "Search query latency, median", tag: "p50 < 50ms" },
      { id: "NFR-03", text: "Indexing freshness: post creation to searchable", tag: "< 10s" },
      { id: "NFR-04", text: "Search throughput, sustained (with burst)", tag: "20K qps (60K peak)" },
      { id: "NFR-05", text: "Indexing throughput, sustained (with burst)", tag: "6K posts/sec (50K peak)" },
      { id: "NFR-06", text: "Availability", tag: "99.99%" },
      { id: "NFR-07", text: "Privacy correctness: unauthorized content ever shown", tag: "zero leaks" },
      { id: "NFR-08", text: "Corpus size searchable across the system", tag: "100s of billions of docs" },
      { id: "NFR-09", text: "Daily index growth", tag: "~500M items/day" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Why a normal search engine doesn't work here",
      body: [
        "A classic search engine (Elasticsearch, Solr) answers 'which documents match these terms' with one global inverted index shared by every user. Facebook post search can't do that, because the correct answer to the same query text is different for every searcher: your friend's post about 'hiking' is visible to you and invisible to a stranger. If privacy is bolted on as a filter after retrieval, you either over-fetch wildly (fetch 10,000 candidates hoping 10 survive the filter) or under-return (fetch top 10, filter down to 2).",
        "Facebook's actual answer, published as the Unicorn system, is to make privacy a first-class part of the index itself: the searcher's friend list, the post's audience, and group membership are all just more posting lists, and a query becomes a boolean intersection of a text clause with a privacy clause, evaluated together inside the same index engine that already knows how to intersect posting lists fast.",
      ],
      bullets: [
        { lead: "Post-filter approach", text: "retrieve by text only, then check each candidate's ACL in a loop. Cheap to build, but you can't guarantee a full page of results without over-fetching by an unknown factor." },
        { lead: "Privacy-as-postings-list", text: "encode 'friends of user X' or 'members of group G' as posting lists exactly like a term's posting list, and intersect them with the text clause inside the index engine." },
        { lead: "The payoff", text: "the index only ever returns documents that are already known to be visible, so downstream stages don't need to discard huge fractions of what they fetched." },
      ],
      pictureTitle: "Filter-after vs filter-inside",
      pictureRows: [
        { label: "Post-filter (fetch then check ACL)", value: "unknown over-fetch factor, wasted work", tone: "bad" },
        { label: "Privacy as a postings list", value: "intersection only returns visible docs", tone: "good" },
      ],
      remember: {
        problem: "Every searcher sees a different, valid answer to the same query text.",
        solution: "Model privacy (friend edges, group membership, audience) as posting lists and intersect them with the text clause inside the index, not as a filter bolted on after retrieval.",
        why: "An index engine built to intersect posting lists fast can treat 'is a friend of the searcher' exactly like 'contains the word hiking' — same machinery, no separate filter pass.",
        tradeoff: "The index has to store and keep fresh a lot more than text: friend edges, audience settings, and group rosters, all as first-class postings.",
        failure: "A naive post-filter either over-fetches to guarantee a full page or returns partial pages when too many candidates get discarded.",
        mitigation: "Push privacy into the same boolean intersection as the text query so what comes out is already visible.",
      },
    },
    {
      n: 2,
      title: "Sharding: owner-based (vertical) vs term-based (horizontal)",
      body: [
        "A classic search engine shards by term or by document id, spreading any one query's posting lists across every shard, so a single query fans out to all N shards. Facebook's dominant query pattern is 'search among my friends' posts', which is inherently graph-local: the searcher's friend edges and their posts cluster around specific people, not around specific words.",
        "Unicorn shards vertically by owner: a user's posts, their friend edges, and their group memberships are co-located on the same (or nearby) shard. A friends-scoped query only needs to touch the shards that hold the searcher's own social neighborhood, instead of every shard in the fleet.",
      ],
      bullets: [
        { lead: "Term-based sharding", text: "great for keyword-only search (any term could be on any shard), but a graph-scoped query still has to fan out everywhere because friend edges are scattered by term, not by owner." },
        { lead: "Owner-based sharding", text: "co-locates a user's identity, posts, and edges, so 'my friends' posts containing X' touches a small, predictable slice of shards." },
        { lead: "Global public search", text: "still needs a term-based fan-out path for public, ungraphed queries (e.g., searching all public posts about a trending topic) — the two sharding strategies coexist for different query shapes." },
        { lead: "Cost", text: "vertical sharding makes rebalancing harder (moving a user means moving their posts, edges, and index state together) and can create hot shards for high-degree accounts (pages, public figures)." },
      ],
      pictureTitle: "Which shard does the query touch?",
      pictureRows: [
        { label: "Term-based, friends-scoped query", value: "fans out to nearly every shard", tone: "bad" },
        { label: "Owner-based, friends-scoped query", value: "touches a small graph-local slice", tone: "good" },
        { label: "Owner-based, global public query", value: "still needs a term-based fallback path", tone: "neutral" },
      ],
      remember: {
        problem: "The dominant query shape ('search among my friends') fans out to every shard under classic term sharding.",
        solution: "Shard vertically by document owner so a user's posts, edges, and group memberships live together; keep a term-sharded path for global public search.",
        why: "Co-locating identity, content, and graph edges turns a graph-local query into a small, predictable fan-out instead of an all-shard scatter-gather.",
        tradeoff: "Rebalancing moves a user's whole neighborhood at once, and high-degree accounts (pages, celebrities) can create hot shards.",
        failure: "Pure term sharding makes every friends-scoped query touch nearly all shards, which does not scale with query volume.",
        mitigation: "Run two sharding strategies side by side: owner-based for graph-local queries, term-based for global public search.",
      },
    },
    {
      n: 3,
      title: "Near-real-time indexing without breaking segment immutability",
      body: [
        "Classic inverted indexes (Lucene-style) get their speed from immutable segments: a segment is built once, compressed, and never mutated, which is what makes posting-list intersection fast. But posts must be searchable within ~10 seconds, and a batch rebuild of the segment is far too slow for that.",
        "The fix is the same one search engines like Elasticsearch use under the hood: new documents land first in a small, frequently-refreshed in-memory segment (mutable, cheap to query, expensive to keep around forever), and a background process periodically merges small segments into larger immutable ones. Deletes and edits don't mutate a segment in place either — they write a tombstone that gets honored at query time and compacted away during the next merge.",
      ],
      bullets: [
        { lead: "Hot in-memory segment", text: "absorbs the last few seconds of writes; queried in addition to the older immutable segments, giving near-real-time visibility without touching the fast path's core assumption." },
        { lead: "Tombstones for deletes/edits", text: "an edit is a delete-tombstone plus a new insert, not an in-place mutation — keeps every segment append-only." },
        { lead: "Background merge", text: "small segments get compacted into larger ones on a schedule, amortizing the cost of maintaining many tiny mutable structures." },
        { lead: "Consistency window", text: "there is a brief window (bounded by the change-log lag plus refresh interval) where a just-created post is durable in TAO but not yet searchable — call this out as a deliberate, bounded trade-off." },
      ],
      pictureTitle: "Where does a fresh post live?",
      pictureRows: [
        { label: "0-10s old", value: "hot in-memory segment, queried live", tone: "used" },
        { label: "Older", value: "compacted, immutable, fast to intersect", tone: "good" },
        { label: "Deleted/edited", value: "tombstoned, honored at query time", tone: "neutral" },
      ],
      remember: {
        problem: "Immutable segments are fast to query but too slow to rebuild for a ~10s freshness target.",
        solution: "A small hot mutable segment absorbs recent writes and is queried alongside older immutable segments; background merges compact them over time.",
        why: "This decouples 'fast to intersect' (immutable, large segments) from 'fast to appear' (tiny hot segment), instead of forcing one structure to do both.",
        tradeoff: "You accept a short, bounded staleness window between a post being durable and being searchable.",
        failure: "Mutating segments in place to get instant visibility would wreck the compression and intersection speed that makes the index fast at all.",
        mitigation: "Bound and monitor the freshness window; treat deletes/edits as tombstone-plus-insert so every segment stays append-only.",
      },
    },
    {
      n: 4,
      title: "Two-stage retrieve-then-rerank ranking",
      body: [
        "Ranking needs text relevance, recency, and social-graph proximity all at once, but running an expensive ML model against every candidate across thousands of shards would blow the latency budget. The standard fix is to split ranking into a cheap stage inside the index and an expensive stage after fan-in.",
        "Each shard scores its local matches with something cheap — term frequency / inverse document frequency plus a recency decay — and returns only its own top-K. A broker merges the per-shard top-K lists, and only that much smaller merged set goes through the expensive ML reranker that folds in social-graph proximity and engagement signals.",
      ],
      bullets: [
        { lead: "Leaf-level score", text: "TF-IDF-style text score plus recency decay, computed locally per shard with no cross-shard or graph-service calls." },
        { lead: "Broker merge", text: "collects each shard's top-K (not everything), so the fan-in set stays bounded regardless of corpus size." },
        { lead: "ML rerank", text: "the merged set is small enough to justify a real model call: social-graph proximity (how close is the author to the searcher), engagement, and freshness combine into a final score." },
        { lead: "Why not rerank everywhere", text: "running the ML model per-shard would mean thousands of model calls per query instead of one batched call on the merged set." },
      ],
      pictureTitle: "Where does the expensive scoring happen?",
      pictureRows: [
        { label: "Per-shard (leaf)", value: "cheap TF-IDF + recency, local only", tone: "good" },
        { label: "Broker merge", value: "bounded top-K regardless of corpus size", tone: "neutral" },
        { label: "Reranker (post-merge)", value: "one batched ML call, graph + engagement", tone: "good" },
      ],
      remember: {
        problem: "Full ML ranking (text + graph + engagement) is too expensive to run against every shard's candidates.",
        solution: "Cheap leaf-level scoring picks a bounded top-K per shard; only the merged set goes through the ML reranker.",
        why: "Bounding the fan-in set before the expensive stage keeps the ML call count constant regardless of how many shards or how large the corpus grows.",
        tradeoff: "A candidate that scores low locally but would have scored high after reranking can get cut before it's ever seen by the reranker.",
        failure: "Reranking at every shard turns one query into thousands of model calls and destroys the latency budget.",
        mitigation: "Tune per-shard top-K to balance recall loss against reranker cost; monitor how often true top results get cut at the leaf stage.",
      },
    },
    {
      n: 5,
      title: "Privacy defense in depth: primary filter plus secondary check",
      body: [
        "The primary privacy filter — friend-edge and group-membership posting lists intersected with the text clause — handles the overwhelming majority of cases cheaply. But some audience rules are too dynamic or fine-grained to keep as a perfectly fresh posting list: custom friend lists, recent unfriending or blocking, and per-post audience overrides can lag the index by the same freshness window as everything else.",
        "So the design never trusts the index alone for something as unforgiving as a privacy leak. After ranking, a secondary, synchronous ACL check against the live privacy/graph service (TAO) re-verifies each of the small number of final results before they're returned — cheap because the candidate set is now tiny, and it closes the staleness gap the async index can't fully avoid.",
      ],
      bullets: [
        { lead: "Primary filter", text: "friend/group postings intersected with text at index time — cheap, handles the bulk of traffic, but can be briefly stale." },
        { lead: "Secondary check", text: "a synchronous, authoritative recheck against TAO on the final small result set, right before returning to the client." },
        { lead: "Over-fetch factor", text: "retrieve more candidates than needed (e.g., 3-5x the page size) so that if the secondary check drops a few, a full page still survives." },
        { lead: "Why not skip the primary filter", text: "checking every candidate against TAO before ranking would mean millions of synchronous graph lookups per query instead of dozens." },
      ],
      pictureTitle: "Two checks, two jobs",
      pictureRows: [
        { label: "Primary (index intersection)", value: "cheap, bulk of filtering, can be briefly stale", tone: "used" },
        { label: "Secondary (live TAO check)", value: "small set, authoritative, closes the gap", tone: "good" },
        { label: "Skip secondary entirely", value: "risks showing a just-unfriended person's post", tone: "bad" },
      ],
      remember: {
        problem: "The async index can briefly lag privacy changes (unfriend, block, custom list edits).",
        solution: "Cheap primary filter inside the index for the bulk of traffic, plus a synchronous secondary ACL check on the small final result set before returning.",
        why: "Checking every candidate synchronously would be too slow; skipping the secondary check entirely risks a real privacy leak on stale data.",
        tradeoff: "Over-fetching to survive secondary-check drops costs some extra retrieval work on every query.",
        failure: "Trusting only the async index means a post can briefly stay visible to someone who was just unfriended or blocked.",
        mitigation: "Over-fetch by a fixed multiplier and run the synchronous TAO recheck only on the small, already-ranked candidate set.",
      },
    },
    {
      n: 6,
      title: "Deletes and edits: tombstones, not surprises",
      body: [
        "A delete or an edit has to be reflected in search at least as fast as a new post appears, and it must never let a deleted or stale post surface — that failure mode is worse than a slow index. Because segments are append-only, a delete is written as a tombstone entry that every query honors immediately, even before the underlying segment is compacted.",
        "An edit is modeled as a tombstone for the old version plus a fresh insert of the new one, so the index never has to reach into an existing posting list and rewrite it in place — it just adds two append-only events and lets the query-time tombstone check and the next background merge sort out the rest.",
      ],
      bullets: [
        { lead: "Tombstone on delete", text: "written to the change log like any other event, propagates through the same near-real-time pipeline, honored at query time immediately." },
        { lead: "Edit = delete + insert", text: "no in-place mutation of a posting list; the new content is just another document with a fresh generation id." },
        { lead: "Query-time honoring", text: "every result is checked against the tombstone set before being returned, even if the underlying segment hasn't been compacted yet." },
        { lead: "Idempotency", text: "the change-log consumer processes events at-least-once, so applying the same tombstone or insert twice must be a no-op." },
      ],
      pictureTitle: "Delete/edit without mutating a segment",
      pictureRows: [
        { label: "Delete", value: "tombstone written + honored immediately", tone: "good" },
        { label: "Edit", value: "old tombstoned, new inserted fresh", tone: "good" },
        { label: "In-place segment rewrite", value: "never — breaks append-only + compression", tone: "bad" },
      ],
      remember: {
        problem: "Deletes and edits must be reflected fast without mutating append-only, compressed segments in place.",
        solution: "Model a delete as a tombstone honored at query time, and an edit as a tombstone plus a fresh insert.",
        why: "Append-only segments keep the intersection-speed and compression that make the index fast; tombstones give correctness without breaking that invariant.",
        tradeoff: "Deleted content lingers physically in old segments until the next background merge, relying on the tombstone check for correctness in the meantime.",
        failure: "Showing a deleted post because a segment wasn't recompacted yet is a correctness bug users notice immediately.",
        mitigation: "Always consult the tombstone set at query time regardless of compaction state, and make change-log processing idempotent.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It is a graph-aware inverted index, not a plain text search engine: privacy is modeled as posting lists (friend edges, group membership) and intersected with the text query inside the index, not filtered after the fact.",
      "Shard vertically by document owner so 'search my friends' posts' touches a small graph-local slice of shards, with a term-sharded fallback for global public search.",
      "Freshness comes from a small hot mutable segment queried alongside older immutable segments, merged in the background; deletes and edits are tombstones, never in-place rewrites.",
      "Ranking is two-stage: cheap TF-IDF plus recency at each shard picks a bounded top-K, then one ML rerank call folds in social proximity and engagement on the small merged set.",
      "Privacy is defense in depth: the index's primary filter handles the bulk cheaply, and a synchronous secondary check against the live graph store closes the staleness gap before results are returned.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · ~20K QPS SUSTAINED · P99 < 200MS",
        summary:
          "A query is parsed and expanded, then fanned out to the shards that hold the searcher's graph-local neighborhood. Each shard intersects the text clause with privacy postings and returns its own top-K, which get merged, reranked, and rechecked before going back to the client.",
        steps: [
          { label: "Client", note: "types a search query" },
          { label: "Query Service", note: "parse, spellcheck, expand" },
          { label: "Broker / Aggregator", note: "fan out to graph-local shards" },
          { label: "Unicorn Shards", note: "text ∩ privacy postings, local top-K" },
          { label: "Ranking Service", note: "ML rerank: graph proximity + engagement" },
          { label: "Privacy Service", note: "synchronous secondary ACL recheck" },
          { label: "Client", note: "receives a privacy-correct page of results" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · ~6K POSTS/SEC (50K PEAK)",
        summary:
          "A new post is written synchronously to the canonical graph store first, so it's durable immediately. Everything that makes it searchable happens off that critical path.",
        steps: [
          { label: "Client", note: "submits a new post" },
          { label: "Post Service", note: "validates, writes canonical record" },
          { label: "TAO", note: "graph store of record, durable" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC INDEXING · < 10S FRESHNESS · NEVER BLOCKS THE POST WRITE",
        summary:
          "The write to TAO fans out through a change log to a tokenizer that builds text and privacy postings, landing them in a hot mutable segment queried in near-real time, later compacted into immutable segments.",
        steps: [
          { label: "TAO", note: "change-data-capture event" },
          { label: "Kafka / Scribe", note: "durable change log" },
          { label: "Indexing Tier", note: "tokenize + build ACL postings" },
          { label: "Unicorn Shards", note: "hot mutable segment, queried live" },
          { label: "Background merge", note: "compacts into immutable segments" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "3B users, hundreds of billions of posts/comments indexed",
          "~500M new items/day ≈ 6K/sec sustained, ~50K/sec peak",
          "~1.5B searches/day ≈ 20K qps sustained, ~60K qps peak",
          "Freshness target: post creation to searchable, < 10s",
          "Latency: p50 < 50ms, p99 < 200ms end to end",
          "Over-fetch multiplier for the secondary ACL check: ~3-5x page size",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Privacy modeled as posting lists, intersected with text at index time (Unicorn), not filtered after retrieval",
          "Owner-based (vertical) sharding for graph-local queries, term-based sharding kept for global public search",
          "Hot mutable segment for recent writes, queried alongside compacted immutable segments",
          "Deletes/edits are tombstones plus inserts, never in-place segment mutation",
          "Two-stage ranking: cheap per-shard top-K, then one batched ML rerank on the merged set",
          "Secondary synchronous privacy check on the final small result set, defense in depth against index staleness",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Privacy is not a filter bolted on after search — it's a first-class part of the index intersection",
          "The bounded staleness window between durable and searchable is a deliberate trade-off, not a bug",
          "Owner-based sharding exists because the dominant query shape is graph-local, not global keyword search",
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
      goal: "Lock the numbers and the privacy model before drawing anything. The single biggest way this problem goes wrong is treating it as generic text search and only remembering privacy halfway through.",
      why: "Privacy correctness is the load-bearing requirement of this whole system — get the interviewer to confirm it explicitly up front, so it's not something you bolt on later under time pressure.",
      steps: [
        { kind: "ASK", text: '**"What\'s the corpus and query volume?"** Land on "hundreds of billions of posts", "~500M new items/day", "~20K qps sustained search, 60K peak". Write **"6K w/s, 20K r/s"** in the corner.' },
        { kind: "ASK", text: '**"What does privacy-correct mean here — public, friends, custom lists, groups?"** Get the interviewer to confirm this is a hard requirement, not an afterthought. Write **"zero unauthorized results, ever"** on the board.' },
        { kind: "SAY", text: 'Propose the freshness target: **"searchable within ~10 seconds of posting"**, and the latency target: **"p99 under 200ms"**. Wait for a nod before writing it down.' },
        { kind: "SAY", text: 'State scope. In: "text search, privacy filtering, ranking, near-real-time indexing". Out: "typeahead autocomplete internals, spell-correction model, ads/sponsored results". "I\'ll flag if I want to come back to any of those."' },
        { kind: "WRITE", text: 'Say out loud: **"This is not a normal search engine — the correct answer to the same query differs per searcher, so privacy has to be part of retrieval, not a filter after it."** Write that sentence on the board; it\'s the thesis for the whole design.' },
      ],
      grading: "Are the scale numbers on the board, and — critically — did you name privacy as a first-class retrieval requirement before drawing a single box?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "One search endpoint, one write endpoint, and a document model that shows text, owner, audience, and timestamp as the four things the index actually needs.",
      why: "The interviewer wants to see you understand what a 'document' in this index actually needs to carry — not just text, but exactly the fields that make privacy-aware graph-local retrieval possible.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /posts { text, audience, mediaRefs? }"** returns "{ postId }". **"GET /search?q=&scope=&cursor="** returns "a ranked, privacy-filtered page of results".' },
        { kind: "DRAW", text: 'Sketch the indexed document: **"post_id"**, **"owner_id"**, **"text (tokenized)"**, **"audience (public / friends / custom_list_id / group_id)"**, **"created_at"**, **"generation_id"**. Say: "Owner and audience are what let me build the privacy postings; generation_id is what makes tombstoning safe."' },
        { kind: "SAY", text: '"A search query internally compiles to a boolean expression: (text terms) AND (audience postings for this searcher), evaluated by the same intersection engine." Write that expression on the board.' },
        { kind: "RULE OUT", text: '"A plain Elasticsearch-style term-sharded index would need a privacy filter after retrieval, with an unknown over-fetch factor to guarantee a full page. That\'s why privacy has to be a postings list, not a filter." Cross off the naive approach.' },
      ],
      grading: "Clean endpoints, a document model with owner/audience/generation fields, and the boolean text-AND-privacy expression written on the board unprompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: write, async indexing, and read. Show that the write path and the indexing path are decoupled, and that the read path fans out to a graph-local slice of shards, not everywhere.",
      why: "This is where you prove the system is not a naive 'post to DB, then search hits DB' design. Separating write, async index build, and read — with read fanning out to a bounded shard set — is the structural signal that unlocks everything else.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write path**: Client → Post Service → TAO. Label it **"synchronous, durable immediately"**.' },
        { kind: "DRAW", text: 'Add the **async indexing path** dropping off TAO: → Kafka/Scribe → Indexing Tier (tokenize + build ACL postings) → Unicorn Shards (hot mutable segment). Label it **"async, ~10s freshness, never blocks the write"**.' },
        { kind: "DRAW", text: 'Add the **read path** as its own lane: Client → Query Service → Broker/Aggregator → Unicorn Shards (fan out to graph-local slice) → Ranking Service → Privacy Service → back to client. Label the fan-out edge **"text ∩ ACL postings, bounded shard set"**.' },
        { kind: "SAY", text: '"Three lanes because they have different jobs: the write path just needs durability, the indexing path optimizes for freshness without blocking writes, and the read path is where privacy and ranking actually happen."' },
      ],
      grading: "Three clearly separated lanes, the fan-out to a bounded (not global) shard set called out explicitly, and an explicit statement that indexing never sits on the write's critical path.",
    },
    {
      n: 4,
      title: "Deep Dive: Privacy-Aware Retrieval",
      minutes: 8,
      goal: "Show the postings-list model for privacy and the two-layer defense (primary index filter, secondary synchronous check), and defend why a naive post-filter loses.",
      why: "This is the signature sub-problem of the whole interview. The interviewer is checking whether you can make privacy correctness cheap at retrieval time instead of expensive after it, and whether you understand that async freshness alone can't guarantee correctness.",
      steps: [
        { kind: "DRAW", text: 'Draw the intersection: **"text postings ∩ friend-edge postings ∩ group postings → candidates"**. "This runs inside the same shard, same engine, as the text-only case — privacy is just another posting list."' },
        { kind: "SAY", text: '"Owner-based sharding co-locates a user\'s posts with their own friend edges, so this intersection touches a small, graph-local slice of shards, not the whole fleet."' },
        { kind: "SAY", text: '"The index can be briefly stale on privacy changes — a recent unfriend or block. So after ranking, I run a synchronous secondary check against the live graph store on the small final result set, and over-fetch by ~3-5x so a page survives the drop."' },
        { kind: "RULE OUT", text: '"A pure post-filter approach — retrieve by text, then check ACLs in a loop — has no bound on how much you need to over-fetch, and checking every candidate against the graph store synchronously means millions of lookups per query instead of dozens." Cross it off.' },
      ],
      grading: "The postings-list model drawn and explained without prompting, the two-layer privacy defense (async primary + synchronous secondary) stated clearly, and a quantified reason the naive post-filter loses.",
    },
    {
      n: 5,
      title: "Deep Dive: Freshness and Ranking",
      minutes: 7,
      goal: "Explain the hot-mutable-segment trick for near-real-time freshness, tombstones for deletes/edits, and the two-stage retrieve-then-rerank ranking pipeline.",
      why: "The interviewer wants to see you reconcile two things that are normally in tension: immutable segments (fast to query) and near-real-time freshness (needs mutation). And they want ranking that scales — not 'run the ML model on everything'.",
      steps: [
        { kind: "SAY", text: '"New writes land in a small hot mutable segment that\'s queried alongside older immutable ones, and a background job merges them over time. That decouples \'fast to intersect\' from \'fast to appear\'."' },
        { kind: "SAY", text: '"Deletes and edits are tombstones, not in-place rewrites — an edit is a tombstone for the old version plus a fresh insert. Every query honors the tombstone set immediately, even before compaction runs."' },
        { kind: "SAY", text: '"Ranking is two-stage: each shard does cheap TF-IDF plus recency decay and returns its own bounded top-K. The broker merges those, and only that smaller set goes through one batched ML rerank call that adds social-graph proximity and engagement."' },
        { kind: "SAY", text: 'Quantify the failure mode: "Reranking at every shard would mean thousands of model calls per query instead of one batched call on the merged top-K — that\'s the whole reason for the two-stage split."' },
      ],
      grading: "Freshness explained via hot-segment-plus-background-merge without conflating it with the write path, tombstones stated explicitly for both deletes and edits, and the two-stage ranking pipeline justified with a quantified reason.",
    },
    {
      n: 6,
      title: "Wrap: Trade-offs, Hot Shards, and Close",
      minutes: 5,
      goal: "Name the deliberate staleness window, the hot-shard risk from owner-based sharding, push back on a requirement, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal here is naming the trade-offs you already accepted rather than waiting to be asked, and treating the interview as a negotiation about scope, not a race to draw more boxes.",
      steps: [
        { kind: "SAY", text: '"There\'s a deliberate, bounded staleness window between a post being durable in TAO and being searchable — a few seconds, driven by change-log lag plus segment refresh. I\'d monitor it as an SLO, not treat it as a bug."' },
        { kind: "SAY", text: '"Owner-based sharding creates hot shards for high-degree accounts — pages, public figures with millions of followers. I\'d split those shards further or replicate them more heavily rather than treating every user uniformly."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need sub-10s freshness for every post, or is that only critical for content inside active conversations? That changes how aggressively I\'d refresh the hot segment."' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a graph-aware inverted index where privacy is a postings list, not a filter, with owner-based sharding and two-stage ranking. With more time I\'d cover typeahead internals, spell-correction, and query-time A/B ranking experiments."' },
      ],
      grading: "The staleness window and hot-shard risk both named unprompted, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working search design that finds the right shape (inverted index, some sharding, some cache) but treats privacy as an afterthought filter rather than a first-class part of retrieval.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Picks an inverted index over the posts and can explain tokenization at a basic level.",
          "Knows to shard the index for scale, usually by document id or hash.",
          "Adds a cache in front of frequent queries.",
          "Recognizes privacy needs to be checked somewhere, usually 'filter results by permission after fetching'.",
          "Can sketch a basic write path: post goes to a database, gets indexed.",
        ],
        gaps: [
          "Privacy filtering happens after retrieval with no bound on over-fetch, and this isn't flagged as a problem.",
          "Doesn't distinguish owner-based sharding from term-based sharding; assumes one sharding strategy fits every query shape.",
          "No plan for near-real-time freshness beyond 'reindex periodically' — doesn't reconcile immutable segments with fast updates.",
          "Ranking is 'sort by relevance score' with no mention of a bounded, two-stage pipeline.",
          "Deletes and edits are handled as 'update the database', without addressing what that means for an append-only index.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives to privacy-as-postings-list without much prompting, picks owner-based sharding with a stated reason, and builds a near-real-time freshness story that doesn't break the index's core assumptions.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "States the scale numbers and the privacy requirement on the board within the first 5 minutes.",
          "Models privacy as posting lists intersected with the text clause, not a post-hoc filter.",
          "Explains owner-based (vertical) sharding and why it beats term sharding for graph-local queries.",
          "Describes a hot-mutable-segment-plus-background-merge approach for near-real-time freshness.",
          "Uses tombstones for deletes/edits instead of in-place mutation.",
          "Splits ranking into a cheap per-shard stage and an expensive merged-set rerank stage.",
        ],
        gaps: [
          "Names the secondary privacy check only when the interviewer asks 'what if the index is stale', not on their own.",
          "Doesn't quantify the over-fetch multiplier or the freshness window in concrete numbers.",
          "Mentions hot shards for high-degree accounts only if prompted about sharding fairness.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats privacy-as-postings-list as the design's thesis stated up front, and volunteers every second-order risk (staleness window, hot shards, over-fetch cost) with numbers before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Opens with the framing sentence that this is not a normal search engine because the correct answer differs per searcher — and builds the whole design from that thesis.",
          "Volunteers the two-layer privacy defense (async primary filter + synchronous secondary recheck) unprompted, with a quantified over-fetch multiplier.",
          "Names the bounded staleness window as a deliberate SLO, not a bug, with the specific lag sources (change-log delay + segment refresh interval).",
          "Brings up hot shards from high-degree accounts unprompted and proposes a concrete mitigation (further splitting, heavier replication).",
          "Justifies the two-stage ranking split with a quantified reason (bounded model-call count vs. per-shard reranking cost).",
          "Pushes back on requirements where appropriate (e.g., does every post need sub-10s freshness, or only active conversations).",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Treating privacy as a filter applied after retrieval with no bound on over-fetching — this is the single biggest tell that the candidate hasn't understood the core problem.",
      "Proposing a single global term-sharded index with no owner-based option, so every 'search my friends' posts' query fans out to nearly every shard.",
      "No freshness story beyond periodic batch reindexing, when the requirement is searchable within ~10 seconds.",
      "Mutating index segments in place to handle deletes/edits instead of using tombstones — breaks the compression and speed that make the index fast.",
      "Running the full ML ranking model against every shard's candidates instead of a bounded top-K before reranking.",
      "Trusting the async index alone for privacy correctness with no synchronous recheck, risking a real leak on stale unfriend/block state.",
      "No capacity numbers at all — sharding strategy, freshness budget, and ranking cost all become guesses instead of consequences of stated scale.",
    ],
    followUps: [
      {
        q: "How does this differ from just running Elasticsearch over posts?",
        a: "Elasticsearch (and Lucene under it) is superb at term-sharded text retrieval but has no native concept of a per-searcher privacy answer — you'd bolt privacy on as a post-retrieval filter or a query-time script filter, both of which either over-fetch unboundedly or risk partial pages. Facebook's Unicorn treats the social graph itself as more posting lists that intersect with text inside the same engine, and shards vertically by owner so the dominant graph-local query pattern doesn't fan out everywhere. It's the same core data structure (posting lists, intersection), applied to a fundamentally different sharding and query model.",
      },
      {
        q: "What happens if the async indexing pipeline falls behind — say Kafka backs up for 5 minutes?",
        a: "New and edited posts stop appearing in search within the 10s target, but nothing is lost: TAO already has the durable write, and the change log is durable and ordered, so the indexer catches up once the backlog clears. The bigger risk is deletes lagging the same way — a deleted post could remain searchable a bit longer than usual. Because deletes are also tombstones flowing through the same pipeline, the fix is monitoring: alert on change-log consumer lag as a first-class SLO, since it directly maps to how stale search results are.",
      },
      {
        q: "Why not just check privacy synchronously against the graph store for every candidate, and skip the postings-list approach entirely?",
        a: "Because that means a synchronous network round-trip to the graph store per candidate per shard — with thousands of candidates across a graph-local fan-out, that's potentially thousands of blocking lookups per single search query, which destroys the p99 latency budget. The postings-list intersection does the equivalent check as pure in-memory set operations at index-query speed. The synchronous graph-store check still happens, but only once, on the small final result set after ranking — a handful of lookups instead of thousands.",
      },
      {
        q: "How do you handle a user with 5 million followers (a public figure or page) without creating a hot shard?",
        a: "Owner-based sharding naturally wants to co-locate that user's posts and edges on one shard, but at that fan-out, any single shard becomes a hotspot for both index updates and every search that touches that user's content. The mitigation is treating high-degree accounts as a special case: split their postings across multiple shards (partition by a secondary key like post_id range within the owner), and replicate those specific shards more heavily than average. This is a deliberate exception to the general rule, applied to a small, identifiable set of accounts.",
      },
      {
        q: "What's the actual failure mode if the secondary privacy check is removed?",
        a: "The system would rely entirely on the async index's freshness for privacy correctness. Since indexing lags real time by up to the freshness window, a recently unfriended or blocked person's search could still surface a post from someone who just revoked their access — a real, user-visible privacy leak, not just a staleness annoyance. That's why the secondary check exists specifically as a synchronous, authoritative source-of-truth recheck: it trades a small amount of latency on a small result set for a hard correctness guarantee.",
      },
      {
        q: "How would you extend this to support group and page search, not just individual friends?",
        a: "The same postings-list model extends directly: group membership and page-follow relationships are just more posting lists, intersected the same way as friend edges. The owner-based sharding co-locates a group's posts with its membership roster the same way it does for individual users. The main new complexity is that group membership changes (join/leave) need the same freshness and tombstone treatment as friend edges, and very large groups or pages need the same hot-shard mitigation as high-degree individual accounts.",
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
          "This is a graph-aware inverted index, not a plain text search engine. The reason it's a genuinely different system from Elasticsearch-over-posts is that the correct answer to identical query text is different for every searcher, so privacy can't be an afterthought — it has to be part of retrieval itself.",
          "Anchor everything on the numbers: ~3B users, hundreds of billions of posts/comments, ~500M new items/day (~6K/sec sustained, 50K peak), ~1.5B searches/day (~20K qps sustained, 60K peak), a ~10s freshness target, and a hard zero-tolerance requirement on privacy leaks. Every structural choice below is a consequence of these, especially the last one.",
        ],
      },
      {
        heading: "Privacy as posting lists, not a filter",
        body: [
          "Facebook's real system for this, Unicorn, models friend edges, group membership, and audience settings as posting lists exactly like a term's posting list. A query compiles to a boolean expression — (text terms) AND (privacy postings for this searcher) — evaluated as a single intersection inside the index engine, so what comes out the other side is already known to be visible.",
          "This avoids the two failure modes of a bolt-on filter: unbounded over-fetching to guarantee a full page, or returning partial pages because too many fetched candidates got discarded. The trade-off is that the index now has to store and keep fresh far more than text — the whole shape of the friend graph and group rosters.",
        ],
      },
      {
        heading: "Sharding: why the dominant query shape drives the strategy",
        body: [
          "Term-based sharding — the classic search-engine approach — spreads any query's posting lists across every shard, so a graph-scoped query ('search my friends' posts') fans out to nearly all of them regardless of how few friends the searcher has. Unicorn instead shards vertically by document owner, co-locating a user's posts, edges, and group memberships, so a graph-local query only touches a small, predictable slice of shards.",
          "A term-sharded path still exists alongside it for global public search (a trending-topic query with no graph scope). The cost of owner-based sharding is a harder rebalancing story (moving a user moves their whole neighborhood) and hot shards for high-degree accounts, which need special-cased splitting and heavier replication.",
        ],
      },
      {
        heading: "Freshness: a hot mutable segment next to immutable ones",
        body: [
          "Classic inverted indexes get their speed from immutable, compressed segments — exactly the property that makes a ~10s freshness target hard, since rebuilding a segment per write is too slow. The fix is a small, frequently-refreshed hot mutable segment that absorbs recent writes and is queried alongside the older immutable segments, with a background process merging them over time.",
          "Deletes and edits never mutate a segment in place: a delete is a tombstone honored at query time, and an edit is a tombstone plus a fresh insert. This keeps every segment append-only, preserving the compression and intersection speed the whole system depends on, at the cost of a deliberate, bounded staleness window between durability and searchability.",
        ],
      },
      {
        heading: "Ranking: bound the expensive stage",
        body: [
          "Combining text relevance, recency, and social-graph proximity in one ML model call per candidate, per shard, would multiply into thousands of model calls per query. The fix is two stages: cheap TF-IDF-plus-recency scoring at each shard picks a bounded top-K locally, a broker merges those bounded lists, and only that smaller merged set goes through one batched ML rerank call that adds graph proximity and engagement.",
          "The trade-off is that a candidate scoring low locally can get cut before the reranker ever sees it — tuning the per-shard top-K balances that recall loss against reranker cost.",
        ],
      },
      {
        heading: "Defense in depth on privacy",
        body: [
          "Because the async index can briefly lag real-time privacy changes (an unfriend, a block, an audience edit), the design never trusts it alone. The cheap primary filter (postings-list intersection) handles the bulk of traffic; a synchronous secondary check against the live graph store re-verifies the small final result set right before returning it to the client, with a 3-5x over-fetch multiplier so a dropped candidate doesn't shrink the page below what was requested.",
          "That two-layer structure — cheap-and-async for volume, expensive-and-synchronous for correctness on a small final set — is the general pattern worth remembering: it shows up anywhere an async pipeline's freshness window collides with a zero-tolerance correctness requirement.",
        ],
      },
    ],
  },
};
