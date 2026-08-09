import type { Problem } from "@/lib/types";

export const onlineAuction: Problem = {
  slug: "online-auction",
  num: "6.8",
  title: "Design an Online Auction",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design an eBay-style online auction platform that runs 10M live auctions concurrently, absorbs peak bursts of 20K bids/sec when auctions cluster around common close times, notifies every watcher of an outbid event within 1 second, and closes each auction exactly once — determining the winner and capturing payment without ever double-charging a bidder or silently losing a winning bid.",
  ],
  hardParts:
    "The hard parts: serializing concurrent bids on the same hot item without a global lock while a last-second sniping burst hammers a single row, closing an auction and charging the winner exactly once despite crashes, retries, and an anti-sniping extension that keeps moving the deadline, and fanning out real-time price updates to thousands of watchers on one item without melting the WebSocket layer.",
  keyTopics: [
    "Optimistic Concurrency Bidding (CAS)",
    "Proxy / Max-Bid Auto-Increment",
    "Soft-Close Anti-Sniping",
    "Exactly-Once Auction Settlement",
    "Throttled WebSocket Fan-Out",
  ],
  foundationsReferenced: [
    { label: "Optimistic Concurrency Control", tone: "blue" },
    { label: "CockroachDB / Postgres", tone: "blue" },
    { label: "Kafka", tone: "orange" },
    { label: "Saga Pattern", tone: "orange" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "WebSockets / Pub-Sub", tone: "purple" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", col: 1, row: 1, tone: "slate" },
      { id: "cdn", label: "CDN", sub: "listing images", col: 1, row: 2, tone: "green" },
      { id: "lb", label: "API Gateway", col: 2, row: 1, tone: "slate" },
      { id: "item_service", label: "Item Service", sub: "read replica", col: 3, row: 1, tone: "green" },
      { id: "valkey", label: "Valkey", sub: "current price cache · ~95% hit", col: 4, row: 1, tone: "green" },
      {
        id: "bid_service",
        label: "Bid Service",
        sub: "stateless",
        mono: "per-item CAS · optimistic concurrency",
        col: 3,
        row: 2,
        tone: "purple",
      },
      {
        id: "postgres",
        label: "CockroachDB",
        sub: "sharded by item_id",
        mono: "immutable bid ledger",
        col: 5,
        row: 2,
        tone: "blue",
      },
      { id: "kafka", label: "Kafka", sub: "bid.placed / auction.closed", col: 3, row: 3, tone: "orange" },
      { id: "ws_gateway", label: "WebSocket Gateway", sub: "per-item pub/sub, throttled", col: 2, row: 3, tone: "orange" },
      {
        id: "closer",
        label: "Auction Closer",
        mono: "timer wheel · CAS claim",
        col: 4,
        row: 3,
        tone: "orange",
      },
      {
        id: "payment",
        label: "Payment / Settlement",
        mono: "saga · idempotent capture",
        col: 5,
        row: 3,
        tone: "orange",
      },
    ],
    edges: [
      { from: "client", to: "cdn", label: "images", kind: "read" },
      { from: "client", to: "lb", label: "browse item", kind: "read" },
      { from: "lb", to: "item_service", kind: "read" },
      { from: "item_service", to: "valkey", label: "~95% hit", kind: "read" },
      { from: "valkey", to: "postgres", label: "miss", kind: "read" },
      { from: "client", to: "lb", label: "place bid", kind: "write" },
      { from: "lb", to: "bid_service", label: "bid submit", kind: "write" },
      { from: "bid_service", to: "valkey", label: "update current price", kind: "write" },
      { from: "bid_service", to: "postgres", label: "CAS update · version check", kind: "write" },
      { from: "bid_service", to: "kafka", label: "bid.placed, async", kind: "analytics" },
      { from: "kafka", to: "ws_gateway", label: "fan-out outbid alerts", kind: "analytics" },
      { from: "ws_gateway", to: "client", label: "real-time price push", kind: "analytics" },
      { from: "kafka", to: "closer", label: "auction lifecycle timer", kind: "analytics" },
      { from: "closer", to: "postgres", label: "claim CLOSING · pick winner", kind: "write" },
      { from: "closer", to: "payment", label: "capture payment · saga", kind: "write" },
      { from: "payment", to: "kafka", label: "settlement.completed", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · browsing & watching, ~200:1 vs. writes" },
      { kind: "write", text: "write path · bid placement & auction close, CAS-guarded" },
      { kind: "analytics", text: "async · events, fan-out, and background settlement" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Seller lists an item with starting price, optional reserve price, duration, and optional buy-it-now price", tag: "P0" },
      { id: "FR-02", text: "Bidder places a bid that must exceed the current highest bid by at least the minimum increment", tag: "P0" },
      { id: "FR-03", text: "Proxy/max-bid: bidder sets a private maximum and the system auto-bids on their behalf up to that max", tag: "P0" },
      { id: "FR-04", text: "Real-time current-price updates and outbid notifications pushed to watchers", tag: "P0" },
      { id: "FR-05", text: "Anti-sniping: a bid placed inside the closing window extends the auction end time", tag: "P0" },
      { id: "FR-06", text: "Auction close determines the winner and honors the reserve price (no sale if unmet)", tag: "P0" },
      { id: "FR-07", text: "Payment capture from the winner and payout to the seller, idempotent under retry", tag: "P0" },
      { id: "FR-08", text: "Immutable, viewable bid history per item", tag: "P1" },
      { id: "FR-09", text: "Watch list: users can follow an item without bidding", tag: "P1" },
      { id: "FR-10", text: "Search and browse the catalog with filters (category, price range, ending soon)", tag: "P1" },
      { id: "FR-11", text: "Fraud and shill-bid detection signals (same-IP self-bidding, abnormal bid velocity)", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Bid submit latency, server-side", tag: "p99 < 150ms" },
      { id: "NFR-02", text: "Item-page read latency on cache hit", tag: "p99 < 50ms" },
      { id: "NFR-03", text: "Outbid notification delivery, even on a 10K-watcher hot item", tag: "p99 < 1s" },
      { id: "NFR-04", text: "Bid throughput at peak (sniping bursts at common close times)", tag: "20K/sec" },
      { id: "NFR-05", text: "Auction close and payment capture: no double-charge, no lost winner", tag: "exactly-once" },
      { id: "NFR-06", text: "Availability (about 4.4 hrs downtime per year)", tag: "99.95%" },
      { id: "NFR-07", text: "Durability of the bid ledger once a bid is accepted", tag: "zero loss" },
      { id: "NFR-08", text: "Read-to-write ratio that anchors the caching strategy", tag: "200:1" },
      { id: "NFR-09", text: "Peak-to-average bid rate driven by end-time clustering", tag: "35:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why the average bid rate is a lie",
      body: [
        "The naive capacity number is deceptively calm: 50M bids/day across 10M live auctions works out to about 580 bids/sec on average. If you size the write path for that, the system falls over on its first real day, because bids do not arrive uniformly through the day.",
        "Two effects concentrate load into narrow windows. First, auctions cluster around common end times (top of the hour, Sunday evening), so thousands of auctions close in the same 60-second window. Second, sniping means a large share of an auction's total bids — often 30-40% — land in its final 10 seconds, as bidders wait to avoid tipping their hand early. Multiply those together and peak load can hit ~20,000 bids/sec, roughly 35x the daily average.",
      ],
      bullets: [
        { lead: "Daily average", text: "50M bids / 86,400s ≈ 580 bids/sec — looks trivial, and is the wrong number to design around." },
        { lead: "End-time clustering", text: "auctions scheduled to end at round times pile thousands of closes into the same minute." },
        { lead: "Sniping concentration", text: "a large fraction of any single auction's bids land in its last 10 seconds, stacking on top of the clustering effect." },
        { lead: "Net peak", text: "~20,000 bids/sec, about 35x the average — this is the number that sizes the write path, the DB shard count, and the fan-out layer." },
      ],
      pictureTitle: "Average vs. peak bid rate",
      pictureCaption: "design target: size for the 35x peak burst, not the 580/sec average",
      pictureRows: [
        { label: "Daily average", value: "~580 bids/sec", tone: "neutral" },
        { label: "Peak (sniping burst at common close times)", value: "~20,000 bids/sec, ~35x average", tone: "bad" },
        { label: "Design target", value: "provision the write path and DB shards for the peak", tone: "good" },
      ],
      remember: {
        problem: "The average bid rate looks tiny, but real load is spiky.",
        solution: "Size the write path for the ~35x peak created by end-time clustering plus last-second sniping, not the ~580/sec daily average.",
        why: "Auctions cluster around common close times and each one concentrates a chunk of its bids into its final seconds — the two effects compound.",
        tradeoff: "Provisioning for the peak means running excess capacity most of the day, in exchange for not falling over during the exact moment that matters most.",
        failure: "Size for the average and the system saturates every time a batch of popular auctions closes together.",
        mitigation: "Load-test against a synthetic sniping burst, not steady traffic, and alert on bid-rate slope, not just absolute rate.",
      },
    },
    {
      n: 2,
      title: "Bid ordering: kill three options, defend one",
      body: [
        "Many bidders can hit the same item's current price at the same instant, especially during a sniping burst. The write must never silently lose a bid, and it must do this without a lock sitting on the hottest row in the system. Put the candidates on the board and rule them out one at a time.",
      ],
      bullets: [
        { lead: "Global or distributed lock", text: "a Redis-based lock per item adds a network round trip to every bid and, worse, can expire mid-write under a GC pause or network blip, letting two writers both believe they hold it. Rejected." },
        { lead: "Naive read-then-write UPDATE", text: "application code reads current_price=100, computes a new value, writes it back with no version check. Two concurrent bidders can both read 100, both write, and one accepted bid vanishes with no error — a classic lost update. Rejected." },
        { lead: "Kafka partitioned by item_id", text: "guarantees per-item event ordering and is genuinely useful for the async fan-out lane, but it doesn't by itself resolve the database write or the proxy-bid math — consumer lag also adds latency the bid path can't afford. Partial." },
        { lead: "Optimistic concurrency (CAS on a version column)", text: "UPDATE auctions SET current_price=?, version=version+1 WHERE auction_id=? AND version=?. Only one concurrent writer's CAS matches; everyone else gets zero rows affected, re-reads the fresh price, and retries. No lock is ever held, and an uncontested item pays no extra cost at all. Winner." },
      ],
      pictureTitle: "Bid ordering: kill three, keep one",
      pictureRows: [
        { label: "Global/distributed lock", value: "extra RTT + risk of a stale lock mid-write → reject", tone: "bad" },
        { label: "Naive read-then-write UPDATE", value: "lost update: a bid vanishes silently → reject", tone: "bad" },
        { label: "Kafka keyed by item_id", value: "orders events, doesn't resolve the write → partial", tone: "neutral" },
        { label: "CAS on version column", value: "one writer wins, loser retries → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Serialize concurrent bids on one item without a global lock on the hottest row.",
        solution: "Optimistic concurrency control: UPDATE ... WHERE auction_id=? AND version=?, retry on a zero-row result.",
        why: "No lock is ever held, so uncontested items (the vast majority) pay zero coordination cost; only genuinely contended items retry.",
        tradeoff: "Under heavy contention a bidder's request may retry a few times before it lands, adding a little tail latency to the hottest items.",
        failure: "A naive read-then-write UPDATE with no version check silently drops a winning bid when two writers race.",
        mitigation: "Bound retries with backoff and a max-attempt cap; surface 'price changed, please confirm' to the bidder if retries exhaust.",
      },
    },
    {
      n: 3,
      title: "Proxy bidding: the private max and the auto-raise",
      body: [
        "Every bidder actually has two numbers: a public current bid that everyone sees, and a private maximum only the system knows. When a challenger bids, the system doesn't just record their number — it re-runs the auction logic to raise the current leader just far enough to stay ahead, up to that leader's own private max.",
        "This is what lets someone set a max bid once and walk away: the system fights on their behalf without ever revealing how high they were willing to go.",
      ],
      bullets: [
        { lead: "Two prices per bidder", text: "current bid (public) and max bid (private, never shown to anyone, including the seller)." },
        { lead: "Auto-raise on challenge", text: "a new bid only pushes the current price up to min(challenger's bid + increment, leader's max) — never straight to the leader's true ceiling." },
        { lead: "Leader change", text: "if the challenger's max exceeds the current leader's max, the challenger becomes the new leader at min(challenger's max, previous leader's max + increment)." },
        { lead: "Tie-break", text: "equal max bids go to whoever bid first, which prevents the two proxies from oscillating forever." },
      ],
      pictureTitle: "Proxy bid resolution, worked example",
      pictureRows: [
        { label: "Alice sets max $80 (first bidder)", value: "current price = $10 (starting price)", tone: "neutral" },
        { label: "Bob bids $40 (his true max)", value: "proxy raises Alice to $42 (Bob + $2 increment); Bob is outbid instantly", tone: "good" },
        { label: "Bob raises his max to $95", value: "Bob becomes leader at $82 (Alice's max $80 + $2 increment)", tone: "used" },
      ],
      remember: {
        problem: "Let a bidder set a ceiling once and never have to babysit the auction.",
        solution: "Store a private max per bidder; on every challenge, auto-raise the current leader to just past the challenger, capped at the leader's max.",
        why: "It reproduces what a human proxy at a live auction house does — fight to the max you gave them, never reveal it early.",
        tradeoff: "The public price understates true willingness to pay, which is by design but occasionally confuses bidders watching the price barely move.",
        failure: "Skipping proxy bidding and treating every bid as a literal one-shot forces bidders to manually re-bid every time they're outbid, which is what sniping exploits.",
        mitigation: "Re-run the proxy resolution atomically inside the same CAS write that accepts the challenger's bid, so the two never desync.",
      },
    },
    {
      n: 4,
      title: "Anti-sniping: the soft close",
      body: [
        "A fixed hard deadline rewards timing, not valuation: a sniper who bids in the last second wins purely because no one had time to respond, which defeats the point of a live auction. The fix, borrowed from real auction houses, is a soft close: any bid landing inside a closing window pushes the end time forward, so the auction only truly ends once bidding actually goes quiet.",
      ],
      bullets: [
        { lead: "Fixed deadline problem", text: "a bid at T-1 second wins by timing, not by being the highest genuine valuation — sniping tools automate exactly this." },
        { lead: "Soft-close window", text: "a bid landing inside the last 5 minutes extends end_time by 5 more minutes." },
        { lead: "Natural convergence", text: "because each extension only re-triggers on a new bid inside the window, the auction converges the moment bidders stop bidding — it doesn't loop forever on its own." },
        { lead: "Bound it anyway", text: "cap total extensions (e.g., max 10) or total extra time (e.g., +30 min cap) so you have a hard answer ready for 'what if it never converges?'" },
      ],
      pictureTitle: "Soft-close mechanics",
      pictureRows: [
        { label: "Bid at T-8min (outside the 5-min window)", value: "no extension, end_time unchanged", tone: "neutral" },
        { label: "Bid at T-2min (inside the window)", value: "end_time += 5min", tone: "used" },
        { label: "No bids in the last 5 min", value: "auction closes for real", tone: "good" },
      ],
      remember: {
        problem: "A fixed deadline rewards last-second timing over genuine valuation.",
        solution: "Any bid inside the closing window (e.g., last 5 min) extends end_time by that window, capped by a max extension count or total extra time.",
        why: "It converges naturally — the auction only ends once no new bid arrives inside the window — while the cap bounds the worst case.",
        tradeoff: "A genuinely hot item can run noticeably longer than its posted end time, which some sellers find surprising unless it's disclosed upfront.",
        failure: "No soft close means sniping tools reliably beat honest bidders who don't automate their last-second bid.",
        mitigation: "Disclose the soft-close rule in the listing and cap total extension so support has a concrete answer for 'how long can this run?'",
      },
    },
    {
      n: 5,
      title: "Exactly-once close and settlement",
      body: [
        "Closing an auction is a state transition with money attached, and it must happen exactly once even if multiple workers race to do it or a crash forces a retry. Model it as an explicit state machine — OPEN -> CLOSING -> CLOSED/UNSOLD -> SETTLED — and make the very first transition the thing that prevents duplicates, not the payment call at the end.",
      ],
      bullets: [
        { lead: "Claim before you act", text: "UPDATE auctions SET status='CLOSING' WHERE id=? AND status='OPEN' AND end_time<=now(). Only one Closer worker's UPDATE affects a row; every other racing worker affects zero rows and backs off. Same CAS pattern as the bid write, applied to the status column." },
        { lead: "Reserve check", text: "if current_price < reserve_price, the auction closes as UNSOLD and no payment ever runs." },
        { lead: "Idempotent payment capture", text: "the capture request carries an idempotency key derived from auction_id, so a retried request after a crash returns the original result instead of creating a second charge." },
        { lead: "Saga, not a distributed transaction", text: "payment capture, inventory release, and notification are independent steps that each retry on their own; if payment ultimately declines, a compensating step reverts the win (offer the next-highest bidder, or mark unsold) instead of trying to roll back everything atomically." },
      ],
      pictureTitle: "What makes 'exactly once' literally true",
      pictureRows: [
        { label: "Two Closer workers race the same auction", value: "CAS on status: only one wins the CLOSING transition", tone: "good" },
        { label: "Settlement crashes mid-payment", value: "retry reuses the same idempotency key — no double charge", tone: "good" },
        { label: "Payment declines after close", value: "saga compensates: offer next-highest bidder or mark unsold", tone: "neutral" },
      ],
      remember: {
        problem: "Close every auction and capture payment exactly once, despite racing workers and crash-retries.",
        solution: "CAS-guarded OPEN -> CLOSING transition claims the auction before any settlement work runs; payment capture carries an idempotency key.",
        why: "The claim step is what makes duplication structurally impossible, not just unlikely — the idempotency key then protects the money-movement step specifically.",
        tradeoff: "The state machine adds a couple of extra writes and a short CLOSING window versus a naive one-shot 'close and charge' call.",
        failure: "A plain cron `UPDATE ... WHERE end_time<=now()` immediately followed by a payment call, with no claim step, double-charges when two workers race or a retry fires after a crash.",
        mitigation: "Never let payment run until the CLOSING claim succeeds; always pass auction_id-derived idempotency keys to the payment provider.",
      },
    },
    {
      n: 6,
      title: "Real-time fan-out and the hot-item thundering herd",
      body: [
        "Watchers subscribe to an item's price channel expecting near-real-time updates, but pushing a WebSocket message on every single bid does not scale to a hot item. Ten thousand watchers on one auction that takes 50 bids in its last 10 seconds means 500,000 messages per second from that one item alone if you push per bid.",
      ],
      bullets: [
        { lead: "Per-bid push doesn't scale", text: "10K watchers × 50 bids in 10s = 500K messages/sec generated by a single hot auction." },
        { lead: "Coalesce, don't stream every bid", text: "throttle broadcasts to about once per second per item, always carrying the latest price — a bidder who got outbid mid-burst still finds out well within the 1s p99 budget." },
        { lead: "Fan-out via partitioned pub/sub", text: "Kafka keyed by item_id feeds however many WebSocket gateway pods hold that item's watcher connections, so one hot item's connections spread across the whole gateway fleet instead of pinning a single process." },
      ],
      pictureTitle: "Taming one hot item's fan-out",
      pictureRows: [
        { label: "Naive: 1 push per bid", value: "~500K msgs/sec from one hot item", tone: "bad" },
        { label: "Throttled: 1 push/sec/item", value: "~10K msgs/sec from the same item, still under 1s p99", tone: "good" },
        { label: "Connections for one item", value: "spread across the WebSocket gateway fleet via keyed pub/sub", tone: "used" },
      ],
      remember: {
        problem: "Fan out real-time price updates to thousands of watchers on one hot item without melting the notification layer.",
        solution: "Throttle broadcasts to ~1 update/sec/item carrying the latest price; distribute watcher connections across the gateway fleet via item_id-keyed pub/sub.",
        why: "The 1s p99 budget doesn't require streaming every bid — only the latest price, delivered promptly, matters to a watcher.",
        tradeoff: "A watcher won't see every intermediate price during a burst, only the latest one each second — acceptable since the current price is all that's actionable.",
        failure: "Per-bid WebSocket pushes on a single hot item can generate hundreds of thousands of messages per second and take down the gateway serving it.",
        mitigation: "Server-side coalescing window plus keyed pub/sub so no single gateway process ever holds all of one item's watchers.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a write path fighting contention on one row (an item's current price), a scheduled exactly-once state transition (closing the auction), and a real-time fan-out side channel — three different correctness properties, three different tools.",
      "Concurrent bids on the same item are serialized with optimistic concurrency (a version column CAS), not a lock — the loser retries instead of blocking everyone else.",
      "Proxy bidding means every bidder has a public current bid and a private max; the system auto-raises the leader just past each challenger, up to that private max.",
      "Anti-sniping extends the deadline whenever a bid lands in the closing window, so auctions end when bidding actually goes quiet, not on an exploitable fixed clock.",
      "Auction close claims the row with a CAS before any settlement work runs, and payment capture carries an idempotency key, so a crash-and-retry can never close an auction twice or double-charge a winner.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · BROWSE/WATCH · SUB-50MS P99",
        summary:
          "Browsing an item page is a cache-served lookup of the current price and metadata. The database is only touched on a cache miss.",
        steps: [
          { label: "Client", note: "opens an item page" },
          { label: "CDN", note: "listing images" },
          { label: "API Gateway", note: "routes to a nearby pod" },
          { label: "Item Service", note: "stateless read" },
          { label: "Valkey", note: "current price cache, ~95% hit" },
          { label: "CockroachDB", note: "miss only" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · BID PLACEMENT · SUB-150MS P99",
        summary:
          "A bid is validated, then written with a CAS against the item's version column. A conflict means someone else won the race; the caller retries against the fresh price.",
        steps: [
          { label: "Client", note: "submits a bid or a max bid" },
          { label: "API Gateway", note: "auth, rate limit" },
          { label: "Bid Service", note: "validates increment, funds hold" },
          { label: "CockroachDB CAS", note: "UPDATE ... WHERE version=? — retry on conflict" },
          { label: "proxy-bid resolution", note: "auto-raise leader up to their private max" },
          { label: "Valkey", note: "update current price cache" },
          { label: "Kafka", note: "emit bid.placed, async" },
        ],
      },
      {
        kind: "analytics",
        title: "BACKGROUND · CLOSE, SETTLE, NOTIFY",
        summary:
          "A timer service claims due auctions with the same CAS pattern used for bids, then runs settlement as an idempotent saga while notifications fan out on the side.",
        steps: [
          { label: "Auction Closer", note: "polls the due index by end_time" },
          { label: "CAS claim CLOSING", note: "only one worker wins per auction" },
          { label: "determine winner", note: "check reserve_price" },
          { label: "Payment/Settlement", note: "idempotency key = auction_id" },
          { label: "Kafka", note: "settlement.completed event" },
          { label: "WebSocket Gateway", note: "throttled push, ~1/sec/item" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "10M live auctions concurrently, ~50M bids/day, ~580 bids/sec average",
          "Peak ~20,000 bids/sec during sniping bursts at common close times, ~35x average",
          "Bid submit p99 < 150ms; item-page read p99 < 50ms on cache hit",
          "Outbid notification delivered p99 < 1s even on a 10K-watcher hot item",
          "Anti-sniping window: a bid inside the last 5 min extends end_time by 5 min, capped",
          "Valkey current-price cache ~95% hit rate on item-page reads",
          "Read:write ratio ~200:1 (browsing/watching vs. bidding)",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Optimistic concurrency (version column CAS) on current_price, not a distributed lock",
          "Proxy/max-bid model: public current price, private max, auto-raise on challenge",
          "Soft-close anti-sniping instead of a hard fixed deadline",
          "Auction close claimed via CAS on the status column before any settlement work runs",
          "Idempotency key = auction_id on payment capture; a saga, not a 2PC transaction",
          "Kafka keyed by item_id both orders bid events and fans out to WebSocket gateways",
          "Valkey caches current price; CockroachDB is the source of truth",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Average bid rate hides the real problem: end-time clustering + sniping create a ~35x burst",
          "Throttle real-time push to ~1 update/sec/item, not one per bid, to survive a hot-item thundering herd",
          "Reserve price: a winning bid can still result in 'no sale' if the reserve isn't met",
          "CAS retry never silently loses a bid — the loser re-reads the fresh price and retries",
          "The CAS-guarded CLOSING claim is what makes 'exactly once' true, not the idempotency key alone — both are needed",
          "Fraud/shill-bidding detection is P2 scope, but be ready to name the signals (same-IP self-bidding, bid velocity)",
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
      goal: "Confirm it's an English (ascending) auction with optional reserve and buy-it-now, then get the real numbers on the board before drawing anything.",
      why: "This design lives or dies on numbers the interviewer expects you to derive, not guess. Locking the average-vs-peak gap first is what later justifies every concurrency and caching decision.",
      steps: [
        { kind: "ASK", text: '**Is this an ascending English auction or a Dutch/descending one?** Confirm "English auction, optional reserve price, optional buy-it-now". Write **"English, reserve + BIN optional"** top-left.' },
        { kind: "ASK", text: 'Next ask: **"How many live auctions, and what\'s the bid rate?"** Land on "10M live auctions", "~580 bids/sec average". Write **"10M auctions, 580 b/s avg"**.' },
        { kind: "SAY", text: 'Propose latency targets yourself: **"bid submit p99 < 150ms"**, **"outbid notification p99 < 1s"**. Wait for a nod, then write it down.' },
        { kind: "SAY", text: 'State scope. In: "bid placement", "proxy bidding", "anti-sniping", "close and settlement", "real-time notifications". Out: "seller KYC/onboarding", "payment processor internals", "search ranking". "Happy to come back to any of those." Wait for confirmation.' },
        { kind: "WRITE", text: 'Do the peak math out loud: **"50M bids/day → ~580/sec average"**, **"sniping at common close times pushes peak to ~20K/sec, ~35x average"**. Write both numbers on the board — don\'t keep them in your head.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, parking out-of-scope items deliberately, and surfacing the average-vs-peak gap before drawing any boxes?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two write endpoints, one immutable bid ledger, and a version column called out explicitly before it's needed.",
      why: "The interviewer wants to see the version column land here, not as an afterthought during the concurrency deep dive — it signals you designed for contention from the start, not bolted it on.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /auctions/:id/bids { amount, maxBid? }"** returns **"{ status, currentPrice }"**. **"GET /auctions/:id"** returns "current price, end_time, bid count". **"WS /auctions/:id/watch"** for real-time updates.' },
        { kind: "DRAW", text: 'Sketch two tables: **"auctions { auction_id PK, seller_id, current_price, current_bidder_id, version, reserve_price, end_time, status }"** and **"bids { bid_id, auction_id, bidder_id, amount, max_bid, placed_at }"** — say "bids are append-only, like an immutable event log; only the auction row\'s current_price pointer ever moves."' },
        { kind: "SAY", text: '"Every bid write is a CAS against this version column — that\'s what replaces a lock, and I\'ll come back to it in the deep dive."' },
        { kind: "RULE OUT", text: '"A single global sequence number across all auctions would serialize unrelated items against each other — partition ordering by auction_id instead."' },
      ],
      grading: "Two clean endpoints, an explicit immutable bid ledger separate from the mutable auction row, and the version column called out unprompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: read, write, and background/async. Each lane gets a different correctness property, and say so.",
      why: "This is the structural signal: reads are cache-served and eventually consistent, writes need linearizable per-item ordering, and the close/settlement lane needs exactly-once — three different guarantees, three different mechanisms, and the interviewer is checking you know they're different.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → CDN → API Gateway → Item Service → Valkey → CockroachDB (miss only). Label **"~95% hit"** on the Valkey arrow.' },
        { kind: "DRAW", text: 'Add the **write path**: Client → API Gateway → Bid Service → CockroachDB, labeled **"CAS · version check, retry on conflict"**, then Bid Service → Valkey to update the cached price.' },
        { kind: "DRAW", text: 'Add the **background/async lane**: Bid Service → Kafka → WebSocket Gateway → Client (throttled push), and separately Kafka → Auction Closer → CockroachDB (claim CLOSING) → Payment/Settlement.' },
        { kind: "SAY", text: '"Three lanes, three correctness properties: reads are cache-served, writes need linearizable per-item CAS, and the close/settlement lane needs exactly-once — not just eventual consistency."' },
      ],
      grading: "Three clearly separated lanes, each arrow labeled with a share or a mechanism (not just a box name), and an explicit statement that the three lanes have different correctness requirements.",
    },
    {
      n: 4,
      title: "Deep Dive: Bid Concurrency and Proxy Bidding",
      minutes: 8,
      goal: "Show the CAS statement, defend it against the alternatives, then walk a concrete proxy-bidding example with numbers.",
      why: "This is the signature sub-problem, the same role the ID generator played in a URL shortener design — one hot row, many concurrent writers, and a bid must never be silently lost.",
      steps: [
        { kind: "DRAW", text: 'Write the CAS statement: **"UPDATE auctions SET current_price=?, version=version+1 WHERE auction_id=? AND version=?"**. "Only one concurrent writer\'s CAS matches; everyone else gets zero rows affected and retries against the fresh price."' },
        { kind: "SAY", text: 'Walk the proxy-bid example: "Alice sets a private max of $80. Bob bids $40 — the proxy raises Alice to $42, Bob is outbid instantly without Alice lifting a finger. Bob raises his max to $95 — now Bob leads at $82, Alice\'s max plus the increment."' },
        { kind: "RULE OUT", text: '"A distributed lock adds a round trip to the hottest row and can expire mid-write. A naive read-then-write UPDATE with no version check silently drops a bid. Kafka ordering alone orders events but doesn\'t resolve the database write." Cross each off.' },
        { kind: "SAY", text: '"Uncontested items — the vast majority — pay zero extra cost. Only genuinely contended items during a sniping burst ever retry."' },
      ],
      grading: "The CAS statement on the board, a concrete numeric proxy-bid walkthrough, and a one-line rejection for each alternative.",
    },
    {
      n: 5,
      title: "Deep Dive: Anti-Sniping and Exactly-Once Close",
      minutes: 7,
      goal: "Explain the soft-close mechanic with numbers, then show the state machine and the CAS claim that makes settlement exactly-once.",
      why: "The interviewer is probing whether you can name the failure mode of a naive cron-based close (double-close, double-charge) before it's pointed out to you, and whether you can articulate that the CAS claim — not the idempotency key alone — is what prevents duplication.",
      steps: [
        { kind: "SAY", text: 'Explain soft close: "A bid landing inside the last 5 minutes extends end_time by 5 more minutes. It converges naturally once bidding goes quiet, and I cap total extensions so there\'s a hard upper bound."' },
        { kind: "DRAW", text: 'Draw the state machine: **"OPEN → CLOSING → CLOSED/UNSOLD → SETTLED"**. Circle the OPEN → CLOSING transition: **"UPDATE ... WHERE status=\'OPEN\' AND end_time<=now()"** — "this CAS claim is what makes exactly-once literally true."' },
        { kind: "SAY", text: '"Payment capture carries an idempotency key derived from auction_id, so a crash-and-retry never double-charges. If payment ultimately declines, a compensating step offers the next-highest bidder or marks the item unsold — it\'s a saga, not a distributed transaction."' },
        { kind: "RULE OUT", text: '"A naive cron `UPDATE ... WHERE end_time<=now()` that immediately calls payment, with no claim step, double-charges the instant two Closer replicas race or a retry fires after a crash." Cross it off.' },
      ],
      grading: "The state machine drawn with the CAS claim circled, an idempotency key named explicitly on the payment step, and the naive-cron failure mode ruled out unprompted.",
    },
    {
      n: 6,
      title: "Wrap: Fan-Out, Tiers, and Close",
      minutes: 5,
      goal: "Name the hot-item fan-out throttle, state the SLA tiers, push back on a requirement, and close with a one-sentence summary plus parked items.",
      why: "Staff-level signal here is spotting the thundering-herd risk in the notification layer before being asked, and treating the interview like a collaborative 40-minute budget rather than a checklist to exhaust.",
      steps: [
        { kind: "SAY", text: '"A 10K-watcher hot item taking 50 bids in its last 10 seconds is 500K messages/sec if I push per bid. I throttle broadcasts to about 1/sec/item carrying the latest price, and spread that item\'s connections across the WebSocket gateway fleet via item_id-keyed pub/sub."' },
        { kind: "SAY", text: '"Tiers: bid writes are tier-1 for correctness, close/settlement is tier-1 for correctness but not latency-critical, notifications are tier-2, throttled, best-effort within the 1s budget."' },
        { kind: "SAY", text: 'Push back where useful: "Is 20K bids/sec global, or per region? Are auctions region-pinned, or can bidders in different regions bid on the same item concurrently?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a contended-row write path plus an exactly-once scheduled close plus a throttled real-time side channel. With more time I\'d cover fraud/shill-bid detection, payment processor internals, and search ranking."' },
      ],
      grading: "The hot-item throttle named unprompted, explicit SLA tiers, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design that mostly hangs together, but the concurrency and settlement correctness stay hand-wavy until pressed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: bid service, database, cache, and a notification queue.",
          "Knows to add some kind of locking when prompted about concurrent bids.",
          "Can write the core endpoints and a reasonable two-table data model.",
          "Knows proxy bidding exists as a concept, in outline.",
          "Adds a cron job to close auctions when the deadline passes.",
        ],
        gaps: [
          "Doesn't reason about the lost-update race on current_price without being prompted.",
          "Treats close as a simple `UPDATE ... WHERE end_time<=now()` with no claim step — double-charge risk goes unnoticed.",
          "No plan for hot-item fan-out; assumes WebSocket pushes 'just work' at any scale.",
          "Anti-sniping described vaguely as 'extend the timer' with no window size or cap.",
          "Doesn't separate the read, write, and background lanes into different correctness properties.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, lands on CAS-based concurrency and a real state machine for close, and quantifies the parts the interviewer pushes on.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the peak-vs-average bid rate and the latency budgets on the board within the first 5 minutes.",
          "Drives CAS/version-based concurrency for bids unprompted, with the retry-on-conflict behavior explained.",
          "Explains the proxy-bid algorithm with a concrete numeric example.",
          "States the soft-close window with numbers and mentions a cap.",
          "Separates bid-write / close-settlement / notification into distinct correctness tiers.",
          "Names an idempotency key on the payment capture step.",
        ],
        gaps: [
          "Doesn't volunteer the CAS-claim-before-settlement pattern until asked 'what if two closer workers race?'",
          "Mentions hot-item fan-out throttling only when pushed on 'what about 10K watchers?'",
          "Doesn't proactively describe the saga compensation path for a payment that declines after close.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, surfaces the load-bearing risks before being asked, and brings operational maturity that goes beyond the mechanics of the design.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the average-vs-peak sizing gap (~35x) unprompted as the number that drives every capacity decision.",
          "Frames the CAS-guarded CLOSING claim as the mechanism that makes 'exactly once' literally true, distinct from the idempotency key that protects the payment step specifically.",
          "Proactively raises the hot-item thundering herd risk and names a concrete throttle (~1 push/sec/item) before being asked about scale.",
          "Pushes back on requirements ('is 20K bids/sec global or per region? are auctions region-pinned?').",
          "Names the saga/compensation path for a late payment decline without being prompted.",
          "Closes with a one-sentence summary of the whole system and an explicit list of what they'd cover with more time.",
          "Treats the interviewer as a collaborator: paces the 40 minutes, parks tangents, and returns to them only if time allows.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Reaching for a distributed lock (or a single global mutex) on bid writes instead of optimistic concurrency — kills throughput and still risks a stale lock mid-write.",
      "A plain read-then-write UPDATE on current_price with no version check — two concurrent bids can silently overwrite each other and a winning bid vanishes.",
      "Treating auction close as a simple `UPDATE ... WHERE end_time<=now()` cron with no CAS claim — two closer replicas, or a retry after a crash, can double-close and double-charge.",
      "Pushing every single bid to every watcher over WebSocket with no throttling — a 10K-watcher hot item during a sniping burst becomes hundreds of thousands of messages per second.",
      "No anti-sniping mechanism at all, or a vague 'we'll extend the timer' with no window size or cap, inviting the obvious 'what stops it from never closing?' follow-up.",
      "Charging the winner's payment method synchronously inside the same call path that closes the auction — a slow payment gateway now blocks every other auction closing on that worker.",
      "No reserve-price handling — treating every closed auction as a completed sale even when the highest bid never met the seller's reserve.",
    ],
    followUps: [
      {
        q: "Why optimistic concurrency instead of a lock for bid writes?",
        a: "A per-item lock adds a network round trip to the hottest possible row and can expire mid-write under a GC pause or network blip, letting two writers both believe they hold it. CAS via a version column needs no lock service at all, and only genuinely contended items pay a retry, while the vast majority of auctions with no active contention write in one shot at full speed.",
      },
      {
        q: "What happens when two 'Auction Closer' workers race to close the same auction?",
        a: "The CLOSING transition itself is CAS-guarded: UPDATE auctions SET status='CLOSING' WHERE id=? AND status='OPEN' AND end_time<=now(). Only one worker's UPDATE affects a row and proceeds to determine the winner and start settlement; the other worker's UPDATE affects zero rows and it simply moves on. It's the same pattern as the bid write, applied to the status column instead of the price.",
      },
      {
        q: "How do you guarantee the winner is never double-charged even if settlement crashes mid-payment?",
        a: "The payment capture call carries an idempotency key derived from auction_id. The payment provider (or an internal idempotency table keyed on that value) guarantees a retried request with the same key returns the original result instead of creating a second charge. Combined with the CAS-guarded CLOSING claim, 'exactly once' holds at both the state-transition layer and the money-movement layer, and each layer is protecting against a different failure mode.",
      },
      {
        q: "What if the reserve price isn't met?",
        a: "The item still closes at end_time (or once the anti-sniping extensions stop firing), but the Closer marks status=UNSOLD instead of SOLD when current_price < reserve_price. No payment capture runs, the seller is notified the item didn't sell, and a common product extension is to let the seller relist or offer the second-highest bidder a second-chance purchase outside the normal auction flow.",
      },
      {
        q: "How do you stop the anti-sniping extension from letting an auction run forever?",
        a: "Cap it two ways: cap the number of extensions (e.g., max 10) or cap total extension time (e.g., no more than +30 minutes past the original end_time). Because an extension only fires when a new bid lands inside the window, the auction converges the moment bidders go quiet — the cap is just the guaranteed upper bound you quote when asked 'what if it never ends?'",
      },
      {
        q: "How does the WebSocket layer handle a single item with 10,000 watchers?",
        a: "That item's watcher connections are spread across many WebSocket gateway pods rather than pinned to one process, fed by a Kafka topic keyed on item_id. Instead of pushing on every bid, the gateway throttles outbound broadcasts to roughly once per second per item, always carrying the latest price — so a 50-bids-in-10-seconds sniping burst produces about 10 messages per watcher instead of 50, and the design still meets the sub-1s notification budget.",
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
          "This is a contested single-row write path (an item's current price), wrapped by a scheduled exactly-once state transition (closing the auction), plus a real-time fan-out side channel (outbid notifications). Each of those three needs a different correctness tool, and naming that split is the fastest way to signal you understand the shape of the problem.",
          "Anchor everything on the peak-vs-average gap: ~580 bids/sec average but ~20,000 bids/sec peak, a ~35x burst driven by end-time clustering plus last-second sniping. Every structural choice below exists to survive that peak, not the average.",
        ],
      },
      {
        heading: "Sizing and the average-vs-peak gap",
        body: [
          "10M live auctions generate ~50M bids/day, which is only ~580 bids/sec if spread evenly — but bids aren't spread evenly. Auctions cluster around common end times, and within any single auction, a large share of its bids land in the final seconds as bidders wait to snipe. The two effects compound into a ~35x peak-to-average ratio, which is the number that sizes DB shard count, cache capacity, and the fan-out layer.",
        ],
      },
      {
        heading: "Serializing bids without a lock",
        body: [
          "A distributed lock on the hottest row adds latency and risks a stale lock mid-write; a naive read-then-write UPDATE risks a silent lost update when two bidders race. Optimistic concurrency control resolves both: UPDATE auctions SET current_price=?, version=version+1 WHERE auction_id=? AND version=?. The losing writer gets zero rows affected, re-reads the fresh price, and retries — no lock is ever held, and uncontested items pay no extra cost.",
          "Proxy bidding rides on top of this same CAS write: a bidder's private max is stored, and every challenge auto-raises the current leader to just past the challenger, capped at the leader's max, all resolved atomically inside the write that accepts the challenge.",
        ],
      },
      {
        heading: "Soft close and exactly-once settlement",
        body: [
          "A fixed deadline rewards last-second timing over genuine valuation, so any bid inside a closing window (e.g., the last 5 minutes) extends end_time by that window, capped by a max extension count so the worst case is bounded and quotable.",
          "Closing is modeled as a state machine, OPEN -> CLOSING -> CLOSED/UNSOLD -> SETTLED, and the OPEN -> CLOSING transition is itself a CAS claim: only one worker's UPDATE can win it, which is what makes 'exactly once' true at the structural level. Payment capture then carries an idempotency key derived from auction_id, protecting the money-movement step specifically, with a saga pattern handling compensation if payment ultimately declines.",
        ],
      },
      {
        heading: "Real-time fan-out and the hot-item herd",
        body: [
          "Pushing a WebSocket message per bid doesn't survive a hot item: 10K watchers times 50 bids in a 10-second sniping burst is 500K messages/sec from one auction. The fix is to throttle broadcasts to roughly once per second per item, always carrying the latest price, and to distribute that item's watcher connections across a fleet of WebSocket gateway pods via a Kafka topic keyed on item_id, so no single process ever holds all of one item's connections.",
        ],
      },
      {
        heading: "SLA tiers and what ties it together",
        body: [
          "Bid writes are tier-1 for correctness — a bid must never be silently lost. Close and settlement are tier-1 for correctness (exactly-once) but not latency-critical. Notifications are tier-2, throttled, and best-effort within the 1-second budget. That explicit hierarchy is what justifies every trade-off in the design: why the read path can be cache-served and slightly stale, why the write path pays for CAS retries instead of a lock, and why the notification layer is allowed to coalesce rather than stream every single bid.",
        ],
      },
    ],
  },
};
