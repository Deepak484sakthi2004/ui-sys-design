import type { Problem } from "@/lib/types";

export const youtube: Problem = {
  slug: "youtube",
  num: "6.13",
  title: "Design YouTube",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a video platform that ingests 500 hours of video uploaded per minute, serves roughly 1 billion hours watched per day to 2.5B+ monthly users across mobile, web, and TV, and starts playback in under 1.5 seconds no matter how bad the viewer's network is.",
  ],
  hardParts:
    "The hard parts: transcoding a video into a full bitrate ladder fast enough that playback can start before encoding finishes, keeping a multi-exabyte-per-day egress bill sane by pushing almost all of it to the edge, and counting views at a rate and adversarial-resistance that a naive 'increment a row' can't survive.",
  keyTopics: [
    "Chunked Parallel Transcoding",
    "Adaptive Bitrate Streaming (HLS/DASH)",
    "Multi-Tier CDN with Origin Shield",
    "Approximate, Deduplicated View Counting",
    "Hot/Cold Storage Tiering",
  ],
  foundationsReferenced: [
    { label: "Object Storage (S3 / GCS)", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Kafka", tone: "orange" },
    { label: "CDN & Edge Caching", tone: "green" },
    { label: "Sharded MySQL / Vitess", tone: "blue" },
    { label: "Exactly-Once Processing", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "viewer", label: "Client (Viewer)", col: 1, row: 1, tone: "slate" },
      {
        id: "playback",
        label: "Playback API",
        sub: "stateless · resolves manifest + signed URLs",
        col: 2,
        row: 1,
        tone: "green",
      },
      { id: "cdn", label: "CDN Edge", sub: "~95% hit · popular videos", col: 3, row: 1, tone: "green" },
      {
        id: "metadataDB",
        label: "Metadata DB",
        sub: "Vitess/MySQL, sharded by video_id",
        col: 4,
        row: 1,
        tone: "blue",
      },
      {
        id: "blobStore",
        label: "Object Storage",
        sub: "video segments · exabyte-scale · erasure-coded",
        col: 5,
        row: 1,
        tone: "blue",
      },
      { id: "uploader", label: "Client (Uploader)", col: 1, row: 2, tone: "slate" },
      {
        id: "uploadSvc",
        label: "Upload Service",
        mono: "tus: resumable chunked PUT",
        col: 2,
        row: 2,
        tone: "purple",
      },
      { id: "rawBucket", label: "Raw Upload Bucket", sub: "staging, pre-transcode", col: 3, row: 2, tone: "purple" },
      { id: "jobQueue", label: "Kafka", sub: "event backbone: transcode jobs + watch-progress pings", col: 2, row: 3, tone: "orange" },
      {
        id: "transcode",
        label: "Transcode Workers",
        sub: "parallel chunk fan-out · multi-rendition",
        col: 3,
        row: 3,
        tone: "orange",
      },
      { id: "flink", label: "Flink", sub: "windowed dedup, view aggregation", col: 4, row: 3, tone: "orange" },
      { id: "counterStore", label: "Counter Store", sub: "aggregated view deltas", col: 5, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "viewer", to: "playback", label: "get manifest", kind: "read" },
      { from: "playback", to: "metadataDB", label: "video row + rendition manifest", kind: "read" },
      { from: "viewer", to: "cdn", label: "fetch segments via signed URLs", kind: "read" },
      { from: "cdn", to: "blobStore", label: "origin fetch on miss", kind: "read" },
      { from: "uploader", to: "uploadSvc", kind: "write" },
      { from: "uploadSvc", to: "rawBucket", label: "chunked PUT, resumable", kind: "write" },
      { from: "uploadSvc", to: "metadataDB", label: "create row, status=processing", kind: "write" },
      { from: "rawBucket", to: "jobQueue", label: "upload complete", kind: "analytics" },
      { from: "jobQueue", to: "transcode", label: "transcode job", kind: "analytics" },
      { from: "transcode", to: "blobStore", label: "write rendition ladder", kind: "analytics" },
      { from: "transcode", to: "metadataDB", label: "status=ready, thumbnails, duration", kind: "analytics" },
      { from: "playback", to: "jobQueue", label: "watch-progress ping", kind: "analytics" },
      { from: "jobQueue", to: "flink", label: "view events", kind: "analytics" },
      { from: "flink", to: "counterStore", label: "windowed dedup, ~1min", kind: "analytics" },
      { from: "counterStore", to: "metadataDB", label: "periodic flush, aggregated deltas", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · playback, ~1B hours watched/day" },
      { kind: "write", text: "write path · uploads, 500 hours/min" },
      { kind: "analytics", text: "async/background · transcoding + view counting, never blocks playback or uploads" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["viewer", "playback", "metadataDB"],
      say: "Start with the read skeleton: the client calls the Playback API directly for a manifest, and the API resolves the video row and rendition pointers from the metadata DB. This call happens on every playback, so it gets its own tight budget: p99 under 100ms.",
    },
    {
      reveal: ["cdn", "blobStore"],
      say: "The video bytes never come from that API — they come from the CDN edge, which absorbs about 95% of the roughly 1.3 exabytes a day of watch traffic. On a miss, the edge falls back to object storage, so the origin only ever sees the aggregated tail.",
    },
    {
      reveal: ["uploader", "uploadSvc", "rawBucket"],
      say: "Uploads are a separate, much smaller lane, about 1,400 times less traffic than playback. A resumable chunked PUT lands the raw file in a staging bucket while the Upload Service writes a metadata row with status=processing.",
    },
    {
      reveal: ["jobQueue", "transcode"],
      say: "Once staging finishes, a Kafka event kicks off the Transcode Workers, which fan a video out into GOP-aligned chunk-by-rendition jobs in parallel, write the finished ladder to object storage, and flip the row to status=ready.",
    },
    {
      reveal: ["flink", "counterStore"],
      say: "The same Kafka backbone also carries watch-progress pings. Flink windows and dedupes them per user, video, and minute, aggregates the result into a Counter Store, and only that batched delta — never a per-click write — gets flushed back into the metadata row.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Upload a video via resumable, chunked transfer, supporting multi-GB / multi-hour files", tag: "P0" },
      { id: "FR-02", text: "Transcode an uploaded video into an adaptive-bitrate ladder (multiple resolutions and codecs)", tag: "P0" },
      { id: "FR-03", text: "Stream video via adaptive bitrate (HLS/DASH) to web, mobile, and TV clients", tag: "P0" },
      { id: "FR-04", text: "Store and serve video metadata: title, description, thumbnail, duration, processing status", tag: "P0" },
      { id: "FR-05", text: "Count views with a minimum-watch-time threshold and bot/refresh-spam dedup", tag: "P0" },
      { id: "FR-06", text: "Support likes, comments, and channel subscriptions", tag: "P1" },
      { id: "FR-07", text: "Search and browse videos by title, channel, and category", tag: "P1" },
      { id: "FR-08", text: "Recommend videos for a viewer's home feed", tag: "P1" },
      { id: "FR-09", text: "Support visibility controls (public / unlisted / private) and monetization hooks (ad insertion)", tag: "P1" },
      { id: "FR-10", text: "Give creators a near-real-time analytics dashboard (views, watch time)", tag: "P1" },
      { id: "FR-11", text: "Support live-stream ingest in addition to video-on-demand", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Playback start latency (time to first frame)", tag: "p95 < 1.5s" },
      { id: "NFR-02", text: "Metadata / manifest API latency", tag: "p99 < 100ms" },
      { id: "NFR-03", text: "Peak concurrent streams served globally", tag: "50M concurrent" },
      { id: "NFR-04", text: "Sustained upload ingest throughput", tag: "500 hrs video/min" },
      { id: "NFR-05", text: "Availability of the playback path", tag: "99.95%" },
      { id: "NFR-06", text: "Durability of stored video (no data loss)", tag: "99.999999999%" },
      { id: "NFR-07", text: "View-count freshness on the creator dashboard", tag: "< 1 min" },
      { id: "NFR-08", text: "Read-to-write ratio (hours watched/day vs. hours uploaded/day) that anchors the design", tag: "~1,400:1" },
      { id: "NFR-09", text: "CDN edge cache hit rate target", tag: "> 95%" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: where do the bytes actually go?",
      body: [
        "Before drawing boxes, put the scale on the board. 500 hours of video uploaded per minute is ~720,000 hours/day of raw footage. At a blended average bitrate across resolutions of roughly 0.9GB/hour, that is ~650TB/day of raw ingest — big, but not the scary number.",
        "The scary number is on the read side. Roughly 1 billion hours are watched per day, and if you deliver at an average of ~3Mbps blended across mobile/TV/desktop, that is on the order of 1.3 exabytes/day of egress. That single fact — egress outweighs ingest by orders of magnitude — is why almost every architectural decision below exists to keep that traffic off the origin.",
      ],
      bullets: [
        { lead: "Ingest", text: "~720,000 hours/day raw video ≈ 650TB/day landing in staging storage before any transcoding happens." },
        { lead: "Rendition ladder", text: "transcoding to ~10 renditions (144p→4K, H.264/VP9/AV1) roughly triples stored bytes, adding on the order of ~2PB/day to durable storage." },
        { lead: "Egress", text: "~1B hours watched/day at ~3Mbps average ≈ 1.3 exabytes/day delivered — this is why CDN hit rate is the single biggest lever on both cost and latency, bigger than any per-request optimization." },
      ],
      pictureTitle: "Where do the bytes actually go?",
      pictureCaption: "ingest ~650TB/day · storage adds ~2PB/day after the rendition ladder · egress ~1.3EB/day (CDN absorbs ~95% of it)",
      pictureRows: [
        { label: "Raw ingest", value: "~650TB/day", tone: "neutral" },
        { label: "Storage added after transcode", value: "~2PB/day (≈3× raw)", tone: "bad" },
        { label: "Daily egress (watch traffic)", value: "~1.3EB/day", tone: "bad" },
        { label: "Egress absorbed at the CDN edge (~95% hit)", value: "~1.24EB/day never touches origin", tone: "good" },
      ],
      remember: {
        problem: "How big are the numbers, and what do they force architecturally?",
        solution: "Ingest ~650TB/day, storage triples on transcode, egress (~1.3EB/day) dwarfs ingest by orders of magnitude.",
        why: "Every viewer re-downloads bytes that were encoded once; a platform this size is fundamentally read-amplified.",
        tradeoff: "Multi-rendition storage costs 3x the raw bytes so that delivery can be 20x cheaper via caching.",
        failure: "If egress isn't absorbed near the viewer, origin bandwidth and cost scale with 1B watch-hours/day directly.",
        mitigation: "Push nearly all egress to a multi-tier CDN; treat origin traffic as the exception, not the default path.",
      },
    },
    {
      n: 2,
      title: "Resumable chunked upload: why a single POST can't work",
      body: [
        "A 2-hour 4K source file can be 20GB+, uploaded from a phone on flaky mobile data. A naive single HTTP POST re-sends the entire file from byte zero on any dropped connection — at that size, on that network, the upload may never complete. The fix is a resumable, chunked protocol (the tus protocol is the canonical open standard) where the client uploads fixed-size byte ranges and the server tracks how far it has gotten.",
        "This isn't a nice-to-have; it's the difference between uploads succeeding at all on the networks most creators actually use, versus a P0 product failure that only shows up under real-world conditions load testing on office wifi never catches.",
      ],
      bullets: [
        { lead: "Naive single POST", text: "any interruption on a multi-GB transfer restarts the whole upload from byte 0 — effectively unusable on mobile networks." },
        { lead: "Chunked PATCH (tus)", text: "client uploads in fixed-size chunks; server persists an offset. On reconnect, the client asks 'where did we get to?' and resumes from that byte, not from zero." },
        { lead: "Parallel chunks", text: "on a good connection, multiple chunks upload concurrently over separate connections to use available bandwidth instead of one serial stream." },
        { lead: "Per-chunk integrity", text: "each chunk carries a checksum verified before the offset advances, so silent corruption is caught before it reaches the transcoding pipeline." },
      ],
      pictureTitle: "Naive POST vs. resumable chunked upload",
      pictureRows: [
        { label: "Single POST, connection drops at 90%", value: "restart from byte 0", tone: "bad" },
        { label: "Chunked (tus), connection drops at 90%", value: "resume from last acked chunk", tone: "good" },
        { label: "Parallel chunk upload on good network", value: "uses full available bandwidth", tone: "good" },
      ],
      remember: {
        problem: "Upload multi-GB video files reliably over unreliable mobile networks.",
        solution: "Resumable chunked upload (tus protocol): client PATCHes byte-range chunks, server tracks offset.",
        why: "Any interruption on a huge single-shot POST forces a full restart; chunking bounds the blast radius to one chunk.",
        tradeoff: "More client and server state (offsets, partial-upload bookkeeping) than a plain POST.",
        failure: "A single-POST upload API effectively fails for large files on real mobile networks, not just in theory.",
        mitigation: "tus-style resumable chunking plus per-chunk checksums so a bad chunk is caught and re-sent, not the whole file.",
      },
    },
    {
      n: 3,
      title: "Transcoding: chunked parallel fan-out",
      body: [
        "Encoding a 2-hour video into ten renditions serially, one after another, could take hours — unacceptable when creators expect their video to be watchable soon after upload. The fix is to split the source at GOP (group-of-pictures) boundaries into independently-decodable chunks, then fan out chunk × rendition as parallel jobs across a large worker fleet.",
        "The chunks are GOP-aligned specifically so each one can be decoded and re-encoded without needing frames from a neighboring chunk — that's what makes the fan-out embarrassingly parallel instead of a pipeline with sequential dependencies.",
      ],
      bullets: [
        { lead: "GOP-aligned splitting", text: "chunks are cut at keyframe boundaries so each decodes independently — no chunk needs frames from its neighbor." },
        { lead: "Fan-out", text: "N chunks × M renditions become N×M independent parallel jobs on a preemptible/spot compute fleet, which is what turns hours into minutes." },
        { lead: "Progressive availability", text: "lower renditions (360p/480p) are prioritized and become playable while 4K is still encoding, so 'ready to watch' doesn't wait on the whole ladder." },
        { lead: "Kafka as the job queue", text: "decouples upload rate from transcode capacity — a burst of uploads queues instead of overwhelming the worker fleet." },
      ],
      pictureTitle: "Serial vs. parallel chunked transcode",
      pictureRows: [
        { label: "Serial transcode, 2hr 4K source, full ladder", value: "hours", tone: "bad" },
        { label: "GOP-chunked, N×M parallel fan-out", value: "minutes", tone: "good" },
        { label: "360p/480p renditions", value: "ready first, playable early", tone: "good" },
      ],
      remember: {
        problem: "Encode a long video into a full rendition ladder fast enough to be watchable soon after upload.",
        solution: "GOP-aligned chunking + parallel chunk×rendition fan-out across a worker fleet, queued via Kafka.",
        why: "Independent, keyframe-aligned chunks can be encoded in any order on any worker, turning a serial job embarrassingly parallel.",
        tradeoff: "Chunk boundaries must respect GOP structure, and reassembly/packaging adds a stitching step after encoding.",
        failure: "Serial full-file transcoding of long videos can take hours, blowing past any reasonable 'ready to watch' expectation.",
        mitigation: "Prioritize low renditions first for early playability; use spot/preemptible compute since jobs are retryable and stateless.",
      },
    },
    {
      n: 4,
      title: "Adaptive bitrate streaming: the ladder and the manifest",
      body: [
        "A player can't know in advance what network conditions a viewer will have, and those conditions change mid-playback. The fix is to store the video as several bitrate/resolution renditions, each cut into short segments (typically 2-6 seconds), described by a manifest (HLS's .m3u8 or DASH's .mpd). The player monitors its buffer and measured bandwidth and switches renditions between segment boundaries — mid-stream, without interrupting playback.",
      ],
      bullets: [
        { lead: "Manifest", text: "lists the rendition ladder and the URL of every segment; the player, not the server, decides which rendition to fetch next." },
        { lead: "Segment duration tradeoff", text: "shorter segments let the player react to bandwidth changes faster but add per-request overhead and slightly worse compression efficiency; longer segments do the opposite." },
        { lead: "Codec tradeoff", text: "H.264 for universal device compatibility; VP9/AV1 for 30-50% smaller files at the cost of more encode CPU — ship both where the player supports it." },
        { lead: "Ladder is source-aware", text: "never generate a 4K rung from a 480p source — the ladder tops out at the source's real resolution, saving both compute and storage." },
      ],
      pictureTitle: "Adaptive bitrate switching mid-playback",
      pictureRows: [
        { label: "Bandwidth drops mid-stream", value: "player fetches next segment at a lower rung", tone: "neutral" },
        { label: "Short segments (2s)", value: "fast quality switching, more request overhead", tone: "neutral" },
        { label: "Long segments (6s)", value: "better compression, slower to react", tone: "neutral" },
        { label: "Upscaling ladder past source resolution", value: "wasted compute and storage — never do it", tone: "bad" },
      ],
      remember: {
        problem: "Serve the right quality to viewers on wildly different, changing network conditions.",
        solution: "HLS/DASH: multiple bitrate renditions cut into short segments, described by a manifest the player reads.",
        why: "Player-side switching between segment boundaries adapts to real-time bandwidth without a stall or restart.",
        tradeoff: "Segment length trades reaction speed against compression efficiency and request overhead.",
        failure: "A single fixed-bitrate stream either buffers constantly on slow networks or wastes bandwidth on fast ones.",
        mitigation: "Ladder is capped at source resolution; segment duration is tuned (commonly ~4-6s) as a deliberate middle ground.",
      },
    },
    {
      n: 5,
      title: "CDN strategy: the long-tail cold-start problem",
      body: [
        "Popular videos cache trivially — the edge node nearest a viewer already has the segment from the last request. The real risk is the long tail: millions of videos watched rarely, where the edge always misses and every request could hammer the origin directly. A multi-tier CDN (edge → regional mid-tier → origin shield) contains that fan-in so origin storage sees aggregated misses per region, not raw per-client requests.",
        "A second version of the same problem is the opposite: a brand-new video going viral. It has zero cache history, so the first wave of viewers all miss simultaneously — a cold-start stampede on a video the CDN has never seen.",
      ],
      bullets: [
        { lead: "Edge tier", text: "nodes physically close to viewers, often embedded inside ISP networks (Google's Global Cache is the canonical example) for the shortest possible hop." },
        { lead: "Regional mid-tier", text: "absorbs edge misses across a whole region, so the origin only sees one miss per region instead of one per edge node." },
        { lead: "Origin shield / request collapsing", text: "concurrent misses for the same segment from many edges get collapsed into a single origin fetch, not N duplicate fetches." },
        { lead: "Pre-warming", text: "for videos with strong early velocity signals, proactively push the rendition ladder to edge nodes ahead of the traffic spike instead of waiting for organic cache misses." },
      ],
      pictureTitle: "Long-tail cold start vs. viral cold start",
      pictureRows: [
        { label: "Popular video, steady state", value: "edge cache hit, ~95%+", tone: "good" },
        { label: "Long-tail video, rare views", value: "edge always misses, mid-tier absorbs fan-in", tone: "neutral" },
        { label: "Viral video, first wave", value: "cold-start stampede — mitigated by pre-warming", tone: "bad" },
        { label: "N simultaneous misses, same segment", value: "origin shield collapses to 1 fetch", tone: "good" },
      ],
      remember: {
        problem: "Absorb egress at the edge for both rarely-watched long-tail videos and suddenly-viral new ones.",
        solution: "Multi-tier CDN (edge, regional, origin shield) plus velocity-based pre-warming for likely-viral new uploads.",
        why: "A flat single-tier cache turns every long-tail miss and every viral spike into direct origin load.",
        tradeoff: "More infrastructure tiers and pre-warming heuristics that can occasionally warm a video that doesn't take off.",
        failure: "Without an origin shield, a viral video's first wave sends thousands of duplicate concurrent requests to origin.",
        mitigation: "Request collapsing at the shield tier plus regional mid-tier caching absorbs both failure modes.",
      },
    },
    {
      n: 6,
      title: "View counting at scale: approximate, deduplicated, batched",
      body: [
        "A naive 'increment a counter on every play click' write pattern breaks two ways at once: on a viral video it means millions of writes per second serializing on one hot row, and it's trivially gameable — a bot or a bored viewer refreshing a page shouldn't move the count. The fix redefines what a 'view' even is, then moves the counting off the write-per-click path entirely.",
        "A view only counts after a minimum watch-time threshold (roughly 30 seconds, or some percentage of the video). Clients emit watch-progress pings asynchronously to Kafka; a stream job (Flink) windows and deduplicates them per (user, video, time-window), and only the aggregated deltas — not individual events — get flushed into a counter store.",
      ],
      bullets: [
        { lead: "Definition, not just counting", text: "a 'view' requires a minimum watch threshold, filtering out accidental clicks and the simplest bot hits before anything is counted." },
        { lead: "Hot-row problem", text: "direct per-click DB increments on a viral video's row would serialize writes on that one row; instead, sum in-stream first, write deltas." },
        { lead: "Dedup window", text: "grouped by (user, video, time-window) so refresh-spam or repeated pings from one viewer in one sitting don't multiply the count." },
        { lead: "Eventually consistent by design", text: "the publicly displayed count lags by roughly a minute and is intentionally rounded at high magnitudes — exactness was never the product requirement." },
      ],
      pictureTitle: "From play click to displayed count",
      pictureRows: [
        { label: "Naive: DB increment per click", value: "hot-row serialization on viral videos", tone: "bad" },
        { label: "Watch-progress pings → Kafka", value: "async, off the playback critical path", tone: "good" },
        { label: "Flink: window + dedup + threshold", value: "filters bots/refresh-spam before counting", tone: "good" },
        { label: "Aggregated deltas → counter store", value: "one batched write, not millions of tiny ones", tone: "good" },
      ],
      remember: {
        problem: "Count views at massive scale without a hot-row bottleneck or trivial gaming.",
        solution: "Minimum-watch-time definition of a view, async Kafka events, Flink windowed dedup, batched delta writes.",
        why: "Aggregating in-stream turns millions of per-click writes into one small batched write per window.",
        tradeoff: "The displayed count is eventually consistent (~1 min lag) rather than exact and instantaneous.",
        failure: "Per-click DB increments melt under viral load and can be trivially inflated by refresh-spam or bots.",
        mitigation: "Windowed dedup by (user, video, time) plus a watch-time floor filters most gaming before it's ever counted.",
      },
    },
    {
      n: 7,
      title: "Metadata store and hot/cold storage tiering",
      body: [
        "Video metadata — title, owner, status, thumbnail, pointers into the rendition manifest — is a classic OLTP shape, so it lives in a sharded relational store (sharded by video_id or channel_id), entirely separate from the video bytes, which live in blob storage. The database never stores a single byte of video; it only stores pointers.",
        "Storage itself isn't uniform either. Most watch time concentrates on a small fraction of videos, so renditions get tiered by popularity: hot videos are replicated wide across the CDN and kept in fast storage tiers, while cold, rarely-watched videos get demoted to cheaper storage classes — and their least-requested renditions (a 4K rung nobody has ever requested above 480p) can be generated lazily on first request instead of always up front.",
      ],
      bullets: [
        { lead: "Shard the metadata DB", text: "by video_id or channel_id; denormalize where read paths need it (e.g. embed channel name) to avoid cross-shard joins." },
        { lead: "Bytes vs. pointers", text: "the metadata DB stores only pointers into object storage and the rendition manifest — never the video bytes themselves." },
        { lead: "Hot/cold tiering", text: "popular videos stay replicated across CDN edges and fast storage; long-tail videos move to cheaper, colder object storage classes." },
        { lead: "Lazy rendition generation", text: "generate rarely-requested high renditions on first request rather than always up front, trading a one-time cache-miss latency for large compute and storage savings." },
      ],
      pictureTitle: "Metadata vs. bytes, hot vs. cold",
      pictureRows: [
        { label: "Metadata DB", value: "sharded, stores pointers only, never bytes", tone: "neutral" },
        { label: "Hot video (top percentile of views)", value: "wide CDN replication, fast storage tier", tone: "good" },
        { label: "Cold video (long tail)", value: "cheap storage class, fewer eager renditions", tone: "neutral" },
        { label: "Never-requested 4K rung of a cold video", value: "generated lazily on first request, not up front", tone: "good" },
      ],
      remember: {
        problem: "Serve fast metadata lookups and avoid paying full storage cost for videos nobody watches at every rendition.",
        solution: "Sharded metadata DB storing only pointers, plus popularity-driven hot/cold storage tiering with lazy rendition generation.",
        why: "Metadata and bytes have completely different access patterns and cost profiles; watch time is heavily skewed by popularity.",
        tradeoff: "Lazy generation adds a one-time latency hit on the first request for a rarely-used rendition.",
        failure: "Eagerly generating and hot-storing every rendition for every video wastes enormous compute and storage on the long tail.",
        mitigation: "Track per-rendition request rates and demote/regenerate renditions based on observed, not assumed, demand.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "Two very different pipelines share one platform: a write-heavy but latency-tolerant upload/transcode pipeline, and a read-heavy, latency-critical playback pipeline. They almost never touch the same hot path.",
      "Uploads go in over a resumable chunked protocol, then get split at GOP boundaries and fanned out in parallel across chunk × rendition jobs so a full bitrate ladder is ready in minutes, not hours.",
      "Playback is adaptive bitrate streaming — a manifest lists a rendition ladder, and the player switches quality between segments based on live bandwidth, never the server.",
      "Nearly all egress (~95%+) is absorbed by a multi-tier CDN; the origin is designed to see aggregated misses, not raw client traffic, which is the only way 1.3 exabytes/day of watch traffic is affordable.",
      "View counts are approximate by design: a minimum watch-time threshold, windowed dedup, and batched aggregated writes replace a naive per-click DB increment that would melt under viral load.",
    ],
    flows: [
      {
        kind: "read",
        title: "WATCH · ~1B HOURS/DAY · P95 < 1.5S TO FIRST FRAME",
        summary:
          "The client asks the Playback API for a manifest, then fetches segments almost entirely from CDN edge nodes. The origin is only involved on a cache miss.",
        steps: [
          { label: "Client", note: "opens a video" },
          { label: "Playback API", note: "resolves metadata + rendition manifest" },
          { label: "CDN edge", note: "~95% hit, closest hop to the viewer" },
          { label: "Regional CDN tier", note: "absorbs edge misses on miss" },
          { label: "Origin shield", note: "collapses duplicate concurrent misses into one fetch" },
          { label: "Object Storage", note: "true origin, touched only on a full miss" },
          { label: "Adaptive bitrate switch", note: "player picks the next segment's rung based on live bandwidth" },
        ],
      },
      {
        kind: "write",
        title: "UPLOAD & TRANSCODE · 500 HRS/MIN",
        summary:
          "The raw file lands in staging over a resumable chunked upload, then gets split and fanned out in parallel so lower renditions become playable before the full ladder finishes.",
        steps: [
          { label: "Client", note: "resumable chunked PUT (tus)" },
          { label: "Upload Service", note: "tracks offset, verifies per-chunk checksums" },
          { label: "Raw Upload Bucket", note: "staging, pre-transcode" },
          { label: "Metadata DB", note: "row created, status=processing" },
          { label: "Kafka", note: "upload-complete event queues the transcode job" },
          { label: "Transcode Workers", note: "GOP-aligned chunks × rendition ladder, parallel fan-out" },
          { label: "Object Storage", note: "renditions written, packaged as HLS/DASH" },
          { label: "Metadata DB", note: "status=ready, thumbnails + duration set" },
        ],
      },
      {
        kind: "analytics",
        title: "VIEW COUNTING · RUNS ON THE SIDE, NEVER BLOCKS PLAYBACK",
        summary:
          "The player pings watch progress async. A stream job applies a minimum-watch-time threshold and dedup, then writes small aggregated batches instead of one write per click.",
        steps: [
          { label: "Player", note: "emits watch-progress pings" },
          { label: "Kafka", note: "async, off the playback critical path" },
          { label: "Flink", note: "windowed, dedup by (user, video, window), watch-time threshold" },
          { label: "Counter store", note: "aggregated deltas" },
          { label: "Metadata DB", note: "periodic flush, ~1min freshness for the dashboard" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "500 hours uploaded/min ≈ 720K hours/day ≈ ~650TB/day raw ingest",
          "Rendition ladder roughly triples stored bytes: ~2PB/day added to durable storage",
          "~1B hours watched/day at ~3Mbps average ≈ ~1.3 exabytes/day egress",
          "Target: CDN absorbs > 95% of that egress; origin sees the rest",
          "Playback start p95 < 1.5s; metadata/manifest API p99 < 100ms",
          "Peak concurrent streams: ~50M globally",
          "View-count freshness on the creator dashboard: < 1 min",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Resumable chunked upload (tus), not single-shot POST",
          "GOP-aligned chunking + parallel chunk×rendition transcode fan-out via Kafka",
          "Adaptive bitrate (HLS/DASH): player switches rungs, server never dictates quality",
          "Multi-tier CDN (edge, regional, origin shield) with request collapsing",
          "Velocity-based pre-warming for likely-viral new uploads",
          "View = minimum watch-time threshold + windowed dedup + batched aggregated writes",
          "Metadata DB stores only pointers; sharded by video_id, never stores bytes",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Egress dwarfs ingest by orders of magnitude — that asymmetry drives every caching decision",
          "Progressive rendition availability: low renditions playable before the full ladder finishes",
          "Long-tail cold start (rare video) vs. viral cold start (new video) are different failure modes needing different mitigations",
          "View counts are intentionally eventually consistent — exactness was never the requirement",
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
      goal: "Nail down five numbers and the split between the upload/transcode pipeline and the playback pipeline before drawing anything.",
      why: "This system has two fundamentally different workloads sharing one platform. If you don't separate them out loud in the first five minutes, you'll end up drawing one blob that hides the actual design decisions.",
      steps: [
        { kind: "ASK", text: '**"Is this closer to read-heavy or write-heavy?"** Land on "massively read-heavy" — walk them to "500 hours uploaded/min" vs. "~1B hours watched/day". Write **"upload << watch, ~1,400:1"** on the board.' },
        { kind: "ASK", text: 'Ask: **"Video-on-demand only, or live streaming too?"** Scope to VOD as the core problem; park live streaming as a P2 extension if time allows.' },
        { kind: "SAY", text: 'Propose the latency targets yourself: **"p95 time-to-first-frame under 1.5s"**, **"metadata API p99 under 100ms"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope explicitly. In: "upload", "transcoding", "adaptive playback", "CDN strategy", "view counting". Out: "recommendations ranking", "search ranking", "ads", "comments/community". "I\'ll flag if I want to circle back to any of those."' },
        { kind: "WRITE", text: 'Do the back-of-envelope math out loud: **"720K hours/day raw ≈ 650TB/day ingest"**, **"rendition ladder ≈ 3x storage ≈ 2PB/day added"**, **"1B watch-hours/day at ~3Mbps ≈ 1.3EB/day egress"**. Circle the egress number — that\'s the one that drives everything.' },
      ],
      grading: "Are the two pipelines (upload/transcode vs. playback) explicitly separated, and is the egress-vs-ingest asymmetry called out before any component gets drawn?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "A handful of endpoints and a clean separation between the metadata row and the video bytes.",
      why: "The interviewer wants to see you commit to metadata-in-a-database, bytes-in-blob-storage as a first-class decision, not something you back into later.",
      steps: [
        { kind: "WRITE", text: 'Write the core endpoints: **"POST /uploads (chunked, resumable)"** → "{ videoId, uploadUrl }". **"GET /videos/:id/manifest"** → "HLS/DASH manifest + signed segment URLs". **"POST /videos/:id/watch-events"** → "async, fire-and-forget".' },
        { kind: "DRAW", text: 'Sketch the video row: **"video_id (PK)"**, **"owner_id"**, **"status (processing/ready/failed)"**, **"duration"**, **"rendition_manifest_pointer"**, **"view_count (approximate)"**. Say it out loud: "This table never stores a byte of video — only pointers into blob storage."' },
        { kind: "SAY", text: 'Justify the sharding key: **"shard by video_id"**, and explain why: "channel pages need a secondary index or denormalized channel_id → video_id list, since we don\'t want cross-shard joins on the hot read path."' },
        { kind: "RULE OUT", text: 'Get ahead of the obvious alternative: "Storing video bytes as BLOBs in the relational DB" — reject it immediately: "the DB would need to scale to petabytes and serve massive sequential reads, which is exactly what object storage and a CDN are built for and a relational DB isn\'t."' },
      ],
      grading: "Crisp endpoint list, a metadata-only row with an explicit no-bytes-in-the-DB statement, and a sharding key defended with a reason.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: upload/write, transcode/background, and playback/read. Label arrows with traffic shares and latency budgets, not just box names.",
      why: "Drawing these as separate lanes proves you understand they have different SLAs and failure tolerances. A candidate who draws one blob misses that transcoding must never sit between an upload and a 'done' response, and view counting must never sit between a play click and video starting.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write/upload path**: Client → Upload Service (chunked, resumable) → Raw Upload Bucket, plus Upload Service → Metadata DB (status=processing). Label it **"500 hrs/min"**.' },
        { kind: "DRAW", text: 'Add the **background/transcode lane**, dropping off the raw bucket: → Kafka → Transcode Workers (parallel chunk×rendition fan-out) → Object Storage (rendition ladder) + Metadata DB (status=ready). Label it **"async, minutes not hours"**.' },
        { kind: "DRAW", text: 'Lay down the **read/playback path**: Client → Playback API → Metadata DB (manifest lookup), then a separate hop, Client → CDN Edge → Object Storage (on a full miss), for the actual segment bytes. Label the CDN edge **"~95% hit"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different tolerances — playback is latency-critical and read-heavy, upload is write-heavy but latency-tolerant, and transcoding/view-counting are pure background work that must never leak latency into the other two."' },
      ],
      grading: "Three clearly separated lanes, CDN hit rate and traffic volumes labeled on the arrows, and an explicit statement of why background work never touches the playback critical path.",
    },
    {
      n: 4,
      title: "Deep Dive: Transcoding Pipeline",
      minutes: 8,
      goal: "Explain GOP-aligned chunking, the chunk×rendition fan-out, and why progressive rendition availability matters.",
      why: "This is the system's signature sub-problem: encoding a long video into a full bitrate ladder fast enough that 'ready to watch' doesn't mean waiting on the slowest rendition.",
      steps: [
        { kind: "SAY", text: 'Explain the chunking: "Split the source at GOP (keyframe) boundaries so each chunk decodes independently — no chunk needs frames from a neighbor. That\'s what makes the fan-out truly parallel."' },
        { kind: "DRAW", text: 'Sketch the fan-out: **"N chunks × M renditions = N×M independent jobs"** on a worker fleet. "Spot/preemptible compute works here because every job is stateless and retryable."' },
        { kind: "SAY", text: 'Call out progressive availability: "360p/480p are prioritized and become playable while 4K is still encoding — \'ready to watch\' doesn\'t wait for the whole ladder."' },
        { kind: "RULE OUT", text: 'One line: **"Serial full-file transcode"** → hours for a long video, unacceptable. Cross it off in favor of the parallel chunked approach.' },
      ],
      grading: "GOP-aligned chunking explained as the enabler of parallelism (not just \"we use workers\"), and progressive availability volunteered without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: CDN, Cold Start, and View Counting",
      minutes: 7,
      goal: "Cover multi-tier CDN with request collapsing, distinguish long-tail cold start from viral cold start, and explain approximate view counting.",
      why: "Anyone can say 'put a CDN in front of it'. The interviewer wants the two distinct cold-start failure modes named and mitigated differently, plus a view-counting design that survives a viral video without a hot-row meltdown.",
      steps: [
        { kind: "SAY", text: 'Walk the CDN tiers: "Edge nodes closest to the viewer, a regional mid-tier that absorbs edge misses, and an origin shield that collapses N simultaneous misses for the same segment into one origin fetch."' },
        { kind: "SAY", text: 'Name both cold-start modes: "Long-tail videos always miss at the edge — the mid-tier contains that. A brand-new viral video has zero cache history, so the first wave all misses at once — that\'s mitigated with velocity-based pre-warming."' },
        { kind: "SAY", text: 'Explain view counting: "A view requires a minimum watch-time threshold. Watch-progress pings go to Kafka async, Flink windows and dedups by user/video/time, and only aggregated deltas get written — never a per-click DB increment."' },
        { kind: "SAY", text: 'Volunteer the consistency tradeoff: "The displayed count is eventually consistent, roughly a minute of lag, and rounded at high magnitudes — exactness was never the actual requirement."' },
      ],
      grading: "Both cold-start failure modes named with distinct mitigations, and view counting explained as threshold + dedup + batched writes, not just \"cache it\".",
    },
    {
      n: 6,
      title: "Wrap: Tradeoffs, Bottlenecks, and Close",
      minutes: 5,
      goal: "Name the SLA hierarchy across the three lanes, push back on a requirement, and close with a one-sentence summary plus a parked-items list.",
      why: "Staff-level signal here is naming the egress-vs-ingest asymmetry as the design's central fact, treating hot/cold storage tiering as a deliberate cost lever, and closing crisply instead of trailing off.",
      steps: [
        { kind: "SAY", text: 'State the SLA hierarchy: "Playback is tier-1 and latency-critical, upload is tier-2 and latency-tolerant, transcoding and view-counting are tier-3 background work — that hierarchy is why nothing in tier-3 is ever allowed to add latency to tier-1."' },
        { kind: "SAY", text: 'Bring up storage tiering unprompted: "Most watch time concentrates on a small fraction of videos, so we tier storage by popularity and lazily generate rarely-requested high renditions instead of always encoding the full ladder up front."' },
        { kind: "SAY", text: 'Push back where useful: "Do we truly need 50M concurrent streams at global peak, or is that a regional peak? That changes CDN and origin-shield capacity planning."' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s two pipelines sharing one platform — a chunked, parallelized upload/transcode path, and a CDN-first adaptive-bitrate playback path, with view counting kept off both critical paths. With more time I\'d cover recommendations, search, and live streaming."' },
      ],
      grading: "Explicit three-tier SLA hierarchy, storage tiering volunteered unprompted, at least one pushback on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a design that mostly hangs together — upload, transcode, CDN, database — but the numbers and the failure modes stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: upload service, transcoding, CDN, database, and object storage if prompted.",
          "Knows video should be stored separately from metadata, not as a DB blob.",
          "Mentions adaptive bitrate streaming by name (HLS or DASH) when asked how quality adapts.",
          "Adds a CDN in front of video delivery without being told to.",
          "Handles 'what about view counts' by adding a counter column and incrementing it.",
        ],
        gaps: [
          "Doesn't do the ingest/storage/egress math out loud, or just says 'lots of video, lots of storage'.",
          "Transcodes the whole file serially in their mental model, with no idea why that's slow.",
          "CDN is a single flat tier with no origin shield or request-collapsing concept.",
          "View counting is a raw per-click DB increment, with no idea it would melt under viral load.",
          "Doesn't distinguish upload latency tolerance from playback latency criticality.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, separates the upload/transcode pipeline from the playback pipeline, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the ingest/storage/egress numbers on the board within the first five minutes.",
          "Explains GOP-aligned chunked parallel transcoding, not just 'a worker pool'.",
          "Describes a multi-tier CDN (edge + regional + origin) with the reasoning for each tier.",
          "Designs view counting with a watch-time threshold and dedup, not a raw increment.",
          "Separates the metadata DB (pointers only) from object storage (bytes) as a deliberate choice.",
          "Names the egress-vs-ingest asymmetry as the driver of CDN strategy.",
        ],
        gaps: [
          "Names request collapsing / origin shield only after being prompted, not on their own.",
          "Doesn't distinguish long-tail cold start from viral cold start as two different failure modes.",
          "Storage tiering (hot/cold, lazy rendition generation) comes up only if time allows, not volunteered.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats the egress-vs-ingest asymmetry as the design's organizing fact, and surfaces both cold-start failure modes and their distinct mitigations before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "States the ~1.3EB/day egress vs. ~650TB/day ingest asymmetry unprompted and uses it to justify every caching decision.",
          "Distinguishes long-tail cold start (rare video, edge always misses) from viral cold start (new video, zero cache history) with different mitigations for each.",
          "Volunteers progressive rendition availability — low renditions playable before the full ladder finishes — without being asked how transcoding affects time-to-watch.",
          "Frames view counting's eventual consistency as a deliberate product decision, not a limitation apologized for.",
          "Brings up popularity-driven storage tiering and lazy rendition generation as a cost lever unprompted.",
          "Pushes back on requirements ('is 50M concurrent a global or regional peak?') and adjusts the design accordingly.",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Storing video bytes directly in the relational database instead of object storage — this alone signals a fundamental misunderstanding of the access pattern.",
      "Transcoding the whole file serially with no fan-out plan, with no idea why that makes a long video unwatchable for hours after upload.",
      "A single-tier CDN with no origin shield or request collapsing, so a viral video's first wave hits the origin directly with thousands of duplicate requests.",
      "A raw per-click view-count increment with no dedup or watch-time threshold — trivially gameable and a hot-row bottleneck on any popular video.",
      "Treating upload and playback as one undifferentiated path with the same latency budget, instead of recognizing upload is latency-tolerant and playback is latency-critical.",
      "No numbers at all — 'lots of video, lots of viewers' with no ingest/storage/egress math to justify any component's sizing.",
      "Putting analytics or view-counting writes on the playback critical path, so a stream-processing hiccup could add latency to starting a video.",
    ],
    followUps: [
      {
        q: "Why not transcode on upload synchronously and only mark the video ready when everything is done?",
        a: "Because creators expect their video to be watchable soon after upload, and a full rendition ladder for a long video can take a while even with parallelism. The fix is progressive availability: prioritize low renditions first so the video is playable at 360p/480p while higher renditions are still encoding in the background, then upgrade the ladder as more renditions land. Synchronous full-ladder completion would tie 'video is watchable' to the slowest rendition, which is the wrong UX.",
      },
      {
        q: "How would you handle a video going viral in the first ten minutes after upload?",
        a: "This is the viral cold-start problem — the video has zero cache history, so the first wave of viewers all miss at the edge simultaneously. Mitigate it with velocity-based pre-warming: watch for early view-rate signals (shares, rapid view growth) and proactively push the rendition ladder to edge nodes ahead of the traffic spike rather than waiting for organic cache population. On the origin side, an origin shield with request collapsing ensures even a stampede of concurrent misses becomes one origin fetch, not thousands.",
      },
      {
        q: "Why is the view count eventually consistent instead of exact and real-time?",
        a: "Because exactness was never the actual product requirement, and paying for real-time exact counts would mean a write per click on the hottest rows in the system — an unnecessary bottleneck. Counting in-stream with Flink, applying a watch-time threshold and dedup window, and flushing aggregated deltas roughly once a minute gets a count that's accurate enough for both viewers and creators, at a fraction of the write cost and with built-in resistance to refresh-spam and simple bots.",
      },
      {
        q: "How do you decide the rendition ladder for a given source video?",
        a: "Cap the ladder at the source's actual resolution and bitrate — never generate a 4K rung from a 480p source, since upscaling wastes both encode compute and storage without improving perceived quality. Below that cap, include the standard rungs (144p through the source's native resolution) since viewer bandwidth and device mix are unpredictable. For low-demand renditions specifically (e.g. a 4K rung on a video nobody has ever requested above 480p), generate lazily on first request rather than always up front.",
      },
      {
        q: "What's the tradeoff in choosing shorter vs. longer HLS/DASH segment durations?",
        a: "Shorter segments (around 2 seconds) let the player react to bandwidth changes faster, improving adaptive quality switching, but increase per-request overhead and slightly hurt compression efficiency since each segment starts fresh. Longer segments (around 6 seconds) compress better and reduce request volume, but the player is slower to react to a network drop, risking a stall. Most production systems land in the 4-6 second range as a deliberate middle ground rather than optimizing purely for one side.",
      },
      {
        q: "Why shard the metadata database by video_id instead of by channel_id?",
        a: "The read-hot path is resolving a single video's metadata for playback, which is a direct video_id lookup — sharding on that key keeps that path a single-shard read. Channel-level operations (list all videos for a channel) are comparatively rare and lower-latency-tolerant, so they can use a secondary index or a denormalized channel_id-to-video_id mapping instead of forcing the primary shard key to serve a less critical access pattern.",
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
          "This is two pipelines sharing one platform. An upload/transcode pipeline that is write-heavy but latency-tolerant, and a playback pipeline that is massively read-heavy and latency-critical. Almost every design decision exists to keep those two pipelines from touching each other's critical path.",
          "Anchor everything on the asymmetry: ~650TB/day of raw ingest versus ~1.3EB/day of egress. That gap — three or four orders of magnitude — is why the CDN, not the origin, is the actual center of gravity of the system.",
        ],
      },
      {
        heading: "Sizing and why egress dominates",
        body: [
          "500 hours uploaded per minute is ~720,000 hours/day, roughly 650TB/day of raw video at a blended average bitrate. Transcoding into a rendition ladder of ~10 renditions roughly triples stored bytes, adding on the order of 2PB/day to durable storage.",
          "But ~1 billion hours watched per day at ~3Mbps average works out to roughly 1.3 exabytes/day of egress — orders of magnitude larger than ingest. Every viewer re-downloads content that was encoded once, so the system is fundamentally read-amplified, and that single fact is why nearly the entire delivery architecture is built around pushing traffic to the edge.",
        ],
      },
      {
        heading: "Upload and transcoding",
        body: [
          "Multi-GB files over unreliable mobile networks need a resumable, chunked upload protocol (tus-style) — a single POST that restarts from byte zero on any drop is not viable at this file size and network quality. Once staged, the raw file is split at GOP (keyframe) boundaries into independently-decodable chunks and fanned out as parallel chunk × rendition jobs across a worker fleet, turning what would be a serial hours-long encode into a parallel job measured in minutes.",
          "Progressive availability matters here: lower renditions are prioritized so a video becomes watchable at 360p/480p while higher renditions are still encoding, rather than gating 'ready to watch' on the slowest rendition in the ladder.",
        ],
      },
      {
        heading: "Adaptive bitrate playback",
        body: [
          "The player, not the server, decides quality. A manifest (HLS's .m3u8 or DASH's .mpd) lists the rendition ladder and every segment's URL; the player monitors buffer health and measured bandwidth and switches rungs between segment boundaries without interrupting playback. Segment duration is a deliberate tradeoff between reaction speed and compression efficiency, typically landing around 4-6 seconds in production systems.",
          "The ladder is always capped at the source video's actual resolution — generating a 4K rung from a 480p source wastes compute and storage with zero perceptual benefit.",
        ],
      },
      {
        heading: "CDN strategy and the two cold-start problems",
        body: [
          "A multi-tier CDN (edge, regional mid-tier, origin shield) is what makes the egress number affordable: edge absorbs the bulk of steady-state popular-video traffic, the regional tier absorbs edge misses so the origin only sees per-region aggregated misses, and the origin shield collapses concurrent duplicate misses for the same segment into a single origin fetch.",
          "Two distinct failure modes need naming. Long-tail cold start: millions of rarely-watched videos where the edge always misses — contained by the mid-tier, not a crisis. Viral cold start: a brand-new video with zero cache history whose first viewing wave all misses simultaneously — mitigated by velocity-based pre-warming that pushes the rendition ladder to edge nodes ahead of the spike based on early growth signals.",
        ],
      },
      {
        heading: "View counting and storage tiering as cost levers",
        body: [
          "A raw per-click DB increment fails two ways: it serializes writes on one hot row for a viral video, and it's trivially gameable. Instead, a view requires a minimum watch-time threshold, watch-progress pings flow async through Kafka, Flink windows and deduplicates by (user, video, time-window), and only aggregated deltas get flushed to a counter store roughly once a minute — the displayed count is intentionally eventually consistent.",
          "Storage itself is tiered by observed popularity: hot videos stay replicated wide across the CDN in fast storage, cold long-tail videos move to cheaper storage classes, and their least-requested renditions can be generated lazily on first request instead of always up front. Metadata (title, status, pointers) lives in a sharded relational store entirely separate from the bytes, which live in object storage — the database never stores a single byte of video.",
        ],
      },
    ],
  },
};
