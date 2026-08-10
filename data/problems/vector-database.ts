import type { Problem } from "@/lib/types";

export const vectorDatabase: Problem = {
  slug: "vector-database",
  num: "7.7",
  title: "Design a Vector Database",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a vector database that stores 1 billion 768-dimensional embeddings (document, image, or product vectors), serves 10K approximate nearest-neighbor queries/sec at p99 < 50ms with recall@10 above 95%, sustains 5K upserts/sec from a live embedding pipeline, and supports metadata filtering (hybrid search) without silently collapsing recall.",
  ],
  hardParts:
    "The hard parts: fitting a graph index for a billion vectors into memory without paying for a billion raw float32 vectors, combining metadata filters with graph search without breaking recall, and keeping the index fresh under continuous writes when rebuilding a graph in place is expensive.",
  keyTopics: [
    "HNSW Graph Index",
    "Product Quantization",
    "Scatter-Gather Sharding",
    "Filtered ANN Search",
    "LSM-Style Segment Writes",
  ],
  foundationsReferenced: [
    { label: "HNSW / Skip Lists", tone: "purple" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "LSM Trees vs B-Trees", tone: "blue" },
    { label: "Quorum Reads/Writes", tone: "orange" },
    { label: "Bloom / Roaring Bitmaps", tone: "green" },
    { label: "Eventual Consistency", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "query embedding", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "Query Gateway", sub: "embed + route", col: 2, row: 1, tone: "slate" },
      {
        id: "shard",
        label: "Vector Shard",
        sub: "HNSW in RAM + PQ codes",
        mono: "efSearch=128 · ~25M vecs",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "metaidx", label: "Metadata Index", sub: "Roaring bitmaps", col: 4, row: 1, tone: "green" },
      { id: "merge", label: "Merge + Rerank", sub: "top-k across 40 shards", col: 5, row: 1, tone: "green" },

      { id: "builder", label: "Index Builder", sub: "background HNSW build", col: 3, row: 3, tone: "orange" },
      { id: "compactor", label: "Compactor", sub: "merge segments, quantize", col: 4, row: 3, tone: "orange" },
      { id: "objstore", label: "Object Store", sub: "S3 snapshots", col: 5, row: 3, tone: "blue" },

      { id: "upsert", label: "Upsert API", sub: "5K/s", col: 1, row: 4, tone: "purple" },
      { id: "wal", label: "Kafka WAL", sub: "durable log", col: 2, row: 4, tone: "orange" },
      {
        id: "segwriter",
        label: "Segment Writer",
        sub: "immutable, unindexed buffer",
        col: 3,
        row: 4,
        tone: "purple",
      },
    ],
    edges: [
      { from: "client", to: "gateway", label: "embed query", kind: "read" },
      { from: "gateway", to: "shard", label: "scatter to all 40 shards", kind: "read" },
      { from: "shard", to: "metaidx", label: "bitmap AND during graph walk", kind: "read" },
      { from: "shard", to: "merge", label: "top-k per shard", kind: "read" },
      { from: "merge", to: "gateway", label: "global top-k + rerank", kind: "read" },

      { from: "upsert", to: "wal", label: "5K/s append", kind: "write" },
      { from: "wal", to: "segwriter", label: "consume, buffer", kind: "write" },
      { from: "segwriter", to: "shard", label: "brute-force searchable immediately", kind: "write" },

      { from: "segwriter", to: "builder", label: "async, seal + build graph", kind: "analytics" },
      { from: "builder", to: "compactor", label: "small segments merged", kind: "analytics" },
      { from: "compactor", to: "objstore", label: "durable snapshot + PQ codes", kind: "analytics" },
      { from: "objstore", to: "shard", label: "replica bootstrap", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · 10K ANN queries/sec" },
      { kind: "write", text: "write path · 5K upserts/sec" },
      { kind: "analytics", text: "background · index build, compaction, snapshotting — never blocks a query" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "gateway", "shard", "upsert"],
      say: "Two entry points that never share a path: the Query Gateway routes reads to a Vector Shard's in-RAM HNSW graph, and a separate Upsert API takes writes. At 2:1 read-to-write, neither side is negligible.",
    },
    {
      reveal: ["metaidx", "merge"],
      say: "A similarity query has no partition key, so it eventually fans out to every shard. Merge + Rerank combines each shard's local top-k, and a Metadata Index of Roaring bitmaps lets the graph walk skip filtered-out vectors without silently starving recall.",
    },
    {
      reveal: ["wal", "segwriter"],
      say: "On the write side, an upsert is durably appended to a Kafka WAL before it's ever acknowledged — that's the actual durability boundary. A Segment Writer then buffers it unindexed, brute-force searchable within seconds, long before it's anywhere near the graph.",
    },
    {
      reveal: ["builder", "compactor", "objstore"],
      say: "Off the query path entirely: the Index Builder seals a buffer and builds its HNSW graph async, a Compactor merges small segments and physically applies deletes, and Object Store holds durable snapshots so a replacement replica bootstraps without replaying the whole WAL.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Upsert a vector with an id and associated JSON metadata", tag: "P0" },
      { id: "FR-02", text: "Approximate k-NN search: top-k by cosine, dot-product, or L2 distance", tag: "P0" },
      { id: "FR-03", text: "Combine metadata filters with vector search (hybrid pre-filter)", tag: "P0" },
      { id: "FR-04", text: "Delete and update vectors by id", tag: "P0" },
      { id: "FR-05", text: "Namespace/collection isolation for multi-tenant workloads", tag: "P0" },
      { id: "FR-06", text: "Batch upsert, up to 1000 vectors per request", tag: "P1" },
      { id: "FR-07", text: "Hybrid search: blend dense vector score with sparse (BM25/keyword) score", tag: "P1" },
      { id: "FR-08", text: "Optional reranking pass with a secondary (cross-encoder) model on top-k", tag: "P1" },
      { id: "FR-09", text: "Snapshot and restore an entire collection for backup/migration", tag: "P1" },
      { id: "FR-10", text: "Exact (brute-force) search mode for small collections or validation", tag: "P2" },
      { id: "FR-11", text: "Multiple distance metrics configurable per collection", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "ANN query latency, server-side, at 10K QPS", tag: "p99 < 50ms" },
      { id: "NFR-02", text: "Recall@10 versus brute-force ground truth", tag: "> 95%" },
      { id: "NFR-03", text: "Upsert throughput, sustained", tag: "5K/sec" },
      { id: "NFR-04", text: "Freshness: time from upsert acknowledged to searchable", tag: "< 5s" },
      { id: "NFR-05", text: "Availability (about 4.4 hrs downtime/year)", tag: "99.95%" },
      { id: "NFR-06", text: "Durability of vectors and metadata after ack", tag: "zero loss" },
      { id: "NFR-07", text: "In-memory index footprint for 1B × 768-dim vectors", tag: "< 300GB" },
      { id: "NFR-08", text: "Cluster scale, single collection", tag: "1B+ vectors" },
      { id: "NFR-09", text: "Read-to-write ratio that anchors sharding and replica count", tag: "2:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why raw float32 storage is a non-starter",
      body: [
        "Before choosing an index, prove that storing the vectors naively doesn't fit. Each embedding is 768 float32 numbers, 4 bytes each, so one vector is 3,072 bytes. At 1 billion vectors that's about 3.07TB of raw vector data alone, before a single graph edge is stored. An HNSW graph adds neighbor links on top: with M=16 (16 links per layer, roughly 32 stored per node counting the base layer), each node carries about 128 bytes of links, adding another ~128GB. Uncompressed, you're already past 3TB for one collection — and that's before replication.",
        "That number is what forces compression into the design from day one, not as an optimization added later. Product quantization compresses each 3,072-byte vector down to roughly 96 bytes (splitting the vector into subvectors and replacing each with a 1-byte codebook index) — a ~32× reduction. 1B vectors × 96 bytes ≈ 96GB. Add the ~128GB of graph links and you land around 220-300GB, spread across shards, which fits comfortably in RAM across a modest cluster instead of requiring a small data center.",
      ],
      bullets: [
        { lead: "Raw float32", text: "3.07TB for vectors alone at 1B × 768-dim, before any graph structure. Rejected as the resident format." },
        { lead: "Scalar quantization (SQ8)", text: "quantizes each float to 1 byte, a 4× reduction (~768GB total). Simple, higher recall than PQ, used when memory is less constrained." },
        { lead: "Product quantization (PQ)", text: "splits each vector into m subvectors, replaces each with a codebook index, giving ~32× compression (~96GB total). More recall loss than SQ8, recovered later with reranking on raw vectors." },
      ],
      pictureTitle: "Where does the memory go?",
      pictureCaption: "3.07TB raw vectors → 96GB with PQ (32×) → ~220-300GB total once graph links are added back",
      pictureRows: [
        { label: "Raw float32 (3,072B/vec)", value: "3.07TB, before graph edges — reject as resident format", tone: "bad" },
        { label: "PQ compressed (~96B/vec)", value: "96GB, ~32× smaller", tone: "good" },
        { label: "+ HNSW graph links (~128B/vec)", value: "+~128GB, total ~220-300GB", tone: "neutral" },
      ],
      remember: {
        problem: "Fit a billion-vector graph index in memory without paying for raw float32 storage.",
        solution: "Product quantization compresses each vector ~32×; combined with graph links, the resident footprint drops from ~3TB to ~250-300GB.",
        why: "Vector search is memory-bandwidth bound, so the index must live in RAM; compression is what makes that affordable at billion-scale.",
        tradeoff: "PQ trades some recall for 32× smaller footprint; you recover accuracy by reranking the top candidates against the original raw vectors.",
        failure: "Storing raw float32 vectors on a billion-row collection means a multi-terabyte RAM requirement per replica, which is not economical.",
        mitigation: "Store PQ codes for the graph walk, keep raw vectors in cheaper storage (disk/object store) for a final reranking pass on only the top-k candidates.",
      },
    },
    {
      n: 2,
      title: "Index choice: kill three options, defend HNSW",
      body: [
        "The core operation is: given a query vector, find its k nearest neighbors among a billion candidates, fast. Exact nearest-neighbor search is a full scan — there's no shortcut for exactness in high dimensions (the 'curse of dimensionality' defeats tree structures like k-d trees once you're past a few dozen dimensions). So every practical vector database is approximate by design. Put the candidates on the board and rule them out one at a time.",
      ],
      bullets: [
        { lead: "Brute-force scan", text: "compares the query against every vector, O(n) per query. At 1B vectors that's seconds per query, not milliseconds. Rejected for the online path; kept only as the ground truth for measuring recall." },
        { lead: "LSH (locality-sensitive hashing)", text: "hashes similar vectors into the same bucket. Simple and once popular, but at high dimensions (768) it needs many hash tables to hit good recall, and both recall and latency lag graph-based methods badly. Rejected." },
        { lead: "IVF (inverted file index)", text: "k-means-clusters the space into buckets (say 4096 centroids), and a query only searches the nprobe nearest buckets. Fast to build, memory-light, but recall is sensitive to nprobe and cluster boundaries can hide true neighbors near the edge of a bucket. Partially accepted — used as the coarse routing layer, not the sole index." },
        { lead: "HNSW", text: "a multi-layer navigable small-world graph: a sparse top layer for long jumps, denser lower layers for local refinement, greedy best-first search from top to bottom. Logarithmic-ish query cost, the best recall-per-millisecond of any structure at this scale. Winner — at the cost of being memory-hungry, which is why quantization (Learn #1) has to travel with it." },
      ],
      pictureTitle: "ANN index: kill two, keep one, borrow one",
      pictureRows: [
        { label: "Brute-force scan", value: "O(n), seconds/query at 1B → reject (keep as ground truth)", tone: "bad" },
        { label: "LSH", value: "weak recall at 768-dim → reject", tone: "bad" },
        { label: "IVF", value: "fast, memory-light, recall sensitive to nprobe → borrow for routing", tone: "neutral" },
        { label: "HNSW", value: "best recall/latency, memory-hungry → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Find k nearest neighbors among 1B vectors in milliseconds.",
        solution: "HNSW graph index, PQ-compressed, with IVF-style clustering used for coarse shard routing.",
        why: "High dimensions defeat exact tree indexes; approximate graph search gets the best recall-per-millisecond of any known structure at this scale.",
        tradeoff: "You give up exactness (and pay for compression to fit the graph in RAM) in exchange for millisecond queries at a billion vectors.",
        failure: "Brute force at 1B vectors takes seconds per query; that's a 1000×+ miss on the 50ms budget.",
        mitigation: "Tune efSearch per query to trade recall for latency (Learn #6), and keep brute force as an exact-mode option for small collections (FR-10).",
      },
    },
    {
      n: 3,
      title: "Sharding a billion vectors: scatter-gather is the honest answer",
      body: [
        "A single machine can't hold a billion-vector HNSW graph and its query load, so the index has to be sharded. Unlike a key-value store, a vector query has no natural partition key — the nearest neighbor to a query could be on any shard, so there's no way to route a query to just one shard the way you'd route a GET by primary key.",
        "The practical answer used by Pinecone, Weaviate, and Milvus is hash-partition for storage and scatter-gather for reads: partition vectors by a hash of their id across N shards for even write distribution, fan every query out to all N shards in parallel, let each shard return its local top-k against its own HNSW graph, then merge and re-rank the N×k candidates at a coordinator. At 25M vectors per shard (RAM-bounded to keep the graph fast), 1B vectors needs about 40 shards; each query becomes 40 parallel local searches plus one merge, and end-to-end latency is bounded by the slowest shard, not the sum.",
      ],
      bullets: [
        { lead: "Hash-partition by id", text: "keeps writes and deletes evenly spread and requires no rebalancing when the vector distribution shifts, unlike centroid-based partitioning." },
        { lead: "Scatter-gather on read", text: "every query touches every shard because neighbors could be anywhere — there's no cheaper routing without sacrificing recall." },
        { lead: "Shard size, not shard count, is the tuning knob", text: "~25M vectors/shard keeps each shard's graph and PQ codes around 6-8GB, small enough for fast in-memory search and fast rebuild during compaction." },
        { lead: "Replicate for durability and read fan-out", text: "RF=3 per shard both survives node loss and spreads the scatter-gather read load across replicas." },
      ],
      pictureTitle: "Why every query touches every shard",
      pictureRows: [
        { label: "Hash-partition (chosen)", value: "even write load, but every query fans out to all shards", tone: "neutral" },
        { label: "Centroid/IVF partition", value: "route to a few shards, but skewed load & harder rebalancing", tone: "bad" },
        { label: "40 shards × 25M vectors", value: "~6-8GB/shard, query latency ≈ slowest shard", tone: "good" },
      ],
      remember: {
        problem: "Distribute 1B vectors across a cluster when a query could match any shard.",
        solution: "Hash-partition ~40 shards of ~25M vectors each; scatter every query to all shards, merge top-k at a coordinator.",
        why: "Vector queries have no natural routing key like a primary-key lookup, so there's no cheaper alternative to touching every shard without losing recall.",
        tradeoff: "Every query does N parallel network hops instead of one; tail latency is governed by the slowest shard.",
        failure: "Route by centroid instead of hash and shard load skews badly whenever the embedding distribution isn't uniform across clusters.",
        mitigation: "Keep shard count and size bounded so per-shard search stays fast, and replicate (RF=3) to bound tail latency and survive node loss.",
      },
    },
    {
      n: 4,
      title: "Filtered search: why 'just AND a WHERE clause' breaks recall",
      body: [
        "Real queries aren't pure nearest-neighbor — they're 'find similar products where category = shoes and in_stock = true.' The naive approaches both fail in a specific, quantifiable way, which is exactly what an interviewer is probing for.",
        "Post-filtering — run the ANN search first, then drop results that fail the filter — silently returns fewer than k results, or even zero, whenever the filter is selective. If only 1% of vectors match category=shoes, and you fetch top-100 unfiltered candidates, the expected number that also match the filter is about 1, not 100. Pre-filtering — compute the filter first as a bitmap, then restrict the HNSW graph walk to only nodes in that bitmap — fixes the recall problem but can break the graph's connectivity: HNSW's whole speed advantage comes from long-range 'highway' edges built across the full dataset, and if 99% of nodes are excluded by a restrictive filter, the surviving nodes may barely be connected to each other, so the greedy search gets stuck in a fraction of the space it should be exploring.",
      ],
      bullets: [
        { lead: "Post-filter", text: "cheap and simple, but with a selective filter you can return far fewer than k results, or none — recall silently collapses." },
        { lead: "Naive pre-filter", text: "restrict traversal to the filtered bitmap only; fixes correctness but the reduced graph may be poorly connected, degrading recall a different way." },
        { lead: "Filter-aware traversal (ACORN-style)", text: "walk the full HNSW graph as normal, but skip over filtered-out nodes as candidates while still traversing through them to preserve connectivity. This is what Weaviate and Milvus converged on." },
        { lead: "Selectivity-based fallback", text: "when the filter bitmap is small enough (say under 1-2% of the collection), skip the graph entirely and brute-force scan just the filtered set — faster and exact once the candidate pool is small." },
        { lead: "Metadata index", text: "Roaring bitmaps per attribute value give sub-millisecond AND/OR of filter predicates, which is what makes computing selectivity and the filter bitmap itself cheap." },
      ],
      pictureTitle: "Filtering strategies and their failure mode",
      pictureRows: [
        { label: "Post-filter", value: "cheap, but selective filters return < k or zero results", tone: "bad" },
        { label: "Naive pre-filter (bitmap-restricted walk)", value: "correct count, but graph connectivity can collapse", tone: "bad" },
        { label: "Filter-aware traversal", value: "walk full graph, skip non-matching candidates only", tone: "good" },
        { label: "Brute-force fallback (< ~2% selectivity)", value: "scan the small filtered set directly, exact and fast", tone: "good" },
      ],
      remember: {
        problem: "Combine metadata filters with ANN search without silently losing recall.",
        solution: "Filter-aware graph traversal that preserves connectivity, with a brute-force fallback when the filtered set is small.",
        why: "Post-filtering starves on selective filters; naive pre-filtering can disconnect the graph it depends on for speed.",
        tradeoff: "Filter-aware traversal costs more per query than a plain graph walk, but it's the only option that keeps both correctness and speed.",
        failure: "A selective filter (1% match) with post-filtering on a top-100 fetch returns roughly 1 result instead of 100.",
        mitigation: "Estimate filter selectivity from Roaring bitmaps up front and choose the traversal strategy (graph-with-skip vs. brute-force) per query.",
      },
    },
    {
      n: 5,
      title: "Writes: why you can't just insert into a live HNSW graph",
      body: [
        "HNSW graphs are built incrementally in theory, but doing that at 5K upserts/sec in a live, concurrently-queried graph is expensive: each insert needs to find its neighbors at every layer and update their edge lists, which means fine-grained locking on a structure that's also being read thousands of times a second. Deletes are worse — removing a node safely means repairing every edge that pointed to it, or the graph develops holes that degrade search quality over time.",
        "The fix borrows directly from LSM trees. New vectors land in a small in-memory, unindexed buffer (a flat list, brute-force searchable) and are durably logged to a WAL (Kafka) before the upsert is acknowledged — so freshness is milliseconds, not the minutes an HNSW build would take. In the background, once a buffer segment is large enough, it's sealed as immutable and a new HNSW graph is built for just that segment. A compactor periodically merges small segments into larger ones and rebuilds their graphs, which is also where deletes are physically applied — a tombstone bitmap marks a vector deleted immediately (so it disappears from results right away), and the vector is only actually dropped from the graph the next time its segment is compacted.",
      ],
      bullets: [
        { lead: "WAL first", text: "an upsert is acknowledged once durably logged to Kafka, not once indexed — durability and indexing are decoupled." },
        { lead: "Hot buffer", text: "small, unindexed, brute-force searchable — this is what makes a just-written vector show up in search results within seconds, not minutes." },
        { lead: "Background graph build", text: "sealed segments get an HNSW graph built off the query path, exactly like an SSTable flush." },
        { lead: "Compaction merges + applies deletes", text: "small segments merge into larger ones on a schedule; tombstoned vectors are dropped from the graph only at compaction time, avoiding expensive live edge repair." },
        { lead: "Query merges both", text: "a search hits the hot buffer (brute force) and every sealed HNSW segment, merging results — same shape as an LSM read merging the memtable with SSTables." },
      ],
      pictureTitle: "The write path, LSM-style",
      pictureRows: [
        { label: "WAL append", value: "ack'd here — durable before indexed", tone: "neutral" },
        { label: "Hot buffer (unindexed)", value: "brute-force searchable within seconds", tone: "good" },
        { label: "Sealed segment", value: "HNSW graph built async, off the query path", tone: "good" },
        { label: "Compaction", value: "merges segments, physically drops tombstoned vectors", tone: "neutral" },
      ],
      remember: {
        problem: "Sustain 5K upserts/sec without stalling on live HNSW graph edits.",
        solution: "LSM-style write path: WAL for durability, unindexed hot buffer for immediate freshness, async graph build on sealed segments, background compaction.",
        why: "In-place HNSW inserts/deletes require locking a structure under heavy concurrent read load; decoupling durability from indexing removes writes from the query hot path.",
        tradeoff: "A query must merge results from the hot buffer and every sealed segment, adding a small amount of read-side complexity.",
        failure: "Editing a live shared HNSW graph per write introduces lock contention that tanks both query latency and upsert throughput under load.",
        mitigation: "Cap the hot buffer size so brute-force scans stay cheap, and compact on a schedule so segment count (and therefore per-query merge cost) doesn't grow unbounded.",
      },
    },
    {
      n: 6,
      title: "efSearch, efConstruction, M: the recall/latency dial",
      body: [
        "HNSW exposes three knobs, and only one of them is a per-query decision. M is the max number of neighbor edges each node keeps per layer — set at index build time, higher M means better recall and more memory (more edges to store and walk). efConstruction is the candidate list size used while building the graph — higher means a better-quality graph but slower to build, also fixed at build time. efSearch is the candidate list size used at query time, and it's the one product and infra teams actually tune live: higher efSearch explores more of the graph before returning, trading latency for recall, per query if needed.",
        "Concretely: efSearch=64 might land around 90% recall@10 at ~5ms; efSearch=128 might land around 96% at ~15ms; efSearch=256 might push to 98%+ at 30-40ms. There's no setting that gets you to 100% recall except brute force — approximate is the whole premise, and the interview-worthy point is naming that as a deliberate product decision (how much recall for how much latency), not a bug to apologize for.",
      ],
      bullets: [
        { lead: "M (build-time)", text: "max edges per node; higher M = better recall, bigger graph. Typically 12-48; higher-dimensional or noisier embeddings often want the higher end." },
        { lead: "efConstruction (build-time)", text: "candidate list size while inserting a node; higher = better-quality graph, slower to build. Doesn't affect query latency once built." },
        { lead: "efSearch (query-time)", text: "candidate list size while searching; the only knob you can vary per request, e.g. lower for an autocomplete suggestion, higher for a one-shot recommendation." },
        { lead: "Recall is a product decision", text: "a recsys or RAG retrieval step tolerates being off by a rank or two; a primary-key lookup does not. Say this out loud — it's why 'approximate' is acceptable here at all." },
      ],
      pictureTitle: "efSearch trades recall for latency",
      pictureRows: [
        { label: "efSearch=64", value: "~90% recall@10, ~5ms", tone: "neutral" },
        { label: "efSearch=128", value: "~96% recall@10, ~15ms", tone: "good" },
        { label: "efSearch=256", value: "~98%+ recall@10, ~30-40ms", tone: "neutral" },
        { label: "Brute force", value: "100% recall, seconds at 1B vectors — not viable online", tone: "bad" },
      ],
      remember: {
        problem: "Hit p99 < 50ms and recall@10 > 95% without an obvious single setting.",
        solution: "Fix M and efConstruction at index build time for graph quality; tune efSearch per query to trade recall against latency live.",
        why: "efSearch is the only one of the three knobs that's cheap to change without rebuilding the index, so it's the operational lever.",
        tradeoff: "Higher efSearch buys recall at the cost of exploring more of the graph, directly increasing per-query latency.",
        failure: "Fixing efSearch too low to hit a latency SLA quietly drops recall below what the product needs, with no error to signal it.",
        mitigation: "Set efSearch per use case (lower for latency-sensitive autocomplete, higher for one-shot recommendations), and monitor sampled recall against a brute-force baseline in production.",
      },
    },
    {
      n: 7,
      title: "Consistency: why eventual is not a compromise here",
      body: [
        "A vector search that misses a vector written 200ms ago doesn't corrupt anything — it just under-returns momentarily, and the next query a moment later will see it. That's fundamentally different from a bank balance or an inventory count, and it's why vector databases lean unapologetically into eventual consistency rather than paying for quorum reads on every query.",
        "The durability boundary is the WAL, not the index: an upsert is acknowledged once written to Kafka (replicated, durable), before it's searchable. Replicas don't copy the HNSW graph byte-for-byte — graph construction has randomness in it (which neighbors get linked depends on insertion order and concurrent state) and replicating a non-deterministic structure exactly is wasteful. Instead, each replica independently consumes the same WAL and builds its own segments and graphs. If a shard leader crashes before compaction, recovery just means replaying the WAL from the last durable checkpoint to rebuild the hot buffer — the graph itself is rebuildable, so it doesn't need to be the thing you protect.",
      ],
      bullets: [
        { lead: "WAL is the durability boundary", text: "acknowledge on durable log write, not on index completion — decouples 'safe' from 'searchable'." },
        { lead: "Replicas rebuild independently", text: "each replica consumes the same WAL and builds its own HNSW graph rather than replicating graph bytes, sidestepping non-determinism in graph construction." },
        { lead: "Read-after-write is relaxed", text: "'eventually searchable within the index-build latency window (seconds)' is the honest SLA, not immediate consistency." },
        { lead: "Crash recovery = WAL replay", text: "a crashed shard rebuilds its hot buffer (and eventually its segments) from the log; the graph was always disposable and rebuildable." },
      ],
      pictureTitle: "What's durable vs. what's disposable",
      pictureRows: [
        { label: "WAL entry", value: "durable — the actual source of truth", tone: "good" },
        { label: "Hot buffer", value: "rebuildable from WAL replay on crash", tone: "neutral" },
        { label: "HNSW graph", value: "disposable — rebuilt from segments, never replicated byte-for-byte", tone: "neutral" },
        { label: "Cross-replica strong consistency", value: "not attempted — a stale read just under-returns briefly", tone: "used" },
      ],
      remember: {
        problem: "Decide how strong a consistency guarantee a vector search actually needs.",
        solution: "WAL is the durability boundary; replicas independently rebuild graphs from the log; reads are eventually consistent within the index-build window.",
        why: "A missed recent write degrades a search result slightly instead of corrupting state, so the cost of strong consistency isn't justified here.",
        tradeoff: "A vector can be briefly invisible to search right after being acknowledged as written.",
        failure: "Trying to replicate HNSW graphs byte-for-byte across replicas fights the structure's build-time non-determinism for no correctness benefit.",
        mitigation: "Treat the graph as a rebuildable cache over the WAL; recovery is always 'replay the log,' never 'repair the graph.'",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's an approximate nearest-neighbor index (HNSW) over compressed vectors (product quantization), sharded by hash with scatter-gather reads, because no partition key can route a similarity query to just one shard.",
      "Writes go through an LSM-style path — WAL, unindexed hot buffer, async graph build, background compaction — because editing a live shared graph under concurrent reads doesn't scale.",
      "Metadata filters need filter-aware graph traversal, not a naive pre- or post-filter, or recall silently collapses on selective filters.",
      "efSearch is the one knob you tune per query to trade recall for latency; M and efConstruction are fixed at build time.",
      "Consistency is eventual on purpose: a missed recent write under-returns for a moment, it never corrupts state, so quorum reads aren't worth paying for.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 10K QPS · P99 < 50MS",
        summary:
          "The query is embedded, fanned out to every shard in parallel since neighbors could be anywhere, and each shard walks its own compressed HNSW graph while filtering by a metadata bitmap. Results merge and optionally rerank at the coordinator.",
        steps: [
          { label: "Client", note: "sends query vector or text to embed" },
          { label: "Query Gateway", note: "embeds if needed, fans out" },
          { label: "40 Vector Shards (parallel)", note: "HNSW walk, efSearch=128, skip non-matching via metadata bitmap" },
          { label: "Metadata Index", note: "Roaring bitmap AND during traversal" },
          { label: "Merge + Rerank", note: "combine top-k × 40 shards, optional cross-encoder rerank" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · 5K/S",
        summary:
          "An upsert is durably logged before it's acknowledged, then buffered unindexed so it's searchable within seconds. The graph itself is only built once a buffer segment is sealed, off the query path.",
        steps: [
          { label: "Client", note: "submits vector + metadata" },
          { label: "Upsert API", note: "hash-route to shard" },
          { label: "Kafka WAL", note: "ack after durable append" },
          { label: "Hot buffer", note: "unindexed, brute-force searchable in seconds" },
          { label: "Segment Writer", note: "seals buffer once full/aged" },
        ],
      },
      {
        kind: "analytics",
        title: "BACKGROUND · NEVER BLOCKS A QUERY",
        summary:
          "Sealed segments get their HNSW graph built asynchronously. A compactor merges small segments, physically drops tombstoned vectors, and snapshots to object storage for replica bootstrap.",
        steps: [
          { label: "Index Builder", note: "builds HNSW + PQ codes for a sealed segment" },
          { label: "Compactor", note: "merges segments, applies deletes, rebuilds graph" },
          { label: "Object Store", note: "durable snapshot for fast replica catch-up" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "1B vectors × 768-dim × 4B float32 ≈ 3.07TB raw, before graph edges",
          "PQ compression ≈ 32×: ~96GB for codes + ~128GB graph links ≈ 220-300GB resident",
          "~40 shards × ~25M vectors, ~6-8GB/shard, RF=3",
          "efSearch=64 → ~90% recall @ ~5ms; efSearch=128 → ~96% @ ~15ms; efSearch=256 → ~98%+ @ ~30-40ms",
          "10K QPS reads, 5K/s upserts, 2:1 read:write",
          "Freshness: seconds (hot buffer), not minutes (graph build)",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "HNSW graph index, not brute force, LSH, or IVF alone",
          "Product quantization for memory, raw-vector rerank to recover accuracy",
          "Hash-partition shards + scatter-gather reads, not centroid routing",
          "Filter-aware graph traversal, not naive pre/post-filter",
          "LSM-style write path: WAL → hot buffer → async graph build → compaction",
          "Eventual consistency between replicas; WAL is the durability boundary",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Approximate is the premise, not a compromise — quantify the recall/latency tradeoff, don't just say 'it's fast'",
          "Selective metadata filters break naive filtering; name the failure mode with numbers",
          "Live HNSW graph edits under concurrent reads is why writes are LSM-style, not in-place",
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
      goal: "Get the vector count, dimensionality, QPS, write rate, and recall target on the board before drawing anything. Every later decision — shard count, compression ratio, efSearch default — falls out of these numbers.",
      why: "This problem has more load-bearing numbers than most: dimensionality alone swings memory footprint by gigabytes. The interviewer is checking whether you size before you design, and whether you know approximate search means recall is itself a requirement, not an afterthought.",
      steps: [
        { kind: "ASK", text: '**"How many vectors, and what dimensionality?"** Land on "1B vectors, 768-dim" (a common embedding size). Write **"1B × 768-dim"** top-left.' },
        { kind: "ASK", text: '**"What\'s the read and write rate?"** Land on "10K queries/sec, 5K upserts/sec, 2:1". Write it under the vector count.' },
        { kind: "SAY", text: 'Propose the recall/latency budget yourself: **"p99 < 50ms"**, **"recall@10 > 95%"**. Wait for a nod — recall is a real requirement here, not a nice-to-have.' },
        { kind: "SAY", text: 'State scope. In: "ANN search, metadata filtering, the write path, sharding." Out: "generating the embeddings themselves, the ML model serving that produces them." "Let me know if you want me to cover that too." Wait for confirmation.' },
        { kind: "WRITE", text: 'Do the storage math out loud: **"768 dims × 4 bytes = 3,072 bytes/vector"**, **"× 1B = ~3.07TB raw"**. Flag it: "that\'s why compression isn\'t optional here." Write the number down.' },
      ],
      grading: "Are dimensionality and recall target captured as first-class numbers (not just QPS), and is the 3TB raw-storage math done unprompted before any index is proposed?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Three endpoints, one row shape, and the exactness tradeoff named up front.",
      why: "The interviewer wants to see the surface committed to quickly so time goes to the hard parts. Naming 'approximate' as a deliberate choice here, not a limitation you're apologizing for, is a senior signal this early.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /upsert { id, vector[768], metadata }"**, **"POST /query { vector, k, filter?, efSearch? }"** returns **"top-k { id, score, metadata }"**, **"DELETE /vectors/:id"**.' },
        { kind: "DRAW", text: 'Sketch the row: **"id (PK)"**, **"vector (PQ-coded, 768-dim)"**, **"metadata (JSON)"**, **"segment_id"**, **"tombstoned (bool)"**. Say: "vectors are effectively write-once — an update is a delete + reinsert, not an in-place edit."' },
        { kind: "SAY", text: '**"This is approximate, not exact — I\'ll tune for recall@10 above 95% at our latency budget, and there\'s no free lunch to make it 100% without brute force."** Write **"ANN, not exact"** on the board.' },
        { kind: "RULE OUT", text: '"A k-d tree or similar exact index falls apart past a few dozen dimensions — the curse of dimensionality — so exact search at 768-dim means a full scan, not a smarter tree." Cross off exact indexes.' },
      ],
      grading: "Endpoint shapes are crisp, the row model treats vectors as write-once, and the candidate states 'approximate' as a design decision before being asked why results aren't exact.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram, three lanes: read (scatter-gather query), write (upsert), background (index build + compaction). Label edges with shard counts and latency budgets.",
      why: "Drawing background indexing as its own lane, separate from the write path, is the whole signal here — it shows you know a write being acknowledged and a vector being searchable are two different moments, which is the crux of the whole write-path design.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → Query Gateway → fan out to **all ~40 shards** in parallel → each does a local HNSW walk with metadata bitmap filtering → Merge + Rerank → Client. Label **"efSearch=128"**, **"~15ms/shard"**.' },
        { kind: "DRAW", text: 'Add the **write path** as a separate lane: Client → Upsert API → Kafka WAL (ack here) → hot buffer (unindexed, brute-force searchable). Label **"5K/s"**, **"ack on WAL, not on index"**.' },
        { kind: "DRAW", text: 'Add the **background path**, dashed: sealed segment → Index Builder (async HNSW build) → Compactor (merge + apply deletes) → Object Store (snapshot). Label **"never blocks a query"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because acknowledging a write, making it searchable, and making the graph optimal are three different moments — collapsing them into one path is what kills either write throughput or query latency."' },
      ],
      grading: "Three clearly separated lanes, the background/index-build lane drawn as genuinely separate from the write-ack path, and an explicit statement of why they're decoupled.",
    },
    {
      n: 4,
      title: "Deep Dive: Index Choice and Compression",
      minutes: 8,
      goal: "Defend HNSW over brute force, LSH, and IVF, then show product quantization bringing the footprint from 3TB to ~250GB.",
      why: "This is the signature sub-problem. The interviewer is checking that you understand why approximate graph search wins at this scale, and that you can quantify the compression math rather than gesture at 'compress it.'",
      steps: [
        { kind: "SAY", text: '"Brute force is O(n) — seconds per query at 1B, not viable online, though it\'s exactly what I\'d use as the ground truth to measure recall against." Rule it out for the query path.' },
        { kind: "RULE OUT", text: '"LSH needs many hash tables to hit good recall at 768 dimensions and still lags graph methods. IVF alone is fast to build but recall is sensitive to nprobe and cluster-boundary effects." One line each, cross off.' },
        { kind: "SAY", text: '"HNSW: a layered graph, sparse long-range edges at the top for fast traversal, dense local edges at the bottom for precision, greedy best-first search. Best recall-per-millisecond of the options, at the cost of memory."' },
        { kind: "WRITE", text: 'Do the compression math: **"3.07TB raw"** → **"PQ, ~32× → ~96GB codes"** → **"+ ~128GB graph links → ~220-300GB resident, spread across shards."** Say why PQ works: "split the vector into subvectors, replace each with a codebook index — lossy, but reranking on raw vectors afterward recovers accuracy."' },
      ],
      grading: "HNSW explained mechanistically (layers, greedy search), each alternative rejected with a specific reason, and the compression math written out rather than hand-waved.",
    },
    {
      n: 5,
      title: "Deep Dive: Sharding, Filtering, and Freshness",
      minutes: 7,
      goal: "Explain scatter-gather sharding, the metadata-filter failure mode, and the LSM-style write path — the three places this system diverges from a standard sharded database.",
      why: "Each of these is a place where the 'obvious' answer (route by key, AND a WHERE clause, insert directly into the index) quietly breaks. Naming the failure mode before being asked is what separates this from a generic sharded-store answer.",
      steps: [
        { kind: "SAY", text: '"There\'s no partition key for a similarity query — the nearest neighbor could be on any shard — so I hash-partition for even writes and scatter-gather every query across all ~40 shards, merging top-k at a coordinator."' },
        { kind: "SAY", text: '"Naive filtering breaks two ways: post-filter a top-100 fetch against a 1%-selective filter and you get about 1 result, not 100. Pre-filter too aggressively and you can disconnect the graph\'s long-range edges. I\'d use filter-aware traversal that skips non-matching nodes but still walks through them."' },
        { kind: "SAY", text: '"Editing a live HNSW graph under 10K QPS of concurrent reads means lock contention on the write path. So writes go through a WAL, land in an unindexed hot buffer that\'s brute-force searchable in seconds, and the actual graph gets built async on sealed segments — the same shape as an LSM tree."' },
        { kind: "SAY", text: '"Deletes are tombstoned immediately for correctness, physically removed only at compaction — repairing a live graph\'s edges on every delete would be too expensive."' },
      ],
      grading: "All three failure modes (routing, filtering, live-graph writes) are named with their specific breakage, not just their fix, and the LSM parallel is drawn explicitly.",
    },
    {
      n: 6,
      title: "Wrap: Tuning, Consistency, and Close",
      minutes: 5,
      goal: "Name the efSearch tradeoff as a live operational knob, state the consistency model plainly, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal here is treating recall as a dial you turn deliberately per use case, and stating eventual consistency as a considered choice rather than an admission — plus closing cleanly instead of trailing off.",
      steps: [
        { kind: "SAY", text: '"efSearch is the one knob I\'d expose per query — lower for latency-sensitive paths like autocomplete, higher for a one-shot recommendation where a little more latency for more recall is worth it. M and efConstruction are fixed at index build time."' },
        { kind: "SAY", text: '"Consistency is eventual on purpose: a missed recent write just delays a result by a few seconds, it never corrupts state, so quorum reads on every query aren\'t worth paying for. The WAL is the actual durability boundary, not the graph."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need global top-k across the whole billion vectors, or can we scope by tenant/namespace? That changes whether I fan out to all 40 shards or a subset." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a sharded, compressed HNSW graph with an LSM-style write path and filter-aware search. With more time I\'d cover multi-region replication and the embedding-model versioning problem when vectors from two model versions coexist."' },
      ],
      grading: "efSearch framed as an operational lever with a concrete use case, eventual consistency justified rather than confessed, at least one pushback on scope, and a crisp close with parked items.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design with the right named pieces, but treats compression and filtering as details instead of load-bearing decisions.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Names HNSW (or 'an index like FAISS') as the ANN structure when prompted.",
          "Knows to shard the data across multiple machines for a billion vectors.",
          "Proposes a cache or a simple filter step when asked about metadata.",
          "Can write the upsert/query endpoints and a reasonable row shape.",
          "Recognizes the system needs to scale reads and writes differently.",
        ],
        gaps: [
          "Doesn't do the raw-storage math (3TB) or explain why compression is necessary, not optional.",
          "Treats metadata filtering as 'just add a WHERE clause' without the recall failure mode.",
          "Doesn't distinguish between an upsert being acknowledged and a vector being searchable.",
          "No mental model for why editing a live graph under concurrent reads is expensive.",
          "Recall is mentioned only if the interviewer brings it up first.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, quantifies the compression and recall tradeoffs, and names the filtering and write-path failure modes when probed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes vector count, dimensionality, QPS, and recall target on the board within 5 minutes.",
          "Does the storage math (3TB raw → ~250-300GB compressed) unprompted.",
          "Explains why exact search doesn't scale past a few dozen dimensions.",
          "Names the LSM-style write path (WAL, hot buffer, async graph build) with a reason.",
          "Knows post-filter and naive pre-filter both have a specific failure mode.",
          "Distinguishes efSearch (query-time) from M/efConstruction (build-time).",
        ],
        gaps: [
          "States the filtering failure mode only when the interviewer asks 'what if the filter is very selective?'",
          "Mentions eventual consistency but doesn't explain why it's an acceptable choice here specifically.",
          "Doesn't proactively bring up delete/tombstone handling or graph-connectivity risk under aggressive pre-filtering.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats recall as a first-class tunable requirement, and surfaces every place the 'obvious' approach quietly breaks before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Quantifies the post-filter failure mode with actual numbers (1% selectivity on a top-100 fetch returns ~1 result) rather than saying 'recall drops.'",
          "Volunteers that HNSW graph connectivity can break under naive pre-filtering, and proposes filter-aware traversal without prompting.",
          "Explains why replicas rebuild their own HNSW graphs from the WAL rather than replicating graph bytes, citing build-time non-determinism.",
          "Frames efSearch as a per-use-case operational lever (lower for autocomplete, higher for recommendations), not a single global constant.",
          "States explicitly that acknowledging a write, making it searchable, and making the graph optimal are three different moments in the system.",
          "Pushes back on scope ('global top-k across 1B vectors, or scoped by namespace?') and adjusts the fan-out design accordingly.",
          "Closes with a crisp summary and names real unexplored territory (multi-region replication, embedding-model version skew) instead of trailing off.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Proposing an exact index (k-d tree, R-tree) for 768 dimensions without acknowledging the curse of dimensionality makes it a full scan in disguise.",
      "Storing raw float32 vectors at billion-scale with no compression plan, ignoring the ~3TB-before-graph-edges number.",
      "Answering 'combine filters with vector search' as 'just add a WHERE clause' with no discussion of pre- vs post-filter recall collapse.",
      "Inserting directly into a live, shared HNSW graph on every write with no mention of lock contention or an async build path.",
      "Claiming the system has 100% recall — approximate is the entire premise; a candidate who doesn't know that hasn't understood the problem.",
      "No distinction between a write being acknowledged and a vector being searchable, which usually also means no answer for durability on crash.",
      "Chasing strong cross-replica consistency for vector search, paying real latency for a guarantee this workload doesn't need.",
    ],
    followUps: [
      {
        q: "Why HNSW instead of IVF+PQ (the classic FAISS combo), or DiskANN-style disk-resident indexes?",
        a: "IVF+PQ is more memory-efficient and faster to build, but its recall is more sensitive to the nprobe setting and to how well the k-means clusters match the true data distribution, especially near cluster boundaries. HNSW's layered graph gives better recall-per-millisecond at the cost of memory, which is why it's paired with PQ rather than replaced by it — PQ compresses the vectors HNSW stores, it doesn't replace the graph. DiskANN-style indexes (e.g. SPANN, Vamana) spill to SSD and target 10s-of-billions of vectors where nothing fits in RAM even compressed; for 1B vectors, an in-memory HNSW+PQ cluster is still the better latency tradeoff, and disk-resident indexes are the answer once the scale outgrows that.",
      },
      {
        q: "How do you actually measure recall in production, not just at index-build time?",
        a: "Sample a small percentage of live queries, run them against both the approximate index and a brute-force scan (or a slower, higher-efSearch pass) offline, and compute recall@k as the overlap between the two result sets. Track this as a dashboard metric, not a one-time benchmark, because recall silently degrades as the data distribution drifts from what the graph was built on, or as compaction lags and segment count grows. Alert on a sustained drop the same way you'd alert on cache hit rate dropping in a caching system.",
      },
      {
        q: "What happens when you need to change the embedding model — the vectors from model v1 and v2 aren't comparable?",
        a: "You can't mix vectors from two different embedding models in one index — cosine similarity between a v1 and v2 vector is meaningless even if both are 768-dim, because the two models encode meaning into different geometric spaces. The standard approach is a shadow/parallel collection: re-embed the full corpus with the new model into a new collection, run it side by side, validate recall and relevance against the old one, then cut reads over and backfill/retire the old collection. This is expensive (a full re-embedding pass) and worth surfacing as an operational cost of any embedding-based system.",
      },
      {
        q: "How would you support real-time updates to a vector that's already in a compacted, indexed segment?",
        a: "You don't edit the sealed segment in place. A new upsert for an existing id is written to the WAL and lands in the hot buffer like any other write; the old copy in its sealed segment is tombstoned immediately (so a query filters it out even before the buffer version is indexed). The stale copy is physically dropped the next time that segment is compacted. This keeps the write path uniform — every upsert, new or existing id, goes through the same WAL → buffer → async-index flow — at the cost of a query needing to check tombstones and prefer the newest version if both a buffer and a sealed-segment copy exist momentarily.",
      },
      {
        q: "Your recall@10 dashboard shows a sustained drop from 96% to 80%. Walk me through the diagnosis.",
        a: "First check if it's data drift or infrastructure: has query volume or the underlying embedding distribution shifted (new content type, new locale)? If the HNSW graph was built on a different distribution, its long-range edges may no longer connect well to newer regions of the vector space. Second, check segment count and compaction lag — if compaction has fallen behind, an increasing share of vectors are living in the unindexed hot buffer or many small unmerged segments, which changes the effective search behavior. Third, check if efSearch got misconfigured or overridden lower somewhere in the request path. The fix depends on which of the three it is: rebuild/retune the graph for drift, catch up compaction for lag, or fix the config for the third.",
      },
      {
        q: "Why not just use a general-purpose database with a vector extension, like pgvector, instead of a dedicated vector database?",
        a: "pgvector is genuinely a reasonable choice at smaller scale (low millions of vectors, moderate QPS) because you get transactions, joins, and one operational system instead of two. It becomes a poor fit as you approach billion-vector, tens-of-thousands-of-QPS scale: Postgres wasn't built for scatter-gather across dozens of shards, its HNSW implementation shares the same page cache and WAL as the rest of the database (so vector search competes with transactional load for memory and I/O), and it lacks the LSM-style async-build write path that decouples upsert throughput from graph-build cost. The honest answer is scale-dependent: start with pgvector if it fits, migrate to a dedicated system once shard count and QPS make a general-purpose database the bottleneck.",
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
          "This is a memory-bound approximate search structure with a database wrapped around it. The core operation — find the k vectors nearest a query vector, among a billion — has no exact shortcut in high dimensions, so the entire system exists to make 'approximate but fast' honest: quantify how approximate, guarantee how fast, and make sure metadata filters and continuous writes don't quietly break either promise.",
          "Anchor everything on five numbers: 1B vectors, 768 dimensions, 10K queries/sec, 5K upserts/sec, and recall@10 > 95% at p99 < 50ms. Every structural choice below — compression, sharding, the write path, the filtering strategy — is a direct consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing and why compression isn't optional",
        body: [
          "768 dimensions × 4 bytes (float32) = 3,072 bytes per vector; at 1B vectors that's ~3.07TB of raw vector data, before a single graph edge is stored. That number alone rules out storing raw vectors as the resident, searchable format — it has to be compressed.",
          "Product quantization splits each vector into subvectors and replaces each with a 1-byte codebook index, giving roughly 32× compression: ~96GB for 1B vectors. HNSW's own graph links (M=16, roughly 128 bytes/node) add another ~128GB. Total resident footprint lands around 220-300GB, spread across shards — a genuinely different scale of problem than the uncompressed 3TB+.",
        ],
      },
      {
        heading: "HNSW over the alternatives",
        body: [
          "Exact nearest-neighbor structures (k-d trees and relatives) degrade to a full scan once dimensionality passes a few dozen — the 'curse of dimensionality' erases their advantage over brute force. So every practical option here is approximate. Brute force is O(n) and correct, but seconds per query at 1B vectors, unusable online — it survives only as the ground truth for measuring recall. LSH needs many hash tables to reach acceptable recall at 768 dimensions and lags graph methods on both axes.",
          "IVF (k-means clustering, search only the nearest few clusters) is fast to build and memory-light, but recall is sensitive to the nprobe setting and to vectors sitting near a cluster boundary. HNSW — a multi-layer navigable small-world graph, sparse long-range edges up top for fast jumps, dense local edges at the bottom for precision — gets the best recall-per-millisecond of the group, at the cost of memory, which is exactly why it travels paired with product quantization rather than alone.",
        ],
      },
      {
        heading: "Sharding: scatter-gather is the honest cost",
        body: [
          "A vector query has no natural partition key — unlike a primary-key lookup, the nearest neighbor to any given query could live on any shard. So vectors are hash-partitioned across shards for even write distribution, and every query fans out to every shard in parallel (scatter-gather), with each shard returning its local top-k against its own HNSW graph and a coordinator merging and optionally re-ranking the combined candidates.",
          "At ~25M vectors per shard (chosen to keep each shard's graph small enough for fast search and fast rebuild), 1B vectors needs roughly 40 shards. Query latency is bounded by the slowest shard, not the sum of all of them, because the fan-out is parallel — but it does mean 40 network hops per query instead of one, which is the price paid for having no cheaper routing key.",
        ],
      },
      {
        heading: "Filtering, writes, and the two places 'obvious' breaks",
        body: [
          "Metadata filtering is where the naive approach fails in a specific, quantifiable way: post-filtering a fixed top-k fetch starves under a selective filter (1% selectivity on a top-100 fetch returns roughly 1 result), while naive pre-filtering can disconnect the very long-range graph edges HNSW's speed depends on. The fix is filter-aware traversal that walks the full graph but only counts matching nodes as candidates, falling back to a direct brute-force scan when the filtered set is small enough to make that cheaper.",
          "Writes fail the naive approach differently: editing a live, shared HNSW graph under 10K QPS of concurrent reads means lock contention that would tank both read and write performance. The fix, borrowed directly from LSM trees, is a WAL for durability, an unindexed hot buffer for immediate (seconds-level) searchability, and an async graph build on sealed, immutable segments — with a background compactor merging segments and physically applying deletes, which sidesteps the cost of repairing a live graph's edges on every delete.",
        ],
      },
      {
        heading: "Tuning and consistency, stated as decisions",
        body: [
          "efSearch — the candidate list size at query time — is the one knob worth exposing per request: lower for latency-sensitive paths, higher when a little more latency buys meaningfully better recall. M and efConstruction are fixed at build time and shape the graph's baseline quality, not something tuned live. There is no setting that reaches 100% recall short of brute force, and naming that as the deliberate tradeoff — not an apology — is the difference between explaining the system and defending it.",
          "Consistency between replicas is eventual, and that's a considered choice, not a shortfall: a search that misses a vector written moments ago just under-returns briefly, it never corrupts anything, so paying for quorum reads on every one of 10K queries/sec buys nothing the product needs. The WAL is the real durability boundary; the HNSW graph itself is treated as a rebuildable, disposable cache over that log, which is also why replicas build their own graphs independently rather than replicating graph bytes that were never meant to be identical in the first place.",
        ],
      },
    ],
  },
};
