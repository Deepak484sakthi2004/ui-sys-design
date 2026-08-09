import type { Problem } from "@/lib/types";

export const ticketmaster: Problem = {
  slug: "ticketmaster",
  num: "6.12",
  title: "Design Ticketmaster",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a ticketing platform like Ticketmaster that lists 500K events a year, sells roughly 2 billion tickets annually, and must survive on-sale flash crowds where 1-2 million fans compete for a single 50,000-seat venue in the first 60 seconds — guaranteeing that no seat is ever sold twice, while everyday browsing still serves normal p99 latency across a global catalog of events.",
  ],
  hardParts:
    "The hard parts: guaranteeing exactly-one-buyer-per-seat under extreme write contention on a tiny set of rows, shedding a 20-40x demand spike before it ever reaches the database, and expiring abandoned seat holds precisely enough that seats come back on sale within seconds, not minutes.",
  keyTopics: [
    "Pessimistic Row Locking for Seat Inventory",
    "Virtual Waiting Room (Token-Bucket Admission)",
    "TTL-Based Seat Holds",
    "Idempotent Payment Commit",
    "Hot-Row Contention on Popular Events",
  ],
  foundationsReferenced: [
    { label: "PostgreSQL Row-Level Locking", tone: "blue" },
    { label: "Redis / Valkey", tone: "purple" },
    { label: "Token Bucket Rate Limiting", tone: "green" },
    { label: "Kafka", tone: "orange" },
    { label: "Idempotency Keys", tone: "orange" },
    { label: "Elasticsearch", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "cdn", label: "CDN", sub: "event & venue pages", col: 2, row: 1, tone: "green" },
      { id: "search", label: "Search Service", sub: "Elasticsearch · browse/filter", col: 3, row: 1, tone: "green" },
      { id: "waitingroom", label: "Waiting Room", sub: "token-bucket admission", col: 1, row: 2, tone: "orange" },
      {
        id: "seatsvc",
        label: "Seat Hold Service",
        sub: "stateless",
        mono: "SELECT ... FOR UPDATE SKIP LOCKED",
        col: 2,
        row: 2,
        tone: "purple",
      },
      { id: "redis", label: "Valkey", sub: "hold TTL · 8 min", col: 3, row: 2, tone: "purple" },
      {
        id: "inventory",
        label: "Inventory DB",
        sub: "Postgres · seat_status",
        mono: "source of truth",
        col: 4,
        row: 2,
        tone: "blue",
      },
      { id: "payment", label: "Payment Service", sub: "Stripe · idempotency key", col: 5, row: 2, tone: "purple" },
      { id: "kafka", label: "Kafka", sub: "order & hold events", col: 2, row: 3, tone: "orange" },
      { id: "reaper", label: "Hold Reaper", sub: "expires stale holds", col: 3, row: 3, tone: "orange" },
      { id: "notify", label: "Notification Service", sub: "email/SMS · QR ticket", col: 4, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "cdn", kind: "read" },
      { from: "cdn", to: "search", label: "miss", kind: "read" },
      { from: "search", to: "inventory", label: "live counts", kind: "read" },
      { from: "client", to: "waitingroom", label: "on-sale surge", kind: "write" },
      { from: "waitingroom", to: "seatsvc", label: "admitted · throttled", kind: "write" },
      { from: "seatsvc", to: "inventory", label: "FOR UPDATE SKIP LOCKED", kind: "write" },
      { from: "seatsvc", to: "redis", label: "TTL hold · 8 min", kind: "write" },
      { from: "seatsvc", to: "payment", label: "checkout", kind: "write" },
      { from: "payment", to: "inventory", label: "confirm sale", kind: "write" },
      { from: "seatsvc", to: "kafka", label: "hold created", kind: "analytics" },
      { from: "payment", to: "kafka", label: "order placed", kind: "analytics" },
      { from: "kafka", to: "reaper", label: "TTL sweep", kind: "analytics" },
      { from: "reaper", to: "inventory", label: "release expired", kind: "analytics" },
      { from: "kafka", to: "notify", label: "async", kind: "analytics" },
      { from: "kafka", to: "search", label: "CDC index update", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · browse & search" },
      { kind: "write", text: "write path · seat hold & checkout" },
      { kind: "analytics", text: "async · notifications, indexing, hold reaping — never blocks booking" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Browse and search events by artist, venue, date, and location", tag: "P0" },
      { id: "FR-02", text: "View a real-time seat map with per-seat availability and pricing tiers", tag: "P0" },
      { id: "FR-03", text: "Select seats and place a temporary hold before payment", tag: "P0" },
      { id: "FR-04", text: "Complete checkout/payment before the hold expires, converting it to a confirmed ticket", tag: "P0" },
      { id: "FR-05", text: "Automatically release held seats on timeout or payment failure", tag: "P0" },
      { id: "FR-06", text: "Virtual waiting room / queue for high-demand on-sale events", tag: "P0" },
      { id: "FR-07", text: "Guarantee a seat can never be sold to two different buyers", tag: "P0" },
      { id: "FR-08", text: "Send purchase confirmation via email/SMS with a QR-code ticket", tag: "P1" },
      { id: "FR-09", text: "Support general-admission tickets sold by quantity, with no assigned seat", tag: "P1" },
      { id: "FR-10", text: "Rate-limit and bot-detect purchase attempts per account and per IP", tag: "P1" },
      { id: "FR-11", text: "Refunds and ticket transfer/resale on a secondary marketplace", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Seat hold acquisition latency", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "Checkout/payment confirmation latency", tag: "p99 < 2s" },
      { id: "NFR-03", text: "Overselling / double-booking of a seat", tag: "zero double-sell" },
      { id: "NFR-04", text: "Search/browse latency", tag: "p99 < 150ms" },
      { id: "NFR-05", text: "Peak on-sale burst handled for a single venue", tag: "2M concurrent / 40x" },
      { id: "NFR-06", text: "Platform availability", tag: "99.95%" },
      { id: "NFR-07", text: "Seat-hold expiration precision from TTL to release", tag: "sub-second" },
      { id: "NFR-08", text: "Waiting-room admission throughput, matched to safe DB write rate", tag: "10K/min" },
      { id: "NFR-09", text: "Read:write ratio, steady state vs. on-sale spike", tag: "50:1 → ~1:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: two systems in one product",
      body: [
        "Steady-state, this system is almost boring: 2 billion tickets a year averages out to about 63 purchases per second globally, easily absorbed by a handful of app servers. The number that actually drives the architecture is the burst: a single high-demand on-sale — a stadium tour, a Super Bowl — can put 1-2 million fans in front of a 50,000-seat venue in the same 60-second window. That is a 20-40x oversubscription on one small set of rows, arriving as a step function, not a ramp.",
      ],
      bullets: [
        { lead: "Steady state", text: "~63 purchases/sec platform-wide, spread across hundreds of thousands of events — this part of the system is a normal read-heavy web app." },
        { lead: "Flash sale", text: "1-2M concurrent fans compete for 50K seats. Contention concentrates on ~50K rows in one table, not spread across the catalog, so caching does not help the write path at all." },
        { lead: "Two systems, one product", text: "browsing/search is embarrassingly cacheable; buying a specific seat is a small, hot, strongly-consistent write problem. Conflating them is the single most common design mistake." },
      ],
      pictureTitle: "Steady state vs. on-sale spike",
      pictureRows: [
        { label: "Average day", value: "~63 purchases/sec, cache-friendly", tone: "good" },
        { label: "On-sale spike", value: "1-2M concurrent, 50K seats, 20-40x oversubscribed", tone: "bad" },
        { label: "Contention shape", value: "concentrated on ~50K rows, not spread across catalog", tone: "neutral" },
      ],
      remember: {
        problem: "The system looks read-heavy on average but the interview is actually about a 40x write spike on a tiny set of rows.",
        solution: "Design two paths: a cacheable browse/search path for steady state, and a strongly-consistent, load-shed booking path sized for the spike.",
        why: "2B tickets/year averages to ~63/sec, but a single on-sale can put 1-2M fans against 50K seats in the same minute — averages hide the number that actually matters.",
        tradeoff: "Building for the spike means paying for capacity (waiting room, DB headroom) that sits idle 99% of the time.",
        failure: "Design only for the average and the first popular on-sale takes the whole platform down.",
        mitigation: "Separate the read path (cache-everything) from the write path (throttle-and-lock), and size the write path off peak contention, not average QPS.",
      },
    },
    {
      n: 2,
      title: "Preventing overselling: kill three locking strategies, defend one",
      body: [
        "The core correctness guarantee is that a seat can be held or sold by exactly one buyer, ever. Get this wrong and it is a business-ending headline, not a bug ticket. Put the candidate locking strategies on the board and rule out the ones that don't survive real contention.",
      ],
      bullets: [
        { lead: "Optimistic concurrency (CAS/version column)", text: "works fine for low-contention rows, but for a seat that 200 people are clicking on in the same second, it turns into a retry storm — hundreds of failed compare-and-swap attempts per successful hold, wasting DB CPU exactly when you can least afford it. Rejected for hot seats." },
        { lead: "Redis lock as the sole arbiter", text: "a SETNX lock is fast, but if the app crashes after acquiring the lock and before persisting the hold to the database, the lock's TTL eventually expires and the seat silently comes back on sale — while a payment might already be in flight elsewhere. Rejected as the only mechanism." },
        { lead: "Serialize all writes through a single queue", text: "one actor owning all writes for an event removes contention entirely, but caps a hot event's total throughput at a single node and turns that node into a SPOF. Rejected as the primary path, kept in reserve only for pathological single-seat hot spots." },
        { lead: "Pessimistic row lock, held for milliseconds", text: "SELECT ... FOR UPDATE SKIP LOCKED inside a short transaction flips the seat's status column from available to held and records the holder and expiry. SKIP LOCKED lets 20 buyers clicking 20 different seats in the same venue proceed in parallel instead of queueing behind each other's locks. The lock releases the instant the transaction commits — milliseconds, not the 8-minute hold window. Winner." },
      ],
      pictureTitle: "Locking strategies for one hot seat",
      pictureRows: [
        { label: "Optimistic CAS", value: "retry storm under contention → reject for hot seats", tone: "bad" },
        { label: "Redis-only lock", value: "crash between lock and persist → silent double-sell risk", tone: "bad" },
        { label: "Single-writer queue per event", value: "caps throughput, SPOF → fallback only", tone: "neutral" },
        { label: "Row lock, ms-scoped + SKIP LOCKED", value: "correct, parallel across seats → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Guarantee exactly one buyer per seat under extreme contention on the same row.",
        solution: "Pessimistic row lock (SELECT...FOR UPDATE SKIP LOCKED) held only for the millisecond transaction that flips available→held; SKIP LOCKED lets other seats proceed in parallel.",
        why: "The database is the only component that can make the check-and-set atomic without a coordination protocol; keeping the lock scope to milliseconds avoids serializing the whole checkout behind it.",
        tradeoff: "Losers on a contended seat get an immediate, honest 'seat taken' instead of a slower optimistic retry — worse single-request UX, much better system throughput.",
        failure: "Optimistic CAS retry-storms on hot seats; a Redis-only lock can silently expire mid-payment and double-sell.",
        mitigation: "Row lock for the atomic transition, SKIP LOCKED for parallelism across seats, and never hold the lock for anything longer than the state transition itself.",
      },
    },
    {
      n: 3,
      title: "Seat hold TTL: getting an abandoned seat back fast",
      body: [
        "A held seat that nobody pays for must come back on sale — fast, and without relying on the user's browser. Client-side timers are not trustworthy (tab closes, phone dies), and a slow cron sweep leaves seats looking sold out for minutes at exactly the moment demand is highest.",
      ],
      bullets: [
        { lead: "Client-side countdown", text: "tells the user when they'll lose the seat, but enforces nothing — the server is the only party that can be trusted to actually release it." },
        { lead: "Periodic cron sweep alone", text: "e.g. every 60s, scan for expired holds — simple, but during a hot on-sale a 60s lag means seats sit artificially unavailable for up to a minute after abandonment, exactly when every second of inventory matters." },
        { lead: "Redis TTL + keyspace notification", text: "the hold is written to Redis with an 8-minute TTL; on expiry Redis fires a keyspace event that a listener turns into a release. Near-instant, but pub/sub is best-effort — a missed notification (redeploy, network blip) leaks a held seat forever if it's the only mechanism." },
        { lead: "TTL notification + reaper sweep (belt and suspenders)", text: "keyspace notification handles the common case in under a second; a lightweight reaper job re-scans the DB for holds past their expiry every few seconds as a safety net. Correctness never depends on a single best-effort signal. Winner." },
      ],
      pictureTitle: "How fast does an abandoned seat come back?",
      pictureRows: [
        { label: "Client timer only", value: "unenforceable — not trusted", tone: "bad" },
        { label: "Cron sweep alone (60s)", value: "up to 60s of seats stuck 'held'", tone: "bad" },
        { label: "Redis TTL + keyspace notify", value: "sub-second release, but best-effort", tone: "neutral" },
        { label: "Notify + reaper sweep", value: "sub-second common case, seconds-level safety net", tone: "good" },
      ],
      remember: {
        problem: "Release an abandoned seat hold quickly and reliably, without trusting the client.",
        solution: "Redis TTL drives an immediate keyspace-notification release; a periodic reaper sweep of the DB is the safety net for missed notifications.",
        why: "Pub/sub delivery is best-effort, so a system that depends on it alone can leak held seats indefinitely; a cron-only sweep is correct but too slow for a live on-sale.",
        tradeoff: "Running two release mechanisms is more moving parts than one, in exchange for both low latency and a guaranteed floor.",
        failure: "A missed keyspace notification with no sweep leaves a seat permanently 'held' and unsellable.",
        mitigation: "Reaper job re-scans for expired holds every few seconds, independent of Redis pub/sub delivery.",
      },
    },
    {
      n: 4,
      title: "Virtual waiting room: shedding load before it reaches the lock",
      body: [
        "Even a correct locking scheme falls over if 2 million requests hit the seat-selection endpoint in the same second — connection pools exhaust, the database melts, and even users who had no chance at a seat get a terrible experience. The fix is to control admission before the request ever reaches the booking path, not to make the booking path faster.",
      ],
      bullets: [
        { lead: "Let everyone through, rely on the DB to queue", text: "connection pools and lock waits back up instantly; legitimate low-contention requests (browsing other events) get starved by an unrelated on-sale. Rejected." },
        { lead: "Simple rate limit per IP", text: "throttles individual abusers but does nothing to cap the aggregate arrival rate into the booking service, which is the actual bottleneck. Necessary but not sufficient." },
        { lead: "Virtual waiting room", text: "at go-live, arriving users are assigned a position in a queue — a Redis sorted set keyed by arrival time, or a signed token to blunt refresh-spam. A separate admission controller lets users through to seat selection at a rate matched to what the database can safely sustain, say 10K admissions/minute, regardless of how many millions are waiting. Winner." },
        { lead: "Randomize, don't just FIFO", text: "shuffling admission order instead of strict arrival-time FIFO removes the incentive to hammer refresh a millisecond earlier than everyone else, which is what turns a queue into a self-inflicted DDoS." },
      ],
      pictureTitle: "2M requests, one 50K-seat venue",
      pictureRows: [
        { label: "No admission control", value: "DB connection pool exhausts in seconds", tone: "bad" },
        { label: "Per-IP rate limit only", value: "stops abuse, not aggregate overload", tone: "neutral" },
        { label: "Virtual waiting room", value: "admits at DB's safe rate (~10K/min), rest wait", tone: "good" },
      ],
      remember: {
        problem: "A correct locking scheme still melts under 2M simultaneous requests for 50K seats.",
        solution: "A virtual waiting room throttles admission into the booking path to match the database's safe transaction rate; everyone else waits in a queue.",
        why: "The bottleneck is aggregate arrival rate, not per-user abuse — admission control has to sit upstream of the seat-lock code, not inside it.",
        tradeoff: "Fans who would have gotten a seat under unlimited concurrency now wait in a fair queue instead — worse for the fastest clicker, better for everyone else and for the system.",
        failure: "No admission control means the database melts, and even unrelated browsing traffic degrades during someone else's on-sale.",
        mitigation: "Randomized (not strict-FIFO) admission order removes the incentive to refresh-spam, and the admit rate is tuned to actual DB write capacity.",
      },
    },
    {
      n: 5,
      title: "Browsing vs. booking: different consistency budgets",
      body: [
        "Browsing is the opposite problem from booking: high fan-out, low consistency requirements, and enormous opportunity to cache. An event's description, venue, and date almost never change; showing a seat count that's a few seconds stale on a listings page is a fine trade for speed, since the seat map itself re-checks availability authoritatively the moment a user commits to selecting seats.",
      ],
      bullets: [
        { lead: "CDN for static pages", text: "event and venue detail pages are cached at the edge; most browsing traffic never reaches an origin server at all." },
        { lead: "Elasticsearch for search/filter", text: "full-text, geo, date-range, and price-tier filtering across hundreds of thousands of events — a relational DB is the wrong tool for this access pattern at this fan-out." },
        { lead: "Eventually-consistent index", text: "the catalog DB is the source of truth; changes flow to Elasticsearch via CDC through Kafka (an outbox pattern), a few seconds of lag that's invisible to a user browsing listings." },
        { lead: "Seat map is the one authoritative read", text: "the listings page shows an approximate 'X tickets left' count from cache; only the seat-selection screen queries live inventory, because that's the one read that's about to become a write." },
      ],
      pictureTitle: "Browsing vs. booking: different consistency budgets",
      pictureRows: [
        { label: "Event listing page", value: "CDN-cached, seconds of staleness fine", tone: "good" },
        { label: "Search/filter", value: "Elasticsearch, eventually consistent via CDC", tone: "good" },
        { label: "Seat-selection screen", value: "authoritative read straight from inventory", tone: "neutral" },
      ],
      remember: {
        problem: "Serve high-fan-out browsing traffic without making every read pay the cost of strong consistency.",
        solution: "CDN + Elasticsearch for browsing (eventually consistent, cache-everything); only the seat-selection screen reads live inventory.",
        why: "Staleness on a listings page is invisible to the user; staleness on the seat you're about to lock is a correctness bug.",
        tradeoff: "The 'X left' count on listing pages can be slightly wrong; that's an accepted, deliberate trade for cacheability.",
        failure: "Routing every browse request through the strongly-consistent inventory path brings booking-path latency to browsing traffic and vice versa.",
        mitigation: "CDC/outbox keeps search eventually consistent within a few seconds; authoritative reads are reserved for the one screen where staleness matters.",
      },
    },
    {
      n: 6,
      title: "Idempotent payment: making a retry safe by construction",
      body: [
        "A checkout call can time out on the client side after the server already charged the card — the client's only correct move is to retry, and the server's only correct move is to make that retry a no-op rather than a second charge or a second seat.",
      ],
      bullets: [
        { lead: "Idempotency key per checkout attempt", text: "the client generates one key per attempt and sends it with every retry; the Payment Service persists (key → result) before calling the payment gateway, so a retried request with the same key returns the original result instead of charging again." },
        { lead: "Payment success and seat confirmation, one transaction", text: "flipping the seat from held to sold happens in the same transaction (or a saga with a compensating step) as recording the successful charge — a payment can never succeed while the seat silently reverts to available." },
        { lead: "Compensation on partial failure", text: "if the charge succeeds but the seat-confirm step fails (e.g., the hold expired a second earlier), the saga's compensating action is an automatic refund, not a lost payment or a phantom ticket." },
        { lead: "Never trust a client-reported success", text: "the source of truth for 'was this seat sold' is the DB row plus the recorded payment result, not whatever the client's UI last displayed." },
      ],
      pictureTitle: "Retry after a timeout: what has to be true",
      pictureRows: [
        { label: "No idempotency key", value: "retry after timeout risks double charge", tone: "bad" },
        { label: "Idempotency key, no shared txn", value: "charge succeeds, seat could still revert", tone: "bad" },
        { label: "Idempotency key + one txn/saga", value: "retry-safe, charge and seat move together", tone: "good" },
      ],
      remember: {
        problem: "A checkout retry after a network timeout must never double-charge or leave a paid-for seat unconfirmed.",
        solution: "Idempotency key on every payment call, and a single transaction/saga that ties charge success to seat confirmation.",
        why: "The client cannot know if its first request succeeded after a timeout; the server has to make retries safe by construction.",
        tradeoff: "Extra bookkeeping (idempotency key storage, saga compensation logic) for a case that's rare but catastrophic when mishandled.",
        failure: "A charge that succeeds without an atomic seat-confirm step can strand a paying customer without a ticket.",
        mitigation: "Persist the idempotency key before calling the payment gateway; use a compensating refund if seat-confirm fails after charge success.",
      },
    },
    {
      n: 7,
      title: "Post-purchase pipeline: notifications and indexing off the critical path",
      body: [
        "Once a seat is sold, three more things need to happen — send the confirmation, update the search index's availability count, and let the hold reaper stop tracking it — and none of them should be able to slow down or fail the purchase itself. The Payment Service commits the sale and returns to the user; everything downstream reacts to an event.",
      ],
      bullets: [
        { lead: "Tier the work", text: "confirming the purchase is tier-1 (in the critical path); sending the email/SMS, updating search, and cleaning up hold state are tier-2/3, fired async off Kafka." },
        { lead: "Fire and forget from the booking path", text: "the Payment Service emits an 'order placed' event and returns immediately; if the notification service or Elasticsearch is degraded, the purchase still succeeds — it does not roll back." },
        { lead: "QR-code ticket generation", text: "happens in the Notification Service, off the critical path, and is retried independently of the purchase transaction." },
        { lead: "Search index catch-up", text: "the same CDC/outbox stream that keeps browsing eventually consistent also decrements the visible seat count after a sale." },
      ],
      pictureTitle: "What's allowed to slow down a purchase?",
      pictureRows: [
        { label: "Charge + seat commit", value: "tier-1, synchronous, in the critical path", tone: "neutral" },
        { label: "Email/SMS + QR ticket", value: "tier-2, async off Kafka, retried independently", tone: "good" },
        { label: "Search index update", value: "tier-3, eventually consistent, seconds of lag fine", tone: "good" },
      ],
      remember: {
        problem: "Run notifications and index updates without adding their latency or failure modes to the purchase path.",
        solution: "Payment Service commits the sale synchronously and emits an event; notification and indexing consume it async off Kafka.",
        why: "A purchase that already succeeded must never be blocked or rolled back by a downstream system that has nothing to do with the sale's correctness.",
        tradeoff: "A confirmation email or updated seat count can lag a purchase by seconds; that's an accepted trade for never coupling the two.",
        failure: "Putting notification or indexing on the purchase's critical path means an email-provider outage can fail ticket sales.",
        mitigation: "Async, retried consumers off Kafka; the purchase's correctness never depends on their success.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's an inventory system, not a catalog system: browsing is a cacheable read problem, but buying a specific seat is a small, hot, strongly-consistent write problem, and the two need almost opposite architectures.",
      "Overselling is prevented with a pessimistic row lock held only for milliseconds to flip a seat to 'held', backed by a TTL so an abandoned hold releases the seat automatically.",
      "A virtual waiting room throttles admission into the booking path at exactly the rate the database can safely process transactions, so a 2M-user spike never reaches the seat-lock code at all.",
      "Payment goes through an idempotency key so a client retry after a timeout can never double-charge or double-confirm a seat.",
      "Search, notifications, and the hold reaper all run off Kafka, off the booking path, so a slow search index never slows down a checkout.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · BROWSE & SEARCH · P99 < 150MS",
        summary:
          "A user browsing events almost never touches the source of truth. The CDN and Elasticsearch answer nearly everything; only the seat-selection screen goes further and reads live inventory.",
        steps: [
          { label: "Client", note: "browses events" },
          { label: "CDN", note: "cached event/venue pages" },
          { label: "Search Service", note: "Elasticsearch · filter by date/location/artist" },
          { label: "Inventory DB", note: "live 'X left' count, seat-selection screen only" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · SEAT HOLD & CHECKOUT",
        summary:
          "During an on-sale, the waiting room admits users at a controlled rate. Once admitted, a millisecond-scoped row lock flips the seat to held, a TTL tracks the hold, and payment converts it to sold.",
        steps: [
          { label: "Client", note: "on-sale go-live" },
          { label: "Waiting Room", note: "throttled admission, ~10K/min" },
          { label: "Seat Hold Service", note: "stateless" },
          { label: "Inventory DB", note: "SELECT...FOR UPDATE SKIP LOCKED, ms-scoped" },
          { label: "Valkey", note: "hold TTL 8 min" },
          { label: "Payment Service", note: "idempotency key, charge" },
          { label: "Inventory DB", note: "commit sale, seat sold" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · NOTIFICATIONS, INDEXING, HOLD REAPING",
        summary:
          "Once a sale commits, everything else reacts to a Kafka event. None of it can slow down or fail a purchase, and a periodic reaper sweeps expired holds as a safety net independent of Redis TTL notifications.",
        steps: [
          { label: "Payment Service", note: "emits 'order placed'" },
          { label: "Kafka", note: "order & hold events" },
          { label: "Notification Service", note: "email/SMS + QR ticket" },
          { label: "Search Indexer", note: "CDC → Elasticsearch availability" },
          { label: "Hold Reaper", note: "TTL sweep, safety net for expired holds" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "500K events/year, ~2B tickets/year sold platform-wide",
          "Steady state: ~63 purchases/sec globally; on-sale spike: 1-2M concurrent for one 50K-seat venue",
          "Contention ratio on a hot venue: 20-40x oversubscribed in the first 60 seconds",
          "Hold TTL: 8 minutes; waiting-room admission throttled to ~10K admits/min",
          "Seat-hold DB transaction: lock held for single-digit ms, never the full hold window",
          "Checkout p99 < 2s, seat-hold acquisition p99 < 200ms, search/browse p99 < 150ms",
          "Read:write ratio: ~50:1 steady state, inverts toward ~1:1 write-dominated during a spike",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Pessimistic row lock (SELECT...FOR UPDATE SKIP LOCKED) over optimistic CAS for hot seats",
          "Redis TTL + keyspace notification for hold expiry, backed by a periodic reaper sweep",
          "Virtual waiting room throttles admission upstream of the DB, not a DB-side queue",
          "Idempotency key on every payment/checkout call",
          "Search index is eventually consistent via CDC/Kafka; seat lock state is the only strongly consistent path",
          "Async pipeline (Kafka) for notifications and indexing, never on the booking path",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The row lock is held for milliseconds to flip state, never for the whole hold duration",
          "Waiting-room admission rate is tuned to the DB's actual safe transaction throughput, not an arbitrary number",
          "Steady-state browsing and flash-sale booking are two different systems wearing one UI",
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
      goal: "Get the spike numbers on the board before drawing anything — this design lives or dies on the burst, not the average.",
      why: "The interviewer is checking whether you notice that the average QPS is a red herring. Every later decision (locking strategy, waiting-room rate, TTL) falls out of the peak-contention number, so locking it first is what separates an engineer from someone designing for the wrong load.",
      steps: [
        { kind: "ASK", text: '**"Is this steady browsing traffic or a flash on-sale?"** Walk them to both: "~63 purchases/sec average" and "1-2M concurrent for one 50K-seat on-sale". Write **"63/s avg, 1-2M spike / 50K seats"** in the top-left corner.' },
        { kind: "ASK", text: 'Ask: **"Reserved seating, general admission, or both?"** Land on "both — reserved seats need per-seat locking, GA needs quantity-based decrement." Write **"reserved + GA"**.' },
        { kind: "SAY", text: 'Propose the correctness bar yourself: **"zero double-sell, ever"**, and the latency targets: **"sub-200ms hold, sub-2s checkout"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "seat locking", "waiting room", "hold TTL", "payment", "async notifications". Out: "resale marketplace", "dynamic pricing", "fraud/bot ML". "Let me know if you\'d like me to come back to any of those." Wait for confirmation.' },
        { kind: "WRITE", text: 'Do the contention math out loud: **"2M requests / 50K seats ≈ 40x oversubscribed"**, **"that ratio, not the average QPS, is what sizes the waiting room and the lock design."** Write it on the board.' },
      ],
      grading: "Senior judgment. Are you writing the spike-vs-average distinction on the board, parking out-of-scope items deliberately, and locking the correctness bar (zero double-sell) before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Define the hold/purchase endpoints and the seat_status row, and state up front that a seat's status is the single source of truth.",
      why: "The interviewer wants to see you commit to a small, correct state machine. Naming available → held → sold as the only legal transitions, with one authoritative row per seat, signals you understand this is fundamentally an inventory problem.",
      steps: [
        { kind: "WRITE", text: 'Write the core endpoints: **"POST /events/:id/hold { seatIds[] }"** returns **"{ holdId, expiresAt }"**. **"POST /holds/:id/checkout { paymentToken, idempotencyKey }"** returns **"{ orderId }"**. **"DELETE /holds/:id"** for explicit release.' },
        { kind: "DRAW", text: 'Sketch the row: **"seat_id (PK)"**, **"event_id"**, **"status: available | held | sold"**, **"held_by, held_until"**, **"version"**. Say it out loud: "status is the single source of truth — the lock only ever exists to change this column atomically."' },
        { kind: "SAY", text: 'State the legal transitions: **"available → held (row lock, ms-scoped) → sold (payment commit) or → available (TTL expiry / explicit release)."** No other transitions are legal.' },
        { kind: "RULE OUT", text: 'Get ahead of the obvious mistake: "I\'m not modeling this as a generic CRUD resource — a seat only ever moves forward through that state machine, which is what makes the lock-and-TTL design possible."' },
      ],
      grading: "Crisp endpoint names, a one-row-per-seat data model with an explicit state machine, and the source-of-truth statement volunteered without prompting.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: browse/search, seat-hold/checkout, and async. Label the arrows with what each lane guarantees, not box names.",
      why: "Drawing browse, booking, and async as separate lanes is the whole point. It proves you understand they have different consistency and latency requirements, so they need different infrastructure. Candidates who draw one blob miss that booking must never share a bottleneck with browsing.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read/browse lane**: Client → CDN → Search Service (Elasticsearch) → Inventory DB (only for the seat map). Label it **"cache-everything, eventually consistent"**.' },
        { kind: "DRAW", text: 'Add the **write/booking lane** as a separate row: Client → Waiting Room → Seat Hold Service → Inventory DB (row lock) → Valkey (TTL) → Payment Service → Inventory DB (commit). Label arrows **"~10K admits/min"**, **"ms-scoped lock"**, **"idempotency key"**.' },
        { kind: "DRAW", text: 'Add the **async lane** dropping off Payment/Seat Hold Service: → Kafka → Notification Service, Search Indexer, Hold Reaper, dashed, labeled **"never blocks a purchase"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different guarantees — browsing is cache-everything, booking is zero-double-sell, async is best-effort and off the critical path."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with the guarantee they provide (not just a name), and an explicit statement that async never sits on the booking path.",
    },
    {
      n: 4,
      title: "Deep Dive: Preventing Overselling",
      minutes: 8,
      goal: "Show the row-lock-plus-TTL design and defend why optimistic CAS and Redis-only locking both fail under real contention.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can guarantee exactly-one-buyer-per-seat under extreme contention, and whether you understand the lock must be scoped to milliseconds, not the full checkout window.",
      steps: [
        { kind: "SAY", text: 'State the mechanism: "SELECT ... FOR UPDATE SKIP LOCKED inside a short transaction flips available → held. SKIP LOCKED lets other buyers on other seats in the same venue proceed without queueing behind this lock."' },
        { kind: "SAY", text: 'Volunteer the critical nuance: "The lock is held for the milliseconds it takes to commit that one transaction — not the 8-minute hold window. If it were held for the whole window, throughput on a hot event would collapse."' },
        { kind: "RULE OUT", text: 'One line each: **Optimistic CAS** → retry storm on hot seats. **Redis-only lock** → can silently expire mid-payment and double-sell. **Single-writer queue** → caps throughput, SPOF.' },
        { kind: "SAY", text: 'Close the loop on TTL: "Once held, a Redis TTL plus keyspace notification releases it near-instantly on abandonment, backed by a reaper sweep so correctness never depends on a single best-effort pub/sub delivery."' },
      ],
      grading: "The lock mechanism explained with the ms-scope nuance volunteered without prompting, and a one-line rejection for each alternative.",
    },
    {
      n: 5,
      title: "Deep Dive: Waiting Room & Flash-Sale Load Shedding",
      minutes: 7,
      goal: "Explain why the lock design alone isn't enough, and walk the waiting-room mechanism with a concrete admission rate.",
      why: "Anyone can say 'add a queue'. The interviewer wants an admission-control mechanism tied to a real number — the database's safe write throughput — and for the top score, the candidate naming the refresh-spam failure mode unprompted.",
      steps: [
        { kind: "SAY", text: 'Explain the gap: "Even a correct lock melts if 2M requests hit the seat-hold endpoint directly — connection pools exhaust before the lock code even runs. Admission control has to sit upstream of the database."' },
        { kind: "SAY", text: 'Walk the mechanism: "Arriving users get a queue position — a Redis sorted set or signed token — and an admission controller lets people through at the rate the DB can safely sustain, about 10K/min here, independent of how many millions are waiting."' },
        { kind: "SAY", text: 'Volunteer the failure mode: "Strict FIFO on arrival time incentivizes refresh-spamming to shave milliseconds off your position, which turns the queue into a self-inflicted DDoS. Randomizing admission order removes that incentive."' },
        { kind: "SAY", text: 'Close with the tuning point: "The admit rate isn\'t arbitrary — it\'s set to match the seat-hold service\'s measured safe transaction rate, with headroom, and adjusted from real on-sale telemetry."' },
      ],
      grading: "Admission control framed as upstream of the DB with a concrete throughput number, and the refresh-spam / randomized-admission failure mode volunteered before being asked.",
    },
    {
      n: 6,
      title: "Wrap: Payment Idempotency, Bottlenecks, and Close",
      minutes: 5,
      goal: "Name the SLA tiers, the idempotent-payment guarantee, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is operational maturity: explicit tiering used to justify what's allowed to fail, the payment-retry story stated without prompting, and a clean close that treats the interviewer as a collaborator.",
      steps: [
        { kind: "SAY", text: 'State the tiers: "Charge-and-seat-commit is tier-1 and synchronous. Notifications, search indexing, and hold reaping are tier-2/3 and async — that hierarchy is what justifies keeping them off the booking path."' },
        { kind: "SAY", text: 'Bring up payment idempotency unprompted: "Every checkout carries an idempotency key, so a client retry after a timeout can never double-charge or leave a paid seat unconfirmed — charge success and seat-sold happen in one transaction or saga."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need per-seat locking for general admission, or is that just a decrementing counter with the same lock pattern?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s an inventory system with a millisecond-scoped lock, a load-shedding waiting room, and an idempotent payment commit. With more time I\'d cover resale, dynamic pricing, and bot/fraud detection in the waiting room."' },
      ],
      grading: "Explicit SLA tiers, the idempotent-payment guarantee stated unprompted, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but the concurrency story and the numbers stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, cache, database, and a queue if prompted.",
          "Knows a seat needs 'some kind of lock' before it can be sold.",
          "Writes reasonable endpoints for holding and purchasing a seat.",
          "Adds Elasticsearch or a cache for browsing when asked how search scales.",
          "Handles 'what about the confirmation email' by adding a queue and a worker.",
        ],
        gaps: [
          "Doesn't do the contention math out loud (2M requests vs. 50K seats), or just says 'lots of traffic'.",
          "Picks a naive read-then-update or optimistic-only approach with an obvious race window.",
          "No waiting room or admission control — assumes rate limiting per IP is enough for a flash sale.",
          "No idempotency key mentioned for payment; doesn't consider a client retry after timeout.",
          "Treats browsing and seat-booking as the same read/write path with the same consistency model.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks defaults with reasons, names trade-offs when asked, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the spike-vs-average numbers on the board within the first 5 minutes.",
          "Proposes a pessimistic row lock (SELECT...FOR UPDATE, ideally SKIP LOCKED) over a naive check-then-update.",
          "Proposes a TTL-based hold via Redis, and separates browsing (cache) from booking (strong consistency).",
          "Proposes some form of virtual waiting room or admission control for the on-sale spike.",
          "Mentions idempotency keys for the payment call when asked about retries.",
          "Separates async work (notifications, indexing) from the booking critical path.",
        ],
        gaps: [
          "Doesn't volunteer that the row lock must be scoped to milliseconds, not the full hold window, unless probed.",
          "Doesn't propose the reaper-sweep-as-safety-net alongside Redis TTL unprompted — treats pub/sub as sufficient.",
          "Doesn't propose randomized admission order to prevent refresh-spam in the waiting room.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, paces the interview, surfaces risks before being asked, and brings operational maturity that goes beyond the design itself.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers that the row lock is held only for the millisecond state-transition, not the full 8-minute hold — and explains why that distinction is what makes the design scale.",
          "Designs hold release as belt-and-suspenders (TTL notification + reaper sweep) unprompted, naming pub/sub's best-effort delivery as the reason a single mechanism isn't enough.",
          "Ties the waiting-room admission rate explicitly to the database's measured safe transaction throughput, and names the refresh-spam failure mode of strict FIFO before being asked.",
          "Describes payment as a saga with an explicit compensating action (refund) for the charge-succeeds-but-seat-confirm-fails case.",
          "Defines explicit tiers (booking critical path vs. async notifications/indexing) and uses that hierarchy to justify every trade-off.",
          "Pushes back on requirements where appropriate ('does GA ticketing need per-seat locking, or just a decrementing counter?').",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Using optimistic-only CAS or a naive read-then-write for seat state, creating an obvious race window under real contention.",
      "No admission control or waiting room for a flash sale, letting millions of requests hit the database directly.",
      "Holding a row lock for the entire multi-minute checkout window instead of just the state-transition transaction.",
      "No idempotency key on payment, risking a double charge or a lost seat confirmation on client retry.",
      "Treating browsing and seat-booking as the same read/write path with the same consistency model.",
      "Relying solely on Redis TTL/pub-sub for hold release with no reconciliation sweep as a safety net.",
      "No answer for what happens to a held seat when payment fails or the user abandons checkout.",
    ],
    followUps: [
      {
        q: "Why not just cache seat availability the way you cache event listings?",
        a: "Caching works when staleness is invisible to the user, which is true for 'this event exists' but not for 'this exact seat is available' — showing a seat as free when it was just sold a second ago leads directly to a double-sell attempt at checkout. The listings page shows an approximate, cached count; the seat-selection screen and the hold transaction always go straight to the authoritative inventory row, because that's the one read that's about to become a write.",
      },
      {
        q: "What happens if the Seat Hold Service crashes mid-transaction, after acquiring the row lock but before committing?",
        a: "The database transaction itself is the unit of atomicity — if the process dies before COMMIT, the transaction never completes and the row lock is released automatically when the connection drops, leaving the seat's status column unchanged (still available or still held from before). No seat can end up in a half-updated state, because the row lock and the state mutation live inside the same transaction boundary; that's the whole reason the lock is scoped that tightly.",
      },
      {
        q: "How do you stop scalpers or bots from hoarding seats through the waiting room?",
        a: "Layer it: CAPTCHA or proof-of-work at waiting-room entry to raise the cost of scripted arrivals, per-account and per-payment-method caps on holds (e.g., max 8 seats per order, one active hold per account per event), randomized rather than strict-FIFO admission so scripted refresh-timing doesn't guarantee a front-of-queue position, and post-hoc fraud detection on purchase patterns (many orders to the same card, same device fingerprint) that can flag and reverse suspicious sales. No single layer stops a determined scalper, but together they raise the cost significantly.",
      },
      {
        q: "How would general-admission (unassigned) tickets change the locking design?",
        a: "GA tickets aren't a specific row to lock — they're a quantity, so the lock target changes from a seat row to an availability counter for the event/tier. The same pattern applies: an atomic decrement (UPDATE ... SET available = available - N WHERE available >= N, or a row lock on the tier's counter row) replaces SELECT...FOR UPDATE on a seat_id, and the hold is 'N units of tier X' with the same TTL and reaper mechanics. The waiting room and payment idempotency logic are unchanged.",
      },
      {
        q: "What's your fallback if Redis is down during an on-sale?",
        a: "Redis in this design is on the hold-TTL path, not the authoritative-state path — Postgres remains the source of truth for seat status. If Redis is unavailable, new holds can still be created (the row lock and status flip happen in Postgres), but TTL-driven fast release degrades to relying solely on the reaper sweep against a held_until column stored in Postgres, so release latency grows from sub-second to the reaper's poll interval (a few seconds) rather than the system losing correctness.",
      },
      {
        q: "How do you decide the waiting-room admission rate?",
        a: "It's derived from load testing the seat-hold transaction's actual sustained throughput against the database — the max rate at which SELECT...FOR UPDATE transactions complete without lock-wait latency climbing or connection pools saturating, with headroom subtracted for safety (say, target 70% of measured capacity). That number, not an arbitrary guess, becomes the admission controller's token-bucket refill rate, and it's re-validated per event since venue size and seat-map complexity affect it.",
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
          "This is an inventory system wearing a catalog's clothes. Browsing looks like a normal read-heavy web app and can be cached almost everywhere; buying a specific seat is a small, hot, strongly-consistent write problem concentrated on a handful of rows. The entire architecture exists to keep those two workloads from contaminating each other.",
          "Anchor everything on the spike, not the average: 2B tickets/year is only ~63 purchases/sec platform-wide, but a single on-sale can put 1-2 million fans against 50,000 seats in the same 60-second window — a 20-40x oversubscription that arrives as a step function. Every structural choice below exists to survive that step function without ever selling a seat twice.",
        ],
      },
      {
        heading: "Guaranteeing exactly one buyer per seat",
        body: [
          "A cross-region lock or a heavyweight coordination protocol per hold would be too slow, and optimistic concurrency retry-storms on a seat that hundreds of people are clicking in the same second. The winning pattern is a pessimistic row lock — SELECT ... FOR UPDATE SKIP LOCKED — held only for the milliseconds it takes to flip a seat's status from available to held inside one transaction. SKIP LOCKED lets buyers contending for different seats in the same venue proceed in parallel instead of queueing behind each other.",
          "The lock's scope is the detail that makes the design work: it protects the atomic state transition, not the 8-minute checkout window that follows. Holding it for the full window would serialize an entire event's throughput behind whoever is currently mid-checkout.",
        ],
      },
      {
        heading: "Releasing abandoned holds without trusting the client",
        body: [
          "A hold that nobody pays for has to come back on sale quickly, and the release mechanism can't depend on the user's browser staying open. The design uses two layers: a Redis TTL on the hold that fires a keyspace notification for near-instant release in the common case, plus a periodic reaper job that independently re-scans the database for holds past their expiry.",
          "The second layer exists because pub/sub delivery is best-effort — a missed notification during a redeploy or network blip would otherwise leak a held seat indefinitely. Correctness never rests on a single best-effort signal.",
        ],
      },
      {
        heading: "Shedding load before it reaches the lock",
        body: [
          "A correct locking scheme still collapses if 2 million requests hit the seat-hold endpoint in the same second — connection pools exhaust and the database melts before the lock code ever runs. The fix is a virtual waiting room: arriving users get a queue position (a Redis sorted set or signed token), and a separate admission controller lets people through to seat selection at a rate matched to the database's measured safe transaction throughput, independent of how many millions are waiting.",
          "Admission order is randomized rather than strict first-in-first-out, which removes the incentive to refresh-spam for a marginally earlier queue position — a subtlety that turns a fairness mechanism back into a self-inflicted denial of service if missed.",
        ],
      },
      {
        heading: "Two consistency budgets under one product",
        body: [
          "Browsing is cache-everything: event and venue pages sit on a CDN, search and filtering run on Elasticsearch fed by CDC off the catalog database, and a listings page's 'X tickets left' is allowed to be a few seconds stale. Only the seat-selection screen — the one read that's about to become a write — queries live inventory. Conflating these two paths, or routing every browse request through the strongly-consistent inventory service, is the most common design mistake in this problem.",
        ],
      },
      {
        heading: "Payment idempotency and the async tail",
        body: [
          "A checkout call can time out client-side after the server already charged the card, so every checkout carries an idempotency key: the Payment Service persists (key → result) before calling the payment gateway, making a retry return the original result rather than a second charge. Charge success and seat confirmation live in the same transaction or saga, with a compensating refund if the seat-confirm step fails after the charge succeeds.",
          "Once a sale commits, notifications, QR-code generation, and search-index updates all run async off a Kafka event — tier-2/3 work that must never add latency to, or be able to fail, a purchase that already succeeded.",
        ],
      },
    ],
  },
};
