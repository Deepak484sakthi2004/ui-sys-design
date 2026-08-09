import type { Problem } from "@/lib/types";

export const newsFeed: Problem = {
  slug: "news-feed",
  num: "6.2",
  title: "Design a News Feed / Timeline",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a news feed / timeline like Twitter/X, Instagram, or Facebook: 500M daily active users compose and consume posts, publishing about 300M posts/day (roughly 3.5K writes/sec on average, bursting past 10K/sec during live events), while the home timeline is read about 150 times more often than it's written, roughly 300K reads/sec globally, and a freshly published post needs to reach most followers within seconds — from accounts with a handful of followers up to celebrities with 100M+.",
  ],
  hardParts:
    "The hard parts: fanning a single post out to millions of followers without the write path collapsing (the celebrity problem), keeping a materialized-but-stale timeline cache correct as likes, edits, and deletes land after fan-out has already happened, and ranking each user's feed by relevance without adding seconds of latency to a scroll.",
  keyTopics: [
    "Fan-out on Write vs Fan-out on Read",
    "Hybrid Fan-out (The Celebrity Problem)",
    "Redis Sorted Sets as Materialized Timelines",
    "ML Feed Ranking (Multi-Signal Scoring)",
    "Social Graph as a First-Class Store",
  ],
  foundationsReferenced: [
    { label: "Redis / Valkey", tone: "purple" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Kafka / Message Queues", tone: "orange" },
    { label: "Cassandra / Wide-Column Stores", tone: "blue" },
    { label: "Publish-Subscribe", tone: "orange" },
    { label: "CDN & Object Storage", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "author", label: "Author", col: 1, row: 1, tone: "slate" },
      { id: "postsvc", label: "Post Service", sub: "stateless writes", col: 2, row: 1, tone: "green" },
      { id: "postdb", label: "Post Store", sub: "Cassandra · wide-column", col: 3, row: 1, tone: "blue" },
      { id: "mediastore", label: "Media Store", sub: "S3 + CDN", col: 4, row: 1, tone: "blue" },
      { id: "graphdb", label: "Social Graph", sub: "follower / following edges", col: 5, row: 1, tone: "blue" },
      { id: "fanoutq", label: "Fan-out Queue", sub: "Kafka", col: 2, row: 2, tone: "orange" },
      {
        id: "fanoutworker",
        label: "Fan-out Worker",
        sub: "push to followers' timelines",
        col: 3,
        row: 2,
        tone: "orange",
      },
      {
        id: "timelinecache",
        label: "Timeline Cache",
        sub: "Redis ZSET · ~800 ids/user",
        col: 4,
        row: 2,
        tone: "green",
      },
      { id: "reader", label: "Reader", col: 1, row: 3, tone: "slate" },
      {
        id: "feedsvc",
        label: "Feed Service",
        sub: "merges push + pull, hydrates",
        col: 2,
        row: 3,
        tone: "purple",
      },
      { id: "ranker", label: "Ranking Service", sub: "re-score & blend", col: 3, row: 3, tone: "purple" },
    ],
    edges: [
      { from: "author", to: "postsvc", label: "compose post", kind: "write" },
      { from: "postsvc", to: "postdb", label: "persist post", kind: "write" },
      { from: "postsvc", to: "mediastore", label: "media upload", kind: "write" },
      { from: "postsvc", to: "graphdb", label: "follower-count check", kind: "write" },
      { from: "postsvc", to: "fanoutq", label: "async · only if < 10K followers", kind: "analytics" },
      { from: "fanoutq", to: "fanoutworker", kind: "analytics" },
      { from: "fanoutworker", to: "graphdb", label: "resolve follower ids · paginated", kind: "analytics" },
      { from: "fanoutworker", to: "timelinecache", label: "push post_id · O(followers)", kind: "analytics" },
      { from: "reader", to: "feedsvc", kind: "read" },
      { from: "feedsvc", to: "timelinecache", label: "pre-computed timeline", kind: "read" },
      { from: "feedsvc", to: "graphdb", label: "which celebrities do I follow", kind: "read" },
      { from: "feedsvc", to: "postdb", label: "pull celebrity posts · merge", kind: "read" },
      { from: "feedsvc", to: "ranker", label: "re-score & blend", kind: "read" },
    ],
    legend: [
      { kind: "read", text: "read path · ~300K feed loads/s, merges push + pull" },
      { kind: "write", text: "write path · ~3.5K posts/s avg, 10K/s peak" },
      { kind: "analytics", text: "fan-out · async, off the post path, push to followers' timelines" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Publish a post (text, image, video) so it can appear in followers' feeds", tag: "P0" },
      { id: "FR-02", text: "Retrieve a user's home timeline, paginated and ranked", tag: "P0" },
      { id: "FR-03", text: "Follow / unfollow a user; the feed reflects graph changes going forward", tag: "P0" },
      { id: "FR-04", text: "Deliver a new post to followers within seconds of publish", tag: "P0" },
      { id: "FR-05", text: "Support celebrity / high-fan-out accounts (10M+ followers) without degrading the write path", tag: "P0" },
      { id: "FR-06", text: "Rank the feed using engagement signals (recency, affinity, predicted engagement)", tag: "P1" },
      { id: "FR-07", text: "Like / comment / share a post, reflected for every future viewer", tag: "P1" },
      { id: "FR-08", text: "Delete or edit a post, with the change visible everywhere it was delivered", tag: "P1" },
      { id: "FR-09", text: "Cursor-based pagination that stays stable while new posts keep arriving", tag: "P1" },
      { id: "FR-10", text: "Mute / block a user removes their posts from the feed", tag: "P2" },
      { id: "FR-11", text: "Insert sponsored posts into the ranked feed", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Feed read latency, server-side", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "Post write / fan-out initiation latency", tag: "p99 < 500ms" },
      { id: "NFR-03", text: "Feed read throughput, sustained globally", tag: "300K/sec" },
      { id: "NFR-04", text: "Post write throughput, sustained (peak burst 10K/sec)", tag: "3.5K/sec" },
      { id: "NFR-05", text: "Availability (about 52 min downtime per year)", tag: "99.99%" },
      { id: "NFR-06", text: "Fan-out completion for non-celebrity posts, 99% of followers", tag: "< 5s" },
      { id: "NFR-07", text: "Durability: no data loss for published posts", tag: "zero loss" },
      { id: "NFR-08", text: "Read-to-write ratio that anchors the whole design", tag: "150:1" },
      { id: "NFR-09", text: "Follower-count threshold before falling back to pull-on-read", tag: "10K followers" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: the two numbers that drive everything",
      body: [
        "Before picking a fan-out strategy, put five numbers on the board: 500M DAU, ~300M posts/day, ~300K feed reads/sec, and a 150:1 read-to-write ratio. That ratio is the whole ballgame — it says the system must be optimized for reads even though the expensive work (fan-out) happens on write, because writes are 150x rarer than reads.",
        "The other number that matters just as much is the shape of the follower graph. It is not uniform — it is power-law. A median user has a couple hundred followers, but the tail runs to accounts with 10M, even 100M followers. A design that only works for the median user breaks catastrophically on that tail, which is exactly what the rest of this system is built around.",
      ],
      bullets: [
        { lead: "500M DAU, ~300M posts/day", text: "→ ~3.5K writes/sec average, bursting past 10K/sec during live events and launches." },
        { lead: "150:1 read:write ratio", text: "the home timeline is read far more than posts are made, so almost the entire latency budget belongs to reads." },
        { lead: "Follower distribution is power-law", text: "median ~200 followers, 99.9th percentile in the tens of millions — that tail is what breaks a naive design." },
      ],
      pictureTitle: "The two numbers that drive everything",
      pictureRows: [
        { label: "Posts/day ≈ 300M (~3.5K/s avg, 10K/s peak)", value: "write path", tone: "neutral" },
        { label: "Feed reads ≈ 300K/s (150:1 ratio)", value: "read path — optimize this first", tone: "good" },
        { label: "Follower distribution: power-law tail to 100M+", value: "breaks naive fan-out", tone: "bad" },
      ],
      remember: {
        problem: "How big is this system, really?",
        solution: "500M DAU, 300M posts/day (~3.5K/s avg, 10K/s peak), ~300K feed reads/sec, a 150:1 read:write ratio.",
        why: "Every later decision — cache sizing, fan-out strategy, ranking budget — is a consequence of these numbers, not a guess.",
        tradeoff: "Optimizing for the 150:1 ratio means the read path gets almost the entire latency budget; the write path is allowed to be asynchronous.",
        failure: "Design without naming the ratio and you can't defend why fan-out is async or why the feed is cache-first.",
        mitigation: "Put the numbers on the board first, in the first five minutes, before drawing any boxes.",
      },
    },
    {
      n: 2,
      title: "Fan-out on write vs fan-out on read: kill neither, understand both",
      body: [
        "There are two ways to answer 'what's in my feed?' Fan-out on write (push): when a post is created, immediately write its ID into every follower's precomputed timeline, so reading is just fetching one list. Fan-out on read (pull): write nothing at post time; when a user opens their feed, live-merge posts from everyone they follow.",
        "Push spends write-time work to make reads cheap: O(1) read, but O(followers) write. Pull spends read-time work to make writes cheap: O(1) write, but O(following) read, paid on every single scroll refresh. Given the 150:1 ratio, push wins for typical accounts — it optimizes the operation that happens 150x more often. But push cost scales with follower count, so it collapses precisely on the power-law tail this system has to serve.",
      ],
      bullets: [
        { lead: "Push (fan-out on write)", text: "O(1) read, O(followers) write. A 200-follower post costs 200 cache writes — cheap." },
        { lead: "Pull (fan-out on read)", text: "O(1) write, O(following) read — every feed load merges up to hundreds of lists, and reads are the frequent operation." },
        { lead: "Neither wins alone", text: "push optimizes the far more frequent operation for typical users, but a celebrity with 50M followers turns one post into 50M writes." },
      ],
      pictureTitle: "Push vs pull, at typical scale",
      pictureRows: [
        { label: "Push", value: "O(1) read · O(followers) write", tone: "good" },
        { label: "Pull", value: "O(1) write · O(following) read, every scroll", tone: "bad" },
        { label: "200 followers, push cost", value: "200 cache writes per post — cheap", tone: "good" },
        { label: "50M followers, push cost", value: "50M cache writes for ONE post — breaks", tone: "bad" },
      ],
      remember: {
        problem: "Should a post be delivered at write time or assembled at read time?",
        solution: "Neither alone: push for typical accounts, pull for the celebrity tail — a hybrid, covered next.",
        why: "Reads outnumber writes 150:1, so push wins for normal accounts by making reads O(1); but push cost is O(followers), so it collapses for millions of followers.",
        tradeoff: "Push spends write-time work to buy cheap reads; pull spends read-time work to buy cheap writes — pick per-account, not globally.",
        failure: "Pure push: one celebrity post triggers tens of millions of fan-out writes and can take hours to land. Pure pull: every read merges hundreds of lists, blowing the p99 budget.",
        mitigation: "Threshold on follower count decides push vs pull per account.",
      },
    },
    {
      n: 3,
      title: "The celebrity problem and the hybrid threshold",
      body: [
        "The fix is a threshold, commonly around 10K followers. Below it: fan out on write as normal — the post ID gets pushed into every follower's cached timeline. At or above it: skip fan-out entirely. The post is written once, marked pull-only, and the feed service fetches it directly from the post store at read time for anyone who follows that account, merging it with their precomputed timeline.",
        "This bounds the worst case: publishing costs O(1) no matter how many followers an account has. The cost shifts to reads, but only for the (small) set of readers who follow celebrities, and even then it's bounded by how many celebrities a person follows — usually tens, never millions.",
      ],
      bullets: [
        { lead: "< 10K followers", text: "push at publish time, O(followers) write, O(1) read." },
        { lead: "≥ 10K followers (celebrity)", text: "no push, O(1) write, pulled from the post store and merged on read." },
        { lead: "Reader follows 3 celebrities", text: "means merging 3 live pulls with 1 cached list per feed load — bounded, cheap." },
        { lead: "Real systems do exactly this", text: "the threshold is tunable, and some systems combine follower count with post velocity so a suddenly-viral small account doesn't blow up the queue either." },
      ],
      pictureTitle: "Hybrid fan-out: who gets pushed, who gets pulled",
      pictureRows: [
        { label: "< 10K followers", value: "push at publish, O(followers) write, O(1) read", tone: "good" },
        { label: "≥ 10K followers", value: "no push, O(1) write, pulled + merged on read", tone: "neutral" },
        { label: "Reader follows 3 celebrities", value: "merge 3 live pulls + 1 cached list per load", tone: "good" },
        { label: "No threshold at all", value: "one viral post = tens of millions of writes", tone: "bad" },
      ],
      remember: {
        problem: "A single post from a 50M-follower account must not create 50M synchronous writes.",
        solution: "Hybrid fan-out: push below a follower-count threshold (~10K), pull-and-merge above it.",
        why: "Bounds the worst-case write cost to O(1) regardless of follower count, shifting cost to reads — but only for the small set of readers who follow that celebrity.",
        tradeoff: "Feed reads for celebrity-followers do a bit more work (merge a few live pulls) in exchange for publish latency that never depends on follower count.",
        failure: "No threshold: fan-out workers queue tens of millions of jobs per celebrity post, and followers see a stale feed for hours during a live event.",
        mitigation: "Tune the threshold from the follower-count distribution; combine with post velocity so a suddenly-viral small account is also protected.",
      },
    },
    {
      n: 4,
      title: "The timeline cache: IDs, not content",
      body: [
        "The materialized timeline is a Redis sorted set per user: key is the user, member is a post ID, score is a rank or timestamp. Sorted sets give O(log n) inserts and native range queries, exactly what pagination needs. Crucially, it holds only the most recent ~800 post IDs, not the user's whole history — a home feed almost never scrolls back further, so this turns an unbounded structure into a fixed-size one.",
        "Just as important: the timeline stores IDs and a score, never full post content. Content lives in a separate post cache, fetched by ID in one batched 'hydrate' call per feed page. That keeps fan-out writes tiny (an ID, not a payload) and keeps memory bounded: 500M users × 800 IDs × ~50 bytes ≈ 20TB across the cluster, sharded by user ID so a whole timeline lives on one partition.",
      ],
      bullets: [
        { lead: "Sorted set, not a list", text: "ZADD with score = timestamp/rank gives O(log n) insert and native range queries (ZREVRANGE) for pagination and trimming." },
        { lead: "Bounded to ~800 IDs", text: "matches production systems; caps memory per user instead of letting history grow forever." },
        { lead: "IDs, not full posts", text: "content is hydrated from a separate, shared cache in one batched call, so a fan-out write is a handful of bytes." },
        { lead: "Sharded by user, not post", text: "a user's whole timeline lives on one shard, so building the feed is one request, not scatter-gather." },
      ],
      pictureTitle: "What lives in the timeline cache?",
      pictureRows: [
        { label: "user:timeline (Redis ZSET)", value: "~800 post_ids, score = rank/timestamp", tone: "good" },
        { label: "post_id → content cache", value: "separate hydrate step, batched GET", tone: "neutral" },
        { label: "500M users × 800 IDs × ~50B", value: "~20TB across the cluster", tone: "used" },
        { label: "Unbounded history per user", value: "memory grows forever — rejected", tone: "bad" },
      ],
      remember: {
        problem: "Serve a paginated home feed in a single low-latency read.",
        solution: "A Redis sorted set per user holding ~800 post IDs (score = rank/time), with a separate batched hydrate step for full content.",
        why: "ZSETs give O(log n) insert and native range queries for pagination; storing IDs not content keeps fan-out writes tiny and caps memory at a known bound.",
        tradeoff: "You give up 'infinite scrollback' in the fast path — going past ~800 posts falls back to a slower cold path.",
        failure: "Store full post content per timeline entry and 500M users × 800 posts multiplies into an unaffordable, mostly-duplicated cache.",
        mitigation: "IDs in the timeline ZSET, content in a shared post cache, hydrated in one batched call per feed page.",
      },
    },
    {
      n: 5,
      title: "Ranking: a re-rank, not a search",
      body: [
        "Once fan-out or pull has produced a candidate set (the ~800 cached IDs plus any celebrity pulls), ranking only has to re-sort that small, already-bounded list — it never searches the whole corpus. That reframing is what keeps ranking cheap enough to sit on the critical read path.",
        "The score itself blends recency decay, affinity (how often this viewer engages with this author), and a predicted-engagement probability from a lightweight model. Heavy features (learned embeddings) are precomputed offline and just looked up; only fast, cheap features (recent engagement velocity) are computed inline. The ranked page is then cached briefly so a pull-to-refresh doesn't re-rank from scratch.",
      ],
      bullets: [
        { lead: "Candidate generation is already done", text: "fan-out/pull produced maybe a few hundred candidates; ranking only re-sorts that set." },
        { lead: "Multi-signal score", text: "blend recency decay, affinity, predicted engagement, and content-type/diversity boosts into one score per candidate." },
        { lead: "Feature freshness vs latency", text: "real-time signals come from a fast counter store; heavy learned features are precomputed offline and looked up, not computed inline." },
        { lead: "Cache the ranked page", text: "rank once, cache the ordered page for a short TTL, and splice in new/high-score posts instead of a full recompute." },
      ],
      pictureTitle: "Ranking is a re-rank, not a search",
      pictureRows: [
        { label: "Candidate set", value: "~few hundred posts from cache + celebrity pulls", tone: "good" },
        { label: "Score = f(recency, affinity, predicted engagement)", value: "model lookup, not training, on the request path", tone: "neutral" },
        { label: "Rank the whole corpus per request", value: "too slow — never do this", tone: "bad" },
        { label: "Cache the ranked page briefly", value: "avoids re-ranking on every pull-to-refresh", tone: "good" },
      ],
      remember: {
        problem: "Order the feed by relevance without adding seconds to a scroll.",
        solution: "Re-rank the small candidate set already produced by fan-out/pull, using precomputed features and a lightweight model lookup, then cache the ordered page briefly.",
        why: "Candidate generation already bounded the problem to a few hundred posts; ranking is cheap once you don't re-derive candidates or recompute heavy features inline.",
        tradeoff: "Slightly stale features (offline embeddings) and a short-TTL ranked-page cache trade perfect freshness for a latency budget that fits a scroll.",
        failure: "Score the entire post corpus per request, or compute heavy ML features inline, and feed-load latency blows past the read budget.",
        mitigation: "Keep candidate generation and ranking as two separate, bounded stages; precompute what you can offline.",
      },
    },
    {
      n: 6,
      title: "Consistency after the fact: likes, edits, and deletes",
      body: [
        "A post that has already been fanned out into millions of caches can't have its downstream engagement (likes, comments) or its content re-pushed every time something changes — that would be a fan-out of its own, at a far higher rate than posts themselves. The fix follows directly from teardown 4: since timelines store only IDs, anything else is read live at hydrate time.",
        "Likes and comment counts are fetched fresh from a counter service at hydrate time, so they're always correct without ever touching the millions of cached timeline entries that reference that post. An edit is just an updated row in the post store, visible immediately everywhere because content is read live, not cached in the timeline. A delete tombstones the post; the hydrate step silently filters out any ID that resolves to a tombstone, instead of hunting that ID down across every timeline it was ever pushed into.",
      ],
      bullets: [
        { lead: "Timeline stores IDs, not counts", text: "likes/comments/shares are fetched fresh at hydrate time, so engagement numbers are correct without touching millions of cached entries." },
        { lead: "Deletes are filtered, not hunted down", text: "tombstone the post in the post store; hydrate silently drops any ID that resolves to a tombstone." },
        { lead: "Edits are just a live read", text: "content is hydrated from the post store on every read, so an edit is visible everywhere immediately, no fan-out needed." },
        { lead: "This is why IDs-not-content was the right call", text: "if timelines stored full content, every edit or like would need its own fan-out at a much higher rate than posts." },
      ],
      pictureTitle: "What needs fan-out again, and what doesn't",
      pictureRows: [
        { label: "New post", value: "fans out (push) or gets pulled — teardown 3", tone: "neutral" },
        { label: "Like/comment count changes", value: "never fanned out, read live at hydrate", tone: "good" },
        { label: "Edited post text", value: "never fanned out, read live at hydrate", tone: "good" },
        { label: "Deleted post", value: "tombstoned, silently filtered at hydrate, not scrubbed from timelines", tone: "good" },
      ],
      remember: {
        problem: "Likes, edits, and deletes happen after a post is already fanned out into millions of caches.",
        solution: "Store only IDs in timelines; hydrate content, counts, and tombstone status live at read time.",
        why: "Anything read live at hydrate time never needs propagation — only the post ID itself was ever fanned out.",
        tradeoff: "Every feed page pays a hydrate/lookup cost at read time instead of a write-time propagation cost.",
        failure: "Cache full content or counts in the timeline entry, and every like or edit needs a fan-out of its own, at a much higher rate than posts.",
        mitigation: "Keep the timeline cache to IDs and a rank score only; treat hydrate as the single point where truth is read.",
      },
    },
    {
      n: 7,
      title: "The social graph is its own service",
      body: [
        "Follower/following edges get queried constantly: on every post (to decide push vs pull and to get the follower list), on every feed pull (which celebrities does this reader follow), and on their own product surfaces (follower lists, suggestions). That query pattern earns the graph its own sharded, wide-column store rather than living inside the user table.",
        "Model it as an adjacency list — user_id maps to a list of follower_ids, and the reverse for following_ids — sharded by user_id so a typical user's full graph lives on one partition. The one wrinkle is the power-law tail: a celebrity's follower row can have 100M+ entries, far too large to read or iterate in one shot, so the fan-out worker (and anything else touching that row) must paginate it in bounded batches rather than ever loading it whole.",
      ],
      bullets: [
        { lead: "Adjacency list, wide-column", text: "user_id → {followers: [...]}, and the reverse — a wide-column store gives an efficient 'list everyone who follows X' for the fan-out worker." },
        { lead: "Sharded by user_id", text: "keeps a normal user's full follower/following list on one partition, so 'who does this person follow' is a single read." },
        { lead: "Wide-row problem for celebrities", text: "a 100M-follower row can't be read in one shot; even the rare push case for such a row is paginated in batches, e.g. 10K at a time." },
        { lead: "Two write patterns", text: "follow/unfollow is low volume and can afford stronger consistency; the graph is read constantly, so it's cached far more heavily than it's written." },
      ],
      pictureTitle: "The social graph is its own service",
      pictureRows: [
        { label: "~500M users × ~200 following avg", value: "~100B edges, power-law skew", tone: "used" },
        { label: "Normal user's follower list", value: "single-partition read", tone: "good" },
        { label: "Celebrity's 100M-row follower list", value: "paginated in batches, never loaded whole", tone: "neutral" },
        { label: "Follow / unfollow", value: "low volume, can afford quorum writes", tone: "good" },
      ],
      remember: {
        problem: "Answer 'who follows X' and 'who does Y follow' at social-network scale, fast, for both fan-out and feed reads.",
        solution: "A sharded wide-column adjacency list (user_id → follower/following ids), with celebrity rows paginated rather than loaded whole.",
        why: "Sharding by user_id keeps a typical user's edges on one partition; wide-row pagination is what keeps the power-law tail from blowing up memory.",
        tradeoff: "Two directions to maintain (followers and following) means a follow/unfollow is two writes, not one.",
        failure: "Try to load a celebrity's 100M-entry follower row in one query and you OOM the node serving that partition.",
        mitigation: "Always paginate wide rows in bounded batches; treat 'get all followers' as a stream, never a single read.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a fan-out problem wearing a feed's clothes: getting one post in front of the right people fast, without one popular account melting the write path.",
      "Hybrid fan-out is the core idea: push to followers' precomputed timelines for typical accounts, pull-and-merge at read time for celebrities.",
      "Timelines store post IDs, not content, in a bounded Redis sorted set (~800 entries); content, likes, and deletes are always read live so they never need re-propagating.",
      "Ranking is a cheap re-rank of a small, already-bounded candidate set, not a search over the whole corpus.",
      "The whole design optimizes reads over writes, because feed reads outnumber posts roughly 150 to 1.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · ~300K/S · SUB-200MS P99",
        summary:
          "A feed load merges the reader's precomputed timeline with any celebrities they follow, re-ranks the bounded candidate set, and hydrates content in one batched call.",
        steps: [
          { label: "Reader", note: "opens the app / pulls to refresh" },
          { label: "Feed Service", note: "orchestrates the merge" },
          { label: "Timeline Cache", note: "~800 pre-computed post IDs, Redis ZSET" },
          { label: "Social Graph", note: "which celebrities does this reader follow" },
          { label: "Post Store", note: "pull each celebrity's recent posts" },
          { label: "Ranking Service", note: "re-score & blend the bounded candidate set" },
          { label: "hydrate", note: "batched content/count fetch, tombstones filtered" },
          { label: "Ranked page", note: "returned to client" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · ~3.5K/S AVG, 10K/S PEAK",
        summary:
          "A post is written once; the fan-out decision branches on follower count, but the author's request never waits on delivery to followers.",
        steps: [
          { label: "Author", note: "submits text / media" },
          { label: "Post Service", note: "stateless" },
          { label: "Post Store", note: "insert, source of truth" },
          { label: "Media Store", note: "S3 + CDN, async upload" },
          { label: "Social Graph", note: "follower-count check decides push vs pull-only" },
          { label: "Response", note: "returned immediately, before fan-out completes" },
        ],
      },
      {
        kind: "analytics",
        title: "FAN-OUT · ASYNC, OFF THE POST PATH",
        summary:
          "Fan-out never blocks the post write; a worker pool drains the queue and pushes IDs into each follower's timeline at whatever pace the cluster can sustain.",
        steps: [
          { label: "Post Service", note: "enqueues a fan-out job, only if followers < 10K" },
          { label: "Fan-out Queue", note: "Kafka" },
          { label: "Fan-out Worker pool", note: "drains the queue" },
          { label: "Social Graph", note: "resolve follower ids, paginated batches" },
          { label: "Timeline Cache", note: "ZADD post_id into each follower's ZSET" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "500M DAU, 300M posts/day (~3.5K/s avg, 10K/s peak)",
          "~300K feed reads/sec, 150:1 read:write ratio",
          "Celebrity threshold: ~10K followers decides push vs pull",
          "Timeline cache: ~800 post IDs/user, ~20TB across the Redis cluster",
          "Social graph: ~100B follow edges, power-law tail to 100M+ followers",
          "p99 feed load < 200ms; fan-out completes for 99% of followers < 5s",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Hybrid fan-out: push below the follower threshold, pull-and-merge above it",
          "Timeline cache stores post IDs + rank score, never full content",
          "Likes/comments/edits read live at hydrate time, never fanned out",
          "Deletes are tombstoned and filtered at hydrate, not scrubbed from every timeline",
          "Ranking re-scores the bounded candidate set only, features precomputed offline",
          "Social graph sharded by user_id; celebrity rows paginated, never loaded whole",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The celebrity problem is the load-bearing risk — name the threshold and the pull-merge fallback unprompted",
          "150:1 read:write ratio is why the whole system is cache-first and fan-out is async",
          "IDs-not-content in the timeline cache is what makes deletes/edits/likes cheap",
          "Fan-out is best-effort/tier-2; post write and feed read are tier-1",
          "Wide-row pagination for celebrity follower lists — never load 100M rows in one shot",
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
      goal: "Get five numbers and three product decisions on the board before drawing anything, so the interviewer confirms scope out loud and nothing surprises you later.",
      why: "Numbers are not trivia here. The interviewer is checking whether you drive the design from data. Cache sizing, the fan-out threshold, and the ranking budget all fall out of these numbers, so locking them first is what separates an engineer from someone guessing.",
      steps: [
        { kind: "ASK", text: '**Is this read-heavy or write-heavy?** Walk them to "~300M posts/day", "~300K feed reads/sec", "150:1 ratio". Write **"3.5K w/s avg, 300K r/s, 150:1"** in the top-left corner of the board.' },
        { kind: "ASK", text: 'Next ask: **"How many users, and what does the follower distribution look like?"** Land on "500M DAU" and "power-law tail to 100M+ followers". Write **"500M DAU, power-law tail to 100M followers"** underneath.' },
        { kind: "SAY", text: 'Propose the latency targets yourself: **"sub-200ms p99 on a feed load"**, **"99% of followers see a normal post within 5s"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "post creation", "fan-out", "home timeline read", "ranking", "the social graph". Out: "search", "DMs", "stories/ephemeral content", "ads targeting". "Let me know if you\'d like me to come back to any of those." Wait for confirmation.' },
        { kind: "WRITE", text: 'Do the storage math out loud: **"300M posts/day × 365 × 5yr ≈ 550B posts"**, **"~1KB metadata each ≈ 550TB"**, **"media lives separately in object storage, measured in exabytes, served via CDN"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, parking out-of-scope items deliberately, and locking the latency budget before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two endpoints, an ID-only timeline shape, and a bounded cache size justified out loud, before the celebrity problem even comes up.",
      why: "The interviewer wants to see you commit to a small surface and defend it. An ID-only timeline signals you already understand why full content in the cache would be a trap once deletes and likes enter the picture.",
      steps: [
        { kind: "WRITE", text: 'Write the two endpoints: **"POST /posts { text, media? }"** returns **"{ post_id }"**. **"GET /timeline?cursor="** returns "a ranked, paginated list of hydrated posts".' },
        { kind: "DRAW", text: 'Sketch the post row: **"post_id (PK)"**, **"author_id"**, **"text"**, **"media_refs"**, **"created_at"**, **"deleted (tombstone flag)"**. Say: "Posts are the source of truth; timelines only ever store the ID."' },
        { kind: "DRAW", text: 'Sketch the timeline cache shape: **"user:timeline (ZSET)"**, member = "post_id", score = "rank / timestamp". Say: "Bounded to ~800 entries per user — that\'s what keeps this a fixed-size structure instead of an unbounded one."' },
        { kind: "RULE OUT", text: '"Store full post content per timeline entry" — multiplies storage by followers × posts, and every edit would need its own fan-out. Cross it off.' },
      ],
      grading: "Crisp endpoint names, an ID-only timeline shape stated and justified, and the bounded-cache decision made before being prompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled paths: write, async fan-out, and read. Label the arrows with traffic shares and thresholds, not just box names.",
      why: "Drawing write, fan-out, and read as separate lanes is the whole point. It proves you understand they carry different SLAs — a post must save instantly regardless of follower count, fan-out is best-effort, and reads carry almost the entire latency budget.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write lane**: Author → Post Service → Post Store, Media Store, Social Graph (follower-count check). Label **"3.5K/s avg, 10K/s peak"**.' },
        { kind: "DRAW", text: 'Add the **async fan-out lane**, dropping off the Post Service: → Fan-out Queue → Fan-out Worker → Social Graph (paginated) → Timeline Cache. Label **"async, off the post path"**, **"only if followers < 10K"**.' },
        { kind: "DRAW", text: 'Add the **read lane**: Reader → Feed Service → Timeline Cache + Social Graph (celebrity follows) + Post Store (pull celebrity posts) → Ranking Service → hydrate → response. Label **"~300K/s, sub-200ms p99"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because writes, fan-out, and reads have different SLAs — publish must be fast regardless of follower count, fan-out is best-effort and async, and reads carry almost the entire latency budget."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with traffic and the celebrity threshold, and an explicit statement that fan-out never sits on the post-write path.",
    },
    {
      n: 4,
      title: "Deep Dive: Hybrid Fan-out and the Celebrity Problem",
      minutes: 8,
      goal: "Show the push/pull framing, the threshold decision, and defend it against pure-push and pure-pull.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can bound fan-out cost for accounts with 50M+ followers, and whether you understand why the answer is different for typical accounts vs. the power-law tail.",
      steps: [
        { kind: "SAY", text: 'Contrast the two models: "Push is O(1) read, O(followers) write. Pull is O(1) write, O(following) read — paid on every one of the 300K reads/sec." Given the 150:1 ratio, push wins for typical accounts.' },
        { kind: "DRAW", text: 'Draw the threshold decision at post time: followers < 10K → push into every follower\'s ZSET. followers ≥ 10K → skip fan-out, mark pull-only.' },
        { kind: "SAY", text: 'Explain the read-time merge: "The feed service pulls each followed celebrity\'s recent posts live from the post store and merges them with the reader\'s cached timeline before ranking."' },
        { kind: "RULE OUT", text: 'One line each: **pure push** → a celebrity post becomes tens of millions of writes, hours to land. **pure pull** → every one of 300K reads/sec merges hundreds of lists, blowing the read budget.' },
      ],
      grading: "The threshold stated with a number, the O(followers) vs O(following) framing without prompting, and a one-line rejection for both pure strategies.",
    },
    {
      n: 5,
      title: "Deep Dive: Ranking and the Timeline Cache",
      minutes: 7,
      goal: "Explain ranking as a bounded re-rank, and walk the ID-only timeline cache that makes deletes/edits/likes cheap.",
      why: "Anyone can say 'run ML on it'. The interviewer wants the candidate-generation-then-ranking framing, and — for the top score — the candidate volunteering why IDs-only caching is what makes downstream consistency (likes, edits, deletes) tractable.",
      steps: [
        { kind: "SAY", text: 'Frame ranking correctly: "Fan-out/pull already produced a bounded candidate set, maybe a few hundred posts. Ranking only re-scores that set — it never searches the whole corpus."' },
        { kind: "SAY", text: 'Name the feature split: "Real-time signals like engagement velocity come from a fast counter store; heavy learned features like embeddings are precomputed offline and just looked up." Cache the ranked page briefly to avoid re-ranking every pull-to-refresh.' },
        { kind: "SAY", text: 'Walk the timeline cache internals: "A Redis ZSET, ~800 post IDs, score = rank/time. Content is hydrated in one batched call — the timeline never stores content."' },
        { kind: "SAY", text: 'Close the loop on consistency: "Because the timeline only stores IDs, a like, an edit, or a delete never needs its own fan-out — likes and content are read live at hydrate, and a delete is a tombstone filtered at hydrate."' },
      ],
      grading: "Candidate-generation-then-ranking stated explicitly, feature freshness split named, and the connection drawn — unprompted — between IDs-only caching and cheap deletes/edits/likes.",
    },
    {
      n: 6,
      title: "Wrap: Consistency, Bottlenecks, and Close",
      minutes: 5,
      goal: "Name the SLA tiers, push back on a requirement, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: explicit SLA tiers used to justify trade-offs, a tunable threshold framed as an operational knob rather than a magic number, and a clean close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: 'State the tiers: "Post write and feed read are both tier-1 — always fast. Fan-out delivery is tier-2, best-effort — it can lag a few seconds under load without breaking the product."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need full ML ranking for every account, or is reverse-chronological fine for low-engagement users? That changes the ranking service\'s load." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Mention the operational knob: "The celebrity threshold is tunable, and in practice you\'d combine it with post velocity so a suddenly-viral small account is also protected, not just accounts that are celebrities by follower count alone."' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a hybrid fan-out feed: push for typical accounts, pull-and-merge for the celebrity tail, ID-only caching so edits/deletes/likes never need re-propagation, and ranking that only re-scores an already-bounded candidate set. With more time I\'d cover search, stories/ephemeral content, and ads insertion."' },
      ],
      grading: "Explicit SLA tiers, at least one push-back on requirements, the threshold framed as a tunable operational knob, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but fan-out cost and downstream consistency stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, cache (usually 'Redis'), a database, a queue for async work.",
          "Knows to fan out a new post to followers, at least conceptually.",
          "Knows reads dominate writes and adds a cache layer in front of the DB.",
          "Can write the two endpoints (POST /posts and GET /timeline) and a single-row post schema.",
          "Handles 'what about likes' by storing a counter somewhere.",
        ],
        gaps: [
          "Doesn't identify the celebrity problem unprompted — describes fan-out as if every account has 200 followers.",
          "Timeline cache is unbounded (stores 'all recent posts') with no cap on size.",
          "Doesn't separate ID storage from content, so deletes/edits/likes have no clear story.",
          "No consistency plan for a post deleted after it's already been fanned out.",
          "Ranking described as 'run ML on the feed' without the candidate-set framing.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks defaults with reasons, and names the celebrity problem and its threshold when asked.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the DAU, QPS, storage, and ratio numbers on the board within the first 5 minutes.",
          "Proposes hybrid fan-out with a concrete threshold and explains the O(followers) vs O(following) framing.",
          "Timeline cache is bounded to a fixed size and stores IDs, not content.",
          "Explains the hydrate step and why deletes/likes don't need re-fan-out.",
          "Frames ranking as a re-rank of a bounded candidate set, not a corpus search.",
          "Shards the social graph by user_id and mentions wide-row pagination for celebrities.",
          "Names the 150:1 ratio as the reason the whole system is cache-first.",
        ],
        gaps: [
          "Volunteers the celebrity threshold only after the interviewer hints at 'what if someone has 50M followers'.",
          "Doesn't quantify the fan-out worst case in numbers ('tens of millions of writes'), just says 'that would be slow'.",
          "Doesn't mention the offline-vs-real-time feature split for ranking unless directly asked.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces the celebrity problem and consistency story before being asked, and brings operational maturity beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the celebrity problem and a concrete threshold unprompted, quantifying the failure mode (tens of millions of writes for one post if unbounded).",
          "States explicit SLA tiers — post write and feed read are tier-1, fan-out delivery is tier-2/best-effort — and uses that hierarchy to justify every trade-off.",
          "Names wide-row pagination for celebrity follower lists as an operational hazard, not just a fact about the data model.",
          "Explains why IDs-not-content in the timeline cache is what makes deletes, edits, and likes cheap, connecting it back to fan-out cost.",
          "Pushes back on requirements ('does every account need full ML ranking, or is chronological fine for low-engagement users?').",
          "Proposes combining the follower-count threshold with post velocity so a suddenly-viral small account is protected too.",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Fan-out on write for every account with no threshold — one celebrity post becomes tens of millions of synchronous writes.",
      "Storing full post content or like counts inside every timeline cache entry, so a single edit or like needs its own fan-out.",
      "Unbounded timeline cache per user — memory grows forever instead of capping at a known number of recent posts.",
      "No plan for deletes: trying to scrub a deleted post's ID out of millions of already-fanned-out timelines instead of tombstoning and filtering at read time.",
      "Ranking described as scoring the entire post corpus per request instead of re-ranking an already-bounded candidate set.",
      "Treating the social graph like any other row-oriented table, with no plan for a 100M-entry follower row.",
      "No SLA distinction between the post write, the fan-out delivery, and the feed read — treating them as one path with one latency budget.",
    ],
    followUps: [
      {
        q: "What if a normal user suddenly goes viral and crosses the celebrity threshold mid-burst?",
        a: "The threshold is checked per post at publish time, so an in-flight fan-out job for an earlier post isn't retroactively affected. But a small account whose post is suddenly spreading fast needs the same protection a celebrity gets, which is why production systems combine the static follower-count threshold with a post-velocity signal — if a post's engagement or share rate spikes past a cutoff, the system can pause further push-based fan-out for that post and switch remaining delivery to pull, even though the author's follower count never crossed 10K.",
      },
      {
        q: "How do you paginate a feed whose underlying data keeps changing as new posts arrive?",
        a: "Use cursor-based pagination keyed on the same rank/timestamp score already stored in the timeline ZSET, not an offset. The client passes back the score of the last item it saw; the next page is a range query for everything below that score. New posts land above the cursor and never shift or duplicate items already paginated through, which an offset-based approach would get wrong the moment new posts are inserted mid-scroll.",
      },
      {
        q: "What happens if the fan-out worker pool falls behind during a traffic spike?",
        a: "The Kafka queue backs up and fan-out lag grows past the 5-second SLA, but reads keep working because they don't depend on fan-out completing — the feed service just serves whatever has landed in the cache so far, and autoscaling adds worker capacity to drain the backlog. This is exactly why fan-out is tier-2/best-effort: a lagging queue degrades freshness for some users temporarily, it never takes down reads or writes.",
      },
      {
        q: "Why not just always pull (fan-out on read) for everyone and skip the celebrity complexity?",
        a: "Because reads outnumber writes 150:1 — paying a live merge cost on every one of ~300K reads/sec, for every user's full following list, overwhelms compute far worse than the bounded write cost push imposes on the 99%+ of accounts under the celebrity threshold. Pull-everywhere trades a well-understood, bounded write cost for an unbounded-per-read cost multiplied by the system's dominant traffic pattern.",
      },
      {
        q: "How does ranking avoid feeling stale if heavy features are precomputed offline?",
        a: "Split real-time and offline signals: offline batch jobs compute expensive features like affinity embeddings and refresh them daily, while a fast counter store tracks real-time engagement velocity (likes/comments in the last few minutes) and feeds that into the score inline. The blend means a post can rank higher within seconds of going viral even though the heavier embeddings behind it were computed yesterday.",
      },
      {
        q: "How would you extend this design for Stories or other ephemeral content?",
        a: "Give it a separate storage and delivery model rather than reusing the timeline cache: ephemeral posts are short-lived (24h TTL), so a small author typically has a small candidate set, which makes pure pull cheap enough that fan-out complexity isn't worth it. Expiration becomes a TTL on the post store instead of the delete/tombstone path used for permanent posts, and the celebrity threshold matters far less because the read pattern (a strip of a few dozen stories) is bounded regardless of follower count.",
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
          "This is a fan-out problem wearing a feed's clothes. The core operation — get a newly published post in front of the right people — is a delivery problem, and everything expensive in this design (the push/pull split, the bounded cache, the ranking stage) exists to make that delivery fast and cheap at 300K reads/sec against a power-law follower graph.",
          "Anchor everything on five numbers: 500M DAU, 300M posts/day (~3.5K/s avg, 10K/s peak), ~300K feed reads/sec, a 150:1 read:write ratio, and a sub-200ms p99 feed load. Every structural choice below is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Push vs pull, and why neither wins alone",
        body: [
          "Fan-out on write (push) precomputes each follower's timeline at post time, making reads O(1) at the cost of an O(followers) write. Fan-out on read (pull) does the opposite: writes are O(1), but every feed load must live-merge posts from everyone the reader follows — O(following), paid on every one of the 300K reads/sec this system serves.",
          "Given the 150:1 ratio, push is the right default: it optimizes the operation that happens 150x more often. But push cost scales with follower count, which means it collapses exactly where the follower graph has its heaviest tail — celebrity accounts with tens of millions of followers.",
        ],
      },
      {
        heading: "Hybrid fan-out and the celebrity threshold",
        body: [
          "The resolution is a threshold, typically around 10K followers. Below it, posts fan out on write as normal. At or above it, fan-out is skipped entirely — the post is written once (O(1)) and marked pull-only. The feed service pulls that account's recent posts directly from the post store at read time and merges them into any follower's feed, bounded by how many celebrities that reader follows, not by how many followers the celebrity has.",
          "This is why publish latency never depends on follower count: the worst case is always O(1) at write time. Production systems often sharpen this further by combining the static follower-count threshold with a post-velocity signal, so a small account that suddenly goes viral gets the same protection without ever crossing the follower threshold.",
        ],
      },
      {
        heading: "The timeline cache and the social graph",
        body: [
          "The materialized timeline is a Redis sorted set per user, holding only the most recent ~800 post IDs with a rank/timestamp score — bounded, not the user's whole history. It stores IDs and a score only, never content; content is hydrated from a separate cache in one batched call per feed page, keeping fan-out writes tiny and total memory to a known bound (~20TB across the cluster at 500M users).",
          "The social graph backing all of this — follower/following edges — is its own sharded, wide-column store, keyed by user_id so a typical user's edges live on one partition. The one operational wrinkle is the power-law tail: a celebrity's follower row can hold 100M+ entries, so anything touching that row (fan-out, analytics) must paginate it in bounded batches rather than ever loading it whole.",
        ],
      },
      {
        heading: "Ranking as a bounded re-rank",
        body: [
          "By the time ranking runs, candidate generation (fan-out or pull) has already narrowed the problem to a few hundred posts — ranking re-scores that bounded set, it never searches the whole corpus. The score blends recency decay, affinity between viewer and author, and a predicted-engagement probability, combining a fast real-time signal (recent engagement velocity, from a counter store) with heavier features precomputed offline (learned embeddings) and simply looked up.",
          "The ranked page itself is cached briefly so a pull-to-refresh doesn't trigger a full recompute, trading a few seconds of staleness for a latency budget that actually fits a scroll.",
        ],
      },
      {
        heading: "Consistency after the fact, and the SLA hierarchy",
        body: [
          "Because timelines store only IDs, none of likes, edits, or deletes need their own fan-out. Likes and comment counts are read live from a counter store at hydrate time; an edit is just an updated row in the post store, visible immediately since content is never cached in the timeline; a delete tombstones the post, and the hydrate step silently filters any ID that resolves to a tombstone instead of scrubbing it out of millions of timelines.",
          "That design rests on an explicit SLA hierarchy: post write and feed read are tier-1 and must always be fast; fan-out delivery is tier-2, best-effort, allowed to lag a few seconds under load without degrading either tier-1 path. Naming that hierarchy out loud is what justifies every trade-off in this design, from the celebrity threshold to the IDs-only cache to async fan-out itself.",
        ],
      },
    ],
  },
};
