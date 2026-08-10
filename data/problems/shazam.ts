import type { Problem } from "@/lib/types";

export const shazam: Problem = {
  slug: "shazam",
  num: "6.11",
  title: "Design Shazam",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design Shazam: identify a song from a 5-10 second clip recorded on a phone microphone, matched against a catalog of 50 million songs, with server-side match compute under a few hundred milliseconds — while the audio has already been through a bar's PA system, a car engine, or a TV speaker before it ever reaches the mic. ~20 million identifications a day (avg ~230/sec), spiking over 20x during a live broadcast moment everyone is watching at once, all converging on one true match hiding inside a fingerprint index holding roughly half a trillion hash postings.",
  ],
  hardParts:
    "The hard parts: building an audio fingerprint that survives noise and compression while staying cheap to hash; searching and voting across ~500 billion index postings fast enough to feel instant; and proving a match is real instead of a random hash collision — all while ingesting new songs into a live index without ever taking recognition down.",
  keyTopics: [
    "Constellation Map / Peak-Picking",
    "Combinatorial Anchor-Target Hashing",
    "Time-Offset Histogram Voting",
    "Sharded Inverted Index at ~500B Postings",
    "On-Device Fingerprinting",
  ],
  foundationsReferenced: [
    { label: "Fourier Transform / Spectrograms", tone: "blue" },
    { label: "Inverted Index", tone: "green" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Valkey / Redis", tone: "purple" },
    { label: "Kafka / Stream Processing", tone: "orange" },
    { label: "LSM Trees vs B-Trees", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "on-device FFT + hashing", col: 1, row: 2, tone: "slate" },
      { id: "cdn", label: "CDN", sub: "cover art", col: 1, row: 1, tone: "green" },
      { id: "lb", label: "API / LB", col: 2, row: 2, tone: "slate" },
      {
        id: "recognition",
        label: "Recognition Service",
        sub: "stateless · fans out lookups",
        mono: "hash lookup → time-offset histogram vote",
        col: 3,
        row: 2,
        tone: "green",
      },
      { id: "cache", label: "Valkey Cache", sub: "fingerprint-hash short-circuit", col: 4, row: 2, tone: "green" },
      { id: "index", label: "Fingerprint Index", sub: "~500B postings, sharded", col: 5, row: 2, tone: "blue" },
      { id: "kafka", label: "Kafka", col: 3, row: 3, tone: "orange" },
      { id: "flink", label: "Flink", col: 4, row: 3, tone: "orange" },
      { id: "clickhouse", label: "ClickHouse", sub: "trending charts", col: 5, row: 3, tone: "orange" },
      {
        id: "ingestion",
        label: "Ingestion Pipeline",
        sub: "async, ~100K tracks/day",
        mono: "spectrogram → peaks → combinatorial hashes",
        col: 2,
        row: 4,
        tone: "purple",
      },
      { id: "metadata", label: "Metadata Store", sub: "title/artist/art · RF=3", col: 5, row: 4, tone: "blue" },
      { id: "datalake", label: "Data Lake", sub: "unmatched clips", col: 4, row: 4, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "cdn", label: "cover art", kind: "read" },
      { from: "cdn", to: "metadata", label: "miss", kind: "read" },
      { from: "client", to: "lb", kind: "read" },
      { from: "lb", to: "recognition", kind: "read" },
      { from: "recognition", to: "cache", label: "fingerprint-hash lookup", kind: "read" },
      { from: "cache", to: "index", label: "miss · parallel fan-out", kind: "read" },
      { from: "recognition", to: "metadata", label: "resolve song_id", kind: "read" },
      { from: "recognition", to: "kafka", label: "async event", kind: "analytics" },
      { from: "kafka", to: "flink", kind: "analytics" },
      { from: "flink", to: "clickhouse", kind: "analytics" },
      { from: "flink", to: "datalake", label: "unmatched clips", kind: "analytics" },
      { from: "datalake", to: "ingestion", label: "gap signal", kind: "analytics" },
      { from: "lb", to: "ingestion", label: "new track, rare", kind: "write" },
      { from: "ingestion", to: "index", label: "bulk-write postings", kind: "write" },
      { from: "ingestion", to: "metadata", label: "song metadata", kind: "write" },
    ],
    legend: [
      { kind: "read", text: "identification path · ~5K/s peak" },
      { kind: "write", text: "catalog ingestion · async, ~100K tracks/day" },
      { kind: "analytics", text: "trending + gap detection · never blocks a match" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "lb", "recognition", "index"],
      say: "The client already did the expensive work on-device — spectrogram, peaks, hashes — so the API/LB just routes the compact fingerprint to a stateless Recognition Service, which fans hash lookups out across the Fingerprint Index in parallel and votes on the one song whose hashes line up in time.",
    },
    {
      reveal: ["metadata", "cdn"],
      say: "Once the vote picks a winner, Recognition resolves the song_id against the Metadata Store for title and artist, and the CDN serves cached cover art at the edge so image bytes never touch the identification path.",
    },
    {
      reveal: ["cache"],
      say: "During a viral broadcast moment, thousands of near-identical clips can hit the same shards in the same seconds — so a Valkey cache keyed on the fingerprint hash short-circuits repeats before they ever reach the full index fan-out.",
    },
    {
      reveal: ["ingestion"],
      say: "Growing the 50M-song catalog can't touch that hot path: an async Ingestion Pipeline runs the same spectrogram-to-hash steps as a query, then bulk-writes postings and metadata to replicas out of band, roughly 100K tracks a day.",
    },
    {
      reveal: ["kafka", "flink", "clickhouse", "datalake"],
      say: "Recognition drops a match or no-match event into Kafka and moves on. Flink aggregates it into ClickHouse for trending charts, and clips that never cleared the vote threshold land in a Data Lake that feeds the next ingestion batch — a gap-detection loop that never blocks a live identification.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Identify a song from a 5-10s audio clip captured via the phone microphone", tag: "P0" },
      { id: "FR-02", text: "Return title, artist, album, and cover art for a confident match", tag: "P0" },
      { id: "FR-03", text: "Work in noisy real-world conditions: bars, cars, TVs and radios through cheap speakers", tag: "P0" },
      { id: "FR-04", text: "Serve a catalog of 50M+ songs that keeps growing", tag: "P0" },
      { id: "FR-05", text: "Ingest new tracks into the live index continuously, without taking recognition offline", tag: "P0" },
      { id: "FR-06", text: "Return a clear 'no match' instead of guessing when the clip isn't in the catalog", tag: "P0" },
      { id: "FR-07", text: "Store per-user identification history", tag: "P1" },
      { id: "FR-08", text: "Compute global and regional trending charts from identification volume", tag: "P1" },
      { id: "FR-09", text: "Queue an identification offline and submit it once connectivity returns", tag: "P1" },
      { id: "FR-10", text: "Deep-link a match to the user's streaming service of choice", tag: "P2" },
      { id: "FR-11", text: "Detect duplicate/near-duplicate clips to avoid double-counting the same listen", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Server-side match latency once the fingerprint lands (excludes on-device recording time)", tag: "p99 < 300ms" },
      { id: "NFR-02", text: "Identification throughput, sustained during a peak live-broadcast moment (avg ~230/sec)", tag: "5K/sec peak" },
      { id: "NFR-03", text: "Recognition service availability", tag: "99.95%" },
      { id: "NFR-04", text: "False-positive rate: probability of returning the wrong song as a confident match", tag: "< 0.1%" },
      { id: "NFR-05", text: "Catalog and fingerprint index size the system must serve reads against", tag: "50M songs / ~500B hashes" },
      { id: "NFR-06", text: "Fingerprint-index lookup latency budget inside the match path", tag: "p99 < 100ms" },
      { id: "NFR-07", text: "Fingerprint payload size sent from client per 10s clip (not raw audio)", tag: "< 50KB" },
      { id: "NFR-08", text: "Catalog ingestion throughput the pipeline must absorb", tag: "100K tracks/day" },
      { id: "NFR-09", text: "Read (identify) to write (catalog-ingest) request ratio that anchors the whole design", tag: "200:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why one matching hash proves nothing",
      body: [
        "Before designing the voting logic, prove that a single matching hash is weak evidence. Each hash packs three quantities — anchor frequency, target frequency, and the time delta between them — into roughly 30 bits, giving about 1.07 billion possible values. The index holds ~500 billion postings. Divide: 500B / 1.07B ≈ 467 average postings sharing every single hash value. So one matching hash could belong to hundreds of unrelated (song, offset) pairs scattered across the entire catalog.",
        "That single fact is why the interview answer can't stop at 'hash and look up' — it has to be 'hash, look up many, and vote'. Real evidence only shows up when dozens of independently-generated hashes from the same clip agree on the same time offset inside one candidate song.",
      ],
      bullets: [
        { lead: "30-bit hash", text: "packs anchor frequency, target frequency, and Δtime into one number, giving ~1.07B possible values." },
        { lead: "500B postings / 1.07B buckets", text: "≈ 467 average collisions per hash value — any single match is close to noise." },
        { lead: "The fix isn't a bigger hash", text: "it's requiring many independently-generated hashes from the same clip to agree on the same time offset before calling it a match." },
      ],
      pictureTitle: "How much evidence does one hash match carry?",
      pictureRows: [
        { label: "1 matching hash", value: "~467 average unrelated (song, offset) collisions", tone: "bad" },
        { label: "20-30 time-aligned matching hashes", value: "astronomically unlikely by chance — real match", tone: "good" },
      ],
      remember: {
        problem: "Is a single matching fingerprint hash enough to call a match?",
        solution: "No — with ~500B postings in a ~1.07B-value hash space, one hash match averages ~467 unrelated collisions; you need a spike of time-aligned matches.",
        why: "The hash space is small relative to the index, so pigeonhole guarantees heavy bucket depth; specificity comes from the pattern of matches, not any one of them.",
        tradeoff: "Requiring many aligned matches adds a voting step to every query, but it's what turns billions of noisy candidates into one confident answer.",
        failure: "Trusting a single hash hit (or even the raw match count) without checking time alignment returns false positives constantly.",
        mitigation: "Build a time-offset histogram per candidate song and only accept a peak that clears a minimum-count threshold.",
      },
    },
    {
      n: 2,
      title: "The fingerprint algorithm: kill three, keep one",
      body: [
        "The fingerprint has to survive noise, compression, and cheap microphones while staying small enough to hash and search cheaply. Put the candidates on the board and rule them out one at a time.",
      ],
      bullets: [
        { lead: "Raw waveform / cross-correlation", text: "compares samples directly; any EQ, compression, or ambient noise shifts the waveform enough to break alignment, and it's O(length) per candidate — too slow against 50M songs. Rejected." },
        { lead: "Deep audio embeddings + ANN search", text: "a learned vector per clip, compared via approximate nearest-neighbor search. Robust and useful for adjacent fuzzy-match features, but ANN search over hundreds of billions of vectors is heavier and less exact than a hash lookup for a problem hashing already solves. Partially accepted, not primary." },
        { lead: "Single peak → single hash", text: "quantize one spectral peak's time/frequency directly into a hash key. Too coarse: the hash carries only one quantity, so the bucket-depth math above bites hard with no way to get more specific. Rejected." },
        { lead: "Constellation map + combinatorial anchor-target hashing", text: "keep only local maxima in the spectrogram — the loudest points, which survive noise and compression because energy has to change a lot to knock a true peak off the top. Pair each anchor point with several target points in a bounded zone ahead of it (fan-out ~5-10), and hash (freqAnchor, freqTarget, Δtime) together. Sparse because only peaks survive, specific because three quantities go into one hash. Winner." },
      ],
      pictureTitle: "Fingerprint algorithm: kill three, keep one",
      pictureRows: [
        { label: "Raw waveform / cross-correlation", value: "breaks on any noise/EQ, O(n) per candidate → reject", tone: "bad" },
        { label: "Deep embeddings + ANN", value: "robust but heavy; good for adjacent features → partial", tone: "neutral" },
        { label: "Single peak → single hash", value: "not specific enough, huge bucket depth → reject", tone: "bad" },
        { label: "Constellation + anchor-target hashing", value: "sparse + specific + noise-robust → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Build a fingerprint that survives real-world noise and stays cheap to hash and search.",
        solution: "Keep only spectrogram peaks (constellation map); hash each anchor peak paired with several nearby target peaks (freqA, freqB, Δt).",
        why: "Peaks are the highest-energy points, so noise rarely displaces them; pairing three quantities per hash makes each hash specific instead of relying on hash-space size alone.",
        tradeoff: "You throw away most of the spectrogram (only peaks survive), trading raw information for noise robustness and a far smaller index.",
        failure: "Waveform matching breaks under any distortion; single-quantity hashing collides too often to be useful at catalog scale.",
        mitigation: "Tune peak density and fan-out to balance index size against noise robustness, and always confirm with time-offset voting.",
      },
    },
    {
      n: 3,
      title: "Indexing ~500 billion hash postings",
      body: [
        "A query generates hundreds of hashes, and every one of them needs a fast point lookup. At ~500 billion postings, the store has to be built for high-fanout O(1)-ish reads, not general SQL.",
      ],
      bullets: [
        { lead: "Why not a relational database", text: "500B rows behind a B-tree means deep, disk-bound index traversals per lookup, and a single query needs hundreds of those lookups sub-millisecond each — not a full SQL round trip." },
        { lead: "Shard by hash value", text: "partition the hash space, like consistent hashing, across many nodes, each holding a hash → [(songID, offset), ...] posting list in memory or SSD-backed storage for O(1)-ish point reads." },
        { lead: "Fan out, gather, don't scatter-gather everything", text: "one query generates hundreds of hashes, so the recognition service fans out point lookups in parallel across shards and merges results — shard count sets the parallelism, not the query." },
        { lead: "Replicate for availability", text: "RF=3 like any critical read path store; a shard going down must not turn into 'can't identify any song whose hashes landed there'." },
      ],
      pictureTitle: "Serving ~500B postings fast",
      pictureRows: [
        { label: "RDBMS + B-tree", value: "disk-bound per lookup, doesn't survive thousands of point reads/query", tone: "bad" },
        { label: "Sharded hash→postings store", value: "O(1)-ish point lookup, parallel fan-out per query", tone: "good" },
        { label: "RF=3 replication", value: "one shard outage doesn't blind recognition for those hashes", tone: "good" },
      ],
      remember: {
        problem: "Serve point lookups for hundreds of hashes per query against ~500B postings.",
        solution: "Shard the hash space across many nodes holding hash→posting-list structures in memory/SSD; fan out per query in parallel.",
        why: "A query is hundreds of independent point lookups, not one query — the store must be built for high-fanout O(1) reads, not general SQL.",
        tradeoff: "Custom sharded infra is more operational work than a managed RDBMS, but a B-tree over 500B rows can't hit the per-lookup latency budget.",
        failure: "Putting hash postings behind a generic relational index turns each identification into thousands of slow, disk-bound lookups.",
        mitigation: "Partition by hash prefix, replicate RF=3, and keep hot shards memory-resident.",
      },
    },
    {
      n: 4,
      title: "Time-offset histogram voting",
      body: [
        "Every hash lookup returns a scattering of candidates across many songs. Voting is the step that turns that scatter into one confident answer, and it's the part interviewers probe hardest because 'just look it up' isn't enough.",
      ],
      bullets: [
        { lead: "Collect candidates", text: "every hash lookup returns (songID, songTimeOffset) postings; for each, compute delta = songTimeOffset - queryTimeOffset." },
        { lead: "Bucket by song, then by delta", text: "group candidates by songID, then histogram the delta values within each song. A true match plays the same content at a constant offset, so its true-positive hashes cluster into one delta bucket." },
        { lead: "Peak = evidence", text: "the tallest bucket's count is the match score; unrelated songs get their few colliding hashes scattered across many deltas, so no bucket stands out." },
        { lead: "Threshold and rank", text: "require the peak bucket to clear a minimum count (tens of aligned hashes) before calling it a match; return the top-scoring song, or 'no match' if nothing clears the bar." },
      ],
      pictureTitle: "Turning noisy hash hits into one confident answer",
      pictureRows: [
        { label: "True match", value: "hashes cluster into one Δt bucket → tall spike", tone: "good" },
        { label: "Random collision", value: "hashes scatter across many Δt values → no spike", tone: "bad" },
        { label: "Below threshold", value: "no bucket clears the minimum count → 'no match'", tone: "neutral" },
      ],
      remember: {
        problem: "Distinguish a real song match from random hash collisions across a huge index.",
        solution: "Histogram each candidate song's matching hashes by time offset; a real match produces a sharp peak, noise doesn't.",
        why: "A true match is time-coherent — every aligned hash agrees on the same offset between query and source — while chance collisions land at random offsets.",
        tradeoff: "Voting adds a merge/aggregation step after the index lookups, costing a bit of latency for a lot of precision.",
        failure: "Ranking by raw match count instead of peak-bucket count lets a popular song's incidental collisions outscore the true match.",
        mitigation: "Score by the tallest histogram bucket, not total hits, and enforce a minimum-count threshold before returning a result.",
      },
    },
    {
      n: 5,
      title: "The hot-song spike: same song, same second, thousands of phones",
      body: [
        "During a viral broadcast moment — a halftime show, a trending TikTok clip — tens of thousands of users can Shazam the exact same audio within the same few seconds. Unlike ordinary popularity skew, the spike here is in near-identical incoming queries, not just in the distribution of correct answers, and the fix has to sit in front of the lookup, not after it.",
      ],
      bullets: [
        { lead: "The spike is in the query, not just the result", text: "a viral moment can put 10K+ nearly-identical fingerprints through the system within seconds — the same hashes hitting the same shards, the same postings, over and over." },
        { lead: "Fingerprint-hash cache", text: "hash the compact fingerprint itself (or a coarse locality-sensitive summary of it) as a Valkey key; a repeat or near-repeat clip returns the cached (songID, confidence) in one read, skipping the full fan-out and vote." },
        { lead: "It's a short-circuit, not the source of truth", text: "the index is still the source of truth; the cache just absorbs the burst so the shards under the popular hashes don't melt during the exact seconds everyone is Shazaming the same thing." },
      ],
      pictureTitle: "What happens during a viral broadcast moment?",
      pictureRows: [
        { label: "No cache", value: "10K near-identical clips → 10K full index fan-outs", tone: "bad" },
        { label: "Fingerprint-hash cache", value: "first clip pays the fan-out, the rest are one Valkey read", tone: "good" },
      ],
      remember: {
        problem: "Absorb a burst of thousands of near-identical queries within the same few seconds (a viral broadcast moment).",
        solution: "Cache (fingerprint-hash → result) in Valkey so repeat/near-repeat clips short-circuit before the full index fan-out and vote.",
        why: "The bottleneck during a spike isn't song popularity, it's near-identical queries hammering the same hash shards at the same instant.",
        tradeoff: "Near-duplicate detection needs a locality-sensitive key, not an exact hash, or slightly different clips (different noise, timing) miss the cache.",
        failure: "Without this, a viral moment turns into thousands of full, uncached index fan-outs landing on the same hot shards simultaneously.",
        mitigation: "Short-circuit cache plus normal shard-level headroom for the fraction of near-duplicates the cache key doesn't catch.",
      },
    },
    {
      n: 6,
      title: "Ingesting new songs without taking recognition down",
      body: [
        "Ingestion is write-heavy and bursty by batch; identification is read-heavy and latency-critical. Mixing them on the same path risks read latency for a rare write, so ingestion runs fully async and never touches the hot path.",
      ],
      bullets: [
        { lead: "Offline batch pipeline", text: "new audio decodes to mono/resampled PCM, runs through the same spectrogram → peak-pick → combinatorial-hash steps as a query, then bulk-writes postings into index shards plus a metadata row for title/artist/art." },
        { lead: "Multiple fingerprints, one song", text: "a live version, a remaster, and a radio edit each get their own fingerprint set, all pointing at the same canonical metadata — a match on any version resolves to the same song." },
        { lead: "Never touch the live read path", text: "bulk writes land on index replicas out of band (batched inserts, not per-hash transactions), so ingestion volume never competes with identification for read latency." },
        { lead: "Close the loop on gaps", text: "log fingerprints that scored below the match threshold to a data lake; recurring unmatched clips are a signal the catalog is missing a song, feeding the ingestion queue." },
      ],
      pictureTitle: "Growing the catalog without downtime",
      pictureRows: [
        { label: "Per-hash writes on the read path", value: "contends with identification traffic → reject", tone: "bad" },
        { label: "Batched, async bulk writes", value: "ingestion and recognition never compete", tone: "good" },
        { label: "Unmatched-query log", value: "surfaces real catalog gaps for the next batch", tone: "neutral" },
      ],
      remember: {
        problem: "Add ~100K tracks/day to a live index that must keep answering identification queries.",
        solution: "Async batch pipeline (decode → fingerprint → bulk write) writes to index replicas out of band from the read path; unmatched queries feed a catalog-gap log.",
        why: "Ingestion is write-heavy and bursty by batch, identification is read-heavy and latency-critical — mixing them on the same path risks read latency for a rare write.",
        tradeoff: "New songs aren't instantly searchable; there's a batch-processing lag between upload and being identifiable.",
        failure: "Writing hash postings synchronously on the hot path would let a large catalog import degrade identification p99.",
        mitigation: "Keep ingestion fully async and batched; monitor batch lag as its own SLA, separate from identification latency.",
      },
    },
    {
      n: 7,
      title: "On-device fingerprinting: why the phone does the hashing",
      body: [
        "The phone already has the audio and spare compute, so pushing the FFT and peak-picking to the client saves bandwidth, saves server compute, and keeps raw audio off the wire entirely.",
      ],
      bullets: [
        { lead: "Raw audio vs. fingerprint", text: "10s of raw 44.1kHz PCM is roughly 1.7MB; a compressed fingerprint of the same clip is tens of KB — two orders of magnitude smaller to upload, and a fraction of the compute the server would otherwise spend on FFTs for every request." },
        { lead: "Push spectrogram + peak-picking to the client", text: "the phone has the audio and enough compute to do the FFT and peak-picking itself; only the compact hash list crosses the network, and the server never sees or stores raw audio of what the user was near." },
        { lead: "Offline queueing", text: "if there's no connectivity, the fingerprint (already computed) queues locally and submits once the network returns — the expensive on-device step already happened." },
        { lead: "Server still owns the index and voting", text: "the split is clean: client generates evidence (hashes), server judges it (lookup + vote) — the server never needs to re-derive the fingerprint from raw audio." },
      ],
      pictureTitle: "What crosses the network per identification?",
      pictureRows: [
        { label: "Raw 10s PCM audio", value: "~1.7MB, plus server-side FFT for every request", tone: "bad" },
        { label: "On-device fingerprint", value: "tens of KB, FFT cost paid once on the phone", tone: "good" },
      ],
      remember: {
        problem: "Minimize bandwidth and server compute per identification while keeping privacy reasonable.",
        solution: "Do spectrogram + peak-picking on-device; send only the compact fingerprint (hash list) to the server.",
        why: "The phone already has the audio and spare compute; shipping raw audio wastes bandwidth and duplicates FFT work server-side for every one of millions of daily queries.",
        tradeoff: "Client-side fingerprinting logic must stay in lockstep with the server's hashing scheme (same peak-picking, quantization, hash format) across app versions.",
        failure: "A client/server fingerprint-format mismatch after an app update silently drops the match rate to zero until it's caught.",
        mitigation: "Version the fingerprint format explicitly and have the server reject/flag unknown versions instead of silently mismatching.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a nearest-match search over spectrogram fingerprints: turn a noisy clip into a sparse set of hashes, look them up, and vote on which song's hashes line up in time.",
      "The fingerprint keeps only spectrogram peaks (a constellation map) because loudest points survive noise and compression; hashing pairs of nearby peaks makes each hash specific enough to be useful.",
      "A single matching hash means almost nothing at this scale — real evidence is dozens of hashes agreeing on the same time offset, found via a per-song histogram.",
      "The index is huge (~500B hash postings), so it's sharded like any inverted index, and ingestion writes to it asynchronously so a catalog import never slows down identification.",
      "Viral broadcast moments send thousands of near-identical clips through the system at once; a fingerprint-hash cache short-circuits repeats before they ever hit the full index fan-out.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · IDENTIFY · 5K/S PEAK · P99 < 300MS",
        summary:
          "The phone does the expensive audio work and sends only a compact fingerprint. The server checks a short-circuit cache first, then fans out hash lookups across the index and votes on the winner.",
        steps: [
          { label: "Client", note: "records 5-10s, extracts spectrogram peaks + hashes on-device" },
          { label: "API / LB", note: "routes to a nearby recognition pod" },
          { label: "Recognition Service", note: "fans out hash lookups in parallel" },
          { label: "Valkey cache", note: "fingerprint-hash short-circuit for repeat/near-repeat clips" },
          { label: "Fingerprint Index", note: "sharded, ~500B postings, miss path" },
          { label: "Time-offset histogram", note: "vote: tallest aligned bucket wins" },
          { label: "Metadata Store", note: "resolve song_id → title/artist/art" },
          { label: "Response", note: "match + confidence, or 'no match'" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · CATALOG INGEST · ASYNC, ~100K TRACKS/DAY",
        summary:
          "New audio runs through the exact same fingerprinting code as a query, then the resulting hash postings are bulk-written to the index out of band, never on the identification path.",
        steps: [
          { label: "Ingestion request", note: "new track from a label or partner" },
          { label: "Decode / resample", note: "mono, standard sample rate" },
          { label: "Spectrogram + peak-pick", note: "constellation map" },
          { label: "Combinatorial hashing", note: "anchor-target pairs, fan-out ~5-10" },
          { label: "Bulk write", note: "Fingerprint Index + Metadata Store, batched" },
        ],
      },
      {
        kind: "analytics",
        title: "ANALYTICS · TRENDING + GAP DETECTION",
        summary:
          "The recognition service fires an event and moves on. A separate pipeline aggregates trending charts and logs unmatched clips as candidates for the next ingestion batch.",
        steps: [
          { label: "Recognition Service", note: "emits a match/no-match event" },
          { label: "Kafka", note: "sent without waiting" },
          { label: "Flink", note: "windowed aggregation" },
          { label: "ClickHouse", note: "trending charts by region" },
          { label: "Data lake", note: "unmatched clips feed the catalog-gap queue" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "50M songs in catalog, ~10K fingerprint hashes/song → ~500B total postings",
          "~20M identifications/day, avg ~230/sec, peak ~5K/sec (20x+) during big broadcasts",
          "Index storage: ~500B postings × ~10 bytes ≈ 5TB raw, ~15TB at RF=3",
          "30-bit hash (freqAnchor + freqTarget + Δtime) ≈ 1.07B buckets → ~467 avg collisions/bucket",
          "Fingerprint payload: tens of KB vs. ~1.7MB for 10s raw PCM",
          "Match threshold: tens of time-aligned hashes in one histogram bucket",
          "~100K new tracks/day feeding ingestion",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Constellation map (peaks only) + combinatorial anchor-target hashing, not waveform matching or single-peak hashing",
          "On-device fingerprinting: client sends hashes, never raw audio",
          "Sharded hash→postings index (partition by hash prefix), not a relational B-tree",
          "Time-offset histogram voting to separate real matches from hash collisions",
          "Fingerprint-hash cache in Valkey to absorb viral-broadcast query spikes",
          "Async, batched catalog ingestion — never on the identification read path",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "A single matching hash is close to meaningless at this scale — the interviewer wants the histogram-voting argument",
          "The query spike is in near-identical *requests* (viral broadcast moment), not just popular results — different from typical Zipf-on-reads",
          "Ingestion and identification are on separate paths on purpose; a catalog import must never move p99",
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
      goal: "Lock five numbers and the scope before drawing anything, so the fingerprint, index, and cache design all fall out of data instead of guesses.",
      why: "Every later decision — hash width, index sharding, cache sizing — is a consequence of catalog size, QPS, and the noise bar. Locking these first is what separates driving the design from reacting to it.",
      steps: [
        { kind: "ASK", text: '**Is this closer to exact-match search or fuzzy similarity?** Land on "exact song, fuzzy audio" — distinguish from query-by-humming, which is a different system (park it). Write **"50M songs, 20M IDs/day"** top-left.' },
        { kind: "ASK", text: '**What\'s the noise/quality bar?** Land on "a real phone mic in a real environment: bar, car, TV speaker" and write **"must survive noise + compression"**.' },
        { kind: "SAY", text: 'Propose the latency target yourself: **"p99 < 300ms server-side match, once the fingerprint lands"** — recording time is separate and client-side. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "fingerprinting", "the index", "voting", "ingestion", "hot-broadcast caching". Out: "humming/singing recognition", "streaming deep-links", "billing". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the storage math out loud: **"50M songs × 10K hashes = 500B postings"**, **"500B × ~10 bytes ≈ 5TB raw"**, **"~15TB at RF=3"**. Write it on the board.' },
      ],
      grading: "Numbers written on the board, scope deliberately parked, and the latency budget locked before a single box is drawn.",
    },
    {
      n: 2,
      title: "API and Fingerprint Format",
      minutes: 5,
      goal: "Define the request/response contract and the shape of an index posting before drawing infrastructure, and bring the collision math forward unprompted.",
      why: "This shows you understand exactly what crosses the network and what a 'row' in the index looks like, before the interviewer has to ask.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoint: **"POST /identify { fingerprint: bytes }"** returns **"{ songId, title, artist, confidence } | { match: false }"**. Note: "fingerprint generated on-device, not raw audio."' },
        { kind: "DRAW", text: 'Sketch the index posting: **"hash (30-bit: freqA | freqB | Δt) → [(songId, offsetInSong), ...]"**.' },
        { kind: "SAY", text: 'Justify the hash width: "30 bits ≈ 1.07B buckets; 500B postings means ~467 average collisions per bucket — that\'s why one match isn\'t enough evidence." Bring the math forward before being asked.' },
        { kind: "RULE OUT", text: 'Cross off **raw audio upload** ("~1.7MB/clip, 100x the bandwidth, server pays FFT cost every request") and **single-peak hashing** ("birthday-style bucket depth") before being asked.' },
      ],
      grading: "Crisp endpoint, a defensible posting-row shape, and the bucket-collision math brought forward unprompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled paths: identification, ingestion, and analytics. Label arrows with numbers, not box names.",
      why: "Drawing identification, ingestion, and analytics as separate lanes proves you know they have different SLAs — a candidate who draws one blob misses that ingestion must never touch identification latency.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → API/LB → Recognition Service → Valkey (fingerprint-hash cache) → Fingerprint Index (miss) → Metadata Store → response. Label **"~5K/s peak"**, **"p99 < 300ms"**.' },
        { kind: "DRAW", text: 'Add the **write (ingestion) path** as a separate lane: Ingestion Pipeline (decode → spectrogram → hash) → bulk-write Index + Metadata. Label **"async, ~100K tracks/day"**.' },
        { kind: "DRAW", text: 'Add the **analytics path**, dashed: Recognition Service → Kafka → Flink → ClickHouse (trending); unmatched clips → data lake → gap queue. Label **"never blocks identification"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes, three SLAs — identification is latency-critical tier-1, ingestion is async tier-2, analytics and gap-detection are best-effort tier-3."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with numbers, and an explicit statement that ingestion and analytics never sit on the identification path.",
    },
    {
      n: 4,
      title: "Deep Dive: Fingerprinting and Hashing",
      minutes: 8,
      goal: "Show the constellation map and combinatorial hashing, and defend it against three alternatives.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can build a fingerprint that's both noise-robust and specific enough to search cheaply.",
      steps: [
        { kind: "DRAW", text: 'Sketch a spectrogram with a handful of marked peaks: "keep only local maxima — the loudest points survive noise and compression."' },
        { kind: "SAY", text: 'Explain combinatorial hashing: "pair each anchor peak with ~5-10 target peaks in a bounded zone ahead of it; hash (freqAnchor, freqTarget, Δt) into one 30-bit value. Sparse because only peaks, specific because three quantities per hash."' },
        { kind: "SAY", text: 'Explain the noise-robustness argument: "additive noise has to move a true local maximum a lot before it stops being the maximum, so peaks stay stable even when the raw waveform doesn\'t."' },
        { kind: "RULE OUT", text: 'One line each: **waveform cross-correlation** → breaks under any distortion, O(n) per candidate. **Single-peak hashing** → too coarse, birthday-style bucket depth. **Embeddings + ANN** → heavier, better for adjacent fuzzy-match features, not the primary path.' },
      ],
      grading: "Constellation map + combinatorial hashing explained without prompting, plus a one-line rejection for each alternative.",
    },
    {
      n: 5,
      title: "Deep Dive: Index at Scale and Voting",
      minutes: 7,
      goal: "Walk the sharded index and time-offset histogram voting with real numbers, then volunteer the hot-broadcast caching story.",
      why: "The interviewer wants to see an inverted index scaled to ~500B postings and a concrete plan for turning noisy hits into one confident answer — and, for the top score, the hot-broadcast case named before being asked.",
      steps: [
        { kind: "SAY", text: 'Explain sharding: "partition the hash space across many nodes, like consistent hashing; each shard holds hash→posting-list, RF=3. A query is hundreds of parallel point lookups, not one query."' },
        { kind: "SAY", text: 'Explain voting: "for every candidate hash hit, bucket by (songId, songOffset - queryOffset); a real match is time-coherent so it produces one tall bucket, noise scatters across many."' },
        { kind: "SAY", text: 'Explain the threshold: "score by the tallest bucket, require a minimum aligned-hash count before calling it a match, otherwise return \'no match\'."' },
        { kind: "SAY", text: 'Volunteer the hot-broadcast case: "during a viral moment thousands of near-identical clips hit the same shards in the same seconds; a fingerprint-hash cache in Valkey short-circuits the repeats before the full fan-out."' },
      ],
      grading: "Sharded-index reasoning with numbers, histogram voting explained unprompted, and the hot-broadcast caching volunteered rather than hinted at.",
    },
    {
      n: 6,
      title: "Wrap: Bottlenecks, Tiers, and Ingestion",
      minutes: 5,
      goal: "Name the SLA tiers, the ingestion story, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: explicit SLA tiers, ingestion framed as async-by-design rather than a bolt-on, and a clean close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: 'State the tiers: "identification tier-1, latency-critical; ingestion tier-2, async and batched; trending and gap-detection tier-3, best-effort."' },
        { kind: "SAY", text: 'Reinforce ingestion: "new tracks run through the exact same fingerprinting code as a query, then bulk-write to index replicas out of band — never on the read path."' },
        { kind: "SAY", text: 'Push back where useful: "do we need 5K/sec globally, or is that a handful of regional hot spots during specific broadcasts? That changes how I provision headroom." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a fuzzy-audio-to-exact-match search: peak-based fingerprints, combinatorial hashing, a sharded index, and time-offset voting, with async ingestion and a hot-broadcast cache. With more time I\'d cover query-by-humming and streaming-service deep links."' },
      ],
      grading: "Explicit SLA tiers, ingestion framed as async-by-design, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that recognizes songs but treats the fingerprint and the index as black boxes; the noise-robustness and false-positive story stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right shape: client records audio, server matches against a big database, returns song info.",
          "Knows spectrograms/FFT are involved and that you can't just compare raw waveforms.",
          "Adds a cache in front of the database because reads dominate.",
          "Can sketch a basic hash-based lookup even if the hash design isn't well justified.",
          "Handles 'what if there's no match' by returning an empty result.",
        ],
        gaps: [
          "Treats a single matching hash as a match, with no discussion of collisions or voting.",
          "Doesn't reason about index size (hundreds of billions of postings) or why a normal database can't hold it.",
          "No noise-robustness story beyond 'use a good algorithm'.",
          "Doesn't separate ingestion from the identification read path.",
          "No plan for a burst of identical/near-identical queries during a viral moment.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives fingerprinting, indexing, and voting end-to-end with real numbers; explains why alternatives fail and quantifies most trade-offs when pushed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes catalog size, hash count, QPS, and latency targets on the board within 5 minutes.",
          "Describes the constellation map + combinatorial hashing approach and why peaks survive noise.",
          "Sizes the index (~500B postings) and proposes sharding by hash value.",
          "Explains time-offset histogram voting to separate real matches from collisions.",
          "Keeps ingestion async and off the identification read path.",
          "Mentions on-device fingerprinting to cut bandwidth.",
        ],
        gaps: [
          "Volunteers the hot-broadcast/near-duplicate-query spike only after being prompted.",
          "Doesn't bring forward the '~467 average collisions per hash bucket' math unless asked to justify the voting step.",
          "Ingestion plan is correct but described only at a high level, with no versioning-per-song or gap-detection feedback loop.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, quantifies every risk before being asked, and shows the operational maturity of someone who has run this system, not just designed it once.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the '~30-bit hash space, ~500B postings, ~467 avg collisions per bucket' math as the reason voting exists, unprompted.",
          "Names the viral-broadcast near-duplicate-query spike as a distinct failure mode from ordinary popularity skew, with a fingerprint-hash cache as the fix.",
          "Defines explicit SLA tiers (identification / ingestion / trending) and uses them to justify every trade-off.",
          "Brings up catalog-gap detection (logging unmatched queries) as a feedback loop, not just a one-way pipeline.",
          "Pushes back on requirements ('is 5K/sec global, or a handful of regional hot spots during specific events?').",
          "Closes with a one-sentence system summary and an explicit list of what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Proposing raw waveform cross-correlation as the matching algorithm — breaks under any real-world noise and doesn't scale.",
      "Treating a single matching hash as sufficient evidence without a time-coherency/voting step.",
      "Putting the fingerprint index behind a generic relational B-tree with no sharding story at ~500B rows.",
      "Sending raw audio from the client instead of a compact on-device fingerprint.",
      "Writing new-song hash postings synchronously on the identification read path.",
      "No plan for a burst of thousands of near-identical queries during a viral broadcast moment.",
      "Returning whatever scored highest with no threshold logic, even if it's just noise.",
    ],
    followUps: [
      {
        q: "Why fingerprint peaks instead of the whole spectrogram or raw waveform?",
        a: "Peaks are the highest-energy points in the spectrogram, so noise and compression rarely displace them — that's the noise robustness. They're also sparse (a few hundred per song instead of every time-frequency bin), which keeps the index small enough to shard and search cheaply. Raw waveform matching is both noise-fragile (any distortion breaks sample alignment) and far more expensive to compare; the whole spectrogram is robust but far too large to hash and index at 50M songs.",
      },
      {
        q: "How do you handle pitch-shifted or sped-up audio, e.g., a radio station running slightly fast?",
        a: "This is a real limitation of frequency/time-delta hashing: a pitch or tempo shift moves every peak's frequency and every delta, which changes the hash entirely and can defeat exact matching. Production systems either search across a small window of expected shift hypotheses (a handful of speed variants per query, at added compute cost) or accept degraded matching for extreme shifts. Worth naming explicitly as a known gap rather than glossing over it.",
      },
      {
        q: "How would you support query-by-humming, with no original recording involved?",
        a: "A hum doesn't share spectral peaks with a studio recording, so it needs a different pipeline entirely — melody-contour matching or learned embeddings trained to map both hums and recordings into the same vector space, then approximate nearest-neighbor search. It's a separate, heavier system layered alongside the hash index, not a small tweak to it.",
      },
      {
        q: "How does the index scale as the catalog grows from 50M to 200M songs?",
        a: "Postings grow roughly linearly (200M songs × ~10K hashes ≈ 2 trillion postings), so the same sharding strategy applies with more shards. The real constraints are operational — storage footprint and replication cost — rather than algorithmic. Adding shards without a full re-shuffle is the standard consistent-hashing rebalancing problem, same as any sharded key-value store.",
      },
      {
        q: "What happens if two different songs share many hashes, e.g. a sample or a cover?",
        a: "That's legitimate ambiguity, not a bug: the histogram vote may show two credible peaks. Return top-K candidates with confidence scores instead of forcing a single answer, and treat covers/remixes as their own fingerprint sets pointing to distinct metadata rather than trying to unify them into one song.",
      },
      {
        q: "Why cache on the fingerprint hash instead of just caching by song popularity?",
        a: "Because the spike during a viral moment is in near-identical incoming queries, not in the distribution of correct answers — a popularity cache only helps after you already know the answer. A fingerprint-hash cache short-circuits before the lookup even happens, which is what actually saves the fan-out cost when thousands of people record the same broadcast in the same few seconds.",
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
          "This is a nearest-match search over audio fingerprints, not a search engine over text and not a generic recommendation system. The core operation — turn a noisy clip into a sparse set of hashes, look them up, and vote on which song's hashes line up in time — is what every other piece of the system exists to support.",
          "Anchor everything on five numbers: 50M songs, ~10K hashes/song (~500B postings total), ~20M identifications/day (avg ~250/sec, peak ~5K/sec), and a sub-300ms server-side match budget. Every structural choice below is a consequence of these numbers.",
        ],
      },
      {
        heading: "Sizing and why a single hash proves nothing",
        body: [
          "Each hash packs anchor frequency, target frequency, and their time delta into ~30 bits, giving ~1.07 billion possible values. Divide the 500 billion postings by that space and you get ~467 average collisions per hash value — a single matching hash could belong to hundreds of unrelated (song, offset) pairs.",
          "That's the reason the design can't stop at 'hash and look up': it needs a voting step where dozens of independently-generated hashes from the same clip agree on the same time offset before the system calls it a match.",
        ],
      },
      {
        heading: "The fingerprint: constellation map and combinatorial hashing",
        body: [
          "The spectrogram is reduced to a constellation map — only local maxima, the loudest points, because additive noise has to move a lot before it knocks a true peak off the top. That's what makes the fingerprint noise-robust where raw waveform comparison isn't.",
          "Each anchor peak is paired with several target peaks in a bounded zone ahead of it (fan-out ~5-10), and each pair hashes to (freqAnchor, freqTarget, Δtime). This is sparse (only peaks, not every spectrogram bin) and specific (three quantities per hash instead of one), which is what makes the 30-bit hash space workable at all. Waveform cross-correlation, single-peak hashing, and even deep-embedding ANN search all lose to this for the primary matching path — the first two on robustness or scale, the third on being heavier than the problem requires.",
        ],
      },
      {
        heading: "Indexing ~500 billion postings and voting on the result",
        body: [
          "A query is hundreds of parallel point lookups, not one query, so the index shards the hash space across many nodes (consistent-hashing style), each holding hash→posting-list structures in memory or on SSD for O(1)-ish reads, replicated RF=3. A relational B-tree can't survive that access pattern at this scale.",
          "Every hash hit becomes a (songID, delta) candidate, where delta = songOffset − queryOffset. Bucket candidates by song, then by delta: a true match is time-coherent, so its hashes cluster into one tall histogram bucket, while random collisions scatter across many deltas. Score by the tallest bucket, require a minimum count, and return 'no match' if nothing clears the bar.",
        ],
      },
      {
        heading: "The hot-broadcast spike and on-device fingerprinting",
        body: [
          "Unlike ordinary read skew, a viral broadcast moment sends thousands of near-identical queries — not just requests for a popular result — through the system within the same few seconds. A fingerprint-hash cache in Valkey short-circuits repeats and near-repeats before they ever reach the full index fan-out, which is what actually protects the hot shards.",
          "On-device fingerprinting compounds the savings: the phone already has the audio and the compute, so shipping a tens-of-KB fingerprint instead of ~1.7MB of raw PCM cuts bandwidth by two orders of magnitude and keeps the server from redoing FFT work on every single request.",
        ],
      },
      {
        heading: "Ingestion as a separate, async tier",
        body: [
          "Identification is tier-1 and latency-critical; ingestion is tier-2 and async. New tracks run through the identical fingerprinting pipeline as a query, then bulk-write postings to index replicas out of band — never as synchronous per-hash writes on the read path. Multiple versions of a song (live, remaster, radio edit) get separate fingerprint sets pointing at one canonical metadata row.",
          "Unmatched queries — clips that fell below the histogram threshold — get logged to a data lake as a feedback loop: recurring unmatched clips are a signal the catalog is missing a song, closing the loop between what users are trying to identify and what gets ingested next.",
        ],
      },
    ],
  },
};
