import type { Problem } from "@/lib/types";

export const googleMaps: Problem = {
  slug: "google-maps",
  num: "5.3",
  title: "Design Google Maps",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a mapping and navigation platform serving 1B+ monthly users worldwide: render map tiles at any zoom, geocode free-text search to a place, compute turn-by-turn driving directions with a live ETA over a ~200M-edge road graph, and keep that ETA honest by ingesting GPS pings from ~20M concurrent navigation sessions in real time.",
  ],
  hardParts:
    "The hard parts: computing a shortest path over a 200M-edge world graph in well under 100ms instead of seconds, turning noisy GPS pings from millions of phones into trustworthy per-road speeds without route ETAs flapping every few seconds, and doing spatial search (tiles, POIs, addresses) without ever falling back to a flat scan.",
  keyTopics: [
    "Contraction Hierarchies (Hierarchical Routing)",
    "Quadtree Tile Pyramid",
    "S2 / Geospatial Indexing",
    "HMM Map-Matching for Noisy GPS",
    "Traffic Overlay Feedback Loop",
  ],
  foundationsReferenced: [
    { label: "Dijkstra's Algorithm", tone: "blue" },
    { label: "Quadtrees", tone: "green" },
    { label: "Kafka", tone: "orange" },
    { label: "Bigtable / Cassandra", tone: "purple" },
    { label: "Hidden Markov Models", tone: "blue" },
    { label: "CDN", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "cdn", label: "Tile CDN", sub: "~90% hit, edge cache", col: 1, row: 1, tone: "green" },
      { id: "client", label: "Client", sub: "mobile / web", col: 1, row: 2, tone: "slate" },
      { id: "gateway", label: "API Gateway", sub: "search · route · ping", col: 2, row: 2, tone: "slate" },
      { id: "search", label: "Search Service", sub: "geocode + POI", col: 3, row: 2, tone: "green" },
      {
        id: "geoindex",
        label: "Geo Index",
        sub: "S2 cells + inverted index",
        mono: "R-tree per cell",
        col: 4,
        row: 2,
        tone: "blue",
      },
      { id: "kafka", label: "Kafka", sub: "GPS ping stream", col: 2, row: 3, tone: "orange" },
      { id: "mapmatch", label: "Map Matcher", sub: "Flink · HMM snap-to-road", col: 3, row: 3, tone: "orange" },
      { id: "speedstore", label: "Speed Store", sub: "Bigtable, per-segment EWMA", col: 5, row: 3, tone: "orange" },
      { id: "routing", label: "Routing Service", sub: "stateless, bidirectional A*", col: 3, row: 4, tone: "purple" },
      {
        id: "chgraph",
        label: "CH Graph Shards",
        sub: "in-memory, per region",
        mono: "~200M edges · shortcuts precomputed",
        col: 4,
        row: 4,
        tone: "purple",
      },
      { id: "roadstore", label: "Road Graph Store", sub: "source of truth, versioned", col: 5, row: 4, tone: "blue" },
    ],
    edges: [
      { from: "client", to: "cdn", label: "tile request", kind: "read" },
      { from: "cdn", to: "gateway", label: "miss, ~10%", kind: "read" },
      { from: "client", to: "gateway", label: "search/route request", kind: "read" },
      { from: "gateway", to: "search", kind: "read" },
      { from: "search", to: "geoindex", label: "nearby POI, ranked", kind: "read" },
      { from: "gateway", to: "routing", label: "route request", kind: "read" },
      { from: "routing", to: "chgraph", label: "bidirectional query over shortcuts", kind: "read" },
      { from: "chgraph", to: "roadstore", label: "cold shard load", kind: "read" },
      { from: "client", to: "kafka", label: "GPS ping ~every 4s", kind: "write" },
      { from: "kafka", to: "mapmatch", kind: "analytics" },
      { from: "mapmatch", to: "speedstore", label: "snapped speed sample", kind: "analytics" },
      { from: "speedstore", to: "chgraph", label: "edge weight refresh, ~30-60s", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · tiles, search, routing · 100K/sec" },
      { kind: "write", text: "write path · GPS ping ingestion · 5M/sec" },
      { kind: "analytics", text: "traffic pipeline · async, feeds back into route weights, never gates a route" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Render interactive map tiles across zoom levels 0-20 for any location worldwide", tag: "P0" },
      { id: "FR-02", text: "Forward geocoding: search free-text (address, place, business) and return ranked results", tag: "P0" },
      { id: "FR-03", text: "Reverse geocoding: resolve a lat/lng to the nearest address or place", tag: "P0" },
      { id: "FR-04", text: "Compute turn-by-turn directions with an ETA between two points", tag: "P0" },
      { id: "FR-05", text: "Traffic-aware routing that reflects current road speeds, not just static distance", tag: "P0" },
      { id: "FR-06", text: "Support multiple travel modes: driving, walking, cycling, transit", tag: "P0" },
      { id: "FR-07", text: "Live re-routing during an active navigation session on deviation or a traffic change", tag: "P1" },
      { id: "FR-08", text: "Return 2-3 alternate routes with comparable ETAs", tag: "P1" },
      { id: "FR-09", text: "Show place details for POIs: hours, ratings, photos", tag: "P1" },
      { id: "FR-10", text: "Live 'blue dot' location tracking from device GPS", tag: "P1" },
      { id: "FR-11", text: "Offline map and routing download for a selected region", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Tile fetch latency, cache hit, server-side", tag: "p99 < 50ms" },
      { id: "NFR-02", text: "Route computation latency, single query", tag: "p99 < 100ms" },
      { id: "NFR-03", text: "Geocode / search latency", tag: "p99 < 150ms" },
      { id: "NFR-04", text: "GPS location-ping ingestion throughput, sustained", tag: "5M/sec" },
      { id: "NFR-05", text: "Search + route query throughput, sustained", tag: "100K/sec" },
      { id: "NFR-06", text: "Traffic freshness: GPS ping to route-weight impact", tag: "< 60s" },
      { id: "NFR-07", text: "Availability (about 52 min downtime per year)", tag: "99.99%" },
      { id: "NFR-08", text: "Safety-critical closure propagation to live routing", tag: "< 15 min" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing the world: road graph and tile pyramid",
      body: [
        "Before picking an algorithm, prove how big 'the world' actually is. The drivable road network is roughly 200M directed edges (road segments, both directions counted) over about 150M intersections. Bare topology — endpoints, length, speed class, one-way flag — is around 100 bytes per edge, so ~20GB total: small enough that a compressed graph per continent fits comfortably in a handful of machines' RAM. The full version with lane geometry, signage, and speed-limit history is orders of magnitude bigger, 100s of GB, and lives on disk instead.",
        "Tiles follow a quadtree: at zoom z there are 4^z tiles. Pre-rendering every zoom level globally is absurd — 4^20 is roughly a trillion tiles, most of them ocean or desert nobody ever requests. The fix is to pre-render only up through a threshold zoom (roughly z14-15, about 350M tiles cumulative) and render deeper zooms on demand, caching what actually gets requested.",
      ],
      bullets: [
        { lead: "Topology vs. geometry", text: "raw graph topology is ~20GB and fits in RAM; full road geometry plus metadata is 100s of GB and stays on disk." },
        { lead: "Zoom levels 0-20", text: "tile count grows 4x per zoom level; a naive full pre-render at z20 is on the order of 10^12 tiles." },
        { lead: "Pre-render vs. on-demand", text: "pre-render through ~z14-15 (~350M tiles cumulative), render and cache the rest lazily as requests come in." },
      ],
      pictureTitle: "How big is the world, really?",
      pictureRows: [
        { label: "Road graph (topology only)", value: "~200M edges, ~150M nodes, ~20GB", tone: "good" },
        { label: "Road graph (full geometry + metadata)", value: "100s of GB, disk-resident", tone: "neutral" },
        { label: "Tiles pre-rendered to z14-15", value: "~350M tiles cumulative", tone: "good" },
        { label: "Naive full pre-render to z20", value: "~10^12 tiles — never done", tone: "bad" },
      ],
      remember: {
        problem: "How much data are we actually storing, before choosing algorithms?",
        solution: "~200M road edges (~20GB topology, 100s of GB with geometry) and ~350M pre-rendered tiles through z14-15; deeper zooms render on demand.",
        why: "Topology is small enough to fit in RAM per region; tile count explodes 4x per zoom level, so full pre-rendering to max zoom is wasteful.",
        tradeoff: "On-demand tiles beyond z15 add render latency for the rare deep-zoom request instead of paying storage for tiles nobody requests.",
        failure: "Pre-rendering every zoom level globally would need ~10^12 tiles, most of them ocean or desert nobody ever loads.",
        mitigation: "Pre-render only through the zoom threshold where request density justifies it; cache the rest with normal TTLs.",
      },
    },
    {
      n: 2,
      title: "Tiles: the quadtree pyramid and vector vs. raster",
      body: [
        "A viewport maps to a small, deterministic set of tile keys: each tile is addressed by (z, x, y), and zooming in splits one tile into 4 children. No search is needed to know which tiles a viewport needs, just arithmetic on the bounding box.",
        "Early map tiles were pre-rendered raster images (one fixed style, one fixed pixel density, per zoom level). Modern tiles ship geometry and labels instead and let the client render, style, and rotate them on the GPU — one vector tile serves every style and every screen density, at roughly a tenth of the storage of the equivalent raster set. Point data (POIs, addresses) doesn't fit the rectangular pyramid well, so it's indexed separately with S2 cells, a hierarchical decomposition of the sphere into roughly-square cells that avoids the pole-distortion and dateline-wraparound bugs a naive lat/lng grid has.",
      ],
      bullets: [
        { lead: "Quadtree pyramid", text: "each tile at zoom z splits into 4 children at z+1; a tile is addressed by (z, x, y), so a viewport maps directly to a deterministic tile-key set." },
        { lead: "Raster vs. vector", text: "vector tiles ship geometry and labels, not pixels, so one tile serves every style/DPI/rotation at ~1/10th the storage of raster." },
        { lead: "CDN + edge cache", text: "tiles are versioned by a data release rather than mutated in place, so a CDN edge absorbs ~90% of requests, the same trick as caching an immutable row." },
        { lead: "S2 cells for point data", text: "POIs and geo indices use S2 (hierarchical spherical cells), not a lat/lng bounding box, avoiding pole distortion and the ±180° dateline bug." },
      ],
      pictureTitle: "Tile addressing and storage",
      pictureRows: [
        { label: "Raster tile (PNG, one style)", value: "~15-20KB, fixed style/DPI", tone: "bad" },
        { label: "Vector tile (geometry + labels)", value: "~1-2KB, any style/DPI/rotation", tone: "good" },
        { label: "CDN edge hit", value: "~90% of tile requests never reach origin", tone: "good" },
        { label: "S2 cells vs. lat/lng grid", value: "no pole distortion, no dateline bug", tone: "good" },
      ],
      remember: {
        problem: "Address and serve a map viewport's tiles fast, at every zoom and style.",
        solution: "z/x/y quadtree addressing, vector tiles instead of raster, S2 cells for point data, a CDN in front of everything.",
        why: "Quadtree gives O(1) tile lookup from a viewport; vector tiles decouple storage from style/DPI; S2 avoids lat/lng distortion near poles and the dateline.",
        tradeoff: "Vector tiles push rendering cost to the client GPU instead of paying it once at pre-render time.",
        failure: "A naive lat/lng bounding-box index puts absurd cell density near the poles and breaks at the ±180° meridian.",
        mitigation: "Use S2 (or a geohash variant) for point/POI indexing, and quadtree z/x/y purely for the tile pyramid.",
      },
    },
    {
      n: 3,
      title: "Geocoding and search: ranking a fuzzy address to a point",
      body: [
        "Forward geocoding is a search-and-rank problem, not a lookup: '123 Main' has to match '123 Main St' and '123 Main Street Apt 4'. That needs fuzzy token matching (trigram or edit-distance) layered with a geospatial filter (bias toward the user's current viewport), then a ranking pass that mixes text-match quality, place importance/popularity, and proximity.",
        "Reverse geocoding is the easier direction: given a lat/lng, it's a nearest-neighbor query against the S2/R-tree spatial index for the containing or nearest road segment or building, then a walk up the address hierarchy (segment → street → city). Autocomplete is a third, separate path with its own tighter latency budget, served from an in-memory prefix index seeded with popular queries rather than the full ranking pipeline.",
      ],
      bullets: [
        { lead: "Forward geocode = search, not lookup", text: "needs fuzzy token matching layered with a geospatial filter, then ranked by text score × importance × proximity to the viewport." },
        { lead: "Reverse geocode = nearest-neighbor", text: "given a point, query the S2/R-tree index for the containing or nearest segment, then walk the address hierarchy." },
        { lead: "Autocomplete is a different SLA", text: "prefix-matching-as-you-type needs a sub-50ms in-memory prefix index, kept separate from the full-ranking search path." },
      ],
      pictureTitle: "Forward vs. reverse geocoding",
      pictureRows: [
        { label: "Forward: text → point(s)", value: "token match × importance × proximity", tone: "neutral" },
        { label: "Reverse: point → address", value: "nearest-neighbor on S2/R-tree index", tone: "good" },
        { label: "Autocomplete", value: "separate prefix index, sub-50ms budget", tone: "good" },
      ],
      remember: {
        problem: "Turn free-text like '123 Main St' or a lat/lng into the right place, fast.",
        solution: "Forward geocode = fuzzy token search over an inverted index, filtered and ranked by geospatial proximity; reverse geocode = nearest-neighbor on the S2/R-tree spatial index.",
        why: "Addresses are noisy and abbreviated, so exact match fails; nearest-neighbor on a hierarchical spatial index answers 'what's here' in O(log n).",
        tradeoff: "Ranking quality (importance, personalization) costs an extra scoring pass over raw exact-match latency.",
        failure: "Exact-string matching returns nothing for '123 Main' when the record says '123 Main Street'; a flat lat/lng scan for reverse geocoding is O(n).",
        mitigation: "Trigram/token index for fuzzy forward search, S2 cell index for O(log n) reverse geocoding, and a dedicated prefix index for autocomplete's tighter budget.",
      },
    },
    {
      n: 4,
      title: "Routing: kill Dijkstra, keep Contraction Hierarchies",
      body: [
        "A plain Dijkstra, or even A* with a straight-line heuristic, run online against the raw 200M-edge world graph has to relax millions of edges for a long cross-region query — hundreds of milliseconds to seconds, nowhere near a 100ms budget at 100K queries/sec. Production routers fix this by moving the expensive work offline: Contraction Hierarchies (CH) precompute a node importance ordering (highways rank above driveways) and add shortcut edges that represent the fastest path through each removed node.",
        "At query time, a bidirectional search from both endpoints only relaxes edges that go 'upward' in that importance ordering and meets in the middle, touching a few thousand nodes instead of millions — roughly a 1,000x cut in query time versus plain Dijkstra. The world graph is sharded by region so each shard's CH fits in one machine's RAM, stitched across shard boundaries by a coarser overlay graph for cross-region routes.",
      ],
      bullets: [
        { lead: "Plain Dijkstra", text: "correct but relaxes edges across the whole reachable graph; a cross-continent query touches millions of nodes. Rejected as the online path." },
        { lead: "A* with a geographic heuristic", text: "prunes some search using straight-line distance as a lower bound, faster than Dijkstra but still too much of the graph for sub-100ms at 100K/sec alone." },
        { lead: "Contraction Hierarchies", text: "precompute a node ordering and shortcut edges offline; answer online with a bidirectional up-search touching ~thousands of nodes. Winner." },
        { lead: "Regional sharding", text: "the CH graph is partitioned by continent/country so a shard fits in one machine's RAM, with an overlay graph stitching border nodes for cross-region routes." },
      ],
      pictureTitle: "Why CH beats plain Dijkstra online",
      pictureRows: [
        { label: "Plain Dijkstra, cross-continent", value: "millions of nodes touched, 100s of ms-s", tone: "bad" },
        { label: "A* with geographic heuristic", value: "fewer nodes, still too slow alone", tone: "neutral" },
        { label: "Contraction Hierarchies", value: "~thousands of nodes touched, low ms", tone: "good" },
        { label: "Regional sharding + overlay", value: "each shard fits in one machine's RAM", tone: "good" },
      ],
      remember: {
        problem: "Compute a shortest/fastest route over a 200M-edge world graph in well under 100ms.",
        solution: "Precompute Contraction Hierarchies offline (node importance ordering + shortcut edges); answer online queries with a bidirectional up-search touching only thousands of nodes.",
        why: "Preprocessing moves the expensive work offline once; the online query only explores the 'important roads' layer of the hierarchy.",
        tradeoff: "Preprocessing takes hours and roughly doubles graph size with shortcut edges, and the hierarchy must be rebuilt when topology changes.",
        failure: "Plain Dijkstra or A* alone can't hit a 100ms budget at continent scale under real query volume.",
        mitigation: "Rebuild CH incrementally per region, not globally, and keep dynamic traffic weights in a separate overlay so they never force a full hierarchy rebuild.",
      },
    },
    {
      n: 5,
      title: "Real-time traffic: map-matching noisy GPS onto road segments",
      body: [
        "Every navigating phone streams noisy GPS fixes — 5 to 50 meters of error depending on environment, worse in urban canyons and tunnels. Before that data is useful for traffic, each point has to be snapped onto the correct road segment, which is harder than 'find the nearest edge': GPS noise routinely puts a point closer to a parallel street or a frontage road than the road the car is actually on.",
        "The standard fix, used broadly since Microsoft's original map-matching paper, is a Hidden Markov Model over nearby candidate road segments: the emission probability scores how close a candidate is to the raw GPS fix, and the transition probability scores how plausible the drive between consecutive candidates is (does the implied route length and elapsed time line up). Running Viterbi over the whole trajectory — not one point at a time — picks the most likely sequence of road segments, streamed through Flink so matched samples are available within seconds.",
      ],
      bullets: [
        { lead: "Why not nearest-edge", text: "raw GPS error routinely exceeds the gap between two parallel streets or an overpass and the road beneath it, so naive snapping mis-assigns speed samples." },
        { lead: "HMM map-matching", text: "candidate segments near each fix are HMM states; emission = GPS-to-segment distance, transition = route plausibility; Viterbi decodes the most likely sequence." },
        { lead: "Cost of being wrong", text: "a mis-snapped point pollutes the speed estimate for the wrong road, which can route traffic onto or off a road for the wrong reason." },
        { lead: "Streaming, not batch", text: "map-matching runs as a Flink job over the Kafka ping stream, so speed samples land within seconds, not hours." },
      ],
      pictureTitle: "Snapping a noisy GPS trace to the right road",
      pictureRows: [
        { label: "Nearest-edge snap", value: "fooled by parallel streets/overpasses", tone: "bad" },
        { label: "HMM + Viterbi over the trace", value: "uses the whole trajectory, not one point", tone: "good" },
        { label: "Snap latency", value: "streaming (Flink), seconds not hours", tone: "good" },
      ],
      remember: {
        problem: "Turn a noisy raw GPS point into 'this car is on this road segment'.",
        solution: "Hidden Markov Model over nearby candidate segments — emission = GPS distance, transition = route plausibility — decoded with Viterbi over the trajectory.",
        why: "A single noisy point is ambiguous between parallel roads; scoring the sequence jointly resolves ambiguity no single point can.",
        tradeoff: "HMM map-matching is heavier than nearest-edge snapping and needs a trailing window of points, adding a little latency before a sample is trusted.",
        failure: "Nearest-edge snapping regularly assigns highway speed to the frontage road right next to it, or vice versa, poisoning both estimates.",
        mitigation: "Run the HMM matcher as a streaming job with a small trailing window, and only publish a speed sample once the match is stable.",
      },
    },
    {
      n: 6,
      title: "Feeding traffic back into routing without flapping",
      body: [
        "Map-matched speed samples land in a per-segment store, but pushing every fresh reading straight into the routing graph would make ETAs and even chosen routes jitter every few seconds as noise moves the 'fastest' edge back and forth — route flapping. The fix decouples raw samples from the weight the router reads: aggregate per-segment speeds over a rolling window with exponential smoothing, publish updated weights on a fixed cadence rather than per-sample, and keep the smoothed 'traffic overlay' as a separate layer on top of the static CH graph instead of mutating the precomputed hierarchy.",
      ],
      bullets: [
        { lead: "Raw samples are noisy", text: "a single vehicle's speed says little about a segment; aggregate many samples in a rolling window before trusting the number." },
        { lead: "EWMA over the window", text: "exponential smoothing weights recent samples more, but doesn't let one outlier swing the estimate, damping flapping." },
        { lead: "Overlay, not graph rebuild", text: "traffic weights live in a fast-updating layer the router reads at query time; the underlying CH shortcuts are untouched." },
        { lead: "Publish cadence, not per-sample", text: "edge weights refresh on a ~30-60s cadence, live-feeling without recomputing routes on every GPS ping received." },
      ],
      pictureTitle: "Raw pings to a stable route weight",
      pictureRows: [
        { label: "Per-sample weight update", value: "route flaps every few seconds", tone: "bad" },
        { label: "Rolling window + EWMA", value: "smooths noise, damps flapping", tone: "good" },
        { label: "Traffic as an overlay on CH", value: "no hierarchy rebuild needed", tone: "good" },
        { label: "Publish cadence ~30-60s", value: "feels live without per-ping churn", tone: "good" },
      ],
      remember: {
        problem: "Use live traffic without making ETAs and routes jitter every few seconds.",
        solution: "Aggregate speed samples in a rolling window with EWMA smoothing, publish weight updates on a fixed cadence, and keep traffic as an overlay on the static CH graph.",
        why: "Raw per-vehicle samples are too noisy to drive routing decisions directly; smoothing and a publish cadence trade a little freshness for stability.",
        tradeoff: "Smoothing means the router can lag a genuinely sudden change, like an accident, by up to one aggregation window.",
        failure: "Feeding every raw sample straight into route weights flip-flops the 'best' route and confuses drivers with constant reroute suggestions.",
        mitigation: "Layer traffic as an overlay the router reads at query time, and pair the smoothed feed with a fast-path incident channel for sudden closures.",
      },
    },
    {
      n: 7,
      title: "Live navigation: why the client doesn't call the server every second",
      body: [
        "During an active turn-by-turn session the phone already has the full route geometry cached locally, so it doesn't need a server round-trip to know 'keep going straight for 400m'. The client uses its own GPS plus dead reckoning against the cached route polyline to advance the 'you are here' position and issue turn instructions locally, at whatever refresh rate its sensors support. The server only needs to hear from the client periodically — a location ping every few seconds, both to update the blue dot and to feed the traffic pipeline — and only needs to recompute a route when the client detects it has actually left the planned path or a fresh traffic overlay changes the ETA enough to matter.",
      ],
      bullets: [
        { lead: "Route is cached client-side", text: "once a route is returned, turn-by-turn guidance is a local geometry match against GPS, no server call needed per turn." },
        { lead: "Ping cadence, not per-frame", text: "location pings go up roughly every 4s, frequent enough for live traffic and the blue dot, far cheaper than round-tripping every UI frame." },
        { lead: "Reroute triggers are events, not a poll", text: "deviation from the route or a significant ETA delta from a traffic update triggers a fresh route call; otherwise the client guides off the cached polyline." },
        { lead: "Battery and bandwidth are real constraints", text: "at ~5M pings/sec across ~20M concurrent sessions, ping cadence is a capacity decision as much as a UX one." },
      ],
      pictureTitle: "What actually needs a server round-trip?",
      pictureRows: [
        { label: "Next-turn instruction", value: "local: cached polyline + GPS", tone: "good" },
        { label: "Blue-dot update / traffic sample", value: "periodic ping, ~every 4s", tone: "neutral" },
        { label: "Full reroute", value: "event-triggered: deviation or ETA delta", tone: "neutral" },
        { label: "Per-turn server round-trip", value: "never — would not scale or survive dead zones", tone: "bad" },
      ],
      remember: {
        problem: "Keep a live nav session responsive without hammering the server or draining the battery.",
        solution: "Client caches the route and does local turn guidance via dead reckoning against GPS; the server only gets periodic pings and event-triggered reroute requests.",
        why: "Turn instructions are a local geometry match, not a query; only deviation or a real ETA change needs a server round-trip.",
        tradeoff: "The client can drift briefly out of sync with server-side traffic state between pings, corrected on the next reroute check.",
        failure: "Calling the server for every turn instruction wouldn't survive a tunnel or dead zone, and couldn't scale to tens of millions of concurrent sessions.",
        mitigation: "Cache the route client-side, ping on a fixed cadence, and reroute only on deviation or a material ETA delta.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's three systems glued together: a tile/search read path for 'what's here', a routing engine for 'how do I get there', and an async traffic pipeline that keeps 'how do I get there' honest in real time.",
      "Routing scales by precomputing a Contraction Hierarchy offline, so the online query only touches thousands of nodes, not the 200M-edge world graph.",
      "Traffic comes from GPS pings on every navigating phone, snapped to the right road with an HMM map-matcher, aggregated with smoothing, and layered on top of the static graph as an overlay.",
      "Live navigation is mostly client-local: the phone guides itself off a cached route and only calls the server on a fixed ping cadence or when it actually needs to reroute.",
      "Tiles and search are both spatial-indexing problems: quadtree z/x/y for the tile pyramid, S2 cells for POIs and geocoding, never a flat lat/lng scan.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · SEARCH + ROUTE + TILES · 100K/S",
        summary:
          "A viewport pans, a search box fills in, or a route is requested. Tiles come from a CDN-backed pyramid, search hits a geospatial and text index, and routing runs a bidirectional query over a precomputed Contraction Hierarchy.",
        steps: [
          { label: "Client", note: "pans map / types a search / requests a route" },
          { label: "Tile CDN", note: "~90% hit, z/x/y vector tile" },
          { label: "API Gateway", note: "routes to the right service" },
          { label: "Search Service", note: "geocode / POI lookup" },
          { label: "Geo Index", note: "S2 cell + text match, ranked" },
          { label: "Routing Service", note: "bidirectional query over CH shortcuts" },
          { label: "CH Graph Shards", note: "in-memory, region-sharded, ~thousands of nodes touched" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · GPS LOCATION PINGS · 5M/S",
        summary:
          "Every actively navigating phone streams a location ping every few seconds. It never blocks the UI — the ping just needs to land in the ingestion stream.",
        steps: [
          { label: "Client", note: "GPS fix, ~every 4s during nav" },
          { label: "API Gateway", note: "lightweight ingestion endpoint" },
          { label: "Kafka", note: "buffered ping stream, durable" },
        ],
      },
      {
        kind: "analytics",
        title: "ANALYTICS · TRAFFIC PIPELINE · ASYNC, NEVER BLOCKS A ROUTE QUERY",
        summary:
          "Raw pings get snapped to the correct road, aggregated with smoothing, and published as an overlay the routing graph reads — never a synchronous part of any route request.",
        steps: [
          { label: "Kafka", note: "ping stream" },
          { label: "Map Matcher", note: "Flink job, HMM + Viterbi snap-to-road" },
          { label: "Speed Store", note: "Bigtable, per-segment EWMA" },
          { label: "CH Graph Shards", note: "overlay refresh ~30-60s, no hierarchy rebuild" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "~200M directed road edges, ~150M intersections worldwide (~20GB topology, 100s of GB with geometry)",
          "~350M pre-rendered tiles through z14-15; deeper zooms render on demand",
          "~20M concurrent navigation sessions at peak, ping every ~4s → ~5M pings/sec",
          "100K/sec search+route query throughput; sub-100ms route, sub-150ms search p99",
          "Tile CDN hit rate ~90%; a CH query touches ~thousands of nodes, not millions",
          "Traffic overlay refresh cadence ~30-60s; safety-critical closure fast path < 15 min",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Contraction Hierarchies precomputed offline, not plain Dijkstra/A* online",
          "Vector tiles over raster; quadtree z/x/y for the tile pyramid, S2 cells for point data",
          "HMM + Viterbi map-matching, not nearest-edge GPS snapping",
          "Traffic as a smoothed overlay layer, not a live mutation of the CH graph",
          "Client does local turn guidance off a cached route; server only pinged periodically",
          "Regional CH sharding with a border overlay graph, not one global in-memory graph",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Route flapping is the load-bearing risk if traffic weights update per-sample instead of on a smoothed cadence",
          "CH preprocessing is offline and periodic; a road closure needs a fast incremental path, not a full rebuild",
          "Reads (tiles/search/route) are tier-1; the traffic pipeline is tier-3 and async — it improves routing but never gates a response",
          "Naive lat/lng grids distort near the poles and break at the dateline — S2 cells are the fix, not a detail",
          "GPS map-matching is a sequence problem (HMM + Viterbi), not a per-point nearest-edge lookup",
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
      goal: "Get the five load-bearing numbers on the board before drawing anything: query volume, ping volume, graph size, latency budget, and scope.",
      why: "Every later decision — CH preprocessing, cache sizing, ping cadence — falls out of these numbers. Locking them first is what separates a driven design from a guessed one.",
      steps: [
        { kind: "ASK", text: '**Global scale, or one metro?** Land on "1B+ MAU, global road network, ~200M edges." Write **"global, 200M edges"** in the top-left corner.' },
        { kind: "ASK", text: 'Next: **"how many people are actively navigating at once?"** Land on "~20M concurrent sessions at peak, ping every ~4s". Write **"~20M sessions → ~5M pings/sec"**.' },
        { kind: "SAY", text: 'Propose the latency targets yourself: **"sub-100ms route computation"**, **"sub-150ms search"**, **"sub-50ms tile fetch on cache hit"**. Wait for a nod, then write them down.' },
        { kind: "SAY", text: 'State scope. In: "tiles, geocoding, routing, live traffic, live navigation". Out: "transit schedules, Street View, offline maps, business listings management". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the graph math out loud: **"~200M directed edges, ~150M intersections, ~20GB topology"**, **"100s of GB with full geometry"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are the graph size, ping rate, and latency budget on the board before any boxes get drawn, with scope explicitly parked?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Three or four endpoints, one road-graph schema, tile addressing scheme justified before it's questioned.",
      why: "The interviewer wants to see you commit to a small, well-typed surface and defend the tile/graph representation, not drift into a generic CRUD API.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"GET /tiles/{z}/{x}/{y}"**, **"GET /search?q=..."**, **"GET /geocode?lat=&lng="**, **"POST /route { origin, destination, mode }"** returns **"{ polyline, eta, alternates[] }"**, **"POST /ping { sessionId, lat, lng, ts }"** fire-and-forget.' },
        { kind: "DRAW", text: 'Sketch the road edge row: **"edge_id, from_node, to_node, length_m, speed_class, one_way, geometry_ref"**. Say it out loud: "Topology is separate from geometry so the in-memory CH graph stays small."' },
        { kind: "SAY", text: 'Justify tile addressing: **"z/x/y quadtree key, deterministic from a viewport bounding box"**, "no search needed to know which tiles to fetch."' },
        { kind: "RULE OUT", text: 'Get ahead of alternatives: "A flat lat/lng column with a linear scan doesn\'t work for \'what\'s near me\' at this scale — needs an S2 or R-tree index." Cross it off.' },
      ],
      grading: "Crisp endpoint list, a topology-vs-geometry split in the data model, and the tile addressing scheme defended before being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: read (tiles/search/route), write (GPS ping ingestion), analytics (the traffic feedback loop). Label arrows with throughput and latency, not box names.",
      why: "Drawing three lanes proves you understand tiles/search/routing, ping ingestion, and traffic aggregation have completely different SLAs and failure domains — the single biggest structural insight in this design.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read lane**: Client → Tile CDN / API Gateway → Search Service → Geo Index, and → Routing Service → CH Graph Shards. Label arrows **"~90% CDN hit"**, **"100K/sec"**, **"sub-100ms"**.' },
        { kind: "DRAW", text: 'Add the **write lane** as a separate path: Client → API Gateway → Kafka, labeled **"5M pings/sec, fire-and-forget"**.' },
        { kind: "DRAW", text: 'Add the **analytics lane** dropping off Kafka: → Map Matcher (Flink) → Speed Store → back into CH Graph Shards, dashed, labeled **"async, ~30-60s refresh, never blocks a route"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different SLAs — routing is latency-critical tier-1, ping ingestion is high-volume but low-latency-sensitive, and the traffic feedback loop is best-effort tier-3."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with throughput and latency, and an explicit statement that the traffic pipeline never sits on the route-request path.",
    },
    {
      n: 4,
      title: "Deep Dive: Routing at Scale (Contraction Hierarchies)",
      minutes: 8,
      goal: "Show why plain Dijkstra/A* fails at this scale, then defend Contraction Hierarchies with the offline/online split and regional sharding.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can name a real preprocessing technique and explain why it, not a smarter online algorithm, is what makes sub-100ms possible.",
      steps: [
        { kind: "SAY", text: 'State the failure mode: "Plain Dijkstra on a 200M-edge graph relaxes millions of nodes for a long route — hundreds of ms to seconds, not sub-100ms at 100K/sec."' },
        { kind: "DRAW", text: 'Draw the CH idea: "offline, order nodes by importance, add shortcut edges representing the fastest path through each contracted node." Then: "online, bidirectional search only goes \'upward\' in that ordering and meets in the middle — thousands of nodes touched, not millions."' },
        { kind: "SAY", text: 'Explain regional sharding: "the graph is partitioned by continent/country so each shard\'s CH fits in one machine\'s RAM, with a coarser overlay graph stitching border nodes for cross-region routes."' },
        { kind: "RULE OUT", text: 'One line each: **Plain Dijkstra** → millions of nodes touched, too slow online. **A\\* alone** → faster but still not enough at 100K/sec. **One global in-memory graph** → doesn\'t fit one machine at world scale.' },
      ],
      grading: "The offline/online split stated clearly, CH explained as node-ordering-plus-shortcuts without prompting, and regional sharding volunteered, not just answered when asked \"does this fit on one box?\"",
    },
    {
      n: 5,
      title: "Deep Dive: Real-Time Traffic (Map-Matching + Feedback Loop)",
      minutes: 7,
      goal: "Walk GPS ingestion through map-matching to a smoothed traffic overlay, and volunteer route flapping as the load-bearing risk.",
      why: "Anyone can say 'ingest GPS and update speeds'. The interviewer wants the map-matching problem named correctly and — for the top score — route flapping raised before being asked.",
      steps: [
        { kind: "SAY", text: 'State the raw problem: "GPS error is 5-50 meters, enough to confuse a car for the parallel street next door, so nearest-edge snapping is unreliable."' },
        { kind: "SAY", text: 'Name the fix: "a Hidden Markov Model over nearby candidate segments — emission probability from GPS distance, transition probability from route plausibility — decoded with Viterbi over the whole trajectory."' },
        { kind: "SAY", text: 'Volunteer the flapping risk: "if I push every raw sample straight into route weights, the \'best\' route flip-flops every few seconds. I aggregate in a rolling window with EWMA smoothing and publish on a ~30-60s cadence instead."' },
        { kind: "SAY", text: 'Close with the architecture: "traffic lives as an overlay the router reads at query time, separate from the static CH shortcuts, so a traffic update never triggers a hierarchy rebuild."' },
      ],
      grading: "HMM map-matching named with its actual mechanics (emission/transition, Viterbi), route flapping raised unprompted, and the overlay-vs-rebuild distinction stated clearly.",
    },
    {
      n: 6,
      title: "Wrap: Bottlenecks, Tiers, and Consistency",
      minutes: 5,
      goal: "Name the SLA tiers, the graph-update consistency story, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: explicit tiering that justifies trade-offs, a real plan for road-graph updates that doesn't corrupt an in-flight route, and a clean close.",
      steps: [
        { kind: "SAY", text: 'State the tiers: "Routing and search are tier-1, ping ingestion is tier-2, the traffic feedback loop is tier-3 — that hierarchy is why traffic aggregation never blocks a route response."' },
        { kind: "SAY", text: 'Bring up graph consistency unprompted: "structural changes rebuild the CH offline per region and swap in blue-green, so no in-flight query ever sees a half-updated graph; safety-critical closures go through a fast incremental overlay instead of waiting for a rebuild."' },
        { kind: "SAY", text: 'Push back where useful: "do we need lane-level routing, or is road-segment granularity enough for v1?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a spatial-index read path plus a precomputed hierarchical router plus an async traffic feedback loop. With more time I\'d cover transit schedules, lane guidance, and offline map downloads."' },
      ],
      grading: "Explicit SLA tiers, the blue-green graph-swap consistency story stated unprompted, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but routing and traffic stay hand-wavy and unquantified.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: tile/map server, search service, routing service, database, cache/CDN.",
          "Knows routing is 'shortest path' and mentions Dijkstra by name.",
          "Adds a cache/CDN in front of tiles without being asked twice.",
          "Handles 'what about traffic' by saying 'poll each client's GPS and update the map'.",
          "Describes geocoding as 'look up the address in a database'.",
        ],
        gaps: [
          "Doesn't realize plain Dijkstra/A* can't hit sub-100ms at continent scale; no mention of any preprocessing.",
          "No spatial indexing — proposes a lat/lng column with a linear scan or a naive bounding box query.",
          "Treats traffic as 'just another field on the road row', no ingestion or aggregation pipeline.",
          "Skips storage math entirely ('lots of data') and no tile cache hit-rate estimate.",
          "Doesn't separate tile serving, search, and routing as services with different SLAs.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, names the real preprocessing technique, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes QPS, storage, and latency targets on the board within the first 5 minutes.",
          "Names Contraction Hierarchies (or at minimum bidirectional A* with a real heuristic) and explains the offline/online split.",
          "Proposes a quadtree/S2 spatial index for tiles and points, not a flat scan.",
          "Designs a Kafka-to-stream-processing pipeline for GPS ingestion and explains why it's async.",
          "Mentions map-matching as a real problem caused by GPS noise, even without the exact HMM mechanics.",
          "Separates read (tile/search/route) from write (ping ingest) from the traffic feedback loop.",
        ],
        gaps: [
          "Doesn't spontaneously bring up route flapping or the need to smooth traffic before it hits route weights.",
          "Mentions regional sharding of the CH graph only when asked 'does this fit on one machine?'",
          "Doesn't volunteer why the client does local turn guidance instead of calling the server per turn.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, surfaces the load-bearing risks before being asked, and brings operational maturity beyond the algorithm itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers route flapping as the load-bearing risk in the traffic feedback loop, with the EWMA-and-overlay mitigation stated unprompted.",
          "Explains why CH preprocessing is offline and periodic, and proposes a fast-path incremental closure channel for safety-critical updates unprompted.",
          "Names the HMM map-matching approach by structure — emission/transition probabilities decoded with Viterbi — not just 'we snap to the nearest road'.",
          "Explains why the client does local turn-by-turn guidance and ties server-call cadence to battery/bandwidth at 5M pings/sec scale.",
          "Pushes back on requirements ('do we need lane-level routing, or is road-segment granularity enough for v1?').",
          "Closes with a one-sentence summary and an explicit list of what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Running Dijkstra online over the full world graph for every route request — no mention of any offline preprocessing.",
      "Storing geo data in a flat lat/lng table with no spatial index, implying a linear scan for 'nearby' queries.",
      "Feeding every raw GPS speed sample directly into route weights with no smoothing — this makes ETAs and routes flap.",
      "Treating traffic ingestion as synchronous — blocking a route response on a live GPS ping write.",
      "No distinction between tile serving, search, and routing as separate services with separate latency budgets.",
      "Assuming a single global in-memory graph without addressing whether the whole world's road network fits on one machine.",
    ],
    followUps: [
      {
        q: "Why can't you just run Dijkstra on-demand for every route request?",
        a: "Dijkstra (or plain A*) relaxes edges across the reachable graph until it settles the destination; for a genuinely long route on a 200M-edge world graph that's millions of node expansions, hundreds of milliseconds to seconds — nowhere near a 100ms budget, especially at 100K queries/sec. Contraction Hierarchies move that cost offline: precompute a node importance ordering and shortcut edges once, then answer online queries with a bidirectional search that only expands the 'important roads' layer, touching thousands of nodes instead of millions.",
      },
      {
        q: "How do you keep the routing graph from getting stale when roads change?",
        a: "Two speeds. Structural changes (new roads, permanent closures) go through a periodic offline rebuild of the Contraction Hierarchy per region, then a blue-green swap so no in-flight query ever sees a half-updated graph. Safety-critical changes (an accident, a sudden closure) can't wait for that rebuild, so they go through a fast incremental overlay that marks specific edges unusable within minutes, independent of the CH structure underneath.",
      },
      {
        q: "What stops live traffic data from making routes flap?",
        a: "Raw per-vehicle speed samples are noisy, so they're aggregated over a rolling window with exponential smoothing before they ever reach the router, and the smoothed result is published on a fixed cadence (roughly every 30-60 seconds) as an overlay the router reads, not a mutation of the graph itself. That trades a little freshness — a real, sudden jam takes up to one window to show up — for a stable 'best route' that doesn't flip every few seconds.",
      },
      {
        q: "How does map-matching actually work, and why not just snap to the nearest road?",
        a: "Nearest-edge snapping is fooled constantly — GPS error routinely exceeds the gap between two parallel streets, or between a highway and the frontage road beside it. The standard fix is a Hidden Markov Model: nearby road segments are candidate states for each GPS fix, the emission probability scores how close the fix is to a candidate, and the transition probability scores how plausible the drive between consecutive candidates is (does the route distance and time line up). Running Viterbi over the whole trajectory picks the most likely sequence of segments, correcting an individual noisy point using the shape of the whole trace.",
      },
      {
        q: "Why doesn't the phone call the server for every turn during navigation?",
        a: "Because it doesn't need to — once a route is returned, the phone has the full polyline cached and can match its own GPS position against that geometry locally to issue the next turn instruction, at whatever rate its sensors support. The server only needs a periodic location ping (to update the live blue dot and feed the traffic pipeline) and a route recompute when the client detects a real deviation or a traffic update changes the ETA meaningfully. At ~20M concurrent sessions, per-turn server round-trips wouldn't scale, wouldn't survive a dead zone, and would burn battery for no reason.",
      },
      {
        q: "Does the whole world's road graph fit on one machine?",
        a: "Not as one flat graph at production scale with headroom — so it's sharded by region (country/continent), each shard small enough to fit comfortably in one machine's RAM with its own Contraction Hierarchy. Routes that cross a shard boundary use a coarser overlay graph connecting the border nodes of adjacent shards, so a query never needs to load more than its own region plus a thin stitching layer.",
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
          "This is three coupled systems, not one: a spatial-index read path (tiles, search, geocoding) for 'what's here', a precomputed hierarchical routing engine for 'how do I get there', and an async traffic feedback loop that keeps the routing engine honest without ever sitting on its critical path.",
          "Anchor everything on five numbers: ~200M road edges, ~20M concurrent navigation sessions producing ~5M GPS pings/sec, 100K search+route queries/sec, and a sub-100ms route / sub-150ms search latency budget. Every structural choice below is a consequence of these numbers.",
        ],
      },
      {
        heading: "Sizing and spatial indexing",
        body: [
          "The road graph's bare topology (~200M directed edges, ~150M nodes) is ~20GB, small enough to live in RAM per region; full geometry and metadata run to 100s of GB and stay on disk. Tiles follow a quadtree pyramid addressed by (z, x, y); pre-rendering every zoom level globally would need on the order of 10^12 tiles, so only zoom levels up through ~z14-15 (~350M tiles) are pre-rendered, with deeper zooms rendered and cached on demand.",
          "Point data — POIs, addresses — is indexed with S2 cells rather than a lat/lng bounding box, avoiding the pole distortion and dateline-wraparound bugs a naive grid has. Forward geocoding is fuzzy token search filtered and ranked by proximity; reverse geocoding is a nearest-neighbor query against the same spatial index.",
        ],
      },
      {
        heading: "Routing without coordination-killing latency",
        body: [
          "A route request against the raw 200M-edge graph with plain Dijkstra or A* would relax millions of nodes for a long query — far past the 100ms budget at 100K queries/sec. Contraction Hierarchies fix this by moving the expensive work offline: precompute a node importance ordering and add shortcut edges representing the fastest path through each contracted node.",
          "Online, a bidirectional search only expands edges 'upward' in that ordering and meets in the middle, touching thousands of nodes instead of millions. The graph is sharded by region so each shard's CH fits in one machine's RAM, with a coarser overlay graph stitching border nodes together for routes that cross shard boundaries.",
        ],
      },
      {
        heading: "Turning noisy GPS into trustworthy traffic",
        body: [
          "GPS fixes carry 5-50 meters of error, enough to confuse a car for a parallel street or a frontage road next to a highway. Nearest-edge snapping is unreliable at that error margin, so map-matching uses a Hidden Markov Model over nearby candidate segments: emission probability scores GPS-to-segment distance, transition probability scores route plausibility between consecutive matches, and Viterbi decodes the most likely sequence over the whole trajectory, streamed through Flink.",
          "Matched speed samples land in a per-segment store, but feeding every raw sample straight into route weights would make the 'best' route flap every few seconds. The fix aggregates samples in a rolling window with exponential smoothing and publishes updated weights on a ~30-60s cadence as an overlay the router reads — never a mutation of the static CH graph itself.",
        ],
      },
      {
        heading: "Live navigation and operational maturity",
        body: [
          "During an active session, the phone already holds the full route polyline, so turn-by-turn guidance is a local geometry match against GPS — no server round-trip per turn. The server hears from the client on a fixed ping cadence (~4s) for the blue dot and the traffic pipeline, and only recomputes a route when the client detects a real deviation or a traffic update changes the ETA meaningfully.",
          "Graph updates run at two speeds: structural changes (new roads, permanent closures) rebuild the CH offline per region on a periodic cadence with a blue-green swap, so no in-flight query ever sees a half-updated graph; safety-critical changes (a sudden closure) go through a fast incremental overlay that marks edges unusable within minutes, independent of the full rebuild. That tiering — routing and search tier-1, ping ingestion tier-2, the traffic feedback loop tier-3 — is what justifies every trade-off in the design.",
        ],
      },
    ],
  },
};
