import type { Problem } from "@/lib/types";

export const paymentSystem: Problem = {
  slug: "payment-system",
  num: "6.9",
  title: "Design a Payment System",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a payment system that authorizes and captures 5,000 card payments/sec sustained (20,000/sec peak on Black Friday) against external card networks you don't control, guarantees a client retry after a timeout can never double-charge a card, and keeps a double-entry ledger that balances to the penny under concurrent writes — all while never losing track of a single dollar.",
  ],
  hardParts:
    "The hard parts: making retries safe (idempotency and exactly-once) when the thing you're calling is a third-party card network you can't wrap in one transaction, resolving the genuine ambiguity of \"did the charge go through\" after a timeout, and keeping a double-entry ledger correct under concurrency while every entry stays immutable and auditable.",
  keyTopics: [
    "Idempotency Keys",
    "Double-Entry Ledger",
    "Saga-Based Orchestration",
    "PCI Tokenization Vault",
    "Reconciliation as Safety Net",
  ],
  foundationsReferenced: [
    { label: "ACID Transactions", tone: "blue" },
    { label: "Saga Pattern", tone: "purple" },
    { label: "Idempotency & Exactly-Once Processing", tone: "orange" },
    { label: "Outbox Pattern (Kafka)", tone: "orange" },
    { label: "PostgreSQL / Spanner (Strong Consistency)", tone: "blue" },
    { label: "Sharding by Account", tone: "green" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "checkout / merchant server", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "Payment API", sub: "stateless", col: 2, row: 1, tone: "slate" },
      {
        id: "idempotency",
        label: "Idempotency Store",
        sub: "key → request hash → response",
        mono: "24h TTL",
        col: 2,
        row: 2,
        tone: "purple",
      },
      {
        id: "orchestrator",
        label: "Payment Orchestrator",
        sub: "saga / state machine",
        mono: "created → authorized → captured",
        col: 3,
        row: 1,
        tone: "purple",
      },
      { id: "risk", label: "Risk / Fraud Engine", sub: "warm features, <50ms", col: 3, row: 2, tone: "blue" },
      { id: "kafka", label: "Kafka", sub: "outbox", col: 3, row: 3, tone: "orange" },
      { id: "ledger", label: "Ledger DB", sub: "double-entry · ACID", mono: "append-only", col: 4, row: 1, tone: "green" },
      { id: "vault", label: "Tokenization Vault", sub: "PCI-isolated", col: 4, row: 2, tone: "blue" },
      { id: "webhook", label: "Webhook Service", sub: "at-least-once", col: 4, row: 3, tone: "orange" },
      { id: "psp", label: "Card Network / PSP", sub: "external, ~300ms RTT", col: 5, row: 1, tone: "slate" },
      { id: "reconcile", label: "Reconciliation Job", sub: "vs. bank settlement file", col: 5, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "gateway", label: "POST /charge + Idempotency-Key", kind: "write" },
      { from: "gateway", to: "idempotency", label: "lookup key", kind: "write" },
      { from: "idempotency", to: "gateway", label: "cached response, if seen", kind: "write" },
      { from: "gateway", to: "orchestrator", label: "create PaymentIntent", kind: "write" },
      { from: "orchestrator", to: "risk", label: "score, sync", kind: "write" },
      { from: "orchestrator", to: "vault", label: "detokenize PAN", kind: "write" },
      { from: "orchestrator", to: "psp", label: "authorize + capture", kind: "write" },
      { from: "psp", to: "orchestrator", label: "approved / declined", kind: "write" },
      { from: "orchestrator", to: "ledger", label: "double-entry post · ACID txn", kind: "write" },
      { from: "orchestrator", to: "idempotency", label: "store result", kind: "write" },
      { from: "gateway", to: "ledger", label: "GET /payments/:id", kind: "read" },
      { from: "orchestrator", to: "kafka", label: "outbox: PaymentSucceeded", kind: "analytics" },
      { from: "kafka", to: "webhook", label: "at-least-once", kind: "analytics" },
      { from: "webhook", to: "client", label: "signed webhook → merchant", kind: "analytics" },
      { from: "kafka", to: "reconcile", label: "settlement stream", kind: "analytics" },
      { from: "reconcile", to: "ledger", label: "match vs. bank file, T+1", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · status checks" },
      { kind: "write", text: "write path · 5K authorizations/s" },
      { kind: "analytics", text: "async · webhooks & reconciliation, never blocks a charge" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Create a PaymentIntent for a given amount, currency, and merchant", tag: "P0" },
      { id: "FR-02", text: "Authorize and capture a card payment via an external PSP / card network", tag: "P0" },
      { id: "FR-03", text: "Idempotent request handling via an Idempotency-Key header — a client retry never double-charges", tag: "P0" },
      { id: "FR-04", text: "Double-entry ledger recording every money movement, immutable and auditable", tag: "P0" },
      { id: "FR-05", text: "Support partial and full refunds by posting reversing ledger entries", tag: "P0" },
      { id: "FR-06", text: "Real-time fraud / risk scoring before authorization", tag: "P0" },
      { id: "FR-07", text: "Tokenize and vault card data to isolate PCI DSS scope", tag: "P0" },
      { id: "FR-08", text: "Deliver signed webhooks to merchants on state changes (succeeded, failed, refunded)", tag: "P1" },
      { id: "FR-09", text: "Reconcile the internal ledger against processor / bank settlement files daily", tag: "P1" },
      { id: "FR-10", text: "Support multi-currency payments and FX conversion at settlement", tag: "P1" },
      { id: "FR-11", text: "Payout / settle funds to merchant bank accounts on a T+2 schedule", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Authorize + capture latency (round trip to card network)", tag: "p99 < 500ms" },
      { id: "NFR-02", text: "Idempotency-key replay latency on a cache hit", tag: "p99 < 20ms" },
      { id: "NFR-03", text: "Payment throughput, sustained", tag: "5K/sec" },
      { id: "NFR-04", text: "Payment throughput, peak (Black Friday)", tag: "20K/sec" },
      { id: "NFR-05", text: "Availability of the payment API", tag: "99.99%" },
      { id: "NFR-06", text: "Financial correctness: no double charge, no lost transaction", tag: "zero loss" },
      { id: "NFR-07", text: "Ledger balance integrity across every account, at all times", tag: "sums to $0.00" },
      { id: "NFR-08", text: "Webhook delivery success within retries", tag: "99.9% / 1 min" },
      { id: "NFR-09", text: "Idempotency-key retention window", tag: "24h" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Money as integers: the sizing argument for correctness",
      body: [
        "Before anything else, settle how money is represented, because getting this wrong corrupts every number downstream. IEEE-754 floating point cannot represent most decimal fractions exactly, so $0.10 + $0.20 evaluates to 0.30000000000000004, not 0.30. Across millions of transactions, that drift is not cosmetic — it is real money silently gained or lost, and it will not show up in a demo, only in a monthly reconciliation report that doesn't balance.",
      ],
      bullets: [
        { lead: "Integer minor units", text: "store every amount as an int64 in the currency's smallest unit — cents for USD, so $19.99 is stored as 1999. Arithmetic on integers is exact; there is no rounding to accumulate." },
        { lead: "ISO 4217 exponents vary", text: "USD and EUR have 2 decimal places, JPY has 0 (¥100 is stored as 100, not 10000), and BHD/KWD have 3. A single hardcoded 'divide by 100' assumption silently corrupts amounts in ~30 currencies." },
        { lead: "Never a float, anywhere", text: "not in the API payload, not in the database column, not in a currency-conversion step. Convert to a display string only at the very edge, for rendering." },
      ],
      pictureTitle: "Would you trust this arithmetic with your transaction volume?",
      pictureCaption: "float: 0.1 + 0.2 = 0.30000000000000004 · integer cents: 10 + 20 = 30, exact",
      pictureRows: [
        { label: "Float: $0.10 + $0.20", value: "0.30000000000000004 → wrong", tone: "bad" },
        { label: "Integer cents: 10 + 20", value: "30 → exact, no drift", tone: "good" },
        { label: "JPY (exponent 0)", value: "100 == ¥100, not ¥1.00", tone: "neutral" },
      ],
      remember: {
        problem: "Represent money so arithmetic is exact at any transaction volume.",
        solution: "Store every amount as an integer in the currency's minor unit (cents), using the ISO 4217 exponent per currency.",
        why: "Floating point cannot represent most decimal fractions exactly; the rounding error compounds across millions of transactions.",
        tradeoff: "You must thread a currency-aware exponent through every conversion instead of assuming 'divide by 100' everywhere.",
        failure: "A float-based ledger drifts silently; the mismatch only surfaces weeks later when a monthly reconciliation doesn't balance.",
        mitigation: "Ban floats from the schema and the API contract; enforce integer minor units at every boundary with the currency's own exponent.",
      },
    },
    {
      n: 2,
      title: "Idempotency keys: kill the naive retry, defend one design",
      body: [
        "A client can time out waiting for a response without knowing whether the charge succeeded on the server. If it blindly retries the same POST, a naive server processes it twice and charges the card twice. The fix has to be deterministic: the same logical request, replayed any number of times, produces exactly one charge and always returns the same response.",
      ],
      bullets: [
        { lead: "Client-generated Idempotency-Key", text: "one UUID per logical operation, generated once by the client before the first attempt, and reused on every retry of that same operation — not regenerated per HTTP call." },
        { lead: "Store the request hash, not just the key", text: "keep {merchant_id, idempotency_key} → {request_body_hash, status, response}. If a retry arrives with the same key but a different body, that's a client bug — reject it with a conflict, don't silently process a different charge under an old key." },
        { lead: "In-flight lock", text: "mark the record 'processing' before calling the PSP. A concurrent retry that arrives while the first attempt is still in flight waits or gets a 409, rather than racing a second call to the card network." },
        { lead: "24h retention", text: "matches the window most PSPs guarantee their own dedup key survives, so a retry on either side of the call stays safe." },
      ],
      pictureTitle: "Idempotency: kill the naive option, keep one",
      pictureRows: [
        { label: "Raw retry, no key", value: "double charge on timeout → reject", tone: "bad" },
        { label: "Key = hash(card, amount) only", value: "two legit same-amount purchases collide → reject", tone: "bad" },
        { label: "Client key + request hash + in-flight lock", value: "safe replay, safe conflict detection → WINNER", tone: "good" },
      ],
      remember: {
        problem: "A client retry after a timeout must never double-charge a card.",
        solution: "Client-supplied Idempotency-Key, stored with a hash of the request body and an in-flight processing lock.",
        why: "The key makes retries of the same logical operation deterministic; the hash catches a key reused for a different request; the lock stops two concurrent retries from both reaching the PSP.",
        tradeoff: "Every write pays one extra lookup/write against the idempotency store, and clients must be trusted to reuse keys correctly across retries.",
        failure: "Without a request hash, a buggy client that reuses a key for a different amount would silently process the wrong charge.",
        mitigation: "Reject mismatched request hashes with a conflict instead of guessing which request the client 'meant'.",
      },
    },
    {
      n: 3,
      title: "The double-entry ledger: the append-only invariant",
      body: [
        "A single mutable 'balance' column updated in place is the wrong data model for money: two concurrent debits can both read the same balance and both apply, silently losing one of them, and there is no audit trail of how the number got there. A double-entry ledger fixes both problems — every movement of money is recorded as at least two balanced rows, and the rows are never edited, only appended.",
      ],
      bullets: [
        { lead: "Journal entry", text: "(payment_id, debit_account, credit_account, amount_minor_units, currency, created_at). A $50 charge debits the customer's account and credits the merchant's, in the same row." },
        { lead: "Balance invariant", text: "sum(debits) == sum(credits) must hold for every entry and, summed over time, for every account. This is the correctness check that catches bugs before customers do." },
        { lead: "Immutable, append-only", text: "a refund is a new reversing entry, not an edit to the original row. History is never rewritten, which is what makes the ledger auditable." },
        { lead: "Serializable per account", text: "row-level locking or serializable isolation on the account being debited prevents two concurrent transactions from both reading a stale balance and overdrawing it." },
      ],
      pictureTitle: "Balance column vs. double-entry journal",
      pictureRows: [
        { label: "Mutable balance, UPDATE in place", value: "race condition, lost updates, no audit trail", tone: "bad" },
        { label: "Double-entry, append-only journal", value: "auditable, always reconciles to $0.00", tone: "good" },
        { label: "Eventually-consistent ledger shards", value: "not acceptable — per-account writes must be ACID", tone: "bad" },
      ],
      remember: {
        problem: "Keep money correct and auditable under concurrent writes.",
        solution: "Double-entry, append-only ledger: every movement is a balanced debit/credit pair; refunds are new rows, never edits.",
        why: "A mutable balance column has no audit trail and races under concurrency; balanced pairs make every entry self-checking.",
        tradeoff: "More storage (every movement is at least two rows, forever) in exchange for a system that can prove its own correctness.",
        failure: "A single UPDATE-in-place balance column loses concurrent debits and gives no way to explain how a balance got to its current value.",
        mitigation: "Serializable transactions per account, and a background job that continuously verifies sum(debits) == sum(credits).",
      },
    },
    {
      n: 4,
      title: "The saga: orchestrating a payment across a system you don't own",
      body: [
        "A payment is not one database transaction — it spans your own state and an external card network that you cannot wrap in a two-phase commit; the PSP will never join your transaction. Model the payment as an explicit, durably-persisted state machine (created → risk_checked → authorized → captured → settled, or declined/failed/reversed at any step) so that a crash mid-flow resumes from the last known state instead of silently losing or re-doing work.",
      ],
      bullets: [
        { lead: "Persist before you call out", text: "write the next state to the orchestrator's own store before firing the external call, never after. On restart, the recovery sweep reads that state, not memory that just vanished." },
        { lead: "Every step is itself idempotent", text: "risk scoring, vault detokenization, and the PSP call must each tolerate being retried after a crash, because the saga will retry the step it was on, not restart from zero." },
        { lead: "Compensating actions", text: "if capture succeeds at the PSP but the ledger write fails, the next saga step is 'reverse the authorization', not 'pretend the charge never happened' — you cannot silently drop a step that already had a real-world side effect." },
        { lead: "Recovery sweep", text: "a background job scans for sagas stuck in a non-terminal state past a timeout and either resumes them from their last durable state or drives them to a defined terminal failure state." },
      ],
      pictureTitle: "Two-phase commit vs. a persisted saga",
      pictureRows: [
        { label: "2PC across your DB and the PSP", value: "impossible — a third party won't join your transaction", tone: "bad" },
        { label: "In-memory workflow, retry from step 0", value: "re-fires the PSP call on every crash → double charge", tone: "bad" },
        { label: "Persisted state machine, idempotent steps, compensation", value: "resumable, no lost or duplicated work", tone: "good" },
      ],
      remember: {
        problem: "Coordinate a multi-step payment across your own database and an external card network with no shared transaction.",
        solution: "A durably-persisted saga/state machine with idempotent steps and explicit compensating actions.",
        why: "You cannot 2PC with a third party; persisting state before each call is what makes a mid-flow crash recoverable instead of ambiguous.",
        tradeoff: "Every step must be written to tolerate being retried, which adds design overhead compared to a single in-process transaction.",
        failure: "An in-memory workflow that restarts from step 0 after a crash re-fires an already-completed PSP call and double-charges the card.",
        mitigation: "Persist state before each external call, make each call idempotent, and run a recovery sweep for stuck sagas.",
      },
    },
    {
      n: 5,
      title: "\"Did it go through?\": the timeout-ambiguity problem",
      body: [
        "This is the genuinely hard failure mode. You send an authorize request to the card network and the connection times out before any response arrives. You do not know whether the charge succeeded on their side. Blindly retrying risks a double charge; blindly marking it failed risks charging a customer for nothing they'll receive, because the charge may well have gone through.",
      ],
      bullets: [
        { lead: "Pass your idempotency key to the PSP too", text: "most card networks and PSPs accept their own dedup key on the authorize call, so a retry to the PSP itself is safe even though your first attempt's outcome is unknown to you." },
        { lead: "On timeout: mark 'in_doubt', not 'failed'", text: "the payment sits in an explicit ambiguous state, never surfaced to the customer as a definitive success or failure until it's resolved." },
        { lead: "Query, don't guess", text: "call the PSP's status endpoint — a GET, which has no side effect — to resolve what actually happened. This is safe to retry indefinitely." },
        { lead: "Settlement file as ground truth", text: "if even the status endpoint is unreachable, the daily settlement/reconciliation file from the bank is the final source of truth and resolves the ambiguity within 24 hours." },
      ],
      pictureTitle: "Resolving a timed-out authorize call",
      pictureRows: [
        { label: "Assume success on timeout", value: "customer never charged, merchant ships for free", tone: "bad" },
        { label: "Assume failure, retry blindly", value: "risk of a genuine double charge", tone: "bad" },
        { label: "in_doubt → poll PSP status → settlement file fallback", value: "resolves correctly, worst case within 24h", tone: "good" },
      ],
      remember: {
        problem: "A timeout during authorization leaves you not knowing whether the charge actually happened.",
        solution: "Mark the payment in_doubt, poll the PSP's idempotent status endpoint, and fall back to the settlement file as ground truth.",
        why: "Neither assuming success nor assuming failure is safe; only asking the authoritative system (directly or via its settlement file) resolves it correctly.",
        tradeoff: "The customer may see a 'processing' state for longer than you'd like, instead of an instant answer.",
        failure: "Guessing in either direction produces either an unpaid order or a double charge — both are real financial and trust damage.",
        mitigation: "Never terminate a payment in an ambiguous state on a timeout; always resolve through a query or the reconciliation sweep.",
      },
    },
    {
      n: 6,
      title: "Fraud scoring without blowing the latency budget",
      body: [
        "Risk scoring has to run before authorization, but the whole authorize+capture budget is ~500ms and the card network round trip already eats a good chunk of it. A synchronous ML pipeline with cold feature lookups doesn't fit; the fast path has to be a cheap, mostly-precomputed decision, with anything expensive pushed off to the side.",
      ],
      bullets: [
        { lead: "Warm, precomputed features", text: "velocity counters, device fingerprint, IP reputation kept hot in a fast key-value store, so scoring is a handful of lookups plus a rules/lightweight-model pass in single-digit to tens of milliseconds — not a cold database scan." },
        { lead: "Three-way decision", text: "allow, block, or step-up (trigger a 3-D Secure challenge). Only the ambiguous middle band pays extra latency and customer friction; the clear-cut cases resolve immediately." },
        { lead: "Async enrichment after the fact", text: "a slower, heavier model can re-score after authorization and flag or hold a payout later, instead of blocking the charge itself on a model that takes seconds to run." },
        { lead: "Feedback loop", text: "chargebacks and disputes feed back into retraining; risk is a probabilistic, continuously-tuned system, not a one-time synchronous gate." },
      ],
      pictureTitle: "Fitting risk scoring into a 500ms budget",
      pictureRows: [
        { label: "Full ML pipeline, cold features, synchronous", value: "blows the authorization budget", tone: "bad" },
        { label: "Rules + warm precomputed features", value: "single-digit to tens of ms, catches obvious fraud", tone: "good" },
        { label: "Allow / block / step-up tiers", value: "only the ambiguous band pays 3DS friction", tone: "good" },
      ],
      remember: {
        problem: "Score fraud risk before authorization without blowing the ~500ms authorize budget.",
        solution: "Warm, precomputed features feeding a fast rules/lightweight-model pass, with allow/block/step-up tiers and async re-scoring after the fact.",
        why: "The card network round trip already consumes most of the latency budget; risk scoring has to be near-free on the hot path.",
        tradeoff: "The fast synchronous model is less accurate than a full pipeline, so some fraud is caught only later, after the money has moved.",
        failure: "A synchronous, cold-feature ML pipeline on the authorize path adds hundreds of milliseconds and can blow the SLA under load.",
        mitigation: "Keep the sync path to warm-feature rules with a step-up tier for ambiguous cases, and run the heavy model asynchronously.",
      },
    },
    {
      n: 7,
      title: "PCI scope isolation via a tokenization vault",
      body: [
        "Storing a raw card number (PAN) anywhere in your application puts your entire stack in PCI DSS audit scope — expensive, slow, and a growing attack surface. Instead, an isolated, network-segmented vault is the only component that ever touches a live PAN; it exchanges the card number for an opaque token the instant it's collected, and everything else in the system — orchestrator, ledger, risk engine, your own database — only ever sees that token.",
      ],
      bullets: [
        { lead: "Collect outside your app servers", text: "a hosted card field or vault-hosted iframe sends the PAN directly to the vault, bypassing your application entirely and shrinking your PCI audit scope (SAQ A instead of SAQ D)." },
        { lead: "Token everywhere else", text: "the app stores {token, last4, card brand} for display and reference; the token is meaningless outside the vault." },
        { lead: "Detokenize only inside the vault boundary", text: "the raw PAN is reconstituted only at the moment of the PSP call, inside the vault's own isolated network segment, and never logged or persisted anywhere else." },
        { lead: "Encrypt at rest with an HSM", text: "the vault itself encrypts stored card data using hardware security modules and rotates or expires tokens on its own schedule." },
      ],
      pictureTitle: "Where does the PAN live?",
      pictureRows: [
        { label: "Raw PAN in application DB", value: "full PCI DSS Level 1 scope for your whole stack", tone: "bad" },
        { label: "Token in app DB, PAN only in vault", value: "minimal scope, vault is the only audited boundary", tone: "good" },
        { label: "Hosted card field, bypasses app servers", value: "smallest possible scope (SAQ A)", tone: "good" },
      ],
      remember: {
        problem: "Handle card numbers without pulling your entire application into PCI DSS audit scope.",
        solution: "An isolated tokenization vault that's the only thing that ever touches a raw PAN; everything else sees an opaque token.",
        why: "PCI scope follows anywhere cardholder data flows or is stored; a vault contains that footprint to one audited boundary.",
        tradeoff: "Every charge pays a hop to detokenize inside the vault, and the vault itself becomes a highly available, highly secured dependency.",
        failure: "Storing raw PANs in the application database means a single app-layer breach is a full cardholder-data breach.",
        mitigation: "Hosted card fields that never transit your servers, tokens everywhere else, detokenization confined to the vault's boundary.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a distributed transaction against a system you don't control — your database and the card network. Idempotency keys make retries safe, and a persisted saga makes a crash mid-flight recoverable.",
      "Every dollar lives in a double-entry ledger: append-only, integer minor units, and it must balance to $0.00 across every account. A mutable balance column is the wrong answer.",
      "The hardest failure isn't the charge failing, it's the charge timing out — you genuinely don't know if it went through, so you poll the PSP's status and fall back to the settlement file as ground truth.",
      "Fraud scoring, webhook delivery, and settlement all run off the hot path so a slow risk model or a broken merchant webhook endpoint never adds latency to an authorization.",
      "Card data itself never touches your application: a PCI-isolated vault tokenizes it at the edge, so your database only ever sees an opaque token.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · STATUS CHECK",
        summary: "A merchant polls or a customer refreshes to see whether a payment cleared. This never touches the PSP again — it reads the ledger's own record of what already happened.",
        steps: [
          { label: "Client", note: "GET /payments/:id" },
          { label: "Payment API", note: "stateless" },
          { label: "Ledger DB", note: "read replica, current state" },
          { label: "Response", note: "status + amount + last4" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · AUTHORIZE + CAPTURE · 5K/S SUSTAINED",
        summary: "A charge is idempotency-checked, risk-scored, detokenized, sent to the card network, and posted to the ledger as a balanced pair — each step durably recorded before the next one fires.",
        steps: [
          { label: "Client", note: "POST /charge + Idempotency-Key" },
          { label: "Idempotency Store", note: "lookup key, replay if seen" },
          { label: "Payment Orchestrator", note: "creates PaymentIntent, persists state" },
          { label: "Risk Engine", note: "warm features, allow/block/step-up" },
          { label: "Tokenization Vault", note: "detokenize PAN" },
          { label: "Card Network / PSP", note: "authorize + capture, ~300ms RTT" },
          { label: "Ledger DB", note: "double-entry post, ACID txn" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC · WEBHOOKS + RECONCILIATION",
        summary: "The orchestrator fires an outbox event and moves on. Webhooks and settlement reconciliation happen off to the side, at-least-once, and never add latency to a charge.",
        steps: [
          { label: "Payment Orchestrator", note: "outbox: PaymentSucceeded" },
          { label: "Kafka", note: "at-least-once delivery" },
          { label: "Webhook Service", note: "signed payload, retries with backoff" },
          { label: "Reconciliation Job", note: "matches ledger vs. bank settlement file, T+1" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "5,000 payments/sec sustained, 20,000/sec peak (Black Friday), authorize+capture p99 < 500ms",
          "Idempotency-Key replay (cache hit) p99 < 20ms, 24h retention window",
          "Amounts stored as int64 minor units (cents); ISO 4217 exponents vary — JPY=0, USD=2, BHD=3",
          "Ledger: double-entry, append-only, must sum to $0.00 across every account, at all times",
          "Webhook delivery: at-least-once, 99.9% within 1 minute, exponential backoff for up to 72h",
          "Settlement / payout to merchant bank accounts on a T+2 schedule",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Idempotency-Key + request hash + in-flight lock, not raw retry-and-hope",
          "Double-entry, append-only ledger, not a mutable balance column",
          "Persisted saga/state machine across risk → vault → PSP → ledger, every step idempotent",
          "On PSP timeout: mark in_doubt, poll PSP status, fall back to settlement-file reconciliation",
          "PCI-isolated tokenization vault; app and DB only ever see a token, never a raw PAN",
          "Fraud scoring via warm precomputed features + allow/block/step-up tiers, not a sync ML pipeline",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Money is never a float — integer minor units with per-currency ISO 4217 exponents",
          "The timeout-ambiguity problem ('did it go through') is the genuine hard part, not the happy path",
          "Reconciliation against the bank's settlement file is the system's ground-truth safety net",
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
      goal: "Lock five numbers and the scope before drawing anything: throughput, latency budget, currencies, consistency expectations, and what's explicitly out of scope.",
      why: "This is a correctness-critical system, not a throughput-critical one — the interviewer wants to see you anchor on 'zero loss' and 'balances to the penny' before you get seduced by scaling numbers. Every later decision (idempotency, ledger model, saga design) is a consequence of that priority.",
      steps: [
        { kind: "ASK", text: '**"What throughput and what\'s the latency budget?"** Land on "5,000 payments/sec sustained, 20,000/sec peak", **"authorize+capture p99 under 500ms"**. Write **"5K/20K sustained/peak, p99<500ms"** top-left.' },
        { kind: "SAY", text: 'State the priority explicitly: **"Correctness beats latency here — a lost or duplicated charge is a much worse outcome than a slow one."** Wait for a nod before moving on.' },
        { kind: "ASK", text: 'Ask **"single currency or multi-currency?"** and **"do we own the card network integration, or go through a PSP like Stripe/Adyen?"** Land on multi-currency, integrating via a PSP.' },
        { kind: "SAY", text: 'State scope. In: "authorize/capture", "idempotency", "the ledger", "refunds", "webhooks", "reconciliation". Out: "the actual card network / interchange internals", "full KYC/AML", "chargebacks/disputes workflow". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Write the non-negotiable invariant on the board: **"ledger sums to $0.00 across every account, always"** and **"a retry must never double-charge."** These two lines anchor everything that follows.' },
      ],
      grading: "Senior judgment: numbers on the board fast, but more importantly the correctness invariant stated explicitly before any component is drawn.",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "Two or three endpoints, one journal-entry schema, and the money-as-integers decision made out loud before anyone has to ask.",
      why: "The interviewer wants to see you commit to a tiny, well-typed surface and defend the data model that makes correctness possible, before drawing a single box.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoints: **"POST /charge { amount_minor, currency, payment_method_token, idempotency_key }"** → **"{ payment_id, status }"**. **"POST /refund { payment_id, amount_minor? }"**. **"GET /payments/:id"**.' },
        { kind: "DRAW", text: 'Sketch the journal entry row: **"(payment_id, debit_account, credit_account, amount_minor, currency, created_at)"**. Say it out loud: "Every row is a balanced pair, and rows are never edited — a refund is a new reversing row."' },
        { kind: "SAY", text: '**"Amounts are int64 minor units, never a float."** Give the JPY example: "JPY has zero decimal places, so ¥100 is stored as 100, not 10000 — the exponent is per-currency, from ISO 4217."' },
        { kind: "RULE OUT", text: 'Get ahead of it: "A single mutable balance column would race under concurrent writes and has no audit trail — I\'m using an append-only double-entry journal instead." Cross the mutable-column option off.' },
      ],
      grading: "Crisp endpoints, the journal-entry schema drawn correctly, and the integer-minor-units decision volunteered rather than prompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: the synchronous authorize path, the read/status path, and the async webhook+reconciliation path.",
      why: "Drawing these as separate lanes proves you understand they have different guarantees — the authorize path must be synchronous and correct, while webhooks and reconciliation are best-effort and must never sit in front of a charge.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write/authorize path**: Client → Payment API → Idempotency Store → Orchestrator → Risk Engine → Vault → Card Network/PSP → Ledger. Label the arrows **"idempotency lookup"**, **"score, sync"**, **"detokenize"**, **"authorize+capture ~300ms"**.' },
        { kind: "DRAW", text: 'Add the **read/status path** as a thin separate arrow: Client → Payment API → Ledger (read replica), labeled **"GET /payments/:id"**.' },
        { kind: "DRAW", text: 'Add the **async lane** dropping off the Orchestrator: → Kafka → Webhook Service → Merchant, and Kafka → Reconciliation Job → Ledger, dashed, labeled **"never blocks a charge"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes with three different guarantees — authorize is synchronous and must be correct, status reads are cheap, and webhooks/reconciliation are async and best-effort by design."' },
      ],
      grading: "Three clearly separated lanes, the authorize path fully labeled step by step, and an explicit statement that async work never blocks a charge.",
    },
    {
      n: 4,
      title: "Deep Dive: Idempotency and Exactly-Once",
      minutes: 8,
      goal: "Walk the idempotency-key design and the saga/state-machine model, and defend why a naive retry fails.",
      why: "This is the signature sub-problem. The interviewer is probing whether you can make a client retry against your API safe, and separately, whether the orchestrator itself can survive a mid-flow crash without duplicating a PSP call.",
      steps: [
        { kind: "SAY", text: '"The client generates one Idempotency-Key per logical charge and reuses it on every retry. I store {key → request hash, status, response}. Same key, same hash: I replay the cached response. Same key, different hash: that\'s a client bug, I reject it."' },
        { kind: "SAY", text: '"While a request is in flight I mark it processing and hold a lock, so two concurrent retries can\'t both reach the PSP."' },
        { kind: "DRAW", text: 'Draw the saga states: **"created → risk_checked → authorized → captured → settled"**, with declined/failed/in_doubt as branches. "Each transition is persisted before the next external call fires, so a crash resumes instead of re-firing a completed step."' },
        { kind: "RULE OUT", text: '"A raw retry with no key risks a double charge. A key derived only from card+amount would collide two legitimate same-amount purchases. An in-memory saga that restarts from step 0 on crash re-fires the PSP call." Cross each off.' },
      ],
      grading: "The idempotency-key + request-hash + lock design stated precisely, the saga states on the board, and each weaker alternative rejected with a concrete failure mode.",
    },
    {
      n: 5,
      title: "Deep Dive: Ledger and the Timeout-Ambiguity Problem",
      minutes: 7,
      goal: "Defend the double-entry ledger's concurrency story, then volunteer the timeout-ambiguity problem as the genuine hard part before being asked.",
      why: "Anyone can say 'use a ledger'. The top score comes from naming, unprompted, that a timed-out authorize call leaves you not knowing whether the charge happened — and having a real resolution path, not a guess.",
      steps: [
        { kind: "SAY", text: '"Every account\'s writes are serializable so two concurrent debits can\'t both read a stale balance. A background job continuously verifies sum(debits) == sum(credits) as a live correctness check."' },
        { kind: "SAY", text: 'Volunteer the hard part: "The real risk isn\'t the charge failing cleanly — it\'s the authorize call timing out. I genuinely don\'t know if it succeeded on the card network\'s side."' },
        { kind: "SAY", text: '"On timeout I mark the payment in_doubt, never failed or succeeded, then poll the PSP\'s status endpoint — a GET, safe to retry. If even that\'s unreachable, the daily settlement file from the bank is ground truth and resolves it within 24 hours."' },
        { kind: "SAY", text: 'Close the loop: "That settlement-file reconciliation isn\'t just for the timeout case — it runs every day as the safety net that proves the ledger matches what actually moved."' },
      ],
      grading: "The double-entry concurrency story stated cleanly, and the timeout-ambiguity problem volunteered with a concrete two-step resolution (status poll, then settlement file), not just 'we retry'.",
    },
    {
      n: 6,
      title: "Wrap: Fraud, PCI, Reconciliation, and Close",
      minutes: 5,
      goal: "Cover fraud scoring's latency budget, PCI scope isolation, and close with a crisp one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal here is naming the operational and compliance dimensions that a design can otherwise quietly ignore — fraud latency, PCI scope, and reconciliation as an ongoing safety net rather than a one-off.",
      steps: [
        { kind: "SAY", text: '"Risk scoring runs on warm precomputed features so it fits in single-digit to tens of milliseconds, with an allow/block/step-up tier — only the ambiguous cases pay 3DS friction. A heavier model re-scores async, after the fact."' },
        { kind: "SAY", text: '"Card numbers never touch our application — a PCI-isolated vault tokenizes them at collection, so our database and every other service only ever sees an opaque token."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need synchronous 3DS for every ambiguous transaction, or can more of that be async with a hold? That changes the risk-engine latency budget." Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence: "It\'s a distributed transaction against an external card network, made safe by idempotency keys, a persisted saga, a double-entry ledger, and settlement-file reconciliation as the ground-truth backstop. With more time I\'d cover disputes/chargebacks and multi-PSP failover."' },
      ],
      grading: "Fraud latency and PCI scope both named unprompted, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a design that processes a charge and stores a record of it, but the correctness guarantees under retry and failure stay vague.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: API gateway, a database, a queue, and 'call Stripe or similar' for the actual card processing.",
          "Uses an Idempotency-Key if the interviewer prompts for it, but can't fully explain the request-hash or locking behavior.",
          "Knows amounts should be integers if asked, but may default to a decimal/float type unprompted.",
          "Has a payments table with a status column that gets updated in place.",
          "Handles refunds by updating the original row's status rather than posting a new entry.",
        ],
        gaps: [
          "Doesn't reason about what happens when the call to the card network times out — defaults to 'we retry' with no ambiguity handling.",
          "Ledger is a single mutable balance/status column, not a double-entry append-only journal.",
          "No saga/state-machine story for a crash mid-flow; assumes the request either fully completes or the client will just try again.",
          "No mention of PCI scope or where card numbers actually live.",
          "Fraud/risk mentioned only if asked, usually as 'add a fraud check' with no latency-budget reasoning.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, picks the idempotency and ledger patterns with reasons, and handles failure modes when the interviewer pushes on them.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Writes throughput, latency, and the 'zero loss / balances to the penny' invariant on the board within the first 5 minutes.",
          "Designs the Idempotency-Key + request-hash + in-flight lock pattern unprompted.",
          "Models the payment as an explicit state machine and explains why 2PC with the PSP is impossible.",
          "Uses a double-entry, append-only ledger and can state the sum(debits)==sum(credits) invariant.",
          "Mentions tokenization/PCI scope when asked about storing card data.",
          "Names fraud scoring's latency constraint and proposes warm precomputed features.",
        ],
        gaps: [
          "Volunteers the timeout-ambiguity problem only after the interviewer asks 'what if the call times out', not on their own.",
          "Doesn't bring up settlement-file reconciliation until asked how you'd catch a bug in the above.",
          "States the saga/idempotency ideas correctly but doesn't quantify the failure mode (e.g., how long in_doubt can persist, what triggers the reconciliation sweep).",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, names the timeout-ambiguity problem as the genuine hard part before being asked, and brings the operational and compliance maturity that separates a working design from a production one.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers 'did it go through' as the load-bearing hard problem of the whole system, unprompted, with the full resolution chain: in_doubt state → PSP status poll → settlement-file fallback.",
          "Frames reconciliation as a continuous safety net, not a one-off recovery step — it runs daily regardless of whether anything went wrong.",
          "Explicitly separates PCI scope reduction (vault, hosted fields, SAQ A vs SAQ D) as its own design axis, not folded into 'security'.",
          "Names the tier hierarchy explicitly: authorization is the only synchronous, latency-critical, must-be-correct path; everything else is best-effort or async by design.",
          "Pushes back on requirements ('does every ambiguous transaction need synchronous 3DS, or can more be async with a hold?').",
          "Closes with a one-sentence summary of the whole system and explicitly lists what they'd cover with more time (disputes, multi-PSP failover, AML/KYC).",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Storing money as a float or double anywhere in the pipeline — API payload, database column, or a currency conversion step.",
      "Treating a raw retry-and-hope as the solution to a client timeout, with no idempotency key or request-hash story.",
      "A ledger that's a single mutable balance column updated in place instead of an append-only double-entry journal.",
      "Storing raw card numbers (PANs) in the application database instead of tokenizing at a PCI-isolated vault.",
      "Blocking the authorization call on a synchronous webhook delivery to the merchant, or on a heavy fraud ML pipeline with cold features.",
      "No answer for 'what happens when the card network call times out' beyond 'we retry' — that ambiguity is the whole hard part of this problem.",
      "No reconciliation step against the bank's settlement file, so the ledger's truth is never checked against what actually moved.",
    ],
    followUps: [
      {
        q: "What happens if two retries of the same idempotency key arrive concurrently?",
        a: "The first request marks the record 'processing' and holds a lock before it calls the PSP. The second concurrent request with the same key sees the in-flight lock and either waits briefly for the first to finish (then returns its cached response) or gets a 409/425 telling the client to retry shortly. Once the first attempt completes, both requests converge on the same stored response — neither one independently reaches the card network.",
      },
      {
        q: "Why double-entry instead of a single balance column?",
        a: "A balance column has no audit trail — you can't reconstruct how it got to its current value, and two concurrent debits can both read the same stale value and both apply, silently losing one of them. Double-entry makes every movement a self-checking, balanced pair (debit one account, credit another), rows are never edited, and a refund is a new reversing row, so the full history is always reconstructable and sum(debits) always equals sum(credits) for verification.",
      },
      {
        q: "How do you avoid PCI DSS scope creep across the whole application?",
        a: "Card numbers never enter the application's own servers or database. A hosted card field or vault-hosted iframe sends the PAN directly to an isolated, network-segmented vault, which returns an opaque token. Every other component — orchestrator, ledger, risk engine — only ever handles that token; detokenization happens only inside the vault's own boundary at the moment of the PSP call. This keeps the audit scope to the vault (and the hosted field, which often qualifies for the lightest SAQ A assessment) instead of your entire stack.",
      },
      {
        q: "What if the reconciliation job finds a mismatch between your ledger and the bank's settlement file?",
        a: "That's treated as a hard alert, not a soft warning — it means the internal ledger and the actual movement of money disagree, which is exactly the failure mode the whole design is trying to prevent. The affected merchant's payouts are held pending investigation, the specific transactions are flagged for manual review, and the mismatch itself is logged as a correctness incident. This is why reconciliation runs daily as routine practice rather than only after an outage — it's the system's independent check on itself.",
      },
      {
        q: "How do you scale ledger writes to 20K/sec at peak without breaking the ACID invariant?",
        a: "Shard the ledger by account (or merchant), so serializable transactions only ever need to lock the accounts involved in a single payment, not the whole ledger. Use a database that gives strong per-shard consistency — a partitioned PostgreSQL cluster or a globally-consistent store like Spanner/CockroachDB — so each shard independently sustains its share of the write rate. Money movements between accounts in different shards use the same saga pattern as the PSP call: persist each leg, make it idempotent, and compensate on partial failure, rather than attempting a cross-shard distributed transaction.",
      },
      {
        q: "Why not just use a message queue with at-least-once delivery for the whole payment flow and skip the ledger's ACID guarantees?",
        a: "A queue guarantees a message gets delivered at least once; it says nothing about whether the money math ends up correct or whether 'did the charge happen' gets answered atomically with the state you record. You still need a synchronous, ACID-consistent decision point that says 'this charge happened, post these two balanced entries, now' — that's what the ledger transaction is for. The queue is exactly right for the parts that don't need atomicity with the charge itself, like notifying a merchant's webhook endpoint or streaming to reconciliation, which is why those run on the async lane while the ledger write stays synchronous.",
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
          "This is a distributed-transaction problem wearing a payments costume. Almost every hard decision in the system is a variation on the same question: does this authoritative external system (the card network, the bank) agree with my local state, and what do I do when I genuinely can't ask it right now? Idempotency keys, the saga, and reconciliation against the settlement file are three different answers to that one question at three different points in the flow.",
          "Anchor everything on the priority stated up front: correctness beats latency. 5,000 payments/sec sustained and a sub-500ms authorize budget matter, but they matter less than the ledger summing to $0.00 and a retry never double-charging a card. Every structural choice below exists to protect that invariant.",
        ],
      },
      {
        heading: "Money and the ledger",
        body: [
          "Amounts are stored as integers in the currency's minor unit — cents for USD, with the exponent varying per ISO 4217 currency (JPY=0, USD/EUR=2, BHD=3) — because floating point cannot represent most decimal fractions exactly and the rounding error compounds across millions of transactions.",
          "The ledger itself is double-entry and append-only: every movement of money is at least two balanced rows (debit one account, credit another), and a refund is a new reversing row rather than an edit to history. This is what makes sum(debits) == sum(credits) a continuously verifiable invariant instead of a hope, and what gives every dollar a full, auditable trail of how it moved.",
        ],
      },
      {
        heading: "Idempotency and the saga",
        body: [
          "On the client-facing side, an Idempotency-Key generated once per logical charge and stored with a hash of the request body makes retries safe: the same key and hash replay the cached response, a mismatched hash is rejected as a client error, and an in-flight processing lock stops two concurrent retries from both reaching the card network.",
          "Internally, the payment moves through an explicit, durably-persisted state machine (created → risk_checked → authorized → captured → settled) because you cannot wrap your own database and a third-party card network in one transaction. Persisting each state before firing the next external call, making every step itself idempotent, and defining compensating actions for partial failure is what lets a crash mid-flow resume correctly instead of losing or duplicating a charge.",
        ],
      },
      {
        heading: "The timeout-ambiguity problem",
        body: [
          "The hardest single failure mode: an authorize call to the card network times out before any response arrives, and you genuinely don't know if it succeeded. Assuming success risks giving away goods for a charge that never happened; assuming failure and retrying risks a real double charge.",
          "The resolution is to never guess: mark the payment in_doubt, poll the PSP's idempotent status endpoint (a safe-to-retry GET) to learn the true outcome, and if that's unreachable too, fall back to the next daily settlement file from the bank as ground truth. This is also why reconciliation runs continuously rather than only as an emergency recovery step — it's the system's independent check that the ledger matches what actually moved.",
        ],
      },
      {
        heading: "Fraud scoring and PCI scope",
        body: [
          "Risk scoring has to happen before authorization but inside a budget that the card-network round trip is already eating into, so the synchronous path is kept to warm, precomputed features (velocity counters, device fingerprint, IP reputation) and a fast rules/lightweight-model pass, with a three-way allow/block/step-up decision. A heavier model can re-score asynchronously after the fact; only the ambiguous middle band pays the extra latency of a 3DS challenge.",
          "Card numbers themselves are kept out of the application entirely: a PCI-isolated, network-segmented tokenization vault is the only component that ever touches a raw PAN, exchanging it for an opaque token at collection time (ideally via a hosted field that bypasses the application server altogether). Everything else — orchestrator, ledger, risk engine — only ever sees the token, which is what keeps the audit scope contained instead of covering the entire stack.",
        ],
      },
      {
        heading: "Async work and the tier hierarchy",
        body: [
          "Authorization is the only tier-1, synchronous, must-be-correct path. Webhook delivery to merchants and settlement-file reconciliation both run off an outbox (Kafka) fed by the orchestrator, are at-least-once and best-effort, and are explicitly allowed to lag or retry for hours without ever adding latency to a charge.",
          "That tier hierarchy is what justifies every trade-off in the design: it's why the ledger write is synchronous and ACID while the webhook is async and idempotent on the receiving end, and why reconciliation, the system's ultimate correctness backstop, is allowed to resolve discrepancies on a T+1 cadence instead of in real time.",
        ],
      },
    ],
  },
};
