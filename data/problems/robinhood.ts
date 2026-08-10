import type { Problem } from "@/lib/types";

export const robinhood: Problem = {
  slug: "robinhood",
  num: "6.10",
  title: "Design Robinhood",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design Robinhood: a commission-free trading app with ~24M funded accounts and up to ~3M concurrent users during market hours, streaming real-time quotes for ~10K actively traded symbols, executing orders at a sustained 2K/sec (peaking past 50K/sec on a meme-stock day), while guaranteeing that cash and positions are always exactly correct — a user can never place a trade with money they don't have.",
  ],
  hardParts:
    "The hard parts: keeping the cash ledger exactly correct while orders and market-data prices race each other in real time, fanning out roughly a million price ticks a second to millions of phones without melting the backend, and staying correct (and up) when order volume spikes 25x in an afternoon, the way it did during GameStop in January 2021.",
  keyTopics: [
    "Ledger-First Consistency (ACID Buying Power)",
    "Symbol-Partitioned Market Data Fan-Out",
    "Idempotent Order Submission",
    "Order Routing & Payment for Order Flow (FIX)",
    "Backpressure Under Meme-Stock Load",
  ],
  foundationsReferenced: [
    { label: "CockroachDB / Distributed SQL", tone: "blue" },
    { label: "Kafka Partitioning", tone: "orange" },
    { label: "Idempotency Keys", tone: "green" },
    { label: "Pub/Sub Fan-Out", tone: "purple" },
    { label: "Optimistic Concurrency Control", tone: "blue" },
    { label: "Circuit Breakers", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Mobile / Web Client", col: 1, row: 1, tone: "slate" },
      { id: "wsgw", label: "WebSocket Gateway", sub: "~3M concurrent conns", col: 2, row: 1, tone: "green" },
      { id: "quotecache", label: "Quote Cache", sub: "Redis · latest tick/symbol", col: 3, row: 1, tone: "green" },
      { id: "mdkafka", label: "Market Data Bus", sub: "Kafka · symbol-partitioned", col: 4, row: 1, tone: "orange" },
      { id: "feedhandler", label: "Feed Handler", sub: "SIP + direct exchange feeds", col: 5, row: 1, tone: "orange" },

      { id: "oms", label: "Order Service (OMS)", sub: "stateless · validates", col: 2, row: 2, tone: "purple" },
      { id: "risk", label: "Risk / Buying Power", mono: "cash + margin check", col: 3, row: 2, tone: "purple" },
      { id: "ledger", label: "Ledger DB", sub: "CockroachDB · ACID", col: 4, row: 2, tone: "blue" },
      { id: "router", label: "Smart Order Router", mono: "FIX · price improvement", col: 5, row: 2, tone: "purple" },

      { id: "marketmaker", label: "Market Maker / Exchange", sub: "Citadel, Virtu, NYSE, Nasdaq", col: 5, row: 3, tone: "slate" },
      { id: "fillsvc", label: "Fill & Clearing Service", sub: "execution reports → ledger + portfolio", col: 3, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "wsgw", label: "subscribe symbols", kind: "read" },
      { from: "feedhandler", to: "mdkafka", label: "raw ticks · ~1M/s peak", kind: "read" },
      { from: "mdkafka", to: "wsgw", label: "live ticks · subscribed partitions", kind: "read" },
      { from: "mdkafka", to: "quotecache", label: "latest price update", kind: "read" },
      { from: "quotecache", to: "wsgw", label: "snapshot on reconnect", kind: "read" },
      { from: "wsgw", to: "client", label: "delta ticks, throttled ~1/s", kind: "read" },

      { from: "client", to: "oms", label: "submit order (idempotency key)", kind: "write" },
      { from: "oms", to: "risk", label: "buying power check", kind: "write" },
      { from: "risk", to: "ledger", label: "reserve cash · row lock", kind: "write" },
      { from: "ledger", to: "router", label: "reserved → route order", kind: "write" },
      { from: "router", to: "marketmaker", label: "FIX NewOrderSingle", kind: "write" },

      { from: "marketmaker", to: "fillsvc", label: "execution report (FIX)", kind: "analytics" },
      { from: "fillsvc", to: "ledger", label: "settle cash + position", kind: "analytics" },
      { from: "fillsvc", to: "wsgw", label: "order-status push", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · streaming market data, ~1000:1 vs. orders" },
      { kind: "write", text: "write path · order submission, 2K/s sustained" },
      { kind: "analytics", text: "async · execution reports, settlement, never blocks an order ack" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["client", "oms", "ledger"],
      say: "Start with the order skeleton: client submits, the Order Service validates, and every buying-power check reads and writes the ledger directly — no cache ever sits in this loop, because a stale balance is a double-spend waiting to happen.",
    },
    {
      reveal: ["risk", "router", "marketmaker"],
      say: "Add the gate and the exit door: Risk reserves cash inside the same ACID transaction as the ledger, and only after that reservation commits does the Smart Order Router speak FIX to a market maker — nothing routes on an unreserved order.",
    },
    {
      reveal: ["fillsvc"],
      say: "Close the loop: execution reports stream back from the market maker into a Fill & Clearing service that settles cash and position into that same ledger, asynchronously, without ever blocking the order ack.",
    },
    {
      reveal: ["feedhandler", "mdkafka"],
      say: "Now the other half of the app entirely: a feed handler ingests roughly a million exchange ticks a second and publishes them onto a Kafka bus partitioned by symbol, so each symbol stays ordered while the fan-out scales horizontally.",
    },
    {
      reveal: ["wsgw", "quotecache"],
      say: "A WebSocket gateway subscribes straight to the partitions its connected clients hold for the live stream, falls back to a Redis snapshot only when a client (re)connects, and throttles every symbol to about one update a second before it ever reaches a phone.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Submit market and limit orders (buy/sell) for equities, with real-time acknowledgment", tag: "P0" },
      { id: "FR-02", text: "Stream real-time quotes (bid/ask/last trade) for symbols a user is watching or holding", tag: "P0" },
      { id: "FR-03", text: "Maintain an authoritative cash balance and position ledger; check buying power before every order", tag: "P0" },
      { id: "FR-04", text: "Route orders to market makers/exchanges and process execution reports (fills, partial fills, cancels)", tag: "P0" },
      { id: "FR-05", text: "Portfolio view: current holdings, average cost, unrealized P&L, updated near-real-time", tag: "P0" },
      { id: "FR-06", text: "Cancel or replace an order before it executes", tag: "P0" },
      { id: "FR-07", text: "Fractional share trading (e.g. buy $10 of a $3,000 stock)", tag: "P1" },
      { id: "FR-08", text: "Instant buying power from unsettled funds (margin-backed instant deposits)", tag: "P1" },
      { id: "FR-09", text: "Respect trading halts and volatility circuit breakers pushed from the exchange", tag: "P1" },
      { id: "FR-10", text: "Order history and year-end tax document generation from settled trades", tag: "P2" },
      { id: "FR-11", text: "Push notifications for price alerts and order fills", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Order acknowledgment latency, submit to ack", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "Market data delivery latency, exchange tick to client", tag: "p99 < 250ms" },
      { id: "NFR-03", text: "Ledger correctness: no account is ever allowed to overdraw its buying power", tag: "zero overdraft" },
      { id: "NFR-04", text: "Order submission throughput, sustained (peak on a volatile day)", tag: "2K/s (50K/s peak)" },
      { id: "NFR-05", text: "WebSocket fan-out concurrency during market hours", tag: "3M concurrent" },
      { id: "NFR-06", text: "Availability during market hours (9:30am–4pm ET)", tag: "99.99%" },
      { id: "NFR-07", text: "Durability of trade and ledger records", tag: "zero loss" },
      { id: "NFR-08", text: "Read-to-write ratio (quote reads vs. order writes) that anchors the design", tag: "1000:1" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: two very different traffic shapes",
      body: [
        "Robinhood is really two systems glued together: a read-heavy market-data firehose and a write-critical, low-volume ledger. Market data is enormous and disposable — a missed tick two seconds ago doesn't matter, only the latest price does. Orders are tiny in volume but zero tolerance for error — a lost or double-counted order is a real customer's money.",
        "At ~24M funded accounts and ~3M concurrent sessions during market hours, the feed handler ingests on the order of 1M ticks/sec at peak volatility across ~10K actively traded symbols, while the order path runs a sustained 2K orders/sec with headroom to absorb a 25x spike (50K/sec) on a day like GameStop, January 2021. Those two numbers — 1M/sec disposable reads vs. 2K/sec durable writes — are why the architecture forks into a caching/fan-out half and an ACID-ledger half that barely touch.",
      ],
      bullets: [
        { lead: "Market data", text: "~1M ticks/sec ingested, fanned out to ~3M sockets, each client watching a handful of symbols. Losing a stale tick is fine; the next one supersedes it." },
        { lead: "Orders", text: "~2K/sec sustained, but every single one must debit the right amount from the right account exactly once. Losing or duplicating one is a compliance incident." },
        { lead: "Ratio", text: "roughly 1000:1 reads to writes, which is why quotes get a cache-heavy, eventually-consistent path and orders get a small, strongly-consistent one." },
      ],
      pictureTitle: "Two systems, two consistency models",
      pictureCaption: "market data: eventually consistent, cache-first · ledger: strongly consistent, cache-never",
      pictureRows: [
        { label: "Market data (~1M ticks/s)", value: "eventually consistent, stale-is-fine", tone: "good" },
        { label: "Orders (~2K/s, 50K/s peak)", value: "strongly consistent, zero tolerance", tone: "neutral" },
      ],
      remember: {
        problem: "One app, two traffic shapes with opposite consistency needs.",
        solution: "Fork the architecture: cache-heavy pub/sub for market data, ACID ledger for orders and cash.",
        why: "A stale quote is harmless; a wrong cash balance is a regulatory and customer-trust failure.",
        tradeoff: "More operational surface (two very different subsystems) in exchange for not forcing one consistency model onto both.",
        failure: "Treating quotes and money the same way either makes the ledger too slow (waiting on cache invalidation) or the quote path too fragile (ACID writes on every tick).",
        mitigation: "Keep the ledger small and boring (row-level ACID transactions only); keep market data disposable and cache-first.",
      },
    },
    {
      n: 2,
      title: "The ledger is the whole game: buying power without overdrafts",
      body: [
        "The single hardest correctness requirement is: a user can never submit an order that costs more than their available buying power, even if they tap 'Buy' from two devices at once, or their app retries a flaky request. This is a classic double-spend problem, and it is solved the same way a bank solves it — not with a cache, with a database transaction.",
        "Every order first does a conditional debit against the ledger: read the account's available buying power, and in the same ACID transaction, reserve the order's cost (row lock or compare-and-swap on a version column). If two concurrent orders would jointly overdraw the account, the database itself rejects the second one — the check and the reservation happen atomically, so there is no window where two requests both read 'sufficient funds' and both proceed.",
      ],
      bullets: [
        { lead: "Why not a cache", text: "a cached balance can be stale by the time you act on it — exactly the double-spend gap a bank cannot tolerate. The ledger is read and written inside one transaction, never served from Redis." },
        { lead: "Row-level locking / OCC", text: "CockroachDB (or Postgres with SERIALIZABLE isolation) enforces that concurrent reservations on the same account serialize; the loser gets a retryable conflict, not a silent overdraft." },
        { lead: "Idempotency key", text: "every order submission carries a client-generated UUID. If the mobile app retries after a timeout, the ledger recognizes the key and returns the original result instead of debiting twice." },
        { lead: "Two-phase commit of the order lifecycle", text: "reserve cash on submit, then either release the reservation (cancel) or convert it into an actual debit (fill). The reservation never silently disappears." },
      ],
      pictureTitle: "Two taps, two devices, one account",
      pictureRows: [
        { label: "No transaction", value: "both reads see 'funds OK' → double-spend", tone: "bad" },
        { label: "ACID reserve-then-fill", value: "second request serializes, sees reserved funds, rejects", tone: "good" },
        { label: "Retry with idempotency key", value: "second submit returns first result, no double debit", tone: "good" },
      ],
      remember: {
        problem: "Guarantee an account can never overdraw its buying power, even under concurrent or retried requests.",
        solution: "ACID reserve-then-fill transaction against a strongly consistent ledger, keyed by a client-supplied idempotency key.",
        why: "Check-and-reserve must be atomic; a cached balance always has a stale-read window a double-spend can exploit.",
        tradeoff: "Every order pays a synchronous DB round trip instead of a cache hit — acceptable because order volume (2K/s) is three orders of magnitude below quote volume.",
        failure: "A separate check-then-write (read balance, then write debit) leaves a race window two concurrent orders can both slip through.",
        mitigation: "Single atomic reserve-then-fill transaction, idempotency keys on submission, and reconciliation jobs that catch anything that still slips through.",
      },
    },
    {
      n: 3,
      title: "Market data fan-out: from the exchange tape to 3M phones",
      body: [
        "The exchanges (via the SIP — Securities Information Processor — consolidated tape, plus direct exchange feeds for lower latency) produce on the order of a million price updates a second across all US-listed symbols at peak volatility. No client needs all of that; each phone cares about a handful of symbols it holds or watches. The job is to go from a firehose to a filtered trickle per user, fast.",
        "A feed handler normalizes exchange messages and publishes them onto a Kafka topic partitioned by symbol, so a given symbol's updates always land on the same partition and stay ordered. A quote cache (Redis) holds the latest tick per symbol for anyone connecting fresh. WebSocket gateway pods subscribe to just the symbol partitions their connected clients care about, and — critically — throttle: even if AAPL ticks 50 times a second, a phone gets at most ~1 update/sec, because a human eye and a battery can't use more than that.",
      ],
      bullets: [
        { lead: "Symbol partitioning", text: "keeps per-symbol ordering (last trade must never appear to move backward) while letting the fan-out scale horizontally across gateway pods." },
        { lead: "Client-side throttling", text: "coalesce N ticks into the latest value and push at ~1Hz per symbol per client — this alone cuts fan-out bandwidth by 10-50x during a volatile symbol's burst." },
        { lead: "Delta over full state", text: "push only the fields that changed (last price, bid/ask) rather than a full quote object, shrinking the message and the mobile radio wake-up cost." },
        { lead: "Reconnect from cache, not from Kafka", text: "a freshly (re)connected client reads the current snapshot from Redis, then subscribes forward — it never has to replay history to catch up." },
      ],
      pictureTitle: "Firehose to trickle",
      pictureRows: [
        { label: "Exchange tape (~1M ticks/s)", value: "raw, unfiltered, all symbols", tone: "bad" },
        { label: "Kafka, symbol-partitioned", value: "ordered per symbol, horizontally scaled", tone: "neutral" },
        { label: "WebSocket gateway, throttled ~1Hz", value: "per-client, per-symbol, only what changed", tone: "good" },
      ],
      remember: {
        problem: "Fan out ~1M ticks/sec to ~3M sockets without melting the backend or the client.",
        solution: "Symbol-partitioned Kafka → Redis snapshot cache → WebSocket gateway that throttles to ~1 update/sec/symbol/client.",
        why: "Clients cannot use, and shouldn't pay the battery cost for, every raw tick — only the latest value matters.",
        tradeoff: "Throttling means a client's chart can lag the true tape by up to a second; acceptable for a retail trading app, not for an HFT firm.",
        failure: "Pushing every raw tick to every subscribed client on a hot symbol (e.g. a meme stock) saturates gateway bandwidth and drains mobile batteries.",
        mitigation: "Coalesce-and-throttle at the gateway, delta-only payloads, and snapshot-from-cache on reconnect instead of replay.",
      },
    },
    {
      n: 4,
      title: "Order routing: Robinhood isn't an exchange",
      body: [
        "Robinhood doesn't match buyers and sellers itself — it's a broker-dealer that routes orders to market makers (wholesalers like Citadel Securities and Virtu) or directly to exchanges (NYSE, Nasdaq) under SEC Rule 606 order-routing disclosure rules. This is the payment-for-order-flow model: market makers pay for the flow and, in exchange, are required to give the customer a price at or better than the National Best Bid and Offer (NBBO).",
        "The Smart Order Router picks a destination per order (based on historical execution quality and price improvement), speaks FIX (Financial Information eXchange) protocol to send a NewOrderSingle, and the market maker returns an execution report — filled, partially filled, or rejected. Partial fills are common on large orders and must be handled as a stream of fill events against the same order id, not a single terminal state.",
      ],
      bullets: [
        { lead: "Not an internal matching engine", text: "unlike a stock exchange, there's no order book to match against in-house; the router's job is picking the best external destination, not matching trades." },
        { lead: "FIX protocol", text: "the industry-standard wire format for order messages; NewOrderSingle to submit, ExecutionReport for every state change (new, partial fill, fill, cancel, reject)." },
        { lead: "Price improvement", text: "market makers are required to fill at or better than NBBO; the router logs the improvement for Rule 606 disclosure reporting." },
        { lead: "Partial fills", text: "a 1,000-share order might fill as five separate execution reports; the OMS accumulates them against the order id and only marks it 'filled' when the cumulative quantity matches." },
      ],
      pictureTitle: "Order lifecycle, one order id, many events",
      pictureRows: [
        { label: "NEW", value: "order accepted, cash reserved", tone: "neutral" },
        { label: "PARTIALLY_FILLED ×N", value: "cumulative quantity tracked against the reservation", tone: "used" },
        { label: "FILLED", value: "cumulative qty = order qty, reservation converts to debit", tone: "good" },
        { label: "REJECTED / CANCELED", value: "reservation released back to buying power", tone: "bad" },
      ],
      remember: {
        problem: "Get a retail order executed without running an in-house matching engine.",
        solution: "A Smart Order Router speaks FIX to external market makers/exchanges and reconciles a stream of execution reports back to one order id.",
        why: "Payment-for-order-flow economics mean wholesalers compete for retail flow and are obligated to match or beat NBBO — cheaper than building an exchange.",
        tradeoff: "You depend on a third party's fill quality and uptime; a market maker outage or slow ack becomes your order-ack latency.",
        failure: "Treating a partial fill as a terminal state loses track of remaining quantity and can double-reserve or under-settle cash.",
        mitigation: "Model fills as an append-only stream against the order id; only close the order when cumulative filled quantity reconciles.",
      },
    },
    {
      n: 5,
      title: "The meme-stock spike: circuit breakers and clearinghouse capital",
      body: [
        "In January 2021, GameStop trading volume through Robinhood spiked roughly 25x overnight, and the company famously restricted buying in a handful of volatile names. The technical reason wasn't just server load — it was that the clearinghouse (NSCC, National Securities Clearing Corporation) requires brokers to post collateral proportional to the risk of trades not yet settled, and that deposit requirement spiked with volatility and volume far faster than cash on hand could cover. It's a genuine systems lesson: a downstream financial dependency can force a kill switch even when your servers are healthy.",
        "Independent of that specific historical event, any trading platform needs circuit breakers at multiple layers: rate-limiting a single account's order rate, halting a symbol the exchange itself has halted, and a global kill switch the ops team can throw if the order-to-fill pipeline backs up. The design goal is graceful degradation — market data keeps flowing (read-only is safe) even if order submission is throttled or paused.",
      ],
      bullets: [
        { lead: "Traffic circuit breaker", text: "per-account and global rate limits on order submission, shedding load before the OMS or ledger saturates, with market data unaffected." },
        { lead: "Exchange-driven halts", text: "when an exchange halts a symbol (LULD — limit up/limit down — or a news pause), that halt event flows through the same market-data bus and the OMS rejects new orders on that symbol immediately." },
        { lead: "Downstream capital constraint", text: "settlement/clearing obligations (T+1 today, was T+2 before 2024) can force a broker to restrict trading in high-volatility names even with healthy infrastructure — a business-level circuit breaker, not just a technical one." },
        { lead: "Backpressure, not silent drops", text: "when the order pipeline is overloaded, reject new submissions with a clear error rather than silently queuing them past their useful window — a stale market order is a wrong order." },
      ],
      pictureTitle: "A 25x spike hits three different limits",
      pictureRows: [
        { label: "Infra: order pipeline load", value: "rate-limit + shed, market data stays up", tone: "neutral" },
        { label: "Exchange: symbol halted", value: "reject new orders on that symbol immediately", tone: "neutral" },
        { label: "Clearing: NSCC capital deposit", value: "can force trading restrictions independent of server health", tone: "bad" },
      ],
      remember: {
        problem: "Stay correct and available when order volume spikes 25x in hours.",
        solution: "Layered circuit breakers: per-account rate limits, exchange-halt propagation, and awareness that clearing capital requirements are a real, non-technical limit.",
        why: "A trading platform's true capacity ceiling isn't only CPU/DB throughput — it includes a regulated capital requirement downstream.",
        tradeoff: "Aggressive backpressure means some users see rejected orders during a spike instead of a queued-and-delayed one — the right tradeoff for a market order.",
        failure: "Queuing orders past their price-relevant window and executing them late is arguably worse than rejecting them outright.",
        mitigation: "Reject fast with a clear error, keep market data (read-only) flowing throughout, and treat clearing capital as a named constraint in capacity planning.",
      },
    },
    {
      n: 6,
      title: "Portfolio view: fast and approximate vs. the ledger's exact truth",
      body: [
        "The portfolio screen (holdings, cost basis, live P&L) needs to feel instantaneous as prices move, but it is not the source of truth — the ledger is. The portfolio service recomputes market value by combining the ledger's exact position quantities with the live quote cache's latest prices, and caches that combined view for fast reads. This is an eventually-consistent read model built on top of a strongly-consistent write model, the same split as the market-data-vs-orders divide in teardown 1, applied one layer up.",
        "Settlement adds another wrinkle: a filled trade debits/credits the ledger immediately for buying-power purposes, but cash doesn't actually move between the broker and the clearinghouse until T+1. The portfolio view has to show 'settled' vs. 'pending settlement' cash separately, or users get confused about why their buying power doesn't match their bank-transferable cash.",
      ],
      bullets: [
        { lead: "Portfolio value = ledger positions × cache prices", text: "recomputed on read (or streamed and cached), never stored as the source of truth — it's derived, so it can never drift the ledger out of correctness." },
        { lead: "Reconciliation job", text: "periodically recomputes portfolio value straight from the ledger and live quotes and diffs it against the cached view, alerting on drift beyond a tolerance." },
        { lead: "Settled vs. unsettled cash", text: "the ledger tracks both; buying power can include unsettled funds (with margin backing) while withdrawable cash cannot, until T+1 settlement completes." },
        { lead: "Cache invalidation is cheap here", text: "unlike the ledger, a stale portfolio value for a few hundred milliseconds is a UX nit, not a compliance issue — so it's fine to cache aggressively." },
      ],
      pictureTitle: "Two numbers that look the same but aren't",
      pictureRows: [
        { label: "Buying power", value: "includes reserved + some unsettled funds", tone: "used" },
        { label: "Withdrawable cash", value: "only fully settled (T+1) funds", tone: "neutral" },
        { label: "Portfolio market value", value: "derived, cached, refreshed on every tick", tone: "good" },
      ],
      remember: {
        problem: "Show a live-feeling portfolio without making the ledger itself fast-but-fuzzy.",
        solution: "Derive portfolio value on read from ledger positions × cached live prices; keep it a read model, never the source of truth.",
        why: "Separating the exact write model (ledger) from the fast read model (portfolio cache) lets each be optimized for its own job.",
        tradeoff: "Users can see a portfolio value that's a few hundred ms stale relative to the true tape — acceptable, unlike a stale cash balance.",
        failure: "Conflating buying power (can include unsettled funds) with withdrawable cash (settled only) confuses users and can look like a bug.",
        mitigation: "Track settled vs. unsettled cash explicitly in the ledger, and run reconciliation jobs that diff the cached portfolio view against ledger truth.",
      },
    },
    {
      n: 7,
      title: "Idempotency end to end: mobile networks retry, the ledger must not care",
      body: [
        "Mobile clients live on flaky networks: a request can time out on the client side after the server already processed it. If 'Buy 10 shares' is retried naively, that's a double order. The fix has to span the whole path, not just the database — the client must generate the idempotency key once (a UUID at 'tap'), and every hop downstream must key its work off that same id.",
      ],
      bullets: [
        { lead: "Client-generated key", text: "created once when the user taps Buy, sent with every retry of the same logical request, so the server can recognize a retry versus a new order." },
        { lead: "OMS dedupe", text: "the order service upserts on the idempotency key; a retry with the same key returns the original order's current state instead of creating a second one." },
        { lead: "Ledger reservation keyed the same way", text: "the cash reservation is tied to the order id, so even a retried reservation call is a no-op if one already exists for that key." },
        { lead: "Downstream FIX calls too", text: "the router uses the order id as the FIX ClOrdID (client order id) so a retried route to the market maker is recognized as the same order, not a duplicate submission." },
      ],
      pictureTitle: "One tap, one order, however many retries",
      pictureRows: [
        { label: "No idempotency key", value: "network retry → duplicate order → double debit", tone: "bad" },
        { label: "Idempotency key, OMS only", value: "dedupes the order, but router could still double-route", tone: "neutral" },
        { label: "Idempotency key end-to-end", value: "OMS, ledger, and FIX ClOrdID all key off the same id", tone: "good" },
      ],
      remember: {
        problem: "Flaky mobile networks retry requests; retries must never become duplicate orders.",
        solution: "One client-generated idempotency key per logical order, propagated and deduplicated at every hop: OMS, ledger reservation, and FIX ClOrdID.",
        why: "A single-hop fix (just dedupe at the DB) still leaves duplicate work upstream or downstream of that hop.",
        tradeoff: "Every service in the chain has to thread and honor the same key, which is extra plumbing versus trusting each call to be idempotent by luck.",
        failure: "Deduping only at the OMS but not at the FIX gateway can still send two NewOrderSingle messages to the market maker for one user intent.",
        mitigation: "Propagate the same id as the FIX ClOrdID so the market maker's own dedupe logic also catches a duplicate route.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's two systems wearing one app: a disposable, cache-heavy market-data firehose (~1M ticks/sec) and a tiny, zero-tolerance ACID ledger (~2K orders/sec).",
      "Buying power is enforced with an atomic reserve-then-fill transaction against the ledger, never a cache — that's the one rule that can't bend.",
      "Market data fans out through symbol-partitioned Kafka into a Redis snapshot, and the WebSocket gateway throttles to ~1 update/sec/symbol/client so a hot stock doesn't drown 3M phones.",
      "Robinhood doesn't match trades itself — a Smart Order Router sends FIX orders to market makers (Citadel, Virtu) or exchanges and reconciles a stream of partial-fill execution reports.",
      "The real capacity ceiling on a meme-stock day isn't just servers — clearinghouse (NSCC) capital deposit requirements can force trading restrictions independent of infrastructure health.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · ~1M TICKS/S IN, ~3M SOCKETS OUT",
        summary:
          "Exchange ticks land on a symbol-partitioned bus, get cached as the latest snapshot, and the WebSocket gateway throttles the fan-out so no client (or its battery) drowns.",
        steps: [
          { label: "Feed Handler", note: "SIP + direct exchange feeds" },
          { label: "Market Data Bus (Kafka)", note: "symbol-partitioned; gateway pods subscribe directly to the relevant partitions" },
          { label: "Quote Cache (Redis)", note: "latest snapshot, read only by a pod on a client's (re)connect" },
          { label: "WebSocket Gateway", note: "throttled ~1 update/s/symbol/client" },
          { label: "Client", note: "delta-only payload, subscribed symbols only" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · 2K/S SUSTAINED, 50K/S PEAK",
        summary:
          "An order reserves cash atomically before it's allowed to route anywhere, and the idempotency key travels all the way to the market maker so a retry can never become a duplicate.",
        steps: [
          { label: "Client", note: "generates idempotency key at tap" },
          { label: "Order Service (OMS)", note: "validates, dedupes on key" },
          { label: "Risk / Buying Power", note: "reserve check" },
          { label: "Ledger DB", note: "ACID reserve-then-fill transaction" },
          { label: "Smart Order Router", note: "FIX NewOrderSingle, key = ClOrdID" },
          { label: "Market Maker / Exchange", note: "fills at or better than NBBO" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · EXECUTION, SETTLEMENT, NEVER BLOCKS AN ACK",
        summary:
          "Fills stream back as a series of execution reports, get reconciled against the reserved cash, and settle into the ledger — separately from the fast order-ack path.",
        steps: [
          { label: "Market Maker", note: "execution report (FIX), possibly partial" },
          { label: "Fill & Clearing Service", note: "accumulates fills against order id" },
          { label: "Ledger DB", note: "converts reservation into settled debit/credit" },
          { label: "WebSocket Gateway", note: "pushes order-status update to client" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "~24M funded accounts, ~3M concurrent during market hours",
          "Market data: ~1M ticks/sec peak across ~10K actively traded symbols",
          "Orders: 2K/sec sustained, up to ~50K/sec on a 25x volatility spike",
          "Order ack p99 < 200ms; market data delivery p99 < 250ms",
          "Read:write ratio ≈ 1000:1 (quote reads vs. order writes)",
          "WebSocket throttle: ~1 update/sec/symbol/client regardless of tick rate",
          "Settlement: T+1 for cash movement, distinct from instant buying-power reservation",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Ledger is ACID (CockroachDB/Postgres), never served from a cache",
          "Reserve-then-fill transaction for buying power, not check-then-write",
          "Idempotency key propagated end-to-end: OMS → ledger → FIX ClOrdID",
          "Kafka partitioned by symbol for market data; Redis holds latest snapshot",
          "No in-house matching engine — Smart Order Router sends FIX to market makers",
          "Portfolio view is a derived, cached read model, not the source of truth",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Double-spend prevention via atomic reserve-then-fill is the load-bearing correctness guarantee",
          "Clearinghouse (NSCC) capital requirements are a real, non-technical capacity ceiling",
          "Settled vs. unsettled cash must be shown separately, or buying power looks 'wrong' to users",
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
      goal: "Split the problem into its two traffic shapes out loud before drawing anything: market data (huge, disposable) and orders (tiny, zero-tolerance).",
      why: "The interviewer wants to see you recognize this is two systems, not one, before you commit to an architecture. Getting this split right in the first five minutes shapes every later decision — cache strategy for quotes, ACID strategy for the ledger.",
      steps: [
        { kind: "ASK", text: '**"How many users, and what\'s the read:write ratio?"** Land on "~24M funded accounts, ~3M concurrent during market hours" and "market data massively dominates orders, roughly 1000:1". Write **"3M concurrent, 1000:1 read:write"** on the board.' },
        { kind: "SAY", text: 'Name the two traffic shapes yourself: **"Market data is huge and disposable — a stale tick from a second ago doesn\'t matter. Orders are tiny in volume but zero-tolerance — a lost or duplicated order is real money."** This framing is the spine of the whole design.' },
        { kind: "ASK", text: '**"Do we build our own matching engine, or route out to market makers?"** Confirm: **"Robinhood is a broker-dealer, not an exchange — orders route out via FIX to market makers/exchanges."** Write it down; it rules out designing an in-house order book.' },
        { kind: "SAY", text: 'State scope. In: "order submission and ledger", "market data streaming", "portfolio view", "order routing". Out: "options chains", "crypto", "margin interest calculation", "tax reporting internals". "Flag if you want me to come back to any of those."' },
        { kind: "WRITE", text: 'Write the two latency budgets: **"order ack p99 < 200ms"**, **"market data p99 < 250ms"**. These anchor the write path vs. the read/fan-out path differently.' },
      ],
      grading: "Do they explicitly name the two-traffic-shape split before drawing boxes, and do the scale numbers end up written on the board?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Define the order endpoint with an idempotency key, and sketch the ledger row that makes buying power checks atomic.",
      why: "This is where a candidate either shows they understand the double-spend problem or doesn't. Bringing the idempotency key and the reserve-then-fill model forward, unprompted, is a strong senior signal.",
      steps: [
        { kind: "WRITE", text: 'Write the core endpoint: **"POST /orders { symbol, side, qty, type, idempotencyKey }"** returns **"{ orderId, status }"**. Say: "The idempotency key is generated client-side once, at the tap — every retry reuses it."' },
        { kind: "DRAW", text: 'Sketch the ledger row: **"account_id"**, **"cash_balance"**, **"reserved_cash"**, **"settled_cash"**, **"version (for OCC)"**. Say: "Reserved and settled are tracked separately so buying power and withdrawable cash never get conflated."' },
        { kind: "SAY", text: 'Walk the state machine out loud: **"NEW → reserve cash → PARTIALLY_FILLED (0..N times) → FILLED (reservation converts to debit) or CANCELED/REJECTED (reservation released)."**' },
        { kind: "RULE OUT", text: 'Get ahead of it: "A check-then-write — read balance, then write debit as two steps — leaves a race window two concurrent orders can both pass through. It has to be one atomic transaction." Cross off check-then-write.' },
      ],
      grading: "Idempotency key present in the API from the start, and the ledger row separating reserved vs. settled cash without being prompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram, three lanes: market-data read path, order write path, and async execution/settlement — each with its own consistency story.",
      why: "Drawing these as three separate lanes proves the candidate understands they have different SLAs and different correctness requirements, not just different code paths.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read/market-data lane**: Feed Handler → Kafka (symbol-partitioned). From Kafka, two paths converge on the client: the WebSocket Gateway subscribes directly to the partitions its connected clients hold for the live stream, and a Redis quote cache serves only the snapshot on (re)connect. Both land on WebSocket Gateway → Client. Label arrows **"~1M ticks/s"**, **"throttled ~1/s per symbol"**.' },
        { kind: "DRAW", text: 'Add the **write/order lane**: Client → OMS → Risk/Buying-Power → Ledger DB → Smart Order Router → Market Maker. Label **"2K/s sustained · ACID reserve-then-fill"**, **"FIX NewOrderSingle, only after the reservation commits"**.' },
        { kind: "DRAW", text: 'Add the **async lane**: Market Maker → Fill & Clearing Service → Ledger (settle) and → WebSocket Gateway (push order-status). Label **"execution reports, partial fills"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they have three different correctness stories — market data is eventually consistent and cache-first, orders are strongly consistent and ACID, and settlement is async but still exactly-once via the idempotency key."' },
      ],
      grading: "Three clearly separated lanes, correct direction of data flow, and an explicit statement of why each lane has a different consistency model.",
    },
    {
      n: 4,
      title: "Deep Dive: Buying Power and the Ledger",
      minutes: 8,
      goal: "Defend the reserve-then-fill transaction and the end-to-end idempotency key as the mechanism that prevents double-spend.",
      why: "This is the signature sub-problem. The interviewer is probing whether the candidate can name the double-spend race precisely and close it with an atomic transaction, not hand-wave 'we use a database'.",
      steps: [
        { kind: "SAY", text: 'State the race precisely: "Two concurrent order submissions both read \'sufficient funds\' before either writes — that\'s the double-spend window. It has to close inside one atomic transaction, not across two separate calls."' },
        { kind: "DRAW", text: 'Draw the reserve-then-fill transaction: read available buying power, reserve order cost, commit — all in one ACID transaction with row-level locking or optimistic concurrency (version column / CAS).' },
        { kind: "SAY", text: 'Explain the idempotency key propagation: "The same key that dedupes at the OMS is reused as the ledger reservation key and the FIX ClOrdID sent to the market maker, so a retry at any layer is recognized, not re-executed."' },
        { kind: "RULE OUT", text: '"A cached balance is always stale by some window — that window is exactly the double-spend gap. The ledger has to be read and written in the same transaction, never served from Redis for this check."' },
      ],
      grading: "Names the double-spend race precisely, draws the atomic reserve-then-fill transaction, and explains idempotency-key propagation end-to-end without prompting.",
    },
    {
      n: 5,
      title: "Deep Dive: Market Data Fan-Out and the Meme-Stock Spike",
      minutes: 7,
      goal: "Walk the fan-out path with real throttling numbers, then volunteer what actually caps capacity on a volatility spike — including the non-technical clearing constraint.",
      why: "Anyone can say 'add a WebSocket layer'. The top signal is naming that raw exchange tick rate must be throttled before it reaches a phone, and that the real ceiling on a 25x spike day includes clearinghouse capital, not just server capacity.",
      steps: [
        { kind: "SAY", text: 'Walk the fan-out with numbers: "Feed handler ingests ~1M ticks/sec, Kafka partitions by symbol to keep ordering, Redis holds the latest snapshot, and the gateway throttles to about 1 update/sec/symbol/client — a 50x-in-one-second tick burst on a hot stock still leaves each phone with one update."' },
        { kind: "SAY", text: 'Volunteer the historical case: "In January 2021, GameStop volume spiked roughly 25x, and Robinhood restricted buying in a few names — not purely a server-capacity issue but an NSCC clearinghouse capital deposit requirement that spikes with volatility. It\'s worth naming that a broker\'s real ceiling includes a regulated capital constraint, not just CPU."' },
        { kind: "SAY", text: 'Handle infra-level backpressure: "Per-account and global rate limits shed order-submission load before the OMS or ledger saturate; market data stays flowing throughout because it\'s read-only and cache-served."' },
        { kind: "SAY", text: 'Close with the principle: "Reject fast with a clear error under overload rather than queue-and-delay a market order — a late market order is arguably a wrong order."' },
      ],
      grading: "Concrete throttling numbers volunteered, the clearing-capital constraint named unprompted, and a clear reject-fast-over-queue stance on order backpressure.",
    },
    {
      n: 6,
      title: "Wrap: Consistency Boundaries and Close",
      minutes: 5,
      goal: "Restate the two-system boundary, name the portfolio view as a derived read model, and close with a crisp one-sentence summary plus a parked-items list.",
      why: "Staff-level signal here is drawing a clean line between what must be exact (ledger) and what can be fast-and-approximate (everything else), and treating the interview's remaining time as a resource to allocate deliberately.",
      steps: [
        { kind: "SAY", text: 'Restate the boundary: "Only the ledger — cash and positions — needs to be strongly consistent. Market data and the portfolio view are both derived, cached, and allowed to be a few hundred milliseconds stale."' },
        { kind: "SAY", text: 'Name the settled-vs-unsettled distinction unprompted: "Buying power can include unsettled funds; withdrawable cash can\'t, until T+1 settlement. Showing these as one number is a real source of user confusion, worth calling out."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need sub-250ms market data for every symbol, or just the ones a user is actively viewing versus just holding? That changes fan-out cost a lot." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s two systems sharing one app — a disposable market-data fan-out and a small, zero-tolerance ACID ledger, joined by order routing over FIX. With more time I\'d cover margin risk limits, options chains, and the tax-lot accounting for cost basis."' },
      ],
      grading: "Explicit consistency-boundary restatement, the settled/unsettled distinction volunteered, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design with the right named components, but the ledger correctness argument and the fan-out math stay hand-wavy.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, order service, database, cache, WebSocket for live prices.",
          "Knows there needs to be a 'buying power check' before an order goes through.",
          "Picks a database for the ledger and a cache for quotes without being prompted.",
          "Draws a queue (Kafka) somewhere in the market-data path.",
          "Can name that orders go to an exchange or market maker, even if fuzzy on the mechanism.",
        ],
        gaps: [
          "Doesn't precisely name the double-spend race (two concurrent orders both reading 'sufficient funds').",
          "Proposes checking the cache for buying power, or a check-then-write pattern, without seeing the race window.",
          "No idempotency-key story for retried order submissions.",
          "Fan-out is 'push every tick to every client' with no throttling or delta-only design.",
          "Doesn't distinguish settled vs. unsettled cash, or buying power vs. withdrawable balance.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, gets the ledger's atomic reserve-then-fill transaction right, and quantifies fan-out throttling when pushed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes the scale split (1000:1 read:write, 2K orders/sec, 1M ticks/sec) on the board within the first five minutes.",
          "Names the double-spend race precisely and closes it with an atomic reserve-then-fill transaction.",
          "Proposes an idempotency key at the API layer and at the ledger.",
          "Designs symbol-partitioned Kafka plus a Redis snapshot for market data.",
          "Explains that Robinhood routes orders via FIX to market makers rather than matching internally.",
          "Distinguishes settled vs. unsettled cash when asked directly.",
          "Proposes rate limiting/circuit breakers on the order path under load.",
        ],
        gaps: [
          "Volunteers the client-throttling number (~1 update/sec/symbol) only after being asked how fan-out scales.",
          "Doesn't propagate the idempotency key past the OMS (misses the FIX ClOrdID hop) unless prompted.",
          "Doesn't bring up the clearinghouse capital constraint as a real capacity ceiling unless the interviewer mentions GameStop.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, names the two-consistency-model architecture as the organizing idea before being asked, and surfaces the non-technical capacity constraint unprompted.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "States the two-traffic-shape framing (disposable market data vs. zero-tolerance ledger) as the very first architectural decision, before drawing a single box.",
          "Propagates the idempotency key across all three hops unprompted: OMS dedupe, ledger reservation, FIX ClOrdID.",
          "Volunteers the clearinghouse capital constraint (NSCC deposit requirements) as a real, non-technical ceiling on order capacity, with the GameStop 2021 case as evidence.",
          "Explicitly separates settled vs. unsettled cash and buying power vs. withdrawable balance as a named source of user confusion to design around.",
          "Quantifies the fan-out throttling (~1M ticks/s in, ~1Hz per client out) and explains why that ratio is the right one for a retail app, not an HFT system.",
          "Pushes back on scope ('per-symbol vs. per-viewed-symbol freshness') to control the interview's time budget.",
          "Closes with a one-sentence summary and a deliberately chosen parked-items list (margin, options, tax lots).",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Checking buying power against a cached balance instead of inside the same transaction as the reservation — this is the double-spend bug.",
      "No idempotency key on order submission, so a mobile network retry can create a duplicate order.",
      "Designing an in-house matching engine when the real system routes orders out to market makers/exchanges via FIX.",
      "Pushing every raw exchange tick to every subscribed client with no throttling — a hot symbol saturates the gateway and the client's battery.",
      "Treating the portfolio view's cached market value as a source of truth instead of a derived, recomputable read model.",
      "No distinction between settled and unsettled cash, so buying power and withdrawable balance are conflated.",
      "Assuming infrastructure capacity is the only ceiling during a volume spike, missing that clearing/capital requirements are a real, separate constraint.",
    ],
    followUps: [
      {
        q: "Why can't the buying power check just read from a fast cache like Redis?",
        a: "Because a cached balance is stale by definition — there's always a window between when it was last written and when you read it, and that window is exactly where a double-spend race lives. Two concurrent order submissions could both read 'sufficient funds' from the cache and both proceed, together overdrawing the account. The check has to happen inside the same atomic transaction as the reservation against the ledger, so the database itself serializes the two requests and only one wins.",
      },
      {
        q: "How would you scale the WebSocket layer to 3M concurrent connections?",
        a: "Horizontally: many stateless gateway pods, each holding a subset of connections, subscribing to only the Kafka symbol-partitions its connected clients actually watch — not the whole firehose. Sticky routing (consistent hashing on connection id) at the load balancer keeps a client on the same pod for its session. The real lever is the per-client throttle (~1 update/sec/symbol) — it caps outbound bandwidth per connection regardless of how volatile the underlying symbol is, which is what actually makes 3M connections tractable rather than raw connection count.",
      },
      {
        q: "What happens if the market data feed handler falls behind or the exchange feed drops?",
        a: "Market data is read-only and disposable, so the fallback is graceful: clients keep showing the last known price from the Redis snapshot cache, ideally flagged as stale in the UI, and the feed handler catches up from the exchange's backfill/snapshot mechanism (many feeds support a resync). Critically, this must never block order submission — the OMS can still accept orders (though a market order without a fresh quote is a legitimate reason to require a limit price or briefly pause market orders on affected symbols).",
      },
      {
        q: "How do partial fills interact with the buying-power reservation?",
        a: "The initial reservation covers the full order quantity at submission. As execution reports stream in with partial fills, the Fill & Clearing Service accumulates them against the order id; each partial fill converts its slice of the reservation into a settled debit at the actual fill price (which may differ slightly from the reserved estimate due to price improvement). If the fill price is better than reserved, the difference is released back to buying power; if the order is canceled with quantity remaining, the unfilled portion's reservation is released. The reservation and the accumulating fills are reconciled against the same order id so nothing double-counts.",
      },
      {
        q: "Why does Robinhood route orders to market makers instead of running its own exchange?",
        a: "Running an exchange means building and regulating a full matching engine, membership, and market-making liquidity — enormous regulatory and capital overhead. Instead, wholesale market makers like Citadel Securities and Virtu compete for retail order flow (payment for order flow) and are obligated under SEC rules to fill at or better than the National Best Bid and Offer. This is cheaper and faster to build, offloads market-making risk to specialists, and Rule 606 requires disclosing routing practices and execution quality, which keeps the incentive aligned with getting customers good prices.",
      },
      {
        q: "What actually happened with GameStop trading restrictions in January 2021, from a systems perspective?",
        a: "Trading volume in a handful of names spiked roughly 25x almost overnight. The proximate technical cause of the restrictions wasn't server capacity — it was that the clearinghouse (NSCC) requires brokers to post collateral sized to the risk of trades not yet settled (at the time T+2), and that deposit requirement scales sharply with volatility and volume. The deposit call came in far larger and faster than available cash on hand could cover, forcing a temporary restriction on opening new positions in those names until capital could be raised. It's a useful systems lesson: capacity planning for a regulated financial system has to include downstream capital/clearing constraints, not just compute and database throughput.",
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
          "Robinhood is two systems sharing one app: a huge, disposable market-data fan-out and a tiny, zero-tolerance cash ledger. Almost every hard design decision falls out of picking the right consistency model for each half and keeping them from contaminating each other — the ledger never gets served from a cache, and market data never pays for an ACID transaction.",
          "Anchor everything on the scale split: ~24M funded accounts, ~3M concurrent sessions in market hours, ~1M ticks/sec of market data at peak, and ~2K orders/sec sustained (up to ~50K/sec on a volatile day). The 1000:1 ratio between quote reads and order writes is why the architecture forks the way it does.",
        ],
      },
      {
        heading: "The ledger: the one place correctness cannot bend",
        body: [
          "Buying power must be checked and reserved atomically, in one transaction against the source of truth — never a cache — because a cached read always has a stale window a concurrent order can exploit. A reserve-then-fill transaction (read available funds, reserve the order's cost, commit) closes that window; CockroachDB or Postgres with row-level locking or optimistic concurrency (a version column / compare-and-swap) enforces that two concurrent reservations against the same account serialize rather than race.",
          "Idempotency has to travel the whole path, not just the database: a client-generated key is created once at submission, deduplicated at the order service, reused as the ledger's reservation key, and reused again as the FIX ClOrdID sent to the market maker — so a retry at any hop is recognized as the same logical order instead of a new one.",
        ],
      },
      {
        heading: "Market data: firehose to trickle",
        body: [
          "The feed handler normalizes exchange messages (from the SIP consolidated tape and/or direct exchange feeds) and publishes onto Kafka partitioned by symbol, preserving per-symbol ordering while scaling horizontally. WebSocket gateway pods are themselves Kafka consumers, subscribing only to the partitions their connected clients actually hold, so the live stream never has to detour through a cache. A Redis quote cache holds the latest tick per symbol purely for fresh-connection snapshots — a client reads the current value once on (re)connect, then subscribes forward.",
          "The unlock is throttling at the WebSocket gateway: even if a symbol ticks 50 times a second, a client gets at most about one update a second, and only the fields that changed. That single design choice is what makes fanning out to millions of sockets tractable — it caps outbound load per connection independent of how volatile the underlying symbol gets.",
        ],
      },
      {
        heading: "Order routing without an in-house exchange",
        body: [
          "Robinhood is a broker-dealer, not an exchange — it doesn't match buy and sell orders itself. A Smart Order Router picks a destination (a wholesale market maker like Citadel Securities or Virtu, or an exchange directly) and speaks FIX protocol: NewOrderSingle to submit, a stream of ExecutionReport messages back for new/partial-fill/fill/cancel/reject.",
          "Market makers are obligated to fill at or better than the National Best Bid and Offer under the payment-for-order-flow model, disclosed under SEC Rule 606. Partial fills are modeled as an append-only stream against one order id, accumulated until the filled quantity reconciles with the order quantity — treating a partial fill as terminal is a common and costly modeling mistake.",
        ],
      },
      {
        heading: "Capacity limits that aren't purely technical",
        body: [
          "A trading platform's real capacity ceiling includes more than servers and databases. Order-pipeline circuit breakers (per-account and global rate limits) shed load before the OMS or ledger saturate, while market data — being read-only and cache-served — keeps flowing throughout. Exchange-driven halts (LULD pauses, news halts) propagate through the same market-data bus and block new orders on that symbol immediately.",
          "The January 2021 GameStop event is the canonical case study for a constraint beyond infrastructure: a roughly 25x volume spike triggered a clearinghouse (NSCC) capital deposit requirement that scaled with volatility and outpaced available cash, forcing temporary trading restrictions independent of server health. Good capacity planning for a regulated financial system names that constraint explicitly rather than assuming compute and database throughput are the only limits.",
        ],
      },
      {
        heading: "Portfolio: a derived view, never the source of truth",
        body: [
          "The portfolio screen combines the ledger's exact position quantities with the quote cache's latest prices, recomputed on read (or streamed and cached) — an eventually-consistent read model layered on top of the strongly-consistent ledger. Because it's derived, it can be cached aggressively; being a few hundred milliseconds stale is a UX nit, not a correctness bug, and a reconciliation job periodically diffs the cached view against ledger truth to catch drift.",
          "Settlement timing adds a distinction worth surfacing on its own: a fill debits the ledger immediately for buying-power purposes, but cash doesn't actually move until T+1. Showing settled cash, unsettled cash, and buying power as one blended number is a common source of user confusion — the ledger tracks them separately, and the UI should too.",
        ],
      },
    ],
  },
};
