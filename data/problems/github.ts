import type { Problem } from "@/lib/types";

export const github: Problem = {
  slug: "github",
  num: "4.2",
  title: "Design GitHub",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a hosted Git platform storing 420M+ repositories for 100M+ developers: git push/pull/clone over smart HTTP and SSH, pull-request code review, issue tracking, code search across the whole corpus, and webhook/CI triggers on every push — all while a repo forked 50,000 times must not cost 50,000× the storage.",
  ],
  hardParts:
    "The hard parts: storing Git's content-addressable object graph durably and cheaply when forks share nearly all of their objects with their parent, keeping pull-request review comments anchored to the right line across force-pushes and rebases, and indexing code search over hundreds of millions of mutating repos without re-indexing the world on every push.",
  keyTopics: [
    "Content-Addressable Object Store (Git DAG)",
    "Fork Network Object Pooling",
    "Spokes Replication (Raft Quorum)",
    "Diff-Anchored PR Comments",
    "Incremental Code Search Indexing",
  ],
  foundationsReferenced: [
    { label: "Merkle DAGs", tone: "green" },
    { label: "Raft Consensus", tone: "orange" },
    { label: "Vitess / MySQL Sharding", tone: "purple" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Inverted Indexes", tone: "blue" },
    { label: "Content-Addressable Storage", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "git CLI / browser", col: 1, row: 2, tone: "slate" },
      { id: "lb", label: "Git Front Door", sub: "smart HTTP + SSH", col: 2, row: 2, tone: "slate" },
      {
        id: "repoRouter",
        label: "Repo Router",
        mono: "consistent hash(repo_id) → spoke",
        col: 3,
        row: 2,
        tone: "blue",
      },
      { id: "spokes", label: "Spokes Storage", sub: "3 replicas · Raft leader", col: 4, row: 2, tone: "green" },
      { id: "metaDB", label: "MySQL / Vitess", sub: "repos, users, PRs, issues", col: 4, row: 1, tone: "purple" },
      {
        id: "prService",
        label: "PR Service",
        mono: "diff engine · comment anchoring",
        col: 2,
        row: 4,
        tone: "purple",
      },
      { id: "kafka", label: "Kafka", sub: "push / PR events", col: 3, row: 3, tone: "orange" },
      { id: "webhook", label: "Webhook Dispatcher", sub: "HMAC-signed, retried", col: 4, row: 3, tone: "orange" },
      { id: "actions", label: "Actions Runners", sub: "ephemeral VMs", col: 5, row: 3, tone: "orange" },
      { id: "blackbird", label: "Blackbird Index", sub: "code search", col: 4, row: 4, tone: "blue" },
    ],
    edges: [
      { from: "client", to: "lb", label: "git clone/fetch · API/web read", kind: "read" },
      { from: "lb", to: "repoRouter", label: "route by repo_id · pull", kind: "read" },
      { from: "repoRouter", to: "spokes", label: "any in-sync replica", kind: "read" },
      { from: "lb", to: "metaDB", label: "PR/issue/user reads", kind: "read" },
      { from: "client", to: "lb", label: "git push", kind: "write" },
      { from: "lb", to: "repoRouter", label: "route by repo_id · push", kind: "write" },
      { from: "repoRouter", to: "spokes", label: "Raft leader · quorum write", kind: "write" },
      { from: "lb", to: "prService", label: "open/review/merge PR", kind: "write" },
      { from: "prService", to: "spokes", label: "diff read · base..head blobs/trees", kind: "read" },
      { from: "prService", to: "spokes", label: "merge commit · quorum write", kind: "write" },
      { from: "prService", to: "metaDB", label: "comments, review state, merge queue", kind: "write" },
      { from: "spokes", to: "kafka", label: "post-receive event", kind: "analytics" },
      { from: "kafka", to: "webhook", label: "fan-out", kind: "analytics" },
      { from: "kafka", to: "actions", label: "trigger workflow", kind: "analytics" },
      { from: "kafka", to: "blackbird", label: "reindex changed blobs", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · clone/fetch/browse, ~40K/sec" },
      { kind: "write", text: "write path · git push · PR open/review/merge" },
      { kind: "analytics", text: "async lane · webhooks, Actions triggers, search — never blocks a push" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "lb", "repoRouter", "spokes"],
      say: "Start with the core git loop: a client pushes or pulls through a front door that speaks smart HTTP and SSH. A repo router consistent-hashes the repo id to find its storage location, and Spokes holds the actual git objects — replicated three ways with a Raft-elected leader taking writes.",
    },
    {
      reveal: ["prService", "metaDB"],
      say: "Pull requests and issues are a different data problem: relational, transactional metadata. The PR Service reads commits and blobs straight out of Spokes to compute a diff, then persists comments and review state into MySQL, sharded by repo_id via Vitess — and because a merge is still a git write, it lands a real commit back into Spokes too.",
    },
    {
      reveal: ["kafka"],
      say: "Every write that lands in Spokes, a push or a merge, drops a single post-receive event into Kafka after the client's ack has already gone out. Nothing downstream is allowed to add latency to that write.",
    },
    {
      reveal: ["webhook", "actions", "blackbird"],
      say: "Three consumers read that same event at their own pace: the Webhook Dispatcher fires signed callbacks out to integrations, Actions Runners pick up CI workflows, and Blackbird re-tokenizes only the blobs that changed, so search stays fresh without ever re-indexing the world.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Git push/pull/clone over smart HTTP and SSH, including shallow and partial clone", tag: "P0" },
      { id: "FR-02", text: "Fork a repository; the fork shares objects with its parent via a fork network and diverges independently", tag: "P0" },
      { id: "FR-03", text: "Open, review (inline + file-level comments), approve, and merge pull requests, including a merge queue", tag: "P0" },
      { id: "FR-04", text: "Issues: create, label, assign, and cross-reference (#123) between issues and PRs", tag: "P0" },
      { id: "FR-05", text: "Repo/org/team access control: public, private, and internal visibility with role-based permissions", tag: "P0" },
      { id: "FR-06", text: "Fire webhooks and trigger CI (Actions workflows) on push, PR, and issue events", tag: "P0" },
      { id: "FR-07", text: "Code search (and code navigation) across every repo the requester can see", tag: "P0" },
      { id: "FR-08", text: "Web-based file browsing: render files with syntax highlighting, blame, and history at any commit", tag: "P1" },
      { id: "FR-09", text: "Notifications (web + email) for mentions, review requests, and subscribed activity", tag: "P1" },
      { id: "FR-10", text: "Large file storage via Git LFS with a separate content store", tag: "P1" },
      { id: "FR-11", text: "REST + GraphQL API with per-token rate limiting for integrations", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "git push server-side latency, ack after quorum write (repos < 1GB)", tag: "p99 < 1s" },
      { id: "NFR-02", text: "git clone/fetch latency, warm pack cache", tag: "p99 < 2s" },
      { id: "NFR-03", text: "Push throughput, sustained (burst on incident storms)", tag: "2K/sec" },
      { id: "NFR-04", text: "Clone/fetch throughput, sustained (CI-dominated)", tag: "40K/sec" },
      { id: "NFR-05", text: "Availability (about 4.4 hrs downtime per year)", tag: "99.95%" },
      { id: "NFR-06", text: "Durability of committed git objects (RF=3, quorum=2)", tag: "zero loss" },
      { id: "NFR-07", text: "Webhook delivery latency, from push landing to first delivery attempt", tag: "p99 < 5s" },
      { id: "NFR-08", text: "Code search index freshness, from push to searchable", tag: "< 60s" },
      { id: "NFR-09", text: "Storage dedup ratio for a popular repo's fork network vs. naive copy-per-fork", tag: "≥ 20:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why forks don't cost 50,000× storage",
      body: [
        "Start from the number that makes this problem interesting: a popular repo (a starter template, a framework) can be forked 50,000+ times. If every fork stored a full independent copy of the parent's git objects, a repo with a 40MB object graph would need 2TB across its fork network for bytes that are 99%+ identical to the original. At 420M repos platform-wide, naive per-repo storage is not just wasteful, it's the difference between a feasible and infeasible cost model.",
        "The fix has to exploit the fact that Git objects are content-addressed: a blob's identity is the hash of its contents, so an unchanged file has the exact same object id in the fork as in the parent. Storage design should let forks reference those objects instead of copying them.",
      ],
      bullets: [
        { lead: "Naive copy-per-fork", text: "50,000 forks × 40MB = 2TB for one logical codebase, almost entirely duplicate bytes. Rejected as a default." },
        { lead: "Fork network", text: "forks share a common object pool with their parent; only commits/blobs unique to the fork cost new bytes. A typical fork with a few commits of drift costs kilobytes, not megabytes." },
        { lead: "Why this matters early", text: "naming this constraint before drawing storage boxes is what separates 'add a database' from an actual design — it drives the object-store architecture in teardown 4." },
      ],
      pictureTitle: "Storage cost of a 50,000-fork repo",
      pictureCaption: "naive: 50,000 × 40MB = 2TB · with fork network: ~40MB shared + KB-scale drift per fork",
      pictureRows: [
        { label: "Naive copy-per-fork", value: "2TB for one logical codebase", tone: "bad" },
        { label: "Fork network (shared pool)", value: "~40MB shared + per-fork drift", tone: "good" },
      ],
      remember: {
        problem: "Storage cost of forks at 420M repos and 50,000-fork networks.",
        solution: "Fork network: forks share the parent's object pool, paying only for their own new commits.",
        why: "Git objects are content-addressed, so an unchanged file already has the identical object id across the fork and parent — sharing storage is just not re-writing bytes you already have.",
        tradeoff: "Shared pools couple garbage collection across the network — you can't prune an object until no fork in the network references it.",
        failure: "Naive per-fork copies turn a 40MB repo into a 2TB fork network, multiplying storage cost with every star the repo gets.",
        mitigation: "Reference-count objects across the fork network and only GC when the last referencing fork drops a commit.",
      },
    },
    {
      n: 2,
      title: "Git's object model: the DAG that shapes everything",
      body: [
        "Git itself is a content-addressable key-value store before it's a version control tool: every blob (file contents), tree (directory listing), and commit (snapshot + parent pointers) is identified by the SHA of its own content, and commits form a Merkle DAG — each commit hashes its tree and its parents, so any tampering anywhere changes every hash downstream of it. This is the foundation the rest of the design leans on.",
        "Two consequences matter for a hosting platform: objects are immutable once written (a 'change' is always a new object, never an edit), and identical content always produces the identical object id regardless of which repo or fork it lives in. Both are exactly the properties that made the caching story easy in a read-heavy KV design — here they make replication and dedup easy instead.",
      ],
      bullets: [
        { lead: "Blob", text: "raw file contents, hashed. Two files with identical bytes across any two repos on the platform share the same blob id." },
        { lead: "Tree", text: "a directory snapshot: a list of (name, mode, object id) entries. Trees reference blobs and other trees." },
        { lead: "Commit", text: "a tree id, parent commit id(s), author, and message. The DAG shape (parents) is what makes history, branches, and merges possible." },
        { lead: "Packfiles", text: "on disk, loose objects get compressed into packfiles with delta encoding between similar objects, which is what makes clone/fetch payloads small over the wire." },
      ],
      pictureTitle: "Why immutable + content-addressed matters",
      pictureRows: [
        { label: "Immutable objects", value: "no in-place edits, replication is append-only", tone: "good" },
        { label: "Content-addressed", value: "identical content ⇒ identical id, across repos", tone: "good" },
        { label: "Merkle DAG", value: "any tamper anywhere changes hashes downstream", tone: "neutral" },
      ],
      remember: {
        problem: "Need a storage model that's cheap to replicate, cache, and dedup at 420M-repo scale.",
        solution: "Lean on Git's own object model: immutable, content-addressed blobs/trees/commits forming a Merkle DAG.",
        why: "Immutability makes replication append-only and caching trivially correct; content addressing means identical bytes are identical objects, which is the mechanism fork sharing and cross-repo dedup both ride on.",
        tradeoff: "You inherit Git's own scaling pain points (huge trees, huge blobs) rather than designing storage from scratch — LFS exists to push large binaries out of this model.",
        failure: "Treating git storage as an opaque blob store loses the dedup and cheap-replication properties that content addressing gives for free.",
        mitigation: "Model storage and replication explicitly on the object graph, not as a generic file-store abstraction.",
      },
    },
    {
      n: 3,
      title: "Spokes: replicating repos without a distributed filesystem",
      body: [
        "A repo's git directory needs to survive a disk or host failure with zero object loss, at 2K pushes/sec sustained. Running Git on top of a generic distributed filesystem is slow and fragile — Git assumes local disk semantics for its ref updates and pack writes. Instead, replicate whole repo directories: each repo is assigned to a 'spoke' of 3 storage servers, one elected leader via Raft, two followers.",
        "Writes (pushes) go only to the leader, which fsyncs the pack and ref update, then replicates to followers before acking — a write is durable once 2 of 3 copies have it. Reads (clone/fetch) can be served by any in-sync replica, which is what lets read throughput scale independently of the leader.",
      ],
      bullets: [
        { lead: "Repo-as-unit-of-replication", text: "replicate the whole git directory, not individual objects — this matches how Git itself reads and writes (local disk, whole-repo operations like gc)." },
        { lead: "Raft-elected leader", text: "owns writes for that repo; a host failure triggers leader election and a new leader is serving pushes within seconds, not minutes." },
        { lead: "Quorum writes", text: "ack a push once 2 of 3 replicas have the pack durably on disk — one lost replica never loses committed history." },
        { lead: "Checksum repair", text: "a background reconciler hashes refs and packs across replicas and repairs any replica that's drifted, self-healing without a human paging." },
      ],
      pictureTitle: "Spokes: 3-way repo replication",
      pictureRows: [
        { label: "Push", value: "leader fsyncs, replicates, acks at quorum=2", tone: "neutral" },
        { label: "Pull/clone", value: "any in-sync replica serves it", tone: "good" },
        { label: "Leader failure", value: "Raft election, new leader within seconds", tone: "good" },
      ],
      remember: {
        problem: "Zero-loss durability for git pushes at 2K/sec without a slow generic distributed filesystem.",
        solution: "Spokes: repo-directory-level replication, 3 replicas, Raft-elected leader takes writes, quorum=2 acks.",
        why: "Git assumes local-disk semantics; replicating whole repo directories keeps that assumption true on each replica while still surviving a host failure.",
        tradeoff: "Only the leader accepts writes for a given repo, so a single very hot repo's write throughput is capped by one host's disk — mitigated by the repo router spreading repos across many spokes.",
        failure: "A generic network filesystem under Git adds latency and can corrupt packs under concurrent access, causing push failures under load.",
        mitigation: "Keep replication at the repo-directory granularity and run a background checksum reconciler to catch silent drift.",
      },
    },
    {
      n: 4,
      title: "Fork networks: the mechanism, not just the motivation",
      body: [
        "Teardown 1 established why forks must share storage. The mechanism: when you fork a repo, GitHub does not copy its git objects. The fork's git directory gets an `info/alternates` pointer at the parent network's shared object store, so `git cat-file` on the fork can resolve any object that exists in the parent, even though the fork's own pack directory is empty at fork time.",
        "New commits pushed to the fork land in the fork's own object store as usual. Only when they're merged back upstream (or the parent pulls them) do they become part of the shared pool. This means a fork network behaves like a tree: one root object pool, and every fork is a thin layer of its own divergent objects on top.",
      ],
      bullets: [
        { lead: "Alternates", text: "a fork's object lookup falls through to the parent's pool via `info/alternates` — read path is transparent, no copy needed at fork time." },
        { lead: "Divergent writes stay local", text: "commits unique to the fork live in the fork's own pack files; the shared pool is never mutated by a fork's push." },
        { lead: "GC coordination", text: "the shared pool can't drop an object while any fork in the network still references it — GC has to be network-aware, not per-repo." },
        { lead: "Detached forks", text: "if a fork needs to leave the network (e.g. the parent is deleted), it needs a one-time 'un-alternate' that copies the objects it actually uses out of the shared pool." },
      ],
      pictureTitle: "Fork network object flow",
      pictureRows: [
        { label: "Fork created", value: "info/alternates → parent's pool, 0 bytes copied", tone: "good" },
        { label: "Fork pushes new commits", value: "objects land in fork's own pack, pool untouched", tone: "neutral" },
        { label: "GC on shared pool", value: "object kept if referenced by any fork in the network", tone: "neutral" },
      ],
      remember: {
        problem: "Give forks copy-on-write-style storage without literally copying the git object graph.",
        solution: "info/alternates makes a fork's object lookup fall through to a shared parent pool; only new commits cost the fork bytes.",
        why: "Content-addressed objects mean the fork and parent already agree on ids for shared history — alternates just makes that sharing explicit at the storage layer.",
        tradeoff: "Garbage collection must be network-wide, which is more complex than per-repo GC and couples the fleet's health across forks of the same repo.",
        failure: "Per-repo GC that ignores the network can delete an object another fork still needs, corrupting that fork's history.",
        mitigation: "Reference-count objects across the whole network before any prune; support an explicit detach path for forks leaving the network.",
      },
    },
    {
      n: 5,
      title: "Pull requests: diffs that survive force-pushes, and the merge queue",
      body: [
        "A review comment is anchored to a specific line in a specific diff, but the branch it comments on keeps moving — force-pushes after a rebase, amended commits, squashes. A comment stored as a raw (commit_sha, line_number) pair breaks the moment history is rewritten. Store it as (original commit, file path, side, line, and the surrounding diff-hunk context) instead, and recompute its position against the new diff on every push.",
        "Merging is its own hard problem at scale: two PRs can each pass CI independently against `main`, yet conflict semantically once both land. A merge queue serializes merges — it creates a speculative merge commit of 'current queue head + this PR' and runs CI against that combination before actually merging, catching interaction bugs that per-PR CI can't see.",
      ],
      bullets: [
        { lead: "Anchor by context, not coordinates", text: "storing surrounding lines (the diff hunk) lets the platform relocate a comment even when the line number shifts after an unrelated edit earlier in the file." },
        { lead: "Outdated, not broken", text: "if the anchored context is gone entirely (that hunk was rewritten), the comment is marked outdated and collapsed, still visible on the original diff rather than pointing at the wrong line." },
        { lead: "Merge queue batches merges", text: "PRs are merged one at a time against a moving speculative head, so a batch of green PRs can't produce a broken `main` through semantic conflicts." },
        { lead: "Not-rocket-science rule", text: "the invariant the queue enforces: every commit that lands on `main` passed CI on exactly the tree it's about to become — not on a stale base." },
      ],
      pictureTitle: "Comment anchoring across a force-push",
      pictureRows: [
        { label: "Context still matches", value: "comment repositions to the new line", tone: "good" },
        { label: "Context rewritten/removed", value: "comment marked outdated, kept visible", tone: "neutral" },
        { label: "Raw line-number anchor", value: "silently points at the wrong line after rebase", tone: "bad" },
      ],
      remember: {
        problem: "Keep review comments correct across force-pushes, and keep `main` green even when independently-passing PRs interact badly.",
        solution: "Anchor comments to diff context (not coordinates) and reposition/outdate on every push; serialize merges through a merge queue with speculative CI.",
        why: "Coordinates drift the moment history is rewritten; a queue is the only way to test the actual resulting tree before it becomes `main`.",
        tradeoff: "The merge queue adds latency to merging (you wait for your slot and a fresh speculative CI run) in exchange for a `main` that never breaks from batched merges.",
        failure: "Coordinate-anchored comments silently point at the wrong line after a rebase; parallel merges without a queue can pass CI individually yet break `main` together.",
        mitigation: "Diff-hunk-based repositioning plus an explicit 'outdated' state; a queue that always tests against the true next `main`.",
      },
    },
    {
      n: 6,
      title: "Code search at repo-mutation scale",
      body: [
        "Indexing hundreds of millions of repos for full-text/code search only works if a push updates the index incrementally — re-indexing an entire repo on every commit would mean re-processing a meaningful fraction of the platform's total bytes every second. The index has to be keyed so that a push only touches the shards holding the blobs that actually changed.",
        "Two more properties keep this affordable: index the corpus by content-addressed blob, not by (repo, path) pair, so a file identical across thousands of repos (a license file, a lockfile) is tokenized and stored once and simply mapped to many locations; and shard the index by content hash so a single popular file's presence in many repos doesn't concentrate load on one shard.",
      ],
      bullets: [
        { lead: "Incremental on push", text: "the post-receive event carries the set of changed blob ids; only those blobs get re-tokenized and written into the index, not the whole repo." },
        { lead: "Dedup by blob id", text: "identical file content across repos is indexed once; search results map the single indexed document back to every (repo, path, ref) it appears in." },
        { lead: "Shard by content hash", text: "spreads any one popular file's index entries across shards instead of hot-spotting a single shard on a viral file." },
        { lead: "Freshness SLA, not latency", text: "target < 60s from push to searchable — a background property, never something a push waits on." },
      ],
      pictureTitle: "Why search doesn't re-index the world",
      pictureRows: [
        { label: "Full re-index per push", value: "cost scales with repo size, not change size — rejected", tone: "bad" },
        { label: "Incremental, blob-diffed", value: "cost scales with bytes actually changed", tone: "good" },
        { label: "Index keyed by (repo, path)", value: "duplicates identical content millions of times over", tone: "bad" },
        { label: "Index keyed by blob id", value: "identical content stored once, mapped to N locations", tone: "good" },
      ],
      remember: {
        problem: "Keep code search fresh across hundreds of millions of repos without re-indexing on every push.",
        solution: "Incremental indexing keyed off the changed-blob list from the push event; dedup the index by content-addressed blob id.",
        why: "A push only changes a handful of blobs; re-tokenizing only those, and storing identical content once, keeps indexing cost proportional to change size, not repo size.",
        tradeoff: "Mapping one indexed blob back to many (repo, path, ref) locations adds a layer of indirection the query path has to resolve.",
        failure: "Per-(repo, path) indexing of a widely-vendored file (a common lockfile format) multiplies index size and indexing cost by its occurrence count.",
        mitigation: "Content-addressed indexing plus a separate location-mapping table, sharded by content hash to avoid hot shards on popular files.",
      },
    },
    {
      n: 7,
      title: "Metadata: why Vitess and repo_id as the shard key",
      body: [
        "PRs, issues, comments, stars, and permissions are relational, high-cardinality, and need transactions (closing an issue and posting the closing comment must be atomic) — a fit for MySQL, not the object store. At platform scale, though, a single MySQL primary can't hold or serve 420M repos' worth of metadata, so the schema is sharded, with Vitess providing resharding and query routing without every application query knowing the physical shard map.",
        "The shard key is repo_id (with org-owned repos co-located by org where practical): almost every query — 'PRs on this repo', 'issues assigned in this repo' — scopes naturally to one repo or org, so cross-shard joins stay rare. A global search or a cross-org dashboard is the exception that needs a separate fan-out or a denormalized read model, not the common case the shard key is optimized for.",
      ],
      bullets: [
        { lead: "Why not one giant DB", text: "at 420M repos and their PRs/issues/comments, a single primary runs out of both storage and write throughput; sharding is not optional at this scale." },
        { lead: "Why repo_id, not user_id", text: "collaboration data (PRs, issues) is fundamentally repo-scoped, even when many users touch one repo — sharding by repo keeps that data together." },
        { lead: "Vitess as the routing layer", text: "vtgate routes queries to the right shard and lets shards be split or moved without every service knowing about it, which matters when one org's repo blows up in size." },
        { lead: "The exception: cross-shard queries", text: "a user's global notification feed spans many repos across many shards — that's fanned out or served from a denormalized index, not a live join." },
      ],
      pictureTitle: "Sharding metadata by repo_id",
      pictureRows: [
        { label: "PRs, issues, comments", value: "single-repo queries stay on one shard", tone: "good" },
        { label: "Vitess (vtgate)", value: "routes + reshards without app awareness", tone: "neutral" },
        { label: "Global notification feed", value: "cross-shard, needs a denormalized read model", tone: "used" },
      ],
      remember: {
        problem: "Serve relational, transactional metadata (PRs, issues, permissions) for 420M repos.",
        solution: "MySQL sharded by repo_id, fronted by Vitess for routing and resharding.",
        why: "Collaboration data is repo-scoped, so repo_id keeps almost all queries single-shard; Vitess hides the physical shard map from application code.",
        tradeoff: "Cross-repo queries (a user's global feed) can't be a live join anymore and need a separate fan-out or denormalized index.",
        failure: "Sharding by user_id instead would scatter a single repo's PRs/issues across many shards, making the common query the expensive one.",
        mitigation: "Shard by repo_id (co-locate by org where practical); build denormalized read models for the genuinely cross-shard views.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's Git's content-addressable object graph plus a metadata layer on top — commits/trees/blobs never change, so replication and caching are simple; PRs, issues, and users live in sharded MySQL.",
      "Forks don't duplicate storage: a fork's git directory points at its parent network's shared object pool via alternates, so only new commits cost bytes.",
      "Every repo is replicated 3x by Spokes with a Raft-elected leader taking writes, so a single storage-node failure never loses a push.",
      "PR comments are anchored to diff context, not raw line numbers, so they survive force-pushes and rebases — or get marked outdated instead of pointing at the wrong line.",
      "Webhooks, CI triggers, and search indexing all run off an async event bus after the push already returned, so a slow Action or search shard never adds latency to `git push`.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · CLONE/FETCH · 40K/S",
        summary:
          "A clone or fetch is routed to the repo's storage location, then served by any in-sync replica so read load never bottlenecks on a single leader.",
        steps: [
          { label: "Client", note: "git fetch / clone" },
          { label: "Git Front Door", note: "auth, protocol v2 negotiation" },
          { label: "Repo Router", note: "consistent hash(repo_id) → spoke" },
          { label: "Spokes replica", note: "any in-sync copy, git-upload-pack" },
          { label: "Packfile response", note: "streamed, delta-compressed" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · GIT PUSH · 2K/S SUSTAINED",
        summary:
          "A push is only ever accepted by the repo's Raft-elected leader, which fsyncs and replicates before acking, so a durable ack means quorum durability.",
        steps: [
          { label: "Client", note: "git push" },
          { label: "Git Front Door", note: "auth, pre-receive hooks, LFS/size check" },
          { label: "Repo Router", note: "routes to the leader for this repo" },
          { label: "Spokes leader", note: "fsync pack + ref update" },
          { label: "Quorum replicate", note: "ack at 2 of 3 replicas" },
          { label: "post-receive event", note: "emitted to Kafka, push already acked" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · WEBHOOKS, CI, SEARCH — NEVER BLOCKS A PUSH",
        summary:
          "The push has already returned to the client by the time this runs. Every downstream consumer reads the same event off Kafka and moves at its own pace.",
        steps: [
          { label: "Kafka", note: "post-receive / PR / issue events" },
          { label: "Webhook Dispatcher", note: "HMAC-signed, retried with backoff" },
          { label: "Actions Runners", note: "ephemeral VM/container picks up the job" },
          { label: "Blackbird Index", note: "re-tokenizes only the changed blobs, < 60s freshness" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "420M repositories, 100M developers",
          "Push: 2K/sec sustained, bursts on incident/CI storms",
          "Clone/fetch: 40K/sec sustained, CI-dominated",
          "Push server-side p99 < 1s (quorum ack); clone p99 < 2s warm",
          "Repo replication: RF=3, quorum=2, Raft-elected leader per repo",
          "Search freshness < 60s from push; webhook delivery p99 < 5s",
          "Fork network dedup ≥ 20:1 typical vs. naive copy-per-fork",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Spokes: repo-directory-level replication, not a generic distributed filesystem",
          "Fork network via info/alternates, not copy-on-fork",
          "Metadata sharded by repo_id via Vitess, not a single MySQL primary",
          "PR comments anchored by diff context, repositioned or marked outdated on push",
          "Merge queue with speculative CI, not direct per-PR merge to main",
          "Search index keyed by content-addressed blob id, updated incrementally off push events",
          "Webhooks/Actions/search all async off Kafka, never on the push's critical path",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "50,000-fork storage blow-up is the load-bearing motivation for the fork network",
          "Immutable, content-addressed objects are why replication, caching, and dedup are all simple",
          "Push is tier-1, webhooks/Actions/search are tier-3 — an explicit async SLA hierarchy",
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
      goal: "Get scale numbers and product scope on the board before drawing anything. Every later storage and replication decision should trace back to these.",
      why: "The interviewer is checking whether the design is driven by data or by vibes. GitHub has enough surface area (git storage, PRs, issues, search, CI) that scoping it explicitly is what keeps the next 35 minutes focused.",
      steps: [
        { kind: "ASK", text: '**"How many repos and developers?"** Land on "420M repos, 100M developers" and write it top-left.' },
        { kind: "ASK", text: '**"Is fork storage a concern, or can I assume naive copies are fine?"** Get them to confirm forks matter — this is the signature sub-problem, so surface it now, not mid-diagram.' },
        { kind: "SAY", text: 'Propose scope: In — "git push/pull", "forks", "pull requests + review", "issues", "code search", "webhooks/CI triggers". Out — "billing", "Pages hosting", "org SSO". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "SAY", text: 'Propose numbers yourself: **"2K pushes/sec sustained, 40K clone/fetch/sec"**, **"push p99 under 1s, clone p99 under 2s"**. Wait for a nod, then write them down.' },
        { kind: "WRITE", text: 'State the fork math out loud: **"50,000 forks × 40MB naive = 2TB for one codebase"** — this is the number that justifies the fork-network design later, plant it now.' },
      ],
      grading: "Numbers and scope on the board within 5 minutes, and the fork-storage constraint named early rather than discovered mid-design.",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Separate the two data worlds — the git object graph and the relational metadata — and justify why they're different stores.",
      why: "A candidate who reaches for one database for everything hasn't recognized that commits/blobs/trees are immutable content-addressed objects while PRs/issues are mutable relational rows with transactions. That split drives the whole storage architecture.",
      steps: [
        { kind: "WRITE", text: 'Write the two endpoint families: **"git push / git-receive-pack"**, **"git fetch / git-upload-pack"** (Smart HTTP + SSH), and **"REST/GraphQL: /repos/:id/pulls, /repos/:id/issues"**.' },
        { kind: "DRAW", text: 'Sketch the object model: **"blob (content)"**, **"tree (dir listing)"**, **"commit (tree + parents)"**, all content-addressed by SHA. Say: "identical content, identical id, across any repo on the platform" — this is what unlocks dedup later.' },
        { kind: "SAY", text: 'Contrast it with metadata: **"PR row: id, repo_id, base/head sha, state, merge_queue_position"**, **"issue row: id, repo_id, labels, assignees"** — relational, transactional, lives in MySQL, not the object store.' },
        { kind: "RULE OUT", text: 'Get ahead of "why not store everything in one database": "Git objects are immutable and huge in aggregate; forcing them through row-oriented MySQL with transactions you don\'t need would be slower and much more expensive than a replicated object store." Cross it off.' },
      ],
      grading: "Two clearly separated data models named up front, and the content-addressing property stated as the reason it matters, not just as trivia.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: read (clone/fetch), write (push, PR merge), async (webhooks/CI/search). Label arrows with numbers and consistency levels, not just box names.",
      why: "This is where the interviewer checks whether the SLA-tier thinking is real. Async work (webhooks, CI, search) must visibly hang off an event bus after the write already acked — not be drawn inline with the push.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write path**: Client → Git Front Door → Repo Router → Spokes leader (Raft) → quorum ack at 2/3. Label it **"2K/sec, p99 < 1s, quorum=2"**.' },
        { kind: "DRAW", text: 'Lay down the **read path** in parallel: Client → Git Front Door → Repo Router → any in-sync Spokes replica. Label it **"40K/sec, any replica, p99 < 2s"**.' },
        { kind: "DRAW", text: 'Add the **async lane** dropping off the Spokes leader: → Kafka → {Webhook Dispatcher, Actions Runners, Blackbird Index}, dashed, labeled **"push already acked, never blocks"**.' },
        { kind: "SAY", text: 'Narrate the tiers: "Push and clone are tier-1 and latency-critical. Webhooks, CI triggers, and search indexing are tier-3, async, and best-effort on delivery timing — they read the same event, at their own pace."' },
      ],
      grading: "Three visually separated lanes, numbers on the arrows, and an explicit statement that the async lane only starts after the write already acked.",
    },
    {
      n: 4,
      title: "Deep Dive: Object Storage, Replication, and Fork Networks",
      minutes: 8,
      goal: "Explain Spokes replication and the fork-network object pool as two connected mechanisms, not two separate factoids.",
      why: "This is the signature sub-problem for GitHub specifically. The interviewer wants durability (Spokes) and the fork-storage insight (alternates) both explained with the numbers that motivate them.",
      steps: [
        { kind: "SAY", text: 'Explain Spokes: "Each repo is replicated 3x across storage servers, a Raft-elected leader takes writes, quorum=2 for a durable ack, and reads can hit any in-sync replica." Draw the 3-replica box.' },
        { kind: "SAY", text: 'Bring back the fork math: "A repo forked 50,000 times would cost 2TB naively. Instead, a fork\'s git directory has an info/alternates pointer at the parent\'s object pool — the fork stores zero bytes for shared history, only its own new commits."' },
        { kind: "SAY", text: 'Address GC: "You can\'t prune a shared object until no fork in the network references it anymore — garbage collection has to be network-aware, not per-repo."' },
        { kind: "RULE OUT", text: '"Why not a generic distributed filesystem under Git?" → "Git assumes local-disk semantics for pack writes and ref updates; a network filesystem adds latency and risks pack corruption under concurrent access." Cross it off.' },
      ],
      grading: "Spokes explained with replica count and quorum, the fork-network mechanism (alternates) named specifically, and network-aware GC raised without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: PR Comments, Merge Queue, and Search",
      minutes: 7,
      goal: "Show how review comments survive a force-push, why a merge queue exists beyond per-PR CI, and how search stays fresh without re-indexing the world.",
      why: "These are the places a mid-level design goes hand-wavy: 'comments just work' and 'we index the repo.' The interviewer wants the actual mechanism — diff-context anchoring, speculative merge CI, and incremental blob-level indexing.",
      steps: [
        { kind: "SAY", text: 'Explain comment anchoring: "A comment stores the diff-hunk context around its line, not a raw line number. On every push, we recompute its position against the new diff — reposition if the context still matches, mark outdated if it doesn\'t."' },
        { kind: "SAY", text: 'Explain the merge queue: "Two PRs can each pass CI against main independently and still conflict semantically once both land. The queue runs CI against a speculative merge of \'queue head + this PR\' before actually merging, serializing merges so main never breaks from a batch."' },
        { kind: "SAY", text: 'Explain search: "The post-receive event carries the changed blob ids, so only those get re-tokenized — not the whole repo. The index is keyed by content-addressed blob id, so a file identical across thousands of repos is indexed once and mapped to many locations."' },
        { kind: "SAY", text: 'Volunteer the freshness SLA: "< 60s from push to searchable — a background property we monitor, never something a push waits on."' },
      ],
      grading: "Diff-context anchoring stated as the mechanism (not just 'we handle it'), the merge queue's speculative-CI purpose explained, and search described as incremental and blob-deduped.",
    },
    {
      n: 6,
      title: "Wrap: Bottlenecks, Tiers, and Close",
      minutes: 5,
      goal: "Name the SLA tiers explicitly, flag the biggest operational risk, and close with a one-sentence summary plus a parked-items list.",
      why: "Staff-level signal here is treating the SLA hierarchy as the thing that justifies every trade-off made earlier, plus naming risk (a hot repo, a viral fork) before being asked, then closing cleanly.",
      steps: [
        { kind: "SAY", text: 'State the tiers: "Push and clone are tier-1. PR/issue metadata writes are tier-2. Webhooks, Actions triggers, and search are tier-3 — that hierarchy is why the async lane can never block a push."' },
        { kind: "SAY", text: 'Name the hot-repo risk unprompted: "A single mega-popular repo\'s pushes are capped by one Raft leader\'s disk throughput, since only the leader writes. We\'d watch for that and could shard a single huge repo\'s refs if it ever became the bottleneck."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need full-history clone by default, or is partial/shallow clone the common case? That changes how much of Spokes\' bandwidth budget clone traffic actually needs."' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a content-addressed object store with quorum-replicated repos, fork networks for storage sharing, diff-anchored PR review, and an async lane for webhooks/CI/search. With more time I\'d cover LFS, org SSO, and Actions runner isolation."' },
      ],
      grading: "Explicit SLA tiers used to justify trade-offs, a named operational risk beyond the obvious, at least one pushback on requirements, and a crisp close with parked items.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design with the right high-level boxes, but storage cost and consistency stay hand-wavy.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, git storage, a database for PRs/issues, a search index.",
          "Knows Git objects are content-addressed and can explain blob/tree/commit at a basic level.",
          "Adds a cache or CDN in front of common reads without being asked.",
          "Handles 'what about CI' by adding a queue and workers.",
          "Can sketch a rough PR/issue schema.",
        ],
        gaps: [
          "Doesn't compute the fork-storage blow-up (50,000 × 40MB), so the fork network reads as an arbitrary feature rather than a forced design.",
          "Proposes copying a repo's full object graph on fork, or doesn't address fork storage at all until prompted.",
          "Replication is 'store it in S3 three times' with no leader/quorum story for writes.",
          "PR comments are 'store the line number' with no mention of what happens on a force-push.",
          "Search is 'index the repo' with no incremental story — implies full re-index on every push.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, names the fork-storage constraint early, and gives each subsystem a real mechanism, not just a label.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "States the fork-storage math (50,000 × 40MB = 2TB) unprompted and uses it to motivate the fork network.",
          "Explains Spokes-style replication with a leader and quorum, not just 'replicate 3x'.",
          "Describes info/alternates (or an equivalent shared-pool mechanism) as the fork storage answer.",
          "Anchors PR comments to diff context, not raw line numbers, and explains the outdated-comment case.",
          "Shards metadata by repo_id and explains why that's the natural key.",
          "Draws three separated lanes (read/write/async) with numbers on the arrows.",
          "Describes search indexing as incremental off the push event, not a full re-index.",
        ],
        gaps: [
          "Doesn't raise network-aware garbage collection for the fork pool until asked.",
          "Explains the merge queue's existence but not why per-PR CI alone is insufficient (semantic conflicts between independently-green PRs).",
          "Names the async SLA tier but doesn't use it to justify why webhooks are allowed to be best-effort.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, connects every mechanism back to the two or three numbers that actually force it, and surfaces operational risk unprompted.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Treats the fork-storage math as the load-bearing constraint of the whole storage design, not a side fact — and ties GC coordination back to it without being asked.",
          "Explains why the merge queue exists beyond 'CI passes': two independently-green PRs can still semantically conflict, so the queue tests the true resulting tree.",
          "Names the single-leader-per-repo write bottleneck as an operational risk for mega-popular repos, with a mitigation direction (ref sharding) rather than just flagging it.",
          "Explicitly separates the two data worlds (immutable content-addressed objects vs. mutable relational metadata) and derives the storage choice for each from its properties.",
          "Uses the tier-1/2/3 SLA hierarchy to justify every async design choice, not just to describe the diagram.",
          "Pushes back on requirements ('do we need full clone by default, or is shallow/partial the common case?').",
          "Closes with a one-sentence summary and an explicit parked-items list, pacing the 40 minutes like a collaborator.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Proposing a full object-graph copy on fork without computing the storage blow-up at real fork counts (a popular repo can be forked 50,000+ times).",
      "Treating git storage as generic blob storage on a distributed filesystem, missing that Git assumes local-disk semantics for pack writes and ref updates.",
      "Anchoring PR comments to a raw (commit, line_number) pair with no story for what happens after a force-push or rebase.",
      "Merging PRs directly to main with no merge queue, missing that two independently-green PRs can still conflict semantically once both land.",
      "Full re-index on every push for search, instead of an incremental update scoped to the changed blobs.",
      "Putting webhook delivery or CI triggering on the push's critical path, so a slow webhook consumer or Actions queue adds latency to `git push`.",
      "No consistency story for garbage collection in a shared fork-network object pool, risking deletion of an object another fork still references.",
    ],
    followUps: [
      {
        q: "How does GitHub avoid duplicating storage for forks in practice?",
        a: "A fork's git directory gets an info/alternates pointer at the parent network's shared object pool at fork time, copying zero bytes. Object lookups on the fork fall through to the shared pool for anything it doesn't have locally. Only commits unique to the fork land in the fork's own pack files, so storage cost scales with how much the fork has diverged, not with the size of the shared history.",
      },
      {
        q: "What happens if the Raft leader for a repo's spoke fails mid-push?",
        a: "The in-flight push fails and the client retries (git's smart protocol is designed to be safely retried — a failed push doesn't leave a repo in a half-written state because the ref update is the last, atomic step). Raft runs a new leader election among the remaining replicas, typically completing within seconds, and the repo router starts directing writes to the new leader. Because writes require quorum=2 before acking, any push that was actually acknowledged to the client is already durable on at least one surviving replica.",
      },
      {
        q: "Why not just anchor PR comments to a line number and re-map with a diff algorithm on read, instead of storing hunk context?",
        a: "You could compute the mapping lazily at read time by diffing the original commit against the current head, but storing the diff-hunk context at comment-creation time makes the outdated-vs-repositioned decision cheap and deterministic — you're matching stored context against the current file rather than re-deriving intent from a multi-commit diff chain on every read. It also gives you a stable 'what did the reviewer actually see' record even after the branch is deleted.",
      },
      {
        q: "How does the fork network handle garbage collection safely?",
        a: "GC on the shared object pool has to be network-aware: an object can only be pruned once no repo in the fork network (parent or any fork) references it, whether through a ref, a reflog entry, or an open PR. In practice this means GC either walks reachability across the whole network before pruning, or maintains a reference count per shared object that's updated as forks are created, push new commits, or are deleted/detached.",
      },
      {
        q: "Why is code search indexed by blob id instead of by (repo, path)?",
        a: "Enormous amounts of content are byte-identical across repos — license files, lockfiles, vendored dependencies, forked codebases that haven't diverged. Indexing by (repo, path) would tokenize and store that content once per occurrence, multiplying index size by however many times it appears platform-wide. Indexing by content-addressed blob id stores it once and maps it to every (repo, path, ref) it appears in, which is both smaller and means a push to one repo doesn't need to re-index content it shares with a thousand other repos.",
      },
      {
        q: "Why does the merge queue need to run CI again if every PR already passed CI individually?",
        a: "Individual CI runs a PR's branch against the current main at the time it was tested — but by the time it's actually merged, other PRs may have landed first, and even a purely additive change can semantically conflict with another purely additive change (two PRs each adding a route with the same path, two migrations that both assume they're first). The merge queue tests the actual tree that will exist after this merge, against the current queue head, catching exactly that class of bug that per-PR CI structurally cannot see.",
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
          "GitHub is two systems bolted together: a replicated, content-addressed object store for Git's own data (commits, trees, blobs), and a sharded relational layer for everything collaborative on top of it (PRs, issues, comments, permissions). Almost every hard design decision falls out of treating those as genuinely different problems rather than forcing them into one store.",
          "Anchor everything on a few numbers: 420M repos, 100M developers, 2K pushes/sec sustained, 40K clone/fetch/sec, and the fork-storage constraint — a popular repo forked 50,000 times would cost 2TB if forks copied their parent's objects. That last number is what makes this problem GitHub-specific rather than generic-Git-hosting.",
        ],
      },
      {
        heading: "Git's object model as the storage foundation",
        body: [
          "Blobs, trees, and commits are all content-addressed and immutable: an object's id is the hash of its own bytes, and a commit's hash transitively covers its entire tree and history, forming a Merkle DAG. Immutability means replication can be append-only and caching can never serve something stale. Content addressing means identical content — the same file across two unrelated repos, or a file unchanged between a fork and its parent — is literally the same object, which is the property the fork network and the search index both exploit.",
          "Packfiles compress and delta-encode related objects for efficient transfer, which is why clone/fetch payloads stay small even as a repo's full history grows large.",
        ],
      },
      {
        heading: "Spokes: replicating repos without a distributed filesystem",
        body: [
          "Git assumes local-disk semantics for its writes, so instead of running it on a generic network filesystem, each repo's git directory is replicated as a unit across 3 storage servers ('a spoke'), with a Raft-elected leader taking all writes for that repo. A push fsyncs on the leader, replicates to followers, and acks once 2 of 3 copies are durable — a client-visible ack always implies quorum durability. Reads can be served by any in-sync replica, decoupling read throughput from the single write leader.",
          "A background reconciler checksums refs and packs across replicas to catch and repair silent drift, and leader failure triggers a Raft election that typically restores write availability for that repo within seconds.",
        ],
      },
      {
        heading: "Fork networks: storage sharing without copying",
        body: [
          "A fork's git directory is created with an info/alternates pointer at its parent network's shared object pool, so object lookups fall through to shared history with zero bytes copied at fork time. New commits pushed to the fork live in the fork's own pack files; the shared pool is read-only from a fork's perspective until those commits are merged or pulled upstream.",
          "The cost of this sharing is that garbage collection becomes network-aware: an object can't be pruned from the shared pool while any fork in the network — parent or child — still references it, whether via a ref, reflog, or open PR. A fork leaving the network (say, its parent repo is deleted) needs an explicit detach step that copies out the objects it actually uses.",
        ],
      },
      {
        heading: "Pull requests: diff-anchored comments and the merge queue",
        body: [
          "Review comments are anchored to the diff-hunk context around a line, not a raw (commit, line_number) pair, so that a force-push or rebase can reposition the comment by re-matching context rather than breaking outright. When the context is gone entirely, the comment is marked outdated and kept visible on its original diff instead of silently pointing at the wrong line.",
          "Merging is serialized through a merge queue: because two independently-green PRs can still conflict semantically once both land, the queue builds a speculative merge of 'current queue head + this PR' and runs CI against that exact resulting tree before actually merging — enforcing that every commit on main passed CI on the tree it's about to become, not a stale base.",
        ],
      },
      {
        heading: "Search, webhooks, and Actions: async without blocking a push",
        body: [
          "Push is tier-1 and latency-critical; webhook delivery, CI triggering, and search indexing are all tier-3 and run off a Kafka event emitted after the push already acked — a slow webhook consumer or a backed-up Actions queue never adds latency to `git push`. Webhooks are HMAC-signed and retried with backoff; Actions jobs are picked up by ephemeral runners; search re-tokenizes only the blobs the post-receive event says actually changed.",
          "The search index itself is keyed by content-addressed blob id rather than (repo, path), so identical content shared across many repos — license files, lockfiles, vendored code — is tokenized once and mapped to every location it appears in, keeping both index size and per-push indexing cost proportional to what actually changed rather than to the platform's total size.",
        ],
      },
    ],
  },
};
