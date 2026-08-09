import type { Problem } from "@/lib/types";

export const dropbox: Problem = {
  slug: "dropbox",
  num: "2.6",
  title: "Design Dropbox",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a file storage and sync service for 500M registered users (100M daily active, ~3 devices each) holding on the order of an exabyte of user data, where every local edit must propagate to a user's other devices within seconds, an upload must send only the bytes that changed rather than the whole file, and identical content across different users must be stored exactly once.",
  ],
  hardParts:
    "The hard parts: chunking and diffing files so a one-line edit to a 2GB file uploads kilobytes, not gigabytes; deduplicating blocks globally without turning the hash lookup into a write-path bottleneck; and keeping a consistent version history across devices that edit the same file offline and concurrently, without silently losing either side's work.",
  keyTopics: [
    "Content-Defined Chunking",
    "Content-Addressable Dedup",
    "Delta Sync (rsync-style diff)",
    "Long-Poll Notification Fanout",
    "Journal-Ordered Metadata & Conflict Detection",
  ],
  foundationsReferenced: [
    { label: "Merkle Trees", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "MySQL Sharding", tone: "purple" },
    { label: "Object Storage (S3)", tone: "blue" },
    { label: "Optimistic Concurrency Control", tone: "orange" },
    { label: "Pub-Sub / Long Polling", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      {
        id: "client",
        label: "Client (Desktop/Mobile)",
        sub: "FS watcher + CDC chunker",
        col: 1,
        row: 1,
        tone: "slate",
      },
      { id: "gateway", label: "API Gateway / LB", col: 2, row: 1, tone: "slate" },
      {
        id: "metadata",
        label: "Metadata Service",
        sub: "sharded MySQL",
        mono: "file tree + append-only journal",
        col: 3,
        row: 1,
        tone: "purple",
      },
      { id: "blockcache", label: "Edge Cache / CDN", sub: "hot block reads", col: 4, row: 1, tone: "green" },
      {
        id: "blockstore",
        label: "Block Storage",
        sub: "~exabyte scale, erasure-coded",
        mono: "content-addressed by SHA-256",
        col: 5,
        row: 1,
        tone: "blue",
      },
      {
        id: "blockserver",
        label: "Block Server",
        sub: "dedup check + commit",
        mono: "hash → exists? skip : store",
        col: 3,
        row: 2,
        tone: "green",
      },
      { id: "queue", label: "Kafka", sub: "change-event log", col: 2, row: 3, tone: "orange" },
      {
        id: "notify",
        label: "Notification Service",
        sub: "long-poll fanout, ~100M idle conns",
        col: 3,
        row: 3,
        tone: "orange",
      },
      {
        id: "workers",
        label: "Background Workers",
        sub: "thumbnails · virus scan · search index",
        col: 4,
        row: 3,
        tone: "orange",
      },
    ],
    edges: [
      { from: "client", to: "gateway", label: "long-poll: anything changed?", kind: "read" },
      { from: "gateway", to: "metadata", label: "journal cursor", kind: "read" },
      { from: "metadata", to: "client", label: "delta: changed block list", kind: "read" },
      { from: "client", to: "blockcache", label: "fetch missing blocks", kind: "read" },
      { from: "blockcache", to: "blockstore", label: "miss", kind: "read" },
      { from: "client", to: "gateway", label: "upload: chunk manifest", kind: "write" },
      { from: "gateway", to: "blockserver", label: "new blocks only", kind: "write" },
      { from: "blockserver", to: "blockstore", label: "dedup'd write", kind: "write" },
      { from: "blockserver", to: "metadata", label: "commit version · append journal", kind: "write" },
      { from: "metadata", to: "queue", label: "publish change event", kind: "analytics" },
      { from: "queue", to: "notify", label: "fanout", kind: "analytics" },
      { from: "notify", to: "client", label: "wake: pull now", kind: "analytics" },
      { from: "queue", to: "workers", label: "index/thumbnail jobs", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "sync/pull path · long-poll wake, then delta pull" },
      { kind: "write", text: "upload path · chunk, dedup, commit" },
      { kind: "analytics", text: "async background · notify + indexing, never blocks sync" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Upload a file or folder and sync it across all of a user's linked devices", tag: "P0" },
      { id: "FR-02", text: "Watch the local filesystem, detect changes, and upload only the changed blocks (delta sync)", tag: "P0" },
      { id: "FR-03", text: "Download files on demand or via a full sync when a new device is linked", tag: "P0" },
      { id: "FR-04", text: "Support large files (up to 50GB) via resumable, chunked upload", tag: "P0" },
      { id: "FR-05", text: "Deduplicate identical blocks globally, across all users, not just within one account", tag: "P0" },
      { id: "FR-06", text: "Propagate a change to a user's other online devices in near real time", tag: "P0" },
      { id: "FR-07", text: "Detect and resolve conflicting concurrent edits without silently discarding either side", tag: "P0" },
      { id: "FR-08", text: "File version history (30 days / N versions) with one-click restore", tag: "P1" },
      { id: "FR-09", text: "Shared folders and share links with read/write permission levels", tag: "P1" },
      { id: "FR-10", text: "Offline edits queue locally on the client and sync automatically on reconnect", tag: "P1" },
      { id: "FR-11", text: "Selective sync: choose which folders sync to a given device", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Change-to-other-device notification latency, online devices", tag: "p99 < 2s" },
      { id: "NFR-02", text: "Metadata operation latency (list, rename, move)", tag: "p99 < 100ms" },
      { id: "NFR-03", text: "Sustained block-write throughput, platform-wide", tag: "500K/sec" },
      { id: "NFR-04", text: "Total files tracked in metadata", tag: "100B files" },
      { id: "NFR-05", text: "Durability of a committed block", tag: "11 nines" },
      { id: "NFR-06", text: "Service availability", tag: "99.9%" },
      { id: "NFR-07", text: "Storage savings from dedup + compression vs. raw", tag: "2-3x" },
      { id: "NFR-08", text: "Concurrent idle long-poll connections held by the Notification Service", tag: "100M" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Chunking: fixed-size blocks vs. content-defined chunking",
      body: [
        "Before anything else, decide how a file becomes uploadable pieces. Cut a file into fixed-size 4MB blocks and everything looks fine — until someone inserts one byte at the start of a 2GB file. Every downstream block boundary shifts by one byte, so a fixed-size chunker thinks the entire file changed and re-uploads all of it. The fix is to let the content itself decide where a chunk boundary falls.",
        "Content-defined chunking (CDC) runs a rolling hash (Rabin fingerprint) over the byte stream and cuts a new chunk whenever the hash matches a pattern, for example its low 22 bits are all zero, which happens on average every 4MB. Boundaries are anchored to content, not to a byte offset, so an insertion only perturbs the chunks touching the insertion point — everything before and after resettles at the same boundaries as before.",
      ],
      bullets: [
        { lead: "Fixed-size blocks", text: "simple and fast to compute, but one inserted byte shifts every later boundary, so a tiny edit re-uploads and re-hashes the whole file. Rejected as the sole strategy." },
        { lead: "Content-defined chunking", text: "boundaries are a function of local content via a rolling hash, so an edit only invalidates the 1-2 chunks around it. Average chunk size ~4MB, min/max clamped (~2MB/~8MB) to bound chunk-table overhead. Winner." },
        { lead: "Per-file Merkle tree", text: "hash each chunk, then hash the ordered list of chunk hashes into one file hash. Two files (or two versions of one file) can be compared chunk-hash by chunk-hash without touching file bytes." },
      ],
      pictureTitle: "One inserted byte: fixed vs. content-defined",
      pictureRows: [
        { label: "Fixed 4MB blocks", value: "every boundary shifts → re-upload 100%", tone: "bad" },
        { label: "Content-defined chunking", value: "only 1-2 chunks around the edit change", tone: "good" },
      ],
      remember: {
        problem: "A 1-byte insertion shouldn't force a full re-upload of a multi-GB file.",
        solution: "Content-defined chunking: a rolling hash picks chunk boundaries from local content, ~4MB average.",
        why: "Boundaries anchor to content, so an insertion shifts only the chunks touching it — everything else resettles identically.",
        tradeoff: "Rolling-hash computation costs more CPU per byte than a naive fixed-size cut, and chunk sizes vary (clamped min/max to bound metadata).",
        failure: "Fixed-size chunking on an insert-heavy edit pattern re-uploads the entire file every time, blowing the delta-sync promise.",
        mitigation: "Clamp chunk size to a min/max band so a pathological byte stream can't produce degenerate 1-byte or 100MB chunks.",
      },
    },
    {
      n: 2,
      title: "Global dedup: content-addressable storage without a hot index",
      body: [
        "Two users uploading the same PDF, or one user copying a folder, should not double the bytes on disk. Address every block by its content hash (SHA-256) instead of an assigned ID: two identical byte sequences always produce the same key, so 'does this block already exist' is a single lookup, and storing it twice is structurally impossible — the second write just increments a reference count.",
        "The danger is that this hash lookup sits on every single upload, so at 500K blocks/sec it has to be sharded like everything else. Shard the block-existence index by hash prefix (the hash is already uniformly distributed, so this needs no separate hashing scheme, unlike sharding by user), which spreads the lookup load evenly and keeps any one shard from becoming a hot spot for a viral file.",
      ],
      bullets: [
        { lead: "Content hash as the key", text: "SHA-256 over the chunk bytes. Same bytes, same key, so identical content across any two users collapses to one stored copy automatically." },
        { lead: "Reference counting", text: "each block row tracks how many files point to it. A block is only physically deleted from storage once its refcount hits zero (and stays zero past the version-retention window)." },
        { lead: "Shard by hash prefix", text: "the hash is already uniform, so the first N bits of the hash choose the shard — no extra hashing layer needed, and load spreads evenly regardless of which files are popular." },
        { lead: "Two-phase upload", text: "client sends chunk hashes first; server replies with only the hashes it doesn't have. The client then uploads bytes for just the missing chunks — dedup saves upload bandwidth, not only storage." },
      ],
      pictureTitle: "Dedup: hash-addressed blocks, not file-addressed",
      pictureRows: [
        { label: "Same file, 2 users", value: "1 physical copy, 2 refcounts", tone: "good" },
        { label: "Hash-prefix sharding", value: "even load, no per-file hot shard", tone: "good" },
        { label: "Naive per-file storage", value: "N users = N copies on disk", tone: "bad" },
      ],
      remember: {
        problem: "Store identical content once across 500M users without a bottleneck lookup on every write.",
        solution: "Content-addressable storage (SHA-256 key) with a reference count per block, sharded by hash prefix.",
        why: "The hash is the identity, so existence-check and identity-check are the same lookup, and hash-prefix sharding is already load-balanced.",
        tradeoff: "Every upload pays a hash-existence round trip before bytes move, and deletes become 'decrement and maybe reap' instead of an immediate free.",
        failure: "Dedup keyed by filename or per-user ID misses cross-user duplicates entirely and can still create a hot shard for a viral file.",
        mitigation: "Two-phase upload (hashes first, bytes for misses only) turns dedup into a bandwidth win too, not just a storage one.",
      },
    },
    {
      n: 3,
      title: "Delta sync: uploading only the diff, not the file",
      body: [
        "Chunking makes delta sync possible; this is where it pays off. When a file changes, the client re-chunks it locally, compares the new chunk-hash list against the last-synced manifest it kept from the previous sync, and only the chunks whose hashes changed get uploaded. A one-line edit in a 2GB file becomes a handful of ~4MB chunks, not 2GB.",
        "This only works because the client keeps state: the last manifest (ordered list of chunk hashes) it successfully synced. Without that local manifest, the client has no diff to compute and falls back to full re-chunk-and-compare-against-server, which is why a freshly linked device does a full download first — it has no prior manifest to diff against.",
      ],
      bullets: [
        { lead: "Local manifest cache", text: "the client remembers the chunk-hash list from the last synced version. New content only re-chunks around the edited region; unchanged regions keep their prior hashes." },
        { lead: "Diff, not transfer", text: "compare new manifest to old manifest by hash — matching entries need no network trip at all, only the changed entries go to the two-phase upload." },
        { lead: "Whole-file re-upload (rejected)", text: "no chunking, no manifest — every edit re-sends the entire file. Simple, but bandwidth cost scales with file size, not edit size." },
        { lead: "Server-side byte diff (rejected)", text: "server computes an rsync-style diff against its stored version. Correct in principle, but it means shipping the whole file to the server first to diff against — the opposite of what delta sync is for." },
      ],
      pictureTitle: "Editing 1 line of a 2GB file",
      pictureRows: [
        { label: "Whole-file re-upload", value: "~2GB transferred", tone: "bad" },
        { label: "Delta sync (CDC + manifest diff)", value: "~4-8MB transferred (1-2 chunks)", tone: "good" },
      ],
      remember: {
        problem: "Uploading a full file on every edit doesn't scale to large files edited frequently.",
        solution: "Client keeps the last-synced chunk manifest and diffs new chunk hashes against it before uploading.",
        why: "Content-defined chunking guarantees unrelated regions keep the same hashes, so the diff is cheap and precise.",
        tradeoff: "The client must persist manifest state per file; losing it forces a full re-chunk-and-compare fallback.",
        failure: "A device with no prior manifest (fresh install, cleared cache) can't diff, so it must fully download or fully re-scan.",
        mitigation: "Treat 'no local manifest' as a known, handled case — full sync on first link — rather than an edge-case failure.",
      },
    },
    {
      n: 4,
      title: "Metadata service: the journal, not just the file tree",
      body: [
        "Metadata is not just 'the current state of the file tree' — it is a history of operations. Model every change (create, edit, move, delete) as an append-only, monotonically increasing journal entry per user (or per namespace), rather than only overwriting a row in place. The current file tree is a materialized view derived from replaying the journal; the journal itself is the source of truth other devices sync against.",
        "This is what makes 'what changed since I last synced' answerable cheaply: a device just asks for journal entries after its last-seen sequence number (its cursor), instead of diffing entire directory trees on every sync. Shard the metadata store (sharded MySQL, one shard set per namespace/user range) so no single shard has to serve every user's journal reads.",
      ],
      bullets: [
        { lead: "Append-only journal", text: "every mutation gets a new, monotonically increasing revision number scoped to the namespace. Nothing is edited in place at the journal level." },
        { lead: "Client cursor", text: "each device tracks the last revision number it has applied. 'What's new' is 'give me journal entries after my cursor' — a cheap indexed range scan, not a tree diff." },
        { lead: "Materialized file tree", text: "the current-state table (path → latest block manifest) is derived by replaying the journal and is what most reads hit; the journal is kept for sync and history." },
        { lead: "Sharded by namespace", text: "a user's (or shared folder's) journal and tree live on one shard, so most operations are single-shard; cross-shard only for account-wide search." },
      ],
      pictureTitle: "Journal vs. plain row-overwrite metadata",
      pictureRows: [
        { label: "Row-overwrite only", value: "no history, no cheap 'what changed'", tone: "bad" },
        { label: "Append-only journal + cursor", value: "O(new entries) sync, full history for free", tone: "good" },
      ],
      remember: {
        problem: "Devices need to know what changed since last sync without re-scanning the whole tree.",
        solution: "Model metadata as an append-only, per-namespace journal with monotonic revisions; devices sync via a cursor.",
        why: "A cursor-based range scan on an indexed, append-only log is cheap; a tree diff across millions of files is not.",
        tradeoff: "The journal grows forever and needs compaction/archival; reads of 'current state' need a materialized view on top.",
        failure: "Row-overwrite-only metadata has no way to answer 'what's new since revision X' without a full tree comparison.",
        mitigation: "Materialize current state as a derived table for fast reads; keep the journal itself as the sync and version-history source of truth.",
      },
    },
    {
      n: 5,
      title: "Notification fanout: long polling at 100M idle connections",
      body: [
        "'Near real time' across devices means every idle client needs a live signal, not a poll-every-30-seconds loop — polling 100M idle devices every 30s is 3.3M requests/sec of pure overhead with no new data most of the time. Long polling flips the cost: the client opens a request, the server holds it open (no response) until either a change arrives for that user or a timeout (say 60s) fires, then the client immediately reopens. Idle connections cost memory on the server, not CPU or a scheduled wakeup.",
        "The Notification Service doesn't carry file bytes or even metadata — it only knows 'namespace X has new journal entries, go pull.' That thin payload is what lets it hold tens of millions of connections cheaply and lets the actual sync (the read lane) happen over the normal metadata/block path once woken.",
      ],
      bullets: [
        { lead: "Long poll, not short poll", text: "server holds the request open until there's something to say, collapsing 'poll every N seconds' into 'wake me when it matters.' Reduces both request volume and average latency." },
        { lead: "Thin wake signal only", text: "the notification carries a namespace ID, nothing else. The client still does a real pull against Metadata Service to get the actual delta — this keeps the Notification Service stateless about file content." },
        { lead: "WebSockets (considered)", text: "lower latency, fully bidirectional, but holding millions of persistent duplex connections is operationally heavier than a request that naturally re-issues every ~60s. Reasonable choice; long-poll is simpler to scale horizontally and degrade gracefully." },
        { lead: "Sharded by user/namespace", text: "notification servers are assigned namespace ranges (consistent hashing) so a fanout from Kafka only has to reach the handful of servers currently holding that user's connections." },
      ],
      pictureTitle: "Poll vs. long-poll at 100M idle devices",
      pictureRows: [
        { label: "Poll every 30s", value: "~3.3M req/sec, mostly 'nothing changed'", tone: "bad" },
        { label: "Long poll (~60s hold)", value: "connections idle in memory, wake on change", tone: "good" },
      ],
      remember: {
        problem: "Notify ~100M idle devices of changes within seconds without constant polling load.",
        solution: "Long-poll connections held open by the Notification Service; a thin 'namespace changed' wake signal triggers a real pull.",
        why: "Holding an idle connection is cheap (memory); scheduled re-polling at that scale is not (CPU + network, mostly wasted).",
        tradeoff: "Long-held connections need careful timeout/reconnect handling and sharding so any one server doesn't hold too many.",
        failure: "A crashed or overloaded notification shard silently stops waking its assigned users; they look idle, not broken.",
        mitigation: "Clients always re-establish on disconnect/timeout and also do a periodic slow-interval safety pull as a backstop.",
      },
    },
    {
      n: 6,
      title: "Conflict resolution: two devices, one file, offline edits",
      body: [
        "Device A edits a file offline; Device B edits the same file online in the meantime. When A reconnects, both versions claim to be 'the current one.' Detect this with optimistic concurrency: every write to a file includes the revision the client last saw as its parent. If the server's current revision doesn't match the client's stated parent, the write is a conflict, not a normal update — never silently overwrite.",
        "Resolution is a product decision, not just a technical one: keep both. The losing write is saved as a sibling file (e.g., 'report (Jane's conflicted copy 2026-08-09).docx') rather than merged or discarded. This guarantees zero silent data loss at the cost of occasionally handing the user two files to reconcile themselves — an acceptable tradeoff for opaque binary content where a real merge often isn't possible.",
      ],
      bullets: [
        { lead: "Parent-revision check (CAS)", text: "a write says 'apply on top of revision N.' If the journal's current revision is already > N, the server rejects the blind overwrite and flags a conflict." },
        { lead: "Last-write-wins (rejected)", text: "simplest option, but it silently discards one side's edits. Unacceptable for a storage product whose entire value proposition is not losing your files." },
        { lead: "Auto-merge (rejected for general files)", text: "works for structured text with a real diff/merge algorithm, but Dropbox stores arbitrary binary content — most file types have no sound merge strategy." },
        { lead: "Conflicted copy (winner)", text: "both versions are preserved as separate files; the user (or an app-level merge tool for compatible formats) resolves it. Zero silent loss, by construction." },
      ],
      pictureTitle: "Conflicting writes: three strategies",
      pictureRows: [
        { label: "Last-write-wins", value: "silent data loss → reject", tone: "bad" },
        { label: "Auto-merge", value: "no general algorithm for binary files → reject", tone: "bad" },
        { label: "Conflicted copy via CAS", value: "zero silent loss, user reconciles → winner", tone: "good" },
      ],
      remember: {
        problem: "Two devices edit the same file while one was offline; someone's changes must not silently vanish.",
        solution: "Optimistic concurrency (compare-and-swap on parent revision); on mismatch, keep both as a conflicted copy.",
        why: "Detecting the conflict is cheap (one revision comparison); guessing the 'right' resolution for arbitrary binary content is not possible in general.",
        tradeoff: "Users occasionally see duplicate 'conflicted copy' files they must manually reconcile, instead of a seamless merge.",
        failure: "Last-write-wins looks fine in a demo and then quietly deletes a user's afternoon of offline edits the first time it happens for real.",
        mitigation: "Never accept a write whose stated parent revision is stale; always branch to a conflicted copy instead of overwriting.",
      },
    },
    {
      n: 7,
      title: "Block storage: why object storage, and why durability is a separate axis from availability",
      body: [
        "Blocks are immutable once written (a new version is new blocks, never an edit to existing bytes), which is exactly the access pattern object storage is built for: write-once, read-many, no in-place update. Don't put block bytes in the same database as metadata — metadata is small, relational, and hot; blocks are huge, opaque, and cold on average. Mixing them forces the metadata store to also solve exabyte-scale blob storage, which it isn't built for.",
        "Durability and availability are different promises and get different mechanisms. Durability (will the bytes still exist) comes from erasure coding blocks across failure domains — cheaper than 3x replication at the same loss tolerance, appropriate because blocks are cold and rarely re-read. Availability (can I read it right now) comes from the edge cache layer in front, since a block being durably stored on a degraded node doesn't help a user waiting on a download.",
      ],
      bullets: [
        { lead: "Object storage, not the metadata DB", text: "blocks are immutable, huge, and cold on average — a purpose-built blob store (S3-class, or a custom system like Dropbox's own block storage) is the right shape; a relational metadata store is not." },
        { lead: "Erasure coding over replication", text: "for cold, rarely-accessed blocks, erasure coding (e.g., Reed-Solomon) hits the same durability target as 3x replication at roughly half the storage overhead — the CPU cost of reconstruction is paid rarely." },
        { lead: "Durability vs. availability", text: "erasure coding protects against permanently losing bytes; it says nothing about read latency right now. That's what the edge cache and hot-tier replicas are for." },
        { lead: "Hot/cold tiering", text: "recently-written or frequently-read blocks stay on faster, replicated hot storage; blocks untouched for weeks migrate to cheaper erasure-coded cold storage in the background." },
      ],
      pictureTitle: "Block storage: durability vs. availability",
      pictureRows: [
        { label: "3x replication", value: "simple, ~3x storage cost", tone: "neutral" },
        { label: "Erasure coding (cold blocks)", value: "same durability, ~1.5x storage cost", tone: "good" },
        { label: "Metadata DB storing blob bytes", value: "wrong tool, doesn't scale to exabytes", tone: "bad" },
      ],
      remember: {
        problem: "Store immutable blocks durably at exabyte scale without paying full replication cost everywhere.",
        solution: "Purpose-built object storage with erasure coding for cold blocks, hot-tier replication for recently active ones.",
        why: "Blocks are write-once/read-many and mostly cold, the exact case erasure coding is cheaper for than replication.",
        tradeoff: "Erasure-coded reads need reconstruction on node failure (slower than a plain replica read), and tiering adds background migration complexity.",
        failure: "Storing block bytes inside the metadata database couples an OLTP-shaped system to blob-shaped storage needs and collapses under scale.",
        mitigation: "Keep metadata (small, hot, relational) and blocks (huge, cold, immutable) in separate systems, each tuned to its own access pattern.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a content-addressable block store behind a change journal: files are cut into ~4MB content-defined chunks, each chunk is stored once globally by its SHA-256 hash, and 'sync' means diffing chunk-hash lists, not comparing file bytes.",
      "Delta sync only works because the client keeps a local manifest (last-synced chunk-hash list) to diff new content against — no manifest means a full re-sync.",
      "Metadata is an append-only journal per namespace, not just a file tree; devices sync by asking for entries after their last cursor, which is cheap at any scale.",
      "Real-time propagation is long-poll fanout: idle connections cost memory, not a scheduled wakeup, and the notification itself carries no file data, just 'go pull.'",
      "Conflicts are detected with optimistic concurrency (compare-and-swap on parent revision) and resolved by keeping both sides as a conflicted copy — never last-write-wins.",
    ],
    flows: [
      {
        kind: "read",
        title: "SYNC / DOWNLOAD PATH",
        summary:
          "A device wakes from long-poll (or opens fresh), asks for journal entries after its cursor, and pulls only the blocks it's missing from cache or cold storage.",
        steps: [
          { label: "Client", note: "long-poll returns, or app opens" },
          { label: "API Gateway", note: "auth + route" },
          { label: "Metadata Service", note: "journal entries after cursor" },
          { label: "Client", note: "diffs against local manifest" },
          { label: "Edge Cache / CDN", note: "fetch needed blocks" },
          { label: "Block Storage", note: "on cache miss" },
        ],
      },
      {
        kind: "write",
        title: "UPLOAD / SYNC-UP PATH",
        summary:
          "The client re-chunks the changed file, diffs the new manifest locally, and uploads only the blocks whose hashes are new — after the server confirms they're not already deduped.",
        steps: [
          { label: "Client", note: "FS watcher fires, CDC re-chunk" },
          { label: "Client", note: "diff vs. last-synced manifest" },
          { label: "API Gateway", note: "send changed-chunk hashes" },
          { label: "Block Server", note: "hash lookup: which are new?" },
          { label: "Client", note: "upload bytes for misses only" },
          { label: "Block Storage", note: "dedup'd write, refcount++" },
          { label: "Metadata Service", note: "CAS on parent revision, append journal" },
        ],
      },
      {
        kind: "analytics",
        title: "NOTIFICATION / BACKGROUND PATH",
        summary:
          "A committed journal entry publishes a change event; the Notification Service wakes the user's other idle devices with a thin signal, and background workers pick up indexing/thumbnailing off the same event.",
        steps: [
          { label: "Metadata Service", note: "publish change event" },
          { label: "Kafka", note: "durable change-event log" },
          { label: "Notification Service", note: "fanout to held long-polls" },
          { label: "Other devices", note: "wake, go pull the sync path" },
          { label: "Background Workers", note: "thumbnails, virus scan, search index" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "500M users, 100M DAU, ~3 devices/user, ~100B files tracked",
          "~exabyte-scale logical data; dedup + compression cut physical storage ~2-3x",
          "Chunk size: content-defined, ~4MB average, clamped ~2-8MB band",
          "Sustained block writes: ~500K/sec platform-wide",
          "Notification Service: ~100M concurrent idle long-poll connections",
          "Durability target: 11 nines per block (erasure-coded cold tier)",
          "Notification latency p99 < 2s; metadata op p99 < 100ms",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Content-defined chunking (rolling hash), not fixed-size blocks",
          "Content-addressable storage keyed by SHA-256, refcounted, not per-file storage",
          "Delta sync via client-side manifest diff, two-phase upload (hashes, then misses)",
          "Metadata as an append-only journal with cursors, not row-overwrite only",
          "Long-poll notification carrying a thin wake signal, not file data",
          "Conflicts via CAS on parent revision → conflicted copy, never last-write-wins",
          "Erasure coding for cold blocks, replication for hot; blocks live outside the metadata DB",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Dedup is global (cross-user), which is why it's keyed by content hash, not by owner",
          "A device with no local manifest must fall back to a full sync — name this explicitly",
          "Durability (erasure coding) and availability (caching) are solved by different mechanisms",
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
      goal: "Lock the numbers and the product scope before drawing anything: who edits, how big are files, how many devices, how fast must a change propagate.",
      why: "Every later decision — chunk size, journal design, notification fanout strategy — falls out of these numbers. An interviewer watching you guess at scale here will discount everything that follows.",
      steps: [
        { kind: "ASK", text: '**"How many users, and how many devices per user?"** Land on "500M users, 100M DAU, ~3 devices each" and write **"500M / 100M DAU / 3 devices"** top-left.' },
        { kind: "ASK", text: '**"How big can a file be, and roughly how much data total?"** Land on "up to 50GB per file, exabyte-scale total." Write it down.' },
        { kind: "SAY", text: 'Propose the latency target: **"sub-2s p99 for a change to show up on another online device"**, **"sub-100ms for metadata ops like list/rename"**. Wait for a nod, then write it.' },
        { kind: "SAY", text: 'State scope. In: "upload/download", "delta sync", "dedup", "real-time notification", "conflict resolution", "version history." Out: "payments/billing", "org-wide admin controls", "full-text file content search." "I\'ll flag if I want to come back to any of those."' },
        { kind: "WRITE", text: 'Say the read/write shape out loud: **"sync/download and notification dominate request volume; uploads are the expensive path in bytes moved."** This is what justifies the three-lane split coming up.' },
      ],
      grading: "Are the five numbers on the board within 5 minutes, and is scope explicitly narrowed rather than left implicit?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Define the upload/sync endpoints and the two core tables (journal + block index) before anyone asks — this is the load-bearing schema for the whole design.",
      why: "Committing to 'metadata is a journal, not just a file tree' this early tells the interviewer you already see the sync problem, not just the storage problem.",
      steps: [
        { kind: "WRITE", text: 'Write the core endpoints: **"POST /blocks/check { hashes[] }"** → returns which are missing. **"PUT /blocks/{hash}"** uploads one missing block. **"POST /files/commit { path, chunkManifest, parentRevision }"** → commits a new version. **"GET /journal?since={cursor}"** → the sync pull.' },
        { kind: "DRAW", text: 'Sketch two tables: **journal**(namespace_id, revision PK, op, path, manifest_ref, parent_revision, ts) and **blocks**(hash PK, size, refcount, storage_location). Say: "The journal is append-only and is the source of truth clients sync against; the file tree is a materialized view on top of it."' },
        { kind: "SAY", text: 'Justify the chunk manifest: **"a file version is just an ordered list of chunk hashes — that\'s what lets me diff two versions by comparing lists, not bytes."**' },
        { kind: "RULE OUT", text: 'Get ahead of it: "Storing blob bytes directly in this metadata store doesn\'t work — blocks are huge and cold, metadata is small and hot. They need separate systems." Cross it off.' },
      ],
      grading: "A clean, small endpoint surface, the journal-plus-materialized-tree model stated explicitly, and the block/metadata separation named before being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: sync/download, upload, and notification/background — each with its own SLA.",
      why: "The interviewer is checking whether you see that these three paths have genuinely different requirements (freshness vs. throughput vs. durability) and therefore different infrastructure, not one undifferentiated 'backend.'",
      steps: [
        { kind: "DRAW", text: 'Lay down the **sync/download lane**: Client → API Gateway → Metadata Service (journal since cursor) → Client diffs → Edge Cache → Block Storage on miss. Label arrows with what\'s asked for, not box names.' },
        { kind: "DRAW", text: 'Add the **upload lane** as a separate row: Client → Gateway → Block Server (dedup check) → Block Storage, and Block Server → Metadata Service to commit the version. Label **"new blocks only"** and **"CAS on parent revision."**' },
        { kind: "DRAW", text: 'Add the **notification/background lane**: Metadata Service → Kafka → Notification Service → (wakes) Client; Kafka → Background Workers for thumbnails/indexing. Label it **"async, thin payload, never blocks sync."**' },
        { kind: "SAY", text: 'Narrate the split: "Sync is a read/freshness problem, upload is a throughput/dedup problem, notification is a fanout/idle-connection problem — each gets infra shaped for its own bottleneck."' },
      ],
      grading: "Three clearly separated lanes, each arrow labeled with what it carries, and an explicit statement of why notification never sits on the upload/commit path.",
    },
    {
      n: 4,
      title: "Deep Dive: Chunking, Dedup, and Delta Sync",
      minutes: 8,
      goal: "Walk content-defined chunking, content-addressable dedup, and the manifest-diff delta sync — the signature sub-problem of this design.",
      why: "This is what separates 'a file sync app' from 'a naive file-copy app.' The interviewer wants to see you derive why fixed-size chunking fails and why hash-addressing solves dedup for free.",
      steps: [
        { kind: "SAY", text: 'Explain the fixed-size chunking failure: "One inserted byte shifts every later block boundary, so a 1-byte edit looks like the whole file changed." Then introduce content-defined chunking: "a rolling hash picks boundaries from local content, so only the chunks near the edit change."' },
        { kind: "SAY", text: 'Explain dedup: "Each chunk is keyed by its SHA-256 hash. Same bytes anywhere in the system, same key — so storing it twice is impossible by construction, and the block table just tracks a refcount."' },
        { kind: "SAY", text: 'Explain delta sync: "The client keeps the manifest — the chunk-hash list — from the last sync. New edits re-chunk, diff hash lists locally, and only the changed hashes get uploaded, after a two-phase check for ones the server already has."' },
        { kind: "RULE OUT", text: 'One line each: **Fixed-size chunks** → any insert re-uploads everything. **Server-side byte diff** → requires shipping the whole file first, defeats the point. **Per-user dedup only** → misses cross-user duplicates.' },
      ],
      grading: "Content-defined chunking explained via the insertion failure mode, dedup tied explicitly to hash-as-identity, and the manifest-diff mechanism stated without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: Real-Time Sync and Conflict Resolution",
      minutes: 7,
      goal: "Walk long-poll notification fanout at scale, then conflict detection and resolution — the two places 'sync' can silently fail a user.",
      why: "This is where staff-level judgment shows: naming the tradeoff between polling cost and push complexity, and refusing to let 'merge automatically' hide a silent data-loss bug.",
      steps: [
        { kind: "SAY", text: 'Walk notification: "100M idle devices polling every 30s is millions of wasted requests/sec. Long-poll flips it — the connection sits open in memory and only responds when there\'s a real change, or times out and reopens."' },
        { kind: "SAY", text: 'Name the payload discipline: "The notification itself carries no file data, just a namespace ID — the device still does a real pull. That\'s what keeps the Notification Service cheap to hold at 100M connections."' },
        { kind: "SAY", text: 'Introduce the conflict case: "Device A edits offline, Device B edits the same file online. On reconnect, A\'s write states a parent revision that\'s now stale — the server rejects the blind overwrite via compare-and-swap."' },
        { kind: "SAY", text: 'Defend the resolution: "We never last-write-wins — that silently deletes someone\'s edits. We keep both as a conflicted copy. For arbitrary binary files there is no general auto-merge, so this is the only choice that guarantees zero silent loss."' },
      ],
      grading: "Long-poll justified with a concrete polling-cost number, and conflict handling framed around CAS-on-parent-revision plus an explicit rejection of last-write-wins.",
    },
    {
      n: 6,
      title: "Wrap: Durability, Bottlenecks, and Close",
      minutes: 5,
      goal: "Separate durability from availability, name the biggest remaining risk, and close with a one-sentence summary plus a parked-items list.",
      why: "Staff-level signal here is treating durability and availability as genuinely different guarantees with different mechanisms, and closing the interview like a collaborator rather than trailing off.",
      steps: [
        { kind: "SAY", text: 'State the storage tiering: "Blocks are immutable, so hot recent blocks stay replicated for fast reads; cold blocks migrate to erasure coding for the same durability at lower storage cost."' },
        { kind: "SAY", text: 'Separate the two guarantees explicitly: "Erasure coding is a durability answer — will the bytes survive. It says nothing about availability — can I read it right now. That\'s what the edge cache is for."' },
        { kind: "SAY", text: 'Push back where useful: "Do version-history reads need the same sub-100ms budget as current-state reads, or can they be slower and cheaper?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a content-addressable block store behind an append-only journal, synced via manifest diffs and long-poll wakeups. With more time I\'d cover sharing/permissions at scale and the version-retention GC path."' },
      ],
      grading: "Durability and availability named as separate mechanisms, at least one pushback on requirements, and a crisp close with an explicit parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a design that syncs files and stores them durably, but chunking, dedup, and conflict handling stay shallow.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: client, API server, a database for metadata, and blob storage (usually 'S3').",
          "Knows files should be chunked for large uploads, without deriving why fixed-size chunks fail.",
          "Adds a database table for file versions when prompted about history.",
          "Handles 'what about real-time sync' by adding polling, then a queue when pushed.",
          "Knows two devices can conflict and suggests 'the server picks one' when asked.",
        ],
        gaps: [
          "Doesn't explain why fixed-size chunking breaks on an insertion — treats chunk size as a tuning knob, not a correctness issue.",
          "Dedup is per-user or per-file, missing that cross-user dedup is the actual point.",
          "No local-manifest concept — every sync looks like 'diff against the server,' which doesn't explain how the diff is computed cheaply.",
          "Conflict resolution defaults to last-write-wins without recognizing the data-loss risk.",
          "No real notification-fanout number; 'push a websocket message' with no idle-connection cost analysis.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, derives content-defined chunking and hash-addressed dedup, and names the conflict problem correctly.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the scale numbers and latency budgets on the board within 5 minutes.",
          "Explains content-defined chunking via the fixed-size insertion failure, without being led there.",
          "Ties dedup directly to content-hash-as-identity and mentions refcounting for deletes.",
          "Models metadata as an append-only journal with a client cursor, not just a mutable file tree.",
          "Uses long polling (or an equivalent) for notification and can estimate the idle-connection cost of naive polling.",
          "Rejects last-write-wins for conflicts and proposes CAS-on-parent-revision plus a conflicted copy.",
          "Separates hot/cold storage tiering when asked about cost.",
        ],
        gaps: [
          "Names erasure coding only when prompted about storage cost, not as a default design choice for cold blocks.",
          "Doesn't proactively separate 'durability' from 'availability' as two different guarantees with different mechanisms.",
          "Quantifies notification cost only in general terms ('polling is wasteful') rather than with a concrete requests/sec estimate.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats durability and availability as separate axes, and volunteers the operational failure modes before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the fixed-size-chunking failure mode with a concrete example (one inserted byte re-uploads a whole 2GB file) before being asked to justify chunking strategy.",
          "States explicitly that durability (erasure coding, refcounting) and availability (caching, hot-tier replicas) are different guarantees solved by different mechanisms.",
          "Quantifies the naive-polling cost at scale (e.g., 100M devices × poll interval) to justify long-poll instead of asserting it.",
          "Frames conflict resolution as a product decision under a technical constraint: 'binary content has no general merge, so preserving both is the only zero-loss option,' not just 'CAS the revision.'",
          "Names the 'no local manifest' edge case (fresh device, cleared cache) unprompted and explains the full-sync fallback.",
          "Pushes back on requirements where appropriate and treats the interviewer as a collaborator, pacing the 40 minutes deliberately.",
          "Closes with a one-sentence system summary and an explicit list of what was deliberately deferred.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Chunking a file into fixed-size blocks and never noticing that a single-byte insertion invalidates every later block boundary.",
      "Deduplicating per-user instead of globally by content hash, missing the entire point of content-addressable storage.",
      "Resolving conflicting concurrent edits with last-write-wins, silently discarding one side's changes.",
      "Storing block bytes directly inside the metadata database instead of a purpose-built object store, coupling an OLTP-shaped system to blob-shaped storage.",
      "Putting the real-time notification payload on the critical sync path (carrying file content instead of a thin wake signal), making the Notification Service expensive to hold at scale.",
      "Treating durability and availability as the same problem, so 'we replicate 3x' is offered as the answer to both without distinction.",
      "No mention of the client-side manifest for delta sync, so 'diff' is hand-waved as something the server does against the whole file.",
    ],
    followUps: [
      {
        q: "Why SHA-256 for content addressing instead of a faster non-cryptographic hash?",
        a: "Because the hash is the identity used to decide 'these two chunks are the same bytes and can share one stored copy.' A non-cryptographic hash (like a 32-bit CRC) has a meaningfully higher collision rate at the scale of hundreds of billions of chunks, and a collision here doesn't just corrupt one file — it would silently return the wrong bytes to a user reading their own data. SHA-256's collision probability is astronomically low even at exabyte scale, so the extra CPU cost (hashing is cheap relative to network/disk I/O) buys correctness you can't compromise on.",
      },
      {
        q: "How does a brand-new device get a user's existing files without downloading their whole history?",
        a: "It fetches the current materialized file tree (path → latest chunk manifest per file) rather than replaying the entire journal from revision 0 — the journal's history is for version restore and sync deltas, not initial bootstrap. Then it downloads blocks for each file, and because dedup is global, many of those blocks are likely already present locally (from other files) or fetched once and shared across files, so the actual bytes moved are less than a naive sum of file sizes would suggest.",
      },
      {
        q: "What happens if two devices try to create the same journal revision number at once?",
        a: "It can't happen by construction: revision numbers are assigned by the Metadata Service (via an auto-increment or a Paxos/single-writer-per-shard sequence), not chosen by the client. A client proposes a write with the parent revision it last saw; the server atomically checks that against the current revision and, only if it still matches, assigns the next one and appends. Two concurrent writes with the same stale parent both compare against the true current revision — the first commits, the second fails the compare-and-swap and becomes a conflict.",
      },
      {
        q: "How do you handle a file with a huge number of tiny changes in rapid succession (e.g., a database file with constant small writes)?",
        a: "Debounce client-side: don't upload on every filesystem event, batch changes over a short window (a few hundred ms to a few seconds) before re-chunking and diffing. Without this, a file with high write frequency would thrash the chunker and flood the journal with near-duplicate revisions. This is also why some file types (like local SQLite/database files) are often excluded from continuous sync entirely, or synced only when the file is closed, rather than on every write.",
      },
      {
        q: "Why not just use a distributed filesystem (like HDFS or a network FS mount) instead of building this?",
        a: "Those are built for a datacenter-local, trusted, high-bandwidth environment with POSIX-like semantics — they assume clients are close and connections are reliable. This system's actual hard problems are the opposite: clients are consumer devices on unreliable, low-bandwidth, high-latency links, edits happen offline, and 'sync' must be resumable, deduplicated, and delta-based to be usable at all. A distributed filesystem solves shared concurrent access in one datacenter; it doesn't solve cross-device, intermittently-connected, bandwidth-constrained sync.",
      },
      {
        q: "How would you extend this to support real-time collaborative editing (like Google Docs) instead of whole-file sync?",
        a: "That's a different consistency model entirely — operational transformation or CRDTs over fine-grained operations (character inserts/deletes), with all active editors converging via a shared, ordered operation log, versus this design's block-level, eventually-consistent file sync. You'd keep the same underlying block-storage and journal ideas for the file's durable snapshots and version history, but the live-editing path would need a separate real-time op-sync service — file-sync's chunk-diff granularity (megabytes) is far too coarse for keystroke-level collaboration.",
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
          "This is a content-addressable block store sitting behind an append-only change journal. The core operation isn't 'store a file' — it's 'diff a chunk-hash manifest against the last one you had, and only move what changed.' Everything expensive (chunking strategy, dedup, the journal, notification fanout, conflict detection) exists to make that diff correct and cheap at 500M-user scale.",
          "Anchor on the numbers: 500M users, 100M DAU, ~3 devices each, exabyte-scale logical data, sub-2s notification latency, sub-100ms metadata reads. Every structural choice below is a consequence of these, not a preference.",
        ],
      },
      {
        heading: "Chunking and why content-defined beats fixed-size",
        body: [
          "Fixed-size chunking (cut every 4MB on the dot) is simple but brittle: inserting one byte anywhere in a file shifts every subsequent chunk boundary, so the diff sees the entire tail of the file as 'changed' even though only a few bytes actually moved. Content-defined chunking fixes this by choosing boundaries from a rolling hash over local content (Rabin fingerprinting), so a cut point only depends on nearby bytes — an insertion perturbs the one or two chunks around it and nothing else.",
          "Chunk size averages ~4MB, clamped to a min/max band so pathological inputs (all-zero files, highly repetitive content) can't produce degenerate chunk counts. Hashing every chunk (SHA-256) and hashing the ordered list of chunk hashes gives a Merkle-tree-style file identity: two versions of a file can be compared hash-list to hash-list without touching the underlying bytes.",
        ],
      },
      {
        heading: "Dedup and delta sync as two sides of the same mechanism",
        body: [
          "Because chunks are keyed by content hash, storing the same bytes twice — whether from two different users uploading the same PDF, or one user's own file duplicated across folders — is structurally impossible. A block table tracks a reference count per hash; physical deletion only happens once the refcount hits zero and stays there past the retention window. The hash-existence lookup is sharded by hash prefix (already uniformly distributed, no extra hashing scheme needed), which spreads load evenly regardless of which content happens to be popular.",
          "Delta sync reuses this exact hash-identity idea on the client: the client keeps the manifest (ordered chunk-hash list) it last successfully synced, re-chunks new content, and diffs the new manifest against the old one locally. Only chunks whose hashes changed are candidates for upload, and a two-phase check (send hashes, server replies with which are actually missing) means even those candidates might not need bytes sent if some other file or user already has that exact chunk.",
        ],
      },
      {
        heading: "Metadata as a journal, and why that unlocks cheap sync",
        body: [
          "Metadata isn't modeled as a mutable file tree that gets edited in place — it's an append-only, per-namespace journal where every operation (create, edit, move, delete) gets the next monotonically increasing revision number. The current file tree is a materialized view derived by replaying the journal; it's what most reads hit, but the journal is what devices sync against.",
          "This is the mechanism that makes 'what changed since I last looked' cheap at any scale: a device just asks for journal entries after its last-seen revision (its cursor) — an indexed range scan, not a tree comparison. The metadata store is sharded by namespace (user or shared folder), so the vast majority of operations touch exactly one shard.",
        ],
      },
      {
        heading: "Real-time propagation and why long polling wins at this scale",
        body: [
          "Naively polling every idle device every 30 seconds to ask 'anything new?' costs millions of wasted requests per second at 100M concurrent devices, almost all answered 'no.' Long polling inverts the cost: the server holds a client's request open — costing memory, not scheduled CPU work — until either a real change arrives for that namespace or a timeout fires and the client reconnects. The notification itself carries no file content, just a namespace identifier, which is what keeps holding tens of millions of these connections affordable; the actual sync happens over the normal metadata-pull path once a device wakes up.",
          "Notification servers are sharded by namespace (consistent hashing), so a fanout from the change-event log (Kafka) only needs to reach the specific servers currently holding that user's connections, not broadcast globally.",
        ],
      },
      {
        heading: "Conflicts, durability, and the discipline of never guessing",
        body: [
          "Concurrent edits from two devices are detected, not guessed at: every write states the revision it's building on top of, and the server only accepts it if that matches its actual current revision (compare-and-swap). A mismatch means someone else committed a newer version in between — that write becomes a conflict, never a silent overwrite. Because Dropbox-style storage holds arbitrary binary content, there's no general-purpose auto-merge available the way there is for structured text, so the resolution is to preserve both versions as separate files and let the user (or a format-aware app) reconcile them. This trades a rare moment of user friction for a hard guarantee: nothing is ever silently lost.",
          "On the storage side, durability and availability are treated as genuinely separate problems. Durability — will the bytes still exist years from now — comes from erasure coding blocks across failure domains, cheaper than full replication at the same loss tolerance and appropriate because blocks are immutable and mostly cold. Availability — can this specific read be served fast right now — comes from the edge cache and hot-tier replication in front of storage. Conflating the two leads to either over-paying (full replication everywhere) or under-serving (durable but slow reads on cold data with no cache in front).",
        ],
      },
    ],
  },
};
