import type { Problem } from "@/lib/types";

export const adExchangeRtb: Problem = {
  slug: "ad-exchange-rtb",
  num: "2.5",
  title: "Design an Ad Exchange / RTB Platform",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a real-time ad exchange (RTB platform) that ingests 3M bid requests/sec from publishers, fans each one out to a filtered set of demand-side platforms (DSPs) in parallel, runs a first-price auction, and returns a winning ad within a ~100ms end-to-end budget — while pacing every campaign's spend smoothly across the day and never losing a billable impression event.",
  ],
  hardParts:
    "The hard parts: fanning out to hundreds of DSPs and closing the auction within a hard ~100ms budget no matter who is slow, pacing campaign spend smoothly across a day without a global lock on every single bid, and keeping billing events lossless while everything else on the hot path is allowed to degrade.",
  keyTopics: [
    "Timeout-Bounded Parallel Fanout",
    "First-Price Auction & Bid Shading",
    "Probabilistic Budget Pacing",
    "Approximate Frequency Capping",
    "Async Billing Pipeline (Zero Loss)",
  ],
  foundationsReferenced: [
    { label: "Consistent Hashing", tone: "green" },
    { label: "Redis / Aerospike", tone: "purple" },
    { label: "Kafka & Stream Processing", tone: "orange" },
    { label: "Token Bucket Rate Limiting", tone: "blue" },
    { label: "Bloom Filters / HyperLogLog", tone: "green" },
    { label: "CAP Theorem Trade-offs", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "publisher", label: "Publisher / SSP", sub: "ad slot loads", col: 1, row: 1, tone: "slate" },
      {
        id: "gateway",
        label: "Bid Gateway",
        sub: "OpenRTB 2.6 · tmax ~100ms",
        mono: "parse + validate request",
        col: 2,
        row: 1,
        tone: "green",
      },
      {
        id: "profile",
        label: "User Profile Store",
        sub: "Aerospike · <1ms",
        mono: "cookie/device ID → segments",
        col: 2,
        row: 2,
        tone: "purple",
      },
      {
        id: "fanout",
        label: "DSP Fanout",
        sub: "~150 DSPs, filtered",
        mono: "filter: budget, category, fill history",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "dsps", label: "DSP Bidders", sub: "100s external · ~80ms SLA", col: 4, row: 1, tone: "blue" },
      {
        id: "auction",
        label: "Auction Engine",
        sub: "1st-price · floor · fraud filter",
        mono: "highest valid bid wins",
        col: 3,
        row: 2,
        tone: "orange",
      },
      { id: "pacer", label: "Budget Pacer", sub: "token bucket per campaign", col: 4, row: 2, tone: "purple" },
      { id: "adserver", label: "Winning Creative", sub: "markup / VAST tag", col: 2, row: 3, tone: "green" },
      { id: "kafka", label: "Kafka", sub: "win + impression + click events", col: 3, row: 3, tone: "orange" },
      { id: "flink", label: "Flink", sub: "real-time spend aggregation", col: 4, row: 3, tone: "orange" },
      { id: "billing", label: "Billing Warehouse", sub: "ClickHouse · zero loss", col: 5, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "publisher", to: "gateway", label: "bid request", kind: "read" },
      { from: "gateway", to: "profile", label: "enrich · <1ms", kind: "read" },
      { from: "gateway", to: "fanout", label: "eligible slot", kind: "read" },
      { from: "fanout", to: "dsps", label: "parallel · ~80ms timeout", kind: "read" },
      { from: "dsps", to: "auction", label: "bid responses", kind: "read" },
      { from: "auction", to: "pacer", label: "reserve budget token", kind: "write" },
      { from: "auction", to: "adserver", label: "winning bid → creative", kind: "write" },
      { from: "adserver", to: "publisher", label: "render ad", kind: "write" },
      { from: "adserver", to: "kafka", label: "win + impression, async", kind: "analytics" },
      { from: "kafka", to: "flink", kind: "analytics" },
      { from: "flink", to: "billing", label: "billing records, zero loss", kind: "analytics" },
      { from: "flink", to: "pacer", label: "spend feedback · <1min", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "bid path · 3M requests/sec, ~100ms budget" },
      { kind: "write", text: "auction outcome · budget reserve + creative render" },
      { kind: "analytics", text: "async billing & pacing feedback, never blocks the auction" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Publishers submit bid requests via OpenRTB containing ad slot, page context, and user identifiers", tag: "P0" },
      { id: "FR-02", text: "Exchange broadcasts each bid request to a filtered set of eligible DSPs in parallel", tag: "P0" },
      { id: "FR-03", text: "Run a first-price auction among valid bids above the publisher's floor price", tag: "P0" },
      { id: "FR-04", text: "Return the winning ad markup / VAST tag to the publisher for rendering", tag: "P0" },
      { id: "FR-05", text: "Pace each campaign's budget smoothly across the day, not front-loaded or exhausted early", tag: "P0" },
      { id: "FR-06", text: "Frequency capping: limit impressions per user per campaign per time window", tag: "P1" },
      { id: "FR-07", text: "Brand-safety and invalid-traffic (fraud) filtering before a bid request reaches auction", tag: "P0" },
      { id: "FR-08", text: "Cookie/device ID matching and user segment lookup for targeting", tag: "P1" },
      { id: "FR-09", text: "Win notification and impression/click tracking, reconciled against confirmed renders", tag: "P0" },
      { id: "FR-10", text: "Reporting dashboard: spend, CPM, win rate per campaign", tag: "P1" },
      { id: "FR-11", text: "Support deal IDs / private marketplace (PMP) direct deals that bypass the open auction", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "DSP round-trip deadline enforced by the exchange", tag: "p99 < 80ms" },
      { id: "NFR-02", text: "End-to-end bid handling, gateway in to ad response out", tag: "p99 < 100ms" },
      { id: "NFR-03", text: "Peak sustained bid-request throughput", tag: "3M/sec" },
      { id: "NFR-04", text: "Exchange availability", tag: "99.99%" },
      { id: "NFR-05", text: "Daily budget pacing accuracy (spend vs. target)", tag: "±5%" },
      { id: "NFR-06", text: "Impression and billing event durability", tag: "zero loss" },
      { id: "NFR-07", text: "Bid-to-win ratio, the number that anchors fanout and infra cost", tag: "100:1" },
      { id: "NFR-08", text: "Feedback loop freshness: spend data to pacing throttle", tag: "< 1 min" },
      { id: "NFR-09", text: "DSP timeout compliance: late bids counted toward the auction", tag: "0%" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why the timeout budget is the whole design",
      body: [
        "An ad slot loads on a publisher's page, the page's ad stack calls the exchange, and the exchange has to decide and answer before the page (or the header-bidding waterfall) moves on. That deadline is not a nicety — a publisher's OpenRTB request carries a tmax field, a hard number of milliseconds, and if the exchange answers even one millisecond late, the whole bid is simply discarded and a fallback ad or the next exchange in line wins the slot instead.",
        "At 3M bid requests/sec, filtering matters as much as speed. Blasting every request to a directory of thousands of DSPs unfiltered would be technically free to send, but every additional DSP in the fanout raises the tail latency of the slowest responder, and the auction can only wait for the slowest bidder it chooses to wait for. So the exchange pre-filters to roughly 100-150 DSPs likely to bid on a given slot before it ever opens a connection.",
      ],
      bullets: [
        { lead: "Why not 500ms", text: "users perceive page lag past roughly 100-300ms, so publishers set tmax in the low hundreds of milliseconds; the exchange's own OpenRTB round trip has to fit inside that, leaving well under 100ms for the exchange's own hop." },
        { lead: "tmax is a hard deadline", text: "not a target. Answering late doesn't mean a slow win, it means the publisher has already moved on and the bid counts for nothing." },
        { lead: "Fanout multiplies the cost", text: "sending to every DSP raises the odds one of them is slow, and one slow DSP can eat the whole exchange's latency budget if nothing bounds it." },
      ],
      pictureTitle: "Where does the 100ms go?",
      pictureRows: [
        { label: "Network + gateway parse", value: "~10-15ms", tone: "neutral" },
        { label: "DSP fanout + response window", value: "~80ms", tone: "good" },
        { label: "Auction + creative return", value: "~5-10ms", tone: "neutral" },
      ],
      remember: {
        problem: "Every bid request has a hard, publisher-set deadline (tmax) that the whole exchange must respect.",
        solution: "Budget the ~100ms end-to-end as fixed slices: parse, filtered fanout, auction, response — and enforce each slice.",
        why: "A late answer isn't slow, it's discarded — the publisher has already moved to the next bidder or a fallback ad.",
        tradeoff: "Filtering the DSP list to ~100-150 likely bidders trades a little bid coverage for a latency budget you can actually hit.",
        failure: "Fanning out to every DSP in the directory lets the slowest one set the pace for every auction.",
        mitigation: "Pre-filter fanout by historical fill rate, category match, and remaining budget before opening any connections.",
      },
    },
    {
      n: 2,
      title: "Auction design: first-price vs second-price",
      body: [
        "Second-price (Vickrey) auctions were the programmatic default for years: the winner pays the second-highest bid plus a cent, which is theoretically incentive-compatible — bidders can safely bid their true value. That theory holds for a single, isolated auction. It broke down once header bidding put the same impression up for auction in several exchanges simultaneously: a DSP no longer knew if it was really in a second-price auction or effectively competing first-price against the winning bid from another exchange, so DSPs started guessing the clearing price and shading their bids down defensively.",
        "The industry response, led by Google Ad Manager's 2019 switch, was to move to first-price auctions: highest bid wins and pays exactly what it bid. It's simpler and transparent, but it pushes the bid-shading problem onto the DSP — now the DSP has to predict the true clearing price itself to avoid overpaying, using its own historical win-rate models.",
      ],
      bullets: [
        { lead: "Second-price (Vickrey)", text: "elegant for one isolated auction, but multiple concurrent auctions for the same impression (header bidding) forced blind bid-shading. Displaced." },
        { lead: "First-price", text: "highest bid wins and pays what it bid — transparent, simple to explain to publishers, but shifts the shading problem to the DSP side. Industry standard today." },
        { lead: "Floor price", text: "still applies under either model: the publisher sets a minimum acceptable bid per slot, and anything below it is excluded from the auction before winner selection." },
      ],
      pictureTitle: "First-price vs second-price",
      pictureRows: [
        { label: "Second-price, single exchange", value: "incentive-compatible in isolation", tone: "neutral" },
        { label: "Second-price, header bidding", value: "blind bid-shading, gameable → displaced", tone: "bad" },
        { label: "First-price", value: "transparent, DSP owns the shading → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Pick an auction mechanism that stays fair once the same impression is up for auction in several places at once.",
        solution: "First-price: highest valid bid above the floor wins and pays exactly what it bid.",
        why: "Second-price's incentive-compatibility only holds for one isolated auction; header bidding broke that assumption.",
        tradeoff: "First-price pushes the clearing-price prediction problem onto DSPs instead of the exchange.",
        failure: "Staying on second-price under header bidding causes systemic blind bid-shading and unpredictable clearing prices.",
        mitigation: "Apply the publisher's floor price uniformly, then let the highest valid bid win outright.",
      },
    },
    {
      n: 3,
      title: "Timeout-bounded fanout: the real hard part",
      body: [
        "The exchange can never wait for the slowest DSP — it sets a hard per-DSP timeout (~80ms), collects whatever bids landed by that deadline, and finalizes the auction with exactly those. A DSP that misses the window gets zero weight in that auction, not a late answer counted afterward; the deadline is propagated with the fanout call itself so every in-flight request is cancelled the instant tmax passes, not caught and discarded after the fact.",
        "Protecting the budget for everyone else means treating DSP health as a first-class signal, not an afterthought. A rolling p95 response time and timeout rate per DSP feeds a health score; DSPs that fall below a threshold get deprioritized or dropped from fanout entirely, the same idea as a circuit breaker, so one chronically slow bidder can't degrade tail latency for the whole exchange.",
      ],
      bullets: [
        { lead: "Hard deadline propagation", text: "the fanout call carries a shared deadline (like a context with a timeout) so every outstanding DSP request is cancelled the moment tmax passes, freeing the connection immediately." },
        { lead: "DSP health scoring", text: "rolling p95 latency and timeout rate per DSP feed a score; chronically slow DSPs get fewer or zero bid requests, a circuit breaker at the fanout layer." },
        { lead: "Bulkheading", text: "the fanout worker pool and connection pool are sized so a single stalled DSP connection can't monopolize threads or exhaust the pool for everyone else." },
      ],
      pictureTitle: "How a slow DSP gets contained",
      pictureRows: [
        { label: "DSP answers within 80ms", value: "bid counted in the auction", tone: "good" },
        { label: "DSP answers late", value: "discarded, zero weight, deadline already cancelled the call", tone: "bad" },
        { label: "DSP chronically slow (health score)", value: "dropped from future fanout lists", tone: "neutral" },
      ],
      remember: {
        problem: "One slow DSP shouldn't be able to blow the latency budget for the whole auction, or degrade the whole exchange over time.",
        solution: "Hard per-DSP deadline propagated with the call, plus a rolling health score that drops chronically slow DSPs from fanout.",
        why: "Waiting for the slowest bidder makes every publisher pay for one bad actor's latency; a deadline plus a circuit breaker bounds the damage to one request and then to future requests.",
        tradeoff: "Some DSPs occasionally lose a winnable bid to a transient blip; that's cheaper than degrading every auction's tail latency.",
        failure: "Treating tmax as a soft target lets one struggling DSP set the pace for millions of concurrent auctions.",
        mitigation: "Cancel on deadline, not on completion; feed timeout rate into a per-DSP health score that gates future fanout.",
      },
    },
    {
      n: 4,
      title: "Real-time budget pacing without a global lock",
      body: [
        "A campaign's budget is spread across a day or a month, and unthrottled spend is lumpy: popular hours can burn a whole day's budget by 9am, or unpredictable bid volume can leave money unspent. Before or during each auction, the exchange has to decide how aggressively a campaign should participate given how much of its budget is already spent versus how much of the period has elapsed — and it has to make that decision in microseconds, for millions of concurrent bids, without a global lock.",
        "The mechanism is a token bucket per campaign, refilled at a smooth target rate, where each bid participation consumes a token. As spend approaches the target, participation becomes probabilistic (sampled) rather than a hard cutoff, which smooths delivery across the full day instead of the campaign running hot then going dark.",
      ],
      bullets: [
        { lead: "Naive hard cutoff", text: "shutting a campaign off entirely at 100% spend produces lumpy delivery — it runs full-tilt all morning, exhausts budget, then goes completely dark for the rest of the day. Rejected." },
        { lead: "Token bucket per campaign", text: "budget refills at a smooth target rate (e.g. an hourly allocation); each bid participation spends a token, and as the bucket empties the campaign's participation probability tapers instead of hard-stopping." },
        { lead: "No global synchronous counter", text: "a strongly consistent cross-node counter on every single bid is too slow at this cardinality; local, regional counters are aggregated on a short interval instead, trading perfect accuracy for the required speed." },
      ],
      pictureTitle: "Hard cutoff vs. probabilistic pacing",
      pictureRows: [
        { label: "Hard cutoff at 100% spend", value: "runs hot, then dark → rejected", tone: "bad" },
        { label: "Token bucket, smooth refill", value: "tapers participation, spreads spend → WINNER", tone: "good" },
        { label: "Global synchronous counter", value: "too slow at this cardinality → rejected", tone: "bad" },
      ],
      remember: {
        problem: "Spend a campaign's budget evenly across the day without a global lock on every bid.",
        solution: "A per-campaign token bucket refilled at a smooth rate; participation becomes probabilistic as the bucket empties.",
        why: "Hard cutoffs cause lumpy delivery; probabilistic throttling based on spend-vs-target ratio smooths it without synchronous coordination.",
        tradeoff: "Regional, periodically-reconciled counters accept a small over/underspend (±5%) for the speed a global lock can't give you.",
        failure: "A synchronous global counter on every bid can't hit microsecond decision latency at millions of bids/sec.",
        mitigation: "Aggregate regional spend into a global view every < 1 min and adjust each campaign's token refill rate from that feedback loop.",
      },
    },
    {
      n: 5,
      title: "Frequency capping and the user profile store",
      body: [
        "Limiting how many times a single user sees the same ad in a period needs a counter keyed by user and campaign, at a cardinality of billions of users times millions of campaigns, checked inside a sub-millisecond slice of the 100ms budget. An exactly-consistent global counter is the wrong tool here — the cost of coordinating it across regions for every single impression check would blow the latency budget on its own.",
        "The practical answer is regional, approximate, TTL-windowed counters living in an in-memory store like Aerospike or Redis. A cap like 'three per user per day' becomes a key with a 24-hour TTL, incremented atomically within a region; a user might occasionally see one extra impression due to cross-region skew, and that's an accepted cost for staying inside the budget.",
      ],
      bullets: [
        { lead: "Exact global counter", text: "consistent counting across every region on every impression would need cross-region coordination per event — far too slow for a sub-millisecond lookup inside a 100ms budget. Rejected." },
        { lead: "Regional approximate counters", text: "each region keeps its own counter with periodic async reconciliation; occasional over-delivery by one impression is an acceptable trade for speed." },
        { lead: "TTL-windowed keys", text: "a cap window like '3 per user per day' is just a key with a 24h TTL, incremented in-region — no cross-region query needed on the hot path." },
      ],
      pictureTitle: "Frequency cap: exact vs. approximate",
      pictureRows: [
        { label: "Exact, globally consistent", value: "cross-region coordination per impression → rejected", tone: "bad" },
        { label: "Regional, TTL-windowed, approximate", value: "sub-ms, occasional +1 over-delivery → WINNER", tone: "good" },
      ],
      remember: {
        problem: "Enforce a per-user impression cap at billions of users with a sub-millisecond lookup budget.",
        solution: "Regional, TTL-windowed counters in Aerospike/Redis, reconciled across regions asynchronously.",
        why: "Exact cross-region consistency at this cardinality and latency budget is not achievable; approximate counting is the honest trade.",
        tradeoff: "A user can occasionally see one extra impression due to cross-region skew before reconciliation catches up.",
        failure: "A strongly consistent global counter would add cross-region round trips to every single bid evaluation.",
        mitigation: "Keep caps regional and TTL-based; treat small over-delivery as an accepted cost, not a bug to chase to zero.",
      },
    },
    {
      n: 6,
      title: "Fraud and brand-safety filtering off the hot-path clock",
      body: [
        "Filtering bot and invalid traffic (IVT), verifying a publisher through ads.txt/sellers.json, and enforcing brand-safety domain blocklists all have to happen — but none of it can add a synchronous external call to a request already spending its budget in single-digit milliseconds per hop. The fix is to move the expensive part offline: domains and apps get a reputation score computed in batch from historical traffic patterns and IVT models, and the inline check becomes a cache lookup against that precomputed score, not a live model inference.",
        "Anything that would require a synchronous external call — a live fraud-model API, a real-time sellers.json fetch — is disqualified from the bid path outright. It either runs as an offline pre-filter that updates a cache, or as a post-hoc audit that adjusts future scores and claws back bad spend after the fact.",
      ],
      bullets: [
        { lead: "Precomputed reputation score", text: "domains and apps are scored in batch using historical traffic and IVT detection models; the inline check is a cache lookup, not model inference." },
        { lead: "Cached ads.txt / sellers.json verification", text: "the authorized reseller chain is validated periodically and cached, not re-fetched on every bid." },
        { lead: "Only cheap inline checks make the cut", text: "anything needing a synchronous external call is moved to an offline pre-filter or a post-hoc audit instead of the bid path." },
      ],
      pictureTitle: "What runs inline vs. offline",
      pictureRows: [
        { label: "Cached reputation score lookup", value: "inline, sub-ms", tone: "good" },
        { label: "Cached ads.txt/sellers.json check", value: "inline, sub-ms", tone: "good" },
        { label: "Live fraud model / external API call", value: "never inline → offline or post-hoc audit", tone: "bad" },
      ],
      remember: {
        problem: "Run fraud and brand-safety checks without adding synchronous latency to the bid-response clock.",
        solution: "Precompute reputation and reseller-chain checks in batch; the inline path is only a cache lookup.",
        why: "Anything requiring a live external call can't fit inside a budget already spent in single-digit milliseconds per hop.",
        tradeoff: "Newly bad domains take up to a batch cycle to get caught, instead of being blocked on their very first bid.",
        failure: "Wiring a live fraud API or model call into the bid path adds unpredictable latency and risks blowing tmax entirely.",
        mitigation: "Treat anything synchronous-and-external as disqualified from the hot path; audit and claw back after the fact instead.",
      },
    },
    {
      n: 7,
      title: "Billing pipeline: the one place zero loss is non-negotiable",
      body: [
        "Everything else on this system's side channel — pacing telemetry, dashboards — can tolerate a dropped event; billing cannot, because a dropped billing event is money, not a stale chart. So while the win/impression event still travels asynchronously off the bid-response path, its delivery mechanism is different: at-least-once, acknowledged writes into Kafka, not a bounded buffer that silently drops on overflow.",
        "There's also a real gap between winning and billing: a DSP wins the auction, but it's only billed once the ad actually renders, confirmed by a separate impression pixel or beacon — typical render rates run 90-95%, so the win-to-render gap is unbilled inventory that has to be tracked, not assumed away. Flink aggregates win, impression, and click events into ClickHouse plus a ledger table, and discrepancies between win notices and confirmed impressions get reconciled and reported rather than silently dropped.",
      ],
      bullets: [
        { lead: "Fire-and-forget is fine for telemetry, wrong for billing", text: "the win/impression write uses at-least-once delivery with acks (dedup happens downstream), never a droppable buffer, because a lost event is unbilled or unpaid revenue." },
        { lead: "Win notice vs. rendered impression", text: "a DSP is only charged when the impression actually renders, confirmed separately from the auction win — typical render rate is ~90-95%." },
        { lead: "Reconciliation, not silence", text: "discrepancies between win notices and confirmed impressions are aggregated and surfaced by the pipeline, not dropped like a best-effort click event would be." },
      ],
      pictureTitle: "Best-effort telemetry vs. billing",
      pictureRows: [
        { label: "Pacing/telemetry events", value: "best-effort, droppable on overflow", tone: "neutral" },
        { label: "Win/impression billing events", value: "at-least-once, acknowledged, zero loss", tone: "good" },
        { label: "Win notice ≠ billed impression", value: "gap tracked via render confirmation, ~90-95%", tone: "used" },
      ],
      remember: {
        problem: "Run async analytics off the hot path without ever losing a billable event.",
        solution: "Split the async pipeline by tier: droppable buffers for telemetry, at-least-once acknowledged writes for billing.",
        why: "A dropped billing event is real revenue loss; a dropped telemetry event is just a slightly stale dashboard.",
        tradeoff: "The billing path costs more (acks, retries, reconciliation) than the best-effort telemetry path, deliberately.",
        failure: "Treating a win notice as a billed impression overcharges for ads that never actually rendered.",
        mitigation: "Bill only on confirmed render, and reconcile win-vs-render discrepancies in the Flink → ClickHouse pipeline.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a timeout-bounded fanout auction: broadcast a bid request to a filtered set of DSPs, collect whatever bids land within ~100ms, and pick a winner — a DSP that misses the deadline gets zero weight, not a late answer.",
      "First-price auction, not second-price — the industry moved here in 2019 because header bidding made second-price gameable, and now DSPs do their own bid-shading instead.",
      "Budget pacing is probabilistic, not a hard on/off switch — a token bucket smooths each campaign's spend across the day instead of burning the whole budget by 9am.",
      "Fraud and brand-safety checks are precomputed and cached; nothing that needs a synchronous external call is allowed anywhere near the bid-response clock.",
      "Billing is the one place nothing is best-effort: win/impression events use durable, acknowledged delivery, because a dropped event is money, not just a stale dashboard.",
    ],
    flows: [
      {
        kind: "read",
        title: "BID REQUEST & AUCTION · ~100MS BUDGET",
        summary: "A slot loads, the exchange enriches and fans the request out to a filtered DSP list in parallel, and the auction closes with whatever bids arrived before the deadline.",
        steps: [
          { label: "Publisher / SSP", note: "ad slot loads" },
          { label: "Bid Gateway", note: "OpenRTB parse, tmax read" },
          { label: "User Profile Store", note: "cookie/device → segments, <1ms" },
          { label: "DSP Fanout", note: "~150 filtered DSPs, parallel" },
          { label: "DSP Bidders", note: "hard ~80ms deadline" },
          { label: "Auction Engine", note: "1st-price, floor, fraud filter" },
        ],
      },
      {
        kind: "write",
        title: "WIN NOTICE & CREATIVE RENDER",
        summary: "The auction outcome reserves a pacing token, hands the winning bid to the ad server, and the publisher renders the creative — this is the state-changing outcome of the auction.",
        steps: [
          { label: "Auction Engine", note: "highest valid bid wins" },
          { label: "Budget Pacer", note: "reserve a spend token" },
          { label: "Winning Creative", note: "markup / VAST tag assembled" },
          { label: "Publisher", note: "renders the ad" },
        ],
      },
      {
        kind: "analytics",
        title: "PACING FEEDBACK LOOP & BILLING",
        summary: "Win, impression, and click events flow async into Kafka and Flink. Billing lands durably in the warehouse; spend aggregates feed back into the pacer so future auctions throttle correctly.",
        steps: [
          { label: "Ad server", note: "emits win + impression event" },
          { label: "Kafka", note: "at-least-once, acknowledged" },
          { label: "Flink", note: "real-time spend aggregation" },
          { label: "Billing Warehouse", note: "ClickHouse, zero loss, reconciled" },
          { label: "Budget Pacer", note: "spend feedback, < 1 min" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "3M bid requests/sec peak, fanned out to ~150 filtered DSPs each",
          "DSP round-trip deadline ~80ms; total exchange budget ~100ms",
          "Win rate ~1-2%, so bid-to-win ratio is roughly 100:1",
          "User profile lookups: <1ms from Aerospike, billions of device IDs",
          "Impression/billing events: zero loss, financial data",
          "Pacing feedback loop freshness: < 1 min from spend to throttle",
          "Render rate ~90-95%: the win-to-billed-impression gap",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "First-price auction, not second-price — avoids the bid-shading trap header bidding created",
          "Parallel fanout with a hard per-DSP deadline; late bids are dropped, never block the auction",
          "DSP health scoring — chronically slow DSPs get dropped from future fanout lists",
          "Aerospike/Redis for user profile + frequency caps — in-memory, TTL-based, regional and approximate",
          "Token-bucket budget pacing — probabilistic participation, not a hard on/off spend switch",
          "Fraud/brand-safety filtering precomputed and cached, never a synchronous inline lookup",
          "Kafka + Flink async pipeline, split by tier: droppable telemetry vs. acknowledged billing",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The 100ms budget is a hard constraint, not a target — a late DSP gets zero weight, not a slow answer",
          "First-price vs second-price and why bid shading killed second-price at scale",
          "Pacing must be probabilistic/smoothed, or budget exhausts by 9am and starves the rest of the day",
          "Billing needs zero loss and reconciliation; telemetry does not — say which is which",
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
      goal: "Get five numbers and the auction model on the board before drawing anything: QPS, the deadline, the pacing goal, and what's in vs. out of scope.",
      why: "Every later decision — fanout size, timeout, cache design for frequency capping — falls out of the deadline and QPS. Locking these first shows you drive the design from constraints, not guesses.",
      steps: [
        { kind: "ASK", text: '**"What is the bid-request deadline, tmax?"** Land on "~100ms end-to-end, ~80ms for DSPs to answer". Write **"3M req/s, ~100ms tmax"** in the corner.' },
        { kind: "ASK", text: 'Ask **"first-price or second-price auction?"** and **"how many DSPs are in the fanout?"**. Land on "first-price, ~150 filtered DSPs per request".' },
        { kind: "SAY", text: 'Propose the pacing goal yourself: **"campaign spend should track its daily target within about ±5%, smoothed across the day, not exhausted by 9am."** Wait for a nod.' },
        { kind: "SAY", text: 'State scope. In: "auction, fanout, pacing, frequency capping, fraud pre-filtering, billing". Out: "creative design tools, publisher-side ad server internals, DSP-side bidding strategy." "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the fanout math out loud: **"3M req/s × ~150 DSPs = ~450M DSP-side calls/sec system-wide"** — that\'s why fanout is filtered, not blasted at the whole DSP directory. Write it on the board.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, locking the deadline and auction model, and quantifying why fanout must be filtered before drawing a single box?",
    },
    {
      n: 2,
      title: "API and Auction Contract",
      minutes: 5,
      goal: "Nail the OpenRTB shape, the auction rule, and the floor price before anyone else brings up alternatives.",
      why: "The interviewer wants to see you commit to a tiny, real contract — OpenRTB's actual shape signals you've built or studied this, not guessed at a generic REST API.",
      steps: [
        { kind: "WRITE", text: 'Write the bid request shape: **"POST /bid { impId, tmax, floorPrice, userId(hashed), context }"**, DSPs respond with **"{ price, creativeId, dealId? }"**.' },
        { kind: "SAY", text: 'State the auction rule out loud: **"highest bid above floorPrice wins, pays exactly what it bid — first-price."** "A bid below the floor is excluded before winner selection, not just ranked lower."' },
        { kind: "RULE OUT", text: '"Second-price was the old default, but header bidding put the same impression in several simultaneous auctions, so DSPs couldn\'t tell if they were really in a second-price auction — they started blind bid-shading. First-price is transparent and puts shading on the DSP side instead." Cross second-price off.' },
        { kind: "WRITE", text: 'Write the win-vs-billed distinction: **"win notice ≠ billed impression"** — billing fires only on a confirmed render pixel, "~90-95% render rate, the gap is unbilled inventory".' },
      ],
      grading: "Crisp bid-request/response shape, first-price stated and defended against second-price by name, and the win-vs-render distinction volunteered.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: the bid/auction hot path, the auction-outcome path, and the async billing/pacing feedback loop.",
      why: "Separating these three lanes proves you know they have different SLAs — a candidate who draws one blob misses that billing needs durability the hot path can't afford to wait for.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **bid path**: Publisher → Bid Gateway → User Profile Store (enrich) → DSP Fanout → DSP Bidders → Auction Engine. Label arrows **"~150 DSPs, parallel"**, **"hard 80ms deadline"**, not the boxes.' },
        { kind: "DRAW", text: 'Add the **outcome path**: Auction Engine → Budget Pacer (reserve token) → Winning Creative → Publisher (render), labeled **"state-changing, on the hot path but fast"**.' },
        { kind: "DRAW", text: 'Add the **async lane**: Ad server → Kafka → Flink → Billing Warehouse, and Flink → Budget Pacer, dashed, labeled **"acknowledged, zero loss"** and **"spend feedback < 1 min"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes with three SLAs — the bid path is a hard 100ms deadline, the outcome path is fast but still synchronous, and billing is async but never droppable, unlike pacing telemetry."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with deadlines and delivery guarantees, and an explicit statement that billing is async-but-durable while telemetry is async-and-droppable.",
    },
    {
      n: 4,
      title: "Deep Dive: Timeout-Bounded Fanout and Auction",
      minutes: 8,
      goal: "Show hard deadline propagation, DSP health scoring, and defend first-price against second-price with the bid-shading story.",
      why: "This is the signature sub-problem: can you keep the auction fast and fair when any of hundreds of external services might be slow or down?",
      steps: [
        { kind: "SAY", text: 'Explain deadline propagation: "The fanout call carries a shared deadline; every in-flight DSP request is cancelled the instant tmax passes, not caught after the fact. A late bid gets zero weight."' },
        { kind: "SAY", text: 'Explain DSP health scoring: "Rolling p95 latency and timeout rate per DSP feed a score. Chronically slow DSPs get dropped from future fanout lists — a circuit breaker at the fanout layer, so one bad actor can\'t degrade every auction."' },
        { kind: "DRAW", text: 'Sketch the auction rule: floor price excludes low bids first, then highest remaining bid wins and pays its own price (first-price). Note fraud-filtered bids are excluded before this step too.' },
        { kind: "RULE OUT", text: '"Second-price under header bidding forces blind bid-shading since a DSP can\'t know if it\'s really isolated." "Waiting for every DSP to answer lets the slowest one set the pace for millions of concurrent auctions." Cross both off.' },
      ],
      grading: "Deadline propagation and DSP health scoring explained without prompting, first-price defended by name against second-price, and floor/fraud exclusion ordered correctly before winner selection.",
    },
    {
      n: 5,
      title: "Deep Dive: Pacing and Frequency Capping",
      minutes: 7,
      goal: "Walk the token-bucket pacing model and the regional, TTL-windowed frequency cap, and volunteer the accuracy trade-offs.",
      why: "Anyone can say 'track spend in a counter'. The interviewer wants a mechanism that stays fast at this cardinality and is honest about the accuracy it gives up.",
      steps: [
        { kind: "SAY", text: 'Explain pacing: "Each campaign has a token bucket refilled at a smooth target rate. As spend nears the target, participation becomes probabilistic instead of a hard cutoff, so delivery is smooth across the day instead of exhausted by 9am."' },
        { kind: "SAY", text: 'Explain frequency capping: "A cap like 3-per-user-per-day is a key with a 24h TTL, incremented in-region. No cross-region call on the hot path — that would blow the sub-millisecond budget."' },
        { kind: "SAY", text: 'Volunteer the trade-off: "Both of these are approximate by design — regional counters reconcile every < 1 minute, so a user might occasionally see one extra impression, and a campaign might spend ±5% off target. That\'s the honest cost of hitting the latency budget."' },
        { kind: "SAY", text: '"A globally consistent counter on every bid is the wrong tool here — it can\'t hit microsecond decisions at millions of bids/sec."' },
      ],
      grading: "Token-bucket pacing explained with the smoothing rationale, TTL-windowed regional frequency caps, and the ±5% / occasional over-delivery trade-off volunteered before being asked.",
    },
    {
      n: 6,
      title: "Wrap: Fraud, Billing, and Close",
      minutes: 5,
      goal: "Separate droppable telemetry from zero-loss billing, mention offline fraud scoring, and close with a crisp summary plus a parking list.",
      why: "Staff-level signal here is knowing which async data can be dropped and which cannot, and closing the interview like a collaborator instead of running out the clock.",
      steps: [
        { kind: "SAY", text: '"Fraud and brand-safety checks are precomputed offline and cached — the inline check is a lookup, never a live model call or external API, because that could blow tmax unpredictably."' },
        { kind: "SAY", text: '"Billing is the one place nothing is best-effort. Win/impression events use acknowledged, at-least-once delivery, and we only bill on a confirmed render, not just a win notice — reconciling the gap, roughly 5-10% of wins, in the Flink pipeline."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need true global pacing accuracy, or is regional-plus-reconciliation within ±5% good enough? That changes whether we need any cross-region synchronous path at all."' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a timeout-bounded fanout auction with probabilistic pacing and a zero-loss billing lane split off from best-effort telemetry. With more time I\'d cover PMP deal IDs, creative QA, and cross-DC failover for the auction engine."' },
      ],
      grading: "Explicit split between droppable telemetry and durable billing, offline fraud scoring stated plainly, at least one pushback on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design with the right named components, but the deadline enforcement and pacing mechanics stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: load balancer, DSP fanout, a cache for user data, a queue for events.",
          "Knows roughly what OpenRTB is and that DSPs respond with bids.",
          "Picks an auction model (often second-price by default) without deep justification.",
          "Adds 'a queue' for both billing and analytics without distinguishing them.",
          "Handles frequency capping by saying 'store a counter in Redis'.",
        ],
        gaps: [
          "Doesn't explain how the timeout is actually enforced — assumes DSPs 'just respond fast'.",
          "Doesn't know or mention the first-price vs second-price shift and why it happened.",
          "Pacing is 'check remaining budget' with no mechanism for smoothing across the day.",
          "No DSP health scoring or circuit-breaking — one slow DSP silently degrades everything.",
          "Treats billing events the same as click/telemetry events — both best-effort.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, enforces the deadline explicitly, and separates billing durability from best-effort telemetry.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes QPS, tmax, and the fanout size on the board within the first 5 minutes.",
          "Explains hard deadline propagation for DSP fanout, not just 'set a timeout'.",
          "Picks first-price and explains bid shading as the reason second-price was displaced.",
          "Designs token-bucket pacing with probabilistic participation instead of a hard cutoff.",
          "Uses regional, TTL-windowed counters for frequency capping and names the approximation trade-off.",
          "Splits the async pipeline: droppable telemetry vs. acknowledged, zero-loss billing.",
        ],
        gaps: [
          "Doesn't volunteer DSP health scoring / circuit breaking until the interviewer asks 'what if a DSP is chronically slow?'.",
          "Quantifies the bid-to-win ratio only when prompted, not as a number that drives fanout-filtering design.",
          "Doesn't bring up the win-vs-rendered-impression reconciliation gap unless asked directly about billing accuracy.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, quantifies every risk before being asked, and brings the operational maturity of someone who has actually run this system.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers DSP health scoring and circuit-breaking unprompted, framing it as protecting the whole exchange from one bad actor, not just one request.",
          "Quantifies the bid-to-win ratio (~100:1) and ties it directly to why fanout must be filtered, not blasted at the full DSP directory.",
          "Explicitly separates 'at-least-once, acknowledged, reconciled' billing from 'droppable, best-effort' telemetry and states why the cost difference is justified.",
          "Names the win-vs-rendered-impression gap (render rate ~90-95%) and describes reconciliation as a first-class pipeline output, not an edge case.",
          "Pushes back on requirements: 'do we need synchronous global pacing accuracy, or is regional-plus-reconciliation within ±5% sufficient?'.",
          "Frames fraud/brand-safety filtering as an architectural rule ('nothing synchronous-and-external belongs on the bid path'), not a one-off decision.",
          "Closes with a one-sentence summary of the whole system and an explicit parked-items list.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Treating the DSP timeout as a suggestion instead of a hard deadline — waiting for slow bidders blows the latency budget for every concurrent auction.",
      "Defaulting to second-price without knowing the industry moved to first-price specifically because of bid shading under header bidding.",
      "Making billing/impression events fire-and-forget with drop-on-overflow, the same as click telemetry — that's a direct revenue loss, not a stale dashboard.",
      "Putting fraud/brand-safety checks as synchronous inline calls (a live model or external API) on the bid-response path.",
      "Budget pacing as a hard on/off cutoff at 100% spend — produces lumpy delivery that exhausts budget by mid-morning.",
      "No DSP health scoring, so one chronically slow or down DSP silently degrades the whole exchange's tail latency over time.",
      "Frequency capping designed as a strongly consistent global counter, which can't hit the sub-millisecond, billions-of-keys budget.",
    ],
    followUps: [
      {
        q: "Why did the industry move from second-price to first-price auctions?",
        a: "Second-price is incentive-compatible only for a single, isolated auction — the winner pays the second-highest bid, so bidding your true value is theoretically safe. Header bidding broke that by putting the same impression up for auction across several exchanges simultaneously, so a DSP could no longer be sure it was really in an isolated second-price auction versus effectively competing first-price against the eventual winning bid elsewhere. DSPs responded by shading bids defensively and unpredictably. Google Ad Manager's 2019 switch to first-price, followed industry-wide, made the mechanism transparent (highest bid wins and pays what it bid) and moved the clearing-price prediction problem onto the DSP's own models instead of leaving it as a systemic guessing game.",
      },
      {
        q: "How do you keep the ~100ms budget safe when a DSP is slow or down?",
        a: "Two layers. First, a hard per-DSP deadline is propagated with the fanout call itself, so every in-flight request to that DSP is cancelled the instant tmax passes rather than being caught after the fact — a late bid simply isn't counted. Second, a rolling health score per DSP (p95 latency, timeout rate) feeds a circuit breaker: DSPs that are chronically slow get deprioritized or dropped from future fanout lists entirely, so the damage from one bad actor is contained to a shrinking share of auctions instead of degrading every one indefinitely.",
      },
      {
        q: "How does budget pacing actually work at the request level?",
        a: "Each campaign has a token bucket that refills at a smooth target rate derived from its daily budget and the time remaining in the period. Each time the campaign is a candidate to bid, it consumes a token; as the bucket empties relative to the target, participation becomes probabilistic — the campaign gets sampled into fewer auctions rather than being hard cut off. This smooths delivery across the full day instead of the campaign spending its whole budget in a burst and going dark. Regional spend counters are aggregated into a global view roughly every minute to adjust each campaign's refill rate, accepting about ±5% pacing accuracy in exchange for not needing synchronous cross-region coordination on every bid.",
      },
      {
        q: "Why is billing handled differently from click or pacing telemetry?",
        a: "A dropped telemetry event just makes a dashboard slightly stale; a dropped billing event is unrecovered or unpaid revenue. So while both are asynchronous relative to the bid response, the delivery guarantees differ: telemetry uses a bounded, droppable buffer, while win/impression billing events use at-least-once, acknowledged writes into Kafka, with downstream deduplication and reconciliation against confirmed renders. The extra cost (acks, retries, reconciliation logic) is deliberate and scoped only to the data that represents real money.",
      },
      {
        q: "What's the difference between a win and a billed impression?",
        a: "Winning the auction only means a DSP's bid was selected — it doesn't guarantee the ad actually rendered on the page (the user could navigate away, the creative could fail to load, and so on). Billing only fires on a separate, confirmed render signal, typically an impression pixel or beacon. Render rates typically run around 90-95%, so there's a real, expected gap between win notices and billed impressions; the pipeline tracks and reconciles that gap explicitly rather than assuming every win becomes a charge.",
      },
      {
        q: "How would you scale the DSP fanout if the number of DSPs grew 10x?",
        a: "You don't scale by fanning out to more DSPs per request — you keep the per-request fanout roughly constant and get smarter about which ~100-150 DSPs are worth calling. That means tighter filtering by historical fill rate, category match, and remaining campaign budget, and possibly a tiered fanout: call the highest-value likely bidders first, and only extend to a second wave if time remains inside the deadline. Connection pooling and keep-alive to each DSP amortizes handshake cost across the higher DSP count, so the marginal cost of a larger DSP directory is mostly in the filtering logic, not the wire calls themselves.",
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
          "This is a timeout-bounded, parallel-fanout auction with a side channel for money. The core operation — broadcast a bid request, collect whatever answers arrive before a hard deadline, pick a winner — is fast and simple; everything expensive (pacing, frequency capping, fraud filtering, billing) exists to make that operation fair and financially sound at 3M requests/sec.",
          "Anchor everything on the numbers: 3M bid requests/sec, a ~100ms end-to-end deadline (~80ms of that spent waiting on DSPs), a ~100:1 bid-to-win ratio, and zero tolerance for lost billing events. Every structural choice below is a consequence of these constraints, not a preference.",
        ],
      },
      {
        heading: "Sizing and the timeout budget",
        body: [
          "A publisher's OpenRTB request carries tmax, a hard millisecond deadline; answering even slightly late means the bid is discarded, not counted late. At 3M req/sec, fanning out to every DSP in a directory of thousands would be technically possible but would let the single slowest responder set the pace for every auction, so the exchange pre-filters to roughly 100-150 DSPs likely to bid, based on historical fill rate, category match, and remaining budget, before opening any connections.",
          "Within the ~100ms budget: roughly 10-15ms for network and gateway parsing, ~80ms held open for DSP responses, and the remainder for auction resolution and returning the winning creative. Every one of those slices is enforced, not aspirational.",
        ],
      },
      {
        heading: "First-price auction and the bid-shading story",
        body: [
          "Second-price (Vickrey) auctions were the historical default because they're incentive-compatible for a single, isolated auction: bidding your true value is always safe. Header bidding broke that assumption by putting the same impression up for auction across multiple exchanges simultaneously — a DSP could no longer trust it was in an isolated auction, so DSPs began shading bids defensively and unpredictably.",
          "The industry, led by Google Ad Manager's 2019 change, moved to first-price: highest valid bid above the publisher's floor wins and pays exactly what it bid. It's transparent and simple to reason about, at the cost of pushing the clearing-price prediction problem onto each DSP's own models.",
        ],
      },
      {
        heading: "Timeout-bounded fanout as the signature hard part",
        body: [
          "A hard deadline is propagated with the fanout call itself, so every in-flight DSP request is cancelled the instant tmax passes rather than being discovered late. That alone isn't enough at scale — a rolling p95-latency and timeout-rate health score per DSP feeds a circuit breaker that deprioritizes or drops chronically slow DSPs from future fanout lists, so one struggling bidder degrades a shrinking share of auctions instead of every one indefinitely.",
          "A worker/connection pool sized deliberately (bulkheading) prevents one stalled DSP connection from monopolizing resources needed by every other concurrent auction.",
        ],
      },
      {
        heading: "Pacing and frequency capping: approximate by design",
        body: [
          "Budget pacing uses a per-campaign token bucket refilled at a smooth target rate; as spend approaches the target, participation becomes probabilistic rather than a hard cutoff, spreading delivery evenly instead of exhausting budget by mid-morning. Regional spend counters feed a global view roughly every minute, accepting ±5% pacing accuracy in exchange for not needing synchronous cross-region coordination on every bid.",
          "Frequency capping follows the same philosophy: a cap is a TTL-windowed key incremented in-region, not a globally consistent counter, because global consistency at billions of user-campaign pairs and a sub-millisecond budget is simply the wrong tool. Both mechanisms trade a small, bounded amount of accuracy for the speed the system actually needs.",
        ],
      },
      {
        heading: "Fraud filtering and the billing pipeline's zero-loss lane",
        body: [
          "Fraud and brand-safety checks are precomputed in batch — domain/app reputation scores, ads.txt/sellers.json verification — so the inline check on the bid path is only a cache lookup, never a live model call or external API that could add unpredictable latency. Anything requiring a synchronous external call is disqualified from the hot path entirely and runs as an offline pre-filter or a post-hoc audit instead.",
          "Billing is the one place nothing is best-effort. While pacing telemetry can be dropped under overflow, win and impression events use at-least-once, acknowledged delivery into Kafka, and billing only fires on a confirmed render — not merely a win notice — because render rates run ~90-95% and that gap is real, unbilled inventory that the Flink → ClickHouse pipeline reconciles explicitly rather than silently absorbing.",
        ],
      },
    ],
  },
};
