import type { Problem } from "@/lib/types";

export const strava: Problem = {
  slug: "strava",
  num: "5.2",
  title: "Design Strava",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design Strava: 100M registered athletes uploading 10M GPS-tracked activities/day (~115/sec sustained, ~800/sec at the Saturday-morning peak), each matched against 30M+ public route segments to update live leaderboards, fanned out into a social feed with kudos and comments, and aggregated — without ever exposing a user's home address — into a global heatmap.",
  ],
  hardParts:
    "The hard parts: matching a noisy GPS trace against millions of candidate segments fast enough to feel instant, fanning out an activity to a social graph that ranges from 50 followers to 5 million without either path collapsing, and enforcing privacy zones so a redacted home address never leaks through a cache, a leaderboard, or a heatmap tile.",
  keyTopics: [
    "Geospatial Segment Matching (S2 Cells)",
    "Redis Sorted-Set Leaderboards",
    "Hybrid Feed Fan-out",
    "GPS Polyline Compression",
    "Privacy-Zone Redaction Order",
  ],
  foundationsReferenced: [
    { label: "Geohashing / S2 Cells", tone: "blue" },
    { label: "Redis Sorted Sets", tone: "purple" },
    { label: "Kafka", tone: "orange" },
    { label: "Cassandra / Wide-Column Stores", tone: "blue" },
    { label: "Fan-out on Write vs Read", tone: "green" },
    { label: "Consistent Hashing", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "mobile app / GPS watch", col: 1, row: 1, tone: "slate" },
      { id: "feed_svc", label: "Feed Service", sub: "stateless", col: 2, row: 1, tone: "green" },
      { id: "feed_cache", label: "Redis Timeline", sub: "cached feed pages", col: 3, row: 1, tone: "green" },
      { id: "leaderboard", label: "Redis Leaderboards", sub: "per-segment sorted sets", col: 4, row: 1, tone: "green" },
      {
        id: "upload_svc",
        label: "Upload Service",
        sub: "stateless · 800/s peak",
        mono: "GPX/FIT/TCX → delta+polyline",
        col: 2,
        row: 2,
        tone: "purple",
      },
      { id: "blob", label: "S3", sub: "raw file + encoded polyline", col: 3, row: 2, tone: "blue" },
      { id: "activity_db", label: "Activity DB", sub: "Cassandra · by athlete_id", col: 4, row: 2, tone: "blue" },
      { id: "kafka", label: "Kafka", sub: "activity.created", col: 5, row: 2, tone: "orange" },
      {
        id: "matcher",
        label: "Segment Matcher",
        sub: "async worker",
        mono: "S2 candidates → corridor match",
        col: 3,
        row: 3,
        tone: "orange",
      },
      { id: "fanout", label: "Fan-out Workers", sub: "timeline + heatmap", col: 4, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "feed_svc", label: "GET /feed", kind: "read" },
      { from: "feed_svc", to: "feed_cache", label: "cached timeline", kind: "read" },
      { from: "feed_cache", to: "activity_db", label: "miss · hydrate", kind: "read" },
      { from: "feed_svc", to: "leaderboard", label: "segment leaderboard", kind: "read" },
      { from: "client", to: "upload_svc", label: "POST /activities", kind: "write" },
      { from: "upload_svc", to: "blob", label: "raw file + polyline", kind: "write" },
      { from: "upload_svc", to: "activity_db", label: "insert activity", kind: "write" },
      { from: "upload_svc", to: "kafka", label: "activity.created", kind: "write" },
      { from: "kafka", to: "matcher", label: "async", kind: "analytics" },
      { from: "matcher", to: "blob", label: "read true polyline", kind: "analytics" },
      { from: "matcher", to: "leaderboard", label: "ZADD effort · per dimension", kind: "analytics" },
      { from: "matcher", to: "activity_db", label: "write segment efforts", kind: "analytics" },
      { from: "kafka", to: "fanout", label: "async", kind: "analytics" },
      { from: "fanout", to: "feed_cache", label: "push to follower timelines", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · feed + leaderboard views" },
      { kind: "write", text: "write path · 800 activity uploads/s peak" },
      { kind: "analytics", text: "async pipeline · segment matching, leaderboards, fan-out, heatmap — never blocks the upload response" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Upload an activity (GPX/FIT/TCX file or live-recorded stream) with distance, duration, elevation gain, and pace", tag: "P0" },
      { id: "FR-02", text: "Automatically match the activity's route against public segments and compute an elapsed time (an 'effort') for each one traversed", tag: "P0" },
      { id: "FR-03", text: "Maintain a live leaderboard per segment (overall, gender, age-group) ranked by fastest effort, including the KOM/QOM crown", tag: "P0" },
      { id: "FR-04", text: "Generate a reverse-chronological social feed of activities from followed athletes", tag: "P0" },
      { id: "FR-05", text: "Kudos (like) and threaded comments on an activity, with a notification to the owner", tag: "P0" },
      { id: "FR-06", text: "Follow / unfollow other athletes", tag: "P0" },
      { id: "FR-07", text: "Privacy zones that redact GPS points within a configurable radius of home/work before any public map, feed entry, or heatmap tile is rendered", tag: "P1" },
      { id: "FR-08", text: "A global heatmap of aggregated public routes, rendered as map tiles, built only from opted-in, redacted data", tag: "P1" },
      { id: "FR-09", text: "Real-time 'beacon' location sharing with chosen contacts while an activity is in progress", tag: "P1" },
      { id: "FR-10", text: "Personal stats dashboard: weekly/monthly mileage, personal records, year-over-year trends", tag: "P2" },
      { id: "FR-11", text: "Third-party device sync (Garmin, Wahoo, Apple Watch, Zwift) via webhook/API integrations", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Feed read latency, server-side", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "Segment leaderboard read latency, server-side", tag: "p99 < 50ms" },
      { id: "NFR-03", text: "Upload finish → segment leaderboard updated", tag: "p99 < 30s" },
      { id: "NFR-04", text: "Upload finish → visible in direct followers' feeds", tag: "p99 < 10s" },
      { id: "NFR-05", text: "Sustained activity-upload throughput, weekend-morning peak", tag: "800/sec" },
      { id: "NFR-06", text: "Availability (about 4.4 hrs downtime per year)", tag: "99.95%" },
      { id: "NFR-07", text: "Durability: no data loss for uploaded GPS traces", tag: "zero loss" },
      { id: "NFR-08", text: "Read-to-write ratio that anchors the design (feed + leaderboard reads vs. uploads)", tag: "100:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: what a GPS trace actually costs",
      body: [
        "Before designing storage, price out one activity. A phone or watch records a point roughly once per second: lat, lng, elevation, timestamp, heart rate, cadence — about 20 bytes per point uncompressed. A 45-minute run is ~2,700 points, so raw is ~54KB per activity. At 10M activities/day that is 540GB/day raw, which is affordable but wasteful, since consecutive points barely move.",
        "Delta-encode each point against the previous one (the deltas are tiny — a few meters, a few centimeters of elevation), then run Google's polyline algorithm (a variable-length encoding of those deltas) and gzip the result. That combination typically shrinks the trace 5-8x, landing around 6-10KB per activity — roughly 80GB/day of compressed trace data, ~29TB/year, which is what actually gets cached and shipped to clients.",
      ],
      bullets: [
        { lead: "Raw points", text: "~20 bytes each (lat, lng, elevation, timestamp, HR, cadence) × ~2,700 points/activity ≈ 54KB raw." },
        { lead: "Delta-encoding", text: "consecutive GPS points move by meters, not degrees, so encoding the delta instead of the absolute value collapses most of the entropy." },
        { lead: "Polyline + gzip", text: "Google's polyline algorithm plus gzip gets ~5-8x compression, landing at ~6-10KB/activity — the number that actually drives cache and CDN sizing." },
        { lead: "Keep the raw file too", text: "the original FIT/GPX upload is kept in cold S3 storage for reprocessing (new segment definitions, elevation-model corrections) even though the hot path only ever touches the compressed polyline." },
      ],
      pictureTitle: "One activity, three representations",
      pictureRows: [
        { label: "Raw points", value: "~54KB, never touched after ingest", tone: "bad" },
        { label: "Delta + polyline + gzip", value: "~6-10KB, the hot-path artifact", tone: "good" },
        { label: "Original FIT/GPX", value: "kept cold in S3 for reprocessing", tone: "neutral" },
      ],
      remember: {
        problem: "10M activities/day at ~54KB raw each is wasteful to store and slow to ship to clients.",
        solution: "Delta-encode consecutive points, then Google polyline + gzip, shrinking each trace to ~6-10KB.",
        why: "GPS points move by meters between samples, so the delta stream has far less entropy than absolute coordinates.",
        tradeoff: "Compressed traces need decoding before use (cheap, CPU-bound) and the raw file must still be kept cold for future reprocessing.",
        failure: "Store and serve raw points and every hot path (feed thumbnails, segment matching) pays 5-8x the bandwidth and storage it needs.",
        mitigation: "Compress once at upload time, keep the raw FIT/GPX in cold storage, and never decode back to raw on the read path.",
      },
    },
    {
      n: 2,
      title: "Segment matching: narrowing 30M candidates to a few hundred",
      body: [
        "A segment is a fixed stretch of road or trail (a climb, a sprint) with a start and end point. There are 30M+ of them worldwide. Checking a new activity's trace against all 30M would be absurd, so the problem splits into two stages: narrow candidates geographically, then confirm a match precisely.",
        "Cover the activity's polyline with S2 cells (a hierarchical spatial index that tiles the earth into cells of roughly known size at each level — pick a level where a cell is a few hundred meters to a couple kilometers across). Every segment is indexed by the S2 cells its own polyline passes through. Intersecting the activity's cell set against the segment index turns 30M candidates into a few hundred that are even geographically plausible for this route.",
      ],
      bullets: [
        { lead: "S2 cell covering", text: "the activity's trace and every segment are both indexed by the S2 cells they pass through; this is a set-intersection problem, not a distance calculation, so it is fast even at 30M segments." },
        { lead: "Corridor matching", text: "for each surviving candidate, walk the activity's points alongside the segment's polyline and check they stay within a tolerance corridor (e.g. ~25m perpendicular distance, similar bearing) for the segment's full length." },
        { lead: "Entry/exit extraction", text: "once corridor-matched, the timestamps at the segment's start and end points give the elapsed time — the 'effort' that gets written to the leaderboard." },
        { lead: "Why brute force fails", text: "comparing a 2,700-point trace against 30M segment polylines with a full path-similarity metric (e.g. Fréchet distance) is O(candidates × points), computationally infeasible per upload; the geo index is what makes candidates a few hundred instead of tens of millions." },
      ],
      pictureTitle: "30M segments → a few hundred candidates → confirmed efforts",
      pictureRows: [
        { label: "All segments", value: "30M — never touched directly", tone: "bad" },
        { label: "S2 cell intersection", value: "~hundreds of geographic candidates", tone: "neutral" },
        { label: "Corridor match confirmed", value: "~dozens of real efforts per activity", tone: "good" },
      ],
      remember: {
        problem: "Match a GPS trace against 30M candidate segments fast enough to feel instant.",
        solution: "Two-stage: S2 cell-set intersection to narrow to hundreds of candidates, then a corridor/bearing tolerance check to confirm and extract entry/exit times.",
        why: "Geospatial indexing turns an O(segments) problem into an O(candidates-in-this-corridor) problem; only the survivors pay for expensive path comparison.",
        tradeoff: "S2 cell resolution is a tuning knob — too coarse over-generates candidates, too fine risks missing a segment that clips a cell boundary; segments are indexed at multiple levels to hedge this.",
        failure: "Running full path-similarity against all 30M segments per upload would make matching take minutes instead of seconds, and would never keep up with 800 uploads/sec.",
        mitigation: "Index every segment by its S2 cell covering at ingest time; matching an activity is then a cheap set lookup, not a full scan.",
      },
    },
    {
      n: 3,
      title: "Leaderboards: sorted sets, and Redis is a cache, not the source of truth",
      body: [
        "A leaderboard is 'rank all efforts on this segment by elapsed time' — a textbook use for a sorted set. Redis ZADD segment:{id}:{dimension} {elapsed_seconds} {athlete_id} is O(log n); reading the top 10 or the KOM/QOM is ZRANGE ...  0 9, also O(log n). One effort, though, is not one ZADD — Strava exposes overall, gender, and age-group leaderboards, plus 'this year' and 'following only' views, so a single confirmed effort fans out to several sorted-set writes.",
        "The genuine trap is treating Redis as authoritative. It is fast and in-memory, which means it is also the thing that can lose data on a node failure. Every effort is written durably to Cassandra first (or in the same transaction path); Redis sorted sets are a rebuildable index over that durable data, not the record of truth — exactly the same discipline as never trusting a cache to be the only copy of a URL mapping.",
      ],
      bullets: [
        { lead: "One effort, several ZADDs", text: "overall, gender, age-group, and time-window leaderboards each get their own sorted set, so a confirmed effort fans out to roughly 5-8 writes, not one." },
        { lead: "KOM/QOM", text: "is just ZRANGE segment:{id}:overall 0 0 — the crown is a query, not a separately maintained field." },
        { lead: "Recompute on segment edit", text: "if a segment's definition changes (rare, but happens — a road closure reroutes it), every leaderboard for that segment must be rebuilt from the durable effort records, which is only possible because Redis was never the source of truth." },
        { lead: "Hot segments", text: "a famous climb ridden by thousands on a sunny Saturday concentrates writes on a handful of sorted-set keys; single-threaded Redis comfortably absorbs this (millions of ops/sec on a single instance), so this is a non-issue compared to the fan-out cost." },
      ],
      pictureTitle: "Effort → leaderboard fan-out",
      pictureRows: [
        { label: "Durable write (Cassandra)", value: "the effort, once — source of truth", tone: "good" },
        { label: "Redis ZADD × ~6 dimensions", value: "overall / gender / age-group / this-year / ...", tone: "used" },
        { label: "Redis instance lost", value: "rebuildable from Cassandra, no data lost", tone: "neutral" },
      ],
      remember: {
        problem: "Serve sub-50ms leaderboard reads across multiple ranking dimensions per segment.",
        solution: "Redis sorted sets per (segment, dimension); one confirmed effort fans out to ~6-8 ZADDs; the effort itself is durably written to Cassandra first.",
        why: "ZADD/ZRANGE are O(log n), and KOM/QOM becomes a free top-of-sorted-set query instead of a separately maintained field.",
        tradeoff: "Multi-dimension fan-out multiplies writes per effort, and every dimension needs its own key naming and rebuild path.",
        failure: "Treat Redis as authoritative and a node failure silently drops leaderboard history with no way to recover it.",
        mitigation: "Cassandra holds every effort durably; Redis sorted sets are a rebuildable index that can be regenerated from durable data at any time.",
      },
    },
    {
      n: 4,
      title: "Feed fan-out: hybrid, because follower counts are wildly skewed",
      body: [
        "Most athletes follow and are followed by 50-150 people, so fan-out-on-write (push a new activity into every follower's precomputed timeline at post time) is cheap and gives fast, simple reads. But some accounts — pro athletes, brands, popular local run clubs — have millions of followers. Writing a timeline row to a million followers synchronously (or even async, at real cost) for every post is not proportionate to who's actually going to see it soon.",
        "The fix is the standard hybrid: fan-out-on-write for accounts under a follower threshold (say 10K), fan-out-on-read for celebrity accounts above it. A follower's feed read merges their precomputed timeline with a live query of the small number of celebrity accounts they follow, sorted by time. Almost everyone's writes stay cheap; only celebrity reads pay a small merge cost, and only at read time, when it's actually needed.",
      ],
      bullets: [
        { lead: "Below threshold: fan-out-on-write", text: "at upload time, push the activity into every follower's Redis/Cassandra timeline. Reads are then a single partition scan — fast and simple, and this covers the overwhelming majority of accounts." },
        { lead: "Above threshold: fan-out-on-read", text: "a celebrity's activity is not pushed anywhere; it's looked up live and merged into a follower's feed only when that follower actually opens the app." },
        { lead: "Merge at read time", text: "the Feed Service reads the precomputed timeline and separately queries 'celebrities I follow, recent activities', merging both by timestamp before returning." },
        { lead: "Kudos/comments ride the same asymmetry", text: "a kudos on a celebrity's post doesn't need to update a million timelines — it just increments a counter on the activity record itself." },
      ],
      pictureTitle: "Fan-out cost by follower count",
      pictureRows: [
        { label: "Typical account (<10K followers)", value: "fan-out-on-write, cheap per post", tone: "good" },
        { label: "Celebrity account (millions)", value: "fan-out-on-read, merged at read time", tone: "neutral" },
        { label: "Pure fan-out-on-write for everyone", value: "a celebrity post = millions of writes", tone: "bad" },
      ],
      remember: {
        problem: "Fan out a new activity to followers when follower counts range from 50 to 5 million.",
        solution: "Fan-out-on-write below a follower threshold, fan-out-on-read (merged at query time) above it.",
        why: "Fan-out cost is proportional to follower count on write; merge cost is proportional to celebrities-followed on read — pick whichever is smaller per account.",
        tradeoff: "Feed reads for users who follow celebrities do a small live merge instead of a pure cache read, trading a little read latency for bounded write cost.",
        failure: "Pure fan-out-on-write means one post from a million-follower account triggers a million timeline writes, spiking the pipeline for a single event.",
        mitigation: "Track follower count per account and route fan-out strategy by threshold; re-evaluate the threshold as accounts cross it.",
      },
    },
    {
      n: 5,
      title: "Privacy zones: match on the true trace, redact only at display",
      body: [
        "A privacy zone hides GPS points within a configurable radius (e.g. 200m-1km) of a user's home or work from anyone but themselves. The order of operations matters enormously: if you redact before segment matching, a user loses credit for the segment right outside their front door. If you redact after generating a public map tile or a heatmap contribution, you've already leaked the address.",
        "The rule: segment matching and personal stats always run against the true, unredacted trace, because they are private computations whose output (an effort, a PR) doesn't reveal the input geometry. Redaction happens exactly once, at the boundary where a trace becomes something other people can see — the public activity map, the feed thumbnail, and the heatmap aggregation input. Every one of those surfaces must call the same redaction function; a CDN edge that ever caches an unredacted tile is a real leak, not a theoretical one.",
      ],
      bullets: [
        { lead: "True trace stays private", text: "segment matching, personal stats, and the athlete's own map view use the full unredacted GPS data — nothing here is ever shown to another person." },
        { lead: "One redaction boundary", text: "the moment a trace is about to be rendered for anyone but the owner (public map, feed card, heatmap input), it passes through the privacy-zone clip and only the clipped version leaves that boundary." },
        { lead: "Radius, not a bounding box", text: "the zone is a circle around a fixed lat/lng the user sets, not derived from the trace itself, so it can't be reverse-engineered from where the redaction starts and stops." },
        { lead: "Cache discipline", text: "CDN and edge caches must key on the redacted artifact only — never cache or serve the pre-redaction polyline on any public-facing path." },
      ],
      pictureTitle: "Where redaction happens",
      pictureRows: [
        { label: "Segment matching", value: "true trace — private computation", tone: "used" },
        { label: "Public map / feed / heatmap", value: "redacted trace — the only thing shown", tone: "good" },
        { label: "CDN caching a pre-redaction tile", value: "a real address leak, not theoretical", tone: "bad" },
      ],
      remember: {
        problem: "Hide a user's home/work location without breaking segment credit for routes near it.",
        solution: "Run all private computation (segment matching, PRs) on the true trace; redact once, at the single boundary where a trace becomes visible to anyone else.",
        why: "Redacting too early loses legitimate segment credit; redacting too late (or inconsistently across surfaces) leaks the exact thing privacy zones exist to protect.",
        tradeoff: "Two representations of every trace (true + redacted) must be kept consistent and the redaction function must be applied uniformly across every public surface.",
        failure: "A feed thumbnail, heatmap tile, or CDN edge cache serves the pre-redaction polyline once, and the user's home address is now public.",
        mitigation: "Centralize redaction in one function called by every public-facing path, and make caches key on the redacted artifact, never the raw one.",
      },
    },
    {
      n: 6,
      title: "The heatmap: batch, opt-in, and deliberately not real-time",
      body: [
        "The global heatmap aggregates years of public routes into map tiles showing where people run and ride. It is built from an offline batch job (e.g. Spark), not a real-time pipeline, because a single activity contributing to a tile is invisible at global scale anyway — the value comes from density accumulated over millions of activities, not freshness.",
        "Only opted-in, already-redacted trace data feeds the job. The pipeline buckets GPS points into a tile pyramid (zoom levels 0-16, each tile covering a smaller area at higher zoom), sums point density per pixel, and renders a log-scale intensity so a handful of runners on a quiet trail is visible without a busy city marathon route saturating the whole map. The output is static tiles served from a CDN, refreshed periodically (daily to weekly), not per-upload.",
      ],
      bullets: [
        { lead: "Batch, not streaming", text: "one activity moves a single pixel's count by one out of millions; there is no product reason to update tiles per-upload, so a periodic Spark job is both simpler and cheaper than a real-time path." },
        { lead: "Opt-in only", text: "the job filters to activities the athlete has explicitly marked visible in the heatmap, on top of privacy-zone redaction already applied to the input traces." },
        { lead: "Log-scale intensity", text: "raw point counts per tile pixel span orders of magnitude between a quiet trail and a city center; log-scaling keeps both visible instead of one washing out the other." },
        { lead: "Static tile output", text: "the job's output is ordinary map tiles cached at a CDN — the heatmap read path is indistinguishable from serving any other map tile." },
      ],
      pictureTitle: "Why the heatmap is a batch job",
      pictureRows: [
        { label: "Per-upload streaming", value: "unnecessary — one activity is invisible at scale", tone: "bad" },
        { label: "Periodic Spark aggregation", value: "cheap, matches how the product is actually used", tone: "good" },
        { label: "Output", value: "static CDN tiles, same as any other map layer", tone: "neutral" },
      ],
      remember: {
        problem: "Aggregate billions of GPS points into a browsable global heatmap without a real-time pipeline.",
        solution: "A periodic batch job (Spark) over opted-in, privacy-redacted traces, bucketed into a log-scaled tile pyramid, served as static CDN tiles.",
        why: "A single activity is statistically invisible in a global aggregate, so freshness is not a real requirement — batch is simpler and far cheaper.",
        tradeoff: "The heatmap lags reality by up to a refresh cycle (daily-to-weekly), which is invisible to users and an explicit, deliberate trade.",
        failure: "Building this as a real-time pipeline burns streaming infrastructure on updates nobody can perceive.",
        mitigation: "Schedule the aggregation job periodically and treat the heatmap as a slowly-refreshed static asset, not a live view.",
      },
    },
    {
      n: 7,
      title: "Data model: why Cassandra, and partitioning by athlete_id",
      body: [
        "The dominant access pattern is 'give me this athlete's activities, in time order' and 'give me this segment's efforts, ranked' — both are time-series/ranked reads against a huge, ever-growing dataset with no need for cross-entity joins. That's the textbook case for a wide-column store: Cassandra, partitioned by athlete_id (with a time-bucket clustering key) for the activities table, and denormalized into a second table partitioned by segment_id for the effort/leaderboard-rebuild path.",
        "This is the same denormalize-for-access-pattern discipline as any wide-column design: writing an effort means writing it into both the activities-by-athlete table and the efforts-by-segment table, because Cassandra has no cheap secondary-index equivalent of 'find all efforts on segment X ordered by time' otherwise. The write cost of dual-writing is small compared to the read-path win of never scanning.",
      ],
      bullets: [
        { lead: "activities_by_athlete", text: "partition key athlete_id, clustering key start_time — a single partition read gives one athlete's feed/history in order, no join required." },
        { lead: "efforts_by_segment", text: "partition key segment_id, clustering key elapsed_seconds (or effort_time) — this is what rebuilds a Redis leaderboard after a segment edit or a cache loss." },
        { lead: "Denormalize, don't join", text: "Cassandra has no efficient join; every access pattern that needs to exist gets its own purpose-built table, written to at write time." },
        { lead: "S3 for the blobs", text: "the encoded polyline and raw FIT/GPX file live in S3, referenced by key from the Cassandra row — Cassandra stores metadata and pointers, not multi-KB blobs." },
      ],
      pictureTitle: "One effort, two tables",
      pictureRows: [
        { label: "activities_by_athlete", value: "PK athlete_id · feed & personal history", tone: "good" },
        { label: "efforts_by_segment", value: "PK segment_id · leaderboard rebuild source", tone: "good" },
        { label: "S3 blob (polyline + raw file)", value: "referenced by key, never inlined", tone: "used" },
      ],
      remember: {
        problem: "Serve both 'this athlete's history' and 'this segment's leaderboard' at scale with no joins.",
        solution: "Cassandra, denormalized into activities_by_athlete and efforts_by_segment, each partitioned for its own read pattern; blobs live in S3.",
        why: "Wide-column stores have no cheap join, so every real access pattern gets its own table, written to once per event.",
        tradeoff: "Writes cost more (multiple tables per effort) in exchange for reads that are always a single-partition lookup.",
        failure: "Model this as one normalized activities table and 'find efforts for segment X' becomes a full scan or a fragile secondary index.",
        mitigation: "Denormalize up front for every known access pattern, and keep large blobs (polylines, raw files) out of the row entirely.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "Uploads are write-once: a GPS trace is compressed, stored, and its metadata written durably — then everything expensive happens async, off the upload response.",
      "Segment matching narrows 30M segments to a few hundred candidates with an S2 geo index before ever comparing paths precisely.",
      "Leaderboards are Redis sorted sets fed by durable Cassandra writes — Redis is a rebuildable index, never the source of truth.",
      "Feed fan-out is hybrid: push-on-write for normal accounts, merge-on-read for celebrity accounts, because follower counts range from 50 to 5 million.",
      "Privacy zones redact once, at the single boundary where a trace becomes visible to anyone but its owner — segment matching always sees the true trace.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · FEED + LEADERBOARD · P99 < 200MS",
        summary:
          "Opening the app asks for a feed page and, inside an activity, a segment leaderboard. Both are served from Redis first; the feed falls back to Cassandra only on a cold cache.",
        steps: [
          { label: "Client", note: "opens feed or an activity" },
          { label: "Feed Service", note: "stateless" },
          { label: "Redis Timeline", note: "cached feed page" },
          { label: "Activity DB (miss)", note: "Cassandra, by athlete_id" },
          { label: "Redis Leaderboards", note: "ZRANGE per segment, per dimension" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · ACTIVITY UPLOAD · 800/S PEAK",
        summary:
          "The upload response only waits on durable storage of the compressed trace and metadata. Everything that takes real compute — matching, leaderboards, feed fan-out — happens after the response, off a Kafka event.",
        steps: [
          { label: "Client", note: "POST /activities · GPX/FIT/TCX" },
          { label: "Upload Service", note: "delta-encode + polyline + gzip" },
          { label: "S3", note: "raw file + compressed polyline" },
          { label: "Activity DB", note: "insert metadata, Cassandra" },
          { label: "Kafka", note: "activity.created — response returns here" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · MATCH, RANK, FAN OUT · P99 < 30S TO LEADERBOARD",
        summary:
          "Off the Kafka event: the segment matcher narrows candidates with the S2 index and writes confirmed efforts; a separate worker fans the activity out to followers' timelines, respecting the fan-out threshold and privacy-zone redaction.",
        steps: [
          { label: "Kafka", note: "activity.created" },
          { label: "Segment Matcher", note: "S2 candidates → corridor match on the true trace" },
          { label: "Redis Leaderboards + Activity DB", note: "ZADD per dimension, durable effort write" },
          { label: "Fan-out Workers", note: "push-on-write below threshold, merge-on-read above" },
          { label: "Heatmap batch (Spark)", note: "periodic, opt-in, redacted input only" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "100M athletes, 10M activities/day (~115/s avg, ~800/s Saturday-morning peak)",
          "30M+ public segments, indexed by S2 cell covering",
          "GPS trace: ~2,700 pts/activity raw (~54KB) → ~6-10KB after delta+polyline+gzip",
          "~80GB/day compressed trace data, ~29TB/year",
          "Read:write ratio ≈ 100:1 (feed + leaderboard reads vs. uploads)",
          "Leaderboard fan-out: ~6-8 Redis ZADDs per confirmed effort",
          "Fan-out threshold: push-on-write below ~10K followers, merge-on-read above",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "S2 cell-set intersection to narrow segment candidates before any path comparison",
          "Cassandra denormalized into activities_by_athlete + efforts_by_segment (no joins)",
          "Redis sorted sets for leaderboards, always fed by a durable Cassandra write first",
          "Hybrid feed fan-out by follower-count threshold, not one strategy for everyone",
          "Redaction happens once, at the public-visibility boundary, never inside segment matching",
          "Heatmap is a periodic batch job (Spark), not a real-time pipeline",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Redis is a rebuildable index for leaderboards, never the source of truth",
          "Segment matching runs on the true trace; only public-facing surfaces see the redacted one",
          "Celebrity accounts break naive fan-out-on-write — quantify the follower-count skew",
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
      goal: "Lock five numbers and the scope of what 'segment matching' and 'privacy' mean before drawing anything.",
      why: "This system has three genuinely different subsystems (upload/storage, segment matching, social feed) and the interviewer wants to see you scope which ones you'll go deep on, driven by numbers, not guessed.",
      steps: [
        { kind: "ASK", text: '**"What scale — how many athletes, how many activities per day?"** Land on "100M athletes, 10M activities/day", write **"10M/day ≈ 115/s avg, ~800/s peak"** on the board.' },
        { kind: "ASK", text: '**"Is segment matching in scope, or just storage and feed?"** This is the signature sub-problem — confirm it\'s in, and write **"30M+ segments"** under the scale line.' },
        { kind: "SAY", text: 'Propose the latency targets yourself: **"feed reads sub-200ms"**, **"leaderboard updates within 30s of upload"**, **"feed visibility within 10s for direct followers"**. Wait for a nod.' },
        { kind: "SAY", text: 'State scope explicitly. In: "upload + storage", "segment matching + leaderboards", "feed + kudos", "privacy zones". Out: "auth", "payments/subscriptions", "route planning/discovery". "Let me know if you want any of those back in."' },
        { kind: "WRITE", text: 'Size one activity out loud: **"~2,700 GPS points raw ≈ 54KB, compresses to ~6-10KB"**, so **"~80GB/day of trace data"**. Write it on the board — this number will justify the compression decision later.' },
      ],
      grading: "Numbers on the board within 5 minutes, explicit scope with segment matching confirmed in, and the compression estimate written down before it's needed.",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Three endpoints, two denormalized tables, and the storage split between metadata and blobs stated up front.",
      why: "Committing to denormalized tables here (rather than discovering the need mid-deep-dive) signals you already understand the read patterns you're about to design around.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /activities { file }"** → **"{ activityId, status: processing }"**. **"GET /feed?cursor="** → paginated activity cards. **"GET /segments/:id/leaderboard?dimension="**.' },
        { kind: "DRAW", text: 'Sketch two Cassandra tables: **"activities_by_athlete (PK athlete_id, CK start_time)"** and **"efforts_by_segment (PK segment_id, CK elapsed_seconds)"**. Say: "No joins in Cassandra, so each real access pattern gets its own table."' },
        { kind: "SAY", text: '"The compressed polyline and the raw FIT/GPX file live in S3, referenced by key — Cassandra rows stay small metadata, not multi-KB blobs."' },
        { kind: "RULE OUT", text: '"A single normalized activities table with a secondary index on segment_id would force a full scan or a fragile index to build a leaderboard — that\'s why efforts get their own denormalized table." Cross it off.' },
      ],
      grading: "Two purpose-built tables named with their partition keys, blobs explicitly pointed to S3 instead of inlined, and the join-free reasoning stated unprompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram, three lanes: read (feed/leaderboard), write (upload), async (matching, ranking, fan-out, heatmap).",
      why: "The interviewer is checking that you understand these three paths have different SLAs and therefore different infrastructure — an upload response must never wait on segment matching or fan-out.",
      steps: [
        { kind: "DRAW", text: 'Draw the **write path**: Client → Upload Service → S3 (blob) + Activity DB (metadata) → Kafka. Label it **"upload response returns once metadata + Kafka event land — matching hasn\'t started yet"**.' },
        { kind: "DRAW", text: 'Draw the **async lane** off Kafka: → Segment Matcher (S2 candidates → corridor match) → Redis Leaderboards + Activity DB; and a parallel → Fan-out Workers → Redis Timeline. Label **"never blocks the upload response"**.' },
        { kind: "DRAW", text: 'Draw the **read path**: Client → Feed Service → Redis Timeline (miss → Activity DB) and → Redis Leaderboards. Label with the latency budgets: **"sub-200ms feed"**, **"sub-50ms leaderboard"**.' },
        { kind: "SAY", text: '"Three lanes because they have three SLAs: upload is tier-1 and must be fast and durable; matching/fan-out is tier-2, async, with a 30-second budget; the feed read path is tier-1 for latency but entirely served from cache."' },
      ],
      grading: "Three clearly separated lanes with the async lane explicitly decoupled from the upload response via Kafka, and latency budgets on the arrows, not just box names.",
    },
    {
      n: 4,
      title: "Deep Dive: Segment Matching",
      minutes: 8,
      goal: "Explain the two-stage narrow-then-confirm approach and quantify why brute force is infeasible.",
      why: "This is the signature hard problem. The interviewer wants to see you recognize that 30M segments makes naive path comparison computationally impossible, and that you reach for a geospatial index specifically, not just 'add a cache'.",
      steps: [
        { kind: "SAY", text: '"Brute force is comparing a 2,700-point trace against 30M segment polylines with a full similarity metric — that\'s computationally infeasible per upload, and we\'re doing 800 uploads/sec at peak."' },
        { kind: "DRAW", text: 'Draw the two stages: **"S2 cell covering: activity trace ∩ segment index → a few hundred candidates"**, then **"corridor match: perpendicular distance + bearing tolerance → confirmed effort + entry/exit timestamps"**.' },
        { kind: "SAY", text: '"Both the activity\'s trace and every segment are pre-indexed by the S2 cells they pass through — this stage is a set intersection, not a distance calculation, which is why it scales to 30M segments."' },
        { kind: "RULE OUT", text: '"Skipping the geo-index stage and comparing directly against all segments" — cross it off as the thing that makes this problem hard in the first place.' },
      ],
      grading: "The two-stage narrow-then-confirm structure drawn explicitly, with the S2 index named as what makes candidate narrowing cheap, and the brute-force cost quantified, not just dismissed.",
    },
    {
      n: 5,
      title: "Deep Dive: Leaderboards and Feed Fan-out",
      minutes: 7,
      goal: "Cover the leaderboard fan-out per effort and the hybrid feed strategy, both driven by real skew in the numbers.",
      why: "Two distinct fan-out problems live in this system and the interviewer wants both named: leaderboard writes fan out per-effort across ranking dimensions, feed writes fan out per-post across a skewed follower graph.",
      steps: [
        { kind: "SAY", text: '"A confirmed effort isn\'t one write — it fans out to ~6-8 Redis ZADDs: overall, gender, age-group, this-year, and so on. Redis is the index; Cassandra holds the durable effort record it\'s rebuilt from."' },
        { kind: "SAY", text: '"Feed fan-out is hybrid. Most accounts have 50-150 followers, so push-on-write at post time is cheap. A celebrity account with millions of followers gets merge-on-read instead — nobody writes a million timeline rows for one post."' },
        { kind: "DRAW", text: 'Sketch the merge: a follower\'s feed read = "precomputed timeline" merged with "live query of the small number of celebrities I follow", sorted by timestamp.' },
        { kind: "SAY", text: '"The threshold is a tunable — say 10K followers — and accounts get re-evaluated as they cross it."' },
      ],
      grading: "Both fan-out problems named explicitly (leaderboard-per-effort, feed-per-post), the hybrid feed strategy quantified with a threshold, and the source-of-truth discipline for Redis stated again here.",
    },
    {
      n: 6,
      title: "Wrap: Privacy, Heatmap, and Close",
      minutes: 5,
      goal: "Name the privacy-zone redaction boundary unprompted, explain why the heatmap is batch, and close with a crisp summary.",
      why: "Privacy zones are the easiest thing to get subtly wrong in this design — the interviewer is listening for whether you volunteer the redaction-order reasoning, not just react when asked about privacy.",
      steps: [
        { kind: "SAY", text: '"One thing I want to flag before we close: segment matching always runs on the true, unredacted trace — otherwise users lose credit for segments near home. Redaction happens exactly once, at the boundary where a trace becomes visible to anyone but the owner: public map, feed card, heatmap input."' },
        { kind: "SAY", text: '"The heatmap is a periodic batch job over opted-in, already-redacted traces — one activity is statistically invisible at that scale, so there\'s no real-time requirement there."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need global leaderboards, or just friends-and-following leaderboards? That changes whether hot-segment write concentration matters at all."' },
        { kind: "SAY", text: 'Close in one sentence: "Upload is a fast, durable write; everything expensive — segment matching, leaderboards, feed fan-out, the heatmap — runs async off Kafka. With more time I\'d cover the beacon live-tracking path and device-sync webhooks."' },
      ],
      grading: "The privacy redaction order volunteered without being asked, the heatmap batch-vs-real-time reasoning stated explicitly, and a clean one-sentence close with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Gets a working upload-and-feed system on the board, but segment matching and fan-out skew stay hand-wavy.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right top-level components: upload service, database, cache, feed service.",
          "Knows GPS traces need to be compressed and stores them as a blob plus metadata.",
          "Adds a queue (Kafka) for 'processing' the activity after upload.",
          "Can describe a leaderboard as 'sort efforts by time' without naming a data structure.",
          "Knows a feed shows activities from people you follow and adds a follows table.",
        ],
        gaps: [
          "Segment matching is described as 'compare the GPS trace to segments' with no mention of how to avoid checking all 30M.",
          "Doesn't distinguish leaderboard writes (Redis) from the durable source of truth (DB) — treats Redis as if it can't lose data.",
          "Feed fan-out is one strategy for everyone; doesn't notice celebrity accounts break fan-out-on-write.",
          "Privacy zones are mentioned only if asked, and often applied inconsistently across surfaces.",
          "No storage math — can't say how big a GPS trace is or how much data accumulates per day.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end with real numbers, names the geo-index approach to segment matching, and gets the leaderboard/fan-out mechanics right.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes upload throughput, trace size, and segment count on the board within the first 5 minutes.",
          "Explains segment matching as a two-stage narrow-then-confirm problem using a geospatial index.",
          "Knows Redis leaderboards must be fed by a durable write and are rebuildable, not authoritative.",
          "Proposes hybrid feed fan-out (push-on-write / merge-on-read) once follower skew comes up.",
          "Denormalizes the Cassandra schema by access pattern (activities_by_athlete, efforts_by_segment).",
          "Applies privacy-zone redaction when asked, and gets the order (match on true trace, redact for display) right.",
        ],
        gaps: [
          "Names the hybrid fan-out threshold only after being prompted with 'what if someone has a million followers?'.",
          "Doesn't volunteer that the heatmap should be batch, not real-time, until asked directly.",
          "Quantifies segment-matching cost in general terms ('too slow') rather than in candidate counts (30M → hundreds).",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, volunteers the privacy-redaction ordering unprompted, and treats every fan-out decision as a quantified skew problem.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the privacy-zone redaction-order rule before being asked — segment matching on the true trace, redaction only at the public-visibility boundary — and names the CDN-caching failure mode explicitly.",
          "Frames both leaderboard fan-out (per-effort, across ranking dimensions) and feed fan-out (per-post, across a skewed follower graph) as the same class of problem with different thresholds.",
          "Brings up the heatmap-as-batch-job reasoning unprompted, with the argument that one activity is statistically invisible at global aggregate scale.",
          "Pushes back on scope ('do we need global leaderboards or just friends leaderboards? that changes whether hot-segment concentration even matters').",
          "Names the S2-index tuning trade-off (cell resolution vs. candidate count) rather than treating the geo index as a black box.",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time (beacon live-tracking, device-sync webhooks).",
          "Paces the 40 minutes deliberately, parking tangents and returning to them only if time allows.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Comparing every uploaded trace against all 30M segments with no geospatial index — this doesn't scale past a demo.",
      "Treating Redis leaderboards as the source of truth with no durable write behind them, so a Redis node failure permanently loses effort history.",
      "One fan-out strategy for every account, so a single celebrity post triggers millions of synchronous timeline writes.",
      "Redacting privacy zones before segment matching, so users silently lose credit for real segments near their home.",
      "Redacting privacy zones inconsistently — public map is clipped but the heatmap or a CDN-cached tile isn't, leaking the address anyway.",
      "Putting segment matching or feed fan-out on the upload response path, so a slow matcher makes every upload feel slow.",
      "Designing the heatmap as a real-time streaming pipeline with no justification for why per-activity freshness matters at global scale.",
    ],
    followUps: [
      {
        q: "Why S2 cells instead of a simple lat/lng bounding-box query?",
        a: "A bounding box over lat/lng distorts badly near the poles and doesn't tile the earth into roughly equal-area cells, so candidate counts vary wildly by latitude. S2 cells are a hierarchical, roughly-equal-area covering of the sphere, so a fixed cell level gives a predictable candidate-set size everywhere from the equator to Scandinavia, and the containment/intersection operations are cheap set operations rather than trigonometric distance calculations on every candidate.",
      },
      {
        q: "What happens if a segment's route is edited after thousands of efforts already exist?",
        a: "Because Redis was never the source of truth, this is a controlled rebuild: recompute affected efforts (or invalidate ones whose match no longer holds) from the durable efforts_by_segment records, then rebuild the Redis sorted sets for that segment from scratch. It's an operational job, not an emergency, precisely because durability was never delegated to the cache.",
      },
      {
        q: "How would you detect and handle GPS spoofing or segment-time cheating?",
        a: "Cross-check the trace's implied speed against physically plausible bounds for the activity type (e.g. a 'run' averaging 40mph is not a run), check point-to-point consistency (GPS jitter has a characteristic noise profile that a spoofed straight-line trace lacks), and flag efforts for review rather than silently rejecting them, since GPS noise near tunnels or dense urban canyons produces some legitimate false positives. This runs as a secondary check after matching, not inline with it, so it doesn't add latency to the leaderboard-update budget.",
      },
      {
        q: "How does the 'beacon' real-time location-sharing feature interact with the rest of the design?",
        a: "It's a genuinely different problem from everything else here: low-latency, ephemeral position updates streamed to a small set of chosen contacts (not a public feed), typically over a WebSocket or push-based channel, with no durability requirement beyond the activity's duration. It doesn't touch segment matching, leaderboards, or the main feed pipeline at all — it's closer to a presence/location system than to the batch-and-async infrastructure the rest of the design relies on.",
      },
      {
        q: "Why denormalize into activities_by_athlete and efforts_by_segment instead of using a relational database with indexes?",
        a: "At 10M writes/day and a read pattern that's almost entirely 'give me everything for this partition key, in order', Cassandra's write-optimized LSM structure and horizontal partitioning scale linearly with data volume in a way a single relational primary is harder to keep up with, without giving up much — there are no cross-entity joins in the hot path. A relational database with secondary indexes would work at smaller scale, but the indexed-lookup cost on a segment_id index over a huge activities table grows in a way a purpose-built partition doesn't.",
      },
      {
        q: "How would you extend this to support live segment leaderboards during group events (e.g. a race with thousands of live trackers)?",
        a: "That's closer to the beacon problem than the async matching pipeline: positions need to stream in near-real-time rather than arrive as one completed upload, so matching would need to run incrementally against in-progress traces instead of a single finished polyline. The leaderboard mechanics (Redis sorted sets, durable backing writes) stay the same; what changes is the trigger — matching per-position-update within an event window instead of once at upload completion — which is a meaningfully different latency budget and worth scoping as a separate deep dive.",
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
          "Strava is a write-once activity store with two expensive things bolted on the side: a geospatial matching pipeline that turns a GPS trace into ranked leaderboard entries, and a social graph that fans an activity out to followers. Both of those run async, off the upload response, because neither one is allowed to make an upload feel slow.",
          "Anchor everything on five numbers: 100M athletes, 10M activities/day (~800/s peak), 30M+ segments, a ~100:1 read:write ratio, and a 30-second budget from upload to leaderboard-updated. Every structural choice below is a consequence of these numbers.",
        ],
      },
      {
        heading: "Sizing and compression",
        body: [
          "A GPS trace at ~1 point/sec for a 45-minute activity is ~2,700 points, ~20 bytes each uncompressed — ~54KB. Delta-encoding consecutive points (which move by meters, not degrees) plus Google's polyline algorithm plus gzip typically achieves 5-8x compression, landing at ~6-10KB per activity — roughly 80GB/day, ~29TB/year of hot-path trace data. The original raw file is kept cold in S3 for reprocessing; nothing on the hot path ever touches it again.",
        ],
      },
      {
        heading: "Segment matching: the signature hard problem",
        body: [
          "Checking a trace against 30M+ segments requires narrowing candidates geospatially before any precise comparison. Every segment and every activity trace are indexed by the S2 cells they pass through; intersecting those cell sets turns 30M candidates into a few hundred that are even geographically plausible for this route — a set operation, not a distance calculation, which is what keeps it feasible at 800 uploads/sec.",
          "Surviving candidates get a corridor match: walk the trace alongside the segment's polyline and confirm it stays within a perpendicular-distance and bearing tolerance for the segment's length. A confirmed match yields entry/exit timestamps and therefore an elapsed time — the effort that gets written durably and fanned out to leaderboards.",
        ],
      },
      {
        heading: "Leaderboards: sorted sets fed by a durable write",
        body: [
          "Redis sorted sets (ZADD/ZRANGE, O(log n)) serve leaderboard reads in under 50ms, and KOM/QOM is just the top of the set. One effort fans out to several sorted sets — overall, gender, age-group, this-year — roughly 6-8 writes per confirmed effort. The discipline that keeps this safe: every effort is written durably to Cassandra first, and Redis is a rebuildable index over that durable data, never the record of truth. A segment edit or a Redis node loss means a rebuild job, not a data-loss incident.",
        ],
      },
      {
        heading: "Feed fan-out and the follower-count skew",
        body: [
          "Most accounts have 50-150 followers, so fan-out-on-write at post time is cheap and gives fast reads. Celebrity accounts with millions of followers break that math, so they get fan-out-on-read instead: nothing is pushed at post time, and a follower's feed read merges their precomputed timeline with a live, on-the-fly query of the small number of celebrities they follow, sorted by time. The threshold between the two strategies is a tunable, re-evaluated as accounts cross it.",
        ],
      },
      {
        heading: "Privacy zones and the heatmap",
        body: [
          "Segment matching and personal stats always run on the true, unredacted trace, because they're private computations. Redaction happens exactly once, at the single boundary where a trace becomes visible to anyone but its owner — public map, feed card, or heatmap input — and every public-facing surface, including CDN edge caches, must go through that same boundary. Getting the order backwards either loses legitimate segment credit or leaks a home address.",
          "The global heatmap aggregates opted-in, already-redacted traces into a tile pyramid via a periodic batch job (Spark), not a real-time pipeline — one activity is statistically invisible at global scale, so freshness beyond daily-to-weekly buys nothing. Output is ordinary static map tiles served from a CDN.",
        ],
      },
    ],
  },
};
