import type { Problem } from "@/lib/types";

export const rateLimiter: Problem = {
  slug: "rate-limiter",
  num: "3.1",
  title: "Design a Rate Limiter",
  level: "Medium",
  deepDiveAvailable: true,
  intro: [
    "Design a rate limiter that protects downstream APIs from abuse and overload: enforce per-user, per-API-key, and per-route limits (e.g. 100 req/min free tier, 10K/min paid tier) across a fleet of gateway nodes handling 1M requests/sec globally, deciding allow-or-deny in under 1ms added latency, without the limiter itself ever becoming the outage.",
  ],
  hardParts:
    "The hard parts: doing atomic distributed counting at sub-millisecond latency without a check-then-increment race, choosing an algorithm that absorbs bursts fairly without either over-blocking legitimate traffic or burning O(n) memory per key, and keeping limits close to correct across a fleet of nodes and regions without paying a network round trip on every single request.",
  keyTopics: [
    "Token Bucket Algorithm",
    "Atomic Check-and-Increment (Lua)",
    "Local Cache + Async Sync",
    "Fail-Open with Local Fallback",
    "Multi-Region Approximate Counting",
  ],
  foundationsReferenced: [
    { label: "Redis / Valkey", tone: "purple" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Lua Scripting / Atomic Ops", tone: "orange" },
    { label: "CAP Theorem", tone: "blue" },
    { label: "Gossip Protocols", tone: "orange" },
    { label: "Circuit Breakers", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "API Gateway", sub: "edge · 1M req/s", col: 2, row: 1, tone: "slate" },
      {
        id: "limiter",
        label: "Rate Limiter Lib",
        sub: "in-process · sidecar",
        mono: "local bucket checked first",
        col: 3,
        row: 1,
        tone: "green",
      },
      {
        id: "redis",
        label: "Redis Cluster",
        sub: "~50M active keys",
        mono: "Lua: GET+INCR+EXPIRE atomic",
        col: 4,
        row: 1,
        tone: "purple",
      },
      { id: "api", label: "Downstream API", col: 5, row: 1, tone: "slate" },
      { id: "localcache", label: "Local Token Cache", sub: "in-proc · ~100ms sync", col: 3, row: 2, tone: "green" },
      { id: "kafka", label: "Kafka", sub: "decision log", col: 3, row: 3, tone: "orange" },
      { id: "analytics", label: "Flink + Abuse Detection", col: 4, row: 3, tone: "orange" },
      { id: "sync", label: "Cross-Region Sync", sub: "gossip / cluster bus", col: 5, row: 3, tone: "orange" },
      { id: "configsvc", label: "Config Service", sub: "rule CRUD", col: 1, row: 4, tone: "blue" },
      { id: "postgres", label: "Postgres", sub: "rule store", col: 2, row: 4, tone: "blue" },
    ],
    edges: [
      { from: "client", to: "gateway", kind: "read" },
      { from: "gateway", to: "limiter", kind: "read" },
      { from: "limiter", to: "localcache", label: "check local first", kind: "read" },
      { from: "localcache", to: "redis", label: "miss / sync ~100ms", kind: "read" },
      { from: "redis", to: "limiter", label: "allow/deny + count", kind: "read" },
      { from: "limiter", to: "gateway", label: "<1ms decision", kind: "read" },
      { from: "gateway", to: "api", label: "allowed only", kind: "read" },
      { from: "limiter", to: "kafka", label: "async decision event", kind: "analytics" },
      { from: "kafka", to: "analytics", kind: "analytics" },
      { from: "redis", to: "sync", label: "cluster bus", kind: "analytics" },
      { from: "configsvc", to: "postgres", label: "persist rule", kind: "write" },
      { from: "configsvc", to: "limiter", label: "push limits · pub/sub", kind: "write" },
    ],
    legend: [
      { kind: "read", text: "decision path · 1M checks/s, <1ms added latency" },
      { kind: "write", text: "config path · rule updates, propagate < 5s" },
      { kind: "analytics", text: "async · decision logging & cross-region sync, never blocks a decision" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "gateway", "limiter", "api"],
      say: "Start with the skeleton: the API Gateway asks an embedded Rate Limiter Lib for a verdict before forwarding to the Downstream API. That decision has to add well under a millisecond, so it lives in the request path as a library, not behind a network hop.",
    },
    {
      reveal: ["localcache", "redis"],
      say: "At 1M decisions/sec, a synchronous check on every request is a non-starter. A Local Token Cache answers most checks from memory in microseconds; only on a miss or the periodic sync does it touch the shared Redis Cluster, which holds ~50M active keys as the source of truth.",
    },
    {
      reveal: ["kafka", "analytics"],
      say: "Every allow/deny decision also drops onto Kafka and moves on — Flink aggregates those events for abuse detection, fully async, so a logging outage can never slow a live decision.",
    },
    {
      reveal: ["sync"],
      say: "Regions are active-active too. Redis clusters gossip across regions over a cluster bus, so a limit that's meant to be global stays close to accurate without a synchronous WAN round trip on every request.",
    },
    {
      reveal: ["configsvc", "postgres"],
      say: "Limits are data, not code: an operator edits a rule through the Config Service, it's persisted in Postgres, and pushed to every gateway node over pub/sub in under 5 seconds — no redeploy.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Enforce N requests per time window per key (user, API key, IP, or route)", tag: "P0" },
      { id: "FR-02", text: "Support multiple limiting policies: token bucket, sliding window, fixed window", tag: "P0" },
      { id: "FR-03", text: "Return standard headers (X-RateLimit-Limit/Remaining/Reset) and 429 with Retry-After", tag: "P0" },
      { id: "FR-04", text: "Per-tier limits, e.g. free tier 100/min vs paid tier 10K/min", tag: "P0" },
      { id: "FR-05", text: "Burst allowance separate from the sustained rate (token bucket burst capacity)", tag: "P0" },
      { id: "FR-06", text: "Distributed enforcement consistent across all gateway nodes and regions", tag: "P0" },
      { id: "FR-07", text: "Hierarchical/composite limits, e.g. per-user AND a global per-endpoint ceiling", tag: "P1" },
      { id: "FR-08", text: "Dynamic rule updates (limit, window, tier) without redeploying gateways", tag: "P1" },
      { id: "FR-09", text: "Admin API to view current usage and reset a key's counter", tag: "P1" },
      { id: "FR-10", text: "Local, per-node fallback limiting if the shared store is unreachable", tag: "P1" },
      { id: "FR-11", text: "Log allow/deny decisions for abuse analysis and audit", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Decision latency added to the request path", tag: "p99 < 1ms" },
      { id: "NFR-02", text: "Sustained decision throughput across the fleet", tag: "1M/sec" },
      { id: "NFR-03", text: "Availability of the limiter itself (it must never be the outage)", tag: "99.99%" },
      { id: "NFR-04", text: "Global count drift tolerance across nodes/regions during async sync", tag: "< 5% overshoot" },
      { id: "NFR-05", text: "Rule-update propagation to every gateway node", tag: "< 5s" },
      { id: "NFR-06", text: "Local counter memory footprint per gateway node", tag: "< 200MB" },
      { id: "NFR-07", text: "Active limited keys held in the shared store", tag: "50M keys" },
      { id: "NFR-08", text: "Failure mode when the shared store is unreachable", tag: "fail-open" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Five algorithms, kill four, defend one",
      body: [
        "Every limiting policy is really just a memory-versus-accuracy tradeoff. Put the five usual suspects on the board and rule them out with numbers, not vibes — the interviewer wants to see you know exactly why fixed window is the wrong default before you reach for token bucket.",
      ],
      bullets: [
        { lead: "Fixed window counter", text: "O(1) memory, trivially simple, but a client can send the limit at the last instant of one window and the limit again at the first instant of the next, getting 2× the limit inside a much shorter span. Rejected as a default when precision matters." },
        { lead: "Sliding window log", text: "store every request timestamp per key and count how many fall in the trailing window. Perfectly accurate, but O(n) memory per key — at 50M keys and a 10K/min limit that's an unbounded amount of state. Rejected for memory at scale." },
        { lead: "Sliding window counter", text: "a weighted blend of the current and previous fixed window. O(1) memory, smooths out the boundary spike, close approximation. Solid, memory-cheap alternative." },
        { lead: "Token bucket", text: "a bucket refills at the sustained rate and holds up to a burst capacity; every request spends one token. O(1) memory, smooth average rate, and — uniquely — a controlled, bounded burst allowance. This is what AWS, Stripe, and most API gateways ship by default. Winner." },
        { lead: "Leaky bucket", text: "requests queue and drain at a fixed rate instead of being admitted or rejected immediately. Great for smoothing output to a downstream system, bad for a reject-fast public API where you want an instant answer, not a queue. Rejected for the request-response case." },
      ],
      pictureTitle: "Algorithm shootout: kill four, keep one",
      pictureRows: [
        { label: "Fixed window", value: "boundary burst up to 2× the limit", tone: "bad" },
        { label: "Sliding window log", value: "perfectly accurate but O(n) memory/key", tone: "bad" },
        { label: "Sliding window counter", value: "O(1), close approximation — solid fallback", tone: "neutral" },
        { label: "Token bucket", value: "O(1), smooth rate + bounded burst — WINNER", tone: "good" },
        { label: "Leaky bucket", value: "smooths via queueing, adds latency — wrong shape", tone: "bad" },
      ],
      remember: {
        problem: "Which algorithm enforces a limit cheaply and fairly at 50M keys?",
        solution: "Token bucket: O(1) memory per key, smooth sustained rate, and a bounded burst capacity.",
        why: "A bucket that refills continuously and caps burst spend gives you both an average-rate guarantee and headroom for legitimate bursts, without storing per-request history.",
        tradeoff: "Slightly harder to reason about than fixed window; needs a refill timestamp plus a token count per key instead of a single integer.",
        failure: "Fixed window lets a client double the limit right at the boundary; sliding log runs out of memory as key count grows.",
        mitigation: "Default every route to token bucket; reserve sliding window counter for routes that need a cheaper approximation with less state per key.",
      },
    },
    {
      n: 2,
      title: "The check-then-increment race, and the atomic fix",
      body: [
        "Two gateway nodes both read the counter for the same key at count=99 with a limit of 100. Both decide 'still under the limit' and both increment. The key is now at 101 and two requests were admitted that shouldn't have been. This is the classic read-then-write race, and it happens constantly under real concurrency, not as an edge case.",
      ],
      bullets: [
        { lead: "The race, in numbers", text: "at 1M decisions/sec fanned out across hundreds of gateway nodes, thousands of requests for the same hot key can land within the same millisecond — the window for the race is wide open, every time." },
        { lead: "Plain Redis INCR isn't enough", text: "INCR itself is atomic, but 'increment, then check if the new value exceeds the limit, then maybe expire' is three operations. Doing them as three separate round trips reopens the race between them." },
        { lead: "Lua script closes it", text: "Redis executes a Lua script as a single atomic unit on one shard — no other command interleaves. One script does GET, checks the limit, INCR, and sets EXPIRE on first write, all-or-nothing." },
        { lead: "Sliding-window variant", text: "for the sorted-set version (ZADD current timestamp, ZREMRANGEBYSCORE to evict old entries, ZCARD to count), the same three operations get wrapped in one Lua script for the same reason." },
      ],
      pictureTitle: "Closing the read-then-write race",
      pictureRows: [
        { label: "No coordination", value: "two nodes both admit at 99/100 → 101 through", tone: "bad" },
        { label: "Plain INCR only", value: "count is atomic, but check+expire aren't bundled", tone: "neutral" },
        { label: "Lua script (GET+INCR+EXPIRE)", value: "one atomic op on one shard — race eliminated", tone: "good" },
      ],
      remember: {
        problem: "Two nodes both read 'under limit' and both admit, over-granting the budget.",
        solution: "Bundle check-and-increment into one Redis Lua script, executed atomically on a single shard.",
        why: "Redis runs a Lua script to completion with no other command interleaving, so the read-check-write sequence can no longer be split by a concurrent request.",
        tradeoff: "Every decision now costs a script eval instead of a bare INCR — marginally more CPU on the Redis side for correctness.",
        failure: "Separate GET, INCR, EXPIRE calls leave gaps a concurrent request can land in, silently over-admitting.",
        mitigation: "Ship one Lua script per algorithm (token bucket, sliding window) as the only way any node talks to Redis for a decision.",
      },
    },
    {
      n: 3,
      title: "Placement: where does the limiter actually run?",
      body: [
        "Before the algorithm, decide where the check happens. This is a real architectural choice with real failure modes, and naming all four options — then killing three — is exactly the kind of ground-covering the interviewer is listening for.",
      ],
      bullets: [
        { lead: "Client-side", text: "the client counts its own requests and self-throttles. Trivial to bypass — anyone can just not run that code — so it's a UX nicety, never the enforcement point. Rejected as the source of truth." },
        { lead: "Centralized rate-limit microservice", text: "every gateway calls out to a dedicated service for a decision. Clean separation, but adds a network hop and a queueing point to every single request, and that service is now a single point of failure for all traffic. Rejected as the default." },
        { lead: "Edge / CDN-level", text: "blunt global limits at the edge (Cloudflare-style) are great for DDoS-shaped abuse, but they don't know about your user tiers or per-route budgets. Good as a first coarse layer, not sufficient alone." },
        { lead: "Embedded library / sidecar + shared store", text: "a small library runs in-process inside each API gateway node, checks a local cache first, and talks to a shared Redis cluster only when it needs to. In-process means no extra hop for the common case. Winner." },
      ],
      pictureTitle: "Four placements, one winner",
      pictureRows: [
        { label: "Client-side", value: "trivially bypassed, not real enforcement", tone: "bad" },
        { label: "Central microservice", value: "extra hop on every request, becomes a SPOF", tone: "bad" },
        { label: "Edge/CDN only", value: "good coarse layer, no per-user granularity", tone: "neutral" },
        { label: "Embedded lib + shared Redis", value: "in-process check, hop only when needed", tone: "good" },
      ],
      remember: {
        problem: "Where should the allow/deny decision physically execute?",
        solution: "An embedded library inside each API gateway node, backed by a shared Redis cluster.",
        why: "In-process avoids an extra network hop for every request; the shared store is only consulted when the local cache can't answer confidently.",
        tradeoff: "Every gateway node now ships and maintains limiter logic instead of calling one central service — more surface area, but no added hop.",
        failure: "A standalone rate-limit microservice adds latency to every request and becomes a single point of failure for the whole API surface.",
        mitigation: "Keep edge/CDN limits as a coarse first layer for obvious abuse, and the embedded library as the precise, tier-aware enforcement point.",
      },
    },
    {
      n: 4,
      title: "Local cache + async sync: the signature hard part",
      body: [
        "The naive design has every request make a synchronous Redis round trip. At 1M decisions/sec that's both a 1-2ms latency tax on every request and a single Redis cluster absorbing the full fleet's write load. The fix trades a small, bounded amount of accuracy for near-zero added latency in the common case — and it's the tradeoff an interviewer is specifically listening for.",
        "This is CAP theorem in miniature, applied on purpose: during a network partition between a node's local count and the shared Redis state, pick availability (answer from the local cache, stay up) over strict consistency (block on Redis to get the exact global count). Name that tradeoff explicitly rather than treating it as an implementation detail.",
      ],
      bullets: [
        { lead: "Naive: synchronous check every time", text: "every request pays a network round trip to Redis (~1-2ms) before the gateway can respond, and Redis becomes the throughput ceiling for the entire fleet." },
        { lead: "Naive: statically split the limit per node", text: "divide the global limit by node count and enforce locally with zero coordination. Falls apart the moment traffic isn't evenly distributed — one hot node wrongly rejects while a cold node sits far under its share." },
        { lead: "Hybrid: local cache with async sync", text: "each node keeps a local approximate token count, decides most requests from memory in microseconds, and syncs deltas to Redis on a short interval (~100ms) or every N requests. Between syncs, a node can over-admit slightly." },
        { lead: "The overshoot is bounded, not unbounded", text: "with N nodes and a 100ms sync window, the worst case is roughly N × (requests one node can admit in 100ms) — quantify it and size a tolerance (e.g. under 5% over the limit) into the NFR, rather than promising perfect enforcement." },
      ],
      pictureTitle: "Avoiding a Redis round trip on every request",
      pictureRows: [
        { label: "Sync Redis call every request", value: "~1-2ms added, Redis is the throughput ceiling", tone: "bad" },
        { label: "Static per-node split", value: "hot node over-rejects, cold node under-uses", tone: "bad" },
        { label: "Local cache + async sync (~100ms)", value: "µs local check, bounded ~5% overshoot", tone: "good" },
      ],
      remember: {
        problem: "Check a shared global limit without a network hop on every request.",
        solution: "Local approximate counters per node, periodically synced to Redis, with a bounded overshoot tolerance.",
        why: "Most decisions can be answered from a local, recently-synced count; only the sync itself needs to touch the network, off the request's critical path.",
        tradeoff: "You give up perfect global accuracy — the limit can be exceeded by a small, quantified margin between syncs.",
        failure: "A sudden traffic spike right after a sync can let noticeably more than the limit through before the next sync catches up.",
        mitigation: "Keep the sync interval short (~100ms), size the tolerated overshoot explicitly, and tighten the interval for routes where precision matters more than latency.",
      },
    },
    {
      n: 5,
      title: "Multi-region and the hot-key problem",
      body: [
        "Two related but distinct problems show up at scale: a single popular key (one viral API key, one abusive IP) concentrating writes on one Redis shard, and a limit that's supposed to be global getting enforced across regions separated by 100ms+ of WAN latency. Neither has a free answer — name the tradeoff for each.",
      ],
      bullets: [
        { lead: "Hot key", text: "one heavily-used key can drive far more writes at a single Redis shard than the fleet's average — INCR itself is O(1), but shard-level contention still caps how fast that one key can be updated. Pre-aggregate locally on each node before syncing, so the shard sees one delta per node per sync interval, not one write per request." },
        { lead: "True global limit, synchronously", text: "coordinating a hard global cap across regions on every request means a cross-region round trip, 100ms or more — far outside the latency budget. Reject synchronous global coordination on the hot path." },
        { lead: "Weighted per-region budgets", text: "split the global limit across regions by expected traffic share (not evenly), enforce locally within each region, and rebalance the split periodically based on observed traffic. No WAN call per request." },
        { lead: "Eventual reconciliation for strict limits", text: "for a budget that truly must not be exceeded (e.g. a hard partner quota), accept eventual consistency: async gossip or CRDT-style merges reconcile true global usage with a short lag, and the system stays slightly permissive rather than blocking during that lag." },
      ],
      pictureTitle: "Global limits without a WAN round trip",
      pictureRows: [
        { label: "Synchronous global limit", value: "WAN RTT per request — far too slow", tone: "bad" },
        { label: "Even split by region count", value: "breaks the moment regional traffic is skewed", tone: "bad" },
        { label: "Weighted local budgets + async reconciliation", value: "no WAN latency, eventually accurate", tone: "good" },
        { label: "Single viral key", value: "pre-aggregate per node before the shard sees it", tone: "neutral" },
      ],
      remember: {
        problem: "Enforce something close to a global limit without cross-region round trips or melting one shard.",
        solution: "Weighted per-region local budgets plus async gossip/CRDT reconciliation; pre-aggregate hot-key writes per node.",
        why: "Cross-region coordination is too slow for the request path; per-node pre-aggregation keeps one hot key from becoming one hot shard.",
        tradeoff: "Regional budgets can be locally exhausted while global capacity remains, and strict global limits are only eventually exact.",
        failure: "A synchronous cross-region check on every request blows the latency budget by 100x; naive even-split budgets starve the region with the most traffic.",
        mitigation: "Rebalance regional weights from observed traffic periodically, and reserve strict synchronous coordination only for truly billing-critical limits, not the general case.",
      },
    },
    {
      n: 6,
      title: "Fail-open with a local fallback, never fail-closed",
      body: [
        "The rate limiter exists to protect availability, so it must never itself be the outage. When the shared Redis store is unreachable, the two extremes are both wrong — the right answer is a deliberate middle ground.",
      ],
      bullets: [
        { lead: "Fail-closed (reject everything)", text: "a Redis blip means every request returns 429. The component built to protect uptime has just caused a 100% outage — worse than having no limiter at all." },
        { lead: "Fail-open, no fallback (allow everything)", text: "a Redis blip means zero enforcement, right when the shared store being down is itself often a symptom of an overload event — exactly the moment you need protection most." },
        { lead: "Fail-open with local fallback", text: "each node keeps a lightweight, conservative local-only token bucket that activates only during a shared-store outage. Enforcement degrades to per-node approximate limits instead of vanishing." },
        { lead: "Circuit breaker on the Redis client", text: "detect the outage within a few hundred milliseconds, flip to local fallback, and flip back automatically once health checks pass — no manual intervention on either side of the blip." },
      ],
      pictureTitle: "What happens when Redis is unreachable?",
      pictureRows: [
        { label: "Fail-closed", value: "limiter blip = full API outage", tone: "bad" },
        { label: "Fail-open, no fallback", value: "limiter blip = zero protection, worst timing", tone: "bad" },
        { label: "Fail-open + local fallback", value: "degraded but bounded protection", tone: "good" },
      ],
      remember: {
        problem: "The shared store the limiter depends on is unreachable — what do gateways do?",
        solution: "Fail open, but fall back to a conservative local-only token bucket per node during the outage.",
        why: "A rate limiter's job is to protect availability; it can't itself become the single point of failure for every request.",
        tradeoff: "Local fallback limits are approximate and per-node, not globally accurate, for the duration of the outage.",
        failure: "Fail-closed turns any Redis blip into a full outage; fail-open with no fallback removes protection at the exact moment of overload risk.",
        mitigation: "A circuit breaker on the Redis client detects the outage fast, switches to local fallback, and reverts automatically once Redis recovers.",
      },
    },
    {
      n: 7,
      title: "Burst allowance and the thundering-herd retry",
      body: [
        "A limiter that's technically correct can still create a self-inflicted traffic spike. Clients that get a 429 tend to retry, and if every rejected client retries at the same instant, you've manufactured a synchronized burst right when the system is least able to absorb one.",
      ],
      bullets: [
        { lead: "Fixed window + naive retry", text: "every client rejected in a given window tends to retry right at the next window boundary, since that's when 'the limit resets'. The result is a thundering herd landing on the exact same instant." },
        { lead: "Token bucket's burst capacity", text: "separating sustained rate from burst size lets a client that saved up tokens spend them in a burst, smoothing demand against the average instead of forcing everyone to wait for a hard reset." },
        { lead: "Retry-After with jitter", text: "returning a randomized Retry-After (e.g. 1-3s, not a fixed value) spreads client retries across a window instead of resyncing them to the same second." },
        { lead: "Standard headers as self-throttling", text: "X-RateLimit-Remaining and X-RateLimit-Reset let well-behaved clients slow down before they ever hit a 429, which is strictly better than every client racing the limit and finding out after the fact." },
      ],
      pictureTitle: "Preventing a self-inflicted traffic spike",
      pictureRows: [
        { label: "Fixed window + naive retry", value: "retry storm synchronized to every window boundary", tone: "bad" },
        { label: "Token bucket burst capacity", value: "smooths demand against a sustained average", tone: "good" },
        { label: "Retry-After + jitter", value: "spreads retries instead of syncing them", tone: "good" },
      ],
      remember: {
        problem: "Rejected clients retry in a way that recreates the exact overload the limiter exists to prevent.",
        solution: "Token bucket burst capacity plus a jittered Retry-After header and standard rate-limit headers.",
        why: "Smoothing what admission looks like, and randomizing when clients are told to come back, both break the synchronization that causes a herd.",
        tradeoff: "Jittered Retry-After means some clients wait a little longer than the theoretical minimum, in exchange for no synchronized spike.",
        failure: "Fixed-window resets plus naive immediate retries synchronize every rejected client onto the same instant, spiking load right at the reset.",
        mitigation: "Always jitter Retry-After, and expose remaining-quota headers so well-behaved clients self-throttle before ever being rejected.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a distributed counter with a decision function: has this key used up its budget in this window? Everything else exists to make that check fast, atomic, and resilient at 1M decisions/sec.",
      "Token bucket is the default algorithm: O(1) memory, a smooth sustained rate, and a bounded burst allowance a strict fixed window can't give you.",
      "The signature hard part is avoiding a network round trip on every single request while still enforcing something close to a global limit — local cache plus async sync to Redis, with a bounded overshoot tolerance you can quantify.",
      "A Redis Lua script makes check-and-increment atomic, closing the classic race where two nodes both read 99-of-100 and both admit.",
      "The limiter must fail open with a local fallback, never fail closed — a limiter outage should degrade protection, never take down the whole API.",
    ],
    flows: [
      {
        kind: "read",
        title: "DECISION · 1M/S · <1MS ADDED LATENCY",
        summary:
          "A request hits the gateway, which asks the embedded limiter library for a verdict. The library checks its local cache first; only on a miss or scheduled sync does it touch Redis.",
        steps: [
          { label: "Client", note: "sends request with API key / user id" },
          { label: "API Gateway", note: "extracts the limiting key + route" },
          { label: "Rate Limiter Lib", note: "in-process, checks local cache first" },
          { label: "Local Token Cache", note: "hit → decision in microseconds" },
          { label: "Redis Cluster", note: "miss/sync → Lua: GET+INCR+EXPIRE atomic" },
          { label: "Rate Limiter Lib", note: "allow or deny, <1ms added" },
          { label: "Gateway response", note: "200 with headers, or 429 + jittered Retry-After" },
        ],
      },
      {
        kind: "write",
        title: "CONFIG · RULE UPDATES · < 5S PROPAGATION",
        summary:
          "An operator changes a limit. The rule is persisted, then pushed to every gateway node so it takes effect without a redeploy.",
        steps: [
          { label: "Admin", note: "sets/updates a limit via the admin API" },
          { label: "Config Service", note: "validates the rule" },
          { label: "Postgres", note: "persists the versioned rule" },
          { label: "Config Service", note: "publishes the update via pub/sub" },
          { label: "Rate Limiter Lib", note: "hot-reloads the new rule on every node" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · DECISION LOGGING & CROSS-REGION SYNC",
        summary:
          "Decisions are logged off the hot path for abuse analysis, and Redis clusters in different regions reconcile usage without ever blocking a live decision.",
        steps: [
          { label: "Rate Limiter Lib", note: "emits each allow/deny decision" },
          { label: "Kafka", note: "async decision log" },
          { label: "Flink", note: "aggregates abuse patterns" },
          { label: "Redis Cluster", note: "cluster bus / gossip reconciles regional counts" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "1M decisions/sec sustained across the fleet, p99 added latency < 1ms",
          "~50M active limited keys (user/API-key/IP × route) held in Redis",
          "Local cache absorbs the vast majority of checks; Redis is touched on sync (~every 100ms) or cold key",
          "Default policy example: 100 req/min sustained, burst capacity ~20 tokens",
          "Config propagation to every gateway node: < 5s via pub/sub",
          "Bounded overshoot tolerance from local cache + async sync: ~5%",
          "Availability target for the limiter itself: 99.99% — it must never be the outage",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Token bucket as the default algorithm, not fixed window or sliding log",
          "Embedded library/sidecar per gateway node backed by shared Redis, not a standalone microservice hop",
          "Local cache + async sync to Redis instead of a synchronous check on every request",
          "Lua script bundles GET+INCR+EXPIRE into one atomic Redis operation",
          "Fail-open with a conservative local fallback limiter, never fail-closed",
          "Weighted per-region local budgets with async reconciliation, not synchronous global coordination",
          "Standard X-RateLimit-* headers plus jittered Retry-After to prevent thundering-herd retries",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The check-then-increment race across nodes, and Lua/atomic scripting as the fix",
          "The accuracy-vs-latency tradeoff of local cache + async sync — name the bounded overshoot",
          "Fail-open + local fallback so a Redis outage degrades, rather than removes, protection",
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
      goal: "Nail down what's being limited, by whom, and at what volume before drawing anything. Every later decision falls out of these numbers.",
      why: "The interviewer is checking whether you drive the design from data rather than defaulting to 'add Redis'. Locking the dimension (user vs IP vs key), the throughput the limiter itself must survive, and the latency budget first is what separates a driven design from a guessed one.",
      steps: [
        { kind: "ASK", text: '**"What are we limiting — per-user, per-API-key, per-IP, or per-route?"** Land on "composable: user or API key plus route, IP as the fallback for anonymous traffic." Write it in the top-left corner.' },
        { kind: "ASK", text: '**"What traffic volume does the limiter itself have to survive?"** Land on "1M requests/sec across the fleet" and **"decision latency under 1ms added"**. Write both down.' },
        { kind: "SAY", text: 'Propose example tiers yourself: **"free tier 100/min, paid tier 10K/min, burst capacity around 20 tokens"**. Wait for a nod, then write it.' },
        { kind: "SAY", text: 'State scope. In: "the algorithm", "distributed consistency", "the config API", "failure modes". Out: "authentication", "WAF/DDoS mitigation", "billing metering". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Write the anchoring numbers on the board: **"1M decisions/s, p99 <1ms added, ~50M active keys"**. Numbers on the board, not in your head.' },
      ],
      grading: "Senior judgment. Are you naming the limiting dimension, writing throughput and latency numbers on the board, and parking out-of-scope items deliberately?",
    },
    {
      n: 2,
      title: "Interface and Policy Model",
      minutes: 5,
      goal: "Define the library interface, the rule schema, and justify token bucket with a one-line rejection of the alternatives — before being asked.",
      why: "The interviewer wants to see you commit to a tiny, well-shaped interface and defend the algorithm choice with the memory/accuracy tradeoff, not just name-drop 'token bucket'.",
      steps: [
        { kind: "WRITE", text: 'Write the library call: **"checkLimit(key, route) → { allowed, remaining, resetAt }"**, and the admin surface: **"PUT /limits/{scope} { limit, window, burst, algorithm }"**.' },
        { kind: "DRAW", text: 'Sketch the rule shape: **"scope (user/tier/route)"**, **"limit"**, **"window"**, **"algorithm"**, **"burst"**. Say: "Rules are versioned and pushed, not hardcoded, so limits change without a redeploy."' },
        { kind: "SAY", text: 'Justify token bucket: "O(1) memory per key, smooth sustained rate, and a bounded burst allowance." Write **"token bucket: refill rate + burst capacity"** on the board.' },
        { kind: "RULE OUT", text: '"Fixed window lets a client send 2× the limit right at the boundary." "Sliding window log is perfectly accurate but O(n) memory per key — doesn\'t scale to 50M keys." Cross both off.' },
      ],
      grading: "A crisp library interface, an explicit rule schema, and bringing the algorithm tradeoff forward instead of waiting to be asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: the decision path, the config path, and the async/analytics path. Label arrows with latency and throughput, not just box names.",
      why: "Drawing decision, config, and async sync as separate lanes proves you understand they have different SLAs. Candidates who draw one blob miss that config propagation and decision-logging must never sit on the hot decision path.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **decision path**: Client → API Gateway → Rate Limiter Lib → Local Token Cache → (miss) Redis Cluster → decision. Label arrows **"<1ms added"**, **"local check first"**, **"Lua atomic"**.' },
        { kind: "DRAW", text: 'Add the **config path** as a separate lane: Admin → Config Service → Postgres → pub/sub push → Rate Limiter Lib, labeled **"<5s propagation, no redeploy"**.' },
        { kind: "DRAW", text: 'Add the **async path** dropping off the limiter: → Kafka → Flink/abuse detection, plus Redis → Cross-Region Sync, dashed, labeled **"async, never blocks a decision"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different SLAs — decisions are latency-critical, config changes are eventually-consistent, and analytics/cross-region sync is fully async."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with latency and throughput, and an explicit statement that config and analytics never sit on the decision path.",
    },
    {
      n: 4,
      title: "Deep Dive: Algorithm and Atomicity",
      minutes: 8,
      goal: "Walk through token bucket mechanics and show the check-then-increment race, then the Lua script that closes it.",
      why: "This is the signature correctness sub-problem. The interviewer is probing whether you understand that a distributed counter check is not automatically atomic, and whether you can name the exact fix.",
      steps: [
        { kind: "SAY", text: 'Explain token bucket: "A bucket refills continuously at the sustained rate and holds up to a burst capacity. Every request spends one token; if none are left, deny." Draw the refill-rate + capacity pair.' },
        { kind: "DRAW", text: 'Draw the race: two nodes both read count=99, limit=100, both decide "under limit," both increment. "Now 101 requests got through on a 100 limit."' },
        { kind: "SAY", text: 'Introduce the fix: "Bundle GET, the limit check, INCR, and EXPIRE into one Redis Lua script. Redis runs it as a single atomic unit on one shard — no other command interleaves."' },
        { kind: "RULE OUT", text: '"Plain INCR alone is atomic, but the surrounding check-and-expire logic isn\'t, so the race reopens between separate calls." Cross it off as insufficient alone.' },
      ],
      grading: "Token bucket mechanics explained without prompting, the race drawn concretely with numbers, and the Lua-script fix named as a single atomic operation.",
    },
    {
      n: 5,
      title: "Deep Dive: Distributed Consistency and Failure Modes",
      minutes: 7,
      goal: "Walk the local-cache-plus-async-sync tradeoff with a quantified overshoot bound, then volunteer fail-open with local fallback and the thundering-herd retry problem.",
      why: "This is where L5 vs L6 gets decided. Anyone can say 'cache it'. The interviewer wants the bounded-overshoot number stated proactively, plus the operational failure-mode plan, without being asked.",
      steps: [
        { kind: "SAY", text: 'Volunteer the sync tradeoff: "Every request touching Redis synchronously would add 1-2ms and cap the whole fleet at Redis\'s throughput. Instead, each node keeps a local count and syncs to Redis on a ~100ms interval." Quantify the overshoot bound.' },
        { kind: "SAY", text: 'Handle multi-region: "A synchronous global check would cost 100ms+ of WAN latency. Instead, weight the global budget across regions by traffic share, enforce locally, and reconcile async."' },
        { kind: "SAY", text: 'Volunteer the failure mode: "If Redis is unreachable, we fail open with a conservative local-only fallback bucket per node, detected by a circuit breaker in a few hundred milliseconds — never fail closed, since that turns a blip into a full outage."' },
        { kind: "SAY", text: 'Close with the retry-storm risk: "Fixed-window resets plus naive client retries synchronize a herd at the boundary. Token bucket burst capacity plus jittered Retry-After spreads that out."' },
      ],
      grading: "The overshoot bound stated in numbers, fail-open with local fallback volunteered unprompted, and the thundering-herd retry problem named with its fix.",
    },
    {
      n: 6,
      title: "Wrap: Tradeoffs, Pushback, and Close",
      minutes: 5,
      goal: "Name the accuracy-vs-latency spectrum explicitly, push back on an ambiguous requirement, and close with a one-sentence summary plus a parked-items list.",
      why: "Staff-level signal is treating the interviewer as a collaborator: naming the exact spot on the accuracy/latency tradeoff curve you chose, questioning whether a requirement is really global-strict or region-local-fine, and closing crisply rather than trailing off.",
      steps: [
        { kind: "SAY", text: 'State the tradeoff spectrum: "Strict synchronous Redis on every request is the most accurate and the slowest; local-only per-node limits are the fastest and least accurate. We picked local cache plus 100ms sync as the middle point, with a bounded overshoot."' },
        { kind: "SAY", text: 'Push back where useful: "Does this limit actually need to be exactly global, or is a regional approximation fine? That changes whether we need cross-region reconciliation at all."' },
        { kind: "SAY", text: 'Bring up the retry-storm mitigation unprompted if not covered yet: "Jittered Retry-After and burst capacity, so a wave of 429s doesn\'t become a synchronized spike."' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a token-bucket limiter with an embedded library, a local-cache-plus-async-sync layer to avoid a Redis round trip on every request, and fail-open local fallback. With more time I\'d cover cost-based limiting and sharding Redis past 50M keys."' },
      ],
      grading: "The tradeoff spectrum stated explicitly, at least one pushback on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working single-node design with a plausible algorithm, but the distributed race and the failure modes stay unaddressed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Names Redis and INCR as the storage/counting primitive.",
          "Picks token bucket or a similar algorithm and can describe it at a high level.",
          "Knows a 429 with some kind of retry signal should be returned.",
          "Sketches a rule shape (limit + window) per user or per key.",
          "Handles 'what if it needs to scale' by saying 'shard Redis'.",
        ],
        gaps: [
          "Doesn't surface the check-then-increment race across nodes at all.",
          "Treats Redis as always available; no fail-open/fail-closed discussion.",
          "One synchronous check per request, no discussion of the latency/throughput cost at 1M/sec.",
          "No comparison of algorithms — just names one without ruling out the others.",
          "Multi-region, if mentioned, is 'run Redis in each region' with no reconciliation story.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, defends the algorithm and atomicity choices with reasons, and addresses distributed consistency and failure modes when probed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes throughput, latency, and key-count numbers on the board within the first 5 minutes.",
          "Picks token bucket over fixed window and sliding log with a one-line reason for each rejection.",
          "Names the check-then-increment race and the Lua-script fix without heavy prompting.",
          "Proposes local cache + async sync to avoid a synchronous Redis call on every request.",
          "States fail-open as the right default when asked directly about a Redis outage.",
          "Mentions multi-region briefly, generally as 'also run Redis per region'.",
        ],
        gaps: [
          "Doesn't quantify the overshoot bound from async sync until the interviewer pushes for a number.",
          "Doesn't bring up the thundering-herd retry problem unless asked about client behavior.",
          "Treats multi-region as symmetric replication rather than weighted, traffic-aware regional budgets.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, quantifies every tradeoff proactively, and brings the operational maturity that separates a correct design from a production-ready one.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the accuracy-vs-latency tradeoff as a named spectrum, with the local-cache-plus-sync choice placed explicitly on it and the overshoot bound quantified (~5%).",
          "Brings up the check-then-increment race and its Lua-script fix unprompted, before the interviewer asks about correctness.",
          "Names fail-open with local fallback as the default, with a circuit breaker detecting the outage in a few hundred milliseconds — not just 'fail open'.",
          "Volunteers the thundering-herd retry problem and its fix (burst capacity, jittered Retry-After) without being asked about client behavior.",
          "Distinguishes strict billing-critical limits (worth eventual-consistency reconciliation) from ordinary limits (fine as regional approximations).",
          "Pushes back on ambiguous scope ('does this need to be exactly global, or is regional approximate fine?').",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Treating 'just use Redis INCR' as the whole design without addressing the check-then-increment race.",
      "Fail-closed as the default, so a Redis blip turns into a full API outage for every client.",
      "Ignoring the boundary-burst weakness of fixed-window counters on a route where precision actually matters.",
      "No local cache at all — every single request pays a synchronous cross-network Redis round trip.",
      "Assuming a perfectly accurate global limit across regions is free, ignoring WAN round-trip latency.",
      "No plan for a single hot key (one viral API key or IP) overwhelming a single Redis shard.",
      "No discussion of what happens when rejected clients retry — risking a self-inflicted thundering herd.",
    ],
    followUps: [
      {
        q: "Why token bucket over sliding window counter?",
        a: "Both are O(1) memory and both are reasonable defaults. The deciding factor is burst behavior: token bucket explicitly separates a sustained refill rate from a burst capacity, so a client that's been quiet can spend saved-up tokens in a legitimate burst. Sliding window counter approximates a smooth rate well but doesn't give you an intentional, tunable burst allowance — it just avoids the fixed-window boundary spike. For APIs where bursty-but-bounded traffic is expected (most real client behavior), token bucket's explicit burst knob is the better fit.",
      },
      {
        q: "How would you enforce a truly strict global limit — for example a hard partner quota that must never be exceeded — with zero overshoot?",
        a: "Drop the local-cache-plus-async-sync optimization for that specific limit and go fully synchronous against a single authoritative Redis (or a single-leader store) for that key, accepting the latency cost since it's a narrow, low-QPS quota, not the general 1M/sec path. The design point is that 'strict' and 'high-throughput-low-latency' are in tension, so you scope the expensive synchronous path to the specific limits that actually need zero overshoot, and keep the cheap approximate path for everything else.",
      },
      {
        q: "Redis itself needs to scale past one node — how do you shard 50M keys?",
        a: "Consistent hashing across the Redis Cluster's hash slots, keyed on the rate-limit key (user/API-key + route), so each key's counter always lands on the same shard and Lua scripts stay single-shard atomic (Redis Cluster's multi-key operations require same-slot keys, which a single counter key satisfies trivially). Resharding moves slot ranges, not individual key logic, and a hot key that overwhelms one shard is mitigated by the per-node pre-aggregation from the multi-region teardown, not by trying to spread one key across shards.",
      },
      {
        q: "What's the difference between rate limiting at the edge/CDN versus at the application gateway?",
        a: "Edge/CDN limiting (Cloudflare-style) operates on coarse signals — IP, ASN, request rate — before traffic even reaches your infrastructure, and is excellent for blunt volumetric abuse and DDoS-shaped traffic. It doesn't know about authenticated users, tiers, or per-route budgets, because that context doesn't exist at the edge. Application-gateway limiting has full request context (API key, user tier, route) and enforces the precise, product-defined budgets. In practice you want both: edge as a coarse first filter, application gateway as the precise enforcement point.",
      },
      {
        q: "What actually happens differently for a client that respects Retry-After versus one that hammers anyway?",
        a: "A well-behaved client reads X-RateLimit-Remaining and Retry-After and backs off, so it experiences occasional 429s but recovers smoothly and never gets further penalized. A client that ignores the signals and retries immediately keeps consuming tokens the moment they refill, staying perpetually rate-limited and, if the system tracks repeat-offender patterns via the async decision log, becomes a candidate for a stricter tier or a temporary IP-level block — the abuse-detection pipeline exists specifically to catch this pattern from the async decision log without slowing down the hot path.",
      },
      {
        q: "How would you support cost-based limiting, where different endpoints consume different amounts of a shared budget — e.g. GraphQL query complexity?",
        a: "Generalize the token bucket so a request spends a variable number of tokens instead of always spending exactly one — the query's estimated cost (computed from GraphQL query complexity analysis, or a fixed weight per REST endpoint) is passed into the same checkLimit call as the token cost. The Lua script and the rule schema barely change: instead of INCR by 1, INCR by cost, and compare against the same bucket capacity. The hard part shifts from the limiter itself to accurately estimating cost per request before execution.",
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
          "This is a distributed counter with a decision function: has this key spent its budget in this window? Everything expensive in the design — the algorithm choice, the atomic scripting, the local-cache-plus-sync layer, the multi-region story — exists to answer that one question at 1M decisions/sec with under a millisecond added latency, without ever becoming the thing that takes the API down.",
          "Anchor everything on four numbers: 1M decisions/sec, 50M active keys, sub-1ms added latency, and a bounded overshoot tolerance of around 5%. Every structural choice below is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Algorithm: why token bucket wins",
        body: [
          "Five algorithms are worth naming and four are worth rejecting with a specific reason. Fixed window is O(1) but allows up to 2× the limit right at a window boundary. Sliding window log is perfectly accurate but stores per-request timestamps, so memory grows with request volume per key — unbounded at 50M keys. Leaky bucket queues requests to smooth output, which is the wrong shape for a reject-fast request-response API.",
          "Sliding window counter and token bucket both hold O(1) state per key and both approximate well. Token bucket wins because it gives you an explicit, tunable burst capacity separate from the sustained rate — the shape real client traffic actually has — rather than just smoothing away the fixed-window boundary spike.",
        ],
      },
      {
        heading: "Atomicity: the race every distributed counter has",
        body: [
          "Two gateway nodes can both read a counter at 99-of-100, both decide 'admit', and both increment — 101 requests get through on a 100 limit. This isn't an edge case; at 1M decisions/sec fanned across hundreds of nodes, thousands of requests for the same key can land in the same millisecond.",
          "The fix is a Redis Lua script that bundles the read, the limit check, the increment, and the TTL set into one atomic unit — Redis executes a script to completion on a single shard with no other command interleaving. This is the same fix whether the underlying structure is a simple integer counter (token bucket) or a sorted set (sliding window log variant).",
        ],
      },
      {
        heading: "Placement and the local-cache-plus-sync hybrid",
        body: [
          "The check runs inside an embedded library in each API gateway node, not a standalone microservice — a dedicated service adds a network hop to every request and becomes a single point of failure for all traffic. The library checks a local, in-process cache first.",
          "The signature hard part is what backs that local cache: a synchronous Redis call on every request adds 1-2ms and caps the fleet's throughput at Redis's ceiling; a static per-node split of the limit breaks under uneven traffic. The answer is a local approximate counter, synced to Redis on a short interval (~100ms), with a bounded, explicitly-quantified overshoot tolerance rather than a promise of perfect enforcement.",
        ],
      },
      {
        heading: "Multi-region: hot keys and eventual global limits",
        body: [
          "A single popular key can drive disproportionate write traffic at one Redis shard — mitigated by pre-aggregating a node's writes for that key locally before syncing, so the shard sees one delta per node per interval instead of one write per request. A cross-region synchronous check adds 100ms+ of WAN latency and is rejected outright for the hot path.",
          "The practical answer is weighted per-region local budgets (sized by observed traffic share, rebalanced periodically) enforced locally, with async gossip or CRDT-style reconciliation for the rare limits that truly must be globally strict — accepting a short window of eventual consistency rather than paying synchronous coordination on every request.",
        ],
      },
      {
        heading: "Failure modes: fail open, and don't cause a retry storm",
        body: [
          "When the shared store is unreachable, fail-closed turns a blip into a full outage, and fail-open with no fallback removes protection at the worst possible moment. The right default is fail-open with a conservative, local-only fallback token bucket per node, switched in by a circuit breaker within a few hundred milliseconds and switched back automatically once Redis recovers.",
          "Separately, a technically-correct limiter can still manufacture its own overload: fixed-window resets plus naive client retries synchronize a herd at every boundary. Token bucket's burst capacity smooths admission against a sustained average, and a jittered Retry-After header spreads client retries instead of resyncing them — both are cheap, and both are exactly the kind of detail that separates a working design from a production-ready one.",
        ],
      },
    ],
  },
};
