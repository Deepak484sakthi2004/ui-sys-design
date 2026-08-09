import type { Problem } from "@/lib/types";

export const instagram: Problem = {
  slug: "instagram",
  num: "6.7",
  title: "Design Instagram",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a photo/video sharing app with 2B registered users, 500M DAU, 100M posts/day, and a home feed served to ~145K reads/sec at p99 under 200ms — where a handful of accounts have 100M+ followers each.",
  ],
  hardParts:
    "The hard parts: fanning out a post to hundreds of millions of followers without a single celebrity post melting the write path, ranking a feed in real time instead of just sorting by time, and keeping a multi-terabyte-per-day media pipeline fast at the edge without ever losing an original upload.",
  keyTopics: [
    "Hybrid Fan-out (Push + Pull)",
    "The Celebrity Problem",
    "Feed Ranking as Re-order, Not Re-fetch",
    "Media Pipeline & CDN",
    "Denormalized Follow Graph",
  ],
  foundationsReferenced: [
    { label: "Redis / Valkey", tone: "purple" },
    { label: "Cassandra (Wide-Column Store)", tone: "blue" },
    { label: "Kafka", tone: "orange" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "CDN & Edge Caching", tone: "green" },
    { label: "CAP Theorem / Eventual Consistency", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 2, tone: "slate" },
      { id: "cdn", label: "CDN", sub: "media edge · ~80% hit", col: 1, row: 1, tone: "green" },
      { id: "lb", label: "API Gateway / LB", col: 2, row: 2, tone: "slate" },
      {
        id: "feedsvc",
        label: "Feed Service",
        sub: "stateless · ranks & merges",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "rediscache", label: "Redis Timeline Cache", sub: "~500M timelines · ~6TB", col: 4, row: 1, tone: "green" },
      { id: "poststore", label: "Cassandra", sub: "post metadata + counters", col: 5, row: 1, tone: "blue" },
      { id: "postsvc", label: "Post Service", sub: "~1.2K/s avg, ~6K/s peak", col: 3, row: 3, tone: "purple" },
      { id: "mediastore", label: "Object Storage", sub: "S3-class · originals + variants", col: 4, row: 3, tone: "blue" },
      { id: "kafka", label: "Kafka", sub: "new_post events", col: 3, row: 4, tone: "orange" },
      { id: "fanoutworker", label: "Fan-out Worker Pool", sub: "push, non-celebrity only", col: 4, row: 4, tone: "orange" },
      { id: "followgraph", label: "Follow Graph", sub: "~300B edges, both directions", col: 2, row: 4, tone: "blue" },
    ],
    edges: [
      { from: "client", to: "lb", label: "GET /feed", kind: "read" },
      { from: "client", to: "cdn", label: "load media", kind: "read" },
      { from: "cdn", to: "mediastore", label: "origin miss ~20%", kind: "read" },
      { from: "lb", to: "feedsvc", kind: "read" },
      { from: "feedsvc", to: "rediscache", label: "precomputed timeline · O(1)", kind: "read" },
      { from: "feedsvc", to: "poststore", label: "celebrity pull + hydrate", kind: "read" },
      { from: "client", to: "lb", label: "POST /media", kind: "write" },
      { from: "lb", to: "postsvc", kind: "write" },
      { from: "postsvc", to: "mediastore", label: "upload original", kind: "write" },
      { from: "postsvc", to: "poststore", label: "insert post row", kind: "write" },
      { from: "postsvc", to: "kafka", label: "new_post event", kind: "write" },
      { from: "kafka", to: "fanoutworker", kind: "analytics" },
      { from: "fanoutworker", to: "followgraph", label: "paginated follower list", kind: "analytics" },
      { from: "fanoutworker", to: "rediscache", label: "push post_id, below threshold", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · ~145K feed reads/s" },
      { kind: "write", text: "write path · ~1.2K posts/s avg" },
      { kind: "analytics", text: "async fan-out & media · never blocks the upload ack" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Upload a photo or video with a caption; generate multiple resolutions/bitrates", tag: "P0" },
      { id: "FR-02", text: "Follow / unfollow other users (public accounts, request-based for private)", tag: "P0" },
      { id: "FR-03", text: "Home feed: ranked posts from accounts the user follows", tag: "P0" },
      { id: "FR-04", text: "Like a post and view the like count", tag: "P0" },
      { id: "FR-05", text: "Comment on a post, with threaded replies", tag: "P0" },
      { id: "FR-06", text: "View a user's profile grid of their own posts", tag: "P1" },
      { id: "FR-07", text: "Stories: 24-hour ephemeral photo/video posts on a separate rail", tag: "P1" },
      { id: "FR-08", text: "Push notifications for likes, comments, new followers, mentions", tag: "P1" },
      { id: "FR-09", text: "Search users and hashtags", tag: "P1" },
      { id: "FR-10", text: "Explore/discovery feed of recommended content", tag: "P2" },
      { id: "FR-11", text: "Direct messaging between users", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Feed load latency, server-side", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "Media time-to-first-byte from the CDN edge", tag: "p99 < 100ms" },
      { id: "NFR-03", text: "Post upload acknowledgment (before fan-out/processing complete)", tag: "p99 < 500ms" },
      { id: "NFR-04", text: "Feed read throughput, sustained globally", tag: "150K/sec" },
      { id: "NFR-05", text: "Post write throughput, sustained (peak burst)", tag: "1.2K/sec" },
      { id: "NFR-06", text: "Availability (about 4.4 hrs downtime per year)", tag: "99.95%" },
      { id: "NFR-07", text: "Fan-out completion, post to appearing in a follower's feed (non-celebrity)", tag: "< 5s" },
      { id: "NFR-08", text: "Durability of uploaded media originals and post metadata", tag: "zero loss" },
      { id: "NFR-09", text: "Read-to-write ratio that anchors the whole design", tag: "100:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: the five numbers that drive everything",
      body: [
        "Before picking a fan-out strategy, quantify the traffic it has to survive. 500M DAU loading their feed roughly 25 times a day is about 12.5B feed reads/day, ~145K/sec average, spiking near 360K/sec in evening peak windows. 100M posts/day is only ~1,150/sec average — the write side looks tiny by comparison.",
        "But writes don't stay tiny once you decide to precompute feeds. If every post is pushed into every follower's timeline at write time, and the average account has ~150 followers, then 100M posts/day becomes ~15B fan-out writes/day — about 165K/sec, the same order of magnitude as the entire read path. That single fact, that naive push amplifies writes up to read-path scale, is the reason this system can't use one fan-out mechanism for every account.",
      ],
      bullets: [
        { lead: "100M posts/day", text: "≈ 1,150/sec average, ~6K/sec at peak (photo/video bursts overlapping across time zones)." },
        { lead: "150 avg followers", text: "means naive push fans a single post out to ~150 timelines, so total fan-out volume is ~165K writes/sec — the same order as the whole read path." },
        { lead: "500M DAU, ~25 loads/day", text: "≈ 145K feed reads/sec average, peaking near 360K/sec." },
        { lead: "Read:write ≈ 125:1", text: "on feed reads vs. posts created — this is a brutally read-heavy system, but push-based fan-out quietly turns part of the read cost into write cost." },
      ],
      pictureTitle: "Where does the traffic actually go?",
      pictureRows: [
        { label: "Posts created", value: "~1.2K/s avg, ~6K/s peak", tone: "neutral" },
        { label: "Feed reads", value: "~145K/s avg, ~360K/s peak", tone: "used" },
        { label: "Naive push fan-out writes", value: "~165K/s avg — same order as reads", tone: "bad" },
      ],
      remember: {
        problem: "How big is this system really, and where does the load concentrate?",
        solution: "500M DAU, 100M posts/day, ~145K feed reads/sec, and naive fan-out alone would add ~165K writes/sec — write amplification on the same order as the entire read path.",
        why: "Every post is read by ~150 followers on average, so pushing it to every timeline multiplies write volume by the follower count.",
        tradeoff: "Precomputing feeds (push) makes reads cheap but amplifies writes; computing feeds live (pull) makes writes cheap but every read fans out across the follow graph instead.",
        failure: "Push-everywhere for every account means one celebrity post with 100M followers triggers 100M writes in seconds.",
        mitigation: "Split the population: push for typical accounts, pull for the few whose follower count would turn one write into millions.",
      },
    },
    {
      n: 2,
      title: "Fan-out on write vs. fan-out on read: kill two, keep the hybrid",
      body: [
        "There are exactly two pure strategies for turning 'posts by people I follow' into 'my feed', and both fail at the extremes. Put them on the board, kill each with a number, and land on the hybrid that most large feed systems actually run.",
      ],
      bullets: [
        { lead: "Fan-out on read (pull)", text: "at feed-load time, look up everyone the user follows, fetch their recent posts, merge and rank. Writes are O(1) — a post is one row. But a feed read now touches ~150 authors' recent-post lists; at 145K reads/sec that's untenable, and heavy users with 1,000+ follows make it worse. Rejected as the only mechanism." },
        { lead: "Fan-out on write (push)", text: "at post time, copy the post_id into a precomputed timeline for every follower. Reads become one O(1) lookup, which is what makes sub-200ms feeds possible. But writes cost O(followers): a celebrity with 100M followers turns one post into 100M writes wanting to land within seconds. Rejected as the only mechanism." },
        { lead: "Hybrid (push for most, pull for celebrities)", text: "push for the >99.99% of accounts under a follower threshold, so reads stay cheap. Skip the push above the threshold; pull those accounts' recent posts live at read time and merge them into the precomputed timeline. Winner." },
      ],
      pictureTitle: "Fan-out: kill two, keep the hybrid",
      pictureRows: [
        { label: "Pull-only", value: "O(1) write, O(follows) read → reject", tone: "bad" },
        { label: "Push-only", value: "O(1) read, O(followers) write → reject", tone: "bad" },
        { label: "Hybrid (push + pull)", value: "O(1) read for everyone, O(followers) write only for typical accounts → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Reads must be O(1) fast, but naive writes can spike to O(followers).",
        solution: "Push (fan-out-on-write) for accounts under ~1M followers; pull (fan-out-on-read) for accounts above it, merged live into the feed.",
        why: "Almost every account has a follower count small enough that pushing is cheap; the rare celebrity account is exactly where pushing stops being cheap.",
        tradeoff: "Two code paths and a merge step at read time, instead of one simple mechanism.",
        failure: "Push-only lets a single celebrity post queue 100M+ writes and lags the fan-out worker pool for minutes; pull-only fans every feed read out across the whole follow list.",
        mitigation: "Route by a follower-count threshold decided at post time, and do the push asynchronously off the request path either way.",
      },
    },
    {
      n: 3,
      title: "The celebrity problem in detail",
      body: [
        "Choosing the threshold is only half the problem — the other half is making sure fan-out, even for accounts that do get pushed, never sits on the critical path and never chokes on one huge account. A post's write acknowledgment must never wait on 150 (or 150,000) downstream timeline writes.",
      ],
      bullets: [
        { lead: "Where to draw the line", text: "~1M followers is a practical threshold: below it, even a burst of writes is a rounding error against total system capacity; above it, one post is a coordinated write storm." },
        { lead: "Never fan out inline", text: "the post write returns success (durably, in the metadata store) as soon as the row is written; fan-out happens after, off a Kafka event, so the uploader is never stuck waiting on hundreds of thousands of timeline writes." },
        { lead: "Paginate the follower list", text: "even for a mid-size account, walk the follower table in pages (e.g. 1,000 at a time) and pipeline the Redis writes in batches, so one large fan-out job doesn't hold a connection or block other jobs behind it in the worker pool." },
        { lead: "Merge at read, not at write", text: "for a celebrity, the feed service fetches their last few posts directly at read time and interleaves them with the precomputed timeline — the follower sees the post on their very next refresh with zero propagation lag, actually faster than waiting on a push." },
      ],
      pictureTitle: "What happens when a 100M-follower account posts?",
      pictureRows: [
        { label: "If pushed", value: "100M timeline writes queued in seconds", tone: "bad" },
        { label: "Actual: skip the push", value: "post row written once, done", tone: "good" },
        { label: "At read time", value: "feed service pulls + merges live, zero lag", tone: "good" },
      ],
      remember: {
        problem: "A celebrity post must not turn into a write storm.",
        solution: "Skip the fan-out for accounts over the follower threshold; pull their recent posts live at feed-read time instead.",
        why: "The cost of pushing scales with follower count; the cost of pulling a handful of recent posts from one author is constant, regardless of how many people are reading.",
        tradeoff: "Celebrity posts cost slightly more per feed read (one extra lookup); in exchange, one post never floods the write path.",
        failure: "Push-everywhere for a 100M-follower account backs up the fan-out queue for everyone else behind it in the same worker pool.",
        mitigation: "Follower-count threshold decided at write time, paginated async fan-out for the accounts that do get pushed, and live merge for the ones that don't.",
      },
    },
    {
      n: 4,
      title: "Feed storage: what actually lives in the timeline cache",
      body: [
        "The precomputed timeline only works if it stays cheap to store and cheap to keep warm across 500M active users. The trick is storing as little as possible per entry and hydrating everything else at read time.",
      ],
      bullets: [
        { lead: "Store IDs, not content", text: "the timeline cache holds only post_id + a score, capped at ~800 entries per user (roughly a month of a typical feed). Hydrating caption, image URL, and like count happens in a second batched call to the post-metadata store — this keeps the hot structure tiny (~500M users × 800 IDs ≈ 6TB total) instead of duplicating megabytes of content per follower." },
        { lead: "Cap and trim", text: "every push trims the list back to the cap so a hyperactive followee doesn't grow one user's timeline unbounded; older entries just age out, which is fine because nobody scrolls a month deep." },
        { lead: "Cold users", text: "a user who hasn't opened the app in months has a stale or evicted timeline; on their next load, the feed service falls back to a bounded on-demand fan-out — walk the follow list live, once, and repopulate — instead of paying to keep every inactive user's cache warm forever." },
        { lead: "Sharded by user_id", text: "consistent hashing spreads timelines across the Redis cluster so one user's writes/reads never bottleneck on a single node, and a node loss only cold-starts the timelines it owned." },
      ],
      pictureTitle: "What actually lives in the timeline cache?",
      pictureRows: [
        { label: "Per user", value: "~800 (post_id, score) pairs, capped", tone: "neutral" },
        { label: "Full post content", value: "NOT stored here — hydrated separately", tone: "good" },
        { label: "Cluster total", value: "~500M timelines ≈ 6TB, sharded by user_id", tone: "used" },
      ],
      remember: {
        problem: "Precomputed feeds must stay cheap to store and cheap to keep warm for 500M users.",
        solution: "Redis holds only (post_id, score) pairs per user, capped at ~800 and consistently hashed across the cluster; content is hydrated from the metadata store at read time.",
        why: "IDs are tiny and bounded; storing full post payloads per follower would multiply storage by the average follower count.",
        tradeoff: "Every feed read needs a second hydration call, trading a bit of read latency for a cache that's cheap to keep warm at 500M-user scale.",
        failure: "Uncapped timelines grow unbounded for users who follow very active accounts, and warming every inactive user's cache forever wastes memory no one reads.",
        mitigation: "Cap at ~800 entries per user, and lazily rebuild (bounded on-demand fan-out) for a user who returns after a long absence instead of always keeping every timeline warm.",
      },
    },
    {
      n: 5,
      title: "Ranking is a re-order, not a re-fetch",
      body: [
        "A pure most-recent-first feed surfaces whatever posted last, not what the user is likely to engage with. The fix is not to fetch more data — it's to re-order the small candidate set the fan-out already produced.",
      ],
      bullets: [
        { lead: "Candidates first, then rank", text: "the precomputed timeline plus any live-pulled celebrity posts form a candidate set (a few hundred post IDs); ranking only has to score that small set, not the whole graph." },
        { lead: "Chronological alone isn't the goal", text: "a scoring pass reorders the same candidate set using signals like recency decay, prior engagement with that author, and content type — the point is relevance, not just recency." },
        { lead: "Keep it inside the latency budget", text: "ranking runs on a few hundred candidates per request, not millions, so a lightweight model (or precomputed features plus a fast scoring function) can run inline within the ~200ms budget instead of needing a slow batch job." },
        { lead: "Degrade gracefully", text: "if the ranking service is slow or down, fall back to the chronological order of the same candidate set — a worse feed is fine, a broken feed is not." },
      ],
      pictureTitle: "Ranking is a re-order, not a re-fetch",
      pictureRows: [
        { label: "Candidate generation", value: "timeline cache + celebrity pulls → few hundred IDs", tone: "neutral" },
        { label: "Ranking pass", value: "score + re-order the same candidates", tone: "good" },
        { label: "Ranking degraded/down", value: "fall back to chronological, never fail the request", tone: "used" },
      ],
      remember: {
        problem: "A feed of just-posted content isn't the same as a feed of content people actually want to see.",
        solution: "Generate a small candidate set from the timeline cache and celebrity pulls, then run a fast ranking pass over just that set.",
        why: "Ranking a few hundred candidates fits the latency budget; ranking the whole graph per request would not.",
        tradeoff: "A ranked feed is more complex to reason about and debug than chronological, and needs a feature/engagement pipeline behind it.",
        failure: "If ranking is treated as mandatory and it fails, the whole feed request fails with it.",
        mitigation: "Ranking is a re-order step with a chronological fallback, so a ranking outage degrades relevance, not availability.",
      },
    },
    {
      n: 6,
      title: "Media pipeline: upload, transcode, CDN, durability",
      body: [
        "A photo or video is orders of magnitude bigger than any metadata row it's attached to, so it needs its own path — one that never blocks the upload response and never routes megabytes through the application tier.",
      ],
      bullets: [
        { lead: "Upload straight to object storage", text: "the client uploads the original file directly to blob storage (e.g. via a pre-signed URL), not through the application server, so a multi-megabyte photo or video never ties up an API pod's connection." },
        { lead: "Process asynchronously", text: "once the original lands, an event triggers a worker pool that generates the derived set — thumbnail, feed-resolution, full-resolution for photos; multiple bitrates/segments for video — and writes each variant back to blob storage." },
        { lead: "The post goes live before processing finishes", text: "the post row and a placeholder are visible almost immediately; the app swaps in the processed variants as they land, typically within a couple of seconds, rather than blocking the whole upload on transcoding." },
        { lead: "Originals are durable, derivatives are disposable", text: "only the original is treated as unrecoverable; every resized/transcoded variant can always be regenerated from it, so those are safe to cache aggressively, evict, or even lose and rebuild." },
      ],
      pictureTitle: "Upload to visible: who does what, and when",
      pictureRows: [
        { label: "Original upload", value: "direct to blob storage, bypasses app server", tone: "good" },
        { label: "Derived variants", value: "generated async by a worker pool", tone: "neutral" },
        { label: "CDN edge", value: "serves variants, ~80% hit, origin is blob storage", tone: "used" },
      ],
      remember: {
        problem: "Serve images/video fast at the edge without either blocking uploads or losing originals.",
        solution: "Upload direct-to-blob-storage, process resolutions/bitrates asynchronously, serve everything through a CDN backed by that same store.",
        why: "Transcoding is CPU-heavy and slow; it must never sit between the user and an upload acknowledgment.",
        tradeoff: "A post can be visible slightly before every resolution has finished processing, so the client needs a placeholder/progressive state.",
        failure: "Routing large uploads through the app tier ties up server connections and memory on every photo/video; treating derivatives as precious like originals wastes storage.",
        mitigation: "Pre-signed direct uploads, an async worker pipeline, and a clear originals-are-durable/derivatives-are-disposable storage policy.",
      },
    },
    {
      n: 7,
      title: "Follow graph and counters: the data model underneath it all",
      body: [
        "Two more decisions make everything above cheap: how the follow graph is shaped, and how likes/comments are counted. Get either wrong and even a well-designed fan-out can't save you.",
      ],
      bullets: [
        { lead: "Denormalize both directions", text: "store 'who I follow' and 'who follows me' as two separate tables, both keyed and sharded by user_id. A join-based schema makes 'give me this user's followers' an expensive scatter-gather at 300B-edge scale; two flat tables make both directions an O(1) partition read." },
        { lead: "Counters, not counting", text: "like and comment counts are maintained as counters incremented in place (e.g. Redis INCR, periodically flushed, or a native counter column), not computed by counting rows on every read — counting a celebrity post's 2M likes on every view would be far too slow." },
        { lead: "Approximate is fine at the top end", text: "for very large counts the UI shows a rounded figure ('2.1M likes'); the system can favor availability and eventual consistency for the counter over making every like a strongly consistent write." },
        { lead: "Post metadata is close to immutable", text: "caption/media/author on a post basically never change after creation, only the counters do — the same immutable-row idea as a KV store, just with a couple of mutable counter columns bolted on." },
      ],
      pictureTitle: "Follow graph and counters, sized",
      pictureRows: [
        { label: "Follow edges", value: "~300B, denormalized both directions", tone: "used" },
        { label: "Naive join for 'my followers'", value: "scatter-gather at scale → reject", tone: "bad" },
        { label: "Like/comment counts", value: "counters, not COUNT(*) on every read", tone: "good" },
      ],
      remember: {
        problem: "Serve 'who does X follow' and 'who follows X' fast at 300B-edge scale, and show like counts without counting rows.",
        solution: "Two denormalized, user_id-sharded tables for the follow graph; counters (not row counts) for likes/comments.",
        why: "A relational join at this scale is a distributed scatter-gather; a counter column is an O(1) increment and read.",
        tradeoff: "Two copies of every follow relationship to keep in sync, and counters trade perfect real-time accuracy for speed at the high end.",
        failure: "COUNT(*) over a celebrity post's likes on every page view would be catastrophically slow; a single join-based follow table makes one of the two directions expensive.",
        mitigation: "Write to both denormalized tables on follow/unfollow, and let counters be eventually consistent with periodic reconciliation.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a fan-out problem wearing a photo-sharing UI: precompute most people's feeds on write so reads are O(1), but skip precomputing for celebrity accounts and pull their posts live instead.",
      "The follow graph is denormalized in both directions so 'who follows me' and 'who do I follow' are each a single O(1) partition read, not a join.",
      "Media never touches the app tier: clients upload straight to blob storage, a worker pool derives every resolution/bitrate asynchronously, and a CDN serves it all at the edge.",
      "Feed ranking is a re-order of a small candidate set (timeline cache + celebrity pulls), not a re-fetch of the whole graph, so it fits inside the latency budget with a chronological fallback.",
      "The one number to know cold: the follower-count threshold for push vs. pull, because that single decision is what keeps one celebrity post from becoming a hundred-million-write storm.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · ~145K/S AVG · P99 < 200MS",
        summary:
          "A feed load merges a precomputed timeline with any celebrity posts pulled live, hydrates the metadata, ranks the small candidate set, and returns.",
        steps: [
          { label: "Client", note: "opens app / pulls to refresh" },
          { label: "API Gateway / LB", note: "routes to a nearby feed pod" },
          { label: "Feed Service", note: "stateless, orchestrates the read" },
          { label: "Redis timeline cache", note: "~800 capped post_ids, O(1)" },
          { label: "Cassandra (posts)", note: "live pull for followed celebrities + hydrate metadata" },
          { label: "Ranking pass", note: "score & re-order candidate set, chronological fallback" },
          { label: "Response", note: "ranked feed of hydrated posts" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · ~1.2K/S AVG, ~6K/S PEAK",
        summary:
          "A post is written once, acknowledged immediately, and everything expensive — fan-out and media processing — happens off the request path.",
        steps: [
          { label: "Client", note: "uploads caption + media" },
          { label: "Object storage (S3-class)", note: "original uploaded direct, bypasses app tier" },
          { label: "Post Service", note: "writes post row, returns ack" },
          { label: "Cassandra (posts)", note: "durable metadata, near-immutable row" },
          { label: "Kafka", note: "new_post event, async" },
          { label: "Fan-out worker pool", note: "push for <1M followers; skipped for celebrities" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · FAN-OUT & MEDIA · NEVER BLOCKS THE UPLOAD ACK",
        summary:
          "Two background pipelines run off the same new_post event: one paginates the follower list and pushes into timelines, the other derives every media resolution and warms the CDN.",
        steps: [
          { label: "Kafka", note: "new_post event" },
          { label: "Fan-out worker", note: "paginate followers, batch-pipeline into Redis timelines" },
          { label: "Media worker pool", note: "derive thumbnail/feed/full resolutions, transcode video" },
          { label: "CDN", note: "warmed with derived variants for fast first view" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "2B registered users, 500M DAU, 100M posts/day (~1.2K/s avg, ~6K/s peak)",
          "~145K feed reads/sec avg, ~360K/s peak (500M DAU × ~25 loads/day)",
          "Naive push-everywhere fan-out ≈ 165K writes/sec — same order as the entire read path",
          "Follow graph: ~300B edges, denormalized both directions",
          "Timeline cache: ~500M active timelines × ~800 capped IDs ≈ 6TB, sharded by user_id",
          "Media: ~300TB/day new derived+original media, ~110PB/year",
          "Celebrity threshold: ~1M followers, ~50K accounts (~0.0025% of users)",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Hybrid fan-out: push (write-time) below the follower threshold, pull (read-time) above it",
          "Timeline cache stores post_id + score only, never full content — hydrate separately",
          "Follow graph denormalized into two user_id-sharded tables, not a join",
          "Likes/comments as counters, not COUNT(*), eventually consistent at the high end",
          "Media uploads go direct-to-blob-storage; app tier never proxies the bytes",
          "Ranking scores a small candidate set with a chronological fallback, never blocks the read",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Write amplification from naive fan-out is the load-bearing risk — the celebrity threshold is what tames it",
          "Post ack is decoupled from both fan-out and media processing — neither blocks the upload response",
          "Originals are durable and irreplaceable; derived media variants are disposable and regeneratable",
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
      goal: "Get five numbers and the shape of the follow graph on the board before drawing anything, so the celebrity problem surfaces from the math, not from a hint.",
      why: "The interviewer wants to see the design driven by data. Every later decision (fan-out threshold, cache size, worker pool sizing) is a consequence of the amplification math done here, not a stylistic preference.",
      steps: [
        { kind: "ASK", text: '**Is this read-heavy or write-heavy?** Walk them to "100M posts/day" vs "~145K feed reads/sec". Write **"~1.2K w/s, ~145K r/s"** in the corner.' },
        { kind: "ASK", text: '**How big is the follow graph, and is it skewed?** Land on "average ~150 followers, but a long tail of celebrity accounts with 10M-100M+ followers". Write **"skewed follow graph"** — this single fact is what the whole design hangs on.' },
        { kind: "SAY", text: 'Propose the latency target: **"feed load p99 < 200ms"**, **"media edge TTFB p99 < 100ms"**, **"upload ack p99 < 500ms"**. Wait for a nod.' },
        { kind: "SAY", text: 'State scope. In: "feed generation", "the follow graph", "media upload/serving", "likes and comments". Out: "stories", "DMs", "discovery/explore ranking internals", "auth". "Happy to come back to any of those."' },
        { kind: "WRITE", text: 'Do the amplification math out loud: **"100M posts × ~150 avg followers ≈ 15B fan-out writes/day ≈ 165K/s"** — roughly the same order as the entire read path. Write it down; it\'s the reason a naive design doesn\'t survive contact with a celebrity account.' },
      ],
      grading: "Senior judgment: are the read/write numbers and the skew of the follow graph on the board before any boxes are drawn, and is the amplification math done out loud rather than asserted?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two-ish endpoints, a near-immutable post row, and the follow-graph denormalization justified before it's questioned.",
      why: "The interviewer wants to see a small committed surface and a data model that already anticipates the scale problems, not one retrofitted after being pushed on it.",
      steps: [
        { kind: "WRITE", text: 'Endpoints: **"POST /media {caption, mediaRefs[]}"** → **"{postId}"**, with the upload itself a pre-signed direct-to-storage step first. **"GET /feed?cursor="** → ranked page of hydrated posts. **"POST /follow/:userId"**, **"POST /posts/:id/like"**.' },
        { kind: "DRAW", text: 'Sketch the post row: **"post_id (PK)"**, **"author_id"**, **"media_refs"**, **"caption"**, **"created_at"**, **"like_count (counter)"**, **"comment_count (counter)"**. Say: "Everything but the two counters is effectively immutable after create."' },
        { kind: "SAY", text: 'Justify the follow graph as two tables, not one: **"following(user_id → followee_id)"** and **"followers(user_id → follower_id)"**, both sharded by user_id. "A single join-based table makes one direction a scatter-gather at 300B edges."' },
        { kind: "RULE OUT", text: 'Get ahead of it: "A single normalized follow table looks cleaner, but \'who follows this celebrity\' becomes a distributed join over billions of rows. Denormalizing to two tables trades storage for O(1) reads in both directions." Cross it off.' },
      ],
      grading: "Two-ish endpoints with a pre-signed upload step called out, a near-immutable post row with counters, and the follow-graph denormalization justified before being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: read, write, and async fan-out/media. Prove reads, writes, and background work have different SLAs.",
      why: "Drawing the async lane as visibly separate is the whole point — it shows the candidate understands the post ack must never wait on either fan-out or transcoding.",
      steps: [
        { kind: "DRAW", text: 'Read lane: Client → LB → Feed Service → Redis timeline cache (O(1)) + live pull from Cassandra for followed celebrities → ranking pass → response. Label arrows **"~145K/s"**, **"p99 < 200ms"**.' },
        { kind: "DRAW", text: 'Write lane: Client → blob storage (direct upload) + LB → Post Service → Cassandra (post row) → ack returned. Label **"~1.2K/s"**, **"ack < 500ms, before fan-out/processing"**.' },
        { kind: "DRAW", text: 'Async lane, dashed, off a Kafka **"new_post"** event: → Fan-out worker pool → Redis timelines (push, non-celebrity only); and separately → Media worker pool → CDN (derived resolutions).' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because reads, writes, and fan-out/processing have three different SLAs — the post ack must never wait on either the fan-out or the transcoding."' },
      ],
      grading: "Three clearly separated lanes, the fan-out and media pipelines explicitly async off the write path, and an explicit statement that the ack never waits on either.",
    },
    {
      n: 4,
      title: "Deep Dive: Fan-out and the Celebrity Problem",
      minutes: 8,
      goal: "Kill both pure strategies with a number each, draw the threshold split, and land the celebrity-pull-has-no-lag point unprompted.",
      why: "This is the signature sub-problem. The interviewer is probing whether the candidate can quantify why push-only and pull-only both fail, not just recite 'hybrid fan-out' as a buzzword.",
      steps: [
        { kind: "SAY", text: 'State the two pure strategies and kill both: "Pull-only makes writes O(1) but every read fans out across ~150 authors — untenable at 145K reads/sec. Push-only makes reads O(1) but a celebrity post becomes O(followers) writes — 100M+ in seconds."' },
        { kind: "DRAW", text: 'Draw the threshold split: accounts under ~1M followers → pushed async via Kafka + a paginated worker pool; accounts over it → skipped, pulled live at read time and merged into the candidate set.' },
        { kind: "SAY", text: 'Explain why pagination matters: "Even a mid-size account\'s fan-out walks the follower table in pages and pipelines the Redis writes in batches, so one job never hogs a worker or a connection."' },
        { kind: "SAY", text: 'Land the punchline: "Celebrity posts actually show up with zero propagation lag, because they\'re fetched live on the follower\'s very next read — no waiting on a queue at all."' },
      ],
      grading: "Both pure strategies killed with a concrete cost (not just 'reject'), the threshold-based hybrid drawn, and the celebrity-pull-has-no-lag point made unprompted.",
    },
    {
      n: 5,
      title: "Deep Dive: Ranking and the Media Pipeline",
      minutes: 7,
      goal: "Separate candidate generation from ranking with a fallback, then walk the media pipeline with the originals-vs-derivatives durability split.",
      why: "Anyone can say 'add ML ranking' or 'use a CDN'. The interviewer wants the latency-budget reasoning behind each, and the durability distinction that keeps storage costs sane.",
      steps: [
        { kind: "SAY", text: 'Explain candidate generation vs ranking: "The candidate set is the timeline cache plus any live celebrity pulls — a few hundred IDs. Ranking scores just that set; it never touches the whole graph, which is what keeps it inside the 200ms budget."' },
        { kind: "SAY", text: 'Name the fallback: "If the ranking service is slow or down, serve the same candidates in chronological order. A worse feed beats a failed one."' },
        { kind: "SAY", text: 'Walk the media pipeline: "Upload goes direct to blob storage via a pre-signed URL, bypassing the app tier. A worker pool derives thumbnail/feed/full resolutions and video bitrates asynchronously, and the post is visible before that finishes."' },
        { kind: "SAY", text: 'Call out the durability split: "Only the original is irreplaceable. Every derived variant can be regenerated from it, so those are safe to evict or lose."' },
      ],
      grading: "Candidate generation vs ranking clearly separated with a fallback, and the media pipeline described as async with the originals-vs-derivatives durability distinction made explicitly.",
    },
    {
      n: 6,
      title: "Wrap: Bottlenecks, Trade-offs, and Close",
      minutes: 5,
      goal: "Name the single biggest risk, push back on at least one requirement, park what's out of scope, and close in one sentence.",
      why: "Staff-level signal is operational maturity: naming the load-bearing risk unprompted, treating requirements as negotiable, and closing cleanly rather than trailing off.",
      steps: [
        { kind: "SAY", text: 'Name the single biggest risk: "The celebrity threshold is load-bearing — get it wrong and the fan-out worker pool backs up for everyone behind a hot post."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need true global consistency on like counts, or is \'eventually consistent, roughly right\' fine? That changes whether counters can be async."' },
        { kind: "SAY", text: 'Mention what\'s parked: "With more time I\'d cover stories (ephemeral, 24h TTL, mostly pull-based), DMs, and the discovery/explore ranking model."' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a hybrid fan-out system — push for the read-cheap common case, pull for the write-expensive tail — with media kept off the request path entirely."' },
      ],
      grading: "The celebrity threshold named as the single biggest risk, at least one requirement pushed back on, parked items listed, and a one-sentence close.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design with a cache in front of a database and a queue for background work, but the celebrity problem and the follow-graph shape stay unexamined.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Draws client → LB → app server → DB → cache, with a queue for 'background stuff'.",
          "Knows a feed shows posts from people you follow, roughly newest-first.",
          "Reaches for Redis as 'a cache' without sizing what's in it.",
          "Adds a CDN when prompted, for images.",
          "Handles likes/comments as normal DB rows without discussing counters.",
        ],
        gaps: [
          "Doesn't do the fan-out amplification math (100M posts × avg followers), so the celebrity problem never surfaces on its own.",
          "Follow graph is a single table with no discussion of read direction cost.",
          "No distinction between originals and derived media, or between upload ack and processing completion.",
          "Feed is either pure DB query or pure cache with no discussion of how it's kept warm.",
          "Ranking, if mentioned at all, is 'sort by engagement' with no candidate-set/latency-budget reasoning.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, names the celebrity problem before being pushed, and picks a hybrid fan-out with reasons — but doesn't always volunteer the failure-mode numbers.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes read/write QPS and the follow-graph skew on the board within the first 5 minutes.",
          "Proposes hybrid fan-out (push below a threshold, pull above it) and can defend both halves.",
          "Denormalizes the follow graph into two directional tables and explains why a join doesn't scale here.",
          "Separates candidate generation from ranking, and knows ranking needs a fallback.",
          "Describes direct-to-blob-storage uploads and async media processing.",
          "Uses counters for likes/comments instead of counting rows.",
        ],
        gaps: [
          "States the celebrity threshold as a number but doesn't quantify what breaks without it (e.g. write storm size).",
          "Mentions the ranking fallback only when asked what happens if the ranking service is down.",
          "Doesn't proactively raise the originals-vs-derivatives durability distinction until prompted about storage cost.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats the fan-out write-amplification number as the single load-bearing fact of the whole design, and brings operational judgment beyond the mechanism.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Opens by computing fan-out write amplification unprompted and states it's the same order of magnitude as the entire read path — that's the reason the design can't be push-only.",
          "Frames the celebrity threshold as a tunable operational lever, not a fixed constant, and discusses how to pick/monitor it.",
          "Volunteers that celebrity posts have zero propagation lag as a genuine upside of the pull half, not just a workaround.",
          "Names the originals-are-durable/derivatives-are-disposable storage policy before being asked about cost or durability.",
          "Pushes back on requirements (e.g. 'does like count need to be exact, or is eventually-consistent fine?') and shows how the answer changes the design.",
          "Closes with a one-sentence summary and an explicit list of what's out of scope if there were more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Fan-out on write for every account with no celebrity carve-out — the design silently breaks the first time a 10M-follower account posts.",
      "Storing full post content inside every follower's timeline cache instead of just post_id — multiplies storage by the average follower count.",
      "A single normalized follow table used for both 'who do I follow' and 'who follows me' — one direction becomes a distributed scatter-gather.",
      "Routing media uploads through the application tier instead of direct-to-blob-storage — ties up server resources on every photo/video.",
      "Treating like/comment counts as a live COUNT(*) instead of a counter — collapses under a celebrity post's like volume.",
      "No fallback for the ranking service — a ranking outage takes down the whole feed instead of degrading to chronological.",
      "No fan-out amplification math anywhere — cache size, worker pool sizing, and the celebrity threshold all become guesses.",
    ],
    followUps: [
      {
        q: "How do you pick the exact celebrity threshold?",
        a: "Pick it where the cost of pushing stops being a rounding error against total write capacity — in practice a few hundred thousand to low millions of followers. Below it, even simultaneous posts from many accounts near the threshold don't dent the fan-out worker pool's headroom; above it, one post alone would. Treat it as a tunable, monitor fan-out queue depth and worker lag, and move the line if the worker pool is consistently falling behind.",
      },
      {
        q: "What happens to a user's feed if they haven't opened the app in six months?",
        a: "Their precomputed timeline in the cache has either been evicted for cold-storage economics or is wildly stale relative to whom they now follow. Rather than keeping every inactive user's timeline warm forever, the feed service detects a stale/missing cache on their next load and does a bounded, one-time on-demand fan-out — walk their follow list live, pull recent posts, populate a fresh timeline — then serves normally from then on.",
      },
      {
        q: "Why not just always compute the feed live at read time (pull-only) — isn't precomputing premature optimization?",
        a: "At 145K reads/sec, pull-only means every single feed load fans out across ~150 authors' recent posts and merges them — that's roughly 22M lookups/sec against the post store just for feed reads, before any ranking. Precomputing collapses that to a single O(1) cache read per user; the cost gets paid once at write time and amortized across every subsequent read of that timeline, which is the right trade when reads outnumber writes ~100:1 or more.",
      },
      {
        q: "How do you keep the follow-graph's two tables consistent with each other?",
        a: "A follow/unfollow is a single logical operation that writes to both the following and followers tables; wrap it in a lightweight transaction or write to both atomically enough that a partial failure is detectable and retryable, and run a periodic reconciliation job that compares counts/samples between the two tables and repairs drift. It's eventual consistency between two denormalized copies, not a hard distributed transaction, because a follow relationship being visible a few hundred milliseconds later in one direction is a non-event.",
      },
      {
        q: "What's the actual latency budget breakdown for a feed load?",
        a: "Roughly: Redis timeline fetch a few ms, live celebrity-post pulls in parallel a few ms more, batched metadata hydration from the post store tens of ms, and the ranking pass tens of ms — leaving headroom inside the 200ms p99 for network and serialization. The two things that can blow the budget are a metadata hydration call that isn't batched (N round trips instead of one) and a ranking service that isn't bounded/timed-out with a fallback.",
      },
      {
        q: "Stories are 24-hour ephemeral posts — how would that change the fan-out design?",
        a: "Stories flip a few assumptions: the content self-expires (TTL, not permanent), and viewing is usually driven by the user actively opening a 'stories rail' rather than a passive scroll, so pull-at-open-time is often good enough without precomputing a timeline at all — you just fetch 'stories from people I follow, not yet expired' directly. The celebrity problem mostly disappears too, since you're not pushing per-viewer state, just listing active stories per author.",
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
          "This is a fan-out problem wearing a photo-sharing UI. The core tension is that precomputing feeds (push) makes reads O(1) but turns writes into O(followers), while computing feeds live (pull) makes writes O(1) but turns reads into O(follows). Every structural choice below exists to get O(1) on both sides for the overwhelming majority of traffic.",
          "Anchor everything on five numbers: 500M DAU, 100M posts/day, ~145K feed reads/sec, a ~150-average but heavily skewed follow graph, and a sub-200ms p99 feed load. The skew in that follow graph — a few accounts with 100M+ followers — is what forces a hybrid design instead of a single mechanism.",
        ],
      },
      {
        heading: "Fan-out: hybrid push and pull",
        body: [
          "Pull-only (fan-out on read) keeps writes at O(1) but makes every feed read fan out across ~150 authors — untenable at 145K reads/sec. Push-only (fan-out on write) keeps reads at O(1) but makes a celebrity post cost O(followers) — 100M+ writes in seconds for the largest accounts. Neither survives alone.",
          "The hybrid routes by a follower-count threshold (~1M): accounts below it are pushed asynchronously off a Kafka new_post event, with a worker pool that paginates the follower list and batch-pipelines writes into Redis timelines. Accounts above it skip the push entirely; the feed service pulls their handful of recent posts live at read time and merges them into the candidate set — which means celebrity posts actually reach followers with zero propagation lag, faster than the push path.",
        ],
      },
      {
        heading: "The timeline cache and the follow graph",
        body: [
          "The precomputed timeline in Redis stores only (post_id, score) pairs, capped at ~800 per user and sharded by user_id via consistent hashing — about 6TB across ~500M active timelines. Full post content is never duplicated into every follower's cache; it's hydrated from the metadata store in a batched call at read time, which is what keeps the cache small enough to stay warm at this scale.",
          "The follow graph is denormalized into two tables — following and followers — both sharded by user_id, so both 'who do I follow' and 'who follows me' are O(1) partition reads instead of a distributed join over ~300B edges. Likes and comments use counters (incremented in place, eventually consistent at the high end) rather than counting rows, since COUNT(*) over a celebrity post's likes would be far too slow.",
        ],
      },
      {
        heading: "Ranking as a bounded re-order",
        body: [
          "Ranking never touches the whole graph — it scores the same small candidate set fan-out already produced (the timeline cache plus any live celebrity pulls, a few hundred post IDs). That's what keeps a ranking pass inside the ~200ms latency budget: it's a re-order, not a re-fetch. If the ranking service is slow or unavailable, the system falls back to chronological order of the same candidates rather than failing the whole request — ranking degrades relevance, never availability.",
        ],
      },
      {
        heading: "Media: off the request path entirely",
        body: [
          "Uploads go directly from the client to blob storage via a pre-signed URL, never through the application tier, so a multi-megabyte photo or video never ties up an API pod. An async worker pool derives every resolution and video bitrate after the original lands, and the post becomes visible with a placeholder before that processing finishes.",
          "The durability policy is asymmetric on purpose: originals are treated as unrecoverable and must never be lost, while every derived variant can always be regenerated from the original, so those are safe to cache aggressively, evict under pressure, or even lose and rebuild without any user-visible data loss.",
        ],
      },
      {
        heading: "Why the celebrity threshold is the load-bearing decision",
        body: [
          "Every other piece of this design — cache sizing, worker pool capacity, the async lane's throughput — is sized against the assumption that push-based fan-out only ever touches a bounded number of followers per post. The celebrity threshold is what enforces that bound. Get it wrong (too high, or missing entirely) and one viral post backs up the fan-out worker pool for every other post queued behind it; get it too low and you lose the read-side benefit of precomputing for accounts that didn't need the pull path. Treating the threshold as a monitored, tunable operational lever — not a constant chosen once and forgotten — is what separates a design that survives a real celebrity account from one that only survives the interview.",
        ],
      },
    ],
  },
};
