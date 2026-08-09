import type { Problem } from "@/lib/types";

export const notificationSystem: Problem = {
  slug: "notification-system",
  num: "3.5",
  title: "Design a Notification System",
  level: "Medium",
  deepDiveAvailable: true,
  intro: [
    "Design a notification system that delivers push, email, SMS, and in-app notifications to 500M users, sustaining 1B notifications/day (~12K/sec average, 50K/sec peak during a breaking-news fan-out), with per-user rate limits and quiet hours, provider failover across independent third-party gateways, and at-least-once delivery without visible duplicate spam.",
  ],
  hardParts:
    "The hard parts: fanning a single publish call out to millions of recipients without melting the queue, guaranteeing at-least-once delivery per channel without duplicating sends on retry, and isolating transactional traffic (OTP, security alerts) from bulk marketing so a promo blast never delays a login code.",
  keyTopics: [
    "Idempotent Ingestion (Dedup Keys)",
    "Priority-Partitioned Queues",
    "Fan-out at Send Time",
    "Multi-Channel Gateway Abstraction",
    "Provider Failover & Circuit Breakers",
  ],
  foundationsReferenced: [
    { label: "Kafka", tone: "orange" },
    { label: "Idempotency Keys", tone: "green" },
    { label: "Token Bucket Rate Limiting", tone: "purple" },
    { label: "Exactly-Once Processing", tone: "orange" },
    { label: "Circuit Breakers", tone: "purple" },
    { label: "Cassandra / Wide-Column Stores", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "trigger", label: "Trigger Service", sub: "order, chat, marketing", col: 1, row: 1, tone: "slate" },
      {
        id: "api",
        label: "Notification API",
        sub: "ingest",
        mono: "idempotency key required",
        col: 2,
        row: 1,
        tone: "purple",
      },
      { id: "prefs", label: "Preference Service", sub: "opt-in · quiet hours", col: 2, row: 2, tone: "blue" },
      { id: "kafka", label: "Kafka", sub: "priority-partitioned topics", col: 3, row: 1, tone: "orange" },
      { id: "fanout", label: "Fan-out Worker", sub: "Flink · topic → user list", col: 3, row: 2, tone: "orange" },
      {
        id: "router",
        label: "Channel Router",
        sub: "push / email / sms / in-app",
        mono: "rate limit + backoff",
        col: 4,
        row: 1,
        tone: "orange",
      },
      { id: "push", label: "APNs / FCM", col: 5, row: 1, tone: "green" },
      { id: "emailgw", label: "SES / SendGrid", col: 5, row: 2, tone: "green" },
      { id: "smsgw", label: "Twilio", col: 5, row: 3, tone: "green" },
      { id: "status", label: "Delivery Status Store", sub: "Cassandra · receipts", col: 3, row: 3, tone: "purple" },
      { id: "client", label: "Client App", sub: "device + inbox", col: 1, row: 3, tone: "green" },
    ],
    edges: [
      { from: "trigger", to: "api", label: "POST /notify", kind: "write" },
      { from: "api", to: "prefs", label: "check opt-in / quiet hours", kind: "write" },
      { from: "api", to: "kafka", label: "publish, partitioned by priority", kind: "write" },
      { from: "kafka", to: "fanout", label: "consume", kind: "analytics" },
      { from: "fanout", to: "prefs", label: "resolve topic → user list", kind: "analytics" },
      { from: "fanout", to: "router", label: "per-user send job", kind: "analytics" },
      { from: "router", to: "push", label: "push channel", kind: "analytics" },
      { from: "router", to: "emailgw", label: "email channel", kind: "analytics" },
      { from: "router", to: "smsgw", label: "sms channel", kind: "analytics" },
      { from: "push", to: "client", label: "delivery", kind: "write" },
      { from: "push", to: "status", label: "delivery receipt", kind: "write" },
      { from: "emailgw", to: "status", label: "bounce / delivered webhook", kind: "write" },
      { from: "smsgw", to: "status", label: "delivery receipt", kind: "write" },
      { from: "client", to: "status", label: "GET /notifications history", kind: "read" },
    ],
    legend: [
      { kind: "read", text: "read path · client fetches notification/inbox history" },
      { kind: "write", text: "write path · ingest, gateway delivery, receipts" },
      { kind: "analytics", text: "async fan-out & dispatch pipeline · never blocks the ingest call" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Accept a notification request from any internal service via a single API", tag: "P0" },
      { id: "FR-02", text: "Support 4 channels: push (iOS/Android), email, SMS, and in-app", tag: "P0" },
      { id: "FR-03", text: "Idempotent ingestion: dedupe by a client-supplied idempotency key", tag: "P0" },
      { id: "FR-04", text: "Per-user preferences: channel opt-in/opt-out, quiet hours, per-topic mute", tag: "P0" },
      { id: "FR-05", text: "Priority tiers: transactional (OTP, security) never queues behind marketing", tag: "P0" },
      { id: "FR-06", text: "Fan-out to a topic or segment (e.g. 'all users in region X') from one publish call", tag: "P0" },
      { id: "FR-07", text: "Templating with variable substitution and per-user locale", tag: "P1" },
      { id: "FR-08", text: "Retry failed sends with exponential backoff and provider failover", tag: "P1" },
      { id: "FR-09", text: "Delivery status tracking: sent, delivered, opened, failed, per channel", tag: "P1" },
      { id: "FR-10", text: "Per-user rate limiting (e.g. max 1 marketing push per hour) to prevent spam", tag: "P1" },
      { id: "FR-11", text: "In-app notification inbox with read/unread state", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Ingestion API latency (ack that the event was accepted)", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "End-to-end delivery latency for transactional sends (e.g. OTP)", tag: "p95 < 5s" },
      { id: "NFR-03", text: "Sustained send throughput, with burst headroom", tag: "12K/s avg, 50K/s peak" },
      { id: "NFR-04", text: "Delivery guarantee for the transactional tier", tag: "zero silent loss" },
      { id: "NFR-05", text: "Duplicate-delivery rate on retried, idempotent sends", tag: "< 0.01%" },
      { id: "NFR-06", text: "System availability", tag: "99.95%" },
      { id: "NFR-07", text: "Fan-out completion time for a 10M-user segment", tag: "< 10 min" },
      { id: "NFR-08", text: "Failover time when a channel provider goes down", tag: "< 30s" },
      { id: "NFR-09", text: "Delivery-status freshness, send to dashboard/webhook", tag: "< 5s" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: the fan-out multiplier hides the real number",
      body: [
        "1B notifications/day sounds like the whole story, but it isn't. That number is messages sent, not API calls received. A single 'flash sale starts now' publish can turn into 10M individual sends in minutes. The two numbers that actually size the system are the ingestion rate (how many publish calls hit the API) and the send rate (how many individual channel deliveries come out the other end) — and the send rate can spike orders of magnitude above the ingestion rate during a broadcast.",
        "1B/day averages to about 11.6K sends/sec, but averages lie for bursty broadcast traffic. Size the fan-out worker and the channel gateways for the 50K/sec peak, not the daily average, and size the ingestion API separately — it only needs to handle publish calls, which are far rarer than individual sends.",
      ],
      bullets: [
        { lead: "Ingestion rate", text: "how many /notify calls arrive — low, maybe tens per second even at peak, because one call can target a segment of millions." },
        { lead: "Send rate", text: "how many individual channel deliveries actually go out — this is the number that sizes queues, workers, and gateway rate limits." },
        { lead: "Broadcast events", text: "a 10M-user segment fan-out is a 10M-message burst against a < 10 min completion SLA, which is what forces the fan-out worker to be horizontally scaled and queue-backed, not synchronous." },
      ],
      pictureTitle: "Ingestion rate vs. send rate",
      pictureCaption: "one publish call can become millions of sends — size for the send rate, not the call rate",
      pictureRows: [
        { label: "Ingestion (API calls)", value: "low — tens/sec even at peak", tone: "good" },
        { label: "Send rate (avg)", value: "~12K/sec (1B/day)", tone: "neutral" },
        { label: "Send rate (broadcast peak)", value: "~50K/sec, 10M-user segment in <10min", tone: "bad" },
      ],
      remember: {
        problem: "1B/day understates the real load because one API call can fan out to millions of sends.",
        solution: "Size the ingestion API for call volume and the fan-out/dispatch pipeline for send volume separately.",
        why: "Ingestion and delivery have completely different throughput profiles — conflating them undersizes the queue and gateways.",
        tradeoff: "Provisioning for peak send rate means idle capacity most of the day, but under-provisioning means a broadcast blows the 10-min SLA.",
        failure: "Sizing everything off the 12K/sec daily average leaves the fan-out worker unable to drain a 10M-user broadcast in time.",
        mitigation: "Autoscale the fan-out worker pool and channel gateways off queue depth, not off a fixed average-rate assumption.",
      },
    },
    {
      n: 2,
      title: "Fan-out at send time — there's no 'pull' option for push",
      body: [
        "This is the same fan-out-on-write vs. fan-out-on-read tradeoff as a news feed, except one side of the choice is gone: a push notification has to land on the device, which means it must be computed and dispatched at send time — there is no way to 'compute it lazily when the user opens the app', because the whole point is to reach them when the app is closed.",
        "So for push/email/SMS, fan-out-on-write is mandatory: the fan-out worker resolves a topic or segment into individual user IDs and enqueues one send job per user, immediately. The in-app inbox is the one channel where fan-out-on-read is a real option — store the topic subscription and materialize the list only when the user opens the inbox — which is worth calling out explicitly since it's the one place you get a choice.",
      ],
      bullets: [
        { lead: "Push/email/SMS", text: "fan-out-on-write only. The message must be dispatched now; there's no later read to compute it against." },
        { lead: "In-app inbox", text: "the one channel where fan-out-on-read is viable — the client fetches unread items by joining topic subscriptions with content at read time." },
        { lead: "Celebrity/broadcast case", text: "a 10M-user segment means the fan-out worker writes 10M individual jobs. Batch the resolution (page through user IDs) rather than materializing the whole list in memory at once." },
      ],
      pictureTitle: "Fan-out-on-write vs. fan-out-on-read, per channel",
      pictureRows: [
        { label: "Push / email / SMS", value: "fan-out-on-write — mandatory, no pull option", tone: "neutral" },
        { label: "In-app inbox", value: "fan-out-on-read viable — materialize at open time", tone: "good" },
        { label: "10M-user broadcast", value: "page the resolution, don't load all IDs at once", tone: "bad" },
      ],
      remember: {
        problem: "How do you fan a single publish call out to millions of recipients without blowing memory or the SLA?",
        solution: "Push/email/SMS always fan out on write, immediately; in-app inbox can optionally fan out on read.",
        why: "A push must land while the app is closed, so it can't be deferred to read time the way a feed item can.",
        tradeoff: "Fan-out-on-write means paying the full fan-out cost up front even if a recipient never opens the app.",
        failure: "Materializing a 10M-user segment into memory in one shot before enqueuing stalls the worker and risks OOM.",
        mitigation: "Page through the segment (cursor-based batches of ~10K user IDs) and stream jobs into the queue continuously.",
      },
    },
    {
      n: 3,
      title: "Idempotency: 'exactly-once' is a myth, at-least-once + dedupe is the real answer",
      body: [
        "Distributed systems cannot give you true exactly-once delivery across a network boundary you don't control — the client can't know if its request was lost before or after the server processed it, so it must retry, and the server must be able to tell 'this is a retry' from 'this is a new request'. The fix is at-least-once delivery plus idempotent processing: every publish call carries a client-generated idempotency key, and the API checks it in Redis before doing any work.",
        "The same problem recurs one layer down, inside the pipeline: if a fan-out worker crashes mid-batch and Kafka redelivers the message, or a channel gateway call times out and the caller retries, you must not double-text or double-charge-push-quota the user. Every send carries its own dedup key (idempotency key + user ID + channel), checked with a short TTL in Redis, so a retried send is a no-op rather than a duplicate.",
      ],
      bullets: [
        { lead: "Ingestion dedup", text: "client-supplied idempotency key, checked against Redis (SET NX with TTL) before the event is published to Kafka. A retried publish call is a no-op." },
        { lead: "Delivery dedup", text: "each individual send is keyed by (idempotency key, user, channel). If the gateway call times out and the worker retries, the dedup check stops a second SMS from going out." },
        { lead: "Why not rely on the provider", text: "APNs/FCM/Twilio don't dedupe for you — a timeout on your side doesn't mean the message didn't land on the other side. Assume it might have and dedupe locally." },
      ],
      pictureTitle: "At-least-once + dedupe = exactly-once-ish",
      pictureRows: [
        { label: "True exactly-once", value: "not achievable across an unreliable network", tone: "bad" },
        { label: "At-least-once + idempotency key", value: "retries are safe no-ops", tone: "good" },
        { label: "Dedup TTL", value: "short window (minutes-hours), not forever", tone: "neutral" },
      ],
      remember: {
        problem: "Guarantee at-least-once delivery without duplicate-spamming a user on retry.",
        solution: "Client-supplied idempotency keys checked at ingestion and again per-channel-send in Redis.",
        why: "Exactly-once isn't achievable across a network boundary; idempotent processing is what makes at-least-once safe to retry.",
        tradeoff: "Redis dedup adds a lookup on every send and a TTL you must size correctly — too short and a slow retry duplicates anyway.",
        failure: "Skipping delivery-level dedup means a timed-out gateway call retried by the worker can send the same SMS twice.",
        mitigation: "Key dedup on (idempotency key, user, channel), not just the top-level request, so per-channel retries are caught too.",
      },
    },
    {
      n: 4,
      title: "Priority isolation: why one Kafka topic is a design bug",
      body: [
        "A single shared queue means a marketing blast to 10M users sits in front of a password-reset OTP the moment both are in flight, because a FIFO queue doesn't know one message is worth $0 and the other is blocking a login. Partition by priority instead: transactional and marketing traffic go into separate Kafka topics (or partitions) with separate consumer groups and separate concurrency budgets, so a bulk send backlog physically cannot delay a transactional one.",
        "This is the single most-checked design decision in this problem, because it's cheap to say and easy to forget to actually implement — interviewers probe whether the isolation is structural (separate topics/queues, separate workers) or just a priority field on the same queue that nothing enforces.",
      ],
      bullets: [
        { lead: "Separate topics", text: "'notifications.transactional' and 'notifications.bulk', each with its own consumer group so bulk backlog can't starve transactional." },
        { lead: "Separate worker pools", text: "transactional workers are provisioned for headroom (low utilization, always ready); bulk workers can run closer to saturation and lag under load without breaking any SLA." },
        { lead: "A priority field on one queue", text: "is not isolation — a consumer still processes messages roughly in arrival order, so a huge bulk backlog still delays the transactional messages behind it." },
      ],
      pictureTitle: "Shared queue vs. partitioned-by-priority",
      pictureRows: [
        { label: "One topic + priority field", value: "bulk backlog still delays transactional — false isolation", tone: "bad" },
        { label: "Separate topics, separate consumers", value: "structural isolation, OTP never waits on marketing", tone: "good" },
        { label: "Transactional worker pool", value: "provisioned for headroom, low utilization by design", tone: "neutral" },
      ],
      remember: {
        problem: "Keep a marketing blast from delaying a password-reset OTP.",
        solution: "Structurally separate Kafka topics/consumer groups per priority tier, not a priority field on a shared queue.",
        why: "A single consumer processes roughly in arrival order — a field doesn't change queueing order, a separate topic does.",
        tradeoff: "More topics and worker pools to operate and monitor, and idle transactional capacity most of the time.",
        failure: "A shared queue with a 'priority' column lets a 10M-message bulk backlog delay OTP delivery past the 5s p95 SLA.",
        mitigation: "Route at publish time by tier; keep transactional workers over-provisioned and alert on their queue depth specifically.",
      },
    },
    {
      n: 5,
      title: "Multi-channel gateways: rate limits, circuit breakers, and failover",
      body: [
        "Push, email, and SMS each go through a different third-party provider (APNs/FCM, SES/SendGrid, Twilio), and every one of them has its own rate limits, its own outage patterns, and its own retry semantics. The Channel Router's job is to isolate the rest of the pipeline from any single provider's bad day: wrap each gateway call in a circuit breaker, retry with exponential backoff plus jitter, and — for providers that support it — failover to a secondary provider.",
        "A circuit breaker matters here specifically because a hanging provider (not erroring, just slow) can quietly consume every worker thread waiting on a timeout, which cascades into every channel backing up, not just the slow one. Trip the breaker on elevated error/latency, fail fast, and let queued messages wait in Kafka rather than in a blocked worker.",
      ],
      bullets: [
        { lead: "Per-provider rate limiting", text: "token bucket per provider account, sized to their documented ceiling (e.g. Twilio's per-number throughput), so you throttle yourself before they throttle you with a 429." },
        { lead: "Circuit breaker per gateway", text: "trip on elevated error rate or p99 latency; while open, fail fast and let the message sit in the queue instead of blocking a worker thread." },
        { lead: "Failover", text: "for channels with a viable second provider (e.g. a backup SMS aggregator), route around an open circuit automatically; for single-provider channels (APNs has no alternative for iOS), the failover is 'queue and retry', not 'switch providers'." },
        { lead: "Dead-letter queue", text: "after N retries with backoff, a permanently-failing send (bad token, invalid number) moves to a DLQ for inspection instead of retrying forever." },
      ],
      pictureTitle: "Isolating the pipeline from one bad provider",
      pictureRows: [
        { label: "Provider slow, no breaker", value: "worker threads block, all channels back up", tone: "bad" },
        { label: "Circuit breaker open", value: "fail fast, message waits in Kafka, other channels unaffected", tone: "good" },
        { label: "Retries exhausted", value: "moves to DLQ, doesn't retry forever", tone: "neutral" },
      ],
      remember: {
        problem: "One slow or down third-party provider shouldn't take down delivery on every channel.",
        solution: "Per-provider rate limiting, a circuit breaker per gateway, backoff-with-jitter retries, and a DLQ for permanent failures.",
        why: "A hanging (not erroring) provider call can silently consume every worker thread, cascading a single-channel outage into a system-wide one.",
        tradeoff: "Circuit breakers add operational complexity (thresholds to tune) and can trip on transient blips, temporarily reducing throughput.",
        failure: "No breaker means an APNs slowdown eventually exhausts the whole worker pool, delaying email and SMS too.",
        mitigation: "Isolate worker pools per channel in addition to the breaker, so a tripped push breaker can't starve email/SMS workers either.",
      },
    },
    {
      n: 6,
      title: "Preferences and rate limits are compliance, not just UX",
      body: [
        "Quiet hours, per-topic mute, and channel opt-out aren't nice-to-haves — for email and SMS specifically, they're legal requirements (CAN-SPAM, TCPA and similar regimes elsewhere), and an unsubscribe or opt-out has to take effect fast and be enforced before every single send, not just at signup. The Preference Service sits in the critical path of every fan-out job: before a message goes out, check the user's channel opt-in, topic mute, and quiet-hours window, and check per-user rate limits (e.g. max 1 marketing push/hour) with a token bucket.",
        "Quiet hours interact with time zones and with priority: a transactional OTP still needs to be delivered during 'quiet hours' — you can't lock a user out of their own login code because it's 2am for them. So the quiet-hours check applies to bulk/marketing traffic, not transactional, which is another instance of the priority-tier split showing up in a different subsystem.",
      ],
      bullets: [
        { lead: "Opt-out enforcement", text: "must be checked at send time, not cached from signup — an unsubscribe needs to block the very next send, which forces a fast (Redis-backed) preference lookup, not a slow batch sync." },
        { lead: "Quiet hours are tier-aware", text: "suppress bulk/marketing during a user's local night; never suppress transactional/security messages." },
        { lead: "Per-user rate limiting", text: "token bucket keyed by user + channel + tier, so 'max 1 marketing push/hour' doesn't also throttle a security alert." },
        { lead: "Bounce/complaint suppression", text: "a hard-bounced email address or a carrier-reported SMS complaint should auto-suppress future sends to that address, fed back from the delivery-status webhooks." },
      ],
      pictureTitle: "Preference checks that must happen at send time",
      pictureRows: [
        { label: "Opt-out check", value: "live lookup, blocks the very next send", tone: "good" },
        { label: "Quiet hours", value: "applies to bulk/marketing only, never transactional", tone: "neutral" },
        { label: "Rate limit", value: "token bucket per (user, channel, tier)", tone: "good" },
        { label: "Cached from signup only", value: "unsubscribe can still send one more message — non-compliant", tone: "bad" },
      ],
      remember: {
        problem: "Enforce opt-out, quiet hours, and rate limits without exempting transactional traffic incorrectly.",
        solution: "A live (Redis-backed) Preference Service check on every send, tier-aware so quiet hours never blocks transactional.",
        why: "Opt-out and consent rules (CAN-SPAM/TCPA-style) require enforcement at send time, not at signup or on a delayed batch sync.",
        tradeoff: "A live check on every send adds a lookup to the hot path of every single message, versus a cached/batched approach that's faster but non-compliant.",
        failure: "Caching preferences and syncing hourly means an unsubscribe can still receive up to an hour of further messages.",
        mitigation: "Keep the preference cache in Redis with short TTL / write-through on update so opt-out is visible within seconds.",
      },
    },
    {
      n: 7,
      title: "Storage split: Postgres for preferences, Cassandra for status",
      body: [
        "Preferences and delivery status have opposite access patterns, which is why they're two different stores. Preferences are low-volume (one row per user per topic), read on every send, and need strong consistency — an opt-out has to be visible immediately everywhere, which points to a relational store like Postgres with a Redis read-through cache in front for the hot path.",
        "Delivery status is the opposite: extremely high write volume (one row per send, per status transition — sent, delivered, opened, failed), append-mostly, and queried by recency or by user, which is the textbook case for a wide-column store like Cassandra — partition by user ID, cluster by timestamp, and let per-row TTL expire old receipts instead of running manual cleanup jobs.",
      ],
      bullets: [
        { lead: "Preferences → Postgres + Redis", text: "low volume, strong consistency needed for compliance, read-through cached because it's on the hot path of every send." },
        { lead: "Delivery status → Cassandra", text: "write-heavy (billions of rows/day), partitioned by user ID, clustered by timestamp, TTL'd — matches the append-only, time-ordered access pattern." },
        { lead: "Why not one store for both", text: "forcing status's write volume through a strongly-consistent relational store would require far more write capacity than the compliance-sensitive preference data actually needs." },
      ],
      pictureTitle: "Two stores, two access patterns",
      pictureRows: [
        { label: "Preferences", value: "low volume, strong consistency, Postgres + Redis cache", tone: "good" },
        { label: "Delivery status", value: "high write volume, append-only, Cassandra + per-row TTL", tone: "good" },
        { label: "One store for both", value: "over-provisions consistency for status, under-provisions durability semantics for prefs", tone: "bad" },
      ],
      remember: {
        problem: "Preferences need strong consistency; delivery status needs high write throughput. One store can't do both well.",
        solution: "Postgres + Redis cache for preferences; Cassandra (partition by user, cluster by time, TTL) for delivery status.",
        why: "The two datasets have opposite volume and consistency requirements — matching the store to the access pattern avoids paying for guarantees you don't need on one side.",
        tradeoff: "Operating two different storage systems instead of one, with different backup, scaling, and on-call playbooks.",
        failure: "Cramming billions of status rows/day into the same strongly-consistent store as preferences forces expensive write scaling you don't need for opt-out data.",
        mitigation: "Keep the two systems decoupled behind their respective services; delivery-status webhooks never touch the preference store.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's an async fan-out pipeline: ingest an event, expand it into per-user, per-channel send jobs, and dispatch through provider gateways — nothing here is synchronous end-to-end.",
      "Idempotency keys at ingestion and again at delivery are what turn 'at-least-once' into something safe to retry, since true exactly-once isn't achievable across a network boundary.",
      "Priority isolation (separate topics/consumer groups for transactional vs. bulk) is the single most-checked decision — a shared queue with a priority field is not real isolation.",
      "Every third-party gateway (APNs, SES, Twilio) gets its own rate limit, circuit breaker, and retry-with-backoff, because a hanging provider can otherwise stall every worker thread.",
      "Preferences (opt-out, quiet hours, rate limits) are checked live on every send, not cached from signup, because opt-out enforcement is a compliance requirement, not just UX.",
    ],
    flows: [
      {
        kind: "write",
        title: "WRITE (INGEST) · LOW VOLUME, SYNC ACK",
        summary:
          "A backend service publishes a notification request. The API checks the idempotency key, checks preferences, and publishes to the right priority topic — then acks immediately. Nothing about actual delivery happens synchronously.",
        steps: [
          { label: "Trigger Service", note: "order, chat, marketing system" },
          { label: "Notification API", note: "checks idempotency key in Redis" },
          { label: "Preference Service", note: "opt-in / quiet-hours check" },
          { label: "Kafka", note: "publish, partitioned by priority tier" },
          { label: "202 Accepted", note: "caller doesn't wait on delivery" },
        ],
      },
      {
        kind: "analytics",
        title: "ASYNC FAN-OUT & DISPATCH · 12K/S AVG, 50K/S PEAK",
        summary:
          "A worker consumes the event, resolves it into individual per-user send jobs (paged, not all at once for large segments), and routes each job to the right channel gateway with rate limiting and a circuit breaker.",
        steps: [
          { label: "Fan-out Worker", note: "topic/segment → paged user-ID batches" },
          { label: "Channel Router", note: "picks push/email/sms/in-app per user pref" },
          { label: "Per-provider rate limit + breaker", note: "token bucket, fail fast on open breaker" },
          { label: "APNs / FCM · SES / SendGrid · Twilio", note: "actual delivery" },
          { label: "Retry with backoff / DLQ", note: "on failure, up to N attempts, then DLQ" },
        ],
      },
      {
        kind: "read",
        title: "READ · STATUS & INBOX",
        summary:
          "Clients poll or receive webhooks for delivery status, and the in-app inbox is read (and can be fanned-out-on-read) separately from the push/email/SMS pipeline.",
        steps: [
          { label: "Client App", note: "GET /notifications history" },
          { label: "Delivery Status Store", note: "Cassandra, partitioned by user, TTL'd" },
          { label: "Gateway webhooks", note: "delivered/bounced/opened feed status back" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "500M users, 1B sends/day ≈ 12K/sec average",
          "Broadcast peak: 10M-user segment fanned out in < 10 min ⇒ ~50K/sec",
          "Ingestion API latency p99 < 200ms; transactional delivery p95 < 5s",
          "Duplicate-delivery rate on retried sends < 0.01%",
          "Delivery-status freshness < 5s; provider failover < 30s",
          "Dedup TTL: minutes-to-hours, not forever",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "At-least-once delivery + idempotency keys, not a claim of exactly-once",
          "Separate Kafka topics/consumer groups per priority tier, not a priority field",
          "Fan-out-on-write for push/email/SMS; fan-out-on-read is viable only for the in-app inbox",
          "Circuit breaker + rate limit + backoff per third-party gateway, isolated worker pools per channel",
          "Postgres + Redis for preferences (strong consistency); Cassandra for delivery status (write-heavy, TTL'd)",
          "Live preference check on every send, never cached-from-signup",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Ingestion rate vs. send rate are different numbers — size the pipeline off send rate",
          "Quiet hours suppress bulk/marketing only, never transactional/security sends",
          "A hanging (not erroring) provider call can exhaust a shared worker pool without a circuit breaker",
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
      goal: "Separate ingestion rate from send rate before anything else, and lock the priority-tier split. These two facts drive every later decision.",
      why: "This problem is easy to undersize by conflating 'notifications per day' with 'API calls per day'. The interviewer wants to see you catch the fan-out multiplier before you start drawing boxes.",
      steps: [
        { kind: "ASK", text: '**"What channels, and what\'s the daily volume?"** Land on push, email, SMS, in-app, and **"1B sends/day"**. Write **"1B/day ≈ 12K/s avg"** on the board.' },
        { kind: "ASK", text: 'Push on the number: **"Is that 1B API calls, or 1B individual deliveries?"** Get them to confirm it\'s deliveries — one publish can fan out to millions. Write **"fan-out multiplier"** next to the throughput line.' },
        { kind: "SAY", text: 'Propose the priority split yourself: **"transactional (OTP, security) vs. bulk/marketing"**, and state the requirement: **"transactional must never queue behind bulk."** Wait for a nod.' },
        { kind: "SAY", text: 'State scope. In: "ingestion, preferences, fan-out, multi-channel dispatch, delivery status." Out: "template design/authoring UI, push-token registration flow, billing." "Let me know if you want me to expand any of those."' },
        { kind: "WRITE", text: 'Write the peak case: **"10M-user segment broadcast, < 10 min completion ⇒ ~50K/s peak"**. This is the number that sizes the fan-out worker pool, not the daily average.' },
      ],
      grading: "Did you separate ingestion rate from send rate unprompted, and lock the transactional-vs-bulk priority split before moving to the API?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "One ingestion endpoint with a mandatory idempotency key, and two data models (preferences, delivery status) with visibly different shapes.",
      why: "The interviewer is checking whether idempotency is designed in from the API surface, not bolted on later, and whether you already sense that preferences and status need different stores.",
      steps: [
        { kind: "WRITE", text: 'Write the endpoint: **"POST /notify { idempotencyKey, priority, channel[], target: {userId | topic}, template, vars }"** returns **"202 { requestId }"**. Say: "The idempotency key is mandatory, not optional — that\'s what makes retries safe."' },
        { kind: "DRAW", text: 'Sketch the preference row: **"user_id, channel, opted_in, quiet_hours_window, topic_mutes"**. Say: "Low volume, read on every send, needs strong consistency — Postgres plus a Redis read-through cache."' },
        { kind: "DRAW", text: 'Sketch the status row: **"(user_id, sent_at) PK/clustering, channel, status, provider_id"**. Say: "High write volume, append-only, TTL\'d — this is Cassandra, partitioned by user, clustered by time."' },
        { kind: "RULE OUT", text: 'Get ahead of it: "One store for both would force status\'s write volume through preference-grade consistency, which is over-provisioning I don\'t need." Cross off "single relational store for everything."' },
      ],
      grading: "Idempotency key present in the API from the start, and two clearly different storage shapes justified by access pattern, not just named.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three paths)",
      minutes: 10,
      goal: "One diagram with ingest (write), async fan-out/dispatch (background), and status/inbox (read) as three visibly separate lanes.",
      why: "Same signal as any fan-out system: candidates who draw one blob miss that ingestion must ack fast while delivery happens on its own schedule, potentially minutes later for a large segment.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **write/ingest lane**: Trigger Service → Notification API → Preference Service (check) → Kafka (priority-partitioned) → 202 ack. Label it **"caller never waits on delivery."**' },
        { kind: "DRAW", text: 'Add the **async fan-out lane**: Kafka → Fan-out Worker (resolves topic → paged user list) → Channel Router (rate limit + breaker) → APNs/FCM, SES/SendGrid, Twilio.' },
        { kind: "DRAW", text: 'Add the **read lane**: Client App → GET /notifications → Delivery Status Store (Cassandra), fed by delivery-receipt webhooks from each gateway.' },
        { kind: "SAY", text: 'Narrate the split: "Ingest is synchronous and cheap because it only publishes an event; the expensive part — resolving millions of recipients and calling three different third-party APIs — is fully async and never blocks the caller."' },
      ],
      grading: "Three clearly separated lanes, the fan-out worker explicitly shown resolving segments in the async lane, and an explicit statement that ingestion never waits on delivery.",
    },
    {
      n: 4,
      title: "Deep Dive: Fan-out and Priority Isolation",
      minutes: 8,
      goal: "Explain fan-out-on-write vs. fan-out-on-read per channel, and defend structural priority isolation over a priority field.",
      why: "This is the signature sub-problem. The interviewer wants to hear that you know push/email/SMS have no 'lazy compute at read time' option, and that a priority field on a shared queue is not real isolation.",
      steps: [
        { kind: "SAY", text: '"Push, email, and SMS must fan out on write — there\'s no read event to compute them lazily against, unlike a news feed. The in-app inbox is the one channel where fan-out-on-read is viable."' },
        { kind: "SAY", text: '"For a 10M-user segment, the fan-out worker pages through user IDs in batches rather than materializing the whole list in memory, to avoid OOM and to keep the < 10 min completion SLA."' },
        { kind: "DRAW", text: 'Draw two Kafka topics: **"notifications.transactional"** and **"notifications.bulk"**, each with its own consumer group. Say: "Structural separation — a bulk backlog physically cannot delay a transactional consumer."' },
        { kind: "RULE OUT", text: '"A priority field on one shared topic doesn\'t change queueing order for a single consumer — a huge bulk backlog still sits in front of the next transactional message." Cross it off.' },
      ],
      grading: "Fan-out-on-write correctly framed as mandatory for push/email/SMS, and priority isolation defended as structural (separate topics/consumer groups), not a field.",
    },
    {
      n: 5,
      title: "Deep Dive: Idempotency, Retries, and Provider Failover",
      minutes: 7,
      goal: "Walk dedup at two layers (ingestion and per-channel-send), then the circuit-breaker/rate-limit story per gateway.",
      why: "The interviewer is probing whether you understand exactly-once isn't achievable, and whether you've thought about what happens when one specific third-party provider — not the whole system — has a bad day.",
      steps: [
        { kind: "SAY", text: '"True exactly-once isn\'t achievable across a network boundary. The real target is at-least-once delivery plus idempotent processing, so a retry is a safe no-op instead of a duplicate."' },
        { kind: "SAY", text: '"Dedup happens twice: once at ingestion on the idempotency key, and again per send on (idempotency key, user, channel) — because a timed-out gateway call might have actually succeeded on their side."' },
        { kind: "SAY", text: '"Each gateway — APNs, SES, Twilio — gets its own rate limiter, circuit breaker, and backoff-with-jitter retry. A hanging call, not just an erroring one, can exhaust a shared worker pool if there\'s no breaker."' },
        { kind: "SAY", text: '"After N retries a send moves to a dead-letter queue instead of retrying forever — a bad push token or invalid phone number isn\'t going to start working on retry 50."' },
      ],
      grading: "Explicitly states exactly-once is not achievable, dedup described at both layers, and circuit breakers justified by the 'hanging call exhausts the pool' failure mode, not just 'handles errors'.",
    },
    {
      n: 6,
      title: "Wrap: Compliance, Bottlenecks, and Close",
      minutes: 5,
      goal: "Bring up preference enforcement as a compliance requirement, name the storage split, and close with a summary plus parked items.",
      why: "Staff-level signal here is recognizing that opt-out/quiet-hours aren't just UX — they're legal requirements with a 'must take effect on the next send' bar — plus the operational maturity to close cleanly.",
      steps: [
        { kind: "SAY", text: '"Opt-out and quiet hours are checked live on every send, not cached from signup — an unsubscribe has to block the very next message, which regimes like CAN-SPAM and TCPA effectively require."' },
        { kind: "SAY", text: '"Quiet hours only suppress bulk/marketing — a transactional OTP still has to reach the user at 2am, or they can\'t log in."' },
        { kind: "SAY", text: 'Name the storage split unprompted: "Postgres+Redis for preferences because of consistency needs, Cassandra for delivery status because of write volume — different access patterns, different stores."' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s an async fan-out pipeline with structural priority isolation and per-provider failure isolation. With more time I\'d cover template authoring, push-token lifecycle, and cross-region failover of Kafka itself."' },
      ],
      grading: "Compliance framing for preferences volunteered unprompted, the storage split justified by access pattern, and a crisp close with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working pipeline with a queue and a worker, but priority, idempotency, and provider isolation stay shallow or unmentioned.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Draws API → queue → worker → channel gateways, the right shape at a coarse level.",
          "Knows to use a message queue (Kafka/SQS) between ingestion and delivery.",
          "Mentions retries on failure when prompted.",
          "Adds a preferences table when asked about user settings.",
          "Names the right third-party providers (APNs/FCM, SES/Twilio) when asked.",
        ],
        gaps: [
          "Doesn't separate ingestion rate from send rate — sizes everything off the daily average.",
          "Priority is a field on one queue, not structurally separate topics/consumer groups.",
          "No idempotency key at either the ingestion or delivery layer; retries can duplicate sends.",
          "No circuit breaker or per-provider isolation — assumes 'retry with backoff' covers a provider outage.",
          "Preferences treated as a UX nicety, not checked live or framed as a compliance requirement.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design end-to-end, separates the two throughput numbers, and builds real priority and provider isolation without being prompted.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Distinguishes ingestion rate from send rate in the first five minutes.",
          "Structurally isolates transactional from bulk traffic (separate Kafka topics/consumer groups).",
          "Designs idempotency keys into the API and mentions delivery-level dedup when asked.",
          "Puts a circuit breaker and rate limiter on each third-party gateway.",
          "Correctly frames push/email/SMS as fan-out-on-write-only, in-app inbox as fan-out-on-read-viable.",
          "Picks different stores for preferences vs. delivery status and gives a reason for each.",
          "Names quiet hours as tier-aware (bulk only, never transactional) when asked.",
        ],
        gaps: [
          "Volunteers delivery-level (not just ingestion-level) dedup only after being pushed on retries.",
          "Doesn't proactively frame preference enforcement as a compliance requirement until asked 'why does this matter legally'.",
          "Quantifies the fan-out burst in words ('it gets big') rather than numbers ('10M users in <10 min ⇒ ~50K/s').",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, surfaces the fan-out multiplier and the compliance angle before being asked, and reasons about failure modes at the level of individual providers.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "States unprompted that 'exactly-once' isn't achievable and frames the real target as at-least-once plus idempotent processing.",
          "Volunteers the ingestion-rate-vs-send-rate distinction before being asked, with the fan-out multiplier quantified.",
          "Identifies the 'hanging call exhausts the worker pool' failure mode as the reason for a circuit breaker, not just 'handles provider errors'.",
          "Frames preference/quiet-hours enforcement explicitly as compliance-driven (opt-out must take effect on the next send), not UX.",
          "Distinguishes fan-out-on-write (mandatory for push/email/SMS) from fan-out-on-read (viable only for in-app inbox) unprompted.",
          "Pushes back on requirements where useful ('do we need per-user rate limits, or per-topic — that changes the token bucket key').",
          "Closes with a one-sentence summary and an explicit parked-items list.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Treating '1B/day' as the send-rate ceiling without noticing that a single broadcast call can multiply that by orders of magnitude in a burst.",
      "A priority field on one shared Kafka topic, presented as if it isolates transactional traffic from bulk — it doesn't change consumer processing order.",
      "No idempotency key anywhere, so 'we retry on failure' is actually 'we sometimes double-send on failure'.",
      "Retrying a hung provider call without a circuit breaker, letting one slow gateway exhaust the shared worker pool and take down every channel.",
      "Caching user preferences from signup and syncing on a batch job, so an unsubscribe can still receive more messages for up to the sync interval.",
      "Suppressing all notifications during quiet hours, including transactional — locking a user out of their own OTP at night.",
      "Putting delivery status in the same strongly-consistent store as preferences, ignoring that status is orders of magnitude higher write volume.",
    ],
    followUps: [
      {
        q: "How would you handle a celebrity/broadcast event — a push to 10M users at once?",
        a: "The fan-out worker pages through the segment in cursor-based batches (e.g. 10K user IDs at a time) instead of materializing the full list in memory, streaming send jobs into the channel-specific queues continuously. The worker pool autoscales off queue depth so the < 10 min completion SLA holds. Transactional traffic stays completely unaffected because it's on a structurally separate topic and consumer group — the broadcast can only ever back up the bulk lane.",
      },
      {
        q: "What happens if the idempotency-key dedup check itself fails or the Redis node holding it is down?",
        a: "You have two bad options and want the safer one: fail the dedup check open (allow the send through, risking a rare duplicate) or fail closed (reject the request, risking a rare missed transactional send). For most channels, fail open — a duplicate push is annoying but recoverable; for anything billed per-send (SMS) you might fail closed and surface an error to the caller. Either way, Redis for dedup should be a small, replicated, low-latency deployment specifically because it's on the hot path of every single send.",
      },
      {
        q: "Why not just use one queue with message priority levels instead of separate Kafka topics?",
        a: "A single consumer (or consumer group) still processes messages roughly in the order they're pulled, so a large low-priority backlog sitting ahead of a high-priority message in the same partition still delays it — the priority field doesn't reorder an already-queued backlog mid-flight. Separate topics with separate consumer groups give you structural isolation: a transactional consumer group only ever sees transactional messages, so its lag is independent of how backed up the bulk lane is.",
      },
      {
        q: "How do you prevent a user from being spammed if multiple services fire notifications about the same underlying event?",
        a: "Two mechanisms compound: idempotency keys catch exact duplicate publishes (same key, same content), and per-user rate limiting (token bucket keyed by user + channel + tier) caps how many distinct messages a user can receive in a window regardless of source. For a genuinely duplicate scenario — two services both notifying about the same order update — you'd also want a dedup key derived from the event's business identity (e.g. order_id + status), not just a random idempotency key, so two different services triggering the same logical notification collapse into one send.",
      },
      {
        q: "Why is delivery status eventually consistent, and is that okay?",
        a: "Delivery status comes from asynchronous provider webhooks (APNs feedback, SES bounce notifications, Twilio delivery receipts) that arrive seconds after the send, so there's an inherent window where a message shows 'sent' but not yet 'delivered'. That's acceptable because nothing in the system blocks on delivery confirmation — the < 5s freshness NFR is about dashboard/webhook visibility, not about gating any further action, so eventual consistency here doesn't compromise correctness anywhere else.",
      },
      {
        q: "How would you extend this to support scheduled/delayed notifications (e.g. 'remind me in 2 hours')?",
        a: "Add a scheduling layer between ingestion and Kafka: instead of publishing immediately, the API writes the request into a time-indexed store (e.g. a Cassandra table clustered by send_at, or a delay-queue feature if the broker supports it) and a scheduler service polls for due items and publishes them into the normal priority-partitioned topics at the right time. The rest of the pipeline — fan-out, dedup, channel dispatch — is unchanged; scheduling only affects when the event enters the existing flow, not how it's processed once it does.",
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
          "This is an async fan-out pipeline with a compliance-sensitive control plane bolted on. The core operation — turn one publish call into the right set of individual channel deliveries — is fundamentally a background job, not a request/response call, and everything expensive (fan-out, provider isolation, rate limiting) exists to make that background job fast, safe to retry, and legally compliant at 50K sends/sec peak.",
          "Anchor everything on the split between ingestion rate (low, tens/sec) and send rate (12K/sec average, 50K/sec broadcast peak). Conflating the two is the most common sizing mistake in this problem, and every structural choice below — separate priority topics, paged fan-out, per-provider isolation — is a direct consequence of that split.",
        ],
      },
      {
        heading: "Ingestion: idempotent by construction",
        body: [
          "The Notification API accepts a mandatory client-supplied idempotency key on every request, checks it against Redis before doing any work, checks the sender's basic preferences, and publishes to a Kafka topic partitioned by priority tier — then acks with 202 immediately. Ingestion is deliberately the cheap, synchronous part of the system; it does no fan-out and no delivery.",
          "True exactly-once delivery is not achievable across a network boundary you don't control, so the design target is at-least-once delivery made safe by idempotent processing at two layers: once at ingestion (the idempotency key), and again per individual send (idempotency key + user + channel), because a timed-out gateway call might have actually succeeded on the provider's side.",
        ],
      },
      {
        heading: "Fan-out: on-write is mandatory, on-read is a rare luxury",
        body: [
          "Push, email, and SMS have no analog to 'compute lazily when the user opens the app' — a push must land while the app is closed, so the fan-out worker resolves a topic or segment into individual per-user send jobs immediately, at publish time. For a large segment (10M users), the worker pages through user IDs in bounded batches rather than materializing the full list, to hit the < 10 min completion SLA without risking memory exhaustion.",
          "The in-app inbox is the one channel where fan-out-on-read is a real option: store the topic subscription and materialize unread items only when the client opens the inbox. Naming this distinction — mandatory fan-out-on-write everywhere except the one channel where fan-out-on-read is viable — is the core of the fan-out sub-problem.",
        ],
      },
      {
        heading: "Priority isolation as a structural property",
        body: [
          "Transactional traffic (OTP, security alerts) and bulk/marketing traffic are structurally separated into different Kafka topics with different consumer groups and different worker pools, not distinguished by a priority field on a shared queue. A field doesn't change how a single consumer processes a backlog; a separate topic does — a 10M-message marketing backlog physically cannot delay a transactional consumer that's reading from a different topic entirely.",
          "Transactional worker pools are deliberately over-provisioned for headroom (low utilization most of the time, always ready to absorb a burst), while bulk worker pools can run near saturation and lag under load without violating any SLA, because bulk/marketing has no hard latency requirement.",
        ],
      },
      {
        heading: "Provider isolation: rate limits, breakers, failover, DLQ",
        body: [
          "Each third-party gateway — APNs/FCM, SES/SendGrid, Twilio — gets its own token-bucket rate limiter sized to that provider's documented ceiling, its own circuit breaker tripped on elevated error rate or p99 latency, and its own retry policy with exponential backoff and jitter. The specific failure mode this defends against is a hanging (not erroring) provider call quietly consuming every worker thread across all channels, not just the slow one — which is why worker pools are also isolated per channel, in addition to the breaker.",
          "Where a viable second provider exists, an open circuit routes to it automatically; where it doesn't (APNs has no substitute for iOS), the failover is simply 'queue and retry' rather than 'switch providers'. After a bounded number of retries, a permanently-failing send (invalid token, bad phone number) moves to a dead-letter queue for inspection instead of retrying forever.",
        ],
      },
      {
        heading: "Preferences, quiet hours, and why they're compliance, not UX",
        body: [
          "The Preference Service sits in the critical path of every fan-out job, checked live rather than cached from signup, because opt-out enforcement in regimes like CAN-SPAM and TCPA requires that an unsubscribe take effect on the very next send. Quiet hours suppress bulk/marketing traffic during a user's local night but never transactional traffic — a security OTP still has to reach the user regardless of the hour, which is the priority-tier split showing up again in a different subsystem.",
          "Storage follows the access pattern split: preferences are low-volume, read on every send, and need strong consistency, so they live in Postgres with a Redis read-through cache for the hot path; delivery status is extremely high write volume and append-only, so it lives in Cassandra, partitioned by user and clustered by time with per-row TTL. Forcing both through one store means over-paying for consistency on one side or under-paying for durability semantics on the other.",
        ],
      },
    ],
  },
};
