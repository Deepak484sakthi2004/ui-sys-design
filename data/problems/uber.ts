import type { Problem } from "@/lib/types";

export const uber: Problem = {
  slug: "uber",
  num: "5.5",
  title: "Design Uber",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design the core of Uber's ride-hailing platform: match roughly 5M concurrently online drivers against ride requests across hundreds of cities, ingest ~1.25M driver location pings/sec, assign a driver within 3-5 seconds of a request, and compute live ETAs and surge pricing per micro-zone — all while never assigning the same driver to two riders at once.",
  ],
  hardParts:
    "The hard parts: keeping a geospatial index fresh under a location-update firehose without falling behind, guaranteeing exactly one rider ever claims a given driver when many matching requests race concurrently, and computing surge pricing per micro-zone in near real time without it becoming laggy, flappy, or gameable.",
  keyTopics: [
    "H3 Hexagonal Geospatial Indexing",
    "Real-Time Location Ingestion Firehose",
    "Atomic Driver Claim (No Double-Dispatch)",
    "Dynamic Surge Pricing",
    "Trip State Machine",
  ],
  foundationsReferenced: [
    { label: "Geohashing / Quadtrees", tone: "green" },
    { label: "Valkey / Redis", tone: "purple" },
    { label: "Kafka", tone: "orange" },
    { label: "Distributed Locks / CAS", tone: "orange" },
    { label: "Consistent Hashing", tone: "blue" },
    { label: "Cassandra / DynamoDB", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "rider", label: "Rider App", col: 1, row: 1, tone: "slate" },
      { id: "driver", label: "Driver App", col: 1, row: 3, tone: "slate" },
      { id: "lb", label: "Regional LB", col: 2, row: 2, tone: "slate" },
      {
        id: "dispatch",
        label: "Dispatch Service",
        sub: "stateless matcher",
        col: 3,
        row: 1,
        tone: "green",
      },
      {
        id: "geo_index",
        label: "Geo Index",
        sub: "H3 cells · ~5M drivers",
        mono: "Valkey GEOADD + k-ring",
        col: 4,
        row: 1,
        tone: "green",
      },
      {
        id: "eta_pricing",
        label: "ETA & Pricing",
        sub: "road graph + traffic",
        col: 5,
        row: 1,
        tone: "blue",
      },
      {
        id: "location_svc",
        label: "Location Ingestion",
        sub: "~1.25M pings/s",
        col: 3,
        row: 3,
        tone: "orange",
      },
      { id: "kafka", label: "Kafka", col: 4, row: 3, tone: "orange" },
      {
        id: "flink",
        label: "Flink",
        sub: "surge + ETA calibration",
        col: 5,
        row: 3,
        tone: "orange",
      },
      {
        id: "trip_svc",
        label: "Trip Service",
        mono: "state machine · CAS",
        col: 2,
        row: 4,
        tone: "purple",
      },
      {
        id: "trips_db",
        label: "Cassandra",
        sub: "trips + ledger · RF=3",
        col: 4,
        row: 4,
        tone: "blue",
      },
    ],
    edges: [
      { from: "rider", to: "lb", kind: "read" },
      { from: "lb", to: "dispatch", kind: "read" },
      { from: "dispatch", to: "geo_index", label: "H3 k-ring query", kind: "read" },
      { from: "dispatch", to: "eta_pricing", label: "ETA + fare + surge", kind: "read" },
      { from: "dispatch", to: "trip_svc", label: "atomic claim · assign driver", kind: "write" },
      { from: "trip_svc", to: "trips_db", label: "CAS transition · LOCAL_QUORUM", kind: "write" },
      { from: "trip_svc", to: "driver", label: "push offer · 10-15s TTL", kind: "write" },
      { from: "driver", to: "trip_svc", label: "accept / reject", kind: "write" },
      { from: "driver", to: "location_svc", label: "gRPC stream · ~4s cadence", kind: "write" },
      { from: "location_svc", to: "geo_index", label: "upsert H3 cell", kind: "write" },
      { from: "location_svc", to: "kafka", label: "async fan-out", kind: "analytics" },
      { from: "kafka", to: "flink", kind: "analytics" },
      { from: "flink", to: "eta_pricing", label: "surge multiplier per H3 cell", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · match a rider to a driver, sub-5s p95" },
      { kind: "write", text: "write path · location pings + trip state, ~1.25M/s" },
      { kind: "analytics", text: "analytics · surge & ETA calibration, never blocks a match" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["rider", "lb", "dispatch"],
      say: "A ride request is a stateless call: Rider App through a regional load balancer to a stateless Dispatch Service. Everything else on this board exists to answer 'who's nearby and free' fast enough to hit a 5-second p95.",
    },
    {
      reveal: ["geo_index", "eta_pricing"],
      say: "Dispatch runs a two-stage funnel. An H3 k-ring query against the Geo Index gives a cheap geometric shortlist, then ETA & Pricing ranks that shortlist by real road-graph time and quotes the surge-adjusted fare.",
    },
    {
      reveal: ["trip_svc", "trips_db", "driver"],
      say: "Dispatch hands the winning candidate to Trip Service, which does an atomic compare-and-swap claim so exactly one rider ever gets that driver, persists the transition to Cassandra, and pushes the offer to the Driver App to accept or reject.",
    },
    {
      reveal: ["location_svc"],
      say: "Every online driver holds a long-lived stream into Location Ingestion, pushing a position every ~4 seconds — 1.25M writes/sec that synchronously keep the Geo Index fresh.",
    },
    {
      reveal: ["kafka", "flink"],
      say: "Location pings also fan out asynchronously into Kafka. Flink aggregates supply and demand per H3 cell into a smoothed surge multiplier and recalibrates road-graph traffic weights, feeding back into ETA & Pricing without ever touching the match path.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Rider requests a ride with pickup/dropoff and gets matched to the nearest available driver", tag: "P0" },
      { id: "FR-02", text: "Ingest real-time driver location, updated roughly every 4 seconds while online", tag: "P0" },
      { id: "FR-03", text: "Assign exactly one driver per ride request; a driver can never be double-dispatched", tag: "P0" },
      { id: "FR-04", text: "Compute ETA for pickup and for the trip, refreshed as the driver moves", tag: "P0" },
      { id: "FR-05", text: "Dynamic (surge) pricing based on real-time supply/demand imbalance per zone", tag: "P0" },
      { id: "FR-06", text: "Trip lifecycle state machine: requested → matched → arrived → in_progress → completed/canceled", tag: "P0" },
      { id: "FR-07", text: "Driver can accept, reject, or let a ride offer time out", tag: "P0" },
      { id: "FR-08", text: "Rider and driver see each other's live location during an active trip", tag: "P1" },
      { id: "FR-09", text: "Fare calculation and payment processing at trip completion", tag: "P1" },
      { id: "FR-10", text: "Trip history and receipts for riders and drivers", tag: "P1" },
      { id: "FR-11", text: "Post-trip rating and feedback for both parties", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "End-to-end latency from ride request to driver match", tag: "p95 < 5s" },
      { id: "NFR-02", text: "Driver location ingestion throughput, sustained globally", tag: "1.25M/sec" },
      { id: "NFR-03", text: "Nearby-driver geospatial query latency", tag: "p99 < 100ms" },
      { id: "NFR-04", text: "Platform availability (about 52 min downtime/year)", tag: "99.99%" },
      { id: "NFR-05", text: "Double-dispatch rate: a driver assigned to two riders at once", tag: "zero" },
      { id: "NFR-06", text: "Driver position staleness inside the matching index", tag: "< 5s" },
      { id: "NFR-07", text: "Trip state durability: no lost trips or unrecorded payments", tag: "zero loss" },
      { id: "NFR-08", text: "Concurrent active trips supported globally at peak", tag: "1M concurrent" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: the location firehose and why it drives everything",
      body: [
        "Start from the number that dictates the whole write path: how often a driver's phone reports its position. At ~5M concurrently online drivers pinging every 4 seconds, that's 5,000,000 ÷ 4 ≈ 1.25M location writes/sec, sustained, worldwide. This single number sizes the ingestion tier, the geo index's write throughput, and the shard count — get it on the board before anything else, because a cache or index sized for reads alone will fall over on this write load.",
        "Compare it to the read side: dispatch does one nearby-driver query per ride request, and with ~15M trips/day the average request rate is only ~175/sec (spiking far higher during rush-hour peaks in dense cities). So the geo index is write-dominated by more than 1000:1 — the opposite of a typical read-heavy system — and that shapes every choice below.",
      ],
      bullets: [
        { lead: "1.25M writes/sec", text: "is the sustained floor. It must be absorbed by upsert, not by rebuilding an index — a full rebuild at this rate is a non-starter." },
        { lead: "175 reads/sec average", text: "with large city-level bursts during rush hour; still dwarfed by the write volume by three orders of magnitude." },
        { lead: "TTL as a heartbeat", text: "each location key carries a ~15-20s TTL, so a driver who stops pinging (crash, app kill, tunnel) silently ages out of the matching pool without an explicit offline event." },
      ],
      pictureTitle: "Write load vs. read load on the geo index",
      pictureCaption: "writes: ~1.25M/s (location pings) · reads: ~175/s average (match requests) — over 1000:1 write-dominated index",
      pictureRows: [
        { label: "Location pings", value: "~1.25M/s sustained, 5M drivers × 1/4s", tone: "bad" },
        { label: "Match queries", value: "~175/s average, city-level bursts", tone: "good" },
      ],
      remember: {
        problem: "What single number should size the geo index and ingestion tier?",
        solution: "~1.25M location writes/sec (5M drivers ÷ 4s ping interval), well over 1000× the ~175/s average match-query rate.",
        why: "Driver location is pushed continuously whether or not anyone is requesting a ride; matching is comparatively rare.",
        tradeoff: "Designing for write throughput means the index must support cheap, frequent upserts — not the read-optimized structures a typical system reaches for first.",
        failure: "Sizing the index off read QPS alone leaves it unable to absorb the ping firehose, and it falls behind within seconds under real traffic.",
        mitigation: "Shard the index by geography so each shard only absorbs the write load of its own city, and use TTL-based expiry instead of explicit offline handshakes.",
      },
    },
    {
      n: 2,
      title: "Geospatial index: kill two options, defend H3",
      body: [
        "The core query is 'which drivers are near this point right now?' — a nearest-neighbor search over a constantly moving, constantly updating point set. Put the candidate index structures on the board and rule them out before landing on H3, Uber's own hexagonal hierarchical spatial index.",
      ],
      bullets: [
        { lead: "Geohash (base32 grid)", text: "cells are rectangular and non-uniform — cells near the poles distort, and a point near a cell edge can have its nearest neighbors in a completely different geohash prefix, forcing awkward multi-prefix boundary queries. Rejected as primary index." },
        { lead: "Quadtree", text: "adapts density well but is a pointer-heavy tree structure that's expensive to keep balanced under 1.25M writes/sec of constant point movement — every driver ping is effectively a delete-then-insert. Rejected." },
        { lead: "H3 hexagons", text: "every cell has 6 equidistant neighbors (no diagonal-distance distortion like a square grid), cells tile uniformly across the globe, and a cell ID is just an integer — no tree rebalancing, a location update is a single key upsert. At resolution 8 (~0.7 km² per hexagon), a driver's candidate set is a k-ring lookup: 7 cells at k=1, 19 cells at k=2 if supply is thin. Winner." },
      ],
      pictureTitle: "Geo index: kill two, keep one",
      pictureRows: [
        { label: "Geohash", value: "boundary distortion, edge-cell blind spots → reject", tone: "bad" },
        { label: "Quadtree", value: "tree rebalance per ping at 1.25M/s → reject", tone: "bad" },
        { label: "H3 hexagons", value: "uniform neighbors, O(1) upsert → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Index 5M moving points and answer 'nearest drivers' in under 100ms.",
        solution: "H3 hexagonal cells (resolution 8, ~0.7 km²) in Valkey; a driver ping is a single key upsert, a query is a k-ring expansion.",
        why: "Hexagons have uniform equidistant neighbors and tile without the edge distortion of a square/rectangular grid, and cell IDs need no rebalancing structure.",
        tradeoff: "Coarser resolution means more false-positive candidates to filter by exact distance; finer resolution means more cells to scan in sparse areas.",
        failure: "Geohash boundary cells miss real nearby drivers who fall just across a prefix boundary; a quadtree can't keep up with constant point churn.",
        mitigation: "Start the k-ring at k=1 and widen to k=2, k=3 automatically when candidate count is below a threshold (sparse suburbs, late-night hours).",
      },
    },
    {
      n: 3,
      title: "Matching without double-dispatch: the atomic claim",
      body: [
        "Multiple dispatch requests can race for the same nearby driver — two riders in the same block both request a ride within the same second. If matching just reads 'is this driver available?' and then writes 'assign', two requests can both read available before either writes, and the driver is offered to both. The fix is a single atomic conditional write, not a read-then-write.",
      ],
      bullets: [
        { lead: "Read-then-write (naive)", text: "check driver.status == available, then set to offered. Classic check-then-act race: two dispatchers can both pass the check before either writes. Rejected." },
        { lead: "Global lock per driver", text: "correct, but a lock service in the hot path of every match adds latency and a single point of contention exactly where you need speed. Overkill for this access pattern." },
        { lead: "Compare-and-swap (CAS)", text: "one atomic operation: SET driver:{id}:status = offered IF status == available (Redis SET NX-style, or a Cassandra lightweight transaction). Exactly one racing request succeeds; the rest see the CAS fail and immediately move to the next candidate in their ranked list. Winner." },
      ],
      pictureTitle: "Guaranteeing exactly one claim",
      pictureRows: [
        { label: "Read-then-write", value: "check-then-act race → double-dispatch possible", tone: "bad" },
        { label: "Global lock service", value: "correct but adds a hop to every match", tone: "neutral" },
        { label: "CAS on driver status", value: "one atomic op, loser retries next candidate", tone: "good" },
      ],
      remember: {
        problem: "Guarantee a driver is never offered to two riders at once, under concurrent match requests.",
        solution: "Atomic compare-and-swap on driver status (available → offered) instead of a separate read then write.",
        why: "CAS makes the check and the mutation a single indivisible operation, so no interleaving of two requests can both succeed.",
        tradeoff: "The losing dispatcher must fall through to its next-ranked candidate, adding a small amount of matching latency in the contended case.",
        failure: "A read-then-write pattern under load produces real double-dispatch: two riders both see a driver arriving, one gets stranded.",
        mitigation: "Rank candidates before attempting claims and retry down the ranked list on CAS failure; cap retries and widen the k-ring if the list is exhausted.",
      },
    },
    {
      n: 4,
      title: "Location ingestion pipeline: why streaming, and how it's sharded",
      body: [
        "1.25M pings/sec cannot be a stateless REST POST per ping — connection setup/teardown overhead alone would dominate. Drivers hold a long-lived streaming connection (gRPC bidi stream or persistent WebSocket) to a Location Ingestion Service, and that service is sharded by geography so no single shard has to absorb global write volume.",
      ],
      bullets: [
        { lead: "Long-lived stream, not per-ping HTTP", text: "one connection amortizes TLS/TCP setup across thousands of pings, cutting connection overhead by orders of magnitude versus a new request every 4 seconds." },
        { lead: "Sharded by city/region", text: "a driver in Chicago never touches infrastructure provisioned for Mumbai; this bounds both the write load per shard and the blast radius of a shard outage to one metro area." },
        { lead: "Dual write, one sync one async", text: "the ping synchronously upserts the driver's H3 cell in the geo index (needed immediately for matching), and asynchronously fans out to Kafka for anything that can tolerate lag — surge computation, trip-replay for support, historical analytics." },
      ],
      pictureTitle: "One ping, two paths",
      pictureRows: [
        { label: "Sync: geo index upsert", value: "must land before the next match query", tone: "good" },
        { label: "Async: Kafka fan-out", value: "surge, analytics — a few seconds of lag is fine", tone: "neutral" },
        { label: "Per-ping HTTP (rejected)", value: "connection overhead dominates at 1.25M/s", tone: "bad" },
      ],
      remember: {
        problem: "Absorb 1.25M location writes/sec without connection overhead swamping the ingestion tier.",
        solution: "Long-lived streaming connections per driver, ingestion sharded by city, with a sync geo-index write and an async Kafka fan-out.",
        why: "Amortizing connection setup and bounding each shard to one geography keeps per-shard load and blast radius manageable.",
        tradeoff: "Streaming connections are stateful infrastructure (unlike stateless HTTP), so the ingestion tier needs connection-aware load balancing and reconnect handling.",
        failure: "Per-ping HTTP requests at this rate spend more time on connection setup than on the actual write.",
        mitigation: "City-sharded ingestion pods with sticky routing by driver ID, and a TTL-based expiry so a dropped connection self-heals the index within ~15-20s.",
      },
    },
    {
      n: 5,
      title: "Surge pricing: smoothing the number that touches money",
      body: [
        "Surge is a demand/supply ratio per H3 cell (open ride requests versus available drivers in that cell and its neighbors), but a raw ratio recomputed every second would flap: a multiplier that jumps from 1.2x to 3.0x and back within a minute erodes rider trust and is trivially gameable by drivers going offline in a cell to trigger a spike. The number that touches money needs to move slowly and predictably.",
      ],
      bullets: [
        { lead: "Raw ratio, recomputed instantly", text: "reacts to every single request/driver change — visibly flaps, easy to game by briefly starving a cell of visible supply. Rejected as the production signal." },
        { lead: "EWMA-smoothed ratio", text: "an exponentially weighted moving average over a trailing 2-3 minute window damps short spikes while still reacting to sustained imbalance within the window." },
        { lead: "Stepped, capped multiplier", text: "the smoothed ratio is quantized into discrete steps (1.0x, 1.2x, 1.5x, 2.0x, ...) with a hard cap, so riders see a stable number and drivers can't hunt for split-second peaks." },
      ],
      pictureTitle: "Why surge can't be instantaneous",
      pictureRows: [
        { label: "Raw ratio, live", value: "flaps second to second, gameable", tone: "bad" },
        { label: "EWMA over ~2-3 min", value: "damps spikes, still tracks real imbalance", tone: "good" },
        { label: "Stepped + capped", value: "stable number riders/drivers can trust", tone: "good" },
      ],
      remember: {
        problem: "Price real supply/demand imbalance without producing a flappy, gameable number.",
        solution: "Flink computes an EWMA-smoothed demand/supply ratio per H3 cell over a ~2-3 minute window, quantized into stepped, capped multipliers.",
        why: "A price that changes every second is both untrustworthy to riders and exploitable by drivers manipulating visible supply.",
        tradeoff: "Smoothing means surge lags a genuine sudden spike (e.g., a stadium letting out) by roughly the window length.",
        failure: "An unsmoothed raw ratio whipsaws between values and can be manipulated by drivers toggling availability in a cell.",
        mitigation: "Tune the EWMA window and step granularity against real event-driven demand spikes; cap the multiplier so no single number becomes indefensible.",
      },
    },
    {
      n: 6,
      title: "ETA and routing: why straight-line distance is wrong",
      body: [
        "Matching needs an ETA to rank candidates (the nearest driver by H3 cell isn't necessarily the fastest to arrive), and pricing needs a trip-distance estimate. Both come from a dedicated ETA & Pricing service that routes over the actual road graph, not Haversine straight-line distance.",
      ],
      bullets: [
        { lead: "Straight-line / Haversine", text: "ignores one-way streets, bridges, highway on-ramps, and traffic. In dense urban grids the error versus real driving distance can be 2-3x. Fine as a coarse pre-filter, wrong as the final ranking signal." },
        { lead: "Precomputed road graph + contraction hierarchies", text: "shortest-path queries over the real street network, precomputed offline so an online query returns in milliseconds instead of running Dijkstra from scratch." },
        { lead: "Live traffic overlay", text: "edge weights (road segment travel times) are periodically recalibrated from the same location-ping stream via Flink, so ETAs reflect current congestion, not just static road geometry." },
      ],
      pictureTitle: "Distance signal: coarse filter vs. final ranking",
      pictureRows: [
        { label: "Haversine straight-line", value: "cheap pre-filter; 2-3x error in dense grids", tone: "neutral" },
        { label: "Road-graph shortest path", value: "accurate ETA for final candidate ranking", tone: "good" },
        { label: "Live traffic recalibration", value: "edge weights refreshed from ping stream", tone: "good" },
      ],
      remember: {
        problem: "Rank driver candidates and quote fares by real arrival time, not raw distance.",
        solution: "A dedicated ETA & Pricing service routes over a precomputed road graph (contraction hierarchies) with live traffic-weighted edges.",
        why: "Straight-line distance ignores road topology and one-way constraints; it's the wrong signal once candidates are down to a handful of nearby drivers.",
        tradeoff: "Road-graph routing is more expensive than Haversine, so it's applied only to the short candidate list the geo index already narrowed down, not to every driver.",
        failure: "Ranking purely by straight-line distance can pick a driver who is geometrically close but blocked by a river or highway, arriving far later than a 'farther' driver.",
        mitigation: "Two-stage ranking: H3 k-ring for a cheap geometric shortlist, then road-graph ETA only on that shortlist.",
      },
    },
    {
      n: 7,
      title: "Trip state machine: why every transition is compare-and-swap",
      body: [
        "A trip moves through a strict sequence — requested → matched → driver_en_route → arrived → in_progress → completed/canceled — and events driving these transitions arrive over an unreliable network from two different mobile apps that can retry, duplicate, or reorder messages. If a transition is a blind overwrite, a duplicated or delayed 'cancel' event could stomp a trip that already completed and paid out.",
      ],
      bullets: [
        { lead: "Blind overwrite (rejected)", text: "sets trip.state = X unconditionally. A late-arriving duplicate or out-of-order event can silently revert a completed, paid trip to canceled." },
        { lead: "CAS transition table", text: "each write is UPDATE trips SET state = 'in_progress' IF state = 'arrived' (a Cassandra lightweight transaction or equivalent). Illegal transitions simply fail the CAS and are dropped or logged, never applied." },
        { lead: "Durable + replayable", text: "every transition is also emitted to Kafka, so billing, analytics, and support tooling can replay a trip's full history without re-deriving it from mutable state." },
      ],
      pictureTitle: "Guarding trip state against duplicate/out-of-order events",
      pictureRows: [
        { label: "Blind overwrite", value: "duplicate cancel can un-complete a paid trip", tone: "bad" },
        { label: "CAS per transition", value: "illegal transition fails closed, no corruption", tone: "good" },
        { label: "Kafka event log", value: "full trip history replayable for billing/support", tone: "good" },
      ],
      remember: {
        problem: "Enforce a strict trip lifecycle when events can arrive duplicated or out of order over mobile networks.",
        solution: "Every state transition is a compare-and-swap (old state → new state); illegal transitions fail closed instead of overwriting.",
        why: "Two mobile apps retrying over flaky networks guarantees duplicates and reordering; the state store must be the arbiter of validity, not the client.",
        tradeoff: "A few legitimate transitions may need a client-side retry when they lose a race against a duplicate, adding minor complexity to client logic.",
        failure: "Blind overwrites let a stale or duplicate event corrupt a trip that has already completed and been paid for.",
        mitigation: "CAS transitions plus a durable Kafka log of every transition, so billing and support can always reconstruct the true sequence of events.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a geospatial matching problem wrapped around a location firehose: index ~5M moving drivers in H3 cells, and answer 'who's nearby' fast enough to match a rider in under 5 seconds.",
      "The write side (1.25M location pings/sec) dwarfs the read side (~175 match queries/sec) by three orders of magnitude — the opposite of most systems, and it drives the whole architecture.",
      "Matching a driver is a compare-and-swap on driver status, never a read-then-write, so two riders can never claim the same driver.",
      "Surge pricing is EWMA-smoothed and stepped so the number that touches money doesn't flap or become gameable.",
      "Trip state is a strict transition table enforced by CAS, because two mobile apps retrying over flaky networks guarantees duplicate and out-of-order events.",
    ],
    flows: [
      {
        kind: "read",
        title: "MATCH · ~175/S AVG · P95 < 5S",
        summary:
          "A ride request narrows 5M drivers down to a handful via the geo index, ranks them by real road ETA, then atomically claims the winner so no one else can grab the same driver.",
        steps: [
          { label: "Rider App", note: "submits pickup/dropoff" },
          { label: "Regional LB", note: "routes to the local dispatch shard" },
          { label: "Dispatch Service", note: "stateless matcher" },
          { label: "Geo Index", note: "H3 k-ring query, ~7-19 candidate cells" },
          { label: "ETA & Pricing", note: "road-graph ETA + surge-adjusted fare on the shortlist" },
          { label: "Trip Service", note: "CAS claim: available → offered" },
          { label: "Driver App", note: "push offer, 10-15s to accept/reject" },
        ],
      },
      {
        kind: "write",
        title: "LOCATION + TRIP STATE · ~1.25M/S",
        summary:
          "Every driver holds a long-lived stream pushing a position every ~4 seconds. It synchronously updates the matching index and asynchronously feeds everything else. Trip transitions are separate, small, and CAS-guarded.",
        steps: [
          { label: "Driver App", note: "gRPC stream, ping every ~4s" },
          { label: "Location Ingestion", note: "city-sharded, sync + async fan-out" },
          { label: "Geo Index", note: "upsert H3 cell, ~15-20s TTL" },
          { label: "Trip Service", note: "CAS transition on accept/arrive/start/complete" },
          { label: "Cassandra", note: "LOCAL_QUORUM write, trip + ledger" },
        ],
      },
      {
        kind: "analytics",
        title: "SURGE & ETA CALIBRATION · RUNS ON THE SIDE",
        summary:
          "Location pings also flow into Kafka for anything that can tolerate a few seconds of lag. Flink aggregates supply/demand per H3 cell and recalibrates road-graph edge weights from real driver speeds.",
        steps: [
          { label: "Location Ingestion", note: "async fan-out, never blocks a ping ack" },
          { label: "Kafka", note: "per-city partitions" },
          { label: "Flink", note: "EWMA demand/supply per H3 cell, ~2-3 min window" },
          { label: "ETA & Pricing", note: "reads surge multiplier + traffic-weighted edges" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "~5M concurrently online drivers, ~100M MAU riders, ~15M trips/day",
          "Location pings: 5M ÷ 4s ≈ 1.25M writes/sec, sustained",
          "Match queries: ~175/s average, large city-level rush-hour bursts",
          "H3 resolution 8 ≈ 0.7 km² per hex; k-ring 1 = 7 cells, k-ring 2 = 19 cells",
          "Match latency budget: p95 < 5s from request to driver assignment",
          "Driver offer timeout: 10-15s before falling through to next candidate",
          "Geo index key TTL: ~15-20s, doubling as an offline/crash heartbeat",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "H3 hexagonal index over geohash (edge distortion) and quadtree (rebalance cost)",
          "Atomic CAS claim on driver status, never read-then-write, to prevent double-dispatch",
          "Long-lived streaming ingestion, sharded by city, not per-ping HTTP",
          "Two-stage ranking: H3 shortlist first, road-graph ETA only on the shortlist",
          "Surge as an EWMA-smoothed, stepped, capped multiplier — never a raw live ratio",
          "Trip transitions enforced by CAS against a fixed state table, with a durable Kafka log",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The write:read ratio on the geo index is well over 1000:1 — the opposite of most systems",
          "Surge must be smoothed/capped or it becomes untrustworthy and gameable",
          "Sharding by geography bounds both load and blast radius per shard",
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
      goal: "Get the driver count, ping interval, trip volume, and latency target on the board before drawing anything. These five numbers drive every later decision.",
      why: "The interviewer is checking whether you notice this system is write-dominated on the geo index, which is the opposite of most systems candidates have rehearsed. Locking the numbers first prevents you from defaulting to a read-heavy-cache mental model.",
      steps: [
        { kind: "ASK", text: '**"How many drivers are online concurrently, and how often do they report location?"** Land on "~5M drivers, every ~4 seconds". Do the math out loud: **"5M ÷ 4s ≈ 1.25M location writes/sec"** and write it top-left.' },
        { kind: "ASK", text: '**"What\'s the trip volume, and the match latency target?"** Land on "~15M trips/day", "driver assigned within ~5 seconds p95". Write **"1.25M w/s vs ~175 match q/s — write-dominated"**.' },
        { kind: "SAY", text: 'State scope. In: "location ingestion", "geospatial matching", "ETA", "surge pricing", "trip state machine". Out: "payments processing internals", "fraud/abuse detection", "driver onboarding". "I\'ll flag if we should come back to any of those."' },
        { kind: "SAY", text: 'Name the one non-negotiable up front: **"a driver can never be offered to two riders at once — that\'s a correctness bug, not a performance one."** This sets up the CAS discussion later.' },
      ],
      grading: "Are the five numbers on the board, is the write:read imbalance called out explicitly, and is double-dispatch named as a correctness requirement before it's asked about?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Define the request/match/trip endpoints and the driver-location and trip-state shapes, with H3 cell ID named as the location's primary index key.",
      why: "Naming H3 explicitly and putting the cell ID in the data model up front signals you already know the geospatial approach, rather than discovering it mid-deep-dive.",
      steps: [
        { kind: "WRITE", text: 'Write the core endpoints: **"POST /rides { pickup, dropoff }"** → "{ tripId }". **"PATCH /drivers/{id}/location { lat, lng }"** streamed, not per-call REST. **"POST /trips/{id}/accept"**, **"/reject"** from the driver app.' },
        { kind: "DRAW", text: 'Sketch driver location state: **"driver_id, h3_cell (res 8), lat, lng, status (available/offered/on_trip), updated_at"**. Say out loud: "h3_cell is the actual index key — lat/lng is just for the final precise-distance filter."' },
        { kind: "DRAW", text: 'Sketch the trip row: **"trip_id (PK), rider_id, driver_id, state, pickup, dropoff, fare, created_at"**. "State transitions are CAS-guarded — I\'ll come back to why."' },
        { kind: "RULE OUT", text: '"A per-ping HTTP POST doesn\'t scale to 1.25M/sec — connection overhead alone dominates. This has to be a persistent stream." Cross off naive polling.' },
      ],
      grading: "H3 cell named as the index key in the data model itself, trip state flagged as CAS-guarded before the deep dive, and per-ping HTTP explicitly ruled out.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: match (read), location + trip-state (write), surge/ETA calibration (analytics). Label arrows with the real numbers, not just box names.",
      why: "Separating location ingestion from matching from surge calibration proves you understand they have different latency and consistency needs — location writes are synchronous-critical for matching but async-tolerant for analytics.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **match path**: Rider App → Regional LB → Dispatch Service → Geo Index (H3 k-ring) → ETA & Pricing (road-graph shortlist) → Trip Service (CAS claim) → Driver App (offer). Label **"~175/s avg"**, **"p95 < 5s"**.' },
        { kind: "DRAW", text: 'Add the **write lane**: Driver App → Location Ingestion (gRPC stream, city-sharded) → Geo Index (upsert). Label **"1.25M/s"**, **"~4s cadence"**. Separately: Trip Service → Cassandra, labeled **"CAS transition, LOCAL_QUORUM"**.' },
        { kind: "DRAW", text: 'Add the **analytics lane**: Location Ingestion → Kafka → Flink → feeds back into ETA & Pricing as a surge multiplier. Label it dashed, **"async, never blocks a ping ack or a match"**.' },
        { kind: "SAY", text: '"Three lanes with three different consistency needs: the geo-index write must be synchronous because matching reads it immediately; the Kafka fan-out for surge can lag by seconds; trip-state writes must be linearizable CAS because they touch money."' },
      ],
      grading: "Three clearly separated lanes, the geo-index sync-write vs. Kafka async-write distinction stated explicitly, and arrows labeled with the real throughput/latency numbers.",
    },
    {
      n: 4,
      title: "Deep Dive: Geospatial Matching and the Atomic Claim",
      minutes: 8,
      goal: "Defend H3 over geohash/quadtree, and walk the CAS claim that prevents double-dispatch under concurrent match requests.",
      why: "This is the signature sub-problem. The interviewer wants to see both halves: a geospatial index that answers 'who's nearby' fast, and a concurrency-safe claim so 'nearby' never becomes 'double-booked'.",
      steps: [
        { kind: "SAY", text: '"Geohash cells are non-uniform rectangles with real boundary-distortion bugs; a quadtree can\'t stay balanced under 1.25M writes/sec of constant point churn. H3 gives uniform hexagonal cells — 6 equidistant neighbors, cell ID is just an integer, so a ping is one upsert."' },
        { kind: "DRAW", text: 'Draw a hex grid with the query point and a k=1 ring (7 cells) around it. "If candidate count is too low, widen to k=2, 19 cells — automatic, not manual."' },
        { kind: "SAY", text: '"The race: two dispatch requests can both read \'available\' before either writes \'offered\'. Fix: one atomic CAS — SET status=offered IF status=available. The loser fails closed and retries the next-ranked candidate." Write the CAS expression on the board.' },
        { kind: "RULE OUT", text: '"A read-then-write is a check-then-act race — real double-dispatch under load. A global lock service works but adds a hop to every match; CAS gets the same guarantee for free inside the write itself."' },
      ],
      grading: "H3 defended against both alternatives with a concrete reason each, the CAS expression written explicitly, and the double-dispatch race explained as a check-then-act bug, not just asserted.",
    },
    {
      n: 5,
      title: "Deep Dive: Surge Pricing and ETA",
      minutes: 7,
      goal: "Explain why surge must be smoothed and capped, and why the final driver ranking uses road-graph ETA instead of straight-line distance.",
      why: "Anyone can say 'surge = demand/supply'. The interviewer wants to hear why a raw live ratio is actively wrong for something that touches money, and why the geo index alone isn't enough to rank candidates.",
      steps: [
        { kind: "SAY", text: '"A raw demand/supply ratio recomputed every second flaps and is gameable — drivers can go dark in a cell to trigger a spike. Flink computes an EWMA over a ~2-3 minute window, then the smoothed value is quantized into steps — 1.0x, 1.2x, 1.5x — with a hard cap."' },
        { kind: "SAY", text: '"For ranking, straight-line distance is wrong — it ignores one-ways, bridges, and traffic, and can be 2-3x off in a dense grid. So it\'s a two-stage funnel: H3 gives a cheap geometric shortlist, then a road-graph ETA (precomputed contraction hierarchies) ranks just that shortlist."' },
        { kind: "SAY", text: '"Traffic weights on the road graph get recalibrated from the same location-ping stream via Flink — real driver speeds on real segments, not static road geometry."' },
        { kind: "SAY", text: '"Trade-off I\'m making explicit: smoothing surge means it lags a genuine sudden spike — a stadium letting out — by roughly the window length. That\'s a deliberate choice, not an oversight."' },
      ],
      grading: "Surge smoothing explained with the gameability motivation (not just 'to reduce noise'), the two-stage ranking funnel named, and the smoothing lag trade-off stated as a deliberate choice.",
    },
    {
      n: 6,
      title: "Wrap: Failure Modes and Close",
      minutes: 5,
      goal: "Name what breaks under stale locations, network partitions during a trip, and duplicate/out-of-order trip events — then close with a one-sentence summary.",
      why: "Staff-level signal here is anticipating the messy real-world failure modes (crashed driver app, flaky mobile network) rather than only the happy path, plus a clean, paced close.",
      steps: [
        { kind: "SAY", text: '"If a driver\'s app crashes mid-ping, the geo index self-heals via the ~15-20s TTL — no explicit offline handshake needed, but that means up to 20 seconds of matching against a phantom driver in the worst case."' },
        { kind: "SAY", text: '"Trip events can arrive duplicated or out of order over mobile networks. Every transition is CAS-guarded against a fixed state table, so a stale duplicate fails closed instead of corrupting a completed, paid trip."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need global 5-second matching, or is that a per-city SLA? Rural areas with sparse driver density may need a different latency budget than Manhattan." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a write-dominated geospatial index (H3) feeding a CAS-guarded matcher, with smoothed surge and road-graph ETAs layered on top. With more time I\'d cover payment reconciliation and driver-side fraud detection."' },
      ],
      grading: "At least two concrete failure modes named with their mitigation, one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a design that matches riders to drivers, but the geospatial indexing and concurrency safety stay hand-wavy.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, matching service, a database, and 'some kind of cache'.",
          "Knows drivers send location updates periodically and stores them somewhere queryable.",
          "Proposes computing distance between rider and drivers to find the nearest one.",
          "Adds a queue when asked how analytics or notifications work.",
          "Can describe the trip lifecycle states in words.",
        ],
        gaps: [
          "Doesn't do the 1.25M writes/sec math, or treats the geo index as read-heavy by default.",
          "Reaches for 'query all drivers and filter by distance' with no spatial index.",
          "Doesn't recognize the double-dispatch race — assumes a simple status flag is enough.",
          "Straight-line distance is treated as good enough for ranking, without noting the error.",
          "Surge, if mentioned, is 'multiply price when busy' with no smoothing or gameability discussion.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, names H3 and the CAS claim without heavy prompting, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the ping rate, write throughput, and match latency target on the board within 5 minutes.",
          "Names H3 (or at minimum a proper geospatial index) and can explain the k-ring query.",
          "Identifies the double-dispatch race and proposes CAS or a lock as the fix.",
          "Separates the location-write path from the trip-state path, noting different consistency needs.",
          "Mentions surge should be smoothed, when asked why a raw ratio is a problem.",
          "Distinguishes straight-line pre-filter from road-graph ranking when prompted.",
        ],
        gaps: [
          "Volunteers surge smoothing/gameability only after the interviewer asks 'what if surge is jumpy?', not on their own.",
          "Doesn't proactively separate sync (geo-index) vs. async (Kafka) writes off a single ping without prompting.",
          "Quantifies failure in words ('the index gets stale') rather than numbers ('up to 20s of phantom-driver matching from the TTL').",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, surfaces the write-dominated nature of the system unprompted, and brings the operational maturity to name failure modes before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "States unprompted that this system is write-dominated (1.25M/s pings vs ~175/s matches), the inverse of a typical design, and shows how that inverts standard read-heavy-cache instincts.",
          "Explains the double-dispatch race as a specific check-then-act bug, and defends CAS over a lock service on latency grounds.",
          "Volunteers surge gameability (drivers going dark to trigger a spike) as the reason for EWMA smoothing and stepped, capped multipliers — before being asked 'what if it flaps?'.",
          "Names the TTL-driven self-healing of the geo index as a deliberate trade-off (stale-driver window vs. explicit offline handshake complexity), with the concrete staleness bound.",
          "Pushes back on a global one-size latency SLA, proposing per-city or per-density budgets.",
          "Closes with a one-sentence summary and explicitly lists what's out of scope (payment reconciliation, fraud detection) rather than trailing off.",
          "Treats the interviewer as a collaborator: paces the 40 minutes, parks tangents, returns to them only if time allows.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Proposing 'scan all drivers and compute distance' instead of a spatial index — this doesn't survive 5M drivers, let alone the query load.",
      "A read-then-write status check for matching, missing the check-then-act race that causes real double-dispatch.",
      "Treating the geo index as read-heavy and sizing it off match QPS instead of the 1.25M/sec ping firehose.",
      "Surge pricing as a raw, instantly-recomputed ratio with no mention of smoothing, capping, or gameability — a number that touches money shouldn't be this naive.",
      "Ranking drivers purely by straight-line distance with no acknowledgment of road-network error in dense cities.",
      "Putting trip-state writes on a blind overwrite instead of a guarded transition, risking a duplicate event corrupting a completed, paid trip.",
      "No story for a driver's app crashing mid-trip or mid-ping — the design silently assumes every client behaves.",
    ],
    followUps: [
      {
        q: "Why H3 over a simple lat/lng range query with a geospatial database index (e.g., PostGIS)?",
        a: "A geospatial DB index works fine at modest scale, but at 1.25M writes/sec across a globally distributed fleet you want the index itself sharded and the query to be a cheap integer lookup, not a range scan through a B-tree/R-tree under heavy concurrent writes. H3 cell IDs are integers you can shard directly (by cell prefix or by city), turn every ping into an O(1) upsert, and the k-ring expansion is a fixed small set of neighbor lookups rather than a range predicate — which keeps p99 well under the 100ms budget even as write volume grows.",
      },
      {
        q: "What happens if the geo index and the actual driver position drift apart — say, a tunnel with no signal for 30 seconds?",
        a: "The TTL (~15-20s) is the safety net: if no new ping arrives, the driver's index entry expires and they simply stop being a match candidate, rather than staying 'available' at a stale location forever. The cost is a small window (up to the TTL) where a driver who just lost signal is invisible to matching even though they're still there and reachable once signal returns — an acceptable trade given the alternative is stale-location matches that fail on arrival.",
      },
      {
        q: "How do you prevent surge pricing from being gamed by drivers coordinating to go offline?",
        a: "Two layers: the EWMA smoothing means a brief coordinated dip doesn't move the published multiplier much within one window, and the stepped quantization means even a real sustained shift has to cross a whole step boundary to change the price riders see, not just nudge a continuous number. On top of that, sustained anomalous multi-driver offline patterns in a cell are a fraud-detection signal fed by the same Kafka stream, which is explicitly out of scope for this design but flagged as a real production concern.",
      },
      {
        q: "Why not just broadcast a ride request to all nearby drivers and let the first to accept win?",
        a: "Broadcast-and-first-accept avoids the sequential-offer latency of trying one candidate at a time, but it means every offer sent to a driver who doesn't win was wasted attention (driver fatigue, notification noise), and you still need the same CAS claim underneath to make 'first to accept wins' atomic — so it doesn't remove the concurrency problem, it just changes who initiates. Sequential nearest-first with a short timeout keeps notification volume low and predictable; a batched broadcast to the top-3 candidates is a reasonable middle ground worth mentioning if the interviewer pushes on offer latency.",
      },
      {
        q: "How would this change for a driver actively on a trip versus one who's idle?",
        a: "An idle driver's location is written purely for matching and can tolerate the full TTL/staleness window described above. A driver mid-trip is on a different, tighter path: their location feeds live trip tracking for the rider (lower staleness tolerance, since the rider is watching the dot move) and the road-graph ETA recalculation for arrival time, so that stream is typically prioritized or even routed with a shorter effective TTL and higher ping frequency than an idle driver's.",
      },
      {
        q: "What's the failure mode if the Geo Index (Valkey) shard for a city goes down?",
        a: "Matching in that city degrades hard — no candidate lookups possible — but it's contained to that city because the index is sharded by geography; other cities are unaffected. The recovery path is that driver apps keep streaming pings to Location Ingestion regardless (pings are buffered/retried), so once the shard (or its replica) comes back, it repopulates within roughly one TTL window (~15-20s) as drivers' next pings land, rather than needing a slow cold rebuild from a durable store.",
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
          "This is a write-dominated geospatial index wrapped around a concurrency-safe claim. The core operation isn't a lookup by key, it's 'find the nearest available point in a constantly moving set and claim it exactly once' — and everything expensive (H3, CAS, sharded ingestion) exists to make that operation fast, fresh, and race-free at 5M moving points.",
          "Anchor everything on five numbers: ~5M online drivers, a ~4s ping interval (≈1.25M writes/sec), ~175 match requests/sec average, a p95 < 5s match latency, and zero tolerance for double-dispatch. Every structural choice below is a consequence of these numbers.",
        ],
      },
      {
        heading: "Why this system is write-dominated, and why that matters",
        body: [
          "Most systems candidates rehearse are read-heavy: a cache absorbs reads, the database is the write bottleneck. Here it's inverted — 1.25M writes/sec against ~175 reads/sec, over 1000:1. That flips the default instinct: instead of optimizing a cache for read fan-out, the geo index has to optimize for constant, cheap upserts, and reads (k-ring queries) are the comparatively rare, comparatively expensive operation that can afford a bit more work per call.",
          "This is why H3 wins over a geospatial database index or a quadtree: a location ping needs to be a single O(1) key upsert with no rebalancing, tree traversal, or lock contention, because that operation happens 1.25M times a second.",
        ],
      },
      {
        heading: "Geospatial indexing with H3",
        body: [
          "H3 tiles the globe in hexagonal cells at multiple resolutions; resolution 8 (~0.7 km² per cell) is a reasonable city-matching granularity. Every cell has 6 equidistant neighbors — no diagonal-distance distortion like a square grid — which makes a k-ring expansion (the cell plus its k rings of neighbors) a clean way to widen a search: k=1 is 7 cells, k=2 is 19, and the system widens automatically when candidate count is thin (sparse suburbs, off-peak hours).",
          "A driver ping upserts one Valkey key keyed by H3 cell; a match query does a k-ring lookup for the candidate driver set, then a small number of those candidates go through precise lat/lng distance filtering and road-graph ranking. The two-stage funnel (cheap geometric shortlist → expensive precise ranking) keeps the expensive part bounded regardless of how dense the driver population is.",
        ],
      },
      {
        heading: "The atomic claim: preventing double-dispatch",
        body: [
          "Multiple riders can request rides near the same driver within the same second, and naive matching — read driver status, then write an assignment — has a check-then-act race: two dispatch requests can both observe 'available' before either commits its write. The fix is collapsing the check and the write into one atomic compare-and-swap: update status from available to offered only if it is currently available. Exactly one of the racing requests succeeds; the CAS failure on the others is the signal to immediately retry the next candidate in their ranked list.",
          "This is cheaper than a dedicated distributed lock service in the hot path — the atomicity lives inside the write itself rather than requiring an extra acquire/release round trip — and it generalizes: every later trip-state transition (accept, arrive, start, complete, cancel) uses the same CAS pattern against a fixed transition table, so illegal or duplicate/out-of-order events fail closed instead of corrupting state.",
        ],
      },
      {
        heading: "Location ingestion at 1.25M writes/sec",
        body: [
          "Per-ping HTTP requests would spend more time on connection setup than on the actual write at this volume, so drivers hold a long-lived stream (gRPC bidi or persistent WebSocket) to a Location Ingestion Service sharded by city/region. Sharding by geography does two things at once: it bounds the write load any single shard has to absorb, and it bounds the blast radius of a shard outage to one metro area rather than the whole platform.",
          "Each ping does two things: a synchronous upsert into the geo index (because matching needs this immediately) and an asynchronous fan-out to Kafka (because surge computation, ETA calibration, and analytics can tolerate a few seconds of lag). Keeping these separate means a slow downstream analytics consumer can never add latency to the matching-critical path.",
        ],
      },
      {
        heading: "Surge pricing and ETA: the two numbers that touch trust",
        body: [
          "Surge and ETA are the two outputs riders scrutinize most, and both resist naive implementations. A raw, instantly-recomputed demand/supply ratio per H3 cell flaps and is gameable (drivers going dark in a cell to spike the price), so Flink computes an EWMA over a trailing 2-3 minute window and quantizes it into stepped, capped multipliers — a number that moves slowly and predictably, at the cost of lagging genuine sudden spikes by roughly the window length.",
          "ETA ranking similarly resists the obvious shortcut: straight-line (Haversine) distance ignores road topology and can be 2-3x off in a dense city grid, so it's used only as a cheap pre-filter. The actual ranking of the geo-index shortlist runs over a precomputed road graph (contraction hierarchies, in the spirit of OSRM) with edge weights periodically recalibrated from real driver speeds pulled off the same location-ping stream — so ETAs reflect live traffic, not just static road geometry.",
        ],
      },
    ],
  },
};
