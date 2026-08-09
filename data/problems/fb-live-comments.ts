import type { Problem } from "@/lib/types";

export const fbLiveComments: Problem = {
  slug: "fb-live-comments",
  num: "5.1",
  title: "Design FB Live Comments",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design the comment stream for a Facebook-style live video: viewers post text comments while a broadcast is live, and every other active viewer sees new comments appear within about 2 seconds. A single viral broadcast can hold 5M concurrent viewers and take 10K comments/sec — naively broadcasting every comment to every viewer is 50 billion deliveries/sec, so the system has to reshape that math, not just scale hardware against it.",
  ],
  hardParts:
    "The hard parts: fan-out amplification (comments/sec × viewers) grows past any single machine or naive pub/sub topology; one viral broadcast breaks the per-key sharding every other part of the stack relies on; and the whole design only works because comment delivery is allowed to be best-effort — lossy, sampled, and unordered — instead of exactly-once and strictly ordered.",
  keyTopics: [
    "Broadcast Fan-out Trees",
    "Adaptive Sampling Under Load",
    "Hot-Shard Mitigation for Viral Content",
    "WebSocket Connection Sharding",
    "Best-Effort Ordering & Load Shedding",
  ],
  foundationsReferenced: [
    { label: "Kafka", tone: "orange" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "WebSockets", tone: "blue" },
    { label: "Pub/Sub Fan-out", tone: "purple" },
    { label: "ScyllaDB", tone: "purple" },
    { label: "Backpressure & Load Shedding", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "poster", label: "Poster Client", col: 1, row: 1, tone: "slate" },
      { id: "lb", label: "Edge LB", col: 2, row: 1, tone: "slate" },
      {
        id: "ingest",
        label: "Comment Ingest Service",
        sub: "stateless · rate-limited",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "kafka", label: "Kafka", sub: "per-video partitions", col: 4, row: 1, tone: "orange" },
      { id: "scylla", label: "ScyllaDB", sub: "comment history", mono: "(video_id, seq)", col: 5, row: 1, tone: "blue" },

      {
        id: "fanout",
        label: "Fanout Workers",
        sub: "broadcast tree",
        mono: "sampled + batched",
        col: 3,
        row: 2,
        tone: "purple",
      },
      {
        id: "gateway",
        label: "WS Gateway",
        sub: "sharded by video_id",
        mono: "~250K conns/node",
        col: 4,
        row: 2,
        tone: "green",
      },
      { id: "viewer", label: "Viewer Client", col: 5, row: 2, tone: "slate" },

      { id: "moderation", label: "Moderation Service", sub: "async classifier", col: 2, row: 3, tone: "orange" },
      { id: "presence", label: "Presence / Viewer Count", col: 3, row: 3, tone: "orange" },
      {
        id: "directory",
        label: "Shard Directory",
        sub: "video_id → gateway set",
        mono: "etcd",
        col: 4,
        row: 3,
        tone: "blue",
      },
    ],
    edges: [
      { from: "poster", to: "lb", kind: "write" },
      { from: "lb", to: "ingest", kind: "write" },
      { from: "ingest", to: "kafka", label: "publish · per-video partition", kind: "write" },
      { from: "ingest", to: "scylla", label: "durable persist, async", kind: "write" },

      { from: "viewer", to: "gateway", label: "subscribe (WebSocket)", kind: "read" },
      { from: "kafka", to: "fanout", label: "consume per shard", kind: "read" },
      { from: "fanout", to: "directory", label: "lookup gateway set", kind: "read" },
      { from: "fanout", to: "gateway", label: "push, batched 250ms", kind: "read" },
      { from: "gateway", to: "viewer", label: "broadcast frame", kind: "read" },
      { from: "gateway", to: "scylla", label: "late-joiner backfill, last 50", kind: "read" },

      { from: "ingest", to: "moderation", label: "async, non-blocking", kind: "analytics" },
      { from: "moderation", to: "kafka", label: "delete/flag event", kind: "analytics" },
      { from: "gateway", to: "presence", label: "join/leave events", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read/fan-out path · deliver comments to viewers" },
      { kind: "write", text: "write path · post + persist a comment" },
      { kind: "analytics", text: "async · moderation and presence, never blocks fan-out" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Post a text comment on a live video (bounded length)", tag: "P0" },
      { id: "FR-02", text: "Deliver new comments in near-real-time to every active viewer of that video", tag: "P0" },
      { id: "FR-03", text: "A viewer who joins mid-stream sees the last ~50 comments immediately", tag: "P0" },
      { id: "FR-04", text: "Comments are durably persisted and remain available on VOD replay after the broadcast ends", tag: "P0" },
      { id: "FR-05", text: "Per-user rate limiting on posting to prevent spam floods", tag: "P0" },
      { id: "FR-06", text: "Gracefully degrade to sampled/throttled delivery instead of overloading clients on a viral video", tag: "P0" },
      { id: "FR-07", text: "Real-time moderation can retroactively delete a comment from every viewer's screen", tag: "P1" },
      { id: "FR-08", text: "Live viewer count / presence shown alongside the comment stream", tag: "P1" },
      { id: "FR-09", text: "A reconnecting viewer resumes the stream without a full replay or obvious duplicate comments", tag: "P1" },
      { id: "FR-10", text: "Broadcaster can pin or highlight a specific comment", tag: "P2" },
      { id: "FR-11", text: "Reactions (likes) on individual comments", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "End-to-end comment delivery latency, post to viewer screen, p99", tag: "< 2s" },
      { id: "NFR-02", text: "Concurrent viewers supported on a single hot broadcast", tag: "5M" },
      { id: "NFR-03", text: "Peak comment ingestion rate on the hottest video", tag: "10K/sec" },
      { id: "NFR-04", text: "Naive fan-out load the design must avoid ever materializing (comments/sec × viewers)", tag: "50B/sec" },
      { id: "NFR-05", text: "Availability of the fan-out path during a live event", tag: "99.95%" },
      { id: "NFR-06", text: "Comment durability once accepted by ingest", tag: "zero loss" },
      { id: "NFR-07", text: "WebSocket connections held per gateway node", tag: "~250K/node" },
      { id: "NFR-08", text: "Ordering guarantee on the delivered stream", tag: "best-effort" },
      { id: "NFR-09", text: "Moderation take-down propagation time", tag: "< 3s" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why naive broadcast is 50 billion deliveries/sec",
      body: [
        "Before drawing a single box, multiply the two numbers that define this problem: comments/sec on the hottest video, and concurrent viewers on that same video. At 10K comments/sec and 5M viewers, delivering every comment to every viewer is 10,000 × 5,000,000 = 50 billion message deliveries per second — for one video. That number is not a capacity problem to throw servers at; it is proof the naive design is structurally wrong and has to change shape, not just scale up.",
        "Everything else in this design exists to shrink that number: cap the rate that actually gets broadcast regardless of how fast comments are posted, and spread the remaining fan-out across many gateway nodes instead of one hub.",
      ],
      bullets: [
        { lead: "Ingestion vs. delivery", text: "the system can accept and store all 10K comments/sec — that part is a normal write-heavy pipeline. The explosion is purely on the delivery side, multiplied by viewer count." },
        { lead: "Display budget", text: "cap the broadcast stream at roughly 5 comments/sec per video, chosen by priority (pinned, verified, then sampled), independent of how many comments are actually being posted." },
        { lead: "Still large, now tractable", text: "5M viewers × 5 comments/sec ≈ 25M deliveries/sec for one video — still big, but now it is a fan-out tree and connection-sharding problem, not a 2000× overload." },
      ],
      pictureTitle: "Why you can't just broadcast every comment",
      pictureCaption: "naive: 10K comments/s × 5M viewers = 50B deliveries/s · capped: 5 shown/s × 5M viewers ≈ 25M deliveries/s",
      pictureRows: [
        { label: "Naive broadcast", value: "50B deliveries/sec — impossible", tone: "bad" },
        { label: "Capped display rate", value: "≈25M deliveries/sec — a fan-out problem", tone: "good" },
      ],
      remember: {
        problem: "Naively pushing every comment to every viewer multiplies to an impossible number.",
        solution: "Cap the broadcast rate per video (a display budget, e.g. ~5/sec) independent of the true posting rate.",
        why: "Fan-out cost is comments/sec × viewers; the only lever big enough to fix a 2000× overload is capping one side of that multiplication.",
        tradeoff: "Most posted comments on a viral video are never shown live — they're sampled/prioritized, though all of them are still stored.",
        failure: "Ship without a display cap and a viral video's fan-out saturates every gateway node's NIC and CPU simultaneously.",
        mitigation: "Enforce the cap at the fanout layer, before it ever reaches a gateway node, and prioritize pinned/verified comments within it.",
      },
    },
    {
      n: 2,
      title: "Broadcast fan-out tree, not a single hub",
      body: [
        "Even a capped ~25M deliveries/sec can't come out of one process. Split the problem into two layers: Fanout Workers consume the video's Kafka partition(s) and know which Gateway nodes currently hold subscribers for that video (via a Shard Directory); Gateway nodes hold the actual WebSocket connections and push to their local viewers. This is a tree, not a hub — the Fanout layer forwards to N gateway nodes, each of which forwards to its own ~250K connections, so no single process ever touches the full viewer count.",
      ],
      bullets: [
        { lead: "Fanout Workers", text: "stateless consumers of a video's Kafka partition; they don't hold connections, only the routing fan-out to gateway nodes." },
        { lead: "Shard Directory", text: "a small etcd/ZooKeeper-style registry mapping video_id → the set of gateway nodes currently serving that video's viewers, updated on connect/disconnect." },
        { lead: "Gateway nodes", text: "hold the actual WebSocket connections, batch outgoing comments into a single frame per tick, and are the only layer that scales with viewer count." },
        { lead: "5M viewers ÷ 250K/node", text: "≈20 gateway nodes minimum for one viral video; run with real headroom (~40) so a node loss doesn't cascade." },
      ],
      pictureTitle: "Hub vs. tree",
      pictureRows: [
        { label: "Single hub pushes to 5M sockets", value: "one process, one NIC — falls over", tone: "bad" },
        { label: "Fanout → ~40 gateway nodes → sockets", value: "load spread, no single point melts", tone: "good" },
      ],
      remember: {
        problem: "No single process can hold or push to millions of concurrent connections.",
        solution: "Two-layer broadcast tree: Fanout Workers route by video_id, Gateway nodes hold ~250K connections each.",
        why: "Splitting routing (Fanout) from connection-holding (Gateway) lets each layer scale independently on its own bottleneck (CPU/fan-out logic vs. socket count/bandwidth).",
        tradeoff: "An extra hop of latency and an extra piece of routing state (the Shard Directory) to keep consistent.",
        failure: "A flat topology means the busiest video's traffic all transits one node, which saturates before viewer count does.",
        mitigation: "Cap connections per gateway node and let the directory route new subscribers to whichever nodes have headroom.",
      },
    },
    {
      n: 3,
      title: "The hot-shard problem: one video breaks your sharding",
      body: [
        "Everything upstream assumes comments spread evenly across many videos, sharded by video_id hash across a fixed number of Kafka partitions. A viral broadcast breaks that assumption the same way a viral link breaks a hash-sharded cache: one video_id can generate more traffic than an entire shard was provisioned for, while thousands of other videos sit nearly idle on their own partitions.",
      ],
      bullets: [
        { lead: "Normal case", text: "video_id hashed across, say, 4096 Kafka partitions — each partition's consumer keeps up easily because traffic is spread thin." },
        { lead: "Viral case", text: "10K comments/sec lands on the single partition owning that video_id; one Fanout Worker consuming it can't keep up alone." },
        { lead: "Fix: dynamic repartitioning", text: "detect the hot video_id (by ingest rate) and pin it to a dedicated set of partitions (e.g. 32) so multiple Fanout Workers parallelize consumption just for that video." },
        { lead: "Detection, not prevention", text: "you can't provision every video for viral load; you provision the system to detect and react to a hot key within seconds." },
      ],
      pictureTitle: "One video, one partition, one bottleneck",
      pictureRows: [
        { label: "Cold video on shared partition", value: "fine — traffic is thin", tone: "good" },
        { label: "Viral video on shared partition", value: "one consumer, 10K/sec — falls behind", tone: "bad" },
        { label: "Viral video pinned to 32 partitions", value: "many consumers share the load", tone: "good" },
      ],
      remember: {
        problem: "Per-key sharding (video_id hash) assumes even traffic; one viral video violates that.",
        solution: "Detect the hot video_id by ingest rate and dynamically pin it to a dedicated set of partitions/consumers.",
        why: "A single partition has a fixed consume ceiling; the only way past it is more parallel consumers on that specific key.",
        tradeoff: "Repartitioning adds operational complexity and a brief window where the hot video lags before remediation kicks in.",
        failure: "Leave it on one partition and comment delivery for the single most-watched video in the system falls behind everyone else's.",
        mitigation: "Auto-detect via ingest-rate alerting and repartition before the consumer lag becomes visible to viewers.",
      },
    },
    {
      n: 4,
      title: "Adaptive sampling: choosing which comments get shown",
      body: [
        "Once the display budget (learn 1) says only ~5 comments/sec get broadcast, someone has to choose which ones. This isn't random dropping — it's a small priority pipeline applied at the Fanout layer before a comment ever reaches a Gateway node, so the choice is made once per video, not once per viewer.",
      ],
      bullets: [
        { lead: "Priority tiers", text: "pinned/broadcaster comments always pass; verified accounts get a higher sampling weight; everything else is reservoir-sampled down to the remaining budget." },
        { lead: "One sampled stream, not N", text: "all viewers of a video see the same sampled subset — sampling once per video keeps the cost independent of viewer count, instead of re-sampling per connection." },
        { lead: "Store everything anyway", text: "the full unsampled stream still lands in Kafka → ScyllaDB, so nothing is lost for moderation, VOD replay, or analytics — only the live broadcast is thinned." },
      ],
      pictureTitle: "What gets broadcast vs. what gets stored",
      pictureRows: [
        { label: "Posted comments", value: "10K/sec — all persisted to Scylla", tone: "neutral" },
        { label: "Broadcast comments", value: "~5/sec — pinned + verified + sampled", tone: "used" },
        { label: "Sampling cost", value: "once per video, shared by all viewers", tone: "good" },
      ],
      remember: {
        problem: "The display budget forces a choice about which comments viewers actually see live.",
        solution: "A priority pipeline (pinned → verified → reservoir sample) applied once per video at the Fanout layer.",
        why: "Sampling once per video, not per connection, keeps the cost of the choice flat regardless of viewer count.",
        tradeoff: "Most viewers never see most comments live — an intentional product trade, softened by full history being queryable.",
        failure: "Sample independently per viewer and the compute cost of sampling itself now scales with viewer count, defeating the point.",
        mitigation: "Compute the sampled stream once at Fanout and replicate the identical result down the broadcast tree.",
      },
    },
    {
      n: 5,
      title: "Late joiners and VOD: ScyllaDB as the backfill source",
      body: [
        "A viewer opening a live video mid-stream needs recent context immediately, not a live-only view of comments from that instant forward. Rather than replaying a Kafka topic from an arbitrary offset (slow, and topics aren't indexed for point lookups), the Gateway node fetches the last ~50 comments directly from ScyllaDB, keyed by (video_id, seq desc), and serves that as an instant snapshot before subscribing the connection to the live tree.",
      ],
      bullets: [
        { lead: "Schema", text: "partition key video_id, clustering key seq (a per-video monotonic sequence assigned at ingest) — a single range query returns the last N comments." },
        { lead: "Snapshot then subscribe", text: "the Gateway serves the ScyllaDB snapshot first, then attaches the connection to the live Fanout feed, avoiding a gap or a duplicate in the common case." },
        { lead: "VOD replay", text: "after the broadcast ends, the same table backs scroll-through of the full comment history against the recorded video — no separate archival pipeline needed." },
      ],
      pictureTitle: "Late joiner: snapshot, then live",
      pictureRows: [
        { label: "Kafka offset replay", value: "not indexed for point lookups — rejected", tone: "bad" },
        { label: "ScyllaDB range query (video_id, seq)", value: "single query, last 50, instant", tone: "good" },
        { label: "Snapshot → subscribe", value: "context first, then the live tree", tone: "neutral" },
      ],
      remember: {
        problem: "A mid-stream joiner needs recent context without replaying the entire comment history.",
        solution: "ScyllaDB keyed by (video_id, seq); Gateway fetches last ~50 as a snapshot, then subscribes to the live feed.",
        why: "Kafka is a log, not an index — point lookups by video need a store built for range queries, which also doubles as the VOD backing store.",
        tradeoff: "One extra read per new connection, but it's a single bounded range query, not a stream replay.",
        failure: "Skip the snapshot and a late joiner sees a blank stream until the next comment happens to be posted.",
        mitigation: "Always snapshot-then-subscribe, and reuse the same table for post-broadcast VOD scroll-back.",
      },
    },
    {
      n: 6,
      title: "Ordering, reconnection, and why 'best-effort' is the point",
      body: [
        "Mobile networks drop WebSocket connections constantly, and comments themselves don't need strict global ordering — a comment landing half a second out of order is invisible to a human scrolling a live feed. Design around that relaxation instead of fighting it: each comment carries a per-video monotonic seq for gap detection, but delivery itself is fire-and-forget, and load shedding drops rather than queues under pressure.",
      ],
      bullets: [
        { lead: "Reconnect protocol", text: "the client remembers the last seq it rendered; on reconnect it re-snapshots from ScyllaDB starting after that seq, tolerant of a small gap or a harmless duplicate at the boundary." },
        { lead: "No unbounded queues", text: "if a Gateway node's outbound buffer for a connection backs up (slow client, congested network), drop the oldest queued frames rather than let memory grow — a dropped live comment is invisible; a crashed gateway node is not." },
        { lead: "Ordering within a batch only", text: "comments are ordered within a single 250ms batch frame by seq; no guarantee is made across gateway nodes or across reconnects." },
      ],
      pictureTitle: "What 'best-effort' actually buys you",
      pictureRows: [
        { label: "Exactly-once, strict order", value: "not attempted — needs an unsheddable queue", tone: "bad" },
        { label: "Best-effort, seq-tagged", value: "load-sheddable, reconnect-tolerant", tone: "good" },
        { label: "Gap on reconnect", value: "acceptable — resnapshot, don't replay", tone: "neutral" },
      ],
      remember: {
        problem: "Strict ordering and exactly-once delivery would require unbounded queues that can't survive load spikes.",
        solution: "Per-video monotonic seq for gap detection only; delivery is fire-and-forget with bounded, sheddable buffers.",
        why: "A dropped or reordered comment is invisible to a human scrolling; a gateway node that OOMs from an unbounded queue is not.",
        tradeoff: "You explicitly accept that some comments some viewers never see live, in exchange for a system that degrades instead of falling over.",
        failure: "Guarantee strict delivery and the first viral spike backs up every gateway node's queues until they crash.",
        mitigation: "Bounded per-connection buffers with drop-oldest semantics, plus a reconnect protocol that re-snapshots rather than replays.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a broadcast fan-out problem, not a lookup problem: one comment goes out to millions of viewers of the same video, and the naive math (comments/sec × viewers) is impossible at scale.",
      "Fix the math first: cap the broadcast display rate (~5/sec/video) independent of posting rate, and sample once per video, not once per viewer.",
      "Fan out through a tree — Fanout Workers route by video_id, Gateway nodes hold the actual ~250K connections each — so no single process touches the full viewer count.",
      "A viral video breaks normal video_id sharding; detect the hot key and dynamically pin it to more Kafka partitions and consumers.",
      "Delivery is deliberately best-effort: bounded, sheddable buffers and a reconnect-by-resnapshot protocol beat strict ordering that can't survive a load spike.",
    ],
    flows: [
      {
        kind: "write",
        title: "WRITE · POST A COMMENT · 10K/S PEAK",
        summary:
          "A comment is rate-limited, sequenced, and durably persisted before anything about broadcasting it is even considered. Ingest never blocks on moderation or fan-out.",
        steps: [
          { label: "Poster Client", note: "submits comment text" },
          { label: "Edge LB", note: "routes to nearest region" },
          { label: "Comment Ingest Service", note: "auth, per-user rate limit, assigns seq" },
          { label: "Kafka", note: "publish to video's partition(s)" },
          { label: "ScyllaDB", note: "durable persist, (video_id, seq)" },
        ],
      },
      {
        kind: "read",
        title: "READ/FAN-OUT · DELIVER TO VIEWERS · < 2S P99",
        summary:
          "The Fanout layer consumes the video's partition, applies the sampling budget once, and pushes a batched frame down to every gateway node holding that video's subscribers.",
        steps: [
          { label: "Kafka", note: "per-video partition(s)" },
          { label: "Fanout Workers", note: "sample to display budget, ~5/sec" },
          { label: "Shard Directory", note: "video_id → gateway node set" },
          { label: "WS Gateway", note: "batch into one frame per 250ms tick" },
          { label: "Viewer Client", note: "renders batched frame" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · MODERATION & PRESENCE · NEVER BLOCKS FAN-OUT",
        summary:
          "Moderation runs off the ingest path and can retroactively delete; presence counts join/leave events. Neither adds latency to a live comment appearing on screen.",
        steps: [
          { label: "Comment Ingest Service", note: "emits async, non-blocking" },
          { label: "Moderation Service", note: "classifier, flags/deletes" },
          { label: "Kafka", note: "delete event, same fan-out path" },
          { label: "Presence Service", note: "join/leave from Gateway" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "5M concurrent viewers on a hot broadcast; 10K comments/sec peak ingestion",
          "Naive fan-out: 10K × 5M = 50B deliveries/sec — the number that forces the whole design",
          "Display budget: ~5 comments/sec shown per video, sampled once, not per viewer",
          "~250K WebSocket connections per gateway node ⇒ ~20 nodes minimum, ~40 with headroom",
          "Late-joiner backfill: last 50 comments via a single ScyllaDB range query",
          "p99 end-to-end delivery < 2s; moderation take-down propagation < 3s",
          "Batch tick: 250ms per gateway frame, ordered within the frame only",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Cap the broadcast rate independent of posting rate, instead of trying to deliver everything",
          "Two-layer broadcast tree: Fanout Workers (routing) separate from Gateway nodes (connections)",
          "Sample once per video at Fanout, not once per viewer at Gateway",
          "Dynamically repartition Kafka for a detected hot video_id instead of over-provisioning every video",
          "ScyllaDB (video_id, seq) doubles as late-joiner snapshot source and VOD history",
          "Best-effort delivery: bounded sheddable buffers, reconnect-by-resnapshot, no unbounded queues",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The 50B-deliveries/sec naive math is why this isn't just 'add a pub/sub and scale horizontally'",
          "Hot-shard detection and dynamic repartitioning, not just static video_id hashing",
          "Ordering and exactly-once delivery are explicitly not the goal — say why that's the right trade",
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
      goal: "Get the two numbers that make this problem hard — comments/sec and concurrent viewers on the hottest video — and multiply them out loud before drawing anything.",
      why: "This design only makes sense once the interviewer hears you say the naive fan-out number is impossible. Locking scale first is what justifies every non-obvious choice (sampling, the fan-out tree, hot-shard repartitioning) later.",
      steps: [
        { kind: "ASK", text: '**"How many concurrent viewers on the hottest broadcast, and what\'s the peak comment rate?"** Land on "5M viewers", "10K comments/sec". Write **"5M viewers, 10K c/s"** in the top-left corner.' },
        { kind: "WRITE", text: 'Multiply it out loud: **"10K × 5M = 50 billion deliveries/sec if I broadcast every comment to every viewer — that\'s impossible, so the design has to change shape, not just scale up."** Write **"naive = 50B/s — rejected"** on the board.' },
        { kind: "SAY", text: 'Propose the latency target yourself: **"sub-2s p99 end-to-end, post to screen"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "posting", "real-time fan-out", "late-joiner backfill", "moderation take-down", "reconnection". Out: "reactions", "pinning", "auth". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "ASK", text: '**"Does ordering need to be strict, or is best-effort okay?"** Land on best-effort — a comment appearing half a second out of order is invisible to a human. Write **"best-effort, no global order"** on the board.' },
      ],
      grading: "Did the naive-math multiplication happen unprompted, in writing, before any boxes were drawn? That single number is the strongest early signal in this interview.",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two endpoints (post, subscribe) and one comment row, with the sequencing scheme that everything downstream depends on.",
      why: "The interviewer wants to see the seq field land early — it's what makes gap detection, reconnection, and the ScyllaDB backfill query all work later without extra explanation.",
      steps: [
        { kind: "WRITE", text: 'Write the surface: **"POST /videos/:id/comments { text }"** returns **"{ seq }"**, rate-limited per user. **"WS /videos/:id/subscribe"** streams batched comment frames, latency-critical, uncapped fan-in.' },
        { kind: "DRAW", text: 'Sketch the row: **"video_id (partition key)"**, **"seq (clustering key, monotonic per video)"**, **"user_id"**, **"text"**, **"created_at"**, **"deleted (bool)"**. Say: "seq is what lets a late joiner query \'last 50\' with one range scan, and lets a reconnecting client say \'send me anything after seq N\'."' },
        { kind: "SAY", text: 'Justify the storage choice: "ScyllaDB — wide-column, partitioned by video_id, so one video\'s comments are colocated and a range query is cheap. It doubles as the VOD backing store after the broadcast ends."' },
        { kind: "RULE OUT", text: '"A relational table with a global auto-increment PK would serialize writes across every video in the system — wrong shape for a write pattern that\'s naturally partitioned by video_id." Cross it off.' },
      ],
      grading: "Two endpoints, a schema with seq as clustering key, and an explicit reason ScyllaDB partitioned by video_id beats a single relational table.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: write (post), read/fan-out (deliver), async (moderation + presence). Label arrows with rates, not box names.",
      why: "Drawing fan-out as its own lane — separate from a simple write path — is the whole signal. It proves you see that 'deliver to millions' is a fundamentally different problem from 'store one comment', which most candidates conflate.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write lane**: Poster Client → Edge LB → Comment Ingest Service → Kafka + ScyllaDB. Label **"10K c/s peak"**, **"rate-limited per user"**.' },
        { kind: "DRAW", text: 'Add the **fan-out lane** as its own row: Kafka → Fanout Workers → WS Gateway (× ~40 nodes) → Viewer Client. Label **"sampled to ~5/s"**, **"~250K conns/node"**, **"250ms batch tick"**.' },
        { kind: "DRAW", text: 'Add the **async lane**: Ingest → Moderation Service (dashed) → Kafka delete event, feeding back into the same fan-out lane. Also Gateway → Presence Service. Label **"never blocks fan-out"**.' },
        { kind: "SAY", text: 'Narrate the split: "Write is a normal durable pipeline. Fan-out is the hard problem — it\'s a tree, not a hub, because no single process can hold millions of connections or push to them directly."' },
      ],
      grading: "Three clearly separated lanes with the fan-out lane visually distinct from the write lane, rates on the arrows, and an explicit statement that async never blocks live delivery.",
    },
    {
      n: 4,
      title: "Deep Dive: Fan-out and Sampling at Scale",
      minutes: 8,
      goal: "Defend the display-budget sampling and the two-layer broadcast tree as the direct fix for the 50B/sec number from phase 1.",
      why: "This is the signature sub-problem. The interviewer is checking whether you can turn 'impossible number' into a concrete architecture, not just wave at 'use a pub/sub'.",
      steps: [
        { kind: "SAY", text: 'Reconnect to the opening math: "We rejected broadcasting everything. Instead we cap what\'s actually shown live — a display budget of roughly 5 comments/sec per video — independent of how fast comments are posted."' },
        { kind: "SAY", text: 'Explain the priority pipeline: "Pinned comments always pass, verified accounts get weighted higher, everything else is reservoir-sampled to fill the remaining budget — computed once per video at the Fanout layer, not once per viewer."' },
        { kind: "DRAW", text: 'Draw the two-layer tree explicitly: Fanout Workers (routing, via a Shard Directory) → Gateway nodes (connections). "5M viewers ÷ 250K per node ≈ 20 nodes minimum, we\'d run ~40 for headroom."' },
        { kind: "RULE OUT", text: '"A single hub process pushing to every socket" → one NIC, one CPU, falls over immediately. "Per-viewer independent sampling" → the sampling cost itself now scales with viewer count, which defeats the point.' },
      ],
      grading: "The 50B → capped budget → tree logic stated as one coherent chain, sampling explained as computed once per video, and the connections-per-node math shown on the board.",
    },
    {
      n: 5,
      title: "Deep Dive: Hot Shard and Late-Joiner Replay",
      minutes: 7,
      goal: "Show that a viral video breaks normal video_id sharding, and that late joiners need a snapshot query, not a log replay.",
      why: "This is where staff-level candidates separate from senior ones: naming that per-key sharding assumptions break under one outlier key, and fixing it with detection + dynamic remediation rather than static over-provisioning.",
      steps: [
        { kind: "SAY", text: '"Normally video_id hashes across thousands of Kafka partitions and traffic is thin per partition. A viral video puts 10K/sec on one partition — one consumer can\'t keep up." Write **"1 partition, 10K/s → falls behind"**.' },
        { kind: "SAY", text: '"The fix is detection, not prevention: alert on ingest rate per video_id, then dynamically pin the hot video to a dedicated set of, say, 32 partitions so multiple Fanout Workers parallelize it."' },
        { kind: "SAY", text: 'Pivot to late joiners: "A Kafka topic isn\'t indexed for point lookups by video, so a new viewer doesn\'t replay the log — the Gateway does one ScyllaDB range query on (video_id, seq) for the last 50, serves that as a snapshot, then subscribes to the live tree."' },
        { kind: "SAY", text: '"That same table is the VOD backing store after the broadcast ends — no separate archival pipeline."' },
      ],
      grading: "Names the hot-shard problem as a broken sharding assumption (not just \'add more servers\'), proposes detection + dynamic repartitioning, and gives the snapshot-then-subscribe answer for late joiners without prompting.",
    },
    {
      n: 6,
      title: "Wrap: Ordering, Reconnection, and Close",
      minutes: 5,
      goal: "State the best-effort delivery philosophy explicitly, cover reconnection, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal here is knowing which guarantees to deliberately not make. Explicitly defending best-effort delivery — and explaining why strict ordering would be worse, not just harder — is what closes the interview strong.",
      steps: [
        { kind: "SAY", text: '"Delivery is best-effort by design: a dropped or reordered comment is invisible to someone scrolling a live feed, but a gateway node OOMing from an unbounded queue is very visible. So buffers are bounded and drop-oldest under pressure."' },
        { kind: "SAY", text: '"Reconnection is resnapshot-based, not replay-based: the client remembers the last seq it rendered, and on reconnect just re-runs the late-joiner snapshot query starting after that seq. A small gap or boundary duplicate is acceptable."' },
        { kind: "SAY", text: 'Push back where useful: "Do we actually need best-effort ordering globally, or per-gateway-node is fine? That changes whether we need any cross-node coordination at all — I\'d default to per-node only."' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a broadcast fan-out problem solved by capping the display rate and routing through a two-layer tree, with best-effort delivery as a deliberate trade for resilience. With more time I\'d cover reactions, comment pinning, and abuse-pattern detection beyond simple rate limits."' },
      ],
      grading: "Explicit defense of best-effort as a deliberate choice (not a shortcut), the resnapshot reconnection protocol stated cleanly, and a crisp closing summary with parked items.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working post-and-fetch comment system, adds WebSockets when prompted, but doesn't confront the fan-out math.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, a queue, a database, WebSocket or long-polling for real-time delivery.",
          "Knows comments need to be persisted and can sketch a reasonable schema.",
          "Adds rate limiting on posting when asked about spam.",
          "Mentions 'pub/sub' as the fan-out mechanism.",
          "Handles late joiners by fetching some recent comments from the database.",
        ],
        gaps: [
          "Never multiplies comments/sec by viewer count — treats fan-out as 'just push to everyone subscribed'.",
          "No sampling or display-budget concept; assumes every comment reaches every viewer.",
          "Single flat pub/sub topology with no notion of a fan-out tree or per-node connection limits.",
          "Doesn't notice that per-video_id sharding breaks under one viral video.",
          "Treats ordering and delivery guarantees as 'exactly-once, in order' without examining the cost.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, confronts the fan-out math, and builds a real two-layer broadcast tree with sampling.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Computes the naive fan-out number (comments/sec × viewers) unprompted and uses it to justify sampling.",
          "Designs the two-layer tree: Fanout Workers for routing, Gateway nodes for connections, with a rough per-node connection budget.",
          "Explains late-joiner backfill via a ScyllaDB range query rather than a log replay.",
          "States that delivery is best-effort and explains the reconnect-by-resnapshot approach.",
          "Names per-user rate limiting and async moderation without prompting.",
        ],
        gaps: [
          "Brings up the hot-shard problem only when the interviewer specifically pushes on 'what if one video gets huge'.",
          "Sampling logic is described qualitatively ('we sample some') without the once-per-video-not-per-viewer distinction.",
          "Doesn't proactively size gateway node count from the connection budget; gives it only when asked.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, reframes 'broadcast every comment' as the wrong goal from minute one, and treats degraded delivery as a designed property, not a compromise.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Opens by computing the impossible naive number and uses it to justify every subsequent non-obvious choice, rather than treating sampling as a bolt-on.",
          "Volunteers the hot-shard problem unprompted — names that per-key sharding is a system-wide assumption that one viral video violates, and proposes detection + dynamic repartitioning.",
          "Explains sampling-once-per-video as a cost argument (compute cost must stay flat regardless of viewer count), not just a product argument.",
          "Frames best-effort delivery and bounded/sheddable buffers as the reason the system survives a spike, explicitly contrasting with what an exactly-once design would do under the same load (crash).",
          "Pushes back on requirements ('do we need global ordering or just per-node ordering?') and explains the operational cost each guarantee buys.",
          "Closes with a one-sentence summary of the whole system and explicitly lists what's out of scope.",
          "Treats the interviewer as a collaborator, paces the 40 minutes, and returns to parked topics only if time allows.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Never computing the naive fan-out number (comments/sec × viewers) — treating 'pub/sub it' as a sufficient answer at any scale.",
      "Designing exactly-once, strictly-ordered delivery for a live comment stream, then not noticing that guarantee requires unbounded queues under load.",
      "One flat pub/sub topology with no per-node connection limit — implicitly assuming a single process can hold millions of sockets.",
      "No hot-shard story: assuming video_id hashing spreads load evenly even under a single viral outlier.",
      "Sampling described as happening per-viewer instead of per-video, silently multiplying the compute cost by viewer count.",
      "Putting moderation or presence tracking on the ingest write path, so a classifier hiccup adds latency to every comment post.",
      "No reconnection story — a dropped WebSocket either replays the entire history or loses all context on resume.",
    ],
    followUps: [
      {
        q: "Why not just use a message broker's native fan-out (e.g., a Kafka consumer group per viewer) instead of a custom Gateway layer?",
        a: "Kafka consumer groups are built for a bounded number of consumers coordinating partition ownership — not for millions of ephemeral per-viewer subscriptions with connect/disconnect churn every second. You'd be asking Kafka's rebalance protocol to do WebSocket connection management, which it isn't built for and would fall over well before 5M consumers. The Gateway layer exists specifically to hold that many long-lived connections efficiently (event-loop based, ~250K/node) while Kafka stays doing what it's good at: a small number of Fanout Worker consumers per video partition.",
      },
      {
        q: "How do you handle a comment that gets deleted by moderation after it's already been broadcast?",
        a: "The delete is a second event through the exact same pipeline — Moderation Service emits a delete event keyed by (video_id, seq) into Kafka, which Fanout Workers pick up and push down the same broadcast tree as a 'remove seq N' instruction to connected clients, typically inside 3s. The ScyllaDB row is marked deleted rather than physically removed immediately, so audit/appeal is still possible, and the late-joiner snapshot query filters deleted rows out.",
      },
      {
        q: "What happens to viewers when a Gateway node crashes mid-broadcast?",
        a: "Every WebSocket connection held by that node drops. Clients detect the disconnect and reconnect through the Edge LB, which routes them to a healthy Gateway node; the Shard Directory is updated to reflect the new node holding those subscribers so Fanout Workers route to it. Each reconnecting client re-runs the late-joiner snapshot query (last 50 comments after its last-seen seq) rather than trying to resume an in-flight stream, so a node crash looks like a brief gap and a resnapshot, not data loss.",
      },
      {
        q: "Why cap the display rate instead of just giving faster clients more comments and slower clients fewer?",
        a: "Per-client differentiated rates would mean computing a different sampled subset per viewer, which makes the sampling cost scale with viewer count again — exactly the multiplication we were trying to eliminate. A single shared sampled stream, computed once per video, keeps that cost flat. If a specific client's connection is too slow to keep up with even the shared stream, that's handled locally at its Gateway connection buffer (drop-oldest), not by re-deriving a personalized sample upstream.",
      },
      {
        q: "How would you detect a video is about to go viral before it overwhelms a single Kafka partition?",
        a: "Track a short rolling window (e.g. 5-10s) of ingest rate per video_id at the Comment Ingest Service or as a Kafka consumer-lag metric per partition; cross a threshold (say, sustained > 1K comments/sec) and trigger the repartitioning workflow — allocate a dedicated partition set for that video_id, migrate its Fanout Workers to consume from the new set, and update the Shard Directory. The detection window trades a few seconds of lag during the transition against not statically over-provisioning every video for a viral spike that mostly never comes.",
      },
      {
        q: "Does this design assume all live videos are equally important, or does it prioritize?",
        a: "No — most of the ~500K concurrently active videos at any time have small, thin audiences and never come close to needing sampling or dedicated partitions; the design's extra machinery (display budget, hot-shard repartitioning, wide gateway fan-out) only activates for the handful of videos crossing real thresholds. That asymmetry (a Zipf-like distribution of viewer counts across videos) is itself worth naming: the system is provisioned for the average case and remediates the outliers, rather than over-building every video for worst-case load.",
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
          "This is a broadcast fan-out problem wearing a comments UI. The hard part isn't storing a comment — that's a normal write-heavy pipeline — it's delivering it to potentially millions of concurrent viewers of the same video without the delivery cost multiplying past what any real system can do.",
          "Anchor everything on two numbers: 5M concurrent viewers and 10K comments/sec on the hottest broadcast. Multiplied naively, that's 50 billion deliveries/sec for a single video. Every non-obvious design choice below exists to make that number tractable, not to add features.",
        ],
      },
      {
        heading: "Shrinking the fan-out math",
        body: [
          "The first move is separating ingestion from delivery: accept and durably store every posted comment (10K/sec is a normal write load for Kafka + ScyllaDB), but cap what actually gets broadcast live at a fixed display budget — roughly 5 comments/sec per video — regardless of how fast comments are being posted.",
          "That budget is filled by a priority pipeline computed once per video: pinned/broadcaster comments always pass, verified accounts are weighted higher, and the remainder is reservoir-sampled to fill what's left. Computing it once per video (not once per viewer) keeps the sampling cost flat regardless of viewer count — the second half of taming the multiplication.",
        ],
      },
      {
        heading: "The two-layer broadcast tree",
        body: [
          "Even at a capped ~25M deliveries/sec for one viral video, no single process can hold the connections or push the traffic. The system splits into Fanout Workers, which consume a video's Kafka partition(s) and know (via a small Shard Directory) which Gateway nodes hold that video's current subscribers, and Gateway nodes, which hold the actual WebSocket connections and batch outgoing comments into one frame per 250ms tick.",
          "At roughly 250K connections per Gateway node, 5M viewers need about 20 nodes at minimum, run with real headroom (~40) so losing one node doesn't cascade. Fanout Workers forward to only the Gateway nodes actually serving a given video, so no layer ever touches the full viewer count directly.",
        ],
      },
      {
        heading: "The hot-shard problem",
        body: [
          "Every other part of the stack assumes video_id hashes evenly across a fixed number of Kafka partitions, which holds for the overwhelming majority of videos and breaks completely for the one going viral: 10K comments/sec landing on a single partition outruns any one consumer.",
          "The fix is detection plus dynamic remediation, not static over-provisioning: monitor ingest rate per video_id, and when a video crosses a threshold, pin it to a dedicated set of partitions (e.g. 32) so multiple Fanout Workers can parallelize consumption just for that video. Most of the ~500K concurrently active videos never trigger this; the system is sized for the average case and reacts to outliers.",
        ],
      },
      {
        heading: "Late joiners, reconnection, and VOD",
        body: [
          "A viewer joining mid-stream needs recent context instantly. Rather than replaying an unindexed Kafka log, the Gateway runs a single ScyllaDB range query on (video_id, seq desc) for the last ~50 comments, serves it as a snapshot, then subscribes the connection to the live tree. The same table backs VOD scroll-back after the broadcast ends, with no separate archival pipeline.",
          "Reconnection after a dropped WebSocket uses the identical mechanism: the client remembers the last seq it rendered and re-runs the snapshot query starting after that point. A small gap or a harmless boundary duplicate is an accepted cost, not a bug to eliminate.",
        ],
      },
      {
        heading: "Why best-effort delivery is the right goal, not a shortcut",
        body: [
          "Strict ordering and exactly-once delivery would require queues that can never be shed under load — and a live comment feed doesn't need either: a comment rendered half a second out of order or occasionally dropped is invisible to a human scrolling. Designing for that relaxation directly is what lets Gateway nodes use bounded, drop-oldest outbound buffers instead of unbounded ones that OOM under a spike.",
          "Moderation and presence run entirely off the write path — async, non-blocking — so a classifier hiccup or a presence-count delay never adds latency to a comment appearing on screen. That explicit tiering (fast/best-effort live delivery vs. best-effort side systems) is what makes the whole design survive its own worst day instead of guaranteeing correctness until the moment it doesn't.",
        ],
      },
    ],
  },
};
