import type { Problem } from "@/lib/types";

export const objectStorage: Problem = {
  slug: "object-storage",
  num: "2.7",
  title: "Design Object Storage",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design an object storage system like Amazon S3 that stores 100 trillion objects across exabytes of data, serves 1M GET/sec and 100K PUT/sec globally, guarantees 99.999999999% (eleven nines) annual durability and 99.99% availability, and supports objects from 0 bytes to 5TB with multipart upload, versioning, and lifecycle tiering to cold storage.",
  ],
  hardParts:
    "The hard parts: hitting eleven-nines durability without paying for 3x replication, splitting and reassembling objects up to 5TB without ever serving a torn write, and sharding metadata across 100 trillion keys without hot-partitioning on sequential prefixes.",
  keyTopics: [
    "Erasure Coding (Reed-Solomon)",
    "Multipart Upload & Chunking",
    "Hash-Sharded Metadata Store",
    "Placement Across Failure Domains",
    "Read-After-Write Consistency",
  ],
  foundationsReferenced: [
    { label: "Erasure Coding", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Paxos / Raft", tone: "orange" },
    { label: "LSM Trees vs B-Trees", tone: "blue" },
    { label: "Merkle Trees", tone: "purple" },
    { label: "Quorum Reads/Writes", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "cdn", label: "CDN", sub: "public GET · ~30% hit", col: 1, row: 1, tone: "green" },
      { id: "client", label: "Client", col: 1, row: 2, tone: "slate" },
      { id: "lb", label: "API Gateway / LB", col: 2, row: 2, tone: "slate" },
      {
        id: "api",
        label: "Object API Service",
        sub: "stateless · REST",
        mono: "GET / PUT / DELETE / LIST",
        col: 3,
        row: 2,
        tone: "green",
      },
      {
        id: "metadata",
        label: "Metadata Store",
        sub: "hash-sharded KV · ~100T keys",
        mono: "bucket/key → shard map + version",
        col: 4,
        row: 2,
        tone: "blue",
      },
      {
        id: "placement",
        label: "Placement + EC Encoder",
        mono: "Reed-Solomon 6+3 · 4MB stripes",
        col: 3,
        row: 3,
        tone: "purple",
      },
      { id: "storage", label: "Storage Nodes", sub: "3 AZs · 9 shards/stripe", col: 4, row: 3, tone: "blue" },
      { id: "events", label: "Event Bus (Kafka)", sub: "create / delete", col: 5, row: 3, tone: "orange" },
      { id: "repair", label: "Repair / Scrubber", sub: "Merkle-tree scan", col: 3, row: 4, tone: "orange" },
      { id: "lifecycle", label: "Lifecycle Manager", sub: "Standard → IA → Glacier", col: 4, row: 4, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "cdn", kind: "read" },
      { from: "cdn", to: "lb", label: "miss", kind: "read" },
      { from: "client", to: "lb", kind: "read" },
      { from: "lb", to: "api", label: "GET", kind: "read" },
      { from: "api", to: "metadata", label: "lookup shard map", kind: "read" },
      { from: "metadata", to: "storage", label: "fetch 6-of-9 shards", kind: "read" },
      { from: "lb", to: "api", label: "PUT / multipart", kind: "write" },
      { from: "api", to: "placement", label: "chunk 4MB stripes + EC encode", kind: "write" },
      { from: "placement", to: "storage", label: "write 9 shards · 3 AZs · quorum", kind: "write" },
      { from: "placement", to: "metadata", label: "commit pointer post-quorum", kind: "write" },
      { from: "api", to: "events", label: "async event", kind: "analytics" },
      { from: "storage", to: "repair", label: "scrub · Merkle diff", kind: "analytics" },
      { from: "repair", to: "storage", label: "re-encode missing shard", kind: "analytics" },
      { from: "metadata", to: "lifecycle", label: "scan tier-eligible objects", kind: "analytics" },
      { from: "lifecycle", to: "storage", label: "rewrite to cold tier", kind: "analytics" },
      { from: "lifecycle", to: "metadata", label: "commit new shard_map + tier", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · 1M GET/sec" },
      { kind: "write", text: "write path · 100K PUT/sec" },
      { kind: "analytics", text: "background · repair, lifecycle, events — never blocks a GET or PUT" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "lb", "api", "metadata"],
      say: "A stateless Object API Service sits behind a load balancer, and every GET or PUT resolves through one Metadata Store — the single source of truth for where an object's bytes actually live.",
    },
    {
      reveal: ["placement", "storage"],
      say: "A PUT doesn't write one copy: the API hands the object to a Placement plus EC Encoder, which splits it into Reed-Solomon 6+3 stripes and writes 9 shards across 3 AZs. Only after a quorum of those shards ack does the metadata pointer commit, which is what gives us read-after-write consistency without a lock.",
    },
    {
      reveal: ["cdn"],
      say: "At 1M GET/sec most of that traffic is public reads, so a CDN sits in front and absorbs roughly 30% before it ever reaches the API service.",
    },
    {
      reveal: ["events"],
      say: "Every create or delete drops an event on a Kafka bus for downstream consumers, fire-and-forget, so a slow subscriber never adds latency to the write that triggered it.",
    },
    {
      reveal: ["repair", "lifecycle"],
      say: "Two jobs run entirely off the hot path: a Scrubber walks every stripe with Merkle checksums and re-derives any shard that's gone bad, and a Lifecycle Manager scans metadata for objects past a policy threshold and re-encodes them into cheaper cold-tier storage, committing the updated pointer when it's done.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "PUT an object up to 5TB (single request under 5GB, multipart above)", tag: "P0" },
      { id: "FR-02", text: "GET an object by bucket + key, with optional byte-range reads", tag: "P0" },
      { id: "FR-03", text: "DELETE an object (writes a delete marker when versioning is on)", tag: "P0" },
      { id: "FR-04", text: "LIST objects in a bucket with prefix/delimiter, paginated", tag: "P0" },
      { id: "FR-05", text: "Strong read-after-write consistency for new PUTs and overwrites", tag: "P0" },
      { id: "FR-06", text: "Multipart upload: initiate, upload parts in parallel, complete or abort", tag: "P0" },
      { id: "FR-07", text: "Versioning: preserve every prior version of an object when enabled", tag: "P1" },
      { id: "FR-08", text: "Lifecycle policies: auto-transition to cheaper tiers or expire after N days", tag: "P1" },
      { id: "FR-09", text: "Server-side encryption at rest, per-object data keys", tag: "P1" },
      { id: "FR-10", text: "Event notifications on object create/delete, pushed to a queue", tag: "P2" },
      { id: "FR-11", text: "Access control via bucket policies and per-object ACLs", tag: "P1" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Annual durability per object", tag: "11 nines" },
      { id: "NFR-02", text: "Availability (about 52 min downtime per year)", tag: "99.99%" },
      { id: "NFR-03", text: "PUT throughput, sustained globally", tag: "100K/sec" },
      { id: "NFR-04", text: "GET throughput, sustained globally", tag: "1M/sec" },
      { id: "NFR-05", text: "GET first-byte latency", tag: "p99 < 100ms" },
      { id: "NFR-06", text: "Metadata lookup latency", tag: "p99 < 10ms" },
      { id: "NFR-07", text: "Storage overhead over raw bytes (erasure coding ratio)", tag: "1.5x" },
      { id: "NFR-08", text: "Maximum single object size", tag: "5TB" },
      { id: "NFR-09", text: "Maximum parts per multipart upload", tag: "10,000 parts" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: eleven nines without paying for 3x replication",
      body: [
        "At 100 trillion objects and exabytes of data, the storage bill is the whole game — every durability decision gets multiplied by the size of the fleet. The naive way to survive disk and node failures is triple replication: keep three full copies. It works, but it costs 200% overhead, meaning every byte you store, you pay for three times over. At exabyte scale that is not a rounding error, it is the majority of the infrastructure budget.",
        "Erasure coding gets the same (actually better) failure tolerance for a fraction of the overhead by trading raw copies for math: split each stripe of data into 6 data blocks, compute 3 parity blocks from them (Reed-Solomon), and store all 9 across 3 availability zones. Losing any 3 of the 9 blocks is still fully recoverable. That is 1.5x overhead, not 3x — and it survives an entire AZ going dark, which 3x replication also does, at twice the cost.",
      ],
      bullets: [
        { lead: "3x replication", text: "200% overhead, survives 2 losses out of 3 copies. Simple, but the storage bill is 3x raw data forever." },
        { lead: "Reed-Solomon 6+3", text: "6 data + 3 parity shards, 1.5x overhead, survives any 3 shard losses — including one full AZ if each AZ holds exactly 3 shards." },
        { lead: "Reed-Solomon 10+4", text: "1.4x overhead, survives 4 losses, but decode is more CPU per read on reconstruction and repair traffic touches more nodes. Facebook's f4 uses this ratio for warm data." },
        { lead: "Why not go higher", text: "more parity shards buy marginal durability for real CPU and network cost on every reconstruction; 6+3 across 3 AZs is the common sweet spot for hot data." },
      ],
      pictureTitle: "Storage overhead: replication vs erasure coding",
      pictureCaption: "same failure tolerance (survive one AZ loss), very different storage bill",
      pictureRows: [
        { label: "3x replication", value: "200% overhead, survives 2 losses", tone: "bad" },
        { label: "Reed-Solomon 6+3", value: "50% overhead, survives 3 losses (1 AZ)", tone: "good" },
        { label: "Reed-Solomon 10+4", value: "40% overhead, survives 4 losses, costlier decode", tone: "neutral" },
      ],
      remember: {
        problem: "Hit 11-nines durability at exabyte scale without 3x storage cost.",
        solution: "Reed-Solomon 6+3 erasure coding: 9 shards per stripe spread across 3 AZs, 1.5x overhead.",
        why: "Losing any 3 of 9 shards is recoverable by construction; spreading 3 shards per AZ means one AZ loss is exactly the threshold, not a surprise.",
        tradeoff: "Encode/decode costs CPU on every write and reconstruction, and repair after a failure touches more nodes than a simple copy would.",
        failure: "3x replication at this scale doubles the storage bill for no extra durability once you're already surviving an AZ loss.",
        mitigation: "Use 6+3 for hot data; consider higher ratios like 10+4 only for cold, rarely-read tiers where decode cost matters less.",
      },
    },
    {
      n: 2,
      title: "Chunking and multipart upload: how a 5TB PUT actually moves",
      body: [
        "A single HTTP request cannot reliably carry 5TB — connections drop, retries would re-upload everything, and you cannot parallelize one giant stream. Multipart upload solves this at the API level: the client calls InitiateMultipartUpload, then uploads parts (5MB to 5GB each, up to 10,000 parts) independently and in parallel, then calls CompleteMultipartUpload with the ordered list of part ETags to finalize the object.",
        "Underneath multipart, there is a second layer of chunking that has nothing to do with the client's part boundaries: each part's bytes are further split into fixed-size stripes (commonly ~4MB) because Reed-Solomon operates on fixed-size blocks. So a 5GB part becomes roughly 1,280 stripes, each independently erasure-coded into 9 shards. The client's parts and the storage layer's stripes are different concerns at different layers — conflating them is a common design mistake.",
      ],
      bullets: [
        { lead: "Small object (< 5MB)", text: "single PUT, single stripe, no multipart machinery needed." },
        { lead: "Multipart parts", text: "5MB-5GB each except the last, up to 10,000 parts — lets a 5TB object upload in parallel and lets a failed part retry without restarting the whole object." },
        { lead: "Stripes inside a part", text: "each part is further sliced into ~4MB stripes because the erasure coder works on fixed block sizes; each stripe gets its own 9 shards." },
        { lead: "ETag semantics", text: "a single-PUT ETag is the MD5 of the object; a multipart ETag is MD5-of-part-MD5s plus a \"-N\" suffix, which is how clients can tell an object was uploaded in N parts." },
      ],
      pictureTitle: "Anatomy of a 5TB PUT",
      pictureRows: [
        { label: "Client parts", value: "up to 10,000 parts, 5MB–5GB each, parallel", tone: "neutral" },
        { label: "Storage stripes", value: "~4MB stripes inside each part, EC per stripe", tone: "good" },
        { label: "Abort/retry", value: "one failed part retries alone, not the whole object", tone: "good" },
      ],
      remember: {
        problem: "Upload objects up to 5TB reliably over HTTP without re-sending everything on one dropped connection.",
        solution: "Multipart API splits into client-visible parts; storage layer independently slices each part into fixed-size EC stripes.",
        why: "Parts give resumability and parallelism at the client; stripes give the erasure coder the fixed block size it needs — two different layers solving two different problems.",
        tradeoff: "More moving parts (literally) and an orchestration step (CompleteMultipartUpload) that must atomically stitch the part list into one metadata entry.",
        failure: "A single 5TB PUT with no chunking means any network blip forces a full re-upload and no parallelism.",
        mitigation: "10,000-part ceiling and 5GB-per-part ceiling are conservative bounds that keep the manifest small and the retry unit cheap.",
      },
    },
    {
      n: 3,
      title: "Erasure coding deep dive: encode, place, decode",
      body: [
        "Reed-Solomon treats each stripe as a vector and computes parity blocks using polynomial math over a finite field, such that any 6 of the resulting 9 blocks are enough to reconstruct the original 6 data blocks. This is fundamentally different from replication: there is no single 'copy' that is the source of truth — the data is mathematically distributed across all 9 shards.",
        "Placement matters as much as the math. The Placement service picks 9 storage nodes for a stripe using a variant of consistent hashing constrained by failure domains: exactly 3 shards per AZ, no two shards on the same rack or disk. That constraint is what turns 'survives any 3 shard losses' into 'survives one full AZ outage' — if shards were scattered without that constraint, an AZ loss could take more than 3 shards and the stripe would be unrecoverable.",
      ],
      bullets: [
        { lead: "Encode", text: "on write, compute 3 parity blocks from 6 data blocks via Reed-Solomon; write all 9 to distinct nodes." },
        { lead: "Place", text: "consistent hashing plus a failure-domain constraint (3 shards/AZ, no shared rack) so any single AZ or rack loss stays within the recoverable threshold." },
        { lead: "Decode", text: "a GET only needs 6 of 9 shards; the missing 3 (whichever they are) are reconstructed on the fly if the primary 6 aren't all reachable." },
        { lead: "Repair cost", text: "losing a node means re-deriving its shard from the other 8 and re-encoding — network- and CPU-heavy, which is why repair runs as a background job, not inline with reads." },
      ],
      pictureTitle: "9 shards, 3 AZs, 1 stripe",
      pictureRows: [
        { label: "AZ-1: shards 1,2,3", value: "3 of 9", tone: "neutral" },
        { label: "AZ-2: shards 4,5,6", value: "3 of 9", tone: "neutral" },
        { label: "AZ-3: shards 7,8,9", value: "3 of 9", tone: "neutral" },
        { label: "Lose all of AZ-2", value: "6 remain → still fully recoverable", tone: "good" },
      ],
      remember: {
        problem: "Reconstruct an object from partial data after node or AZ failure, without a single point of truth.",
        solution: "Reed-Solomon 6+3 with placement constrained to 3 shards per AZ across 3 AZs.",
        why: "The math tolerates any 3-of-9 loss; the placement constraint makes that threshold line up exactly with an AZ boundary.",
        tradeoff: "Reconstruction is compute- and network-heavy compared to reading a plain replica; ordinary GETs should hit 6 healthy shards directly.",
        failure: "Placing shards without a failure-domain constraint can let an AZ outage take more than 3 shards, making the stripe unrecoverable.",
        mitigation: "Enforce the 3-shards-per-AZ rule at placement time, and re-derive lost shards via background repair before a second failure compounds.",
      },
    },
    {
      n: 4,
      title: "Metadata at 100 trillion keys: kill lexicographic, keep hashed",
      body: [
        "The metadata store maps every bucket/key to its version, size, and shard locations — effectively the index for the entire system. The obvious design is to shard it by key range, sorted lexicographically, because that makes LIST fast (a prefix scan is a contiguous range). The problem: real-world key names are often sequential — timestamps, incrementing order IDs, `2024-01-01/...`, `2024-01-02/...` — which means all writes for a given hour land on the same shard. That single shard becomes the bottleneck while every other shard sits idle. This is not hypothetical: it is a documented, real failure mode object stores hit at scale.",
        "The fix is to hash-partition metadata by bucket/key instead of storing it in raw lexicographic order: `shard = hash(bucket + key) mod N`. Writes now spread uniformly regardless of key naming, because the hash destroys the sequential pattern. The cost is that LIST with a prefix can no longer be a single contiguous range scan — it becomes a scatter-gather across shards, or requires a secondary sorted index maintained specifically for listing.",
      ],
      bullets: [
        { lead: "Lexicographic sharding", text: "great for LIST (contiguous range scan), terrible for sequential key names — one shard absorbs a disproportionate share of writes." },
        { lead: "Hash-based sharding", text: "`hash(bucket+key) mod N` spreads any key pattern uniformly across shards; the classic fix for hot-partition-on-sequential-prefix." },
        { lead: "The tradeoff moves, it doesn't disappear", text: "LIST now needs a scatter-gather or a separately maintained sorted secondary index — you're not getting both properties for free." },
        { lead: "Real precedent", text: "this exact sequential-prefix hot-partition problem is why major object stores moved to automatic, hash-based internal partitioning rather than exposing raw key order to the storage layer." },
      ],
      pictureTitle: "Sequential keys vs hashed shards",
      pictureRows: [
        { label: "Lexicographic + sequential keys", value: "one hot shard, rest idle", tone: "bad" },
        { label: "Hash(bucket+key) mod N", value: "uniform write spread across shards", tone: "good" },
        { label: "LIST after hashing", value: "scatter-gather or secondary sorted index", tone: "neutral" },
      ],
      remember: {
        problem: "100 trillion keys, and naive lexicographic sharding hot-spots on sequential key names.",
        solution: "Hash-partition metadata by bucket/key; maintain LIST via scatter-gather or a secondary sorted index.",
        why: "Hashing destroys the sequential pattern that causes hot shards; it's the standard fix once you've diagnosed the failure mode.",
        tradeoff: "You give up cheap contiguous-range LIST in exchange for uniform write distribution — pick the index structure that fits your read pattern.",
        failure: "Sort-order sharding plus timestamp-prefixed keys means one shard absorbs most of the write traffic during any burst.",
        mitigation: "Hash-based primary sharding for writes and point lookups; a purpose-built sorted secondary index for prefix LIST if that's a first-class requirement.",
      },
    },
    {
      n: 5,
      title: "Read-after-write consistency: the metadata store is the only truth",
      body: [
        "The requirement is strong consistency: a GET right after a successful PUT must see the new object, every time, not eventually. This is achievable without a global lock because the write path has exactly one commit point: the metadata store's pointer for that key. Data shards get written to storage nodes first, but the object doesn't exist as far as any reader is concerned until the metadata pointer is committed — and that commit only happens after a quorum of shard writes ack.",
        "Because every read and every write goes through the same metadata store to resolve bucket/key to shard locations, there is no second copy of 'the truth' to go stale. A reader either sees the old pointer (old version, if versioning is on, or a 404 for a brand-new key) or the new one — never a half-written state, because the pointer flips atomically on commit.",
      ],
      bullets: [
        { lead: "Data before pointer", text: "shards are written to storage nodes first; the metadata pointer commits only after quorum ack, so a reader can never see a pointer to shards that don't fully exist yet." },
        { lead: "Single source of truth", text: "both GET and PUT resolve through the same metadata store — there's no separate cache or replica that could serve a stale answer for the object's current version." },
        { lead: "Atomic pointer flip", text: "an overwrite PUT doesn't mutate the old object in place; it writes new shards, then atomically swaps the metadata pointer to the new version." },
        { lead: "Versioning uses the same mechanism", text: "with versioning on, the 'atomic swap' is really 'append a new version and move the latest-pointer' — old versions stay reachable, nothing is lost mid-write." },
      ],
      pictureTitle: "Why a GET can't see a torn write",
      pictureRows: [
        { label: "Shards writing", value: "not yet referenced by metadata — invisible to GET", tone: "neutral" },
        { label: "Quorum ack + pointer commit", value: "atomic — object now exists for every reader", tone: "good" },
        { label: "Overwrite in progress", value: "old pointer still served until new one commits", tone: "good" },
      ],
      remember: {
        problem: "Guarantee strong read-after-write consistency without a global lock on every GET.",
        solution: "Metadata store is the single source of truth; the pointer commits atomically only after shard quorum ack.",
        why: "If there's exactly one place readers resolve object location, and that place only updates after data is durable, there's no window where a stale answer is possible.",
        tradeoff: "Every GET and PUT pays a metadata-store round trip; there's no shortcut via a locally cached pointer without risking staleness.",
        failure: "Committing the metadata pointer before shards are durably quorum-written would let a GET reference data that isn't fully there yet.",
        mitigation: "Strict ordering: shard quorum ack always precedes pointer commit, enforced by the write path, not left to convention.",
      },
    },
    {
      n: 6,
      title: "Self-healing: scrubbing, repair, and why it never touches the hot path",
      body: [
        "Disks fail silently far more often than they fail loudly — bit rot, a bad sector, a node that's up but serving corrupted bytes. If the only way you discover this is a customer's GET failing, you've already had an availability incident. So a background Repair/Scrubber service continuously walks every stripe, using Merkle-tree checksums per shard to detect corruption or loss without reading and comparing full data, and either flags or immediately re-derives a bad shard from the other 8.",
        "This work is deliberately kept off the read and write path. A GET reconstructs from whichever 6-of-9 shards it can reach right now; it doesn't wait for or trigger a repair. The scrubber runs continuously in the background, and by the time a second failure would push a stripe below the recoverable threshold, the first failure has usually already been repaired.",
      ],
      bullets: [
        { lead: "Merkle-tree scrub", text: "compare shard checksums in a tree structure so a single differing leaf pinpoints the corrupted block without re-reading all data — cheap enough to run continuously across an exabyte fleet." },
        { lead: "Proactive re-encode", text: "on detecting a bad or missing shard, repair reconstructs it from the healthy 6 and writes it to a new node — restoring the stripe to 9-of-9 before the next failure arrives." },
        { lead: "Never blocks a GET", text: "reads reconstruct from whatever 6 shards they can reach right now; they don't wait on or trigger a repair job." },
        { lead: "Racing failures", text: "the real risk is a second failure landing before repair finishes the first — this is why repair priority is based on how close a stripe is to the recoverable threshold, not simple FIFO." },
      ],
      pictureTitle: "Repair timeline vs a second failure",
      pictureRows: [
        { label: "Shard fails", value: "stripe now at 8-of-9, still fully readable", tone: "neutral" },
        { label: "Scrubber detects + re-encodes", value: "back to 9-of-9 before a second failure", tone: "good" },
        { label: "Second failure before repair", value: "stripe at 7-of-9 — still recoverable, urgency rises", tone: "bad" },
      ],
      remember: {
        problem: "Detect and fix silent data loss (bit rot, disk failure) before it compounds into unrecoverable loss.",
        solution: "Continuous Merkle-tree scrubbing plus background re-encode, prioritized by proximity to the recoverable threshold.",
        why: "Silent failures are only found by looking; waiting for a customer GET to fail means the incident already happened.",
        tradeoff: "Scrubbing costs continuous background I/O and CPU across the whole fleet, in exchange for catching failures before they stack up.",
        failure: "FIFO repair ordering can let a stripe already at 8-of-9 sit in queue while a healthier stripe gets fixed first, and a second failure lands before repair.",
        mitigation: "Prioritize repair queue by distance-to-threshold (a stripe at 7-of-9 jumps ahead of one at 8-of-9), not simple arrival order.",
      },
    },
    {
      n: 7,
      title: "Lifecycle tiering: the same background discipline applied to cost",
      body: [
        "Most objects are read heavily right after creation and rarely afterward — the access pattern decays fast. Lifecycle policies let a bucket owner declare rules like 'move to Infrequent Access after 30 days, move to cold/archival storage after 90 days, expire after 365.' A background Lifecycle Manager scans the metadata store for objects crossing these thresholds and rewrites them into the target tier's storage — often a different, cheaper erasure-coding ratio (e.g., 10+4 instead of 6+3) since cold data can tolerate slower reconstruction for lower storage cost.",
        "This is the same architectural pattern as repair: a background job that scans metadata, does expensive work (re-encoding, moving shards), and updates the metadata pointer atomically when done — never touching the GET/PUT hot path. The object's key and version never change; only where and how its shards are stored does.",
      ],
      bullets: [
        { lead: "Tier transitions are re-encodes", text: "moving to a cheaper tier often means re-encoding at a higher parity ratio (more overhead reduction) since cold data reads happen rarely enough that slower reconstruction is an acceptable trade." },
        { lead: "Scan, not push", text: "the Lifecycle Manager periodically scans metadata for objects crossing a policy threshold rather than scheduling a timer per object — cheaper at 100 trillion objects." },
        { lead: "Metadata pointer updates atomically", text: "same discipline as any other write: new shards land first, then the pointer (and tier field) update together." },
        { lead: "Expiration is a delete, scheduled", text: "an expiry rule is really a scheduled DELETE, going through the same delete-marker/version machinery as a manual one." },
      ],
      pictureTitle: "A cold object's journey",
      pictureRows: [
        { label: "Day 0-30: Standard", value: "6+3, hot, low-latency reads", tone: "used" },
        { label: "Day 30-90: Infrequent Access", value: "6+3 or similar, lower request cost", tone: "neutral" },
        { label: "Day 90+: Archival", value: "10+4 or higher, cheaper storage, slower restore", tone: "neutral" },
        { label: "Day 365: Expire", value: "scheduled delete via normal delete-marker path", tone: "bad" },
      ],
      remember: {
        problem: "Most data goes cold fast; paying hot-tier storage cost for it forever is wasteful at exabyte scale.",
        solution: "Lifecycle Manager scans metadata for policy-threshold crossings and re-encodes objects into cheaper tiers in the background.",
        why: "Access patterns decay predictably, so re-encoding at a higher parity ratio for rarely-read data trades slower reconstruction for a real storage cost reduction.",
        tradeoff: "Cold-tier reads are slower (sometimes requiring an explicit restore step for archival tiers) in exchange for materially lower storage cost.",
        failure: "Per-object timers at 100 trillion objects would be an enormous, unnecessary scheduling burden compared to periodic metadata scans.",
        mitigation: "Batch-scan metadata for threshold crossings; treat tier transition as just another background re-encode using the same pointer-commit discipline as repair.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a durable blob store: PUT splits an object into erasure-coded shards across 3 AZs, GET reconstructs from any 6-of-9 shards, and a metadata service is the single source of truth for where the shards live.",
      "Reed-Solomon 6+3 erasure coding replaces 3x replication, cutting storage overhead from 200% to 50% while still surviving the loss of an entire AZ.",
      "Metadata is hash-sharded by bucket/key, not stored in lexicographic key order, so sequential prefixes (timestamps, incrementing IDs) never hot-partition a single shard.",
      "Read-after-write consistency comes from the metadata store being the only source of truth — a GET is only ever answered after the write's pointer commit, never from a stale replica.",
      "Repair, lifecycle tiering, and event notifications all run off the hot path so a scrub job or a Glacier transition never adds latency to a GET or PUT.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 1M/S · P99 < 100MS",
        summary:
          "A GET resolves the object's shard locations from metadata, then pulls just enough shards to reconstruct the bytes. The CDN absorbs a chunk of public traffic before any of this even runs.",
        steps: [
          { label: "Client", note: "GET bucket/key" },
          { label: "CDN", note: "~30% hit on public objects" },
          { label: "API Gateway / LB", note: "routes to a nearby pod" },
          { label: "Object API Service", note: "stateless, resolves the request" },
          { label: "Metadata Store", note: "lookup shard map + version" },
          { label: "Storage Nodes", note: "fetch 6-of-9 shards, decode if any missing" },
          { label: "Response", note: "stream bytes back to client" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · 100K/S",
        summary:
          "A PUT chunks the object, erasure-codes each stripe into 9 shards across 3 AZs, waits for a write quorum, then commits the metadata pointer — the object doesn't exist to readers until that pointer flips.",
        steps: [
          { label: "Client", note: "PUT or multipart upload" },
          { label: "Object API Service", note: "validates, starts write" },
          { label: "Placement + EC Encoder", note: "4MB stripes, Reed-Solomon 6+3" },
          { label: "Storage Nodes", note: "write 9 shards, 3 per AZ, quorum ack" },
          { label: "Metadata Store", note: "commit pointer atomically post-quorum" },
          { label: "Event Bus", note: "async create event, doesn't block the ack" },
        ],
      },
      {
        kind: "analytics",
        title: "BACKGROUND · REPAIR + LIFECYCLE, NEVER ON THE HOT PATH",
        summary:
          "A scrubber continuously checksums shards and re-encodes anything missing or corrupted before a second failure compounds. A separate job scans metadata for lifecycle-policy thresholds and re-encodes cold objects into cheaper tiers.",
        steps: [
          { label: "Storage Nodes", note: "Merkle-tree checksums per shard" },
          { label: "Repair / Scrubber", note: "detect + re-derive missing shard from healthy 6" },
          { label: "Metadata Store", note: "scanned for lifecycle-threshold crossings" },
          { label: "Lifecycle Manager", note: "re-encode into IA/Glacier tier, update pointer" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "100T objects, exabytes of data, 1M GET/s, 100K PUT/s",
          "Durability 11 nines annually, availability 99.99%",
          "Reed-Solomon 6+3: 9 shards/stripe, 3 per AZ, 1.5x storage overhead",
          "Survives any 3-of-9 shard loss, i.e. one full AZ outage",
          "Objects 0 bytes to 5TB; multipart parts 5MB-5GB, up to 10,000 parts",
          "Stripes inside a part: ~4MB fixed blocks for the erasure coder",
          "Metadata lookup p99 < 10ms, GET first-byte p99 < 100ms",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Reed-Solomon 6+3 erasure coding, not 3x replication (1.5x vs 3x overhead)",
          "Hash-partition metadata by bucket/key, not lexicographic, to avoid hot shards",
          "Metadata store is the single source of truth for read-after-write consistency",
          "Placement constrained to 3 shards/AZ so recoverability lines up with an AZ boundary",
          "Repair and lifecycle tiering run as background scans, never inline with GET/PUT",
          "Multipart parts (client-facing) are a different layer from EC stripes (storage-facing)",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Sequential key names (timestamps, IDs) hot-partition a lexicographically-sharded metadata store — name this unprompted",
          "The pointer-commit-after-quorum ordering is what makes strong read-after-write consistency possible without a lock",
          "Repair priority should be distance-to-threshold, not FIFO, or a second failure can outrun the fix",
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
      goal: "Get five numbers and the durability/availability targets on the board before drawing anything, so the rest of the design falls out of data, not preference.",
      why: "Durability, throughput, and object-size numbers here directly determine the erasure-coding ratio, the metadata shard count, and the multipart thresholds later. Locking them first is what separates driving the design from guessing at it.",
      steps: [
        { kind: "ASK", text: '**"What durability and availability are we targeting?"** Land on "11 nines durability, 99.99% availability" and write **"11 nines / 99.99%"** in the top-left corner.' },
        { kind: "ASK", text: 'Next: **"What\'s the object size range and read:write ratio?"** Land on "0 bytes to 5TB" and roughly "10:1 read:write". Write it down.' },
        { kind: "SAY", text: 'Propose the throughput and latency targets yourself: **"1M GET/sec, 100K PUT/sec"**, **"GET p99 under 100ms first-byte"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "PUT/GET/DELETE/LIST", "multipart upload", "erasure coding for durability", "metadata scaling", "lifecycle tiering". Out: "auth/IAM details", "billing", "cross-region replication". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the storage math out loud: **"100T objects at exabyte scale"**, **"1.5x overhead at 6+3 erasure coding vs 3x for replication"**. Write the ratio comparison on the board — this is the number the rest of the design defends.' },
      ],
      grading: "Senior judgment. Are the durability/availability numbers written down before any boxes are drawn, and is the 1.5x-vs-3x overhead comparison already on the board?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Four endpoints, a shard-map metadata row, and the multipart-vs-stripe distinction drawn before it gets questioned.",
      why: "The interviewer wants to see the object model committed to early: a bucket/key namespace with immutable-per-version data and a metadata row that is clearly the source of truth, not an afterthought cache.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"PUT /bucket/key"**, **"GET /bucket/key"**, **"DELETE /bucket/key"**, **"GET /bucket?prefix="** for LIST, plus **"POST /bucket/key?uploads"** to init multipart.' },
        { kind: "DRAW", text: 'Sketch the metadata row: **"bucket, key, version_id, size, etag, storage_class, shard_map[]"**. Say: "This row is the single source of truth — a GET is only ever answered from here, never from a cache that could be stale."' },
        { kind: "SAY", text: 'Distinguish the two chunking layers up front: "Multipart parts are client-facing, up to 10,000 parts, 5MB-5GB each. Inside each part, storage further splits into ~4MB stripes for the erasure coder — two different layers, don\'t conflate them."' },
        { kind: "RULE OUT", text: 'Get ahead of the obvious alternative: "3x replication is simpler but 200% storage overhead at this scale. That\'s roughly double the infra cost for the same failure tolerance erasure coding gives us." Cross it off.' },
      ],
      grading: "Crisp endpoint list, a metadata row that clearly signals single-source-of-truth, and the multipart-vs-stripe distinction drawn without being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with read, write, and background lanes clearly separated, arrows labeled with throughput shares and the quorum/consistency point called out explicitly.",
      why: "Drawing background work (repair, lifecycle, events) as a separate lane proves you understand it must never sit on the GET/PUT hot path — the single most common mistake at this scope.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → CDN → API Gateway → Object API Service → Metadata Store → Storage Nodes. Label the last arrow **"fetch 6-of-9 shards"**.' },
        { kind: "DRAW", text: 'Add the **write path** as a separate lane: API Service → Placement + EC Encoder → Storage Nodes (**"9 shards, 3 AZs, quorum"**) → Metadata Store (**"commit pointer post-quorum"**). Say: "The pointer only commits after quorum — that ordering is what gives us read-after-write consistency without a lock."' },
        { kind: "DRAW", text: 'Add the **background lane**, dashed: Storage Nodes → Repair/Scrubber → Storage Nodes, and Metadata Store → Lifecycle Manager → Storage Nodes. Label both **"async, never blocks a GET or PUT"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different urgency levels — reads and writes are latency-critical, repair and lifecycle are best-effort background work that would be dangerous to run inline."' },
      ],
      grading: "Three clearly separated lanes, the quorum-then-pointer-commit ordering called out explicitly, and an explicit statement that repair/lifecycle never sit on the hot path.",
    },
    {
      n: 4,
      title: "Deep Dive: Erasure Coding & Durability",
      minutes: 8,
      goal: "Show the 6+3 layout, the AZ placement constraint, and defend it quantitatively against 3x replication.",
      why: "This is the signature sub-problem. The interviewer is probing whether you understand erasure coding is not just 'cheaper replication' but a placement-constrained mathematical guarantee, and whether you can quantify the tradeoff.",
      steps: [
        { kind: "DRAW", text: 'Draw one stripe: **"6 data blocks + 3 parity blocks = 9 shards"**, 3 shards per AZ across 3 AZs. "Losing any 3 of 9 is recoverable — and because it\'s exactly 3 per AZ, losing one whole AZ is exactly at that threshold, not past it."' },
        { kind: "SAY", text: 'Explain the placement constraint explicitly: "The math alone doesn\'t give you AZ-level durability — you also need placement to guarantee no more than 3 shards share a failure domain. That constraint is doing real work."' },
        { kind: "WRITE", text: 'Put the overhead numbers on the board: **"3x replication = 200% overhead"** vs **"6+3 erasure coding = 50% overhead"**, same AZ-loss tolerance.' },
        { kind: "RULE OUT", text: 'One line: "Higher ratios like 10+4 buy more tolerance and lower overhead, but cost more CPU to decode and touch more nodes on repair — reasonable for cold tiers, not for hot data."' },
      ],
      grading: "The 9-shard/3-AZ layout on the board, the placement constraint explained as doing separate work from the math, and the overhead numbers quantified without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: Metadata Scaling & Consistency",
      minutes: 7,
      goal: "Volunteer the sequential-key hot-partition problem and its fix, then explain how read-after-write consistency is achieved.",
      why: "Anyone can say 'shard the metadata'. The interviewer wants the candidate to name the specific failure mode (hot partition from sequential keys) unprompted and explain the consistency mechanism precisely.",
      steps: [
        { kind: "SAY", text: 'Volunteer the risk: "If I shard metadata lexicographically for cheap LIST, sequential keys — timestamps, incrementing IDs — all land on one shard. That shard becomes a bottleneck while the rest sit idle. This is a documented real-world failure mode."' },
        { kind: "SAY", text: 'State the fix: "Hash-partition by hash(bucket+key) instead. Writes spread uniformly regardless of key naming. The cost: LIST with a prefix is now a scatter-gather, or needs a secondary sorted index."' },
        { kind: "SAY", text: 'Explain consistency precisely: "Shards write first; the metadata pointer only commits after quorum ack. Since every GET and PUT resolves through that same metadata store, there\'s never a second stale copy of the truth to accidentally read."' },
        { kind: "SAY", text: 'Close with versioning: "Under versioning, an overwrite doesn\'t mutate in place — it writes a new version and atomically moves the latest-pointer, so a concurrent read never sees a half-written object."' },
      ],
      grading: "The sequential-key hot-partition problem named before being asked, the hash-based fix stated with its LIST tradeoff, and read-after-write consistency explained via the quorum-then-commit ordering, not hand-waved as \"we use a strongly consistent database\".",
    },
    {
      n: 6,
      title: "Wrap: Repair, Lifecycle, and Close",
      minutes: 5,
      goal: "Name the self-healing and cost-tiering story, push back on one requirement, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal here is operational maturity: naming silent-failure detection unprompted, applying the same background-job discipline to lifecycle tiering, and closing cleanly rather than trailing off.",
      steps: [
        { kind: "SAY", text: 'Bring up repair unprompted: "Disks fail silently more often than loudly — bit rot, corrupted sectors. A background scrubber uses Merkle-tree checksums to find bad shards and re-encode them before a second failure compounds."' },
        { kind: "SAY", text: 'Connect it to lifecycle: "Lifecycle tiering uses the exact same background-scan-and-re-encode pattern as repair — scan metadata for threshold crossings, re-encode into a cheaper ratio for cold data, commit the pointer. Same discipline, different trigger."' },
        { kind: "SAY", text: 'Push back where useful: "Do we really need 1M GET/sec globally, or is that per-region? That changes the metadata shard count and CDN sizing." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a durable blob store built on erasure-coded shards and a single-source-of-truth metadata layer. With more time I\'d cover cross-region replication, IAM/bucket policies, and encryption key management."' },
      ],
      grading: "Repair explained as proactive silent-failure detection, lifecycle tiering explicitly connected to the same background pattern, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but durability math and metadata scaling stay hand-wavy.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, API service, a database for metadata, storage nodes.",
          "Knows objects need to be split up for large files, usually via 'chunking' without precise numbers.",
          "Says 'replicate the data' when asked about durability, without quantifying overhead.",
          "Can write basic PUT/GET/DELETE endpoints.",
          "Handles 'what about metadata' by adding 'a database' with no sharding strategy.",
        ],
        gaps: [
          "Doesn't quantify durability (replication factor, overhead percentage) — says 'we replicate it' and stops.",
          "Doesn't distinguish multipart upload (client-facing) from internal chunking/stripes (storage-facing).",
          "No plan for metadata at scale; assumes a single database scales to 100T keys.",
          "Doesn't mention erasure coding at all, or confuses it with simple replication.",
          "No story for silent data corruption or background repair.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks erasure coding with reasons, names trade-offs when asked, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes durability, throughput, and object-size targets on the board within the first 5 minutes.",
          "Picks Reed-Solomon erasure coding over replication and can quantify the overhead (1.5x vs 3x).",
          "Distinguishes multipart parts from internal EC stripes as separate layers.",
          "Explains that metadata sharding needs to avoid lexicographic hot-partitioning when asked.",
          "Describes read-after-write consistency via the metadata store being the single source of truth.",
          "Mentions background repair and lifecycle tiering as separate concerns from the hot path.",
        ],
        gaps: [
          "Volunteers the sequential-key hot-partition risk only after being hinted at, not on their own.",
          "Doesn't bring up the AZ-placement constraint (3 shards/AZ) as separate from the erasure-coding math itself.",
          "Quantifies repair urgency loosely ('we fix it eventually') rather than by distance-to-threshold.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces the metadata hot-partition risk before being asked, and brings operational maturity beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the sequential-key hot-partition problem unprompted, with the hash-based fix and its LIST tradeoff.",
          "Explains that AZ-level durability comes from a placement constraint (3 shards/AZ) working together with the erasure-coding math, not the math alone.",
          "States the write-ordering invariant precisely: shard quorum ack always precedes metadata pointer commit, and that ordering is what gives read-after-write consistency.",
          "Frames repair priority as distance-to-threshold, not FIFO, and explains why a second failure racing the first is the real risk.",
          "Connects lifecycle tiering to the same background-scan-and-re-encode pattern as repair, rather than treating it as a separate subsystem.",
          "Pushes back on requirements where appropriate ('is 1M GET/sec global or per-region?').",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Saying 'just replicate the data 3 times' for durability without ever mentioning the storage cost or comparing it to erasure coding.",
      "Treating multipart upload parts and internal erasure-coding stripes as the same thing — they're different layers solving different problems.",
      "Sharding metadata lexicographically for LIST performance without noticing sequential key names will hot-partition it.",
      "Committing the metadata pointer before shard writes reach quorum, which would let a GET reference data that isn't durably written yet.",
      "Running repair or lifecycle tiering inline with the GET/PUT path instead of as background jobs.",
      "No failure-domain constraint on shard placement, so an AZ outage could take more than the erasure code's tolerance.",
      "Designing with no capacity numbers, so the erasure-coding ratio, shard count, and metadata partition count all become guesses.",
    ],
    followUps: [
      {
        q: "Why Reed-Solomon 6+3 instead of just replicating 3 times?",
        a: "Both tolerate losing an entire AZ if placed correctly, but replication costs 200% storage overhead (3 full copies) while 6+3 erasure coding costs only 50% overhead (9 shards to store 6 shards' worth of data). At exabyte scale that difference is the majority of the infrastructure bill. The cost you pay instead is CPU on encode/decode and more network traffic during reconstruction, which is a good trade for data that isn't read on every request.",
      },
      {
        q: "What happens if two AZs fail at once?",
        a: "With 6+3 across exactly 3 AZs (3 shards each), losing two AZs means losing 6 of 9 shards — below the 6-of-9 recoverable threshold, so that stripe is unrecoverable. This is a deliberate design boundary: two-AZ simultaneous failure is treated as outside the SLA for a single-region deployment. If it needs to be tolerated, the fix is either a higher-redundancy code (e.g., 6+6) or cross-region replication of the metadata and a subset of shards, both of which raise the overhead back up — durability and cost are always in tension and there's a line drawn somewhere.",
      },
      {
        q: "Why does hashing the metadata key hurt LIST performance, and how do you get it back?",
        a: "Lexicographic sharding makes a prefix scan a single contiguous range on one or a few shards — fast. Hashing spreads keys uniformly by hash(bucket+key), which is exactly what fixes the hot-partition problem, but it also destroys the sort order a prefix scan relies on. To get LIST back, you maintain a separate sorted secondary index (or do a scatter-gather across all shards and merge client-side), paying extra write amplification or query fan-out specifically to serve LIST, while keeping the primary path hash-sharded for uniform writes.",
      },
      {
        q: "How do you guarantee read-after-write consistency without slowing down every GET?",
        a: "The key insight is there's only one commit point: the metadata pointer. Shard writes happen first and don't affect any reader until they're durably quorum-acked; only then does the metadata store atomically flip the pointer to the new version. Every GET and PUT resolve through that same metadata store, so there's no second, possibly-stale copy of 'where is this object' to accidentally read. This doesn't add read latency because reads were always going to hit metadata first anyway — the consistency guarantee comes from write-side ordering, not from doing extra work on reads.",
      },
      {
        q: "How does the system detect data has silently corrupted before a customer notices?",
        a: "A background scrubber continuously walks every stripe, comparing per-shard checksums organized as a Merkle tree so a single differing leaf pinpoints exactly which block is corrupted without re-reading and comparing full shard contents. On detecting a bad or missing shard, it reconstructs the correct value from the healthy 6-of-9 and writes it to a new node, restoring the stripe before a second failure could push it below the recoverable threshold. This runs continuously and independently of any GET, which is the whole point — you find corruption by looking, not by waiting for a customer's read to fail.",
      },
      {
        q: "Walk me through what changes when an object moves from Standard to an archival tier.",
        a: "The Lifecycle Manager scans metadata for objects that have crossed the policy threshold (e.g., 90 days since last access), reads the current shards, re-encodes at a higher-parity, higher-density ratio (say 10+4 instead of 6+3) since archival data can tolerate slower reconstruction for a lower storage footprint, writes the new shards, and atomically updates the metadata pointer's storage_class and shard_map together. The object's key and version never change — only the physical encoding and location of its bytes do. This is architecturally the same background scan-encode-commit pattern as repair, just triggered by a policy threshold instead of a detected failure.",
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
          "This is a durable blob store where every design decision serves one goal: store an object once, reconstruct it correctly forever, without paying for full copies. The core operation isn't a lookup like a URL shortener — it's a split-and-reassemble: PUT breaks an object into erasure-coded shards spread across failure domains, GET reconstructs it from a subset of those shards, and a metadata layer is the single source of truth for where the pieces live.",
          "Anchor everything on five numbers: 100T objects, 1M GET/sec, 100K PUT/sec, 11-nines durability, and objects up to 5TB. The erasure-coding ratio, the metadata shard count, and the multipart thresholds are all consequences of these numbers, not preferences.",
        ],
      },
      {
        heading: "Durability: erasure coding over replication",
        body: [
          "3x replication survives 2 losses at 200% storage overhead. Reed-Solomon 6+3 erasure coding survives 3 losses at only 50% overhead — same or better failure tolerance for a fraction of the cost, because it trades full copies for a mathematical relationship between data and parity blocks.",
          "The math alone isn't enough: placement must constrain exactly 3 shards per AZ across 3 AZs, so that the 3-shard recoverable threshold lines up precisely with an AZ boundary. Without that placement discipline, an AZ outage could take more than 3 shards and the stripe would be unrecoverable — the constraint is doing as much work as the erasure code itself.",
        ],
      },
      {
        heading: "Chunking: two layers, not one",
        body: [
          "Multipart upload is a client-facing concern: objects up to 5TB split into up to 10,000 parts of 5MB-5GB each, uploaded independently and in parallel, letting a single failed part retry without re-sending the whole object. Internally, each part is further sliced into fixed-size stripes (~4MB) because the erasure coder operates on fixed block sizes — a 5GB part becomes roughly 1,280 independently-encoded stripes.",
          "These are genuinely different layers solving different problems: multipart gives the client resumability and parallelism; stripes give the storage layer the fixed block size Reed-Solomon needs. Conflating them is a common mistake that misses both the client-side retry story and the storage-side encoding mechanics.",
        ],
      },
      {
        heading: "Metadata at 100 trillion keys",
        body: [
          "Sharding metadata lexicographically makes LIST fast (contiguous range scans) but is fragile against real-world key naming: sequential keys like timestamps or incrementing IDs all land on the same shard, turning it into a bottleneck while the rest of the fleet idles. Hash-partitioning by hash(bucket+key) fixes this by spreading any key pattern uniformly, at the cost of turning prefix LIST into a scatter-gather or requiring a dedicated sorted secondary index.",
          "This tradeoff doesn't disappear, it moves: you choose which operation (uniform writes vs. cheap LIST) gets the fast path, based on which one actually dominates your workload.",
        ],
      },
      {
        heading: "Consistency without a lock",
        body: [
          "Strong read-after-write consistency comes from ordering, not coordination overhead on reads. Shards write to storage nodes first; the metadata pointer for that key only commits after a quorum of those writes ack. Since every GET and PUT resolves through the same metadata store, there is never a second, possibly-stale copy of 'the truth' — a reader sees either the old pointer or the new one, atomically, never a half-written state.",
          "Versioning extends this naturally: an overwrite doesn't mutate in place, it writes a new version and atomically moves the latest-pointer, so a concurrent reader is never caught mid-write.",
        ],
      },
      {
        heading: "Background discipline: repair and lifecycle share a pattern",
        body: [
          "Silent corruption (bit rot, bad sectors) is only found by looking, so a continuous Merkle-tree scrubber checksums every stripe and proactively re-derives any bad or missing shard from its 6 healthy siblings — prioritized by distance-to-recoverable-threshold so a second failure doesn't outrun the fix. None of this touches the GET/PUT hot path; reads simply reconstruct from whatever 6-of-9 shards are reachable right now.",
          "Lifecycle tiering reuses the exact same architectural pattern: a background job scans metadata for policy-threshold crossings, re-encodes cold objects at a cheaper parity ratio, and atomically updates the pointer. Repair and lifecycle are the same shape of problem — scan, do expensive work off the hot path, commit atomically — triggered by different events (a detected failure vs. an elapsed policy window).",
        ],
      },
    ],
  },
};
