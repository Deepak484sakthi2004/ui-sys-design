import type { Problem } from "@/lib/types";

export const distributedCache: Problem = {
  slug: "distributed-cache",
  num: "3.2",
  title: "Design a Distributed Cache",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a distributed, in-memory caching layer that sits in front of a primary database, holding a ~5TB / 500M-key working set across roughly 100 shards, serving 5M reads/sec and 200K writes/sec at sub-millisecond p99, while surviving individual node failures and cluster resizing without a client-visible blip.",
  ],
  hardParts:
    "The hard parts: routing keys to the right shard as nodes join and leave without a rebalancing storm or a hot spot, absorbing a single key that outgrows one node's ops budget, and choosing a write and invalidation policy that keeps the cache honest without turning every write into a synchronous round trip to the database.",
  keyTopics: [
    "Consistent Hashing with Virtual Nodes",
    "Cache-Aside + Delete-on-Write",
    "Hot-Key Splitting",
    "Approximate LRU Eviction",
    "Primary-Replica Failover",
  ],
  foundationsReferenced: [
    { label: "Consistent Hashing", tone: "green" },
    { label: "Gossip Protocol", tone: "blue" },
    { label: "Redis / Valkey", tone: "purple" },
    { label: "Raft / etcd", tone: "orange" },
    { label: "CAP Theorem", tone: "blue" },
    { label: "LRU / LFU Eviction", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "App Service", col: 1, row: 1, tone: "slate" },
      { id: "localcache", label: "In-Process Cache", sub: "~15% hit · 1-5s TTL", col: 1, row: 2, tone: "green" },
      {
        id: "hashring",
        label: "Client Hash Ring",
        mono: "consistent hash · 200 vnodes/node",
        col: 2,
        row: 1,
        tone: "slate",
      },
      { id: "etcd", label: "etcd Coordinator", sub: "cluster map · Raft", col: 4, row: 1, tone: "blue" },
      { id: "shardA", label: "Cache Shard A", sub: "primary · ~50K ops/s", col: 2, row: 2, tone: "green" },
      { id: "shardB", label: "Cache Shard B", sub: "primary", col: 3, row: 2, tone: "green" },
      { id: "shardC", label: "Cache Shard C", sub: "primary", col: 4, row: 2, tone: "green" },
      { id: "db", label: "Source-of-Truth DB", col: 5, row: 2, tone: "blue" },
      { id: "replicaA", label: "Replica A", col: 2, row: 3, tone: "purple" },
      { id: "replicaB", label: "Replica B", col: 3, row: 3, tone: "purple" },
      { id: "replicaC", label: "Replica C", col: 4, row: 3, tone: "purple" },
    ],
    edges: [
      { from: "client", to: "localcache", label: "GET", kind: "read" },
      { from: "localcache", to: "hashring", label: "miss ~85%", kind: "read" },
      { from: "hashring", to: "shardA", label: "hash(key)", kind: "read" },
      { from: "hashring", to: "shardB", label: "hash(key)", kind: "read" },
      { from: "hashring", to: "shardC", label: "hash(key)", kind: "read" },
      { from: "shardA", to: "db", label: "miss → cache-aside fetch", kind: "read" },
      { from: "client", to: "hashring", label: "SET / DELETE", kind: "write" },
      { from: "hashring", to: "shardA", label: "route to primary", kind: "write" },
      { from: "shardA", to: "db", label: "delete-on-write invalidation", kind: "write" },
      { from: "shardA", to: "replicaA", label: "async replicate", kind: "analytics" },
      { from: "etcd", to: "hashring", label: "cluster map push", kind: "analytics" },
      { from: "etcd", to: "shardB", label: "gossip heartbeat / failover", kind: "analytics" },
      { from: "shardB", to: "replicaB", label: "async replicate", kind: "analytics" },
      { from: "shardC", to: "replicaC", label: "async replicate", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · 5M gets/sec" },
      { kind: "write", text: "write path · 200K sets/sec" },
      { kind: "analytics", text: "background · replication, gossip, rebalancing" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "GET(key): return the cached value or a miss signal", tag: "P0" },
      { id: "FR-02", text: "SET(key, value, ttl?): write or overwrite a value with an optional TTL", tag: "P0" },
      { id: "FR-03", text: "DELETE(key): explicit invalidation", tag: "P0" },
      { id: "FR-04", text: "Automatic eviction under memory pressure via a configurable LRU/LFU policy", tag: "P0" },
      { id: "FR-05", text: "Client-side routing via consistent hashing, no central proxy on the hot path", tag: "P0" },
      { id: "FR-06", text: "Cluster resize (add/remove a shard) rebalances keys with bounded data movement", tag: "P0" },
      { id: "FR-07", text: "Per-shard replication for read scaling and failover", tag: "P0" },
      { id: "FR-08", text: "Hot-key detection and mitigation so one key cannot saturate one shard", tag: "P1" },
      { id: "FR-09", text: "MGET / pipelining: batched multi-key reads to cut round trips", tag: "P1" },
      { id: "FR-10", text: "TTL-based expiration, both lazy (on-access) and active (background sweep)", tag: "P1" },
      { id: "FR-11", text: "Cluster observability: per-shard hit rate, memory, eviction rate", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "GET latency, server-side", tag: "p99 < 1ms" },
      { id: "NFR-02", text: "SET latency, server-side", tag: "p99 < 2ms" },
      { id: "NFR-03", text: "Sustained read throughput", tag: "5M/sec" },
      { id: "NFR-04", text: "Sustained write throughput", tag: "200K/sec" },
      { id: "NFR-05", text: "Availability (about 52 min downtime per year)", tag: "99.99%" },
      { id: "NFR-06", text: "Data movement on a single node add/remove", tag: "~1/N shards" },
      { id: "NFR-07", text: "Cache hit rate on steady-state workload", tag: "≥ 95%" },
      { id: "NFR-08", text: "Failure detection plus replica promotion", tag: "< 10s" },
      { id: "NFR-09", text: "Max safe memory utilization before eviction storms", tag: "~80%" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: how many shards, really?",
      body: [
        "Before drawing boxes, size the cluster. The working set is ~500M keys at roughly 10KB average value size, which is 5TB of live data. A single node can safely hold about 50GB of usable memory once you subtract space for the OS, connection buffers, and eviction headroom, so 5TB divided by 50GB is about 100 shards. That number, not a guess, is what drives every downstream decision: ring size, replica count, node count.",
      ],
      bullets: [
        { lead: "Value size drives shard count", text: "10KB average x 500M keys = 5TB; a bigger average value size, say 100KB, would mean 10x fewer keys fit per node and 10x more shards for the same data." },
        { lead: "Headroom, not capacity", text: "sizing a node at 100% of its RAM is the fastest way to trigger eviction storms; running at ~80% utilization leaves room for value-size variance and traffic spikes." },
        { lead: "100 primary shards", text: "at 5M reads/sec that is ~50K reads/sec per shard, comfortably inside a single-threaded in-memory store's ~100K-1M ops/sec ceiling, with headroom for uneven key distribution." },
        { lead: "x2 for replicas", text: "one replica per shard for failover and read scaling doubles the node count to ~200, not the shard count; replicas hold the same 100 partitions of the keyspace." },
      ],
      pictureTitle: "Sizing the cluster from the numbers",
      pictureRows: [
        { label: "500M keys x 10KB avg", value: "≈ 5TB working set", tone: "neutral" },
        { label: "50GB usable per node (80% cap)", value: "≈ 100 primary shards", tone: "good" },
        { label: "5M reads/sec / 100 shards", value: "≈ 50K reads/sec/shard, inside budget", tone: "good" },
        { label: "Replication x2", value: "≈ 200 total nodes", tone: "neutral" },
      ],
      remember: {
        problem: "How big is this cluster, really?",
        solution: "5TB / 50GB-per-node ≈ 100 primary shards; x2 for replicas ≈ 200 nodes.",
        why: "Every later number, ops per shard, ring size, rebalance blast radius, is a consequence of the shard count, not a separate guess.",
        tradeoff: "Running nodes at 80% memory instead of 100% costs ~20% more hardware but avoids eviction storms under normal traffic variance.",
        failure: "Size at 100% capacity and a modest traffic bump triggers cascading eviction and a rising miss rate exactly when you need the cache most.",
        mitigation: "Cap usable memory at ~80%, alert well before that, and add shards before you are forced to.",
      },
    },
    {
      n: 2,
      title: "Consistent hashing: kill mod-N, defend the ring plus virtual nodes",
      body: [
        "The naive answer, shard = hash(key) mod N, works until N changes. Add or remove one node and mod N reassigns almost every key to a different shard, so a 101-node cluster misses on nearly 100% of its previously warm cache, a self-inflicted overload of the database behind it. Consistent hashing fixes the blast radius; virtual nodes fix the load skew that plain consistent hashing leaves behind.",
      ],
      bullets: [
        { lead: "mod-N hashing", text: "one node added and ~99% of keys map to a new shard. Rejected outright for anything you plan to resize." },
        { lead: "Plain consistent hashing", text: "place each node at one random point on a hash ring; a key belongs to the next node clockwise. Removing one node only moves that node's keys, ~1/N of the keyspace, but with only 100 random points some arcs are 3x the average size, so load is uneven." },
        { lead: "Virtual nodes (the fix)", text: "give each physical node ~200 points on the ring, 20,000 total. The law of large numbers smooths the arc sizes, so every physical node ends up with close to its fair 1/N share, and losing one node spreads its ~1% of keys across dozens of survivors instead of dumping it all on one neighbor." },
        { lead: "Client-side ring", text: "the hash ring lives in a client library, not a central proxy, so routing is one hash lookup with no extra network hop; the ring stays in sync via the coordinator's cluster map." },
      ],
      pictureTitle: "Data movement on a single node change",
      pictureRows: [
        { label: "mod-N hashing", value: "~99% of keys reassigned → reject", tone: "bad" },
        { label: "Consistent hashing, 1 point/node", value: "~1% moves, but uneven load per node", tone: "neutral" },
        { label: "Consistent hashing + 200 vnodes/node", value: "~1% moves, evenly spread → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Resize the cluster without a cache-wide miss storm.",
        solution: "Consistent hashing ring with ~200 virtual nodes per physical node, client-side routing.",
        why: "A ring bounds data movement to ~1/N of the keyspace per node change; virtual nodes bound the load imbalance that a small number of ring points would otherwise create.",
        tradeoff: "More ring metadata (20K points vs. 100) and a slightly heavier client-side lookup, in exchange for predictable, bounded rebalancing.",
        failure: "mod-N hashing reshuffles almost the entire keyspace on any resize, turning a routine scale-out into a database-melting stampede.",
        mitigation: "Ring plus virtual nodes, with a coordinator-pushed cluster map so every client agrees on ownership during the transition.",
      },
    },
    {
      n: 3,
      title: "Write policy: cache-aside, and delete not set",
      body: [
        "There are four textbook write strategies, and they trade off write latency, staleness risk, and durability differently. For a cache sitting in front of a system-of-record database, the right default is cache-aside on reads with delete-on-write for invalidation, not update-on-write, which has a specific, real race condition.",
      ],
      bullets: [
        { lead: "Write-through", text: "every write goes to the cache and the DB synchronously. Simple and always consistent, but write latency becomes DB latency plus cache latency, no savings on the write path at all." },
        { lead: "Write-back (write-behind)", text: "write to cache immediately, flush to DB asynchronously. Fastest writes, but if the cache node dies before the flush, that write is gone, durability now depends on the cache, which defeats having a database of record." },
        { lead: "Write-around", text: "writes go straight to the DB, bypassing the cache entirely; the cache fills in on the next read. Good for write-heavy, rarely-read data, but the first read after a write is always a guaranteed miss." },
        { lead: "Cache-aside + delete-on-write (the pick)", text: "the app reads the DB and populates the cache on a miss; on a write, the app writes the DB and deletes the cache key rather than setting it. Deleting instead of setting avoids the classic race where a slow writer's stale SET lands in cache after a faster, newer write." },
      ],
      pictureTitle: "Four write policies, one default",
      pictureRows: [
        { label: "Write-through", value: "consistent, but write pays full DB latency", tone: "neutral" },
        { label: "Write-back", value: "fastest writes, but cache-node death loses data", tone: "bad" },
        { label: "Write-around", value: "good for cold data, guaranteed miss on first read", tone: "neutral" },
        { label: "Cache-aside + delete-on-write", value: "DB stays source of truth → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Keep the cache honest without making every write pay full DB-plus-cache latency.",
        solution: "Cache-aside: app populates cache on read miss; on write, delete the cache key instead of setting it.",
        why: "Delete-on-write closes the read-modify-write race where a slow writer's stale SET overwrites a newer value; a DELETE just forces the next read to refetch from the DB.",
        tradeoff: "The next read after any write is a guaranteed miss, you trade a little more DB read load for correctness.",
        failure: "Update-on-write under concurrent writers can leave a permanently stale value in cache until its TTL expires, silently wrong data with no error signal.",
        mitigation: "Always DELETE on write, never SET from the write path; pair with a short backstop TTL so any missed invalidation self-heals.",
      },
    },
    {
      n: 4,
      title: "Eviction: exact LRU, random, or approximate?",
      body: [
        "Memory is finite, so something has to leave when the cache is full. True LRU needs a doubly linked list touched on every access, which is memory overhead and a contention point at 5M reads/sec. Approximate LRU, the pragmatic middle ground used by Redis, is worth naming and defending.",
      ],
      bullets: [
        { lead: "True LRU", text: "exact recency order via a linked list updated on every access. Correct, but the write-on-every-read pattern does not scale to millions of ops/sec without heavy contention." },
        { lead: "Random eviction", text: "zero bookkeeping cost, but evicts hot keys as readily as cold ones, hit rate suffers badly under a Zipf-like access pattern." },
        { lead: "Approximate LRU (sampling)", text: "track a rough last-access timestamp per key; on eviction, sample N random keys (5 by default, tune up to ~10) and evict the oldest of the sample. No linked list, O(1) bookkeeping, and with N=10 the eviction order is statistically close to true LRU." },
        { lead: "LFU option", text: "when repeat-access frequency matters more than recency, track access counts with a decaying probabilistic counter instead of last-access time, so a config value read every second isn't evicted as readily as a session read once." },
      ],
      pictureTitle: "Eviction: exact vs. cheap vs. good enough",
      pictureRows: [
        { label: "True LRU (linked list)", value: "exact, but contention at 5M ops/sec", tone: "bad" },
        { label: "Random eviction", value: "O(1), but evicts hot keys too", tone: "bad" },
        { label: "Approximate LRU, sample 5-10", value: "O(1), statistically close → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Evict something when memory is full, at 5M ops/sec, without heavy bookkeeping.",
        solution: "Approximate LRU: sample 5-10 random keys per eviction, drop the oldest of the sample.",
        why: "Skips the doubly linked list touch on every read; sampling converges close to true LRU order at a fraction of the cost.",
        tradeoff: "Not exact — a genuinely cold key can occasionally survive a sweep it should have lost, and vice versa.",
        failure: "True LRU's per-read list maintenance becomes a contention hotspot long before 5M ops/sec, adding tail latency to every GET.",
        mitigation: "Sample size is tunable; raise it, more CPU, closer to true LRU, if measured hit rate lags the approximation's expected loss.",
      },
    },
    {
      n: 5,
      title: "Hot keys: one key, one shard, 500K req/sec",
      body: [
        "Sharding assumes access is roughly uniform across keys, and it usually isn't. A single viral key, a trending post, a flash-sale product, can pull 500K req/sec against one shard whose realistic ceiling is more like 100K-200K ops/sec once you account for network and per-connection overhead. That one key can take down the shard, and because consistent hashing pins it to exactly one node, scaling the cluster out doesn't help at all.",
      ],
      bullets: [
        { lead: "Detect it", text: "sample a percentage of requests, or use a lightweight count-min sketch, per shard to flag keys crossing a per-shard QPS threshold in near-real time." },
        { lead: "Client-side local cache", text: "an in-process cache with a short TTL (1-5s) in front of the distributed cache absorbs the bulk of repeat reads to the same hot key without a network hop at all, the first and cheapest line of defense." },
        { lead: "Key splitting", text: "for keys still too hot after local caching, suffix the key (key#0 .. key#9) so it lands on 10 different shards via the ring, and have readers pick a random suffix. Writes either fan out to all 10 or go through one canonical copy with async propagation." },
        { lead: "What doesn't work", text: "adding more shards doesn't help, consistent hashing keeps that one key on one shard no matter how many nodes exist. This is the one place where the sharding strategy itself needs a targeted exception." },
      ],
      pictureTitle: "One key, 500K req/sec, one shard",
      pictureRows: [
        { label: "More shards (the instinct)", value: "key still pinned to one shard → doesn't help", tone: "bad" },
        { label: "Local in-process cache (1-5s TTL)", value: "absorbs most repeat reads, zero hops", tone: "good" },
        { label: "Key splitting (key#0..key#9)", value: "spreads remaining load across 10 shards", tone: "good" },
      ],
      remember: {
        problem: "A single key exceeds one shard's throughput ceiling.",
        solution: "Absorb with a short-TTL local cache first; if still hot, split the key across N shards with suffixed copies.",
        why: "Consistent hashing pins a key to one shard by design, scaling shard count doesn't redistribute one key's load, so the fix has to be targeted.",
        tradeoff: "Key splitting adds write-side complexity (fan-out or async propagation to N copies) and a small staleness window across copies.",
        failure: "No mitigation means one viral key can take an entire shard down, and everything else co-located on that shard goes down with it.",
        mitigation: "Detect via per-shard hot-key sampling; escalate from local-cache absorption to key-splitting only for keys that need it.",
      },
    },
    {
      n: 6,
      title: "Replication and failover: async, gossip, and a coordinator",
      body: [
        "Every shard is a single point of failure without a copy. Replicate asynchronously, the primary acks the write once it's applied locally and streams the change to replicas in the background, because waiting for a cross-node ack on every SET would double write latency for a system whose whole value proposition is speed. The tradeoff is a small window of possible data loss on primary failure, acceptable because the cache is not the system of record.",
      ],
      bullets: [
        { lead: "Async replication", text: "primary applies the write, acks the client, then streams to replicas. Write latency stays local; the cost is that the last few milliseconds of writes can be lost if the primary crashes before streaming them." },
        { lead: "Failure detection", text: "nodes gossip liveness with each other, similar to Redis Cluster's cluster bus; when a quorum of peers mark a primary unreachable, it's declared failed rather than trusting a single observer's view, avoiding a false failover from one node's network blip." },
        { lead: "Promotion", text: "the coordinator (etcd, Raft-backed) picks the most caught-up replica and promotes it to primary, then pushes the updated cluster map so clients re-route; target under 10 seconds end to end." },
        { lead: "Split-brain guard", text: "only the coordinator's Raft-elected view can promote a replica, two nodes independently deciding they're both primary would corrupt the shard's data." },
      ],
      pictureTitle: "Primary dies: what happens in the next 10 seconds",
      pictureRows: [
        { label: "Async write stream to replica", value: "normal operation, no write-latency cost", tone: "good" },
        { label: "Gossip quorum detects failure", value: "avoids false failover from one flaky observer", tone: "neutral" },
        { label: "Coordinator promotes best replica", value: "clients re-route via updated cluster map", tone: "good" },
        { label: "Writes in flight at crash", value: "small window of possible loss, acceptable for a cache", tone: "bad" },
      ],
      remember: {
        problem: "Survive a shard-primary crash without doubling every write's latency.",
        solution: "Async primary-replica replication; gossip-based quorum failure detection; coordinator-driven promotion.",
        why: "Sync replication would add a cross-node round trip to every write; async keeps writes local and accepts a small loss window instead.",
        tradeoff: "A crash can lose the last few milliseconds of unreplicated writes, fine for a cache backed by a database of record, not fine for a system of record.",
        failure: "A single observer declaring a primary dead on a transient network blip triggers an unnecessary failover and a burst of cache misses.",
        mitigation: "Require a gossip quorum before declaring failure, and route all promotion decisions through one Raft-backed coordinator to prevent split-brain.",
      },
    },
    {
      n: 7,
      title: "Cache stampede: when everyone misses at once",
      body: [
        "Even a well-run cache has a moment where many concurrent requests miss on the exact same key at once, usually right after a hot key's TTL expires. Without protection, every one of those requests falls through to the database simultaneously, the same self-inflicted overload problem as a bad rebalance, just triggered by expiry instead of topology change.",
      ],
      bullets: [
        { lead: "The failure mode", text: "a hot key with, say, 10K concurrent readers expires. All 10K miss in the same instant and all 10K hit the database at once, a thundering herd that can take the DB down even though the cache is otherwise healthy." },
        { lead: "Request coalescing (single-flight)", text: "the first request to miss takes a per-key lock and fetches from the DB; the other 9,999 wait on that in-flight fetch and share its result instead of each issuing their own DB query." },
        { lead: "Jittered TTL", text: "instead of a flat 60s TTL, use 60s ± random(0,10s) so keys that were set around the same time don't all expire in the same instant." },
        { lead: "Probabilistic early expiration", text: "as a key approaches its TTL, each read has a small and increasing chance of proactively refreshing it early, so refreshes spread out over time instead of bunching at the exact expiry moment." },
      ],
      pictureTitle: "10K concurrent readers, one key expires",
      pictureRows: [
        { label: "No protection", value: "10K simultaneous DB queries → stampede", tone: "bad" },
        { label: "Request coalescing", value: "1 DB query, 9,999 wait on it", tone: "good" },
        { label: "Jittered TTL + early refresh", value: "expiries spread out, stampede rarely forms", tone: "good" },
      ],
      remember: {
        problem: "Many concurrent readers miss the same key at the same instant.",
        solution: "Single-flight request coalescing per key, plus jittered TTLs and probabilistic early refresh.",
        why: "Coalescing turns N simultaneous DB queries into 1; jitter and early refresh prevent the mass-simultaneous-expiry that triggers the herd in the first place.",
        tradeoff: "Coalescing adds a per-key lock-or-wait mechanism in the client or a proxy layer; jitter means giving up an exact TTL value.",
        failure: "A hot key's synchronized expiry across many readers can spike DB load hard enough to cause an outage, even though nothing about the cache itself failed.",
        mitigation: "Combine both: jitter reduces how often a stampede can even form, coalescing caps the damage on the rare occasion it does.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's an in-memory key-value layer sharded across ~100 nodes with consistent hashing, sitting in front of a database of record — the cache can lose data, the DB never should.",
      "Clients route directly to the right shard via a hash ring with virtual nodes, so adding or removing a node only moves ~1/N of the keyspace, evenly.",
      "Writes go cache-aside: the app writes the DB then deletes the cache key, never sets it, to close the stale-write race.",
      "A single hot key gets absorbed by a short-TTL local cache first, then split across N shards if it's still too hot; more shards alone never fixes it.",
      "Replication is async for speed, failure detection is gossip-quorum-based to avoid false failovers, and stampede protection (coalescing plus jitter) keeps an expiring hot key from taking down the DB.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 5M/S · SUB-1MS P99",
        summary:
          "A GET checks the local in-process cache first, then routes through the hash ring to the owning shard. Only a full miss reaches the database.",
        steps: [
          { label: "Client", note: "app service issues GET(key)" },
          { label: "In-process cache", note: "~15% hit, 1-5s TTL" },
          { label: "Hash ring (client lib)", note: "hash(key) → shard, ~200 vnodes/node" },
          { label: "Cache shard", note: "primary or replica, sub-ms in-memory lookup" },
          { label: "DB", note: "on full miss, app fetches and populates cache" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · 200K/S",
        summary:
          "A write updates the database first, then deletes the cache key rather than setting it, so the next read repopulates from the source of truth.",
        steps: [
          { label: "Client", note: "app writes a new value" },
          { label: "DB", note: "write of record, source of truth" },
          { label: "Hash ring", note: "locate owning shard for the key" },
          { label: "Cache shard", note: "DELETE key, not SET" },
          { label: "Async replicate", note: "primary streams to replica(s)" },
        ],
      },
      {
        kind: "analytics",
        title: "BACKGROUND · REPLICATION, FAILOVER, REBALANCING",
        summary:
          "Nodes gossip liveness and the coordinator owns cluster membership, so a node failure or a resize event never needs a client to notice mid-request.",
        steps: [
          { label: "Gossip bus", note: "nodes exchange liveness heartbeats" },
          { label: "Coordinator (etcd/Raft)", note: "quorum-confirms failures, owns cluster map" },
          { label: "Promotion", note: "best-caught-up replica promoted, target < 10s" },
          { label: "Cluster map push", note: "clients re-route via updated hash ring" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "500M keys, ~10KB avg value ≈ 5TB working set",
          "~100 primary shards (50GB usable/node, 80% cap), x2 replication ≈ 200 nodes",
          "5M reads/sec, 200K writes/sec ≈ 25:1 read:write",
          "~50K reads/sec per shard, well under a single node's ~100K-1M ops/sec ceiling",
          "200 virtual nodes per physical node ≈ 20K ring points",
          "p99 GET < 1ms, p99 SET < 2ms, hit rate ≥ 95%",
          "Failure detection plus promotion target: < 10s",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Consistent hashing plus virtual nodes, not mod-N hashing",
          "Cache-aside with delete-on-write, not update-on-write, not write-through/write-back",
          "Approximate LRU (sample 5-10), not exact LRU, not random eviction",
          "Hot keys: local cache absorption first, then key splitting — never 'add more shards'",
          "Async primary-replica replication, gossip-quorum failure detection, coordinator-driven promotion",
          "Stampede protection: request coalescing plus jittered TTL, not a flat TTL",
          "Client-side routing (hash ring in the client library), no central proxy on the hot path",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The cache is not the source of truth — async replication's loss window is an acceptable trade only because of that",
          "One key is pinned to one shard by design — scaling the cluster doesn't fix a hot key",
          "Delete-on-write, never set-on-write, to close the concurrent-writer stale-cache race",
          "Virtual nodes exist to smooth load, not to reduce total data movement — plain consistent hashing already bounds that to ~1/N",
          "Stampede risk peaks right after a hot key's TTL, exactly when jitter and coalescing matter most",
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
      goal: "Before you draw anything, get five numbers and the consistency story on the board. The point is to make the interviewer confirm scope out loud, so nothing surprises you later.",
      why: "Numbers are not trivia here. The interviewer is checking whether you drive the design from data. Every later decision (shard count, ring size, eviction policy) falls out of these numbers, so locking them first is what separates an engineer from someone guessing.",
      steps: [
        { kind: "ASK", text: 'Ask **"Is this a general-purpose cache in front of a database, or a specific use case like a session store?"** Land on "general-purpose KV cache in front of a database of record". Write **"cache-aside, DB is source of truth"** top-left.' },
        { kind: "ASK", text: 'Ask for the ratio and scale: walk them to **"5M reads/sec, 200K writes/sec, ~25:1"**. Write it under the first line.' },
        { kind: "SAY", text: 'Propose the latency target yourself: **"sub-1ms p99 GET"**, **"sub-2ms p99 SET"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "GET/SET/DELETE", "sharding", "replication", "eviction", "hot keys". Out: "durability guarantees beyond best-effort", "cross-region replication", "auth". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the storage math out loud: **"500M keys x ~10KB avg ≈ 5TB working set"**, **"50GB usable per node ≈ 100 shards"**, **"x2 replication ≈ 200 nodes"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, stating explicitly that the cache is not the source of truth, and locking the latency budget before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Four verbs, one opaque value type, and a shard-internal record sketched before anyone asks for it.",
      why: "The interviewer wants to see you commit to a tiny surface. Four verbs and an opaque value signal you know this is a generic KV layer, not a database with schemas and transactions.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"GET key"**, **"SET key value ttl?"**, **"DELETE key"**, **"MGET [keys]"** — note that MGET exists to cut round trips for batch reads.' },
        { kind: "SAY", text: '"The value is an opaque byte blob from the cache\'s point of view — serialization is the app\'s problem, not the cache\'s."' },
        { kind: "DRAW", text: "Sketch a shard's internal record: **\"key\"**, **\"value\"**, **\"last-access (for approximate LRU) or freq counter (for LFU)\"**, **\"expire-at\"**." },
        { kind: "RULE OUT", text: '"Multi-key atomic transactions are out of scope — this is a KV cache, not a database." Cross it off before it gets asked.' },
      ],
      grading: "Crisp verb list, an explicit note that the value is opaque, and a shard-internal record sketched proactively.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: read, write, background. Label the arrows with hit rates and hop counts, not just box names.",
      why: "Drawing read, write, and background as separate lanes proves you understand they have different requirements. Candidates who draw one blob miss that replication and rebalancing must never sit on the request path.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read lane**: Client → in-process cache → hash ring → shard (primary or replica) → DB on a full miss. Label **"~15% local hit"**, **"hash(key) → shard"**, **"sub-1ms"**.' },
        { kind: "DRAW", text: 'Add the **write lane**: Client → DB (write of record) → hash ring → shard **"DELETE key, not SET"** → async replicate to the replica.' },
        { kind: "DRAW", text: 'Add the **background lane**, dashed: gossip bus + coordinator (etcd) → cluster map → all shards, labeled **"never on the client\'s request path"**.' },
        { kind: "SAY", text: '"Three lanes because they have three jobs: read is latency-critical, write must protect DB-cache consistency, background must never block either."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with hit rates and hop counts, and an explicit statement that background work never touches the request path.",
    },
    {
      n: 4,
      title: "Deep Dive: Sharding and Rebalancing",
      minutes: 8,
      goal: "Draw the ring with virtual nodes, walk a resize event, and defend it against mod-N hashing.",
      why: "This is the signature sub-problem. The interviewer is probing whether you understand why consistent hashing bounds data movement and why virtual nodes are needed on top of it, not just that 'consistent hashing' is the buzzword to say.",
      steps: [
        { kind: "DRAW", text: 'Draw the ring: nodes placed at points, a key belongs to the next point clockwise. Say: **"~200 virtual nodes per physical node, ~20,000 points total."**' },
        { kind: "SAY", text: '"Virtual nodes smooth the load. With only 100 random points, some arcs are 3x the average size; with 200 per node, every physical node gets close to its fair 1/N share."' },
        { kind: "SAY", text: 'Walk a resize: **"Add one node to a 100-node ring, roughly 1% of keys move, spread across many nodes\' vnodes rather than concentrated on one neighbor."**' },
        { kind: "RULE OUT", text: '"mod-N hashing: one node added and ~99% of keys reassign — a resize becomes a self-inflicted cache-miss storm on the DB. Rejected." Cross it off.' },
      ],
      grading: "The ring and virtual-node concept explained without prompting, a quantified resize walkthrough, and a one-line rejection of mod-N hashing.",
    },
    {
      n: 5,
      title: "Deep Dive: Eviction, Hot Keys, Stampede",
      minutes: 7,
      goal: "Cover approximate LRU, the hot-key math, and stampede protection — the three places where a naive answer breaks under real traffic.",
      why: "Anyone can say 'use LRU' or 'add a cache'. The interviewer wants the failure mode quantified and the mitigation named before being asked.",
      steps: [
        { kind: "SAY", text: '"True LRU needs a linked-list touch on every read, which contends at 5M ops/sec. Approximate LRU samples 5-10 random keys on eviction and drops the oldest of the sample — O(1), statistically close to true LRU."' },
        { kind: "SAY", text: '"A viral key can pull 500K req/sec against a shard whose ceiling is ~100-200K ops/sec. Consistent hashing pins it to one shard, so more shards don\'t help. A short-TTL local cache absorbs most of it; key splitting across key#0..key#9 handles the rest."' },
        { kind: "SAY", text: '"When that hot key\'s TTL expires with 10K concurrent readers, all 10K can miss at once and hammer the DB. Request coalescing lets one fetch serve all 10K waiters; jittered TTLs stop keys from all expiring in the same instant."' },
        { kind: "RULE OUT", text: '"Just add more shards" for a hot key — one line: "consistent hashing keeps that key on one shard regardless of cluster size." Cross it off.' },
      ],
      grading: "Approximate LRU explained with the sampling mechanism, hot-key math quantified in req/sec vs. shard ceiling, and stampede protection volunteered without prompting.",
    },
    {
      n: 6,
      title: "Wrap: Replication, Consistency Story, and Close",
      minutes: 5,
      goal: "Name the replication trade-off explicitly, push back on one requirement, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is naming the consistency trade-off in one sentence instead of dancing around it, treating requirements as negotiable, and closing like a collaborator rather than running out the clock.",
      steps: [
        { kind: "SAY", text: '"Replication is async — writes ack locally and stream to replicas after. That means a crash can lose the last few milliseconds of writes, which is fine because the cache isn\'t the source of truth."' },
        { kind: "SAY", text: '"Failure detection is gossip-quorum based so one flaky observer can\'t trigger a false failover, and the coordinator is the only thing allowed to promote a replica, which prevents split-brain."' },
        { kind: "SAY", text: '"Do we really need 99.99% availability on the cache itself, given every miss just falls through to the DB? That could change how much redundancy we build in." Treat requirements as negotiable.' },
        { kind: "SAY", text: '"It\'s a sharded in-memory KV layer with consistent hashing, cache-aside plus delete-on-write, and async replication with gossip-based failover. With more time I\'d cover cross-region replication, cold-start cache warming, and multi-tenant isolation."' },
      ],
      grading: "Explicit replication trade-off in one sentence, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but the trade-offs and the numbers stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, cache (usually 'Redis'), database.",
          "Knows reads dominate writes and puts a cache in front of the DB.",
          "Picks LRU generically without explaining how it's implemented at scale.",
          "Can write the four verbs (GET/SET/DELETE/MGET) and a rough shard record.",
          "Handles 'what if a node dies' by adding a replica when asked.",
        ],
        gaps: [
          "Doesn't do the storage math out loud, or just says 'lots of data'.",
          "Doesn't distinguish consistent hashing from mod-N hashing, or doesn't mention virtual nodes at all.",
          "No hot-key plan beyond 'use a bigger Redis' or 'add more shards'.",
          "Uses update-on-write instead of delete-on-write, missing the stale-write race entirely.",
          "No replication or failover story unless directly prompted.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks defaults with reasons, names trade-offs when asked, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes QPS, storage, and latency targets on the board within the first 5 minutes.",
          "Picks consistent hashing plus virtual nodes over mod-N, and can explain why vnodes matter.",
          "Picks cache-aside with delete-on-write and can explain the race it avoids.",
          "Explains approximate LRU sampling without prompting.",
          "Names async replication and a gossip-based failure detector when asked about node failure.",
          "Has a hot-key mitigation (local cache, then key splitting) rather than 'add more shards'.",
          "Acknowledges the cache-is-not-source-of-truth trade-off.",
        ],
        gaps: [
          "Volunteers the hot-key math only after the interviewer pushes, not on their own.",
          "Doesn't bring up cache stampede or thundering herd unless directly asked.",
          "Quantifies data-movement bounds only after being asked ('~1/N') rather than stating it up front.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces risks before being asked, and brings operational maturity that goes beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the 1/N data-movement bound and the reason virtual nodes exist (load smoothing, not movement reduction) unprompted.",
          "States the async-replication loss window as an explicit, justified trade tied directly to 'the cache is not the source of truth'.",
          "Brings up cache stampede and jittered TTL unprompted, quantifying the concurrent-reader scenario (e.g. 10K readers, 1 DB query via coalescing).",
          "Explicitly calls out that 'add more shards' does not fix a hot key, and explains why before being challenged on it.",
          "Pushes back on requirements where appropriate ('does the cache itself need 99.99% given the DB fallback on miss?').",
          "Names the gossip-quorum failure-detection design as a deliberate defense against false failovers, not just 'we detect failures'.",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover if there were more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Reaching for update-on-write instead of delete-on-write, creating a silent, permanent stale-cache race under concurrent writers.",
      "Treating the cache as the source of truth, or never stating explicitly that it isn't.",
      "mod-N hashing with no mention of what happens to hit rate on a resize.",
      "No hot-key plan, or answering 'add more shards' which doesn't address a single key pinned to one node.",
      "Sync (quorum) replication on every SET with no acknowledgment of the write-latency cost, or async replication with no acknowledgment of the loss window.",
      "No eviction policy named, or true LRU proposed with no acknowledgment of the per-read bookkeeping cost at millions of ops/sec.",
      "No stampede or thundering-herd protection when a hot key's TTL expires under concurrent load.",
    ],
    followUps: [
      {
        q: "Why client-side hashing instead of a proxy layer like Twemproxy or Envoy?",
        a: "A proxy centralizes routing logic (one place to fix bugs, language-agnostic clients) but adds an extra network hop to every request and becomes a new single point of failure and scaling bottleneck at 5M req/sec. Client-side routing keeps the hot path to one hop, at the cost of every client language needing its own hashing implementation kept in sync with the coordinator's cluster map. At this scale, the extra hop is the deciding factor — routing logic is a solved, shippable library, not a reason to add a hop.",
      },
      {
        q: "How would you warm a cold cache after a full outage?",
        a: "Don't let traffic hit it at full volume immediately — ramp gradually while request coalescing absorbs the redundant DB fetches that would otherwise stampede. For known-hot keys (trending items, top-N lists) pre-warm from the DB in the background before flipping traffic over, so the first wave of real requests already has a populated cache instead of a 100% miss rate hitting the database at once.",
      },
      {
        q: "What if a caller needs strong read-after-write consistency?",
        a: "Cache-aside with delete-on-write gives eventual consistency by default — after a write, the next read anywhere is a guaranteed miss that refetches the new value, but there's a brief window where a stale value could still be read from a replica that hasn't caught up. For read-your-writes needs, route that specific client's reads to the primary shard (not a replica) for a short window after their own write, or accept a short client-side TTL of zero right after a write. It's a targeted exception, not a cluster-wide policy change.",
      },
      {
        q: "How do you decide the replica count per shard?",
        a: "Default to one replica (RF=2 total copies) sized for failover coverage and doubling read capacity. For shards known to be hotter than average, add a second or third replica specifically to spread read load further — this is the same key-splitting instinct applied at the shard level instead of the key level. More replicas cost more memory and more write fan-out per SET, so it's a targeted increase, not a blanket default.",
      },
      {
        q: "Why not just run one giant Redis instance instead of sharding?",
        a: "A single instance is capped by one machine's RAM (nowhere near 5TB affordably) and by its single-threaded event loop's ops ceiling (roughly 100K-1M ops/sec depending on command mix) — nowhere near 5M reads/sec. It's also a single point of failure for the entire cache. Sharding trades operational complexity (routing, rebalancing, hot keys) for horizontal scaling of both memory and throughput, which is the only way to hit this problem's numbers.",
      },
      {
        q: "Redis vs. Memcached — how would you choose for this design?",
        a: "Memcached is a simpler, pure key-value store with a multi-threaded architecture and no built-in clustering — you'd bring your own consistent-hashing client and coordinator, which is close to what this design already does. Redis adds richer data structures, single-threaded execution (simpler concurrency reasoning, but one core per shard), optional persistence (RDB/AOF), and built-in clustering (Redis Cluster) if you want less to build yourself. For a from-scratch design exercise, either works as the shard engine; the design's hard parts (hashing, hot keys, invalidation, failover) sit above that choice either way.",
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
          "This is a sharded, in-memory key-value layer sitting in front of a database of record. The core operation, GET or SET on a key, is a single-key lookup or write, and everything else in the design (hashing, replication, eviction, hot-key handling) exists to keep that operation fast, correctly routed, and honest about what the cache can and cannot promise.",
          "Anchor everything on five numbers: 500M keys / 5TB working set, 5M reads/sec, 200K writes/sec, sub-1ms p99 GET, and 99.99% availability. Every structural choice below is a consequence of these numbers, and the one non-negotiable fact that the cache is not the source of truth.",
        ],
      },
      {
        heading: "Sizing the cluster",
        body: [
          "500M keys at ~10KB average value size is ~5TB of live data. Capping each node at 50GB usable memory (80% of a larger box, leaving headroom for spikes and eviction sampling) gives ~100 primary shards. At 5M reads/sec that's ~50K reads/sec per shard, well under a single-threaded in-memory store's realistic ceiling.",
          "One replica per shard for failover and read scaling doubles the node count to ~200 without doubling the shard count — replicas hold the same 100 partitions of the keyspace, just as copies.",
        ],
      },
      {
        heading: "Routing without coordination: the ring",
        body: [
          "Naive hash(key) mod N reassigns nearly the entire keyspace on any resize. Consistent hashing bounds that to ~1/N per node change by placing nodes on a ring and routing a key to the next point clockwise. Plain consistent hashing with one point per node still leaves uneven load, since a small number of random points has high variance in arc size — so each physical node gets ~200 virtual points (20,000 total), which smooths that variance so every node ends up with close to its fair share.",
          "Routing lives client-side: the hash ring is a library, not a proxy, so a lookup is one hash computation with no extra network hop. The coordinator (etcd, Raft-backed) owns the authoritative cluster map and pushes updates to clients when membership changes.",
        ],
      },
      {
        heading: "Keeping the cache honest: cache-aside and delete-on-write",
        body: [
          "Of the four textbook write strategies, write-through pays full DB latency on every write, write-back risks losing unflushed writes if the cache node dies, and write-around guarantees a miss on first read. Cache-aside with delete-on-write is the default: the app populates the cache on a read miss, and on a write it updates the DB then deletes the cache key rather than setting it.",
          "The delete, not set, choice closes a specific race: two concurrent writers can race such that a slower writer's SET lands in the cache after a faster, newer write, leaving a permanently stale value until TTL expiry. A DELETE just forces the next read to refetch from the database, which is always correct.",
        ],
      },
      {
        heading: "Eviction and the hot-key exception",
        body: [
          "True LRU's per-read linked-list maintenance contends heavily at millions of ops/sec, so approximate LRU (sample 5-10 random keys per eviction, drop the oldest of the sample) trades a small amount of eviction precision for O(1) bookkeeping. LFU with a decaying counter is the alternative when access frequency matters more than recency.",
          "Sharding assumes roughly uniform key access, and viral keys break that assumption hard, one key can pull 500K req/sec against a shard whose ceiling is ~100-200K ops/sec. Because consistent hashing pins a key to exactly one shard by design, adding more shards does nothing for that key. The fix is targeted: a short-TTL local cache absorbs most repeat reads for free, and key splitting (suffixed copies across N shards) handles what's left.",
        ],
      },
      {
        heading: "Replication, failover, and the stampede that isn't obvious",
        body: [
          "Replication is asynchronous, the primary acks a write once applied locally and streams to replicas after, trading a small data-loss window on crash for keeping writes off the WAN round trip. Failure detection is gossip-based and requires a quorum of peers to agree before declaring a primary dead, avoiding false failovers from a single flaky observer; the Raft-backed coordinator is the only entity allowed to promote a replica, preventing split-brain.",
          "A subtler failure mode is the cache stampede: when a hot key's TTL expires with many concurrent readers, all of them can miss simultaneously and hammer the database at once, even though nothing about the cache itself is broken. Request coalescing (one in-flight fetch serves every waiter) caps the damage, and jittered TTLs plus probabilistic early refresh reduce how often synchronized expiry can happen in the first place.",
        ],
      },
    ],
  },
};
