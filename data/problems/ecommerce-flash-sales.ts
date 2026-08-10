import type { Problem } from "@/lib/types";

export const ecommerceFlashSales: Problem = {
  slug: "ecommerce-flash-sales",
  num: "6.6",
  title: "Design E-Commerce Flash Sales",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design the checkout path for a flash sale: 10,000 units of one hot SKU go live at 12:00:00 sharp, and 5 million shoppers hit \"Buy Now\" in the same second. The system must sell exactly 10,000 units — never 10,001, ideally not 9,990 either — while the deal page itself stays readable for 10M concurrent viewers and honest customers don't lose to bots.",
  ],
  hardParts:
    "The hard parts: absorbing a 500:1 demand-to-supply stampede without the inventory check itself becoming the bottleneck, holding a reservation open for the length of checkout without leaking unsold stock or overselling it, and doing all of this while scalping bots have every incentive to out-race real customers.",
  keyTopics: [
    "Virtual Waiting Room (Token-Bucket Admission)",
    "Atomic Inventory Decrement (Sharded Redis + Lua)",
    "Reserve-Then-Confirm (Saga with TTL Release)",
    "Hot-Key Partitioning",
    "Bot & Scalper Mitigation",
  ],
  foundationsReferenced: [
    { label: "Redis / Valkey", tone: "purple" },
    { label: "Kafka", tone: "orange" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Rate Limiting / Token Bucket", tone: "blue" },
    { label: "Idempotency Keys", tone: "orange" },
    { label: "Sharded SQL (Vitess)", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "cdn", label: "CDN", sub: "static deal page", col: 2, row: 1, tone: "green" },
      {
        id: "waitingRoom",
        label: "Waiting Room",
        sub: "token-bucket admission",
        mono: "20K admits/s",
        col: 1,
        row: 2,
        tone: "blue",
      },
      { id: "apiGateway", label: "API Gateway", sub: "per-user rate limit", col: 2, row: 2, tone: "slate" },
      { id: "checkout", label: "Checkout Service", sub: "stateless", col: 3, row: 2, tone: "green" },
      {
        id: "inventoryRedis",
        label: "Inventory Shards",
        sub: "Redis / Valkey",
        mono: "Lua DECR-if-positive · 64 shards",
        col: 4,
        row: 2,
        tone: "purple",
      },
      {
        id: "orderDb",
        label: "Order DB",
        sub: "Vitess / MySQL, sharded",
        mono: "system of record",
        col: 5,
        row: 2,
        tone: "blue",
      },
      { id: "kafka", label: "Kafka", sub: "order.created / order.paid", col: 3, row: 3, tone: "orange" },
      { id: "payment", label: "Payment Service", sub: "idempotent, saga", col: 4, row: 3, tone: "orange" },
      { id: "reconciler", label: "Reservation Reconciler", sub: "TTL release worker", col: 2, row: 3, tone: "orange" },
      { id: "fulfillment", label: "Fulfillment / Notify", col: 5, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "cdn", label: "deal page", kind: "read" },
      { from: "client", to: "waitingRoom", label: "join queue @ T-0", kind: "read" },
      { from: "client", to: "apiGateway", label: "admitted token · POST /buy", kind: "write" },
      { from: "apiGateway", to: "checkout", label: "authorized request", kind: "write" },
      { from: "checkout", to: "inventoryRedis", label: "atomic decrement", kind: "write" },
      { from: "checkout", to: "orderDb", label: "insert PENDING, TTL=5m", kind: "write" },
      { from: "checkout", to: "kafka", label: "order.created", kind: "analytics" },
      { from: "kafka", to: "payment", kind: "analytics" },
      { from: "payment", to: "orderDb", label: "CONFIRMED / FAILED", kind: "analytics" },
      { from: "kafka", to: "reconciler", label: "watch reservation TTL", kind: "analytics" },
      { from: "reconciler", to: "inventoryRedis", label: "release on timeout/fail", kind: "analytics" },
      { from: "reconciler", to: "orderDb", label: "mark EXPIRED", kind: "analytics" },
      { from: "payment", to: "fulfillment", label: "on CONFIRMED", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · deal page + queue join, 10M concurrent viewers" },
      { kind: "write", text: "write path · admitted buy attempts, ~20K/sec" },
      { kind: "analytics", text: "async · payment, fulfillment, reservation release — never blocks the buy ACK" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "apiGateway", "checkout", "orderDb"],
      say: "Start with the plain checkout skeleton: a client calls the API gateway, which hands off to a stateless Checkout Service that writes an order. This is exactly the shape that falls over the instant 5 million people hit Buy Now in the same second.",
    },
    {
      reveal: ["waitingRoom"],
      say: "The fix for the stampede isn't a bigger database, it's admission control. Every client joins a virtual waiting room first, and a token-bucket admitter releases them at a rate the checkout path can actually survive — about 20K/sec, not the raw 5M/sec spike.",
    },
    {
      reveal: ["inventoryRedis"],
      say: "The decrement itself is the hot key: 500 requests racing for every unit. A sharded Redis cluster running an atomic Lua DECR-if-positive script is what lets Checkout answer 'do you get a unit' in under 150ms with no DB row lock in the loop.",
    },
    {
      reveal: ["kafka", "payment", "reconciler"],
      say: "Winning the decrement isn't a sale — it's a PENDING reservation. Checkout fires order.created onto Kafka and returns immediately; Payment confirms or fails asynchronously, and a Reservation Reconciler watches the 5-minute TTL and releases any unit whose payment never lands.",
    },
    {
      reveal: ["cdn", "fulfillment"],
      say: "Round out the edges: the deal page itself is a static, CDN-cached asset so 10 million viewers never touch the origin, and Fulfillment/Notify only fires once Payment confirms an order.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Serve a flash-sale deal page with a live (approximate) remaining-stock indicator", tag: "P0" },
      { id: "FR-02", text: "Virtual waiting room admits shoppers into checkout at a controlled rate once the sale opens", tag: "P0" },
      { id: "FR-03", text: "Buy Now reserves exactly one unit per successful request; total sold never exceeds stock", tag: "P0" },
      { id: "FR-04", text: "Enforce a per-account purchase limit (e.g. 1 unit per verified customer)", tag: "P0" },
      { id: "FR-05", text: "Hold a reserved unit for a checkout window (5 min); auto-release if payment isn't completed", tag: "P0" },
      { id: "FR-06", text: "Process payment and confirm the order idempotently, with no duplicate charges on retry", tag: "P0" },
      { id: "FR-07", text: "Detect and slow down bots/scalpers before granting a queue token (CAPTCHA, fingerprint, velocity)", tag: "P1" },
      { id: "FR-08", text: "Show order status (confirmed, expired, sold-out) and notify the customer of the outcome", tag: "P1" },
      { id: "FR-09", text: "Admin console to configure sale start time, SKU, stock count, and per-user limit", tag: "P1" },
      { id: "FR-10", text: "Gracefully flip the deal page to \"sold out\" the instant inventory hits zero", tag: "P0" },
      { id: "FR-11", text: "Post-sale reconciliation report: units sold, reserved-then-released, revenue, bot-blocked attempts", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Queue-join latency at sale start, p99", tag: "< 200ms" },
      { id: "NFR-02", text: "Buy-Now decision latency (click to accept/reject), p99", tag: "< 150ms" },
      { id: "NFR-03", text: "Overselling tolerance across the full sale", tag: "zero oversell" },
      { id: "NFR-04", text: "Raw concurrent buy-attempts absorbed at T-0 without falling over", tag: "5M burst" },
      { id: "NFR-05", text: "Sustained checkout throughput admitted from the queue", tag: "20K orders/sec" },
      { id: "NFR-06", text: "Checkout availability during the sale window", tag: "99.95%" },
      { id: "NFR-07", text: "Reservation-timeout stock release freshness", tag: "< 10s" },
      { id: "NFR-08", text: "Deal-page read scalability, concurrent viewers", tag: "10M concurrent" },
      { id: "NFR-09", text: "Duplicate-charge rate on payment retries", tag: "zero double-charge" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing the stampede: why 5M-to-10K is the whole design",
      body: [
        "Before drawing boxes, put the ratio on the board: 10,000 units, 5,000,000 people trying to buy in the same second. That's 500 hopeful buyers for every unit, arriving within a window measured in milliseconds, not seconds. A normal e-commerce checkout — DB row lock, synchronous payment call, done — is built for maybe hundreds of orders/sec. At 500× the intended concurrency on a single row, that path doesn't degrade gracefully, it falls over: connection pools exhaust, lock waits queue, and the site goes down for everyone, including the 10,000 people who should have won.",
        "The core insight: you cannot let all 5M requests reach the inventory check at once. The system's job is split into two problems — smooth the arrival rate down to something the backend can survive (the waiting room), then make the surviving trickle race for stock atomically and correctly (the inventory decrement). Skipping the first problem is the single most common flash-sale design failure.",
      ],
      bullets: [
        { lead: "500:1 demand ratio", text: "means 499 out of every 500 requests must fail fast and cheaply — ideally before they ever touch a database or a payment gateway." },
        { lead: "Arrival is a spike, not a ramp", text: "clocks are synchronized to the sale start, so the 5M requests aren't spread over minutes, they're bunched into the first second or two." },
        { lead: "Two different problems", text: "'smooth the rate' (queueing/fairness) and 'decide who gets a unit' (atomic inventory) need different infrastructure and different latency budgets." },
      ],
      pictureTitle: "5M buy-attempts, 10K units, one second",
      pictureCaption: "capacity: 10K units · demand: 5M attempts · surplus: 4.99M requests that must fail cheaply",
      pictureRows: [
        { label: "Naive DB row lock", value: "serializes at ~hundreds/sec → falls over", tone: "bad" },
        { label: "Waiting room + sharded atomic decrement", value: "admits ~20K/sec, decides in <150ms", tone: "good" },
      ],
      remember: {
        problem: "5M concurrent buy-attempts against 10,000 units in the same second.",
        solution: "Split into two stages: an admission layer that throttles the arrival rate, then an atomic, sharded inventory check on the trickle that gets through.",
        why: "No single component can safely evaluate 5M/sec; the fix isn't a bigger database, it's rejecting most requests before they reach one.",
        tradeoff: "Most shoppers see a queue or an instant 'sold out' instead of a snappy checkout — a deliberately worse UX for the 99.8% who lose, in exchange for correctness for the 0.2% who win.",
        failure: "Skip the admission layer and the inventory check (and everything behind it) receives the full 5M/sec spike directly.",
        mitigation: "Waiting room caps admitted throughput to a number the checkout path is provisioned for, load-tested ahead of the sale.",
      },
    },
    {
      n: 2,
      title: "The virtual waiting room: kill three options, defend one",
      body: [
        "The waiting room's job is to convert an uncontrolled 5M/sec spike into a controlled ~20K/sec trickle, fairly, before anyone reaches checkout. Put the candidates up and rule them out.",
      ],
      bullets: [
        { lead: "First-come-first-served on raw requests", text: "means whoever has the fastest script wins, which is exactly the scalper-bot outcome you're trying to avoid, and it does nothing to reduce backend load — it just races everyone against the same overloaded endpoint." },
        { lead: "Load-shed with plain 503s", text: "protects the backend but gives real users no path back in; they refresh manually, which just regenerates the spike every few seconds." },
        { lead: "Random lottery among all 5M", text: "is fair but still requires collecting and storing 5M entries in the same second — you've moved the stampede, not solved it." },
        { lead: "Token-bucket queue", text: "each client requests a queue position (a signed, short-lived token) the instant they arrive; a background admitter releases tokens into checkout at a fixed rate (e.g. 20K/sec) matched to downstream capacity. Position updates are pushed via polling with jittered backoff or a WebSocket, so the queue itself doesn't need a synchronous DB write per request. Winner." },
      ],
      pictureTitle: "Waiting room: kill three, keep one",
      pictureRows: [
        { label: "Raw FCFS race", value: "rewards fastest bot script → reject", tone: "bad" },
        { label: "Plain 503 shedding", value: "protects backend, no path back in → reject", tone: "bad" },
        { label: "Lottery over all 5M", value: "moves the stampede, doesn't solve it → reject", tone: "bad" },
        { label: "Token-bucket admission queue", value: "throttles to 20K/s, fair by arrival → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Convert an uncontrolled 5M/sec spike into a rate the checkout path can survive, fairly.",
        solution: "A token-bucket admission queue: clients get a signed position token on arrival, a background admitter releases tokens at a fixed rate into checkout.",
        why: "Rate-limiting the entry point is cheaper than rate-limiting every downstream service separately, and it decouples 'how many arrived' from 'how many we can serve now'.",
        tradeoff: "Real users wait in a visible queue instead of an instant buy — a UX cost accepted deliberately for backend survivability.",
        failure: "No admission layer means the checkout service, inventory store, and payment gateway all take the raw 5M/sec hit simultaneously.",
        mitigation: "Load-test the admitted rate against real checkout capacity ahead of the sale, and keep the admit rate configurable to throttle down live if downstream lags.",
      },
    },
    {
      n: 3,
      title: "Atomic inventory: the hot-key problem and sharded counters",
      body: [
        "Even after throttling to 20K/sec, every one of those requests is racing to decrement the same counter for the same SKU — a textbook hot key. The decrement must be atomic (check-and-decrement as one operation) or two requests can both read '1 remaining' and both succeed, overselling by one. Multiply that race by thousands of concurrent requests on one key and even a correct atomic primitive can become a throughput ceiling.",
        "A single Redis key with a Lua script (\"if stock > 0 then DECR\") is atomic and fast — a single core can push roughly 50K-100K such ops/sec — which comfortably covers 20K/sec admitted traffic. The real defense-in-depth move for extreme cases is to shard the counter itself: split 10,000 units across, say, 64 shards of ~156 units each, hashed by a random request attribute so load spreads evenly. The catch is uneven depletion — one shard might empty while another still has stock, showing 'sold out' to some users while others still succeed on the same product.",
      ],
      bullets: [
        { lead: "DB row lock (SELECT ... FOR UPDATE)", text: "is correct but serializes at row-lock speed — hundreds to low thousands/sec — and holds a DB connection per waiting request. Fine as the system of record, wrong as the hot-path gate." },
        { lead: "Single Redis key + Lua DECR-if-positive", text: "atomic, in-memory, ~50-100K ops/sec on one core — enough once the waiting room has already throttled the rate down." },
        { lead: "Sharded counters", text: "spreads the hot key across N partitions for extra headroom, at the cost of possible early 'sold out' on individual shards while stock remains elsewhere." },
        { lead: "Reconcile the imbalance", text: "once most shards are near-empty, redirect remaining admits to a single 'overflow' shard holding the last few units, so the tail of the sale doesn't strand stock." },
      ],
      pictureTitle: "Who can survive the decrement rate?",
      pictureRows: [
        { label: "DB row lock", value: "hundreds/sec, connection-bound → too slow", tone: "bad" },
        { label: "Single Redis key + Lua", value: "~50-100K ops/sec, covers 20K/s admitted", tone: "good" },
        { label: "64 sharded counters", value: "more headroom, uneven depletion risk", tone: "neutral" },
        { label: "Overflow shard at the tail", value: "pools last units, avoids stranded stock", tone: "good" },
      ],
      remember: {
        problem: "Decrement one shared inventory counter correctly under heavy concurrent contention.",
        solution: "Atomic Lua script on Redis (check-and-decrement in one op); shard the counter across N partitions if raw throughput demands it.",
        why: "The decrement must be a single atomic operation or two racing requests can both see stock and both succeed, causing an oversell.",
        tradeoff: "Sharding buys throughput headroom but risks uneven depletion — some shards report sold-out while others still have stock.",
        failure: "A read-then-write (GET then SET) instead of an atomic op reintroduces the race and oversells under load.",
        mitigation: "Use DECR-if-positive as one Lua script, not two calls; route the last few units through a shared overflow shard.",
      },
    },
    {
      n: 4,
      title: "Reserve-then-confirm: holding stock without leaking or overselling it",
      body: [
        "Winning the inventory decrement isn't a completed sale — the customer still has to pay, and payment gateways take seconds, not milliseconds. Two failure modes threaten here: hold the unit forever and stock leaks (sold in the system, never actually purchased, item unavailable to anyone else), or don't hold it at all and someone else's decrement succeeds on a unit that's mid-checkout for another customer. The fix is a saga: reserve, then confirm-or-release, with a hard TTL.",
        "On a successful decrement, the checkout service writes a PENDING order with a 5-minute expiry and hands the customer off to payment. If payment succeeds within the window, the order flips to CONFIRMED and the reservation becomes permanent. If the window lapses or payment fails, a reconciler releases the unit back to inventory (an atomic INCR) and marks the order EXPIRED — that unit is now available to the next person admitted from the queue.",
      ],
      bullets: [
        { lead: "PENDING with TTL", text: "the reservation is a state, not just a decremented counter — it has a clock, and the clock is enforced by a background worker, not by hoping the client comes back." },
        { lead: "Idempotent payment call", text: "the order_id is the idempotency key sent to the payment gateway, so a client retry (or a network blip causing a duplicate request) never double-charges." },
        { lead: "Reconciler as the safety valve", text: "a scheduled sweep (or a delayed Kafka message keyed by order_id) finds expired PENDING orders and releases their unit, closing the loop even if the payment service itself is down." },
        { lead: "Confirm is a one-way door", text: "once CONFIRMED, the unit is permanently sold; only PENDING orders are eligible for release, so a slow-but-successful payment can never be undone by the reconciler." },
      ],
      pictureTitle: "Reservation lifecycle",
      pictureRows: [
        { label: "Decrement succeeds", value: "order PENDING, TTL = 5 min starts", tone: "neutral" },
        { label: "Payment confirms in time", value: "order CONFIRMED, unit permanently sold", tone: "good" },
        { label: "TTL expires / payment fails", value: "reconciler releases unit, order EXPIRED", tone: "bad" },
        { label: "Duplicate payment retry", value: "idempotency key blocks double charge", tone: "good" },
      ],
      remember: {
        problem: "Hold inventory during a multi-second payment step without leaking unsold stock or overselling reserved stock.",
        solution: "A PENDING reservation with a hard TTL; confirm on successful payment, auto-release on timeout or failure via a background reconciler.",
        why: "Payment latency and inventory scarcity have different time constants — the reservation state machine reconciles them explicitly instead of conflating 'decremented' with 'sold'.",
        tradeoff: "A slow-but-honest customer can lose their reservation to the TTL; the alternative (no TTL) risks stock leaking forever behind abandoned checkouts.",
        failure: "No TTL means every abandoned checkout permanently removes a unit from sale, so the SKU can show sold-out while units sit unpurchased.",
        mitigation: "TTL enforced by a reconciler independent of the client, plus idempotency keys so payment retries never double-charge a CONFIRMED order.",
      },
    },
    {
      n: 5,
      title: "Bot and scalper mitigation: raising the cost of cheating",
      body: [
        "A flash sale with no bot defense is a sale for whoever has the best script, not the best luck. This is an arms race, not a solved problem — the goal is to raise the cost and latency of automation past what a real browser incurs, layered at every stage rather than relying on one filter.",
      ],
      bullets: [
        { lead: "Queue-join CAPTCHA / proof-of-work", text: "a lightweight challenge at the moment of requesting a queue token, cheap for a human on a phone, expensive to solve at bot scale across thousands of accounts." },
        { lead: "Device fingerprint + velocity checks", text: "flag many queue-join attempts from the same device signature or IP range in a short window; slow-path or drop them before they consume an admitted slot." },
        { lead: "Signed, short-lived queue tokens", text: "bound to the session that requested them, so a token can't be harvested and resold or shared across a bot farm — presenting someone else's token at checkout fails validation." },
        { lead: "Hard per-account purchase limit", text: "one unit per verified account/payment method, enforced at the checkout service before the inventory decrement, closing the 'buy 500 with 500 fake accounts' loophole partially (real accounts still cost more to fake than to script)." },
        { lead: "Post-sale pattern review", text: "orders matching known scalper signatures (shared shipping address, card BIN clustering, timing patterns) get flagged for manual cancellation and restock, accepted as a mop-up rather than a prevention." },
      ],
      pictureTitle: "Layered bot defense",
      pictureRows: [
        { label: "Queue-join CAPTCHA / PoW", value: "raises cost of automated queueing", tone: "good" },
        { label: "Device fingerprint + velocity", value: "flags bursty joins from one source", tone: "good" },
        { label: "Signed session-bound token", value: "kills token resale/sharing", tone: "good" },
        { label: "Per-account purchase limit", value: "caps damage even if bots get through", tone: "neutral" },
        { label: "No defense at all", value: "fastest script wins every unit", tone: "bad" },
      ],
      remember: {
        problem: "Prevent bots and scalper scripts from winning the majority of scarce inventory.",
        solution: "Layer proof-of-work/CAPTCHA at queue join, device/velocity fingerprinting, session-bound signed tokens, and a hard per-account limit.",
        why: "No single filter stops a determined attacker; each layer raises cost and catches a different failure mode of the others.",
        tradeoff: "Every layer adds friction and false-positive risk for real customers — tuned deliberately below the pain threshold of a human, above the cost threshold of naive automation.",
        failure: "No bot defense means the fastest, most-automated actor wins nearly all inventory, and real customers correctly perceive the sale as rigged.",
        mitigation: "Defense-in-depth plus post-sale pattern detection to cancel and restock units traced to scalper behavior after the fact.",
      },
    },
    {
      n: 6,
      title: "Async off the critical path: why checkout doesn't wait for payment",
      body: [
        "The Buy Now response the customer sees — reservation accepted, here's your 5-minute checkout window — must come back in well under 150ms. A payment gateway call can take seconds and occasionally times out. If checkout waited synchronously on payment, the p99 latency of the whole buy path would be dictated by the slowest payment gateway response, not by your own infrastructure, and a gateway blip would stall every admitted buyer.",
        "So checkout does only the synchronous work that must be atomic — decrement inventory, write the PENDING order — then emits an order.created event to Kafka and returns immediately. Payment, fulfillment, and notification all consume that event asynchronously. The customer sees their reservation confirmed instantly and is walked to a payment step that can take as long as it needs, up to the TTL.",
      ],
      bullets: [
        { lead: "Synchronous tier", text: "inventory decrement + PENDING order write — the only steps that must complete before the customer gets an answer, kept minimal on purpose." },
        { lead: "Async tier", text: "payment call, fulfillment kickoff, and customer notification all happen off Kafka consumers, decoupled from the buy-now request/response cycle." },
        { lead: "Gateway outage isolation", text: "if the payment gateway is degraded, admitted buyers still get their reservation confirmed on time; only the confirm step is delayed, and the TTL clock (not the gateway) governs when a stuck reservation gets released." },
        { lead: "Ordering matters less than idempotency here", text: "Kafka gives at-least-once delivery, so the payment consumer must be idempotent on order_id regardless of ordering guarantees." },
      ],
      pictureTitle: "Sync vs. async in the buy path",
      pictureRows: [
        { label: "Inventory decrement + PENDING write", value: "synchronous, <150ms, blocks the ACK", tone: "neutral" },
        { label: "Payment gateway call", value: "async via Kafka, seconds, off the ACK path", tone: "good" },
        { label: "Fulfillment + notification", value: "async, triggered on CONFIRMED", tone: "good" },
        { label: "Payment on the sync path", value: "p99 dictated by gateway, blocks every buyer", tone: "bad" },
      ],
      remember: {
        problem: "Keep Buy Now latency under 150ms when payment gateway calls can take seconds.",
        solution: "Do only inventory decrement + PENDING write synchronously; push payment, fulfillment, and notification onto Kafka as async consumers.",
        why: "A tier-1 latency budget can't be held hostage to a tier-3 dependency's response time.",
        tradeoff: "Customers see 'reservation confirmed' before payment has actually run, requiring a follow-up status step instead of a single-shot receipt.",
        failure: "Synchronous payment on the buy path means a slow or degraded gateway stalls every admitted buyer, not just the ones paying at that instant.",
        mitigation: "Async payment consumer with idempotency on order_id; the TTL reconciler is what ultimately bounds how long a stuck reservation lives.",
      },
    },
    {
      n: 7,
      title: "Redis as hot truth, SQL as system of record",
      body: [
        "During the sale, the inventory counter lives in Redis because nothing else is fast enough for the decrement rate. But Redis is not where you want the durable record of what was sold — a restart, an eviction, or a replication hiccup on an in-memory store shouldn't be the thing standing between you and knowing whether 10,000 or 9,998 units actually sold. The order table in a sharded SQL store (Vitess/MySQL, sharded by user_id) is the durable system of record; Redis is the fast, best-effort gate in front of it.",
        "That split needs an explicit reconciliation step: after the sale, sum CONFIRMED orders in the SQL store and compare against the starting stock count. Any drift — Redis under-counted (a shard restarted mid-sale and lost in-flight decrements) or over-counted (a release raced a confirm) — shows up here and gets corrected before the sale is declared final.",
      ],
      bullets: [
        { lead: "Redis: the gate", text: "in-memory, AOF-persisted for crash recovery, sharded for throughput — optimized for 'can this request have a unit right now', not for long-term durability guarantees." },
        { lead: "SQL: the ledger", text: "every PENDING/CONFIRMED/EXPIRED order is a durable row; this table is what finance, support, and inventory replenishment all trust, not Redis." },
        { lead: "Reconciliation job", text: "post-sale, and periodically during a long-running sale, diff Redis's remaining count against SQL's confirmed-order count to catch drift early." },
        { lead: "Redis restart plan", text: "on a Redis failover, re-seed the shard's remaining count from (initial allocation − confirmed orders for that shard) in SQL, never from a guess." },
      ],
      pictureTitle: "Fast gate vs. durable ledger",
      pictureRows: [
        { label: "Redis (sharded)", value: "decrement gate, in-memory, AOF-backed", tone: "used" },
        { label: "SQL order table", value: "durable system of record, source of truth", tone: "good" },
        { label: "Reconciliation job", value: "diffs Redis vs. SQL, catches drift", tone: "neutral" },
        { label: "Trusting Redis long-term", value: "an eviction or crash loses the count silently", tone: "bad" },
      ],
      remember: {
        problem: "Get decrement speed from an in-memory store without making it the permanent record of what sold.",
        solution: "Redis (sharded) as the fast gate; sharded SQL order table as the durable system of record; a reconciliation job diffs the two.",
        why: "Speed and durability are different requirements — solving both with one store means compromising one of them.",
        tradeoff: "Two stores to keep consistent instead of one, plus an explicit reconciliation step that has to run reliably.",
        failure: "Treating Redis as the sole source of truth means a crash or eviction can silently lose or duplicate sold units with no record to recover from.",
        mitigation: "AOF persistence plus a reconciliation job that re-seeds Redis counts from confirmed SQL orders after any failover.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a 500:1 stampede problem: 5M buy-attempts against 10K units in one second, so the first job is throttling arrival with a virtual waiting room, not the database.",
      "Inventory decrement must be one atomic operation (Lua DECR-if-positive on Redis), sharded across counters if a single hot key can't take the admitted rate.",
      "Winning the decrement isn't a sale — it's a PENDING reservation with a 5-minute TTL; a reconciler releases it back if payment doesn't confirm in time.",
      "Payment, fulfillment, and notification all run async off Kafka so a slow payment gateway never stalls the buy-now ACK.",
      "Bot defense is layered (CAPTCHA at queue join, fingerprinting, signed session-bound tokens, per-account limits) because no single filter stops a determined scalper.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 10M CONCURRENT VIEWERS · DEAL PAGE + QUEUE",
        summary:
          "The deal page itself is a static, CDN-cached asset. Joining the queue is the first dynamic call, and it's designed to be cheap — issue a signed token, don't do any real work yet.",
        steps: [
          { label: "Client", note: "loads the flash-sale page" },
          { label: "CDN", note: "static deal page, remaining-stock is approximate" },
          { label: "Waiting Room", note: "issues a signed queue-position token" },
          { label: "Admitter", note: "releases tokens into checkout at ~20K/sec" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · ~20K ADMITTED/S · BUY NOW",
        summary:
          "Only admitted requests reach here. The decrement and the PENDING write are the only synchronous, must-be-correct steps — everything else about the purchase happens after this returns.",
        steps: [
          { label: "API Gateway", note: "validates admitted token, per-user rate limit" },
          { label: "Checkout Service", note: "stateless" },
          { label: "Inventory Shards (Redis)", note: "atomic Lua DECR-if-positive" },
          { label: "Order DB", note: "insert PENDING, TTL = 5 min" },
          { label: "ACK to client", note: "reservation confirmed, go to payment" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · PAYMENT, FULFILLMENT, RESERVATION RELEASE",
        summary:
          "Everything that can be slow runs off Kafka. The reconciler is the safety valve — it's the only thing that guarantees a stuck PENDING order eventually releases its unit.",
        steps: [
          { label: "Checkout Service", note: "emits order.created" },
          { label: "Payment Service", note: "idempotent on order_id, calls gateway" },
          { label: "Order DB", note: "flips to CONFIRMED or FAILED" },
          { label: "Reconciler", note: "watches TTL, releases unit on expiry/failure" },
          { label: "Fulfillment / Notify", note: "on CONFIRMED only" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "10K units, 5M buy-attempts in ~1 second → 500:1 demand ratio",
          "Waiting room admits ~20K/sec, matched to load-tested checkout capacity",
          "Buy-now decision latency: p99 < 150ms; queue-join latency: p99 < 200ms",
          "Single Redis key with Lua: ~50-100K ops/sec ceiling on one core",
          "64 inventory shards ≈ 156 units each, plus one overflow shard for the tail",
          "Reservation TTL: 5 minutes; reconciler releases within 10s of expiry",
          "Deal page: 10M concurrent viewers, served from CDN, not origin",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Virtual waiting room (token-bucket admission), not raw FCFS or plain 503 shedding",
          "Atomic Lua DECR-if-positive on Redis, not a DB row lock, for the hot-path decrement",
          "Shard the inventory counter under extreme load; pool the tail into an overflow shard",
          "Reserve-then-confirm saga with a hard TTL, not an immediate irreversible decrement",
          "Payment/fulfillment/notification async on Kafka, never on the buy-now sync path",
          "Sharded SQL as the durable system of record; Redis is the fast gate, reconciled after",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The waiting room isn't just fairness — it's what makes the atomic decrement survivable at all",
          "Reservation TTL prevents both stock leaking (abandoned checkouts) and overselling (no hold at all)",
          "Bot defense is layered and probabilistic, not a single solved filter — say the arms-race framing out loud",
          "Redis is not the source of truth long-term; reconciliation against SQL catches drift",
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
      goal: "Get the demand ratio and five numbers on the board before drawing anything. This ratio drives every later decision.",
      why: "The interviewer is checking whether you recognize this as a stampede problem, not a normal checkout problem. If you don't establish the 500:1 ratio up front, you'll design a system that would work for a busy Tuesday, not a flash sale.",
      steps: [
        { kind: "ASK", text: '**"How many units, how many expected buyers, and over what window?"** Land on "10,000 units", "5M buy-attempts", "within ~1 second of sale open". Write **"10K units, 5M attempts, 500:1"** top-left.' },
        { kind: "ASK", text: 'Ask **"Is oversell ever acceptable?"** Land on "zero oversell, hard requirement" and **"minimize unsold-but-reserved stock too"** — both directions of correctness matter.' },
        { kind: "SAY", text: 'Propose the latency targets yourself: **"buy-now decision under 150ms p99"**, **"queue-join under 200ms p99"**. Wait for a nod, then write them down.' },
        { kind: "SAY", text: 'State scope. In: "waiting room", "atomic inventory", "reservation + payment saga", "bot mitigation". Out: "product catalog", "shipping logistics", "customer support". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the throughput math out loud: **"if checkout can safely handle ~20K/sec, the waiting room admits at that rate, not the raw 5M/sec"**. Write **"admit rate = downstream capacity, not demand"** on the board.' },
      ],
      grading: "Do you name the 500:1 ratio unprompted, lock zero-oversell as non-negotiable, and separate 'admit rate' from 'demand rate' before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Three endpoints, one reservation state machine, and the TTL made explicit before it gets asked for.",
      why: "The interviewer wants to see the reservation lifecycle as a first-class model, not an afterthought bolted onto a normal order table. Naming PENDING/CONFIRMED/EXPIRED up front signals you already see the saga.",
      steps: [
        { kind: "WRITE", text: 'Write three endpoints: **"POST /queue/join"** returns "{ queueToken }". **"POST /buy { queueToken }"** returns "{ orderId, status: PENDING, expiresAt }". **"POST /orders/:id/pay { idempotencyKey }"** returns "{ status: CONFIRMED | FAILED }".' },
        { kind: "DRAW", text: 'Sketch the order row: **"order_id (PK)"**, **"user_id"**, **"sku_id"**, **"status: PENDING/CONFIRMED/EXPIRED"**, **"reserved_at"**, **"expires_at"**. Say: "status and expires_at are the whole reservation state machine."' },
        { kind: "SAY", text: 'Justify the TTL: "5 minutes is enough for a real checkout, short enough that abandoned carts don\'t strand inventory for long." Write **"TTL = 5 min"** on the board.' },
        { kind: "RULE OUT", text: 'Get ahead of it: "No TTL means abandoned checkouts leak stock forever. Decrementing only on payment success means the decrement itself races under load — reserve-then-confirm is the middle ground." Cross off both extremes.' },
      ],
      grading: "Three crisp endpoints, an explicit status/TTL field in the schema, and you naming both failure extremes (no TTL vs. decrement-on-payment) before being asked.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram, three labeled lanes: read (deal page + queue), write (admitted buy-now), async (payment/fulfillment/release).",
      why: "Separating these three lanes is the whole architectural insight. Candidates who draw a single client-to-DB blob miss that the waiting room and the async tier exist specifically to protect the tiny synchronous core.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → CDN (deal page) and Client → Waiting Room → Admitter. Label **"10M concurrent viewers"**, **"20K admits/s"**.' },
        { kind: "DRAW", text: 'Add the **write path**: Client (with its admitted token) → API Gateway → Checkout Service → Inventory Shards (Redis) + Order DB. Label **"atomic Lua decrement"**, **"insert PENDING, TTL=5m"**.' },
        { kind: "DRAW", text: 'Add the **async path** off Checkout Service: → Kafka → Payment Service → Order DB (CONFIRMED/FAILED), and Kafka → Reconciler → back to Inventory Shards (release). Label **"never blocks the buy-now ACK"**.' },
        { kind: "SAY", text: 'Narrate: "Three lanes because they have three different jobs — the read lane absorbs volume, the write lane must be atomic and fast, the async lane can take as long as it needs up to the TTL."' },
      ],
      grading: "Three clearly separated lanes, the reconciler shown feeding back into inventory (not a dead end), and an explicit statement that payment never sits on the buy-now path.",
    },
    {
      n: 4,
      title: "Deep Dive: Admission Control and Atomic Inventory",
      minutes: 8,
      goal: "Defend the waiting room's throttling role and the atomic decrement mechanism, including why a naive DB lock fails.",
      why: "This is the signature sub-problem: proving you understand that the waiting room's real job is protecting the decrement, not just fairness — and that the decrement itself must be a single atomic operation.",
      steps: [
        { kind: "SAY", text: 'Explain the waiting room mechanism: "Each client gets a signed queue-position token on arrival. A background admitter releases tokens at a fixed rate matched to what checkout can survive — it\'s a token bucket, not a lottery."' },
        { kind: "SAY", text: 'Explain the decrement: "Lua script does check-and-decrement as one atomic operation on Redis — read-then-write as two calls reintroduces the oversell race."' },
        { kind: "DRAW", text: 'If pushed on extreme throughput: "Shard the counter across ~64 partitions. Tradeoff: uneven depletion, some shards empty early. Mitigate with an overflow shard for the last units."' },
        { kind: "RULE OUT", text: 'One line each: **DB row lock** → serializes at hundreds/sec, connection-bound. **Raw FCFS** → rewards the fastest bot. **No sharding at extreme scale** → single key becomes the ceiling.' },
      ],
      grading: "The atomic-operation requirement stated without prompting, sharding brought up as a scaling lever with its tradeoff named, and a one-line rejection for each weaker alternative.",
    },
    {
      n: 5,
      title: "Deep Dive: Reservation TTL, Payment, and Bot Mitigation",
      minutes: 7,
      goal: "Walk the reserve-then-confirm saga and volunteer the bot-defense layers before being asked.",
      why: "The interviewer wants to see the reservation lifecycle handled as a state machine with a real failure path, and bot mitigation treated as a first-class concern, not an afterthought.",
      steps: [
        { kind: "SAY", text: 'Walk the saga: "Decrement succeeds → PENDING order, 5-min TTL → payment async → CONFIRMED on success, or the reconciler releases the unit on timeout/failure and marks it EXPIRED."' },
        { kind: "SAY", text: 'Cover idempotency: "The order_id is the idempotency key sent to the payment gateway, so a retry never double-charges."' },
        { kind: "SAY", text: 'Volunteer bot defense: "Layered — proof-of-work or CAPTCHA at queue join, device/velocity fingerprinting, signed session-bound tokens so they can\'t be resold, and a hard per-account limit as the backstop."' },
        { kind: "SAY", text: 'Frame it honestly: "This is an arms race, not a solved problem — the goal is raising the cost of automation, plus post-sale pattern review to cancel and restock scalped orders."' },
      ],
      grading: "The TTL/reconciler mechanism explained without prompting, idempotency named for the payment call, and bot mitigation volunteered as a layered, honestly-imperfect defense.",
    },
    {
      n: 6,
      title: "Wrap: Failure Modes and Close",
      minutes: 5,
      goal: "Name the sync/async tier split, the Redis-vs-SQL truth split, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal here is naming failure modes proactively: what happens if Redis restarts mid-sale, what happens if the payment gateway is slow, and closing like a collaborator who paced the interview deliberately.",
      steps: [
        { kind: "SAY", text: 'State the tiers: "Inventory decrement and PENDING write are tier-1 and synchronous. Payment, fulfillment, notification are tier-2 and async — that split is what keeps the buy-now ACK under 150ms regardless of gateway latency."' },
        { kind: "SAY", text: 'Bring up the Redis/SQL split unprompted: "Redis is the fast gate, SQL is the durable ledger. If Redis fails over mid-sale, re-seed its count from confirmed SQL orders, never from a guess."' },
        { kind: "SAY", text: 'Push back where useful: "Do we actually need a global 10K-unit pool, or can we pre-allocate by region to cut cross-region latency on the decrement?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a stampede-throttling problem solved with a waiting room, an atomic sharded decrement, and a reserve-then-confirm saga. With more time I\'d cover regional pre-allocation, refund/cancellation flow, and abuse pattern detection in depth."' },
      ],
      grading: "Explicit sync/async tiers, the Redis-vs-SQL truth split named unprompted, at least one pushback on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working checkout flow that handles the happy path, but treats the spike as 'add a queue' without quantifying it.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, cache, queue, database, payment service.",
          "Knows a decrement needs to be atomic and reaches for Redis without prompting.",
          "Adds some kind of rate limiting when asked how to handle the spike.",
          "Writes a reasonable order schema with a status field.",
          "Mentions bots need to be blocked somehow, usually 'add a CAPTCHA'.",
        ],
        gaps: [
          "Doesn't quantify the demand ratio (500:1) or connect it to why a normal checkout path fails.",
          "Treats the waiting room as a UX nicety rather than the thing that makes the decrement survivable.",
          "No reservation TTL — either decrements are permanent immediately, or there's no story for abandoned checkouts.",
          "Payment call sits on the synchronous checkout path with no async decoupling.",
          "Bot mitigation stops at 'add a CAPTCHA' with no layering or per-account limit.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, quantifies the stampede, and builds a correct reserve-then-confirm saga with reasoned trade-offs.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "States the 500:1 demand ratio and derives the admit rate from downstream capacity, not demand.",
          "Explains the atomic Lua decrement and why read-then-write races into an oversell.",
          "Designs the reservation as PENDING → CONFIRMED/EXPIRED with an explicit TTL and reconciler.",
          "Moves payment and fulfillment off the synchronous checkout path onto Kafka.",
          "Names idempotency keys for the payment call to prevent double-charging on retry.",
          "Layers at least two bot-defense mechanisms and explains what each catches.",
          "Distinguishes Redis (fast gate) from SQL (system of record).",
        ],
        gaps: [
          "Brings up counter sharding only when pushed on extreme throughput, not proactively.",
          "Doesn't volunteer the Redis-restart reconciliation story unless asked what happens on failover.",
          "Frames bot mitigation as a solved problem rather than an explicit arms race with residual risk.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats the demand ratio as the design's organizing constraint, and surfaces every failure mode before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Frames the whole system around the 500:1 stampede from minute one, and derives every downstream decision (admit rate, shard count, TTL) as a consequence of that ratio.",
          "Volunteers the uneven-depletion risk of sharded counters and the overflow-shard mitigation without being pushed.",
          "Names the Redis-vs-SQL truth split and the reconciliation-after-failover story unprompted.",
          "Frames bot mitigation honestly as a layered arms race with residual risk, including post-sale pattern-based cancellation as the mop-up layer.",
          "Explicitly separates tier-1 synchronous work (decrement + PENDING write) from tier-2/3 async work, and uses that hierarchy to justify every latency trade-off.",
          "Pushes back on requirements ('does the whole 10K pool need to be global, or can we pre-allocate by region?').",
          "Closes with a one-sentence summary and explicitly lists what they'd cover with more time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Designing the buy-now path as if it were a normal checkout, with no admission/throttling layer in front of it.",
      "Using a read-then-write (GET, check, SET) for the inventory decrement instead of a single atomic operation — this oversells under real concurrency.",
      "Decrementing inventory permanently the instant a request is accepted, with no TTL or reservation state, so abandoned checkouts leak stock forever.",
      "Putting the payment gateway call on the synchronous checkout path, so a slow gateway stalls every admitted buyer.",
      "No idempotency key on the payment call, risking a double charge on a client or network retry.",
      "Treating Redis as the permanent source of truth for what sold, with no reconciliation against a durable ledger.",
      "No bot mitigation at all, or treating a single CAPTCHA as a complete solution to scalping.",
    ],
    followUps: [
      {
        q: "What happens if two requests both read 'stock = 1' right before the sale ends?",
        a: "That can only happen if the check and the decrement are two separate operations. The fix is making it one atomic operation — a Lua script on Redis that checks stock > 0 and decrements in a single call the Redis event loop executes without interleaving. Two racing requests either both see the atomic op run sequentially (one gets the unit, one doesn't) or, if sharded, land on different shards and each sees its own shard's count — there's no window where both can read the same '1' and both succeed.",
      },
      {
        q: "How do you size the waiting room's admit rate?",
        a: "Load-test the checkout path (inventory decrement + order write) end-to-end and find its sustainable throughput with acceptable p99 latency — say 20K/sec. The admit rate is set to that number, not to demand. It should also be a live-adjustable config, not a constant, so if downstream starts lagging during the actual sale, ops can throttle the admit rate down in real time without a deploy.",
      },
      {
        q: "What if the reconciler itself goes down and reservations never expire?",
        a: "Run the reconciler as multiple replicas consuming from a partitioned Kafka topic or a scheduled sweep with leader election, so no single instance failing stalls all releases. As a backstop, the order's expires_at is checked lazily too — any read of a PENDING order past its TTL treats it as expired and triggers release inline, so even a fully-down reconciler self-heals the moment anything touches that order.",
      },
      {
        q: "Why not just decrement on payment success instead of on Buy Now?",
        a: "Because payment can take seconds, and during that window another shopper's decrement could also succeed on the same unit if you haven't reserved it yet — you'd be back to an oversell race, just moved later. Reserving at Buy Now and confirming on payment success is what prevents two customers from both believing they hold the last unit during the payment step.",
      },
      {
        q: "How would you handle a second flash sale for a different SKU happening at the same time?",
        a: "Each SKU gets its own inventory shard set and its own waiting-room admit-rate budget, since they're independent stampedes with independent capacity constraints. The shared infrastructure (Kafka topics, payment service, order DB) is multi-tenant by sku_id, but the admission and inventory layers should not let one sale's spike consume the admit budget meant for another — partition the token bucket and shard pool per SKU.",
      },
      {
        q: "Bots will always find a way around fingerprinting — is the effort worth it?",
        a: "Yes, framed correctly: the goal isn't zero bots, it's raising the cost per unit acquired past what's profitable for scalpers while staying invisible to real customers. Each layer (PoW, fingerprinting, signed tokens, account limits) closes a specific loophole the others don't, and the post-sale pattern-based cancellation catches what got through. It's an arms race with diminishing but real returns, not a one-time fix.",
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
          "This is a stampede-throttling problem wearing a checkout-flow costume. The core numbers are 10,000 units against 5,000,000 buy-attempts in roughly one second — a 500:1 demand ratio — and every structural decision exists to survive that ratio while guaranteeing zero oversell.",
          "Split the system into a throttling stage (the waiting room, which converts an uncontrolled spike into a sustainable trickle) and a correctness stage (the atomic reservation, which guarantees exactly 10,000 units sell no matter how the trickle arrives). Confusing these two stages, or skipping the first, is the most common design failure.",
        ],
      },
      {
        heading: "Admission: converting 5M/sec into 20K/sec",
        body: [
          "A virtual waiting room issues a signed, short-lived queue-position token the instant a client arrives, before any real work happens. A background admitter releases tokens into checkout at a fixed rate matched to load-tested downstream capacity — not to demand. This single move is what makes every downstream component's job tractable: the inventory store, order DB, and payment service are all sized for 20K/sec, not 5M/sec.",
          "Raw first-come-first-served rewards the fastest script, not the earliest human; plain load-shedding gives no path back in and just regenerates the spike on refresh. The token-bucket queue is the winner because it's both fair by arrival order and load-independent of demand.",
        ],
      },
      {
        heading: "Atomic inventory and hot-key sharding",
        body: [
          "Every admitted request races to decrement the same counter. That decrement must be a single atomic operation — a Lua script on Redis performing check-and-decrement in one call — or two racing requests can both read stock remaining and both succeed, overselling. A DB row lock is correct but serializes at hundreds of ops/sec, far below the 20K/sec admitted rate.",
          "A single Redis key with Lua comfortably covers 20K/sec (a core can push 50-100K such ops/sec), but as a scaling lever the counter can be sharded across N partitions for extra headroom. The tradeoff is uneven depletion — some shards empty early while others still have stock — mitigated by pooling the final units into a shared overflow shard once most partitions are near zero.",
        ],
      },
      {
        heading: "Reserve-then-confirm: the saga that prevents both failure directions",
        body: [
          "Winning the decrement creates a PENDING order with a hard TTL (5 minutes), not an immediately-final sale. This prevents both failure directions at once: an immediate, un-reversible decrement leaks stock behind every abandoned checkout, while no reservation at all lets a second buyer's decrement succeed on a unit that's mid-payment for someone else.",
          "A background reconciler watches for expired PENDING orders and releases their unit atomically (an INCR), flipping the order to EXPIRED. Payment is called with the order_id as an idempotency key so retries never double-charge. Confirm is a one-way door — only PENDING orders are eligible for release, so a slow-but-successful payment can never be undone.",
        ],
      },
      {
        heading: "Async off the critical path, and the two-store truth split",
        body: [
          "Checkout does only the synchronous work that must be atomic — decrement inventory, write the PENDING order — then emits an event and returns. Payment, fulfillment, and notification all run as async consumers off Kafka, so a slow or degraded payment gateway never stalls the buy-now acknowledgment; only the confirm step is delayed, bounded by the reservation TTL.",
          "Redis holds the hot inventory count because nothing else is fast enough for the decrement rate, but it is not the durable system of record — the sharded SQL order table is. A reconciliation job diffs Redis's remaining count against confirmed orders in SQL, and any Redis failover re-seeds counts from SQL rather than from a guess.",
        ],
      },
      {
        heading: "Bot mitigation as a layered, honest arms race",
        body: [
          "No single filter stops a determined scalper, so defense is layered: proof-of-work or CAPTCHA at queue join raises the cost of automated queueing; device and velocity fingerprinting flags bursty joins from one source; signed, session-bound queue tokens prevent harvesting and resale; a hard per-account purchase limit caps damage even from bots that get through; and post-sale pattern review (shared shipping addresses, card BIN clustering) catches what slipped through for manual cancellation and restock.",
          "The honest framing matters in an interview: this isn't a solved problem, it's raising the cost and latency of cheating past what's profitable, while staying invisible to real customers — a deliberately imperfect, continuously-tuned defense rather than a single gate.",
        ],
      },
    ],
  },
};
