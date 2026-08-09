import type { Problem } from "@/lib/types";

export const ragPlatform: Problem = {
  slug: "rag-platform",
  num: "7.6",
  title: "Design a RAG Platform",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a Retrieval-Augmented Generation (RAG) platform that indexes 50 million source documents (500 million chunks) into a vector store, answers 5,000 natural-language queries/sec with retrieval p99 under 150ms and a grounded, cited response, and keeps the index fresh within 5 minutes of a source document changing — all while controlling the per-query cost of embeddings, reranking, and LLM tokens.",
  ],
  hardParts:
    "The hard parts: keeping hundreds of millions of vectors both fast (approximate nearest neighbor) and relevant (recall) under a strict latency budget, migrating the whole index when you upgrade the embedding model without downtime or comparing incomparable vectors, and fitting only the highest-signal chunks into a bounded LLM context window so the model answers from what retrieval actually found instead of hallucinating around the gaps.",
  keyTopics: [
    "Hybrid Dense + Sparse Retrieval",
    "HNSW / ANN Search at Scale",
    "Cross-Encoder Reranking",
    "Chunking & Context-Budget Management",
    "Embedding Model Version Migration",
  ],
  foundationsReferenced: [
    { label: "HNSW / ANN Search", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Kafka", tone: "orange" },
    { label: "Valkey / Redis", tone: "purple" },
    { label: "Exactly-Once Processing", tone: "orange" },
    { label: "Object Storage (S3)", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client / App", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "API Gateway", sub: "authn/z, rate limit", col: 2, row: 1, tone: "slate" },
      {
        id: "orchestrator",
        label: "Query Orchestrator",
        sub: "stateless · fans out",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "cache", label: "Semantic Cache", sub: "Valkey · ~30% hit", col: 2, row: 2, tone: "green" },
      {
        id: "hybrid",
        label: "Hybrid Retriever",
        mono: "dense + BM25 · RRF fusion",
        col: 3,
        row: 2,
        tone: "green",
      },
      {
        id: "vectordb",
        label: "Vector Index",
        sub: "500M chunks · HNSW, sharded",
        col: 4,
        row: 2,
        tone: "blue",
      },
      { id: "bm25", label: "BM25 / Keyword Index", sub: "OpenSearch", col: 5, row: 2, tone: "blue" },
      {
        id: "reranker",
        label: "Cross-Encoder Reranker",
        sub: "top-200 → top-8",
        col: 3,
        row: 3,
        tone: "purple",
      },
      {
        id: "llm",
        label: "LLM Generator",
        mono: "context ≤ 8K tok · cites chunk IDs",
        col: 4,
        row: 3,
        tone: "purple",
      },
      {
        id: "ingest",
        label: "Ingestion Pipeline",
        mono: "chunk → embed → upsert",
        sub: "Kafka-driven from doc sources",
        col: 2,
        row: 4,
        tone: "orange",
      },
      {
        id: "reembed",
        label: "Reindex / Migration Job",
        sub: "embedding version bump · backfill",
        col: 4,
        row: 4,
        tone: "orange",
      },
    ],
    edges: [
      { from: "client", to: "gateway", kind: "read" },
      { from: "gateway", to: "cache", kind: "read" },
      { from: "cache", to: "client", label: "hit ~30%, skip retrieval+LLM", kind: "read" },
      { from: "cache", to: "orchestrator", label: "miss ~70%", kind: "read" },
      { from: "orchestrator", to: "hybrid", kind: "read" },
      { from: "hybrid", to: "vectordb", label: "ANN top-200", kind: "read" },
      { from: "hybrid", to: "bm25", label: "BM25 top-200", kind: "read" },
      { from: "vectordb", to: "reranker", label: "candidates", kind: "read" },
      { from: "bm25", to: "reranker", label: "candidates", kind: "read" },
      { from: "reranker", to: "llm", label: "top-8 chunks, reordered", kind: "read" },
      { from: "llm", to: "client", label: "streamed, cited answer", kind: "read" },
      { from: "llm", to: "cache", label: "cache answer + query embedding", kind: "write" },
      { from: "ingest", to: "vectordb", label: "upsert vectors, batch", kind: "write" },
      { from: "ingest", to: "bm25", label: "upsert postings", kind: "write" },
      { from: "reembed", to: "vectordb", label: "backfill new embedding version, shadow index", kind: "write" },
    ],
    legend: [
      { kind: "read", text: "read path · 5K queries/s" },
      { kind: "write", text: "write path · ingestion + background reindex" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Ingest documents from heterogeneous sources (wikis, PDFs, tickets, code) and normalize to text", tag: "P0" },
      { id: "FR-02", text: "Chunk documents into retrieval units with configurable size/overlap and structure-aware boundaries", tag: "P0" },
      { id: "FR-03", text: "Generate and store dense vector embeddings for every chunk", tag: "P0" },
      { id: "FR-04", text: "Answer a natural-language query by retrieving relevant chunks and generating a grounded response", tag: "P0" },
      { id: "FR-05", text: "Cite the source chunk(s)/document(s) used for each claim in the answer", tag: "P0" },
      { id: "FR-06", text: "Support hybrid retrieval combining dense vector similarity and keyword (BM25) search", tag: "P0" },
      { id: "FR-07", text: "Re-rank retrieved candidates before passing them to the LLM to fit the context budget", tag: "P1" },
      { id: "FR-08", text: "Detect and reprocess updated/deleted source documents (incremental reindexing)", tag: "P0" },
      { id: "FR-09", text: "Filter retrieval results by access control so a user only sees chunks they're authorized to read", tag: "P1" },
      { id: "FR-10", text: "Support multi-turn conversations with retrieval conditioned on chat history", tag: "P1" },
      { id: "FR-11", text: "Capture user feedback (thumbs up/down, corrections) to improve ranking over time", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Retrieval latency: query embed + ANN + rerank, server-side", tag: "p99 < 150ms" },
      { id: "NFR-02", text: "End-to-end time-to-first-token (retrieval + generation start)", tag: "p99 < 1.5s" },
      { id: "NFR-03", text: "Sustained query throughput, globally", tag: "5K/sec" },
      { id: "NFR-04", text: "Retrieval recall@50 against a labeled evaluation set", tag: "> 95%" },
      { id: "NFR-05", text: "Ingestion throughput, steady state", tag: "2M docs/day" },
      { id: "NFR-06", text: "Index freshness: time from document update to queryable", tag: "< 5 min" },
      { id: "NFR-07", text: "Availability (query path)", tag: "99.95%" },
      { id: "NFR-08", text: "Cost ceiling: embeddings + rerank + LLM tokens per 1K queries", tag: "< $3/1K q" },
      { id: "NFR-09", text: "Read-to-write ratio that anchors caching and index design", tag: "~200:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: what does 500M vectors actually cost?",
      body: [
        "Before picking an index type, prove the memory bill out loud. 50M documents chunked at ~10 chunks/doc gives 500M chunks. Each chunk is embedded into a 1536-dimension vector (a common size for production embedding models) stored as 4-byte floats: 1536 × 4 bytes = 6KB per vector, so 500M vectors is 3TB of raw vector data before you've stored a single graph edge.",
        "HNSW (Hierarchical Navigable Small World), the standard in-memory ANN graph, adds roughly its own weight again in link pointers, so a naive fp32 HNSW index lands near 6TB — a number that forces the conversation about quantization before you draw a single box.",
      ],
      bullets: [
        { lead: "Raw vectors", text: "1536-dim × fp32 = 6KB/vector × 500M = 3TB, before any index structure." },
        { lead: "HNSW graph overhead", text: "each node keeps links at multiple layers (M=16 neighbors is typical); roughly doubles memory to ~6TB naive." },
        { lead: "Scalar (int8) quantization", text: "cuts each dimension to 1 byte instead of 4 — a 4× reduction, down to ~1.5TB — for roughly 1-2% recall loss, which is the standard trade production systems take." },
        { lead: "Product quantization (PQ)", text: "compresses further (8-16× vs fp32) for even larger corpora, at a steeper recall cost; worth it past low-billions of vectors, overkill at 500M." },
      ],
      pictureTitle: "Sizing 500M vectors",
      pictureCaption: "500M chunks × 1536-dim → 3TB raw · int8 quantized + HNSW lands at ~1.5TB",
      pictureRows: [
        { label: "fp32 vectors, no graph", value: "3TB raw", tone: "neutral" },
        { label: "+ HNSW graph links (M=16)", value: "~6TB naive", tone: "bad" },
        { label: "int8 quantized + HNSW", value: "~1.5TB, ~98-99% recall retained", tone: "good" },
      ],
      remember: {
        problem: "500M embeddings at fp32 plus a graph index is too large and expensive to serve at 5K QPS.",
        solution: "int8 scalar-quantize every vector before indexing; keep fp32 only in the durable source-of-truth store.",
        why: "Quantization cuts the hot-path memory footprint ~4× with a small, measurable recall hit, which is what makes an in-memory HNSW tier affordable.",
        tradeoff: "You trade a couple points of recall for 4× less RAM and a materially cheaper cluster.",
        failure: "Serving fp32 HNSW at this scale means ~6TB of RAM across shards, which is both expensive and slow to rebuild.",
        mitigation: "Quantize for serving, keep fp32 vectors in object storage so you can re-quantize or re-rank precisely when needed.",
      },
    },
    {
      n: 2,
      title: "Chunking: the retrieval-quality lever, not a formatting detail",
      body: [
        "How you cut a document into chunks determines what can ever be retrieved — a fact split across a chunk boundary is a fact the retriever can't find. The tradeoff space is between chunk size (too small loses context, too large dilutes the embedding and blows the context budget) and boundary alignment (cutting mid-sentence vs. cutting on a structural boundary like a heading or paragraph).",
      ],
      bullets: [
        { lead: "Fixed-size, no overlap (512 tokens)", text: "simplest to build and fastest to embed, but slices sentences and facts in half at every boundary. Rejected as the default." },
        { lead: "Fixed-size + overlap (512 tok, ~15% overlap)", text: "the overlap means a fact split at one boundary usually survives whole in the neighboring chunk, at ~15% more storage and embedding cost. Reasonable baseline." },
        { lead: "Semantic chunking", text: "split on meaning shifts (embedding-similarity dips between sentences) rather than token count; highest retrieval precision, but chunk sizes become uneven and it costs an extra embedding pass just to find the boundaries." },
        { lead: "Structure-aware chunking", text: "split on document structure that's already there — markdown headers, paragraph breaks, table boundaries, code blocks — with overlap inside long sections. Cheap to compute (no extra model call) and respects the author's own logical units. Winner for a heterogeneous corpus." },
      ],
      pictureTitle: "Chunking: kill the naive default, keep structure-aware",
      pictureRows: [
        { label: "Fixed-size, no overlap", value: "cuts facts at boundaries → reject as default", tone: "bad" },
        { label: "Fixed-size + overlap", value: "safe baseline, ~15% storage cost", tone: "neutral" },
        { label: "Semantic chunking", value: "best precision, extra model pass, uneven sizes", tone: "neutral" },
        { label: "Structure-aware + overlap", value: "cheap, respects doc structure → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Choose a chunk boundary strategy that maximizes what retrieval can actually find.",
        solution: "Structure-aware chunking (headers/paragraphs/code blocks) with ~15% overlap inside long sections.",
        why: "A chunk boundary is a retrieval boundary; aligning it with the author's own structure keeps facts intact without an extra embedding pass.",
        tradeoff: "Uneven chunk sizes complicate context-budget math versus a uniform fixed-size scheme.",
        failure: "Naive fixed-size chunking with no overlap silently drops recall on any fact that happens to straddle a cut.",
        mitigation: "Overlap plus periodic recall@k evaluation against a labeled query set to catch boundary losses early.",
      },
    },
    {
      n: 3,
      title: "ANN indexing: HNSW vs IVF-PQ, and how to shard 500M vectors",
      body: [
        "Exact nearest-neighbor search over 500M vectors is a linear scan — far too slow for a 150ms budget — so every production vector search is approximate (ANN), trading a small amount of recall for orders of magnitude more speed. Two index families dominate: HNSW, a navigable graph you walk greedily toward the query; and IVF-PQ, which clusters vectors into buckets (inverted file, IVF) and compresses each vector (product quantization, PQ) so you only score a compressed, relevant subset.",
        "HNSW gives the best recall/latency curve but lives in RAM and its graph doesn't shrink much. IVF-PQ trades some recall for far less memory and a tunable knob (nprobe: how many buckets to search) — the right choice once a single HNSW graph stops fitting in one node's RAM. At 500M vectors, quantized HNSW sharded across nodes is the common answer; IVF-PQ becomes attractive past low billions.",
      ],
      bullets: [
        { lead: "HNSW", text: "graph-based, greedy best-first search; excellent recall at low latency, but memory-hungry and the whole graph should stay in RAM." },
        { lead: "IVF-PQ", text: "cluster-then-compress; much smaller memory footprint, tunable via nprobe, but a coarser recall/latency tradeoff than HNSW at the same memory budget." },
        { lead: "Sharding", text: "partition the 500M chunks across N shards by consistent hashing on doc id (so a doc's chunks colocate for easy re-embedding), each shard runs its own HNSW graph." },
        { lead: "Scatter-gather", text: "a query fans out to every shard in parallel, each returns its local top-K, and the orchestrator merges to a global top-K — the merge step is why an unbalanced shard becomes a tail-latency problem, not just a capacity one." },
      ],
      pictureTitle: "HNSW vs IVF-PQ",
      pictureRows: [
        { label: "HNSW", value: "best recall/latency, RAM-bound", tone: "good" },
        { label: "IVF-PQ", value: "smaller footprint, tunable via nprobe", tone: "neutral" },
        { label: "Sharded, quantized HNSW at 500M", value: "the pragmatic default here", tone: "good" },
      ],
      remember: {
        problem: "Search 500M vectors under a 150ms p99 budget without a linear scan.",
        solution: "Shard by consistent hashing on doc id, run quantized HNSW per shard, scatter-gather with a top-K merge.",
        why: "ANN trades exactness for speed; sharding is what lets the graph fit in RAM per node while staying horizontally scalable.",
        tradeoff: "Scatter-gather means the query's tail latency is the slowest shard's tail latency, not the average.",
        failure: "An unbalanced shard (a hot doc-id range) becomes a straggler that blows the whole query's p99.",
        mitigation: "Hash on doc id for even spread, monitor per-shard latency, and rebalance or split hot shards proactively.",
      },
    },
    {
      n: 4,
      title: "Hybrid retrieval: why dense alone loses on exact matches",
      body: [
        "Dense vector search is excellent at semantic paraphrase — 'how do I reset my password' matches a chunk titled 'account recovery steps' even with zero shared words. But embeddings blur exact tokens: a part number, an error code, or a rare acronym often doesn't stand out in a 1536-dim vector the way it stands out to a keyword index. BM25 (a classic term-frequency ranking function) nails exact and rare-term matches but misses semantic paraphrase entirely.",
        "Run both retrievers in parallel against the same query and fuse their rankings with Reciprocal Rank Fusion (RRF) — a simple, weight-free formula that rewards a chunk appearing near the top of either list, without needing to calibrate BM25 scores against cosine-similarity scores (which live on different scales and can't be compared directly).",
      ],
      bullets: [
        { lead: "Dense-only failure", text: "a query containing an exact error code (\"ERR_502_TIMEOUT\") can retrieve semantically-similar-but-wrong chunks while missing the one chunk that contains the literal string." },
        { lead: "BM25-only failure", text: "misses a paraphrased query entirely if it shares no vocabulary with the relevant chunk." },
        { lead: "RRF fusion", text: "score = sum of 1/(k + rank) across both lists; a chunk ranked #2 by BM25 and #40 by dense still surfaces near the top of the fused list." },
        { lead: "Why not calibrate and sum scores directly", text: "BM25 scores are unbounded and corpus-dependent; cosine similarity is bounded [-1,1]. Rank-based fusion sidesteps having to normalize two incompatible scales." },
      ],
      pictureTitle: "Dense vs. sparse: what each one misses",
      pictureRows: [
        { label: "Dense only", value: "misses exact codes/IDs/rare terms", tone: "bad" },
        { label: "BM25 only", value: "misses semantic paraphrase", tone: "bad" },
        { label: "Hybrid + RRF fusion", value: "covers both failure modes", tone: "good" },
      ],
      remember: {
        problem: "Neither pure vector search nor pure keyword search covers every query type.",
        solution: "Run dense ANN and BM25 in parallel, fuse with Reciprocal Rank Fusion.",
        why: "The two retrievers have complementary, non-overlapping failure modes — paraphrase vs. exact match.",
        tradeoff: "Two retrieval calls and a fusion step instead of one, adding latency and infra you must run in parallel to hide it.",
        failure: "Vector-only retrieval silently fails on part numbers, error codes, and acronyms with no warning in the answer.",
        mitigation: "Always retrieve hybrid; use rank fusion (RRF) instead of trying to calibrate two incomparable score scales.",
      },
    },
    {
      n: 5,
      title: "Reranking and the context budget: from 200 candidates to 8",
      body: [
        "Initial retrieval (ANN + BM25) is optimized to be cheap and wide: a bi-encoder embeds the query and each chunk independently, so similarity is just a dot product — fast enough to score millions of candidates, at the cost of some accuracy. A cross-encoder reranker instead feeds the query and a candidate chunk into the model together, letting it attend across both — far more accurate, but too slow to run on more than a few hundred candidates.",
        "So the funnel is deliberate: retrieve wide and cheap (top-200 from hybrid fusion), rerank narrow and precise (cross-encoder scores all 200, keep top-8), then fit those into the LLM's context window. An 8K-token budget with ~512-token chunks leaves room for maybe 8 chunks plus the prompt and chat history — which is exactly why the funnel has to end there, not at 50 or 100.",
      ],
      bullets: [
        { lead: "Bi-encoder (retrieval)", text: "query and chunk embedded independently; similarity is a cheap dot product, scores millions of candidates in milliseconds." },
        { lead: "Cross-encoder (rerank)", text: "query+chunk encoded jointly with full attention; far more accurate at judging true relevance, but O(candidates) full forward passes, so it only runs on the narrowed set." },
        { lead: "MMR (Maximal Marginal Relevance)", text: "after reranking, dedupe near-identical chunks (e.g., three chunks from the same paragraph) so the 8 slots cover distinct information instead of redundant restatements." },
        { lead: "Context budget math", text: "8K tokens − prompt scaffolding − chat history leaves room for roughly 8 chunks at ~512 tokens each; this number, not a preference, is what caps the funnel at top-8." },
      ],
      pictureTitle: "The retrieval funnel",
      pictureRows: [
        { label: "Hybrid retrieval", value: "top-200 candidates, cheap bi-encoder scoring", tone: "neutral" },
        { label: "Cross-encoder rerank", value: "top-200 → top-8, expensive but accurate", tone: "good" },
        { label: "MMR dedup", value: "8 distinct chunks, not 8 near-duplicates", tone: "good" },
        { label: "LLM context", value: "~8K tokens: 8 chunks + prompt + history", tone: "neutral" },
      ],
      remember: {
        problem: "Get the highest-signal chunks into a bounded LLM context without an expensive full-corpus rerank.",
        solution: "Wide cheap retrieval (top-200) → narrow expensive cross-encoder rerank (top-8) → MMR dedup.",
        why: "Cross-encoders are far more accurate than bi-encoders but too slow to run on more than a few hundred candidates.",
        tradeoff: "Reranking adds a serial hop to the latency budget in exchange for materially better precision at the LLM's input.",
        failure: "Skipping rerank and feeding raw ANN top-8 into the LLM lets marginal, near-duplicate chunks crowd out better ones.",
        mitigation: "Fixed funnel shape (200 → rerank → 8 → MMR) sized against the measured context-token budget, not guessed.",
      },
    },
    {
      n: 6,
      title: "Freshness vs. migration: two very different reindex problems",
      body: [
        "There are two kinds of 'the index needs to change,' and conflating them causes outages. Freshness is routine: a document is edited, its changed chunks get re-embedded and upserted in place, done in minutes via a Kafka-driven pipeline — an incremental, always-on process. Migration is rare and dangerous: upgrading the embedding model itself, because vectors from two different model versions are not comparable — cosine similarity between an old-model vector and a new-model vector is meaningless, so you cannot upsert new-model vectors into an index that's half old-model.",
        "The fix is a shadow index: re-embed the entire 500M-chunk corpus with the new model into a fresh index built alongside the live one, evaluate it against a labeled query set, and only then blue-green cutover traffic — the same pattern as any other model-version rollout, just applied to a search index instead of a service.",
      ],
      bullets: [
        { lead: "Freshness (routine)", text: "doc changes → Kafka event → re-chunk and re-embed only the changed chunks → upsert in place. Minutes, always-on, no downtime." },
        { lead: "Migration (rare)", text: "embedding model upgrade → the whole corpus must be re-embedded, because old and new vectors live in different, incomparable spaces." },
        { lead: "Shadow index", text: "build the fully re-embedded index in the background while the old one keeps serving; this can take hours to days for 500M chunks depending on embedding throughput." },
        { lead: "Blue-green cutover", text: "flip query traffic only after the shadow index clears the recall@50/nDCG bar on a labeled eval set — never cut over on faith." },
      ],
      pictureTitle: "Freshness vs. migration",
      pictureRows: [
        { label: "Doc edited", value: "incremental re-embed, upsert in place, minutes", tone: "good" },
        { label: "Embedding model upgraded", value: "full corpus re-embed, shadow index required", tone: "neutral" },
        { label: "Mixing old/new vectors in one index", value: "similarity scores become meaningless", tone: "bad" },
      ],
      remember: {
        problem: "An embedding model upgrade can't be applied in place like a normal document edit.",
        solution: "Build a full shadow index with the new model, evaluate it offline, then blue-green cutover.",
        why: "Vectors from two embedding model versions are not comparable in the same similarity space.",
        tradeoff: "Migration needs 2× index capacity temporarily and hours-to-days of re-embed time before every cutover.",
        failure: "Upserting new-model vectors into a live old-model index silently corrupts every similarity score in that index.",
        mitigation: "Treat freshness and migration as two pipelines with two SLAs; never let a model upgrade touch the live index directly.",
      },
    },
    {
      n: 7,
      title: "Grounding: making the LLM answer only from what retrieval found",
      body: [
        "A RAG system's whole value proposition collapses if the LLM answers from its own parametric memory instead of the retrieved chunks — that's just a chatbot with extra latency. The prompt has to constrain the model explicitly: answer only using the provided chunks, cite the chunk ID for every claim, and say so explicitly when the retrieved context doesn't contain the answer instead of filling the gap.",
        "The other half is knowing when not to answer at all. Log the reranker's top score for every query; below a calibrated confidence threshold (or on an empty candidate set), return a refusal or an escalation to a human instead of letting the LLM improvise around a weak retrieval result.",
      ],
      bullets: [
        { lead: "Constrained prompting", text: "system prompt explicitly instructs: use only the provided chunks, cite chunk IDs inline, and state 'not found in the provided context' rather than guess." },
        { lead: "Citations as an audit trail", text: "every claim maps back to a chunk ID, so a wrong answer is debuggable — is it a retrieval miss or a generation error — instead of an opaque failure." },
        { lead: "Confidence threshold", text: "log the top reranker score per query; below the calibrated bar, refuse or route to a human rather than answer on thin evidence." },
        { lead: "Feedback as a training signal", text: "thumbs up/down and corrections feed back into reranker fine-tuning and threshold calibration over time, not just a dashboard metric." },
      ],
      pictureTitle: "When retrieval is weak, don't let the LLM guess",
      pictureRows: [
        { label: "Strong retrieval, high rerank score", value: "answer with citations", tone: "good" },
        { label: "Weak retrieval, low rerank score", value: "refuse / escalate, don't guess", tone: "neutral" },
        { label: "No citation constraint in prompt", value: "LLM fills gaps from parametric memory", tone: "bad" },
      ],
      remember: {
        problem: "Prevent the LLM from answering from its own memory instead of the retrieved chunks.",
        solution: "Constrained citation-required prompting plus a confidence-threshold refusal path below a calibrated rerank score.",
        why: "Grounding only works if the model is structurally forced to use retrieval output and admit when that output is insufficient.",
        tradeoff: "The system will sometimes refuse to answer a question it could have guessed correctly, trading coverage for trust.",
        failure: "An unconstrained prompt lets the LLM confidently answer from parametric knowledge, silently defeating the point of RAG.",
        mitigation: "Cite chunk IDs on every claim, log rerank confidence, and route low-confidence queries to a refusal or human review.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a retrieval funnel feeding a constrained generator: hybrid search casts a wide, cheap net, a reranker narrows it to the highest-signal chunks, and the LLM is forced to answer only from those chunks and cite them.",
      "Chunking is a retrieval-quality decision, not formatting — structure-aware chunks with overlap are what let facts survive a boundary cut.",
      "Dense and sparse retrieval fail on opposite query types (paraphrase vs. exact match), so they run in parallel and get fused with RRF, not chosen between.",
      "Vectors from two embedding model versions can't be compared, so a model upgrade needs a full shadow-index rebuild and a blue-green cutover, never an in-place patch.",
      "Freshness (doc edited) and migration (model upgraded) are two different pipelines with two different SLAs — don't let a model upgrade touch the live index directly.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 5K/S · RETRIEVAL P99 < 150MS",
        summary:
          "A query checks the semantic cache first. On a miss it fans out to dense and sparse retrieval in parallel, fuses and reranks the candidates, then the LLM answers only from the narrowed, cited chunk set.",
        steps: [
          { label: "Client", note: "sends a natural-language question" },
          { label: "API Gateway", note: "authn/z, rate limit" },
          { label: "Semantic Cache (Valkey)", note: "~30% hit on near-duplicate queries" },
          { label: "Query Orchestrator", note: "embeds the query, fans out" },
          { label: "Hybrid Retriever", note: "dense ANN top-200 + BM25 top-200 in parallel" },
          { label: "Vector Index / BM25 Index", note: "sharded HNSW + OpenSearch" },
          { label: "Cross-Encoder Reranker", note: "top-200 → top-8" },
          { label: "LLM Generator", note: "streams a cited answer from top-8 chunks only" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · INGESTION · 2M DOCS/DAY",
        summary:
          "Every new or changed document is chunked, embedded, and upserted into both indexes. This path never touches the query path — it runs entirely off the read hot path.",
        steps: [
          { label: "Content Sources", note: "docs, wikis, tickets, code changes" },
          { label: "Kafka", note: "doc-change event" },
          { label: "Ingestion Pipeline", note: "structure-aware chunking, ~15% overlap" },
          { label: "Embedding Service", note: "batch-embeds new/changed chunks" },
          { label: "Vector Index upsert", note: "HNSW insert, sharded by doc-id hash" },
          { label: "BM25 Index upsert", note: "postings update" },
        ],
      },
      {
        kind: "analytics",
        title: "BACKGROUND · REINDEX & EVAL",
        summary:
          "Upgrading the embedding model needs a full parallel rebuild, not an in-place patch, because vectors from two model versions aren't comparable. Evaluation runs continuously against a labeled query set before any cutover.",
        steps: [
          { label: "Trigger", note: "new embedding model approved" },
          { label: "Shadow Index", note: "re-embeds all 500M chunks, built alongside the live index" },
          { label: "Offline Eval", note: "recall@50 / nDCG against a labeled query set" },
          { label: "Blue-Green Cutover", note: "traffic flips only once the shadow index clears the bar" },
          { label: "Feedback Loop", note: "thumbs up/down and corrections logged for rerank training" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "50M docs → 500M chunks (~10/doc), 1536-dim embeddings, 6KB/vector raw",
          "int8-quantized HNSW index: ~1.5TB across shards (vs ~6TB naive fp32+graph)",
          "5K queries/sec, retrieval p99 < 150ms, time-to-first-token p99 < 1.5s",
          "Ingestion: 2M docs/day steady state, index freshness < 5 min after a doc changes",
          "Retrieval funnel: hybrid top-200 → cross-encoder rerank → top-8 into context",
          "Context budget: ~8K tokens, so ~8 chunks of ~512 tokens plus prompt + history",
          "Recall@50 target > 95% against a labeled eval set",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Hybrid dense+BM25 retrieval fused with Reciprocal Rank Fusion, not vector-only",
          "Sharded, int8-quantized HNSW for the live index (not IVF-PQ, at this scale)",
          "Structure-aware chunking (headers/paragraphs/code blocks) with ~15% overlap",
          "Cross-encoder reranker narrows top-200 → top-8; MMR for diversity/dedup",
          "Shadow index + blue-green cutover for every embedding-model version migration",
          "Vector shards partitioned by consistent hashing on doc id, scatter-gather fan-out",
          "Refuse to answer below a calibrated retrieval-confidence threshold",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Can't mix vectors from two embedding model versions in one index — similarity isn't comparable across models",
          "Reranking is the expensive step (full cross-attention) — only run it on a narrowed candidate set",
          "Chunking is a retrieval-quality lever, not a formatting detail — boundary cuts silently kill recall",
          "Cite chunk IDs in every answer and log rerank scores so grounding is auditable, not just plausible",
          "Freshness (minutes, incremental) and migration (hours-days, full rebuild) are two different pipelines",
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
      goal: "Nail down the corpus size, query volume, and the latency budget before drawing anything — every later index and chunking decision falls out of these numbers.",
      why: "The interviewer is checking whether you drive a RAG design from concrete numbers instead of jumping straight to 'use a vector database.' Corpus size decides quantization, query volume decides sharding, and the latency budget decides how deep the retrieval funnel can go.",
      steps: [
        { kind: "ASK", text: '**"How big is the corpus, and how often does it change?"** Land on "50M documents", "500M chunks", "2M docs/day ingested". Write **"50M docs, 500M chunks, 2M/day"** in the top-left corner.' },
        { kind: "ASK", text: 'Next: **"What\'s the query volume and latency budget?"** Land on "5K queries/sec", "retrieval p99 < 150ms", "time-to-first-token < 1.5s". Write it under the corpus line.' },
        { kind: "SAY", text: 'Propose the freshness SLA yourself: **"index freshness under 5 minutes after a doc changes"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "chunking", "hybrid retrieval", "reranking", "grounded generation with citations", "embedding-model migration". Out: "auth/authz internals", "LLM fine-tuning", "UI". "Let me know if you\'d like me to come back to any of those." Wait for confirmation.' },
        { kind: "WRITE", text: 'Do the vector-storage math out loud: **"500M chunks × 1536-dim × 4 bytes = 3TB raw"**, **"HNSW graph roughly doubles it to ~6TB naive"**, **"int8 quantization brings it to ~1.5TB"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are you writing corpus size, QPS, and latency budget on the board, parking out-of-scope items deliberately, and doing the storage math before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two endpoints, one chunk schema, and the context-budget math justified up front.",
      why: "The interviewer wants to see you commit to a small surface and defend the chunk schema, since chunk metadata (doc id, offsets, embedding version) is what makes both filtering and reindexing possible later.",
      steps: [
        { kind: "WRITE", text: 'Write the two endpoints: **"POST /documents { source, content }"** triggers ingestion, returns **"{ docId, status }"**. **"POST /query { question, history? }"** returns **"{ answer, citations[] }"**, streamed.' },
        { kind: "DRAW", text: 'Sketch the chunk row: **"chunk_id (PK)"**, **"doc_id"**, **"text"**, **"embedding (vector, versioned)"**, **"embedding_model_version"**, **"offset/section"**, **"acl_tags"**. Say it out loud: "The embedding_model_version field is what makes migration safe — I can filter or route by it."' },
        { kind: "SAY", text: 'Justify the context budget: **"~8K token context, ~512 tokens/chunk, so top-8 chunks after rerank plus prompt and history."** Write **"8K ctx ≈ 8 chunks"** on the board.' },
        { kind: "RULE OUT", text: 'Get ahead of the obvious alternative: "Storing raw text only and embedding at query time is too slow — embedding 500M chunks live isn\'t feasible; embeddings must be precomputed and stored." Cross it off.' },
      ],
      grading: "Crisp endpoint names, a chunk schema that includes embedding version and ACL tags, and bringing the context-budget math forward unprompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the read, write, and background lanes)",
      minutes: 8,
      goal: "One diagram with three labeled lanes: query/read, ingestion/write, and background reindex. Label the arrows with candidate counts and latency budgets, not just box names.",
      why: "Drawing these as separate lanes proves you understand they have different SLAs and failure domains. Candidates who draw one blob miss that a model migration must never touch the live query path directly.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → Gateway → Semantic Cache → Query Orchestrator → Hybrid Retriever → (Vector Index + BM25 Index) → Reranker → LLM → Client. Label arrows **"~30% cache hit"**, **"top-200 each"**, **"top-8 after rerank"**.' },
        { kind: "DRAW", text: 'Add the **write/ingestion lane**: Content Sources → Kafka → Ingestion Pipeline → Embedding Service → upserts into Vector Index + BM25 Index. Label **"2M docs/day"**, **"< 5 min freshness"**.' },
        { kind: "DRAW", text: 'Add the **background reindex lane**: Reembed Job → builds a full Shadow Index → Offline Eval → Blue-Green Cutover. Label it **"only on embedding-model upgrade, never in-place"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different failure domains — a slow ingest never touches query latency, and a migration never touches the live index until it passes eval."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with candidate counts and latency, and an explicit statement that migration goes through a shadow index, never in place.",
    },
    {
      n: 4,
      title: "Deep Dive: Chunking and Hybrid Retrieval",
      minutes: 8,
      goal: "Defend the chunking strategy and explain why dense-only retrieval isn't enough, with RRF as the fusion mechanism.",
      why: "This is the first signature sub-problem: the interviewer is probing whether you see chunking as a retrieval-quality decision and whether you know dense and sparse retrieval fail on opposite query types.",
      steps: [
        { kind: "SAY", text: '"I\'m chunking on document structure — headers, paragraphs, code blocks — with about 15% overlap, not fixed-size cuts. A fixed cut with no overlap silently drops recall on any fact that straddles the boundary."' },
        { kind: "SAY", text: '"Dense vector search misses exact matches — an error code or part number often doesn\'t stand out in a 1536-dim embedding the way it does to a keyword index. BM25 catches those but misses paraphrase entirely."' },
        { kind: "DRAW", text: 'Draw the two retrievers running in parallel into a fusion step: "Reciprocal Rank Fusion — score = sum of 1/(k + rank) across both lists. It sidesteps having to normalize BM25 and cosine scores, which live on different scales."' },
        { kind: "RULE OUT", text: '"Dense-only" → misses exact/rare terms. "BM25-only" → misses paraphrase. "Score-averaging without rank fusion" → the two score scales aren\'t comparable, so a naive weighted sum is unprincipled.' },
      ],
      grading: "Chunking framed as a retrieval-quality decision, both retriever failure modes named concretely, and RRF explained as a rank-based (not score-based) fusion without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: ANN Index, Reranking, and the Context Budget",
      minutes: 8,
      goal: "Walk the HNSW sharding story and the retrieval funnel (200 → rerank → 8), tying the funnel width to the measured context budget.",
      why: "The interviewer wants to see the funnel shape justified by numbers — why 200, why top-8 — not just 'we rerank.' The best candidates connect the funnel end directly to the token-budget math from phase 2.",
      steps: [
        { kind: "SAY", text: '"500M vectors, sharded by consistent hashing on doc id, each shard runs a quantized HNSW graph. A query scatter-gathers to every shard and I merge local top-Ks into a global top-K."' },
        { kind: "SAY", text: '"HNSW gives the best recall/latency curve but is RAM-bound; if this were low billions of vectors I\'d lean toward IVF-PQ instead for the smaller footprint."' },
        { kind: "SAY", text: '"Retrieval is cheap and wide — bi-encoder dot product over 200 candidates. Reranking is a cross-encoder, full attention over query+chunk together, far more accurate but too slow past a few hundred candidates, so it only runs on the narrowed 200."' },
        { kind: "SAY", text: '"The funnel ends at top-8 because that\'s what the 8K-token context budget actually holds — 8 chunks at ~512 tokens plus prompt and history. I also run MMR after rerank so those 8 aren\'t near-duplicates of each other."' },
      ],
      grading: "Sharding and scatter-gather explained with a merge step, HNSW vs IVF-PQ tradeoff named, and the top-8 cutoff explicitly tied to the token-budget math rather than an arbitrary number.",
    },
    {
      n: 6,
      title: "Wrap: Freshness vs. Migration, Grounding, and Close",
      minutes: 6,
      goal: "Distinguish freshness from migration, explain grounding and the refusal path, then close with a one-sentence summary and parked items.",
      why: "Staff-level signal here is knowing that a model upgrade is not just a bigger version of a routine doc edit, and that a RAG system's credibility depends on refusing to answer when retrieval is weak.",
      steps: [
        { kind: "SAY", text: '"Freshness and migration are different pipelines. A doc edit re-embeds just the changed chunks and upserts in place, done in minutes. An embedding-model upgrade needs a full shadow index — old and new vectors aren\'t comparable in the same space — evaluated offline, then blue-green cut over."' },
        { kind: "SAY", text: '"Grounding: the prompt requires the model to answer only from the provided chunks and cite chunk IDs. Below a calibrated rerank-confidence threshold, or on an empty candidate set, I refuse or escalate rather than let it guess."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need 5K QPS globally or per region? That changes the shard count and cache sizing." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a hybrid retrieval funnel feeding a constrained, cited generator, with a shadow-index path for safe embedding-model migrations. With more time I\'d cover per-user ACL filtering, multi-turn query rewriting, and the feedback-driven rerank fine-tuning loop."' },
      ],
      grading: "Freshness vs. migration stated as two distinct SLAs, the refusal/confidence-threshold path named unprompted, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working retrieve-then-generate pipeline, but the retrieval quality decisions and cost/latency tradeoffs stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right pieces: chunker, embedding model, vector database, LLM.",
          "Knows to chunk documents before embedding and can explain why (context window limits).",
          "Picks a vector database (Pinecone, pgvector, etc.) when prompted and knows it does similarity search.",
          "Can write the ingest and query endpoints and a basic chunk schema.",
          "Handles 'the answer is wrong' by suggesting 'add more data' or 'use a bigger model'.",
        ],
        gaps: [
          "Doesn't do the vector-storage math out loud, or just says 'store it in a vector DB'.",
          "Treats retrieval as a single vector search with no hybrid/keyword fallback.",
          "No reranking step — feeds raw top-K ANN results straight to the LLM.",
          "No plan for what happens when the embedding model changes.",
          "No grounding/citation mechanism — assumes the LLM 'just answers from context'.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks defaults with reasons, names trade-offs when asked, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes corpus size, QPS, and latency targets on the board within the first 5 minutes.",
          "Chooses structure-aware chunking with overlap and can defend it against naive fixed-size.",
          "Runs hybrid dense+BM25 retrieval and can explain RRF fusion without prompting.",
          "Adds a cross-encoder reranking stage and explains why it can't run on the full candidate set.",
          "Sizes the vector index (quantization math) and picks HNSW with a sharding plan.",
          "Requires citations in the generation prompt.",
        ],
        gaps: [
          "Names the embedding-model migration problem only when asked, doesn't volunteer the shadow-index pattern.",
          "Doesn't quantify the context-budget math (why top-8, not top-20) unless pressed.",
          "Mentions 'the LLM might hallucinate' but has no concrete refusal/confidence-threshold mechanism.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces risks before being asked, and brings operational maturity beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers that embedding-model versions are incomparable and the migration needs a full shadow index plus offline eval before any cutover, unprompted.",
          "Ties the retrieval funnel width (top-200 → top-8) directly to the measured context-token budget, not a rule of thumb.",
          "Distinguishes freshness (routine, minutes) from migration (rare, hours-to-days) as two pipelines with two SLAs.",
          "Builds a concrete grounding mechanism: citations plus a calibrated confidence-threshold refusal path, not just 'the prompt says to cite sources'.",
          "Quantifies dense-vs-sparse failure modes with concrete examples (error codes, part numbers) instead of saying 'hybrid is better'.",
          "Pushes back on requirements where appropriate ('do we need 5K QPS globally or per region?').",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Storing raw fp32 vectors with no discussion of quantization, then being surprised the index doesn't fit in memory at 500M vectors.",
      "Treating the vector database as the only retrieval mechanism with no keyword/BM25 fallback for exact-match queries.",
      "Feeding raw top-K ANN results straight into the LLM with no reranking stage.",
      "Upserting new-model embeddings directly into a live index during an embedding-model upgrade instead of building a shadow index.",
      "No citation or confidence-threshold mechanism, so the LLM silently answers from parametric memory when retrieval is weak.",
      "No chunking strategy discussion — treats chunk size as an arbitrary constant with no boundary or overlap reasoning.",
      "Designing with no capacity numbers, so index size, shard count, and context-budget width all become guesses instead of consequences of scale.",
    ],
    followUps: [
      {
        q: "Why not just increase the LLM's context window instead of retrieving a narrow top-8?",
        a: "Even with a large context window, stuffing in hundreds of chunks degrades answer quality — models attend unevenly across a long context (the 'lost in the middle' effect), and every extra token adds latency and cost linearly. Reranking to a small, high-precision set produces both a faster and a more accurate answer than a longer, noisier one; a bigger window relaxes the budget but doesn't remove the need to rank.",
      },
      {
        q: "How do you handle access control so a user doesn't see chunks they're not authorized for?",
        a: "Tag every chunk with ACL metadata at ingestion (which teams/roles can see the source document) and apply it as a pre-filter inside the ANN search itself, not as a post-filter after retrieval — filtering after the top-K is chosen can return fewer than K authorized results, or none, if the top matches all belong to restricted docs. Most vector databases support metadata filtering integrated into the graph traversal for exactly this reason.",
      },
      {
        q: "What happens if the reranker becomes the latency bottleneck?",
        a: "Cross-encoder rerank cost scales with candidate count, so the first lever is narrowing the funnel going in — better initial ranking (tuned RRF weights, a lighter first-pass filter) means fewer candidates need full reranking. The second lever is a smaller, distilled cross-encoder model that trades a little accuracy for latency. Batching rerank calls across concurrent queries on GPU also helps significantly at 5K QPS.",
      },
      {
        q: "How would you evaluate retrieval quality before shipping a change?",
        a: "Maintain a labeled evaluation set of (query, relevant chunk ids) pairs, ideally sourced from real user queries with human-graded relevance. Track recall@k (did the relevant chunk appear in the top-k) and nDCG (how well-ranked was it) as the core metrics, run them offline against any index or model change, and require the new version to meet or beat the baseline before it's eligible for a blue-green cutover.",
      },
      {
        q: "What's the failure mode if the semantic cache serves a stale answer?",
        a: "The cache should key on the embedded query plus the current embedding-model/index version, so a reindex or migration naturally invalidates it. For fast-changing sources, cap the cache TTL well under the freshness SLA (well under 5 minutes) so a stale answer self-heals quickly, and treat the cache as an optimization, never a source of truth — a cache miss must always fall through to live retrieval, not to a default answer.",
      },
      {
        q: "Why RRF for fusion instead of training a learned fusion model?",
        a: "RRF is weight-free and works well out of the box because it only needs rank position, not calibrated scores, so it's robust to corpus and query-distribution shift with zero training data. A learned fusion model (or learned-to-rank layer) can outperform RRF once you have enough labeled relevance data and a stable query distribution, but it's a v2 optimization — RRF is the right default to ship first and iterate from.",
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
          "This is a retrieval funnel feeding a constrained generator. The core operation — turn a natural-language question into a grounded, cited answer — depends on narrowing 500M chunks down to the roughly 8 that actually matter, and then structurally forcing the LLM to answer from only those 8.",
          "Anchor everything on five numbers: 500M chunks, 5K queries/sec, retrieval p99 < 150ms, an 8K-token context budget, and a < 5-minute freshness SLA. Every structural choice below — chunking, hybrid retrieval, reranking, the shadow-index migration pattern — is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing and chunking",
        body: [
          "50M documents at ~10 chunks/doc gives 500M chunks; each 1536-dim embedding is 6KB at fp32, so 3TB raw before any index structure, ~6TB with a naive HNSW graph, and ~1.5TB once int8-quantized. That quantization decision is what makes an in-memory, low-latency index affordable at this scale.",
          "Chunking is a retrieval-quality decision: structure-aware boundaries (headers, paragraphs, code blocks) with ~15% overlap keep facts intact across cuts far more cheaply than semantic chunking, which requires an extra embedding pass just to find the boundaries.",
        ],
      },
      {
        heading: "Hybrid retrieval and why one retriever isn't enough",
        body: [
          "Dense vector search excels at paraphrase but blurs exact tokens — an error code or rare acronym can get lost in a 1536-dim embedding. BM25 nails exact and rare-term matches but misses semantic paraphrase entirely. Running both in parallel and fusing with Reciprocal Rank Fusion (score = sum of 1/(k+rank) across both lists) covers both failure modes without needing to calibrate two incomparable score scales.",
          "Vectors are sharded across nodes by consistent hashing on doc id, each shard runs its own quantized HNSW graph, and a query scatter-gathers to every shard before merging to a global top-K — which is why an unbalanced shard becomes a tail-latency problem, not just a capacity one.",
        ],
      },
      {
        heading: "Reranking and the context budget",
        body: [
          "The funnel is deliberately shaped: a cheap bi-encoder scores hundreds of candidates in milliseconds (dot product), while an expensive cross-encoder — jointly attending over query and chunk — reranks only the narrowed top-200 down to a top-8. The cutoff at 8 isn't arbitrary: an ~8K-token context budget at ~512 tokens/chunk leaves room for roughly 8 chunks alongside the prompt and chat history.",
          "MMR (Maximal Marginal Relevance) runs after reranking to dedupe near-identical chunks, so the 8 context slots cover distinct information rather than three restatements of the same paragraph.",
        ],
      },
      {
        heading: "Freshness vs. migration",
        body: [
          "Two very different reindex problems live under 'the index needs to change.' Freshness is routine: a doc edit triggers a Kafka event, only the changed chunks get re-chunked and re-embedded, and the upsert lands in minutes. Migration is rare and dangerous: an embedding-model upgrade means the entire corpus must be re-embedded, because vectors from two different model versions are not comparable — cosine similarity between them is meaningless.",
          "The fix is a shadow index: re-embed all 500M chunks with the new model in the background, evaluate recall@50/nDCG against a labeled query set, and only blue-green cutover once the shadow index clears the bar. Conflating this with routine freshness — upserting new-model vectors into a live old-model index — silently corrupts every similarity score in that index.",
        ],
      },
      {
        heading: "Grounding and the refusal path",
        body: [
          "A RAG system's entire value proposition depends on the LLM answering from retrieved chunks, not its own parametric memory. The prompt constrains this explicitly — answer only from the provided chunks, cite the chunk ID for every claim, and state when the context doesn't contain the answer rather than guess.",
          "The other half is a confidence threshold: log the reranker's top score per query, and below a calibrated bar (or on an empty candidate set), refuse or escalate instead of letting the LLM improvise. User feedback (thumbs up/down, corrections) feeds back into both threshold calibration and future reranker fine-tuning.",
        ],
      },
    ],
  },
};
