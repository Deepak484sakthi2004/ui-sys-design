import type { Problem } from "@/lib/types";

export const localDelivery: Problem = {
  slug: "local-delivery",
  num: "5.4",
  title: "Design a Local Delivery Service",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a local delivery platform (food, grocery, and parcels) that matches ~2,000 new orders/sec at peak to a pool of 500,000 active couriers pinging their location every ~4 seconds (~125,000 location updates/sec), assigns a courier within a few seconds of an order being ready, and gives the customer a live, smooth map of the courier's position until drop-off — all while never double-booking a courier and never letting one city's outage touch another.",
  ],
  hardParts:
    "The hard parts: matching orders to couriers in real time against a location index that's being rewritten 60x faster than it's being read from, guaranteeing a courier is never assigned to two orders at once when multiple dispatch workers race for the same candidate, and keeping the whole thing gracefully degradable — a courier who goes silent or declines, or a city whose Redis cluster falls over — without ever losing the order.",
  keyTopics: [
    "Geospatial Indexing (H3 + Redis)",
    "Real-Time Dispatch Matching",
    "Optimistic Concurrency for Assignment",
    "Location Ping Fan-In at Scale",
    "Geo-Sharded Regional Isolation",
  ],
  foundationsReferenced: [
    { label: "Redis Geo / H3 Hexagonal Grid", tone: "purple" },
    { label: "Optimistic Concurrency Control (CAS)", tone: "orange" },
    { label: "Consistent Hashing / Geo-Sharding", tone: "green" },
    { label: "Kafka", tone: "orange" },
    { label: "WebSockets & Pub/Sub Fan-Out", tone: "blue" },
    { label: "Postgres Row-Level Locking", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "customerApp", label: "Customer App", col: 1, row: 1, tone: "slate" },
      { id: "courierApp", label: "Courier App", col: 1, row: 3, tone: "slate" },
      { id: "wsGateway", label: "Tracking Gateway", sub: "WebSocket · per-order channel", col: 2, row: 1, tone: "blue" },
      { id: "apiGateway", label: "API Gateway", col: 2, row: 2, tone: "slate" },
      { id: "pingIngest", label: "Location Ping Ingest", sub: "Kafka · ~125K/s", col: 2, row: 3, tone: "orange" },
      { id: "orderSvc", label: "Order Service", sub: "stateless · writes order", col: 3, row: 2, tone: "purple" },
      { id: "geoUpdater", label: "Geo-Index Updater", sub: "Kafka consumer", col: 3, row: 3, tone: "orange" },
      {
        id: "dispatch",
        label: "Dispatch Service",
        sub: "matching engine",
        mono: "CAS assign · retry next candidate",
        col: 4,
        row: 2,
        tone: "green",
      },
      { id: "geoIndex", label: "Courier Geo Index", sub: "Redis · H3 res-8 cells", col: 4, row: 3, tone: "green" },
      { id: "eta", label: "Routing / ETA Engine", sub: "OSRM + traffic model", col: 5, row: 2, tone: "purple" },
      { id: "ordersDb", label: "Orders/Couriers DB", sub: "Postgres · geo-sharded by city", col: 5, row: 1, tone: "blue" },
    ],
    edges: [
      { from: "customerApp", to: "apiGateway", label: "place order", kind: "write" },
      { from: "apiGateway", to: "orderSvc", kind: "write" },
      { from: "orderSvc", to: "ordersDb", label: "insert order", kind: "write" },
      { from: "orderSvc", to: "dispatch", label: "order ready", kind: "write" },
      { from: "dispatch", to: "geoIndex", label: "k-ring radius query", kind: "read" },
      { from: "dispatch", to: "eta", label: "score candidates by ETA", kind: "read" },
      { from: "dispatch", to: "ordersDb", label: "assign · CAS update", kind: "write" },
      { from: "dispatch", to: "courierApp", label: "push offer · 20-30s to accept", kind: "write" },
      { from: "courierApp", to: "dispatch", label: "accept/decline", kind: "write" },
      { from: "customerApp", to: "wsGateway", label: "subscribe · order channel", kind: "read" },
      { from: "dispatch", to: "wsGateway", label: "assignment created", kind: "write" },
      { from: "geoUpdater", to: "wsGateway", label: "threshold-filtered location", kind: "read" },
      { from: "wsGateway", to: "customerApp", label: "live tracking push", kind: "read" },
      { from: "courierApp", to: "pingIngest", label: "location ping · ~4s", kind: "analytics" },
      { from: "pingIngest", to: "geoUpdater", kind: "analytics" },
      { from: "geoUpdater", to: "geoIndex", label: "update H3 cell", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · live tracking, courier proximity lookups" },
      { kind: "write", text: "write path · order create + dispatch assignment" },
      { kind: "analytics", text: "background · location ping ingestion, decoupled from dispatch latency" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["customerApp", "apiGateway", "orderSvc", "ordersDb"],
      say: "Start with the order write path: a customer submits an order through the gateway to a stateless Order Service, which writes a durable row to Postgres, geo-sharded by city. Two problems are still unsolved: matching that order to a courier, and showing the customer where the courier is.",
    },
    {
      reveal: ["dispatch", "geoIndex", "eta"],
      say: "Once an order is ready, Dispatch Service takes over: it k-ring queries the Redis/H3 geo index for nearby couriers, scores each candidate by routed ETA instead of straight-line distance, then writes the winning assignment back to Postgres with a conditional update so two racing workers can never double-book the same courier.",
    },
    {
      reveal: ["courierApp"],
      say: "Dispatch pushes the assignment to the Courier App as an offer with a 20-to-30-second accept window. A decline or timeout comes right back to Dispatch, which requeues the order with a priority boost and tries the next candidate.",
    },
    {
      reveal: ["pingIngest", "geoUpdater"],
      say: "Every courier also pings its position roughly every 4 seconds — about 125,000 pings a second system-wide. That firehose never touches the order tables: it flows through Kafka to a Geo-Index Updater that keeps the H3 cells in Redis fresh, fully decoupled from dispatch latency.",
    },
    {
      reveal: ["wsGateway"],
      say: "For live tracking, the customer subscribes to a per-order WebSocket channel on the Tracking Gateway. Dispatch publishes the assignment there, and the Geo-Index Updater publishes only threshold-filtered location changes off that same ping pipeline, so the map moves smoothly without re-broadcasting every raw ping.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Customer places an order (food, grocery, or parcel) with a pickup and drop-off address", tag: "P0" },
      { id: "FR-02", text: "System matches the order to a nearby available courier within the latency budget", tag: "P0" },
      { id: "FR-03", text: "Courier receives a push notification of the assignment and can accept or decline", tag: "P0" },
      { id: "FR-04", text: "Courier location is tracked in near real time (ping roughly every 4 seconds)", tag: "P0" },
      { id: "FR-05", text: "Customer sees the courier's live location and a continuously updated ETA on a map", tag: "P0" },
      { id: "FR-06", text: "Order lifecycle state machine: created → pending_assignment → assigned → picked_up → in_transit → delivered/cancelled", tag: "P0" },
      { id: "FR-07", text: "Automatic reassignment when a courier declines, times out, or goes silent", tag: "P0" },
      { id: "FR-08", text: "Batching: assign multiple nearby ready orders to one courier as a multi-stop route", tag: "P1" },
      { id: "FR-09", text: "ETA computed from real routing plus historical/live traffic, refreshed as the courier moves", tag: "P1" },
      { id: "FR-10", text: "Each metro region operates independently (geo-sharded), so one city's outage stays contained", tag: "P1" },
      { id: "FR-11", text: "Delivery proof at drop-off: photo, signature, or PIN", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Dispatch latency: order marked ready to courier assigned", tag: "p95 < 8s" },
      { id: "NFR-02", text: "Proximity query latency against the geo index", tag: "p99 < 50ms" },
      { id: "NFR-03", text: "Location ping ingestion throughput, sustained peak", tag: "125K/sec" },
      { id: "NFR-04", text: "Order creation throughput, sustained peak", tag: "2K/sec" },
      { id: "NFR-05", text: "Platform availability", tag: "99.95%" },
      { id: "NFR-06", text: "Assignment correctness: a courier is never committed to two orders at once", tag: "zero double-assign" },
      { id: "NFR-07", text: "Customer-visible tracking freshness, courier move to map update", tag: "< 5s" },
      { id: "NFR-08", text: "Blast radius of one region's infrastructure outage", tag: "1 region" },
      { id: "NFR-09", text: "Location pings vs. order writes — the ratio that drives the split-store design", tag: "60:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: the ping firehose, not the order stream, drives the design",
      body: [
        "Before drawing boxes, find the number that actually stresses the system. Peak order creation lands around 2,000/sec nationally — busy, but a fairly ordinary write rate for a sharded relational store. Courier location, on the other hand, is a different animal: with roughly 500,000 couriers online at peak, each device pinging its position every ~4 seconds, that's 500,000 / 4 ≈ 125,000 location updates per second, sustained, throughout peak hours.",
        "That 60:1 ratio of pings to orders is the whole reason this system has two stores instead of one: a durable relational store for orders and courier profiles that can afford transactions and joins, and a separate ephemeral, in-memory geospatial index that exists purely to answer 'who is near this pickup point right now' and can be rebuilt from the next round of pings if it's ever lost.",
      ],
      bullets: [
        { lead: "Orders", text: "~2,000/sec peak, each one a transactional row with a lifecycle — exactly what Postgres is good at." },
        { lead: "Location pings", text: "~125,000/sec peak, each one overwrites the last known position — nobody cares about ping #4,999, only the latest one." },
        { lead: "The 60:1 ratio", text: "is the signature number of this design: it's what justifies splitting durable order state from ephemeral, high-churn location state instead of cramming both into one database." },
      ],
      pictureTitle: "What actually stresses the system?",
      pictureCaption: "orders: ~2K/sec (durable, transactional) · pings: ~125K/sec (ephemeral, overwrite-only) — 60x the write rate",
      pictureRows: [
        { label: "Orders/sec (peak)", value: "~2,000 — durable rows, Postgres", tone: "neutral" },
        { label: "Location pings/sec (peak)", value: "~125,000 — ephemeral, in-memory", tone: "bad" },
        { label: "Ratio", value: "60:1 pings to orders", tone: "used" },
      ],
      remember: {
        problem: "Which traffic actually sizes the infrastructure?",
        solution: "Location pings (~125K/sec), not order writes (~2K/sec) — a 60:1 ratio.",
        why: "500K couriers pinging every ~4s dwarfs order volume; each ping is an overwrite, not a durable fact.",
        tradeoff: "Splitting into two stores (durable orders + ephemeral geo index) adds an integration point, but a single store can't be both a good OLTP ledger and a 125K writes/sec position cache.",
        failure: "Writing every ping into the transactional order database would blow the write budget and bloat a table nobody needs history for.",
        mitigation: "Route pings to an in-memory geo index (rebuildable, overwrite-only) and keep Postgres for the durable order/courier ledger.",
      },
    },
    {
      n: 2,
      title: "Geospatial indexing: kill flat geohash, defend an H3-keyed Redis index",
      body: [
        "Dispatch needs to answer 'which couriers are within ~2km of this pickup point' in under 50ms, against an index being rewritten 125,000 times a second. Put the candidates on the board.",
        "A full table scan with PostGIS ST_DWithin works at small scale but means every proximity query touches a durable, disk-backed table that's also absorbing 125K writes/sec — it won't hold. A flat geohash (base32 string prefix) is fast to look up but has a boundary bug: two couriers standing a few meters apart, one on each side of a cell edge, can end up with wildly different geohash prefixes, so a naive 'match the prefix' radius query silently misses nearby couriers unless every neighboring cell is checked by hand. The fix is Uber's own answer to this exact problem: H3, a hexagonal hierarchical grid where every cell has six neighbors at a uniform distance, so 'give me couriers nearby' becomes 'look up this cell plus a k-ring of 1-2 neighboring cells' with no boundary special-casing.",
      ],
      bullets: [
        { lead: "PostGIS ST_DWithin", text: "correct and simple, but a disk-backed relational table can't absorb 125K writes/sec of position churn without falling over. Rejected as the hot path." },
        { lead: "Flat geohash prefix match", text: "fast, but boundary-adjacent points can land in unrelated cells, so a naive radius query misses real neighbors unless you special-case every edge. Partially accepted — Redis's own GEO commands use this internally and it's fine for a first cut." },
        { lead: "H3 hexagonal grid", text: "uniform neighbor distance in every direction (hexagons, not squares or geohash rectangles), so expanding the search is a clean k-ring lookup: cell, then its 6 neighbors, then the next ring. Winner." },
        { lead: "Storage", text: "each H3 cell (resolution 8, ~0.46 km edge) maps to a Redis set of courier IDs; a ping updates one cell membership (leave old cell, join new cell) in O(1)." },
      ],
      pictureTitle: "Proximity index: kill two, keep one",
      pictureRows: [
        { label: "PostGIS ST_DWithin (disk)", value: "can't absorb 125K writes/sec → reject", tone: "bad" },
        { label: "Flat geohash prefix", value: "boundary bug, needs manual neighbor checks → partial", tone: "neutral" },
        { label: "H3 hex grid + Redis", value: "uniform k-ring neighbors, O(1) update → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Answer 'who is near this point' in <50ms against an index rewritten 125K times/sec.",
        solution: "H3 hexagonal cells (res 8, ~0.46km edge) as Redis set keys; radius search = target cell + k-ring of neighbors.",
        why: "Hexagons have uniform neighbor distance in all six directions, so expanding a search radius is a clean ring lookup with no boundary special-casing like geohash rectangles need.",
        tradeoff: "An extra indexing step (H3 encode) versus flat geohash, for correctness at cell boundaries.",
        failure: "A flat geohash prefix match can miss a courier standing meters away, on the wrong side of a cell boundary, unless every neighboring prefix is also checked.",
        mitigation: "Encode every ping to its H3 cell and always search a k-ring, never a single cell, so a courier is never one step outside the radius unnoticed.",
      },
    },
    {
      n: 3,
      title: "Dispatch: greedy nearest vs. batched windowed matching",
      body: [
        "Once you have candidate couriers within radius, you still have to pick one — and 'nearest by straight-line distance' is often wrong, because a courier 400m away across a river can be slower than one 900m away on a direct road. Score every candidate by ETA from a routing engine, then decide how many orders to consider at once.",
        "Assign each order the instant it's ready, to whichever scored candidate is free. Simple, and it hits the latency budget (a decision in low single-digit seconds), but it's short-sighted: two orders one minute apart, both near the same courier, get assigned separately when one courier could have handled both. Instead, batch: collect all orders that became ready in the last 1-2 second window across a region, and solve a small assignment problem across the whole batch, which naturally surfaces multi-order opportunities. The trade-off is a few extra seconds of dispatch latency for materially better courier utilization.",
      ],
      bullets: [
        { lead: "Score by ETA, not distance", text: "a routing engine (OSRM/Valhalla) plus a live traffic model gives a real travel time; straight-line distance is a poor proxy once there's a river, highway, or one-way street involved." },
        { lead: "Greedy immediate", text: "assign the moment an order is ready, to the best scored, currently-available candidate. Meets the latency budget, misses batching opportunities." },
        { lead: "Windowed batch match", text: "buffer 1-2 seconds of ready orders per region, then solve assignment across the whole set at once — this is what surfaces 'these two orders are both near this courier, batch them.'" },
        { lead: "The trade-off", text: "is latency for efficiency: greedy assigns in ~1s per order, batching adds the window (1-2s) but meaningfully raises orders-per-courier-trip during peak." },
      ],
      pictureTitle: "Greedy vs. batched dispatch",
      pictureRows: [
        { label: "Greedy, immediate", value: "~1s decision, no batching upside", tone: "neutral" },
        { label: "Windowed batch (1-2s)", value: "+1-2s latency, surfaces multi-order routes", tone: "good" },
        { label: "Score by straight-line distance", value: "wrong across rivers/highways → reject", tone: "bad" },
      ],
      remember: {
        problem: "Pick which of several nearby couriers gets an order, and whether to decide per-order or in a batch.",
        solution: "Score candidates by routed ETA, not distance; batch orders in a 1-2s window per region and solve assignment across the batch.",
        why: "ETA reflects the real road network; batching a short window surfaces multi-order routes that pure greedy assignment can never see.",
        tradeoff: "Batching trades a couple seconds of extra dispatch latency for materially better courier utilization at peak.",
        failure: "Pure greedy-by-distance sends a courier the long way around a river while a farther-but-faster courier sits idle, and never combines nearby orders.",
        mitigation: "Always score by routed ETA; widen the batch window during peak when the density of orders makes batching pay off most.",
      },
    },
    {
      n: 4,
      title: "The double-assignment race, and the CAS fix",
      body: [
        "Multiple dispatch workers run concurrently across a region for throughput, which means two workers can query the geo index at nearly the same instant, both see the same courier as available, and both decide to assign them to different orders. Without a guard, the courier gets two offers, one order silently loses its courier, and nobody notices until a customer complains.",
        "The fix is the same optimistic-concurrency pattern used anywhere two writers might race for one resource: the assignment is a conditional update, not a blind write. 'UPDATE couriers SET status = pending_offer, order_id = ? WHERE courier_id = ? AND status = available.' Whichever worker's update lands first flips the row and gets rows_affected = 1; the loser's identical update matches zero rows, sees rows_affected = 0, and knows to fall back to its next-best candidate instead of assuming success.",
      ],
      bullets: [
        { lead: "The race", text: "two dispatch workers query the geo index microseconds apart, both see courier X as available, both attempt to assign — without a guard, X gets committed twice." },
        { lead: "Conditional update (CAS)", text: "the assignment write includes 'WHERE status = available' as a precondition. Only one writer's update can match; the database enforces the single-winner rule for free." },
        { lead: "The loser retries", text: "rows_affected = 0 means 'lost the race,' not 'error' — the losing worker just re-queries the geo index and tries the next candidate, adding milliseconds, not seconds." },
        { lead: "Alternative: a lock", text: "a Redis SETNX lock with a short TTL on the courier ID during the offer window works too, but the CAS-on-write approach needs no separate lock service and can't leak a stuck lock." },
      ],
      pictureTitle: "Two workers, one courier",
      pictureRows: [
        { label: "No guard", value: "courier double-booked, an order silently loses coverage", tone: "bad" },
        { label: "CAS: WHERE status = available", value: "1 row updated, 1 winner, enforced by the DB", tone: "good" },
        { label: "Loser (rows_affected = 0)", value: "retries next candidate, adds ~ms not sec", tone: "neutral" },
      ],
      remember: {
        problem: "Two concurrent dispatch workers can assign the same courier to two different orders.",
        solution: "Assignment is a conditional update: 'SET status=pending_offer WHERE courier_id=? AND status=available', checked by rows_affected.",
        why: "The database's row-level atomicity turns 'two writers race' into 'exactly one write succeeds,' with zero extra coordination service.",
        tradeoff: "The losing worker pays a retry (re-query + next candidate), a few milliseconds, in exchange for a correctness guarantee that costs nothing when there's no race.",
        failure: "A blind, unconditional assignment write lets both workers 'succeed,' double-booking the courier and silently orphaning one order.",
        mitigation: "Always gate the assignment write on the courier's current status; treat rows_affected = 0 as expected, not exceptional, and retry the candidate list.",
      },
    },
    {
      n: 5,
      title: "When a courier declines, times out, or goes silent",
      body: [
        "An assignment is an offer, not a fact, until the courier accepts — and couriers decline, get distracted, or lose signal. The order's state machine has to treat 'nobody has confirmed yet' as the normal case, not an edge case, and always have a next move.",
        "A courier has a short window (~20-30s) to accept a push notification; a decline or a timeout returns the order to the pending pool immediately, this time with a priority boost since it's already waited once. Separately, a courier mid-delivery who stops pinging for longer than a threshold (~90s) is presumed offline; for an order that's already been picked up, that's an operational alert (support intervention, not silent reassignment, since the order may already be with them); for an order still awaiting pickup, the system can reassign outright.",
      ],
      bullets: [
        { lead: "Accept window", text: "~20-30s to accept a push offer. No response is treated the same as an explicit decline." },
        { lead: "Decline/timeout", text: "the order returns to the pending pool with a priority boost — it's already waited once, so it should jump the queue on the next matching pass, not restart at the back." },
        { lead: "Silent courier, pre-pickup", text: "no ping for ~90s before pickup → safe to reassign; nothing physical has changed hands yet." },
        { lead: "Silent courier, post-pickup", text: "no ping for ~90s after pickup → this is a support escalation, not an automatic reassignment, because the order is physically with that courier." },
      ],
      pictureTitle: "What happens when the offer doesn't land?",
      pictureRows: [
        { label: "Decline / 30s timeout", value: "back to pending pool, priority boost", tone: "neutral" },
        { label: "Silent, pre-pickup (90s)", value: "safe to reassign automatically", tone: "good" },
        { label: "Silent, post-pickup (90s)", value: "support escalation, not silent reassignment", tone: "bad" },
      ],
      remember: {
        problem: "An assignment can fail after the fact: decline, timeout, or a courier who goes silent mid-route.",
        solution: "Short accept window with automatic requeue-and-boost on decline/timeout; pre-pickup silence reassigns automatically, post-pickup silence escalates to support.",
        why: "Physical possession of the order changes what 'safe to reassign' means — before pickup nothing has moved, after pickup the order is with that courier.",
        tradeoff: "The priority boost on requeue can starve out other orders if declines spike, so it needs a cap, not unlimited boosting.",
        failure: "Treating post-pickup silence the same as pre-pickup (auto-reassign) risks sending a second courier to an order that's already physically out for delivery.",
        mitigation: "Split the timeout policy on pickup state, and cap requeue priority boosts so one order can't monopolize every matching pass.",
      },
    },
    {
      n: 6,
      title: "Batching multi-stop routes without hurting anyone's ETA",
      body: [
        "The efficiency win of batching is real — one courier trip instead of two — but only if it doesn't quietly make one customer's order much later so another's is faster. Batching needs a hard guardrail, not just an opportunistic 'these are nearby.'",
        "Two orders are batching candidates only if they share a pickup point (or pickup points within a short walk) and their drop-offs sit roughly along one route. Before committing, call the routing engine on the combined route and check the detour: if delivering both adds no more than ~20% extra time versus either order's own solo trip, batch them; otherwise dispatch them separately. Cap it at a courier's physical capacity (typically 2-3 concurrent orders) so batching never turns into an unbounded backlog.",
      ],
      bullets: [
        { lead: "Candidate criteria", text: "shared or nearby pickup point, and drop-offs that don't require doubling back — this is a routing question, not just a distance one." },
        { lead: "Detour check", text: "call the routing engine on the combined multi-stop route; only batch if the added time for either order stays under a threshold (roughly 20%)." },
        { lead: "Capacity cap", text: "2-3 concurrent orders per courier, driven by physical bag/insulation capacity, not just an algorithmic preference." },
        { lead: "Never at the customer's expense", text: "a batch that would blow one customer's ETA past its own solo-trip time gets rejected, even if it's more efficient for the courier." },
      ],
      pictureTitle: "When does a batch get rejected?",
      pictureRows: [
        { label: "Shared pickup, <20% detour", value: "batch — one trip, two orders", tone: "good" },
        { label: "Detour > 20% for either order", value: "reject — dispatch separately", tone: "bad" },
        { label: "Courier at capacity", value: "reject — cap is 2-3 concurrent orders", tone: "neutral" },
      ],
      remember: {
        problem: "Combine nearby orders into one courier trip without silently degrading anyone's delivery time.",
        solution: "Check the actual routed detour for a combined trip against a threshold (~20%) before batching, and cap concurrent orders to courier capacity.",
        why: "Two orders can look close on a map and still be a bad batch once real roads are considered — the detour check, not proximity, is the real gate.",
        tradeoff: "The detour check adds a routing-engine call before every batch decision, spending latency to protect ETA fairness.",
        failure: "Batching purely on proximity can silently blow one customer's delivery time past what they'd have gotten solo, with no signal to anyone that it happened.",
        mitigation: "Reject any batch where the routed detour for either order exceeds the threshold, and enforce a hard cap on concurrent orders per courier.",
      },
    },
    {
      n: 7,
      title: "Tracking fan-out and regional isolation, without a meltdown",
      body: [
        "Two separate scaling problems hide behind 'show the customer where their courier is': how do you push updates to a customer's map without re-broadcasting all 125,000 pings a second, and how do you keep one city's infrastructure trouble from taking down every other city at once?",
        "For fan-out, never push a raw ping. Each order gets its own pub/sub channel; the same Geo-Index Updater that consumes the ping stream also checks whether the courier who just moved is the one assigned to an open order, and only publishes to that order's channel when they've moved more than a threshold distance or a state changes — most 4-second pings that show someone sitting still or moving predictably never generate a customer-visible update at all. The client also smooths the dot's motion between updates (interpolation) rather than snapping it, since a raw GPS ping is noisy and a jump every 4 seconds looks broken even when it's technically correct. For isolation, shard everything — dispatch workers, the geo index, the pub/sub channels — by metro region, so a city is the unit of failure: if that region's Redis cluster falls over, dispatch degrades or pauses in that city alone, while every other city continues untouched.",
      ],
      bullets: [
        { lead: "Per-order channel, not broadcast", text: "a customer subscribes only to their own order's channel; nobody's client receives another customer's courier updates." },
        { lead: "Threshold-based publish", text: "publish on meaningful movement or state change, not every raw ping — this alone cuts customer-visible updates by an order of magnitude versus naive re-broadcast." },
        { lead: "Client-side interpolation", text: "smooth the dot between real updates so a 4-second ping cadence still reads as continuous motion on the map." },
        { lead: "Geo-sharded by region", text: "dispatch, geo index, and pub/sub are all partitioned by metro area, so a single region's outage has a blast radius of exactly that region." },
      ],
      pictureTitle: "Fan-out and blast radius",
      pictureRows: [
        { label: "Broadcast every ping", value: "unnecessary fan-out, wasted bandwidth", tone: "bad" },
        { label: "Per-order channel + threshold", value: "only meaningful moves reach the customer", tone: "good" },
        { label: "City-sharded infra", value: "one region's outage stays in that region", tone: "good" },
      ],
      remember: {
        problem: "Push live courier location to customers cheaply, and stop one city's outage from spreading.",
        solution: "Per-order pub/sub channels with threshold-based publishing, plus geo-sharding of dispatch/geo-index/pub-sub by metro region.",
        why: "Most 4-second pings carry no customer-visible information; broadcasting them all wastes fan-out capacity that scales with courier count, not customer count.",
        tradeoff: "Threshold-based publishing adds a small filtering step per ping in exchange for an order-of-magnitude smaller fan-out volume.",
        failure: "A single shared infrastructure layer across every city means one region's Redis or dispatch outage takes the whole platform down at once.",
        mitigation: "Partition by metro region end to end, and only publish tracking updates when they'd actually change what the customer sees.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a real-time matching problem wrapped around two very different stores: a durable Postgres ledger for orders, and an ephemeral, H3-indexed Redis layer for the 125K/sec courier location firehose.",
      "Dispatch scores nearby couriers by routed ETA, not straight-line distance, and batches a short window of ready orders to catch multi-order routes greedy assignment would miss.",
      "Assignment is a conditional update (CAS): whoever's write matches 'status = available' first wins, so two racing dispatch workers can never double-book the same courier.",
      "Declines, timeouts, and silent couriers are the normal case, not the edge case — the state machine always has a next move, and treats pre-pickup and post-pickup silence differently.",
      "Everything — dispatch, the geo index, tracking pub/sub — is sharded by metro region, so one city's outage never reaches another.",
    ],
    flows: [
      {
        kind: "write",
        title: "WRITE · ORDER CREATE + DISPATCH · 2K/S",
        summary:
          "An order enters the pending pool, dispatch finds and scores nearby couriers, then commits the winner with a conditional update so two workers can never assign the same courier twice.",
        steps: [
          { label: "Customer App", note: "submits pickup/drop-off + items" },
          { label: "API Gateway", note: "routes to the region's Order Service" },
          { label: "Order Service", note: "writes the order row" },
          { label: "Postgres", note: "insert · geo-sharded by city" },
          { label: "Dispatch Service", note: "order enters the matching batch window" },
          { label: "Geo Index (Redis/H3)", note: "k-ring query for nearby couriers" },
          { label: "Routing/ETA Engine", note: "scores candidates by real travel time" },
          { label: "Postgres CAS update", note: "WHERE status=available · single winner" },
          { label: "Courier App", note: "push offer · ~20-30s to accept" },
        ],
      },
      {
        kind: "read",
        title: "READ · LIVE TRACKING · < 5S FRESHNESS",
        summary:
          "The customer subscribes to a channel scoped to their one order. Dispatch publishes the initial assignment; after that, the same background pipeline consuming location pings publishes only meaningful courier movement, so the map updates smoothly without re-broadcasting every raw ping.",
        steps: [
          { label: "Customer App", note: "subscribes on order creation" },
          { label: "Tracking Gateway", note: "WebSocket · per-order Redis pub/sub channel" },
          { label: "Dispatch Service", note: "publishes the assignment when a courier accepts" },
          { label: "Geo-Index Updater", note: "publishes threshold-filtered location off the ping stream" },
          { label: "Customer App", note: "map dot interpolated between updates" },
        ],
      },
      {
        kind: "analytics",
        title: "BACKGROUND · LOCATION PING INGESTION · 125K/S",
        summary:
          "Every courier device pings its position every ~4 seconds regardless of whether it's tied to an active order. This stream is fully decoupled from dispatch latency — it just keeps the geo index fresh.",
        steps: [
          { label: "Courier App", note: "GPS ping · ~4s cadence" },
          { label: "Kafka", note: "~125K/sec sustained, partitioned by region" },
          { label: "Geo-Index Updater", note: "consumer, updates one H3 cell per ping" },
          { label: "Geo Index (Redis)", note: "O(1) cell membership update" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "500K active couriers at peak, pinging every ~4s → ~125K location updates/sec",
          "~2K orders/sec sustained peak, spiking higher during meal-rush windows",
          "60:1 ratio of location pings to order writes — the number that splits the storage design in two",
          "H3 resolution 8 cells, ~0.46km edge; radius search = target cell + 1-2 k-rings",
          "Dispatch batch window: 1-2s per region; accept window: ~20-30s per offer",
          "Silent-courier threshold: ~90s with no ping before treating them as offline",
          "Batch detour cap: ~20% added time before a multi-order batch is rejected",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Two stores, not one: durable Postgres for orders/couriers, ephemeral Redis/H3 for hot location",
          "H3 hexagonal grid over flat geohash — uniform k-ring neighbors, no boundary special-casing",
          "Score dispatch candidates by routed ETA, not straight-line distance",
          "Windowed batch matching (1-2s) over pure greedy, to catch multi-order routes",
          "Conditional update (CAS) for assignment — never a blind write — to kill the double-booking race",
          "Geo-shard dispatch, geo index, and pub/sub by metro region for blast-radius containment",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The 60:1 ping-to-order ratio is why there are two stores, not a database preference",
          "CAS on assignment (WHERE status = available) is what makes double-booking structurally impossible, not just unlikely",
          "Pre-pickup vs. post-pickup silence get different reassignment policies, because possession of the order changed",
          "Threshold-based publishing, not raw-ping broadcast, is what keeps tracking fan-out affordable",
          "Batching is gated by a routed detour check (~20%), never by proximity alone",
          "Region sharding means one city's outage has a blast radius of exactly that city",
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
      goal: "Before drawing anything, get the two driving numbers — orders/sec and location pings/sec — and the product scope on the board.",
      why: "Numbers are not trivia here. Every later decision (split stores, index choice, batch window) falls out of the 60:1 ratio between pings and orders, so locking it first is what separates an engineer from someone guessing.",
      steps: [
        { kind: "ASK", text: '**"What are we delivering — food, groceries, parcels, or all three?"** Land on "a general local delivery platform," multiple verticals sharing one dispatch engine. Write **"food + grocery + parcel, shared dispatch"** in the corner.' },
        { kind: "ASK", text: '**"What scale — one city or nationwide?"** Land on "nationwide, geo-sharded by metro region." Write **"nationwide, sharded by city"**.' },
        { kind: "SAY", text: 'Propose the numbers yourself: **"~2,000 orders/sec at peak"**, **"~500,000 active couriers"**, **"pinging every ~4 seconds"**. Do the multiplication out loud: "500,000 divided by 4 is 125,000 location updates a second." Write **"2K orders/s · 125K pings/s · 60:1"** on the board.' },
        { kind: "SAY", text: 'State scope. In: "order-to-courier matching", "real-time tracking", "batching", "failure/reassignment handling". Out: "payments", "merchant onboarding", "fraud". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Write the latency budget: **"dispatch decision: p95 < 8s"**, **"proximity query: p99 < 50ms"**, **"tracking freshness: < 5s"**. These three numbers are what every later component gets justified against.' },
      ],
      grading: "Are the two write rates (orders vs. pings) both on the board, and is the 60:1 ratio stated as a reason for the design, not a trivia fact?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two-ish endpoints, an explicit order state machine, and a courier row — with the split-store decision defended up front.",
      why: "The interviewer wants to see you commit to a tiny surface and defend it. Justifying two stores before being asked shows you understand the 60:1 ratio drives the architecture, not just the cache layer.",
      steps: [
        { kind: "WRITE", text: 'Write the core endpoints: **"POST /orders { pickup, dropoff, items }"** returns "{ orderId }". **"POST /couriers/:id/location { lat, lng }"**, uncapped, called every ~4s. **"POST /orders/:id/offer-response { accept: bool }"**, called by the courier app.' },
        { kind: "DRAW", text: 'Sketch the order row: **"order_id (PK)"**, **"status"** (created → pending_assignment → assigned → picked_up → in_transit → delivered/cancelled), **"courier_id"**, **"pickup/dropoff"**, **"region_shard"**. Sketch the courier row separately: **"courier_id (PK)"**, **"status"** (available/pending_offer/on_delivery/offline), **"current_h3_cell"**.' },
        { kind: "SAY", text: 'Justify the split: "Orders are durable, transactional, low-volume — Postgres, geo-sharded by region. Courier location is ephemeral, overwrite-only, 125K/sec — that goes in an in-memory H3-indexed store, not the same table as the order ledger."' },
        { kind: "RULE OUT", text: 'Get ahead of it: "A single Postgres table holding live courier position would mean 125K writes/sec against a disk-backed, indexed table — that\'s the write rate that kills this option, not a stylistic choice."' },
      ],
      grading: "Crisp endpoints, an explicit order state machine sketched, and a stated reason for two stores instead of one.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: write (order + dispatch), read (tracking), background (location ingestion).",
      why: "Drawing these as separate lanes proves you understand they have different latency and failure profiles. Candidates who draw one blob miss that the ping firehose must never sit on the dispatch decision synchronously.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write path**: Customer App → API Gateway → Order Service → Postgres (insert) → Dispatch Service → Geo Index (k-ring query) → Routing/ETA Engine (score) → Postgres (CAS assign) → Courier App (push offer). Label arrows **"WHERE status=available"** and **"p95 < 8s"**, not the boxes.' },
        { kind: "DRAW", text: 'Add the **background lane**, fully separate: Courier App → Kafka (~125K/s) → Geo-Index Updater → Geo Index. Label it **"decoupled from dispatch latency"**.' },
        { kind: "DRAW", text: 'Add the **read/tracking lane**: Customer App subscribes to the Tracking Gateway; Dispatch Service publishes the assignment onto that channel, and the Geo-Index Updater publishes threshold-filtered location off the same ping stream. Label it **"threshold-published, < 5s freshness"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different failure and latency profiles — dispatch is latency-critical, location ingestion is a firehose that must never block dispatch, and tracking is best-effort push."' },
      ],
      grading: "Three visually separated lanes, arrows carrying numbers, and an explicit statement that the ping firehose never touches the dispatch decision synchronously.",
    },
    {
      n: 4,
      title: "Deep Dive: Geospatial Index and Dispatch Matching",
      minutes: 8,
      goal: "Show the H3 k-ring index and the ETA-scored, windowed-batch matching algorithm.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can find nearby couriers correctly at the boundary, score them meaningfully, and explain the latency-vs-efficiency trade-off in batching.",
      steps: [
        { kind: "DRAW", text: 'Draw an H3 cell with its 6 neighbors: **"resolution 8, ~0.46km edge"**. "A radius query is: encode the pickup point to its cell, then pull that cell plus a k-ring of 1-2 neighbors — no boundary special-casing like a flat geohash needs."' },
        { kind: "SAY", text: 'Explain scoring: "Candidates get ranked by routed ETA from an OSRM-style engine, not straight-line distance — distance lies across rivers and highways."' },
        { kind: "SAY", text: 'Explain the batch window: "Ready orders in a region get buffered for 1-2 seconds and matched together, not one at a time, so the matcher can spot two orders near the same courier and batch them."' },
        { kind: "RULE OUT", text: 'One line each: "Flat geohash prefix matching → boundary bug, misses nearby couriers at cell edges." "Pure greedy, order-at-a-time → meets latency but leaves batching opportunities on the table."' },
      ],
      grading: "H3 k-ring explained without prompting, the ETA-vs-distance distinction made, and the batch-window trade-off stated in seconds and outcome, not vaguely.",
    },
    {
      n: 5,
      title: "Deep Dive: Concurrency and Failure Handling",
      minutes: 7,
      goal: "Walk the CAS-guarded assignment race, then the decline/timeout/silent-courier policy.",
      why: "The interviewer is probing whether you can spot the double-assignment race unprompted and whether your failure handling reflects that possession of the order changes what 'safe to reassign' means.",
      steps: [
        { kind: "SAY", text: 'Walk the race: "Two dispatch workers can see the same courier as available at the same instant. The fix is a conditional update — SET status=pending_offer WHERE courier_id=? AND status=available — and check rows_affected. Whoever\'s write lands first wins; the loser sees zero rows changed and retries the next candidate."' },
        { kind: "SAY", text: 'Walk decline/timeout: "A courier has ~20-30 seconds to accept. No response is a decline. The order goes back into the pending pool with a priority boost since it already waited once."' },
        { kind: "SAY", text: 'Walk silent couriers: "No ping for ~90 seconds pre-pickup is safe to auto-reassign — nothing\'s physically moved. Post-pickup, that\'s a support escalation instead, because the order is physically with that courier."' },
      ],
      grading: "CAS explained as 'conditional write, check rows affected' without hand-waving, and the pre-pickup/post-pickup distinction stated as a deliberate design choice.",
    },
    {
      n: 6,
      title: "Wrap: Batching, Regional Isolation, and Close",
      minutes: 5,
      goal: "State the batching guardrail with a number, name regional sharding as the isolation mechanism, push back once, and close cleanly.",
      why: "Staff-level signal is operational maturity: a batching guardrail with a real threshold, a blast-radius argument for region sharding, and a clean close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: 'Batching guardrail: "Two orders only batch if the routed detour for either one stays under ~20% versus its own solo trip — proximity alone isn\'t enough, because a shared street doesn\'t mean a shared route."' },
        { kind: "SAY", text: 'Regional isolation: "Dispatch, the geo index, and tracking pub/sub are all sharded by metro region, so one city\'s Redis outage degrades that city alone."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need sub-5-second tracking freshness for a 2-hour grocery delivery window, or is that only true for a 20-minute food order?" Treat requirements as negotiable by vertical.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a real-time matching system split across a durable order ledger and an ephemeral H3-indexed location layer, with CAS-guarded assignment and region-level blast-radius containment. With more time I\'d cover payments, merchant onboarding, and surge pricing."' },
      ],
      grading: "Batching guardrail stated with a number, region sharding named as the isolation mechanism, at least one pushback, and a crisp closing summary with parked items.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but the storage split and the concurrency risk stay unnoticed unless prompted.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, cache, database, and a queue if prompted.",
          "Mentions a geospatial index ('geohash' or 'Redis geo') when asked how to find nearby couriers.",
          "Adds Kafka for location updates if asked 'how do you handle that much traffic'.",
          "Writes a basic order state machine (created, assigned, delivered).",
          "Matches orders to couriers by 'find the nearest one', without discussing scoring or races.",
        ],
        gaps: [
          "Doesn't separate durable order storage from ephemeral location storage; tries to put both in Postgres.",
          "Doesn't notice the double-assignment race unless the interviewer raises it.",
          "No decline/timeout/reassignment story — assumes the courier always accepts.",
          "Geo index is 'just use Redis GEO' with no discussion of the boundary problem or ring expansion.",
          "No batching, no regional sharding, no blast-radius reasoning.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, splits the storage layer correctly, and catches the concurrency race — but the operational depth (batching, silent couriers) needs prompting.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the orders/sec and pings/sec numbers, and the 60:1 ratio, on the board within the first 5 minutes.",
          "Chooses H3 or an equivalent hex/geohash-aware index and explains the boundary problem.",
          "Scores dispatch candidates by routed ETA, not raw distance.",
          "Identifies the double-assignment race unprompted and proposes a CAS or lock-based fix.",
          "Has an explicit decline/timeout policy for the courier offer.",
          "Mentions regional sharding for isolation.",
          "Explains why two stores exist — durable orders vs. ephemeral location.",
        ],
        gaps: [
          "Volunteers the pre-pickup vs. post-pickup silent-courier distinction only when asked.",
          "Doesn't bring up batching or the detour-cap guardrail unless prompted.",
          "Quantifies degradation in words, not numbers ('the cache would be slower' instead of 'Scylla load triples').",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces the concurrency race and the storage split before being asked, and brings operational maturity that goes beyond the happy path.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the 60:1 ping-to-order ratio as the number that splits the storage architecture, unprompted.",
          "Brings up the CAS assignment race and its fix before being asked, framing it as the interesting concurrency problem in this design.",
          "Distinguishes pre-pickup vs. post-pickup silent-courier handling unprompted, tied explicitly to physical possession of the order.",
          "Names the batching detour cap with a specific number and explains why proximity alone isn't a sufficient gate.",
          "States regional sharding as blast-radius containment and gives a concrete failure scenario it protects against.",
          "Pushes back on requirements by vertical (food vs. grocery freshness needs).",
          "Closes with a crisp one-sentence summary and an explicit parked-items list.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Storing live courier location in the same durable Postgres table as orders — 125K writes/sec against a disk-backed, indexed table will not hold.",
      "Assigning a courier with a blind write instead of a conditional update, leaving the double-booking race live.",
      "Scoring candidates by straight-line distance instead of routed ETA — wrong the moment there's a river, highway, or one-way street in the way.",
      "No decline/timeout policy — treating 'courier accepted' as guaranteed instead of the common case it isn't.",
      "Treating pre-pickup and post-pickup courier silence the same way, risking a second courier being sent to an order that's already out for delivery.",
      "No regional sharding — one city's Redis or dispatch outage takes down matching everywhere.",
      "Batching purely on proximity with no detour check, silently blowing one customer's ETA to make a courier's trip more efficient.",
    ],
    followUps: [
      {
        q: "Why H3 instead of just using Redis's built-in GEO commands (GEOADD/GEOSEARCH)?",
        a: "Redis GEO is a perfectly reasonable first cut — it's a geohash under the hood and handles a basic radius query fine. The reason to move to an H3-keyed scheme is the boundary problem: geohash cells are rectangles with non-uniform neighbor distances, so two couriers a few meters apart on either side of a cell edge can land in cells that don't even share a prefix, and a naive radius query misses them. H3's hexagons have six neighbors at a uniform distance, so 'expand the search' is a clean, correct k-ring lookup instead of a set of hand-checked special cases. In practice a lot of real systems ship Redis GEO first and layer in H3 partitioning once the boundary-miss bugs show up in production.",
      },
      {
        q: "What happens if the geo index (Redis) for a region goes down?",
        a: "Because it's rebuildable — every courier re-pings its position every ~4 seconds — the region can recover within roughly one ping cycle by replaying the next wave of pings, no backup or replay-from-log needed. In the meantime, dispatch in that region either pauses new assignments or falls back to a degraded mode (e.g., querying last-known positions from Postgres, slower and staler but not empty). Because everything is sharded by region, this outage never touches any other city's dispatch.",
      },
      {
        q: "How do you decide the batch window length for dispatch matching?",
        a: "It's a direct trade-off between latency and match quality, and it should flex with order density: during a slow period there's nothing to batch against, so a longer window just adds latency for no benefit, and you'd shrink it toward near-immediate assignment. During a dinner rush, a lot of orders become ready every second in the same few blocks, so a 1-2 second window has real batching upside and the added latency is worth it. In practice you'd make it adaptive to the order-arrival rate in that region rather than a single global constant.",
      },
      {
        q: "Could you use a distributed lock (like Redis SETNX) instead of a conditional DB update for the assignment race?",
        a: "Yes, and some systems do — SETNX on the courier ID with a short TTL during the offer window achieves the same single-winner guarantee. The trade-off is operational: a lock needs its own expiry/cleanup story (a crashed worker holding a lock until TTL expiry can stall that courier), while a conditional update on the courier's own status column piggybacks on transactional guarantees you already have and can't leak a stuck lock. Either is defensible; the conditional update is usually simpler because it needs no separate lock service.",
      },
      {
        q: "How would you extend this to support scheduled deliveries (e.g., 'deliver at 6pm')?",
        a: "Scheduled orders shouldn't enter the same real-time matching pool as on-demand orders until close to their window, or they'd occupy couriers far too early. Keep them in a separate scheduled queue keyed by target time, and have a background job promote each one into the live dispatch pool a fixed lead time before its window (e.g., 15-20 minutes), at which point it behaves exactly like a normal ready order. The matching, CAS-assignment, and batching logic downstream don't need to change at all.",
      },
      {
        q: "What's the failure mode if the routing/ETA engine is slow or down?",
        a: "Dispatch has a hard latency budget (p95 < 8s), so the ETA lookup needs its own timeout well inside that budget — if it doesn't return in, say, 500ms, fall back to straight-line distance for that decision rather than blocking the whole assignment. It's a worse score temporarily, not a stalled order. This is the same tier-hierarchy idea as elsewhere in the design: a secondary signal (ETA precision) degrades gracefully rather than blocking the primary guarantee that an order gets assigned.",
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
          "This is a real-time bipartite matching problem — orders to couriers — sitting on top of two very different stores: a durable, transactional ledger for orders and courier profiles, and an ephemeral, extremely high-churn geospatial index that exists purely to answer 'who is nearby right now.'",
          "Anchor everything on three numbers: ~2,000 orders/sec, ~125,000 location pings/sec (a 60:1 ratio), and a dispatch latency budget of p95 < 8 seconds. Every structural choice below is a consequence of those numbers.",
        ],
      },
      {
        heading: "Sizing and the split-store decision",
        body: [
          "500,000 active couriers pinging every ~4 seconds is 125,000 updates/sec, sustained — sixty times the order write rate. That single fact rules out storing live location in the same durable table as orders: a disk-backed, indexed Postgres table can't absorb that write rate, and it doesn't need to, because a location ping only matters until the next one arrives.",
          "The split is: Postgres, geo-sharded by metro region, for orders and courier profiles (durable, transactional, low-volume); an in-memory, H3-indexed Redis layer for live courier position (ephemeral, overwrite-only, rebuildable from the next ping cycle if lost).",
        ],
      },
      {
        heading: "Geospatial indexing: H3 over flat geohash",
        body: [
          "A proximity query has to answer 'who's within ~2km of this point' in under 50ms against an index rewritten 125K times a second. A flat geohash (prefix-matched base32 string) is fast but has a boundary bug: cells are non-uniform rectangles, so two couriers meters apart on either side of a cell edge can land in prefixes that share nothing, silently missing real neighbors unless every adjacent cell is hand-checked.",
          "H3, Uber's hexagonal hierarchical grid, fixes this structurally: every cell has exactly six neighbors at a uniform distance, so a radius search is a clean k-ring lookup — the target cell plus 1-2 rings of neighbors — with no special-casing. Each courier's ping updates one Redis set membership (leave old cell, join new cell) in O(1).",
        ],
      },
      {
        heading: "Dispatch: ETA scoring and windowed batching",
        body: [
          "Once candidates are found, they're ranked by routed ETA from a routing engine (OSRM-style, with a traffic model), not straight-line distance — distance is a poor proxy the moment a river, highway, or one-way grid separates two points.",
          "Rather than assigning strictly order-by-order, ready orders in a region are buffered for a short window (1-2 seconds) and matched together, which is what lets the matcher spot two orders near the same courier and combine them into one trip. It's a deliberate latency-for-efficiency trade: a few extra seconds of dispatch time for materially better courier utilization at peak.",
        ],
      },
      {
        heading: "Concurrency: the double-assignment race",
        body: [
          "Multiple dispatch workers run concurrently per region for throughput, which means two workers can see the same courier as available at nearly the same instant. The fix is a conditional update on the assignment write — SET status=pending_offer WHERE courier_id=? AND status=available — checked by rows_affected. Exactly one writer's update can match; the loser sees zero rows changed and falls back to its next candidate, adding milliseconds, not seconds.",
          "This is the same optimistic-concurrency pattern used anywhere two writers might race for one resource — no separate lock service needed, and no way for a crashed worker to leave a stuck lock behind.",
        ],
      },
      {
        heading: "Failure handling, batching guardrails, and regional isolation",
        body: [
          "Assignment is an offer, not a fact, until accepted: couriers get ~20-30 seconds to accept a push offer, and a decline or timeout returns the order to the pending pool with a priority boost. A courier who stops pinging for ~90 seconds is presumed offline — safe to auto-reassign before pickup, but a support escalation after pickup, since the order is now physically with them.",
          "Batching is gated by an actual routed-detour check (roughly 20% added time) rather than proximity alone, so efficiency for the courier never silently costs a customer their ETA. And everything — dispatch workers, the geo index, tracking pub/sub — is sharded by metro region, so a single city's infrastructure outage has a blast radius of exactly that city.",
        ],
      },
    ],
  },
};
