import type { Problem } from "@/lib/types";

export const tinder: Problem = {
  slug: "tinder",
  num: "6.4",
  title: "Design Tinder",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design the swipe-and-match core of a dating app: 60M daily active users swipe 1.6B times a day (~18.5K/sec average, ~55K/sec peak), a mutual right-swipe must become a match within seconds, and every card shown has to be a nearby, unswiped, preference-matched profile served fast enough to feel instant as a user flicks through the deck.",
  ],
  hardParts:
    "The hard parts: detecting a mutual match in real time without scanning a swipe table, generating a geo-filtered, ranked candidate queue fast enough to never stall the swipe deck, and keeping a handful of wildly popular profiles from melting one write partition or flooding everyone else's feed.",
  keyTopics: [
    "Precomputed Candidate Queues",
    "Geohash / S2 Candidate Sharding",
    "Point-Lookup Match Detection",
    "Hot-Profile Skew Mitigation",
    "Fire-and-Forget Notification Fanout",
  ],
  foundationsReferenced: [
    { label: "Cassandra", tone: "blue" },
    { label: "Geohashing / S2 Cells", tone: "green" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Redis / Valkey", tone: "purple" },
    { label: "Kafka & Stream Processing", tone: "orange" },
    { label: "Idempotency & Conditional Writes", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "mobile app", col: 1, row: 2, tone: "slate" },
      { id: "lb", label: "Regional LB", col: 2, row: 2, tone: "slate" },
      {
        id: "discovery",
        label: "Discovery Service",
        sub: "stateless · feed fetch",
        col: 3,
        row: 1,
        tone: "green",
      },
      {
        id: "queueCache",
        label: "Redis Queue Cache",
        sub: "~500 precomputed candidates/user",
        col: 4,
        row: 1,
        tone: "green",
      },
      {
        id: "esGeo",
        label: "Elasticsearch",
        sub: "geohash + preference filter",
        mono: "refill on cache miss",
        col: 5,
        row: 1,
        tone: "blue",
      },
      {
        id: "swipe",
        label: "Swipe Service",
        sub: "stateless · write + match check",
        col: 3,
        row: 2,
        tone: "purple",
      },
      {
        id: "swipeStore",
        label: "Cassandra",
        sub: "swipe log + matches · partitioned by swiper_id",
        col: 4,
        row: 2,
        tone: "blue",
      },
      {
        id: "matchSvc",
        label: "Match Service",
        mono: "conditional write, dedupe race",
        col: 5,
        row: 2,
        tone: "purple",
      },
      { id: "kafka", label: "Kafka", sub: "swipe + match events", col: 2, row: 3, tone: "orange" },
      {
        id: "recoJob",
        label: "Flink / Spark",
        sub: "recompute queues, desirability score",
        col: 3,
        row: 3,
        tone: "orange",
      },
      { id: "push", label: "Push Gateway", sub: "APNs / FCM · WebSocket", col: 5, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "lb", label: "GET /feed", kind: "read" },
      { from: "client", to: "lb", label: "POST /swipe", kind: "write" },
      { from: "lb", to: "discovery", label: "feed request", kind: "read" },
      { from: "discovery", to: "queueCache", label: "~95% hit · pop next 20", kind: "read" },
      { from: "queueCache", to: "esGeo", label: "miss → geo + filter query", kind: "read" },
      { from: "lb", to: "swipe", label: "swipe event", kind: "write" },
      { from: "swipe", to: "swipeStore", label: "insert swipe · LOCAL_QUORUM", kind: "write" },
      { from: "swipe", to: "swipeStore", label: "point lookup: did target already like me?", kind: "read" },
      { from: "swipe", to: "matchSvc", label: "mutual like → create match", kind: "write" },
      { from: "matchSvc", to: "swipeStore", label: "insert match row · conditional write on (min,max)", kind: "write" },
      { from: "matchSvc", to: "push", label: "fire-and-forget · notify both users", kind: "analytics" },
      { from: "swipe", to: "kafka", label: "swipe/match event, fire-and-forget", kind: "analytics" },
      { from: "kafka", to: "recoJob", label: "stream", kind: "analytics" },
      { from: "swipeStore", to: "recoJob", label: "swipe history batch", kind: "analytics" },
      { from: "recoJob", to: "queueCache", label: "refill top-N candidates/user", kind: "analytics" },
      { from: "recoJob", to: "esGeo", label: "update desirability score", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · feed fetch, ~2.8K batches/sec peak" },
      { kind: "write", text: "write path · swipe + match, ~55K/sec peak" },
      { kind: "analytics", text: "async · queue refill, scoring, notification fan-out — never blocks a swipe" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "lb", "discovery", "swipe"],
      say: "Two stateless services split from the start: Discovery serves the candidate feed, Swipe records the write. Unlike a typical 100:1 read-heavy app, these run at nearly the same rate — every card shown gets swiped.",
    },
    {
      reveal: ["queueCache", "esGeo"],
      say: "The swipe deck never waits on a live geo query. A background job keeps a queue of ~500 ranked candidates per user in Redis; Elasticsearch's geohash index is only touched to refill that queue, not on every card pull.",
    },
    {
      reveal: ["swipeStore"],
      say: "Cassandra holds the swipe log, partitioned by swiper_id. That partitioning is what turns 'did they already like me back' into a single-partition point lookup instead of a scan.",
    },
    {
      reveal: ["matchSvc", "push"],
      say: "On a mutual like, Swipe hands off to Match Service, which does a conditional write on the unordered pair so a simultaneous double-swipe can't create two match rows, then fires an async notification through the Push Gateway — never on the swipe's critical path.",
    },
    {
      reveal: ["kafka", "recoJob"],
      say: "Swipe and match events stream through Kafka into Flink/Spark, which recomputes ranked candidate queues and dampens popularity scores — async, so a lag here never stalls a swipe.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Swipe right (like) or left (pass) on the next candidate in the deck", tag: "P0" },
      { id: "FR-02", text: "Detect a mutual right-swipe and create a match the instant the second swipe lands", tag: "P0" },
      { id: "FR-03", text: "Push a real-time match notification to both users", tag: "P0" },
      { id: "FR-04", text: "Serve a ranked, geo-filtered discovery queue (distance, age range, gender preference)", tag: "P0" },
      { id: "FR-05", text: "Never resurface a profile the user has already swiped on", tag: "P0" },
      { id: "FR-06", text: "Profile CRUD: photos, bio, location, preferences", tag: "P0" },
      { id: "FR-07", text: "Super Like — a distinct, higher-signal action surfaced to the recipient with priority", tag: "P1" },
      { id: "FR-08", text: "Rewind — undo the last swipe (rate-limited / paid feature)", tag: "P1" },
      { id: "FR-09", text: "1:1 chat between two matched users", tag: "P1" },
      { id: "FR-10", text: "Free-tier daily swipe cap; unlimited swipes for paid tier", tag: "P1" },
      { id: "FR-11", text: "Unmatch, block, and report a user", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Swipe write ack (record + match check), server-side", tag: "p99 < 150ms" },
      { id: "NFR-02", text: "Discovery queue fetch, cache hit", tag: "p99 < 80ms" },
      { id: "NFR-03", text: "Latency from second like to push notification on both devices", tag: "< 2s" },
      { id: "NFR-04", text: "Swipe throughput, sustained peak (evening surge)", tag: "55K/sec" },
      { id: "NFR-05", text: "Availability (about 4.5 hrs downtime per year)", tag: "99.95%" },
      { id: "NFR-06", text: "Durability: no lost swipes or matches", tag: "zero loss" },
      { id: "NFR-07", text: "Geospatial radius accuracy at dense urban density", tag: "within ~1km" },
      { id: "NFR-08", text: "Candidates served per feed-fetch call (amortizes the geo query)", tag: "20:1" },
      { id: "NFR-09", text: "Daily swipe volume across the platform", tag: "1.6B/day" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: this is not a 100:1 read-heavy system",
      body: [
        "Before picking components, get the shape of the traffic right, because it is not what most candidates assume. 60M DAU swipe 1.6B times a day: about 18.5K/sec average, roughly 55K/sec at the evening peak. Unlike a URL shortener, reads and writes here are nearly 1:1 — every card shown gets swiped, so a 'candidate view' and a 'swipe write' happen at almost the same rate. The lever that keeps this affordable is batching: the feed-fetch API returns 20 precomputed candidates per call, so the expensive geo-ranked query only runs once per 20 swipes, roughly 80M batch calls/day, ~930/sec average, ~2.8K/sec peak.",
      ],
      bullets: [
        { lead: "Swipes", text: "1.6B/day, ~50% right-swipes (likes) → 800M likes/day, the volume that drives match-check lookups." },
        { lead: "Matches", text: "~3% of likes are mutual → ~24M matches/day, ~280/sec average, ~800/sec peak." },
        { lead: "Swipe log storage", text: "~80 bytes/row × 1.6B/day ≈ 130GB/day raw. Kept ~1 year for ranking/ML training: ~47TB raw, ~140TB at RF=3, spread across ~60 Cassandra nodes across regions." },
      ],
      pictureTitle: "Where does the 1.6B/day actually go?",
      pictureCaption: "1.6B swipes → 800M likes → 24M matches (~3% of likes convert)",
      pictureRows: [
        { label: "Swipes/day", value: "1.6B (~18.5K/s avg, ~55K/s peak)", tone: "neutral" },
        { label: "Likes/day (drive match-check)", value: "800M (~9.3K/s avg, ~28K/s peak)", tone: "used" },
        { label: "Matches/day", value: "24M (~280/s avg, ~800/s peak)", tone: "good" },
      ],
      remember: {
        problem: "Size a system where reads and writes are nearly 1:1, not the usual read-heavy skew.",
        solution: "Batch candidate fetches (20 per call) to decouple expensive geo-ranking queries from the swipe rate.",
        why: "Every card shown gets swiped, so 'serve a candidate' and 'record a swipe' happen at almost the same frequency — the only free lunch is amortizing the read over a batch.",
        tradeoff: "A stale batch can include a candidate someone else just matched with or who went offline; the client just skips it.",
        failure: "Query the geo-ranker on every single swipe and you 20x the load on Elasticsearch for no benefit.",
        mitigation: "Precompute and cache queues of ~500 candidates per active user, refilled by a background job well before they run dry.",
      },
    },
    {
      n: 2,
      title: "Match detection: kill three options, defend one",
      body: [
        "When A swipes right on B, the system must know, instantly and without a scan, whether B already swiped right on A. Put the candidates on the board and rule them out.",
      ],
      bullets: [
        { lead: "Scan B's swipe history", text: "linear scan of every swipe B has ever made looking for A. Unbounded cost, gets worse the longer B has used the app. Rejected." },
        { lead: "Batch match job", text: "run a nightly job that joins the swipe table against itself for mutual likes. Correct, but matches would take up to 24 hours to surface — kills the product's signature 'it's a match!' moment. Rejected." },
        { lead: "Global likes cache with no schema discipline", text: "dump every like into one Redis hash and scan it per check. Works at small scale, but a single shared structure becomes the bottleneck and a single point of loss. Rejected." },
        { lead: "Point lookup on a swiper-partitioned table", text: "store swipes with swiper_id as the partition key and swipee_id as the clustering key. When A likes B, do one query — SELECT action FROM swipes WHERE swiper_id = B AND swipee_id = A — a single-partition, exact-key read. If it returns 'like', it's a match. Winner." },
      ],
      pictureTitle: "Match detection: kill three, keep one",
      pictureRows: [
        { label: "Scan B's history", value: "unbounded cost per check → reject", tone: "bad" },
        { label: "Nightly batch join", value: "correct but up to 24h late → reject", tone: "bad" },
        { label: "One shared likes cache", value: "single point of loss/bottleneck → reject", tone: "bad" },
        { label: "Point lookup, swiper-partitioned", value: "O(1), instant → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Detect a mutual like instantly without scanning a swipe table.",
        solution: "Partition swipes by swiper_id, cluster by swipee_id; on every right-swipe, do one exact-key read for the reverse pair.",
        why: "A single-partition point lookup is O(1) regardless of table size, and it needs no coordination or secondary index.",
        tradeoff: "Every right-swipe now pays one extra read on the write path (left-swipes/passes skip it entirely).",
        failure: "Two users swiping each other within milliseconds could both observe 'not yet matched' and each try to create the match row, producing a duplicate.",
        mitigation: "Create the match with a conditional write keyed on the unordered pair (min(A,B), max(A,B)), so the second writer's insert is rejected instead of duplicating the match.",
      },
    },
    {
      n: 3,
      title: "Geospatial discovery: geohash cells, not a live radius scan",
      body: [
        "A candidate query is 'people within R km, matching my age/gender filters, that I haven't swiped.' Running that as a live geo-scan against 60M profiles on every card would blow the latency budget. Instead, profiles are indexed into geohash (or S2) cells in Elasticsearch, so 'nearby' becomes 'a handful of adjacent cells,' turning a scan into an index lookup plus a small merge.",
      ],
      bullets: [
        { lead: "Cell precision", text: "geohash precision is chosen so a cell is roughly city-block sized in dense metros and much larger in rural areas — one fixed precision would either explode cell count in Manhattan or be useless in rural Montana." },
        { lead: "Boundary problem", text: "a candidate one meter across a cell edge is technically 'nearby' but lives in the adjacent cell. Query the center cell plus its 8 neighbors, not just one cell, to avoid silently dropping valid candidates near the edge." },
        { lead: "Dynamic radius", text: "in a sparse area, expand the ring of cells searched until enough candidates are found; in Manhattan, a 2km radius already has more candidates than needed, so cap and rank instead." },
        { lead: "Exclusion filter", text: "already-swiped IDs are passed into the ES query as a filter clause so they never round-trip back to the client at all — cheaper than filtering client-side or after the fact." },
      ],
      pictureTitle: "Geo query: cell lookup, not scan",
      pictureRows: [
        { label: "Live radius scan over 60M profiles", value: "too slow for a per-batch call → reject", tone: "bad" },
        { label: "Single geohash cell", value: "drops valid candidates near the edge", tone: "bad" },
        { label: "Center cell + 8 neighbors", value: "correct coverage, still index-only", tone: "good" },
        { label: "Dynamic radius by density", value: "same code, rural vs. urban", tone: "good" },
      ],
      remember: {
        problem: "Find nearby, filtered, unswiped candidates fast enough for an interactive swipe deck.",
        solution: "Geohash/S2 cell index in Elasticsearch; query the center cell plus neighbors, with a dynamic radius and an already-swiped exclusion filter.",
        why: "Turning 'radius' into 'a few adjacent cells' converts an O(N) scan into an index lookup, and querying neighbor cells avoids dropping candidates that sit just across a cell boundary.",
        tradeoff: "Cell precision is a compromise — one size doesn't fit both a dense city and a rural county, so it has to flex by local profile density.",
        failure: "Query only the exact cell a user is in and you systematically undercount candidates near every cell edge, worse in sparse areas where cells are large.",
        mitigation: "Always expand to the 3×3 neighborhood of cells, and grow the ring further whenever the candidate count comes back low.",
      },
    },
    {
      n: 4,
      title: "Precomputed queues: why the swipe deck never waits on a geo query",
      body: [
        "If every card pull ran the geo + preference + exclusion query live, the swipe deck would stall on the slowest dependency in the system every single card. Instead, a background job precomputes and caches a queue of ~500 ranked candidates per active user in Redis; the client just pops the next 20 off that queue, and refill happens asynchronously well before the queue runs dry.",
      ],
      bullets: [
        { lead: "Decoupling", text: "the interactive path (pop next candidate) is now a Redis read, sub-10ms; the expensive path (rank + geo-filter) moved entirely off the request path." },
        { lead: "Refill trigger", text: "when a user's cached queue drops below a low-water mark (~50 remaining), a job re-runs the geo + ranking query and tops it back up — before the user notices, not after." },
        { lead: "Staleness is acceptable here", text: "unlike a bank balance, a slightly stale candidate list is a non-issue — worst case, the client swipes on someone who just went offline or matched someone else, and that swipe simply doesn't produce a match." },
      ],
      pictureTitle: "Card pull: cache pop vs. live query",
      pictureRows: [
        { label: "Live geo query per card", value: "every pull pays the slowest dependency", tone: "bad" },
        { label: "Precomputed Redis queue", value: "sub-10ms pop, refilled async", tone: "good" },
        { label: "Refill at low-water mark", value: "user never sees an empty deck", tone: "good" },
      ],
      remember: {
        problem: "Keep the swipe deck feeling instant without running an expensive query on every card.",
        solution: "Precompute ranked candidate queues per user in Redis; pop for reads, refill asynchronously before the queue empties.",
        why: "Cache-ahead moves the expensive work off the interactive path entirely, the same move as the URL shortener's three-layer cache — expensive work happens once, cheap work happens on every request.",
        tradeoff: "The queue can go slightly stale (an offline user, a taken match); acceptable because a card that doesn't pan out just gets skipped.",
        failure: "If the refill job falls behind (say, during the evening peak when swiping triples), users hit an empty queue and the deck visibly stalls.",
        mitigation: "Refill on a low-water mark, not on empty, and scale the refill job's throughput ahead of the known evening surge.",
      },
    },
    {
      n: 5,
      title: "Hot-profile skew: the load-bearing risk",
      body: [
        "The whole design assumes candidate popularity is roughly even — most users get liked by a small, similar fraction of the people who see them. That assumption breaks for a small number of unusually popular profiles, and when it breaks it stresses two different parts of the system at once: the match-check read path and the fairness of the feed itself. Say this risk out loud the way you'd name the Zipf assumption in a caching system — it's the same shape of problem.",
      ],
      bullets: [
        { lead: "Read hot-partition", text: "the match-check lookup is WHERE swiper_id = <target> AND swipee_id = <me>. If one profile gets liked by 50K people in an hour, that target's partition absorbs 50K point reads concentrated on one Cassandra partition — a hot-partition read spike, not a write spike." },
        { lead: "Feed unfairness", text: "if the ranking job over-weights raw like-count, popular profiles get shown even more, starving everyone else's visibility and making the app feel repetitive for the majority of users." },
        { lead: "Cap and dampen", text: "cap how often any single profile can be surfaced per hour regardless of its score, and dampen (not remove) the like-count signal in ranking so early popularity doesn't compound forever." },
      ],
      pictureTitle: "What happens when one profile goes viral?",
      pictureRows: [
        { label: "Normal profile", value: "reads spread evenly across partitions", tone: "good" },
        { label: "Viral profile, no cap", value: "one partition takes 50K reads/hr", tone: "bad" },
        { label: "Viral profile, capped exposure", value: "surfaced at a fixed max rate, load flattens", tone: "good" },
      ],
      remember: {
        problem: "A small number of hot profiles can overload one Cassandra partition and dominate everyone's feed.",
        solution: "Cap how often any profile is surfaced per hour, and dampen raw popularity in the ranking score.",
        why: "Uncapped popularity compounds: more exposure → more likes → higher score → even more exposure, which both skews fairness and concentrates reads on one partition key.",
        tradeoff: "Capping means a genuinely great profile gets slightly less reach than an unbounded ranking would give it.",
        failure: "No cap: one viral profile pushes 50K point reads/hr onto a single partition and gets shown to a disproportionate share of the user base.",
        mitigation: "Per-profile exposure cap plus a diminishing-returns curve on the popularity signal in the recommendation job.",
      },
    },
    {
      n: 6,
      title: "Notifications: async, but tier-1.5, not tier-3",
      body: [
        "Match creation itself must be synchronous with the swipe write — the whole product depends on the second swiper immediately learning 'it's a match!' But delivering the push notification (APNs/FCM) or WebSocket event is a separate, async step off the swipe write's critical path, so a notification-provider hiccup never slows down or fails a swipe ack.",
      ],
      bullets: [
        { lead: "Swipe ack is fast", text: "the client gets its 'swipe recorded' response the moment the row is written and the match check completes — it does not wait for the notification to be delivered." },
        { lead: "Fire-and-forget fan-out", text: "the Match Service publishes a match event; a fan-out step delivers it over an open WebSocket if the user is active, or a push notification via APNs/FCM if they're not." },
        { lead: "Not the same tier as analytics", text: "unlike click analytics in a read-heavy system, match notification has a real user-facing SLA (< 2s), so it isn't best-effort background work — it just doesn't sit inline with the swipe write." },
      ],
      pictureTitle: "Swipe ack vs. notification delivery",
      pictureRows: [
        { label: "On the swipe write path", value: "notification hiccup would fail a swipe", tone: "bad" },
        { label: "Async fan-out after match creation", value: "swipe ack unaffected, delivery still < 2s SLA", tone: "good" },
        { label: "Notification provider down", value: "swipes and matches keep working; retry queue catches up", tone: "neutral" },
      ],
      remember: {
        problem: "Deliver a real-time match alert without adding notification-provider latency to every swipe.",
        solution: "Synchronous match creation, asynchronous notification fan-out (WebSocket if active, push if not).",
        why: "The swipe write and match creation are the product's core guarantee; delivery is a downstream step that can retry independently.",
        tradeoff: "A user can, in rare cases, see 'it's a match' a couple seconds late if the push provider is degraded — acceptable, a failed swipe write is not.",
        failure: "Coupling the push send to the swipe write means an APNs/FCM outage takes down the entire swipe path with it.",
        mitigation: "Publish the match event to a queue with retry/backoff; keep the swipe API's success path independent of notification delivery.",
      },
    },
    {
      n: 7,
      title: "Why Cassandra, and why swiper_id is the partition key",
      body: [
        "The swipe log is a giant, append-only, write-heavy table: ~1.6B new rows a day, ~130GB/day raw, ~47TB/year, ~140TB at RF=3. The choice that makes both the write path and the match-check read path work is the partition key: swiper_id, clustering by swipee_id.",
      ],
      bullets: [
        { lead: "Write path", text: "swipes are naturally spread across partitions because every user swipes independently — no single partition absorbs disproportionate write load under normal conditions." },
        { lead: "Read path", text: "the match-check query (swiper_id = target, swipee_id = me) is a single-partition, exact-clustering-key read — exactly the access pattern Cassandra's LSM-tree design serves cheaply." },
        { lead: "LSM over B-tree", text: "an append-heavy workload with almost no updates or deletes plays to Cassandra's strength — writes are sequential appends to a commit log plus memtable, not random-access page writes." },
        { lead: "Consistency levels", text: "LOCAL_QUORUM on writes for durability, LOCAL_ONE on the match-check read since a slightly-stale 'not yet matched' just means the match surfaces on the next swipe instead — never a false positive." },
      ],
      pictureTitle: "Why swiper_id as the partition key",
      pictureRows: [
        { label: "Writes", value: "spread evenly, every user writes independently", tone: "good" },
        { label: "Match-check read", value: "single-partition, exact key — cheap", tone: "good" },
        { label: "Hot profile (as target)", value: "reads concentrate on their partition — the one real risk", tone: "bad" },
      ],
      remember: {
        problem: "Store a 1.6B-row/day append-only log and serve instant point lookups against it.",
        solution: "Cassandra, partitioned by swiper_id and clustered by swipee_id, LOCAL_QUORUM writes / LOCAL_ONE reads.",
        why: "This partitioning makes writes naturally spread and makes the match-check exactly the single-partition read Cassandra is built for.",
        tradeoff: "The same key choice is what makes hot-profile skew a read hot-partition problem instead of a write problem — worth naming as the tradeoff, not a surprise.",
        failure: "Partitioning by swipee_id instead would make every read for 'who liked me' cheap but concentrate all of a popular profile's incoming likes as writes on one partition.",
        mitigation: "Keep swiper_id as the partition key and handle popularity skew with the exposure cap from the ranking job, not with a different schema.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "Reads and writes are nearly 1:1 here, not read-heavy like a typical system — every card shown gets swiped, so the win is batching 20 candidates per fetch to amortize the expensive geo query.",
      "A mutual match is detected with one single-partition point lookup (swiper_id = target, swipee_id = me), not a scan, keyed by partitioning swipes on swiper_id.",
      "Nearby candidates come from a geohash/S2 cell index in Elasticsearch, querying the center cell plus neighbors so nothing near a boundary gets dropped, then get cached ahead of time in Redis so the swipe deck never waits on that query live.",
      "The load-bearing risk is hot-profile skew: a viral profile can dump tens of thousands of point reads on one Cassandra partition and dominate everyone's feed unless exposure is capped.",
      "Match creation is synchronous with the swipe write; notification delivery (push/WebSocket) is async off that path, so a notification-provider outage never breaks a swipe.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · FEED FETCH · ~2.8K BATCHES/S PEAK",
        summary:
          "The client asks for the next batch of candidates. Almost every request is answered straight out of a per-user Redis queue that was already computed ahead of time; Elasticsearch is only touched to refill that queue.",
        steps: [
          { label: "Client", note: "requests next batch of candidates" },
          { label: "Regional LB", note: "routes to a nearby pod" },
          { label: "Discovery Service", note: "stateless" },
          { label: "Redis Queue Cache", note: "~95% hit, pop next 20" },
          { label: "Elasticsearch", note: "miss → geohash cell + neighbor query, filters + exclusions" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · SWIPE + MATCH · ~55K/S PEAK",
        summary:
          "Every swipe is recorded. A right-swipe also triggers one point lookup to check whether the target already liked back; if so, a conditional write creates the match exactly once.",
        steps: [
          { label: "Client", note: "swipes right or left" },
          { label: "Regional LB", note: "nearby region" },
          { label: "Swipe Service", note: "stateless" },
          { label: "Cassandra insert", note: "LOCAL_QUORUM, partitioned by swiper_id" },
          { label: "Point lookup (right-swipes only)", note: "swiper_id = target, swipee_id = me, LOCAL_ONE" },
          { label: "Match Service", note: "conditional write to Cassandra on unordered pair (min,max), dedupes the race" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · QUEUE REFILL, SCORING, NOTIFICATIONS · NEVER BLOCKS A SWIPE",
        summary:
          "Two separate async branches off the write path: swipe events stream to Kafka for queue refill and scoring, while match notifications go straight from the Match Service to the Push Gateway without waiting on that stream.",
        steps: [
          { label: "Swipe Service", note: "emits swipe + match events to Kafka, fire-and-forget" },
          { label: "Kafka", note: "swipe + match event stream" },
          { label: "Flink/Spark", note: "recomputes ranked candidate queues, dampens popularity signal" },
          { label: "Redis Queue Cache", note: "refilled before the low-water mark" },
          { label: "Match Service", note: "separately, fires the match notification directly — does not wait on the Kafka pipeline" },
          { label: "Push Gateway", note: "APNs/FCM or WebSocket, target < 2s from match to alert" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "60M DAU, 1.6B swipes/day (~18.5K/s avg, ~55K/s peak)",
          "~800M likes/day, ~24M matches/day (~3% of likes convert)",
          "Swipe log: ~130GB/day raw, ~47TB/year, ~140TB at RF=3, ~60 Cassandra nodes",
          "Batch fetch: 20 candidates/call → ~80M batch calls/day, ~2.8K/s peak on Elasticsearch",
          "Candidate cache: ~500 precomputed candidates/user in Redis, refilled at a low-water mark",
          "Latency: sub-150ms swipe ack, sub-80ms cached feed fetch, sub-2s match-to-push",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Point-lookup match detection: partition swipes by swiper_id, cluster by swipee_id",
          "Conditional write on the unordered pair (min, max) to dedupe a simultaneous double-swipe",
          "Geohash/S2 cell index, query center cell + neighbors, dynamic radius by local density",
          "Precomputed Redis queues, not a live geo query on every card",
          "Exposure cap + dampened popularity signal in the ranking job",
          "Synchronous match creation, asynchronous notification fan-out",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Reads and writes are nearly 1:1 here — batching is what makes it cheap, not caching a skewed distribution",
          "Hot-profile skew is the load-bearing risk, both a read hot-partition problem and a feed-fairness problem",
          "Match creation is synchronous; notification delivery is async but still carries a real user-facing SLA",
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
      goal: "Get the traffic shape and scope locked before drawing anything — especially the fact that this is not a classic read-heavy system.",
      why: "The interviewer is checking whether you derive the design from the actual traffic shape. Getting the 1:1-ish read:write ratio right up front changes every downstream decision about caching and batching.",
      steps: [
        { kind: "ASK", text: '**"How many daily active users, and what\'s the swipe volume?"** Land on "60M DAU, 1.6B swipes/day". Write **"60M DAU, 1.6B swipes/day"** in the top-left corner.' },
        { kind: "SAY", text: 'Do the QPS math out loud: **"1.6B / 86,400s ≈ 18.5K/sec average, call it 55K/sec at the evening peak."** Write it down — do not keep it in your head.' },
        { kind: "SAY", text: 'Name the ratio explicitly: **"Reads and writes are nearly 1:1 here — every card shown gets swiped. That\'s different from a typical read-heavy system, and it changes what I optimize."**' },
        { kind: "SAY", text: 'State scope. In: "swiping", "match detection", "discovery/candidate feed", "match notification". Out: "chat message delivery internals", "payments", "photo verification/moderation". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Storage math out loud: **"1.6B swipes/day × ~80 bytes ≈ 130GB/day raw"**, **"~47TB/year, ~140TB at RF=3"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment: writing the numbers down, correctly identifying the near-1:1 read:write ratio as unusual, and scoping deliberately before drawing boxes.",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Three endpoints, two core tables, and the partition-key choice for swipes justified before it's questioned.",
      why: "The interviewer wants to see you commit to a schema and defend the one choice — the swipe table's partition key — that everything else (match detection, hot-key risk) hangs off of.",
      steps: [
        { kind: "WRITE", text: 'Write three endpoints: **"GET /feed"** → batch of candidates. **"POST /swipe { targetId, action }"** → ack + optional match. **"GET /matches"** → list.' },
        { kind: "DRAW", text: 'Sketch the swipe row: **"swiper_id (partition key)"**, **"swipee_id (clustering key)"**, **"action (like/pass)"**, **"created_at"**. Say: "Partitioning by swiper_id spreads writes evenly and makes the match-check a single-partition read."' },
        { kind: "DRAW", text: 'Sketch the match row: **"pair_key = min(A,B):max(A,B) (unique)"**, **"matched_at"**, **"user_a"**, **"user_b"**. Say: "The unordered pair key is what lets a conditional write dedupe a simultaneous double-swipe."' },
        { kind: "RULE OUT", text: 'Get ahead of the obvious alternative: "Partitioning by swipee_id would make \'who liked me\' cheap to read, but it concentrates every popular profile\'s incoming likes as writes on one partition — worse trade for this workload." Cross it off.' },
      ],
      grading: "Crisp endpoints, two clear schemas, and the partition-key choice defended with a reason, not just asserted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram, three labeled paths: candidate read, swipe write, and async fan-out. Label arrows with traffic share and latency budgets, not just box names.",
      why: "Drawing three lanes shows you understand these paths have different SLAs and failure tolerances. A candidate who draws one blob usually ends up putting notification delivery inline with the swipe write, which is the most common structural mistake in this design.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read lane**: Client → LB → Discovery Service → Redis Queue Cache → Elasticsearch (on miss). Label **"~95% cache hit"**, **"20 candidates/batch"**.' },
        { kind: "DRAW", text: 'Add the **write lane**: Client → LB → Swipe Service → Cassandra insert, then a point-lookup read back to Cassandra, then → Match Service on a hit, which writes the match row back to Cassandra with a conditional insert. Label **"LOCAL_QUORUM insert"**, **"LOCAL_ONE point lookup"**.' },
        { kind: "DRAW", text: 'Add the **async lane**, dashed: Swipe Service → Kafka → Flink/Spark → refills Redis Queue Cache; Match Service → Push Gateway. Label **"never blocks a swipe ack"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different tolerances — the swipe write must never fail silently, the read lane can be slightly stale, and the async lane can retry."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with concrete numbers, and an explicit statement that notification delivery is decoupled from the swipe write.",
    },
    {
      n: 4,
      title: "Deep Dive: Real-Time Match Detection",
      minutes: 8,
      goal: "Walk the point-lookup pattern and defend it against the obvious alternatives, then handle the race condition.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can turn 'detect a mutual event' into an O(1) operation and whether you notice the double-write race before they point it out.",
      steps: [
        { kind: "SAY", text: 'State the query: "On every right-swipe, one exact-key read: swiper_id = target, swipee_id = me. Single partition, no scan, LOCAL_ONE is fine because a stale \'no match yet\' just resolves on the next swipe."' },
        { kind: "RULE OUT", text: 'One line each: **scan swipe history** → unbounded cost. **nightly batch join** → correct but up to 24h late, kills the product moment. **one shared likes cache** → single point of failure at scale. Cross all three off.' },
        { kind: "ASK", text: '**"What if both users swipe right within the same few milliseconds?"** — raise it yourself if not asked. "Both point lookups could return \'not yet matched\' and both try to create the match."' },
        { kind: "SAY", text: 'Resolve it: "Match creation is a conditional write keyed on the unordered pair (min(A,B), max(A,B)). The second insert is rejected by the uniqueness constraint, so exactly one match row is ever created, and both swipers get notified from whichever write succeeded."' },
      ],
      grading: "The point-lookup query stated precisely, each rejected alternative given a real reason, and the double-write race surfaced and resolved without being prompted.",
    },
    {
      n: 5,
      title: "Deep Dive: Geospatial Discovery and Hot-Profile Skew",
      minutes: 7,
      goal: "Explain geohash cell querying with the boundary fix, then volunteer the hot-profile skew risk before being asked.",
      why: "Anyone can say 'index by location.' The interviewer wants the boundary-neighbor fix and, for the top score, the candidate naming hot-profile skew as the load-bearing risk unprompted — the same instinct as naming a Zipf assumption in a caching system.",
      steps: [
        { kind: "SAY", text: 'Explain the index: "Profiles are indexed into geohash cells in Elasticsearch. \'Nearby\' becomes \'a few adjacent cells\' — query the center cell plus its 8 neighbors so a candidate just across a cell boundary isn\'t silently dropped."' },
        { kind: "SAY", text: 'Explain precomputation: "This query runs in a background job, not on every swipe — results are cached as a queue of ~500 candidates per user in Redis, refilled before it runs low."' },
        { kind: "SAY", text: 'Volunteer the risk: "This all assumes candidate popularity is roughly even. A profile that goes viral breaks that two ways: reads for it concentrate on one Cassandra partition, and if ranking over-weights raw like-count, it also crowds out everyone else\'s feed."' },
        { kind: "SAY", text: 'State the mitigation with numbers: "Cap how often any single profile is surfaced per hour, and dampen the popularity signal in ranking so it doesn\'t compound — otherwise one profile can push tens of thousands of reads/hour onto a single partition."' },
      ],
      grading: "Geohash-plus-neighbors explained correctly, precomputation named as the reason the deck never stalls, and hot-profile skew volunteered and quantified without a hint.",
    },
    {
      n: 6,
      title: "Wrap: Tiers, Fairness, and Close",
      minutes: 5,
      goal: "Name the SLA split between swipe writes and notification delivery, push back on a requirement, and close with a crisp summary.",
      why: "Staff-level signal here is treating fairness (who gets shown) as a first-class requirement alongside latency, and closing the interview like a collaborator rather than running out the clock mid-thought.",
      steps: [
        { kind: "SAY", text: 'State the tiers: "Swipe write and match creation are the core guarantee, synchronous. Notification delivery is async but still carries a real < 2s SLA — it\'s not best-effort like a click-analytics pipeline, it just isn\'t inline."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need global 55K/sec, or is peak actually regional and staggered by time zone? That changes how much headroom each region\'s Cassandra ring needs."' },
        { kind: "SAY", text: 'Name the fairness angle unprompted: "Ranking isn\'t just a latency problem — an uncapped popularity signal makes the feed feel repetitive for most users, so exposure capping is a product requirement, not just a load-shedding trick."' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a near-1:1 read:write system built on a point-lookup match check, geohash-indexed precomputed candidate queues, and an exposure cap to stop hot profiles from dominating the feed. With more time I\'d cover chat delivery, abuse/fake-profile detection, and cross-region failover."' },
      ],
      grading: "Explicit tiering of swipe vs. notification, at least one pushback on requirements, fairness named as a first-class concern, and a crisp closing summary with parked items.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but the read:write shape and the matching race condition stay unexamined.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, cache, database, a queue for notifications.",
          "Knows a match requires checking both directions of a like.",
          "Adds a geo index (usually 'use Elasticsearch') when prompted about nearby users.",
          "Can write the swipe and match endpoints and a reasonable schema.",
          "Handles 'what about notifications' by adding a push service.",
        ],
        gaps: [
          "Assumes the system is read-heavy like a typical app without checking — misses that swipes and reads are nearly 1:1.",
          "Doesn't do the storage or QPS math out loud, or just says 'a lot of data'.",
          "Match detection is 'query the database' with no partition-key reasoning, often proposing a scan.",
          "Doesn't notice the double-swipe race condition unless the interviewer raises it.",
          "No plan for a popular profile beyond 'add more cache'.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks defaults with reasons, names trade-offs when asked, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes QPS, storage, and latency targets on the board within the first 5 minutes, and correctly flags the near-1:1 read:write ratio.",
          "Designs the swipe table partitioned by swiper_id specifically so the match-check is a single-partition read.",
          "Explains geohash/S2 cell indexing with the neighbor-cell fix for boundary candidates.",
          "Precomputes candidate queues rather than querying live on every card.",
          "Surfaces the double-swipe race condition and resolves it with a conditional write, when asked.",
          "Separates match creation (sync) from notification delivery (async) on the write path.",
        ],
        gaps: [
          "Names hot-profile skew only after the interviewer hints at 'what if one profile is really popular', not on their own.",
          "Doesn't connect hot-profile skew to the specific partition-key choice made earlier in the interview.",
          "Quantifies risk in words ('gets a lot of traffic') rather than numbers ('50K reads/hr on one partition').",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces risks before being asked, and treats fairness as a first-class requirement alongside latency.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers hot-profile skew as the load-bearing risk unprompted, tying it directly back to the swiper_id partition-key decision made earlier, with a quantified failure mode (tens of thousands of reads/hour on one partition).",
          "Frames exposure capping as a product/fairness requirement, not just a load-shedding hack — 'most users' experience degrades if popularity compounds unchecked.",
          "Explicitly separates 'synchronous core guarantee' (swipe + match) from 'async but still SLA'd' (notification), and explains why that's a different split than a typical best-effort analytics pipeline.",
          "Pushes back on requirements where appropriate ('is 55K/sec truly global peak, or regional and staggered by time zone?').",
          "Names the double-swipe race condition and its conditional-write fix before being asked.",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
          "Treats the interviewer as a collaborator: paces the 40 minutes, parks tangents, returns to them only if time allows.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Treating this as a standard read-heavy system and reaching straight for '100:1 cache everything' without checking the actual swipe:candidate ratio.",
      "Detecting matches with a scan or a nightly batch job, missing that the whole product depends on the match feeling instant.",
      "Partitioning the swipe table by swipee_id 'so I can see who liked me cheaply,' which concentrates every popular profile's incoming likes onto one write partition.",
      "Missing the double-swipe race condition entirely, or hand-waving it as 'the database will handle it' without a conditional write or uniqueness constraint.",
      "Putting notification delivery inline with the swipe write, so a push-provider outage takes the swipe path down with it.",
      "No hot-profile plan, so the first viral profile floods one partition with reads and dominates every other user's feed.",
      "Running the geo + preference + exclusion query live on every single card instead of precomputing and caching ahead.",
    ],
    followUps: [
      {
        q: "Why Cassandra and not a relational database with a unique index on (min_user, max_user)?",
        a: "A relational database could technically enforce match uniqueness with a constraint, but the swipe log itself is a 1.6B-row/day, append-only, near-zero-update workload — exactly what an LSM-tree store is built for, and exactly the workload that stresses a B-tree with random-access page writes. Cassandra also gives multi-region write availability without a single coordinator, which a traditional RDBMS primary/replica setup doesn't offer at this write volume.",
      },
      {
        q: "What happens if the candidate queue refill job falls behind during the evening peak?",
        a: "Users whose queues drop below the low-water mark before the job catches up will see the deck stall, because the fallback is a live Elasticsearch query, which is slower and adds load exactly when the system is already under peak pressure. The mitigation is provisioning the refill job's throughput ahead of the known evening surge (it's a predictable, recurring peak, not a surprise) and lowering the low-water mark trigger during known high-traffic windows so refills start earlier.",
      },
      {
        q: "How would you detect and cap a viral profile before it floods one partition?",
        a: "Track incoming-like rate per profile over a sliding window (e.g., likes in the last hour) in the streaming job that already consumes the Kafka swipe/match events; once a profile crosses a threshold, cap how often the ranking job will surface it going forward, independent of its raw score. The dampened score is what actually reduces the read pressure, since fewer people are shown the profile in the first place, which is more effective than trying to add more replicas to absorb the read spike after the fact.",
      },
      {
        q: "Could you use a global counter or a single 'likes' table keyed by recipient instead of the point-lookup pattern?",
        a: "A recipient-keyed table (partition by swipee_id) makes 'who liked me' cheap to read, but it's the wrong trade here: it concentrates every popular profile's incoming likes as writes on a single partition, exactly the hot-key problem we're trying to avoid, and this product's core loop is 'did the person I just liked already like me back,' which is a lookup keyed by the swiper, not a fan-in read. The chosen schema optimizes for the operation that happens on every single right-swipe, not the less time-critical 'who likes me' view.",
      },
      {
        q: "Why not just show every user candidates in a fixed radius, ignoring preferences, and filter client-side?",
        a: "That would return far more candidates than needed over the network, waste client bandwidth and battery, and — worse — could show a profile that violates a hard exclusion like blocked users, which is a trust and safety issue, not just an efficiency one. Filtering in the geo query itself (preferences and exclusions as filter clauses in the Elasticsearch query) means the wire only ever carries valid, unswiped, unblocked candidates.",
      },
      {
        q: "How would this change if you had to support undo (Rewind) at scale?",
        a: "A swipe is currently an insert-only fact; undo means either a soft-delete flag on the most recent row for that (swiper_id, swipee_id) pair or a compensating 'unswipe' event, and either way the match-check point lookup has to respect it — a rewound like must not still register as a match if the other side already liked back in that same window. The safer approach is a compensating event through the same conditional-write path used for match creation, so 'unswipe' and 'match' can never race each other into an inconsistent state.",
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
          "This is a near-1:1 read:write interactive system with two hard sub-problems bolted on: detect a mutual event instantly, and rank+filter a geospatial candidate pool fast enough to never stall an interactive deck. Unlike a typical read-heavy service, the win isn't 'cache aggressively because most requests repeat' — it's 'batch the expensive query because every card gets consumed exactly once.'",
          "Anchor everything on the numbers: 60M DAU, 1.6B swipes/day (~18.5K/sec avg, ~55K/sec peak), ~800M likes/day, ~24M matches/day, sub-150ms swipe ack, sub-2s match-to-notification. Every structural choice below is a consequence of these numbers.",
        ],
      },
      {
        heading: "Sizing and the read:write ratio",
        body: [
          "1.6B swipes/day means ~18.5K/sec average and ~55K/sec at the evening peak — three regions' evening peaks don't perfectly overlap globally, but any single region sees a sharp local surge. Because every card shown gets swiped, candidate-serving and swipe-recording happen at nearly the same rate, unlike a typical 100:1 read-heavy system.",
          "The lever is batching: one feed-fetch call returns 20 precomputed candidates, so the expensive geo+ranking query only runs once per 20 swipes — ~80M batch calls/day, ~2.8K/sec peak, two orders of magnitude below the swipe rate. Storage: ~130GB/day of swipe rows, ~47TB/year, ~140TB at RF=3 across ~60 Cassandra nodes.",
        ],
      },
      {
        heading: "Match detection without a scan",
        body: [
          "The swipe table is partitioned by swiper_id and clustered by swipee_id. On every right-swipe, one exact-key read — swiper_id = target, swipee_id = me — checks for the reverse like. That's a single-partition point lookup, O(1) regardless of table size, and it needs no secondary index or coordination.",
          "The remaining risk is a race: two users swiping each other within milliseconds could both observe 'not matched yet' and both attempt to create the match. The fix is a conditional write keyed on the unordered pair (min(A,B), max(A,B)) — the second insert is rejected by the uniqueness constraint, so exactly one match row is ever created.",
        ],
      },
      {
        heading: "Geospatial discovery and precomputed queues",
        body: [
          "Profiles are indexed into geohash (or S2) cells in Elasticsearch, turning 'find people within R km' into an index lookup over the center cell plus its 8 neighbors — the neighbor query matters because a valid candidate just across a cell boundary would otherwise be silently dropped. Radius expands dynamically in sparse areas and stays tight in dense ones.",
          "That query never runs live on the interactive path. A background job (Flink/Spark) precomputes a ranked queue of ~500 candidates per active user and caches it in Redis; the client pops from the queue (sub-10ms), and a refill triggers at a low-water mark before it runs dry. This is the same cache-ahead move as layered caching in a read-heavy system, applied to a compute-heavy query instead of a simple key lookup.",
        ],
      },
      {
        heading: "The load-bearing risk: hot-profile skew",
        body: [
          "The design assumes candidate popularity is roughly even. It breaks for unusually popular profiles in two ways at once: reads for the match-check concentrate on that profile's Cassandra partition (tens of thousands of point reads per hour is plausible for a viral profile), and if ranking over-weights raw like-count, that profile also crowds out visibility for everyone else in the feed.",
          "The mitigation is two-part: cap how often any single profile is surfaced per hour regardless of score, and dampen the popularity signal in the ranking job so early popularity doesn't compound indefinitely. This is the same shape of problem as a Zipf-distribution assumption breaking in a caching system — name it as the load-bearing bet, quantify the failure, and keep a mitigation ready.",
        ],
      },
      {
        heading: "Notification delivery and the tier split",
        body: [
          "Match creation is synchronous with the swipe write — the product's core promise is that a mutual like becomes a match immediately. Notification delivery (push via APNs/FCM, or a live WebSocket push if the user is active) is a separate async step off that path, so a notification-provider outage never fails or slows a swipe.",
          "This isn't the same as best-effort analytics, though — match notification carries a real user-facing SLA (< 2s), it's just decoupled rather than deprioritized. The Match Service publishes an event; a fan-out step delivers it with retry/backoff, independent of the swipe API's success path.",
        ],
      },
    ],
  },
};
