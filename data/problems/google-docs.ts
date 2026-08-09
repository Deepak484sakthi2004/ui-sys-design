import type { Problem } from "@/lib/types";

export const googleDocs: Problem = {
  slug: "google-docs",
  num: "7.5",
  title: "Design Google Docs",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a real-time collaborative document editor that stores 1 billion documents, serves 100 million daily active users, lets up to 100 people type into the same document at once, propagates a keystroke to every collaborator in under 100ms, and never loses a committed edit even when a client's network drops mid-sentence.",
  ],
  hardParts:
    "The hard parts: resolving concurrent edits from many typists into one document everyone agrees on, without a lock; guaranteeing every client and every replica converges to the exact same state despite reordering, retries, and offline clients; and doing all of it inside a 100ms budget instead of the seconds a naive merge-and-reconcile would cost.",
  keyTopics: [
    "Operational Transformation (OT)",
    "Single-Writer Doc Sharding",
    "Optimistic Local Apply + Rebase",
    "Snapshot + Op-Log Compaction",
    "Presence as an Ephemeral Side Channel",
  ],
  foundationsReferenced: [
    { label: "WebSockets", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Vector Clocks / Lamport Timestamps", tone: "purple" },
    { label: "CRDTs", tone: "purple" },
    { label: "Pub/Sub (Kafka)", tone: "orange" },
    { label: "LSM Trees / Append-Only Logs", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "editor A", col: 1, row: 1, tone: "slate" },
      { id: "ws_gateway", label: "WS Gateway", sub: "authenticates + connects", col: 2, row: 1, tone: "slate" },
      { id: "metadata_db", label: "Metadata Store", sub: "Spanner · ACLs & sharing", col: 3, row: 1, tone: "blue" },
      { id: "snapshot_store", label: "Snapshot Store", sub: "latest full-doc blob", col: 4, row: 1, tone: "blue" },
      {
        id: "shard_router",
        label: "Shard Router",
        mono: "consistent hash: docId → server",
        col: 1,
        row: 2,
        tone: "slate",
      },
      {
        id: "session_server",
        label: "Doc Session Server",
        sub: "in-memory OT · single writer/doc",
        mono: "transform → apply → broadcast",
        col: 2,
        row: 2,
        tone: "green",
      },
      { id: "op_log", label: "Op Log", sub: "durable per-doc append log", col: 3, row: 2, tone: "blue" },
      { id: "other_clients", label: "Collaborators", sub: "fan-out via WS", col: 4, row: 2, tone: "slate" },
      { id: "presence", label: "Presence", sub: "cursors/selections, ephemeral", col: 5, row: 2, tone: "purple" },
      {
        id: "compactor",
        label: "Snapshot Compactor",
        sub: "op log → snapshot, ~1K ops",
        col: 2,
        row: 3,
        tone: "orange",
      },
      { id: "search_indexer", label: "Search Indexer", sub: "async full-text index", col: 4, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "ws_gateway", label: "open doc", kind: "read" },
      { from: "ws_gateway", to: "metadata_db", label: "authz + ACL", kind: "read" },
      { from: "ws_gateway", to: "snapshot_store", label: "load latest snapshot", kind: "read" },
      { from: "client", to: "shard_router", label: "keystroke op", kind: "write" },
      { from: "shard_router", to: "session_server", label: "route to owning server", kind: "write" },
      { from: "session_server", to: "op_log", label: "append transformed op", kind: "write" },
      { from: "session_server", to: "other_clients", label: "broadcast · <100ms", kind: "write" },
      { from: "session_server", to: "presence", label: "cursor broadcast, throttled", kind: "analytics" },
      { from: "op_log", to: "compactor", label: "periodic compaction", kind: "analytics" },
      { from: "compactor", to: "snapshot_store", label: "write new snapshot", kind: "analytics" },
      { from: "op_log", to: "search_indexer", label: "async index", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · opening a document" },
      { kind: "write", text: "write path · live edit propagation, <100ms" },
      { kind: "analytics", text: "async side channel · presence, compaction, search — never blocks an edit" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Real-time collaborative editing: concurrent edits from multiple users converge to the same document", tag: "P0" },
      { id: "FR-02", text: "Local edits apply optimistically and instantly, before the server round-trip confirms them", tag: "P0" },
      { id: "FR-03", text: "Rich text formatting: bold/italic/underline, headings, lists, tables, images, fonts", tag: "P0" },
      { id: "FR-04", text: "Live presence: show collaborator cursors, selections, and names in distinct colors", tag: "P0" },
      { id: "FR-05", text: "Offline editing with automatic reconciliation on reconnect", tag: "P0" },
      { id: "FR-06", text: "Comments and Suggesting mode (track changes) with accept/reject", tag: "P0" },
      { id: "FR-07", text: "Access control: owner/editor/commenter/viewer roles plus link-sharing", tag: "P0" },
      { id: "FR-08", text: "Full revision history: named versions, diff view, and one-click restore", tag: "P1" },
      { id: "FR-09", text: "Full-text search across a user's documents", tag: "P1" },
      { id: "FR-10", text: "Export to PDF, DOCX, and plain text", tag: "P1" },
      { id: "FR-11", text: "Auto-save with no explicit save action, ever", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Edit propagation latency to remote collaborators", tag: "p99 < 100ms" },
      { id: "NFR-02", text: "Local keystroke-to-screen latency (optimistic apply)", tag: "p99 < 10ms" },
      { id: "NFR-03", text: "Cold document open latency", tag: "p99 < 1s" },
      { id: "NFR-04", text: "Concurrent live editors supported per document", tag: "~100" },
      { id: "NFR-05", text: "Availability (about 4.4 hours downtime per year)", tag: "99.95%" },
      { id: "NFR-06", text: "Durability of any committed (server-acknowledged) edit", tag: "zero loss" },
      { id: "NFR-07", text: "Concurrent WebSocket connections, system-wide peak", tag: "10M" },
      { id: "NFR-08", text: "All connected replicas converge to an identical document state", tag: "< 1s after last op" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Why you can't just lock the paragraph",
      body: [
        "Start by killing the obvious answers so the interviewer knows you considered them. Two people typing into the same sentence is not a rare edge case here, it is the entire product. Whatever handles it has to run on every single keystroke, at typing speed, without the user ever noticing.",
        "Pessimistic locking (grab a lock on a paragraph before you can type in it) turns every keystroke into a network round trip and freezes out the other typist. Last-write-wins silently deletes someone's sentence whenever two saves race. A git-style diff/merge works for occasional merges of whole files, but at keystroke granularity it would pop a conflict dialog every few seconds. None of these preserve intent — the actual bar is that everyone's keystrokes survive and everyone ends up looking at the same text.",
      ],
      bullets: [
        { lead: "Pessimistic lock", text: "a lock per paragraph (or per doc) serializes typing behind network round trips and blocks the other person outright. Rejected." },
        { lead: "Last-write-wins", text: "whichever write reaches storage last wins, silently overwriting the loser's paragraph with no merge at all. Rejected." },
        { lead: "Diff/patch merge (git-style)", text: "fine for infrequent, human-reviewed merges; at keystroke frequency it means a conflict prompt every few seconds. Rejected." },
        { lead: "Operational Transformation", text: "transform each incoming op against ops already applied, so both edits land and both typists converge on the same text. Winner." },
      ],
      pictureTitle: "Kill the naive options first",
      pictureRows: [
        { label: "Pessimistic lock", value: "freezes the other typist → reject", tone: "bad" },
        { label: "Last-write-wins", value: "silently drops a sentence → reject", tone: "bad" },
        { label: "Diff/merge (git-style)", value: "conflict dialog every few seconds → reject", tone: "bad" },
        { label: "Operational Transformation", value: "both edits land, both converge → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Two people typing into the same sentence at the same time, with no lock allowed.",
        solution: "Operational Transformation: transform each op against ops already applied so intent from both sides survives.",
        why: "Locking kills the real-time feel; last-write-wins loses data; keystroke-level diff/merge conflicts constantly.",
        tradeoff: "OT needs a well-defined transform function and a place to establish order — more machinery than 'just overwrite'.",
        failure: "Ship last-write-wins and a collaborator's paragraph vanishes the moment two saves race.",
        mitigation: "Every op carries a position and the revision it was based on, so the transform can adjust it correctly before applying.",
      },
    },
    {
      n: 2,
      title: "OT, and the trick that makes it tractable",
      body: [
        "An edit is a small op: insert(pos, text) or delete(pos, len). If two ops are generated concurrently against the same base revision, applying them naively at their raw positions corrupts the document — an insert at position 10 needs its position shifted if another insert already landed at position 5. The transform function xform(opA, opB) adjusts opB assuming opA has already been applied, so both orders of application produce the same final text.",
        "Full peer-to-peer OT (every client talking to every other client) requires the transform function to satisfy two convergence properties (TP1 and TP2), and TP2 is notoriously hard to get right for rich text. The trick is topology: Google Docs is client-server, a star, not a mesh. Every op only ever needs to be transformed against the server's canonical history, never against another client's pending op directly. That collapses the problem to TP1 alone — client-vs-server transforms — which is what makes OT tractable enough to ship.",
      ],
      bullets: [
        { lead: "Op format", text: "insert(pos, text) / delete(pos, len), each tagged with the client's last-known revision number." },
        { lead: "Central sequencer", text: "the server assigns a strict total order to every op it accepts — the canonical revision history for that doc." },
        { lead: "Client-server, not peer-to-peer", text: "each client only ever transforms against the server, and the server only ever transforms against itself — no client-to-client transform, no TP2 requirement." },
        { lead: "Round trip", text: "server transforms the incoming op against everything applied since the client's stated revision, applies it, assigns the next revision number, and broadcasts the transformed op to everyone including an ack to the sender." },
      ],
      pictureTitle: "Star topology beats mesh topology",
      pictureRows: [
        { label: "Peer-to-peer OT (mesh)", value: "needs TP1 + TP2, very hard for rich text", tone: "bad" },
        { label: "Client-server OT (star)", value: "needs TP1 only — tractable", tone: "good" },
        { label: "Central sequencer", value: "one server assigns the total order per doc", tone: "good" },
      ],
      remember: {
        problem: "Transform concurrent ops correctly without an intractable correctness proof.",
        solution: "Client-server OT: every client transforms only against the server's canonical history, never against other clients directly.",
        why: "The star topology needs only the TP1 convergence property; full peer-to-peer OT needs TP2, which is extremely hard for rich text.",
        tradeoff: "You need one authoritative server per doc — no fully decentralized, serverless mode.",
        failure: "Attempt full mesh OT for rich text and edge cases in overlapping formatting ranges produce diverging documents.",
        mitigation: "Route every op through one session server that owns the total order for that document.",
      },
    },
    {
      n: 3,
      title: "One writer per document: the shard that avoids consensus",
      body: [
        "A total order has to be assigned somewhere. Rather than run distributed consensus (Paxos/Raft) on every keystroke, pin every op for a given document to a single in-memory session server, chosen by consistent hashing on docId. That server holds the live, editable document tree in memory and is the only process allowed to assign revision numbers for that doc — so 'agree on an order' becomes 'ask the one process that already knows the order', which needs no coordination protocol at all.",
        "The tradeoff is a ceiling: one doc's edit throughput is bounded by what a single server's CPU and memory can do, which is exactly why concurrent live editors per document is capped (around 100) rather than unbounded. If that server dies, another node acquires the doc's lease, reloads the latest snapshot plus the op-log tail, replays it to rebuild the exact in-memory state, and only then starts accepting new ops.",
      ],
      bullets: [
        { lead: "Consistent hashing", text: "docId maps to an owning session server; only that server ever assigns revision numbers for the doc." },
        { lead: "In-memory state", text: "the live document tree lives in RAM on the owner so transforms are microseconds, not database round trips." },
        { lead: "Failover via lease", text: "a dead owner's lease expires, a new server claims it, replays snapshot + op-log tail, then resumes." },
        { lead: "The cost", text: "a single doc can't scale past one server's capacity, which is exactly why the concurrent-editor cap exists." },
      ],
      pictureTitle: "Single writer per doc",
      pictureRows: [
        { label: "Distributed consensus per keystroke", value: "correct but far too slow", tone: "bad" },
        { label: "One owning server per doc", value: "no coordination needed, ~100 editor ceiling", tone: "good" },
        { label: "Owner crashes", value: "lease expires, new owner replays snapshot + log", tone: "neutral" },
      ],
      remember: {
        problem: "Someone has to assign a total order to concurrent ops without per-keystroke consensus.",
        solution: "Shard documents one-owner-per-doc via consistent hashing; that owner is the sole sequencer, in memory.",
        why: "Asking the one process that already knows the order is free; running Paxos on every keystroke is not.",
        tradeoff: "Caps a single document's live editor count at what one server can hold and transform.",
        failure: "No single-writer invariant means two servers could assign the same revision number and split the document's history.",
        mitigation: "Lease-based ownership with snapshot + op-log replay on failover rebuilds exact state before accepting writes again.",
      },
    },
    {
      n: 4,
      title: "Offline editing: keep typing, reconcile later",
      body: [
        "A closed laptop lid can't block typing. The client queues ops locally (IndexedDB) and keeps applying them optimistically to the local view, exactly as if it were online — the user sees no difference between an offline queue and network latency. The only thing that changes is when the round trip happens.",
        "On reconnect, the client sends its queued ops tagged with the last server revision it actually saw. The server runs the same transform it always does: adjust each op against everything applied since that revision, then apply and broadcast. If the offline session was long and the doc changed heavily underneath it, the user can see their queued edits land at a slightly shifted position — correct, but occasionally surprising, which is why long-offline sessions get a subtler 'merging changes' indicator rather than a silent instant sync.",
      ],
      bullets: [
        { lead: "Local queue", text: "ops go into IndexedDB and apply to the local view immediately, network state or not." },
        { lead: "Reconnect handshake", text: "client sends its queued ops plus the last revision it saw; the server transforms them like any other op." },
        { lead: "Long offline sessions", text: "heavy concurrent changes underneath a long queue can visibly shift where the queued text lands — correct, but worth flagging in the UI." },
        { lead: "No special case", text: "offline sync reuses the exact same transform-and-apply path as live editing — there is no separate merge algorithm." },
      ],
      pictureTitle: "Offline is just latency, not a different code path",
      pictureRows: [
        { label: "Offline, still typing", value: "local optimistic apply, ops queued", tone: "good" },
        { label: "Reconnect", value: "queued ops sent with last-seen revision", tone: "neutral" },
        { label: "Server", value: "same transform-and-apply as any live op", tone: "good" },
      ],
      remember: {
        problem: "A client goes offline mid-edit and must reconcile without losing or corrupting anything.",
        solution: "Queue ops locally, apply optimistically, and replay the queue through the normal OT transform on reconnect.",
        why: "Offline is structurally identical to a long network delay if the transform function is already correct.",
        tradeoff: "Very long offline sessions can produce a visible 'jump' when heavy concurrent edits get rebased against.",
        failure: "A bespoke offline-merge algorithm, separate from the live path, doubles the surface area for convergence bugs.",
        mitigation: "Reuse one transform path for both live and reconnect traffic; surface a 'merging changes' indicator for long queues.",
      },
    },
    {
      n: 5,
      title: "Storage: snapshot plus a short op-log tail",
      body: [
        "Replaying every keystroke a document has ever received to open it would make a five-year-old doc slower to open than a five-minute-old one — unacceptable. Instead, store a full snapshot of the document tree plus a durable append-only op log of everything since that snapshot. Opening a doc reads the latest snapshot and replays only the short tail, not the whole history.",
        "A background compactor periodically (roughly every 1,000 ops, or every 30 seconds of active editing) folds the op log into a fresh snapshot and lets the old tail be pruned once every client has caught up. Named revision history — the 'version history' feature users actually see — is a separate, much lower-frequency tier: durable named checkpoints kept indefinitely for diff-and-restore, independent of the working compaction snapshots that only exist to bound cold-open latency.",
      ],
      bullets: [
        { lead: "Snapshot", text: "the fully materialized document tree at a point in time — what cold open actually reads." },
        { lead: "Op log", text: "durable, append-only, per document; the source of truth for anything since the last snapshot." },
        { lead: "Compaction", text: "periodic (~1K ops / ~30s), folds the log into a new snapshot so cold open never replays deep history." },
        { lead: "Named revisions", text: "a separate, sparser, permanent tier for the version-history UI — not the same thing as a compaction checkpoint." },
      ],
      pictureTitle: "Why open latency doesn't grow with document age",
      pictureRows: [
        { label: "Replay full history on open", value: "gets slower forever → reject", tone: "bad" },
        { label: "Snapshot + short op-log tail", value: "open cost is bounded, not cumulative", tone: "good" },
        { label: "Compaction snapshots", value: "pruned once superseded", tone: "neutral" },
        { label: "Named revisions", value: "kept forever for version history", tone: "used" },
      ],
      remember: {
        problem: "Cold-open latency must not grow with how old or how edited a document is.",
        solution: "Store a full snapshot plus a short durable op-log tail; compact the tail into a fresh snapshot periodically.",
        why: "Reading one blob plus a bounded tail is O(1)-ish; replaying the whole op history is O(document age).",
        tradeoff: "Compaction is extra background work and a second storage tier (working snapshots vs. permanent named revisions).",
        failure: "Op-log-only storage means a decade-old, heavily-edited doc takes longer to open every year.",
        mitigation: "Compact every ~1K ops or ~30s, and keep named revision checkpoints on a separate, sparser retention policy.",
      },
    },
    {
      n: 6,
      title: "Presence is not the op log — keep it separate",
      body: [
        "Cursor position and text selection change many times a second per user, but losing one is invisible — the next update supersedes it a moment later. Losing a keystroke is never invisible. Because these two data types have opposite durability requirements, they must never share infrastructure: presence rides a lightweight, throttled, unpersisted pub/sub channel, completely separate from the durable op log.",
        "This is the same tier-1-vs-tier-3 pattern as async analytics in a read-heavy system: a lower-priority, higher-frequency signal must never be able to add latency or backpressure to the higher-priority one. Throttle presence broadcasts to roughly 10 updates/sec per user and let them drop silently under load; never let a presence burst slow down or queue behind a real edit.",
      ],
      bullets: [
        { lead: "Different durability", text: "a dropped cursor update is invisible a moment later; a dropped keystroke is data loss." },
        { lead: "Separate channel", text: "presence uses its own ephemeral pub/sub, not the durable, ordered op log." },
        { lead: "Throttled", text: "cap broadcasts to roughly 10/sec per user regardless of how fast the mouse or cursor is actually moving." },
        { lead: "Never contends", text: "presence traffic must not be able to add latency or backpressure to the op path, even under a presence burst." },
      ],
      pictureTitle: "Two data types, two durability tiers",
      pictureRows: [
        { label: "Keystroke (op)", value: "durable, ordered, never dropped", tone: "good" },
        { label: "Cursor/selection (presence)", value: "ephemeral, throttled, drop-safe", tone: "neutral" },
        { label: "Sharing infra between them", value: "a presence burst could delay real edits → reject", tone: "bad" },
      ],
      remember: {
        problem: "Broadcast high-frequency cursor/selection data without letting it touch edit latency.",
        solution: "A separate ephemeral, throttled pub/sub channel for presence, fully decoupled from the durable op log.",
        why: "Presence and edits have opposite durability needs; mixing them lets a burst of one degrade the other.",
        tradeoff: "Occasional lost or stale cursor positions are an accepted cost for keeping the edit path clean.",
        failure: "Route presence through the op log and a flurry of mouse moves adds latency to actual keystrokes.",
        mitigation: "Independent channel, throttled to ~10 updates/sec/user, safe to drop under load.",
      },
    },
    {
      n: 7,
      title: "OT vs. CRDT: the question you should expect",
      body: [
        "A strong interviewer will ask why not CRDTs (conflict-free replicated data types), since newer collaborative tools like Figma lean on them. CRDTs let peers merge concurrent edits with no central sequencer at all, which is great for fully offline, local-first, peer-to-peer apps. But rich-text CRDTs (RGA, Peritext-style structures) carry per-character or per-span metadata and tombstones that bloat memory and storage, and correctly handling overlapping formatting operations in a CRDT is still an active research problem.",
        "Google Docs already needs a server for auth, storage, and sharing, so the 'no central coordinator' benefit of CRDTs buys less than it costs — OT with one sequencer per doc is simpler to reason about and cheaper in memory for long, heavily-formatted documents. The honest framing for an interview: CRDTs win when the topology is genuinely peer-to-peer or offline-first with no natural server; OT wins when you already have a server in the loop and want simpler, leaner state.",
      ],
      bullets: [
        { lead: "CRDT strength", text: "no central sequencer, merges peer-to-peer, ideal for local-first or fully offline collaboration." },
        { lead: "CRDT cost", text: "per-character/span metadata and tombstones bloat memory; overlapping rich-text formatting merges are still hard to get fully right." },
        { lead: "OT fits here", text: "a server is already required for auth and storage, so paying for one sequencer per doc is nearly free." },
        { lead: "The honest answer", text: "this is a topology tradeoff, not a 'better algorithm' — pick CRDT when there's no natural server, OT when there is." },
      ],
      pictureTitle: "OT vs. CRDT, honestly",
      pictureRows: [
        { label: "CRDT", value: "best for peer-to-peer / offline-first, heavier metadata", tone: "neutral" },
        { label: "OT + central sequencer", value: "best when a server already exists, leaner state", tone: "good" },
        { label: "Google Docs's topology", value: "already client-server → OT fits", tone: "good" },
      ],
      remember: {
        problem: "Interviewer asks why not use a CRDT instead of OT.",
        solution: "OT with a per-doc central sequencer, because a server is already in the loop for auth/storage/sharing.",
        why: "CRDTs pay off when there is no natural coordinator; that benefit is mostly wasted once you already run one.",
        tradeoff: "You give up CRDTs' fully decentralized merge in exchange for leaner per-character state.",
        failure: "Naively adopting a rich-text CRDT can blow up memory with tombstones and still mishandle overlapping format merges.",
        mitigation: "Name the topology reason explicitly: server already required here, so OT's single point of coordination is nearly free.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a real-time sync problem, not a CRUD app: every keystroke must reach every collaborator and every replica must converge to the same document.",
      "Operational Transformation with a central sequencer per document — one server owns each doc's canonical order, so transforms are only ever client-vs-server, never peer-vs-peer.",
      "Docs are sharded one-owner-per-doc via consistent hashing; that single writer is what makes conflict resolution tractable at all.",
      "Storage is a snapshot plus a short op-log tail, compacted periodically, so opening a doc never means replaying its whole history.",
      "Presence (cursors, selections) is an ephemeral side channel that can drop data; the op log never can.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · OPEN DOC · P99 < 1S",
        summary:
          "Opening a doc authenticates, checks ACLs, and loads the latest snapshot plus a short op-log tail — never the whole edit history.",
        steps: [
          { label: "Client", note: "requests to open a document" },
          { label: "WS Gateway", note: "authenticates, opens the connection" },
          { label: "Metadata Store", note: "Spanner: ACL / sharing check" },
          { label: "Snapshot Store", note: "latest full-doc blob" },
          { label: "Op Log", note: "replay the short tail since the snapshot" },
          { label: "Render", note: "client shows the current document" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · LIVE EDIT · P99 < 100MS FAN-OUT",
        summary:
          "The keystroke applies locally first, then travels to the one server that owns this document's order, gets transformed, persisted, and broadcast.",
        steps: [
          { label: "Client types", note: "optimistic local apply, <10ms" },
          { label: "WS Gateway", note: "forwards the op" },
          { label: "Shard Router", note: "consistent hash: docId → owning server" },
          { label: "Doc Session Server", note: "transform against ops since client's revision" },
          { label: "Op Log", note: "durable append, assigns next revision" },
          { label: "Collaborators", note: "broadcast transformed op, <100ms" },
        ],
      },
      {
        kind: "analytics",
        title: "SIDE CHANNEL · NEVER BLOCKS AN EDIT",
        summary:
          "Presence, compaction, and search all run off to the side. None of them can add latency to a keystroke, and all of them can be dropped or delayed under load.",
        steps: [
          { label: "Doc Session Server", note: "cursor/selection broadcast, throttled ~10/sec" },
          { label: "Op Log", note: "feeds the compactor and the search indexer" },
          { label: "Snapshot Compactor", note: "periodic, ~1K ops or ~30s" },
          { label: "Search Indexer", note: "async full-text index update" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "1B documents stored, 100M DAU, up to ~100 concurrent editors/doc",
          "Edit propagation to collaborators: p99 < 100ms; local optimistic apply: p99 < 10ms",
          "Cold doc open: p99 < 1s (snapshot + short op-log tail, not full replay)",
          "Snapshot compaction every ~1,000 ops or ~30s of activity, whichever comes first",
          "~10M concurrent WebSocket connections system-wide at peak",
          "Presence broadcasts throttled to ~10 updates/sec per user, never persisted",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Client-server OT (star topology), not peer-to-peer OT and not a CRDT",
          "One authoritative Doc Session Server per doc, routed via consistent hashing",
          "Snapshot + op-log, not op-log-only, so cold open never replays full history",
          "Presence on a separate ephemeral pub/sub channel, never the durable op log",
          "Offline edits queued locally, replayed through the same transform path on reconnect",
          "Search indexing and named revision history both async, off the edit path",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Client-server topology turns intractable peer-to-peer OT (TP1+TP2) into simple client-vs-server transforms (TP1 only)",
          "Single-writer-per-doc means conflict resolution never needs distributed consensus per keystroke",
          "Presence is a side channel — losing a cursor update is fine, losing a keystroke is never fine",
          "Offline sync reuses the live-edit transform path; there is no separate merge algorithm",
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
      goal: "Lock the scale numbers and the concurrency model before drawing anything. The interviewer needs to hear you treat 'real-time' as a number, not a vibe.",
      why: "Every later decision — single-writer sharding, the 100ms budget, presence throttling — falls directly out of the numbers locked here. Skipping this step is the single biggest reason candidates end up hand-waving the OT deep dive later.",
      steps: [
        { kind: "ASK", text: '**"How many people can be editing the same document at once?"** Land on "up to ~100 concurrent editors per doc". Write **"~100 editors/doc"** in the top-left corner.' },
        { kind: "ASK", text: '**"What does \'real time\' mean numerically — is 500ms okay, or does it need to feel instant?"** Land on "p99 < 100ms to remote collaborators, local apply feels instant (<10ms)". Write both numbers down.' },
        { kind: "SAY", text: 'Propose scale yourself: **"1B documents, 100M DAU"**. Wait for a nod, then write it down rather than keeping it in your head.' },
        { kind: "SAY", text: 'State scope. In: "live collaborative editing", "presence", "offline sync", "revision history". Out: "OCR/image editing", "billing", "spreadsheet/slides-specific features". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Name the two failure domains out loud: **"conflicting concurrent edits"** and **"a client going offline mid-edit"**. These are the two hard parts everything else serves.' },
      ],
      grading: "Are the concurrency cap, the latency budget, and the offline requirement all on the board with numbers before a single box gets drawn?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Define the op shape and the document representation before touching conflict resolution — you can't explain a transform function without first showing what it transforms.",
      why: "The interviewer wants to see that you think of an edit as a structured, positioned operation, not an opaque 'save the whole doc' blob. This is what makes the OT deep dive land cleanly later.",
      steps: [
        { kind: "WRITE", text: 'Write the op shape: **"insert(pos, text, revision)"**, **"delete(pos, len, revision)"**, **"format(range, attrs, revision)"**. Say: "Every op is small, positioned, and tagged with the revision it was generated against."' },
        { kind: "DRAW", text: 'Sketch the document representation: a tree of blocks (paragraphs, headings, lists, tables) each holding a run of formatted spans. "This is what a snapshot actually serializes."' },
        { kind: "SAY", text: 'Name the WebSocket surface: **"client connects, sends ops, receives an ack with its assigned revision plus a broadcast of everyone else\'s ops."** No polling, no page loads mid-session.' },
        { kind: "RULE OUT", text: '"Sending the whole document on every keystroke" — reject: bandwidth and CPU cost scale with doc size instead of edit size, and it defeats fine-grained conflict resolution entirely.' },
      ],
      grading: "A concrete, positioned op format on the board, a tree-shaped document model, and a WebSocket-based API stated without prompting.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: read (open a doc), write (live edit), and the async side channel (presence, compaction, search). Label arrows with the numbers, not just box names.",
      why: "Drawing these as separate lanes proves you understand they have different requirements — durability for edits, throughput for presence, freshness for search — and therefore need different infrastructure and different failure tolerances.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → WS Gateway → Metadata Store (ACL check) → Snapshot Store → Op Log (short tail replay). Label it **"p99 < 1s cold open"**.' },
        { kind: "DRAW", text: 'Add the **write path** as its own lane: Client → WS Gateway → Shard Router (consistent hash) → Doc Session Server (transform) → Op Log (durable append) → Collaborators (broadcast). Label it **"p99 < 100ms fan-out"**.' },
        { kind: "DRAW", text: 'Add the **async side channel**, dashed: Doc Session Server → Presence (throttled, ephemeral); Op Log → Snapshot Compactor → Snapshot Store; Op Log → Search Indexer. Label it **"never blocks an edit"**.' },
        { kind: "SAY", text: 'Narrate the split: "Edits are durable and latency-critical, presence is ephemeral and drop-safe, and both search and compaction run entirely off the hot path."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with the actual latency and durability budgets, and an explicit statement that presence/search/compaction never sit on the edit path.",
    },
    {
      n: 4,
      title: "Deep Dive: Conflict Resolution (OT)",
      minutes: 8,
      goal: "Show the transform function, the single-writer-per-doc shard, and defend the client-server topology as the reason OT is tractable here at all.",
      why: "This is the signature sub-problem of the whole interview. The interviewer is probing whether you understand OT is hard in general (peer-to-peer, TP2) but tractable in this specific topology (client-server, TP1 only) — and whether you can explain why a single owning server per doc removes the need for distributed consensus.",
      steps: [
        { kind: "SAY", text: 'Explain the transform: "xform(opA, opB) adjusts opB\'s position assuming opA already applied, so applying both in either order produces the same text."' },
        { kind: "DRAW", text: 'Draw the star topology: Client A, Client B → Doc Session Server (single owner). "Every transform is client-vs-server, never client-vs-client — that\'s what avoids needing the TP2 convergence property."' },
        { kind: "SAY", text: 'Explain the shard: "docId hashes to one owning session server that holds the live doc in memory and is the sole sequencer for its revision numbers — no per-keystroke consensus protocol needed."' },
        { kind: "RULE OUT", text: '"Full peer-to-peer OT" — reject: needs TP1+TP2, very hard to prove correct for rich text formatting. "Distributed consensus per keystroke" — reject: correct but far too slow for a 10ms local, 100ms remote budget.' },
      ],
      grading: "The transform function stated correctly, the client-server topology named as the reason it's tractable, and the single-writer shard explained as the mechanism, without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: Storage, Offline, and Presence",
      minutes: 7,
      goal: "Cover the snapshot+op-log storage model, how offline reconnection reuses the live transform path, and why presence is a deliberately separate, lossy channel.",
      why: "This section is where staff-level candidates show operational maturity: bounded cold-open latency regardless of document age, no bespoke offline-merge code path, and an explicit durability-tier distinction between edits and presence.",
      steps: [
        { kind: "SAY", text: '"Storage is a full snapshot plus a short durable op-log tail, compacted every ~1,000 ops or ~30 seconds. Cold open reads the snapshot and replays only the tail — open latency doesn\'t grow with document age."' },
        { kind: "SAY", text: '"Offline editing queues ops locally and applies them optimistically. On reconnect, the client resends its queue tagged with its last-seen revision, and the server runs the exact same transform it always does — there\'s no separate offline-merge algorithm."' },
        { kind: "SAY", text: '"Presence — cursors and selections — rides a separate, throttled, ephemeral pub/sub channel, never the op log. Losing a cursor update is invisible; losing a keystroke is not, so they can\'t share infrastructure."' },
        { kind: "SAY", text: 'Volunteer the tradeoff: "Named revision history is a separate, sparser, permanent tier from the working compaction snapshots — version history and cold-open performance are different problems."' },
      ],
      grading: "Snapshot+op-log explained with the compaction cadence, offline reconnection framed as reusing the live path, and presence explicitly named as a lower-durability side channel.",
    },
    {
      n: 6,
      title: "Wrap: Bottlenecks, Tradeoffs, and Close",
      minutes: 5,
      goal: "Name the single-writer ceiling, the OT-vs-CRDT tradeoff, and close with a crisp one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal here is naming your own design's limits before being asked, and giving a considered answer to 'why not CRDT' rather than a reflexive one.",
      steps: [
        { kind: "SAY", text: '"The single-writer-per-doc shard is also the ceiling — one document can\'t scale past what one session server can hold and transform, which is exactly why concurrent editors per doc is capped around 100."' },
        { kind: "SAY", text: 'Address CRDTs unprompted: "CRDTs remove the need for a central sequencer, which matters for peer-to-peer or fully offline apps. We already need a server for auth and storage, so OT\'s single point of coordination is nearly free here, and it avoids the memory overhead of rich-text CRDT metadata."' },
        { kind: "SAY", text: 'Push back where useful: "Do we actually need 100 concurrent editors, or is 20-30 realistic and the rest is presentation-mode viewers?" Treat the cap as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s client-server OT with one sequencer per doc, snapshot-plus-op-log storage, and presence kept off the durable path. With more time I\'d cover comment threading, suggestion mode\'s accept/reject semantics, and multi-doc search ranking."' },
      ],
      grading: "The single-writer ceiling named unprompted, a substantive OT-vs-CRDT answer, at least one pushback on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working real-time editor with the right components, but the conflict-resolution mechanism and its correctness argument stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: WebSocket connection, some kind of server-side merge, a database.",
          "Knows edits need to reach other users fast and reaches for WebSockets without prompting.",
          "Adds presence (cursors) as a feature when asked, usually via the same channel as edits.",
          "Can sketch a document as a blob of text or a simple tree.",
          "Knows offline support is needed and proposes 'sync when back online' at a high level.",
        ],
        gaps: [
          "Says 'we merge the changes' without a concrete transform function or algorithm name.",
          "Doesn't distinguish presence traffic from edit traffic — both go through the same path.",
          "Storage is 'save the document' with no snapshot/log distinction, so open latency isn't addressed.",
          "No sharding story — assumes one server or a generic load balancer handles every document.",
          "Offline sync is hand-waved as 'reconcile the differences' with no mechanism.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives to Operational Transformation with a real transform function, sizes the system with numbers, and separates presence from the durable edit path.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the concurrency, latency, and scale numbers on the board within the first 5 minutes.",
          "Names Operational Transformation and can state the transform function's job in one sentence.",
          "Shards documents to a single owning server via consistent hashing and explains why.",
          "Separates the durable op log from ephemeral presence broadcasts.",
          "Proposes snapshot + op-log storage instead of replaying full history on open.",
          "Handles offline editing with a local queue and reconnect flow.",
        ],
        gaps: [
          "Doesn't explain why client-server OT is tractable (TP1 only) versus full peer-to-peer OT (TP1+TP2) unless pushed.",
          "Doesn't volunteer the OT-vs-CRDT comparison unless directly asked.",
          "Names the single-writer shard but doesn't proactively name the concurrent-editor ceiling it implies.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, explains why the client-server topology makes OT tractable at all, and volunteers every load-bearing tradeoff before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Explains the star-topology insight unprompted: client-server OT only needs TP1, full peer-to-peer OT needs the much harder TP2.",
          "Volunteers the single-writer-per-doc ceiling as the reason for the ~100 concurrent-editor cap, with the reasoning, not just the number.",
          "Gives a substantive, unprompted OT-vs-CRDT comparison, naming when each topology actually wins.",
          "Frames presence and edits as two different durability tiers and explains why they must never share infrastructure.",
          "Explains why cold-open latency is bounded (snapshot + short tail) rather than growing with document age.",
          "Pushes back on requirements where appropriate (concurrent editor count, presentation-mode viewers vs. real editors).",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Saying 'we just merge the changes' with no named algorithm or transform function — this is the load-bearing mechanism of the whole system.",
      "Routing presence (cursor/selection) through the same durable channel as edits, so a burst of mouse movement can delay a keystroke.",
      "No sharding story: assuming a generic load balancer can route concurrent edits for the same document to different servers without a single sequencer.",
      "Replaying the full op history to open a document, so a five-year-old heavily-edited doc opens slower every year.",
      "Proposing full peer-to-peer OT without acknowledging TP2 is genuinely hard to prove correct for rich text.",
      "Treating offline sync as a separate, bespoke merge algorithm instead of reusing the live transform path.",
      "No mention of a concurrent-editor ceiling — implying a single document can scale writes infinitely.",
    ],
    followUps: [
      {
        q: "Why not just use a CRDT instead of OT?",
        a: "CRDTs remove the need for a central sequencer entirely, which is genuinely valuable for peer-to-peer or fully offline, local-first apps like Figma's multiplayer canvas. But Google Docs already requires a server for auth, storage, and sharing, so the 'no coordinator' benefit is mostly wasted, while rich-text CRDTs pay a real cost: per-character or per-span metadata and tombstones that bloat memory for long documents, plus genuinely hard edge cases in merging overlapping formatting operations. Given a server is already in the loop, OT with one sequencer per doc is the leaner choice.",
      },
      {
        q: "What happens if the Doc Session Server for a popular document crashes mid-edit?",
        a: "Its lease expires, the shard router's consistent-hash ring reassigns the doc to another server, and that server rebuilds exact state by loading the latest snapshot and replaying the durable op-log tail since it. Only once that replay completes does it start accepting new ops and assigning new revision numbers — clients see a brief reconnect, but no committed edit is lost because the op log is durable independent of any one server's memory.",
      },
      {
        q: "Why cap concurrent editors per document at roughly 100?",
        a: "Because every op for a document is transformed and sequenced by exactly one in-memory session server — that's what avoids distributed consensus on every keystroke. The tradeoff is that a single document's edit throughput is bounded by one server's CPU and memory, not the cluster's. Past a few dozen truly concurrent typists the transform queue and broadcast fan-out start to strain a single process, so the cap is a deliberate ceiling, not an oversight, and it's exactly why the interview should surface it unprompted.",
      },
      {
        q: "How does formatting (bold, headings, tables) interact with OT, versus plain text?",
        a: "Formatting ops (format(range, attrs)) transform against concurrent inserts/deletes the same way text ops do — an insert inside a bolded range needs to inherit or not inherit that formatting depending on intent, and two overlapping format ops on the same range need a defined merge rule (e.g., last-writer-wins per attribute, or explicit union/intersection semantics). This is precisely the part of OT that gets hard fast, and it's also the part real rich-text CRDTs (like Peritext) were specifically designed to make more tractable — a good candidate names this as the genuinely hard corner of the whole problem.",
      },
      {
        q: "Why is presence throttled to about 10 updates a second instead of sending every mouse move?",
        a: "Because presence is a display aid, not data: the human eye can't distinguish 10 cursor updates/sec from 100, but 100/sec from every active collaborator multiplies fan-out traffic for zero perceptible benefit and risks contending with the systems that carry real edits if they're not fully isolated. Throttling client-side (or server-side on ingest) keeps the ephemeral channel cheap and keeps its worst-case load bounded and predictable.",
      },
      {
        q: "How would you extend this design to support suggestion mode (track changes)?",
        a: "Suggestions are ops tagged with an author and a pending state rather than applied directly to the canonical text — the document model needs a parallel 'proposed changes' layer that renders as strikethrough/underline overlays on top of the accepted text. They still flow through the same OT pipeline for ordering and conflict resolution (two people suggesting overlapping edits still need to converge), but accept/reject is a separate op type that either merges the suggestion into the canonical text or discards it, keeping the core transform logic unchanged.",
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
          "This is a real-time convergence problem with a document attached. The core operation isn't 'save a file' — it's 'every collaborator's keystroke must reach everyone else and every replica must land on the exact same text,' and everything expensive here (transform functions, single-writer sharding, snapshotting, presence isolation) exists to make that convergence fast, correct, and cheap at up to 100 concurrent typists per doc.",
          "Anchor everything on four numbers: 1B documents, 100M DAU, ~100 concurrent editors per document, and a p99 < 100ms edit-propagation budget. Every structural choice below is a direct consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Killing the naive approaches",
        body: [
          "Pessimistic locking serializes typing behind network round trips and is a non-starter for a product whose entire value is simultaneous typing. Last-write-wins silently deletes a collaborator's work whenever two saves race — unacceptable for a document with real content in it. A git-style diff/merge is fine at file granularity for occasional merges, but at keystroke granularity it would surface a conflict prompt every few seconds.",
          "Operational Transformation is the answer because it preserves intent: a transform function adjusts an incoming op's position based on what has already been applied, so two concurrent edits both land and both clients converge on identical text, with no lock and no visible conflict.",
        ],
      },
      {
        heading: "Why OT is tractable here: the star topology",
        body: [
          "Full peer-to-peer OT, where every client can transform directly against every other client, requires the transform function to satisfy two convergence properties, TP1 and TP2. TP2 is famously difficult to prove correct for rich text with formatting spans, and getting it wrong produces documents that silently diverge between clients — a bug class that's brutal to detect and reproduce.",
          "Google Docs sidesteps this by using a client-server star topology: every client only ever transforms against the server's canonical history, and the server only transforms against its own applied history. That collapses the requirement to TP1 alone. Concretely, the server assigns a strict total order (a revision number) to every accepted op; when a client's op arrives tagged with an older revision, the server transforms it against everything applied since, applies it, and broadcasts the transformed op with its new revision to everyone, including an ack to the sender.",
        ],
      },
      {
        heading: "Single writer per document: the shard that avoids consensus",
        body: [
          "Assigning a total order requires one authority. Rather than run distributed consensus on every keystroke, each document is pinned via consistent hashing to exactly one in-memory session server, which holds the live document tree and is the sole process allowed to assign revision numbers for that doc. 'Agree on an order' becomes 'ask the process that already knows the order' — no coordination protocol needed on the hot path.",
          "The cost of this is a throughput ceiling: one document can't scale past what a single server can hold and transform, which is precisely why concurrent live editors per document is capped around 100. On failure, the owning server's lease expires, another node claims it, reloads the latest snapshot plus the op-log tail, replays it to reconstruct exact state, and only then resumes accepting writes — so a crash costs a brief reconnect, never a lost edit.",
        ],
      },
      {
        heading: "Storage, offline, and the presence side channel",
        body: [
          "Cold-open latency must not grow with document age, so storage is a full snapshot of the document tree plus a short durable op-log tail since that snapshot; opening a doc reads the snapshot and replays only the tail. A background compactor folds the log into a fresh snapshot roughly every 1,000 ops or 30 seconds, and named revision history for the version-history UI is a separate, sparser, permanent tier, independent of these working compaction checkpoints.",
          "Offline editing queues ops locally and applies them optimistically; on reconnect the client resends its queue tagged with its last-seen revision and the server runs the identical transform-and-apply path it always does — there's no bespoke offline-merge algorithm. Presence (cursors, selections) is architecturally separate: it's ephemeral and drop-safe where edits are durable and loss-intolerant, so it rides its own throttled pub/sub channel that can never add latency or backpressure to a real edit.",
        ],
      },
      {
        heading: "OT vs. CRDT, and where this design's edges are",
        body: [
          "CRDTs remove the need for a central sequencer entirely and shine in peer-to-peer or fully offline, local-first topologies. But since Google Docs already requires a server for auth, storage, and sharing, that benefit is largely unrealized, while rich-text CRDTs pay real costs in per-character metadata, tombstone bloat, and genuinely hard overlapping-format-merge semantics. Given the server is already there, OT with one sequencer per document is the leaner choice — this is a topology tradeoff, not a claim that OT is universally superior.",
          "The honest edges of this design: a single document's live-edit throughput is capped by one server's capacity, formatting merges are the hardest corner of the transform function, and the whole system leans on presence being safely lossy. A strong answer names all three before being asked.",
        ],
      },
    ],
  },
};
