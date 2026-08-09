import type { Problem } from "@/lib/types";

export const multiTenantSaas: Problem = {
  slug: "multi-tenant-saas",
  num: "4.4",
  title: "Design a Multi-Tenant SaaS Platform",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a multi-tenant SaaS platform that serves 50,000 tenants ranging from 3-person startups to enterprise accounts with 20M end users, sustains 200K API requests/sec across the fleet with p99 latency independent of tenant size, guarantees zero cross-tenant data leakage, and lets a new tenant sign up and start using the product in under 30 seconds.",
  ],
  hardParts:
    "The hard parts: enforcing airtight data isolation between tenants sharing the same infrastructure, stopping one tenant's traffic spike from degrading everyone else (the noisy-neighbor problem), and rolling out schema changes across thousands of tenants without downtime or per-tenant drift.",
  keyTopics: [
    "Pooled vs Siloed Tenancy",
    "Row-Level Security (RLS)",
    "Noisy-Neighbor Bulkheads",
    "Tenant-Aware Sharding",
    "Zero-Downtime Multi-Tenant Migrations",
  ],
  foundationsReferenced: [
    { label: "PostgreSQL Row-Level Security", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "PgBouncer / Connection Pooling", tone: "purple" },
    { label: "Token Bucket Rate Limiting", tone: "green" },
    { label: "Kafka", tone: "orange" },
    { label: "Expand-Contract Migrations", tone: "purple" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "client", label: "Client", sub: "tenant.acme.app", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "API Gateway", sub: "resolves tenant_id", col: 2, row: 1, tone: "slate" },
      { id: "limiter", label: "Rate Limiter", sub: "per-tenant token bucket", col: 2, row: 2, tone: "green" },
      {
        id: "app",
        label: "App Service",
        sub: "stateless · 200K req/s",
        mono: "AsyncLocal tenant_id set per request",
        col: 3,
        row: 1,
        tone: "green",
      },
      { id: "directory", label: "Tenant Directory", sub: "tenant_id → shard, tier, region", col: 3, row: 2, tone: "purple" },
      { id: "redis", label: "Redis", sub: "tenant-namespaced keys", col: 4, row: 1, tone: "green" },
      { id: "pooled_db", label: "Pooled Postgres", sub: "shared schema · RLS · long tail", col: 5, row: 1, tone: "blue" },
      { id: "silo_db", label: "Siloed Postgres", sub: "dedicated · whale tenants", col: 5, row: 2, tone: "blue" },
      { id: "onboarding", label: "Onboarding Service", sub: "provisions tenant + schema/DB", col: 2, row: 3, tone: "purple" },
      { id: "kafka", label: "Kafka", sub: "usage & audit events", col: 3, row: 3, tone: "orange" },
      { id: "metering", label: "Metering / Billing", sub: "per-tenant usage rollups", col: 4, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "client", to: "gateway", kind: "read" },
      { from: "gateway", to: "limiter", label: "per-tenant bucket", kind: "read" },
      { from: "limiter", to: "app", label: "allowed only", kind: "read" },
      { from: "app", to: "directory", label: "tenant_id → shard", kind: "read" },
      { from: "app", to: "redis", label: "tenant-namespaced", kind: "read" },
      { from: "app", to: "pooled_db", label: "SET LOCAL + RLS", kind: "read" },
      { from: "app", to: "silo_db", label: "whale tier", kind: "read" },
      { from: "client", to: "onboarding", label: "signup", kind: "write" },
      { from: "onboarding", to: "directory", label: "register tenant", kind: "write" },
      { from: "onboarding", to: "pooled_db", label: "provision rows", kind: "write" },
      { from: "onboarding", to: "silo_db", label: "provision dedicated DB", kind: "write" },
      { from: "app", to: "kafka", label: "async, never blocks", kind: "analytics" },
      { from: "kafka", to: "metering", label: "at-least-once", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "read path · 200K req/s, tenant-isolated at every hop" },
      { kind: "write", text: "onboarding / provisioning path" },
      { kind: "analytics", text: "usage metering · async, at-least-once, funds the bill" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Tenant signup provisions an isolated workspace automatically", tag: "P0" },
      { id: "FR-02", text: "Every request resolves to a tenant_id via subdomain or JWT claim before touching any data", tag: "P0" },
      { id: "FR-03", text: "Row-level data isolation: a query scoped to tenant A can never return tenant B's rows", tag: "P0" },
      { id: "FR-04", text: "Tiered plans (Free / Pro / Enterprise) with different quotas and isolation guarantees", tag: "P0" },
      { id: "FR-05", text: "Usage metering per tenant (API calls, storage, seats) for billing", tag: "P0" },
      { id: "FR-06", text: "Per-tenant customization: feature flags, branding, custom fields", tag: "P1" },
      { id: "FR-07", text: "Zero-downtime schema migrations rolled out across all tenants", tag: "P1" },
      { id: "FR-08", text: "Tenant data export and hard delete (GDPR right to be forgotten)", tag: "P1" },
      { id: "FR-09", text: "Data residency: EU tenants' data stays in an EU region", tag: "P1" },
      { id: "FR-10", text: "Self-service upgrade from pooled to dedicated (siloed) tier", tag: "P2" },
      { id: "FR-11", text: "Admin console with tenant impersonation and a full audit trail", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "API latency, independent of which tenant is calling", tag: "p99 < 200ms" },
      { id: "NFR-02", text: "Cross-tenant data leakage tolerance", tag: "zero leaks" },
      { id: "NFR-03", text: "Platform availability", tag: "99.95%" },
      { id: "NFR-04", text: "One tenant's traffic spike must not degrade another tenant's p99", tag: "< 5% impact" },
      { id: "NFR-05", text: "New tenant provisioned and usable end-to-end", tag: "< 30s" },
      { id: "NFR-06", text: "Tenants supported on the pooled + siloed hybrid model", tag: "50K tenants" },
      { id: "NFR-07", text: "Sustained platform-wide request throughput", tag: "200K/sec" },
      { id: "NFR-08", text: "Storage per pooled shard before a rebalance triggers", tag: "~500GB/shard" },
      { id: "NFR-09", text: "Usage metering freshness, API call to billing dashboard", tag: "< 5 min" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: the power-law tenant distribution",
      body: [
        "Before picking an isolation model, look at the shape of the tenant base. It is not uniform: a handful of whale tenants (enterprise accounts with millions of end users) dominate storage and traffic, while tens of thousands of small tenants each use almost nothing. Roughly the top 100 tenants (about 0.2% of the base) hold ~40% of all data; the remaining ~49,900 tenants share the other ~60%. That shape, not a preference, is what forces a hybrid infrastructure model instead of picking one architecture for everyone.",
      ],
      bullets: [
        { lead: "Pure database-per-tenant", text: "gives every tenant a dedicated database. Strong isolation, but 50,000 databases to patch, monitor, and back up individually is an operational disaster, and most small tenants use under 1% of a dedicated DB's capacity. Rejected for the long tail." },
        { lead: "Pure shared everything", text: "puts every tenant in one shared database. A whale tenant's 20M-row table sits next to a 3-person startup's 200-row table on the same shard, so the whale's backup, vacuum, and traffic pattern degrades every small neighbor. Rejected for whales." },
        { lead: "Hybrid: pooled + siloed tiers", text: "pool the long tail behind shared, RLS-enforced Postgres shards, and give the small number of whale tenants their own dedicated database. Infra cost tracks the actual power-law shape of the tenant base instead of one size fitting none. Winner." },
      ],
      pictureTitle: "Where does the data actually live?",
      pictureCaption: "~100 whale tenants get dedicated DBs · ~49,900 pooled tenants share RLS-enforced shards",
      pictureRows: [
        { label: "Top ~100 tenants (whales)", value: "~40% of rows, dedicated silo DB each", tone: "used" },
        { label: "Remaining ~49,900 tenants", value: "~60% of rows, pooled shared-schema shards", tone: "good" },
        { label: "Pure DB-per-tenant for everyone", value: "50K DBs to patch/backup, most <1% utilized", tone: "bad" },
      ],
      remember: {
        problem: "One infra model can't fit both a 3-person startup and a 20M-user enterprise account.",
        solution: "Hybrid tenancy: pool the long tail on shared RLS-enforced shards, silo the whale tenants on dedicated DBs.",
        why: "Tenant size follows a power law — a tiny fraction of tenants hold most of the data, so cost and isolation needs diverge sharply between the two groups.",
        tradeoff: "You now run and operate two different tenancy models instead of one, plus a promotion path between them.",
        failure: "Force everyone into one shared DB and a whale's load pattern degrades thousands of small tenants at once.",
        mitigation: "Size the pooled/siloed split from real usage data, not guesswork, and keep the boundary a continuous decision, not a one-time launch choice.",
      },
    },
    {
      n: 2,
      title: "Isolation models for the pooled tier: kill two, defend one",
      body: [
        "Inside the pooled tier, thousands of tenants share the same Postgres shard. There are three classic ways to structure that sharing. Put them on the board and rule two out before committing to the third — the interviewer wants to see you've felt the operational cost of each, not just named them.",
      ],
      bullets: [
        { lead: "Database-per-tenant", text: "already ruled out in the sizing step for the long tail — strongest isolation, but 50,000 databases is unmanageable at this scale. Reserved for whale tenants only." },
        { lead: "Schema-per-tenant", text: "one Postgres schema per tenant inside a shared database — namespaced tables, no cross-tenant query is even possible. Looks attractive, but Postgres catalog bloat past roughly 10,000 schemas slows the planner and pg_dump, and a single migration means running the same DDL 50,000 times. Rejected." },
        { lead: "Shared schema + tenant_id column", text: "one set of tables for everyone, every row carries a tenant_id, every index leads with it. A migration runs exactly once. Winner for the pooled tier — but now the isolation guarantee has moved from 'the database structurally can't see the other tenant's table' to 'every single query must remember to filter by tenant_id.' That shift is the vulnerability the next teardown closes." },
      ],
      pictureTitle: "Three isolation models, one survivor",
      pictureRows: [
        { label: "Database-per-tenant", value: "50K DBs → ops disaster (reserved for whales)", tone: "bad" },
        { label: "Schema-per-tenant", value: "catalog bloat + 50K-way migration fan-out → reject", tone: "bad" },
        { label: "Shared schema + tenant_id", value: "one migration, but correctness now depends on every query filtering → WINNER, needs backstop", tone: "good" },
      ],
      remember: {
        problem: "Which isolation model fits tens of thousands of shared-tier tenants in one database?",
        solution: "Shared schema, every table carries a tenant_id column, indexes lead with it.",
        why: "It's the only option where a migration runs once instead of once per tenant, and it fits the power-law shape from teardown 1.",
        tradeoff: "Correctness now depends on every query filtering by tenant_id correctly — a much weaker guarantee than schema or database separation.",
        failure: "A single missed WHERE clause, ORM bug, or hand-written report query can return another tenant's rows.",
        mitigation: "Don't rely on application discipline — enforce the filter at the database layer with Row-Level Security (next teardown).",
      },
    },
    {
      n: 3,
      title: "Row-Level Security: where the isolation guarantee actually lives",
      body: [
        "Shared schema plus a tenant_id column is only safe if something other than 'the engineer remembered the WHERE clause' enforces it. Postgres Row-Level Security (RLS) is that something: a policy on every table filters rows by the current session's tenant context, enforced by the database on every SELECT, UPDATE, and DELETE — no matter what the app forgot. The subtlety is how that tenant context gets set safely on a connection that's shared across many tenants' requests via PgBouncer.",
      ],
      bullets: [
        { lead: "RLS policy", text: "CREATE POLICY tenant_isolation ON accounts USING (tenant_id = current_setting('app.tenant_id')::uuid); — the database itself rejects rows outside the current tenant, independent of the query the app wrote." },
        { lead: "SET LOCAL, not SET", text: "under PgBouncer transaction pooling, a physical connection is handed to a different tenant's transaction the moment the previous one commits. A session-level SET leaves the tenant context on the connection for the next borrower to inherit — a real cross-tenant leak. SET LOCAL scopes the setting to the current transaction and resets automatically." },
        { lead: "Tenant context propagation", text: "the validated JWT's tenant_id claim is captured in AsyncLocalStorage at the top of the request; a DB middleware issues SET LOCAL app.tenant_id at the start of every transaction, so isolation is structural rather than something each handler must remember." },
        { lead: "Defense in depth", text: "RLS is the last line, not the only one — the app still filters by tenant_id explicitly for index efficiency (RLS backstops the WHERE clause, it doesn't replace the need for a good index)." },
      ],
      pictureTitle: "Where does the isolation guarantee actually live?",
      pictureRows: [
        { label: "App remembers WHERE tenant_id = ?", value: "one missed filter = cross-tenant leak", tone: "bad" },
        { label: "Postgres RLS policy", value: "enforced on every query, can't be forgotten", tone: "good" },
        { label: "SET (session-level) under PgBouncer", value: "leaks tenant context to the next borrower", tone: "bad" },
        { label: "SET LOCAL (transaction-scoped)", value: "resets automatically, safe under pooling", tone: "good" },
      ],
      remember: {
        problem: "Make cross-tenant data leakage structurally impossible, not just unlikely.",
        solution: "Postgres RLS policies on every table, tenant context set per-transaction via SET LOCAL, propagated from the JWT via AsyncLocalStorage.",
        why: "The database enforcing the filter removes the failure mode where a forgotten WHERE clause leaks data — the guarantee no longer depends on every engineer getting every query right.",
        tradeoff: "Every query now pays a session-variable check, and connection pooling has to be handled carefully (transaction-scoped, not session-scoped).",
        failure: "Using session-level SET with PgBouncer transaction pooling leaks tenant A's context into tenant B's next transaction on the same connection.",
        mitigation: "Always use SET LOCAL inside the transaction; test it explicitly against the connection pooler's actual pooling mode, not just against a direct connection.",
      },
    },
    {
      n: 4,
      title: "Noisy neighbors: protecting a shard from one tenant",
      body: [
        "Pooled tenants share compute, database shards, and cache. A single tenant running a bulk import or a runaway analytics query can starve everyone else's p99 on that shard. Isolation of data (teardown 3) doesn't isolate performance — that needs its own layers: per-tenant rate limits, bulkheaded resource pools, and a path to promote a tenant off the shared shard entirely once it outgrows it.",
      ],
      bullets: [
        { lead: "Per-tenant rate limiting", text: "a token bucket keyed by tenant_id at the gateway, tuned to plan tier (Free/Pro/Enterprise), rejects with 429 before an abusive or misbehaving tenant's traffic ever reaches the app tier." },
        { lead: "Connection pool bulkheads", text: "PgBouncer pools sized per shard (and per large tenant where needed) so one tenant's slow queries can't exhaust the pool and starve every other tenant sharing that shard." },
        { lead: "Query timeouts", text: "every pooled-tier query carries a hard statement_timeout; a tenant's runaway report gets killed instead of pinning a worker connection for minutes." },
        { lead: "Promotion to siloed", text: "an automatic alert fires when a tenant crosses a QPS or storage threshold on a shared shard, offering — or forcing — a move to a dedicated database. Tiering from teardown 1 is a continuous decision, not a one-time signup choice." },
      ],
      pictureTitle: "Who protects the shard from one tenant?",
      pictureRows: [
        { label: "No per-tenant limits", value: "one bulk import can starve every neighbor", tone: "bad" },
        { label: "Token bucket per tenant_id", value: "abusive tenant gets 429s, not the shard", tone: "good" },
        { label: "Bulkheaded connection pools", value: "one tenant can't exhaust the shard's pool", tone: "good" },
        { label: "Promotion to siloed tier", value: "outgrown tenants get their own database", tone: "used" },
      ],
      remember: {
        problem: "Stop one tenant's load from degrading every other tenant sharing its infrastructure.",
        solution: "Per-tenant token-bucket rate limiting, bulkheaded connection pools, hard query timeouts, and an automatic pooled-to-siloed promotion path.",
        why: "Data isolation and performance isolation are separate problems; sharing a database means sharing its capacity unless something explicitly partitions it.",
        tradeoff: "Bulkheads mean provisioning capacity that sits idle for most tenants most of the time, in exchange for a bounded blast radius.",
        failure: "A single tenant's bulk import or bad query pins every connection in the shared pool, and every other tenant on the shard sees timeouts.",
        mitigation: "Enforce limits at multiple layers (gateway rate limit, pool bulkhead, statement timeout) so no single missing control causes an outage.",
      },
    },
    {
      n: 5,
      title: "Sharding and the tenant directory",
      body: [
        "The pooled tier is split across many Postgres shards, each holding thousands of tenants. A Tenant Directory maps tenant_id to {shard, tier, region}, and every request does one cached lookup before it even knows which cluster to talk to. New tenants land on the least-loaded shard, and when a shard gets hot, a subset of its tenants — not the whole database — gets moved to a new one.",
      ],
      bullets: [
        { lead: "Tenant Directory", text: "a small, heavily-cached table {tenant_id → shard_id, tier, region}; a directory lookup is on the critical path of every request, so it must be cache-hit almost always." },
        { lead: "Assignment at signup", text: "new tenants are placed on the least-loaded pooled shard rather than a random or purely hashed one, so shard load stays roughly even without needing a rebalance immediately." },
        { lead: "Rebalancing a hot shard", text: "pick the tenants to move, dual-write their rows to the new shard, backfill their history, then flip the directory entry atomically — a per-tenant migration, not a whole-database one." },
        { lead: "Region for data residency", text: "the directory also carries a region field, so EU tenants' shard lives in an EU cluster, satisfying data-residency requirements without a separate routing system." },
      ],
      pictureTitle: "How a request finds its shard",
      pictureRows: [
        { label: "Tenant Directory lookup (cached)", value: "tenant_id → shard_id, tier, region", tone: "neutral" },
        { label: "New tenant", value: "assigned to the least-loaded shard", tone: "good" },
        { label: "Hot shard", value: "subset of tenants dual-written, then cut over", tone: "used" },
      ],
      remember: {
        problem: "Route 200K req/sec to the right one of hundreds of pooled shards, and rebalance without downtime.",
        solution: "A cached Tenant Directory (tenant_id → shard, tier, region), least-loaded placement at signup, per-tenant dual-write rebalancing for hot shards.",
        why: "Moving individual tenants, instead of resharding an entire database, keeps a rebalance small, reversible, and invisible to everyone else on the shard.",
        tradeoff: "Every request pays an extra (cached) lookup, and the directory itself becomes a piece of critical shared infrastructure that must stay fast and available.",
        failure: "Hash all tenants blindly onto shards and a single whale tenant landing on a shard with several other large tenants creates an unrebalanceable hotspot.",
        mitigation: "Track load per shard, place new tenants by current load rather than a static hash, and keep the per-tenant migration path rehearsed, not theoretical.",
      },
    },
    {
      n: 6,
      title: "Zero-downtime migrations across a shared table",
      body: [
        "Because the pooled tier uses one shared schema, a migration risk is different from a siloed one: you can't take downtime for tens of thousands of tenants to add a column, and a botched migration is felt by everyone at once, not by one tenant. The fix is the expand-migrate-contract pattern, run in separate, individually-safe deploys rather than one big change.",
      ],
      bullets: [
        { lead: "Expand", text: "add the new column as nullable, or the new table alongside the old one. This deploy is safe because nothing reads the new shape yet." },
        { lead: "Migrate / backfill", text: "batch-backfill existing rows, rate-limited per shard so the backfill job doesn't itself become a noisy neighbor on the very shards it's touching." },
        { lead: "Contract", text: "once all reads and writes use the new shape, drop the old column in a separate, later deploy — never in the same change that adds the new one." },
        { lead: "Siloed tenants replay it N times", text: "the same DDL runs once per dedicated database for whale tenants; track per-tenant migration status in the directory so one stuck whale doesn't block the rollout for everyone else." },
      ],
      pictureTitle: "Expand → migrate → contract",
      pictureRows: [
        { label: "Big-bang ALTER TABLE on a live shared table", value: "locks/slows thousands of tenants at once", tone: "bad" },
        { label: "Expand: add nullable column", value: "zero-risk deploy, nothing reads it yet", tone: "good" },
        { label: "Backfill, rate-limited per shard", value: "doesn't become its own noisy neighbor", tone: "good" },
        { label: "Contract: drop old column later", value: "separate deploy, after full cutover", tone: "good" },
      ],
      remember: {
        problem: "Ship a schema change to a table shared by tens of thousands of tenants with zero downtime.",
        solution: "Expand-migrate-contract: additive schema change, rate-limited backfill, then a separate later deploy to drop the old shape.",
        why: "Splitting the change into independently-safe steps means a bad step affects nothing until it's verified, instead of one risky change touching every tenant simultaneously.",
        tradeoff: "A migration now takes three deploys and a backfill window instead of one ALTER TABLE — slower, in exchange for never taking the whole shard down.",
        failure: "A single-step migration that adds a NOT NULL column with no default locks the table and errors out every in-flight write across every tenant on that shard.",
        mitigation: "Never combine add-and-drop in one deploy; rate-limit backfills; track per-tenant migration state in the directory for siloed replays.",
      },
    },
    {
      n: 7,
      title: "Usage metering: at-least-once, because it funds the bill",
      body: [
        "Every API call, gigabyte stored, and seat used needs to feed a per-tenant usage counter that the billing engine reads. This looks like the click-analytics side-channel from a simpler system, but the reliability bar is different: a dropped usage event undercounts an invoice, so this pipeline can't be best-effort. It needs at-least-once delivery with idempotent aggregation, still emitted off the request's hot path.",
      ],
      bullets: [
        { lead: "Emit off the hot path", text: "the app service publishes a usage event to Kafka after the request completes; the API call itself never waits on the metering write." },
        { lead: "At-least-once, not best-effort", text: "the Kafka topic uses acks=all and consumers commit only after the aggregate write succeeds, tolerating duplicate deliveries instead of ever silently dropping an event." },
        { lead: "Idempotent aggregation", text: "each event carries a unique event_id; the metering consumer upserts using that id, so a redelivered event increments the tenant's counter once, not twice." },
        { lead: "Freshness, not real-time", text: "usage rolls up per tenant, per hour, into a billing store; the dashboard SLA is minutes, loose enough to batch cheaply at 50K-tenant scale." },
      ],
      pictureTitle: "Click analytics vs. billing metering",
      pictureRows: [
        { label: "Best-effort analytics (e.g. click tracking)", value: "drop-on-overflow is an acceptable trade", tone: "neutral" },
        { label: "Usage metering (this system)", value: "at-least-once + idempotent upsert — money depends on it", tone: "used" },
        { label: "Both", value: "emitted off the hot path, never block the request", tone: "good" },
      ],
      remember: {
        problem: "Meter per-tenant usage accurately enough to bill on, without slowing down the request path.",
        solution: "Emit usage events to Kafka async with acks=all; a consumer idempotently upserts per-tenant, per-hour rollups keyed by event_id.",
        why: "Unlike best-effort telemetry, a dropped metering event directly undercounts a customer's invoice, so the pipeline needs at-least-once semantics, not fire-and-forget.",
        tradeoff: "At-least-once plus idempotent upserts costs more (dedup bookkeeping, stronger delivery guarantees) than a drop-tolerant analytics pipeline.",
        failure: "Treat metering like best-effort click analytics and a Kafka rebalance during peak traffic silently undercounts thousands of tenants' bills.",
        mitigation: "acks=all producer, commit-after-write consumers, event_id-keyed idempotent upserts, and reconciliation against raw request logs for auditing.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's one platform serving tenants that range from 3 users to 20M, so the core bet is a hybrid tenancy model: pool the long tail behind shared, RLS-enforced Postgres shards, and give the handful of whale tenants their own dedicated database.",
      "Isolation is enforced by the database, not the app: Postgres Row-Level Security backstops every query, and SET LOCAL (not SET) keeps tenant context from leaking between requests that share a PgBouncer connection.",
      "Noisy neighbors are handled with per-tenant rate limits, bulkheaded connection pools, and a promotion path that moves a tenant from pooled to siloed once it outgrows its shard.",
      "Schema changes on a table shared by thousands of tenants use expand-migrate-contract, never a big-bang ALTER TABLE, because a bad migration is felt by everyone at once.",
      "Usage metering funds the bill, so unlike best-effort analytics it's at-least-once with idempotent aggregation, emitted off the request path so a billing hiccup never slows an API call.",
    ],
    flows: [
      {
        kind: "read",
        title: "READ · 200K/S · TENANT-ISOLATED",
        summary:
          "Every request resolves a tenant first, then the database itself — not the app — is what stops it from ever seeing another tenant's row.",
        steps: [
          { label: "Client", note: "tenant.acme.app or JWT with tenant_id claim" },
          { label: "API Gateway", note: "resolves tenant_id from subdomain/JWT" },
          { label: "Rate Limiter", note: "per-tenant token bucket, tuned to plan tier" },
          { label: "App Service", note: "AsyncLocal tenant context for the request" },
          { label: "Tenant Directory", note: "cached lookup: tenant_id → shard, tier, region" },
          { label: "Pooled or Siloed Postgres", note: "SET LOCAL app.tenant_id; RLS enforces the row filter" },
          { label: "Response", note: "only this tenant's rows, guaranteed by the DB" },
        ],
      },
      {
        kind: "write",
        title: "WRITE · ONBOARDING · < 30S",
        summary:
          "Signing up a tenant is a write to the directory plus provisioning storage for it — pooled tenants get rows in shared tables, whale tenants get a dedicated database.",
        steps: [
          { label: "Client", note: "signs up" },
          { label: "Onboarding Service", note: "creates the tenant record" },
          { label: "Tenant Directory", note: "registers tenant_id → shard/tier/region" },
          { label: "Pooled Postgres", note: "default tier: rows scoped behind RLS" },
          { label: "Siloed Postgres", note: "enterprise tier: provisions a dedicated database" },
        ],
      },
      {
        kind: "analytics",
        title: "USAGE METERING · AT-LEAST-ONCE · < 5MIN FRESHNESS",
        summary:
          "Every request emits a usage event after it completes. Unlike best-effort click analytics, this pipeline can't drop events because it funds the invoice.",
        steps: [
          { label: "App Service", note: "emits a usage event, doesn't wait" },
          { label: "Kafka", note: "acks=all, at-least-once delivery" },
          { label: "Metering / Billing Service", note: "idempotent upsert by event_id" },
          { label: "Billing store", note: "per-tenant hourly rollups, < 5 min freshness" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "50,000 tenants; largest whale tenant ~20M end users, smallest a 3-person startup",
          "200K API requests/sec platform-wide, p99 target independent of tenant size",
          "Top ~100 tenants (~0.2%) hold ~40% of total data — the power law that drives the pooled/siloed split",
          "~500 pooled shards, thousands of tenants each; ~100 whale tenants each with a dedicated DB",
          "Onboarding: new tenant provisioned and usable in < 30s",
          "Usage metering freshness: < 5 min from API call to billing dashboard",
          "~500GB/shard soft cap before a rebalance is triggered",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "Hybrid tenancy: pooled shared-schema shards for the long tail, siloed dedicated DBs for whale tenants",
          "Shared schema + tenant_id column beats schema-per-tenant (catalog bloat, 50K-way migration fan-out) and DB-per-tenant (ops cost) for the pooled tier",
          "Postgres RLS enforces isolation at the database, not just app-level WHERE clauses",
          "SET LOCAL (transaction-scoped), never session-level SET, under PgBouncer transaction pooling",
          "Per-tenant token-bucket rate limiting plus bulkheaded connection pools defend against noisy neighbors",
          "Schema changes use expand-migrate-contract, never a single big-bang ALTER TABLE",
          "Usage metering is at-least-once and idempotent, unlike best-effort click/audit analytics",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Isolation must live in the database (RLS), because 'the app always remembers to filter' is not a guarantee",
          "PgBouncer transaction pooling plus session-level SET is a real cross-tenant leak vector — say SET LOCAL explicitly",
          "Tenant tiering is a continuous promotion path, not a one-time signup decision",
          "A migration on a shared table is felt by thousands of tenants simultaneously — expand-migrate-contract, not big-bang",
          "Billing metering can't drop events like best-effort analytics can — money depends on it",
          "Data residency (EU tenants in an EU region) rides on the same tenant directory that does shard routing",
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
      goal: "Get the tenant-size distribution, the isolation bar, and the scale numbers on the board before drawing anything. The whole design hinges on the shape of the tenant base, so make the interviewer confirm it.",
      why: "Numbers here aren't trivia — they determine whether you even need a hybrid tenancy model. A candidate who assumes all tenants are the same size will design a single flat architecture and miss the whole point of the problem.",
      steps: [
        { kind: "ASK", text: '**"How many tenants, and how skewed is the size distribution?"** Land on "~50,000 tenants, power-law skewed — a handful with millions of users, most tiny." Write **"50K tenants, power law"** in the top-left corner.' },
        { kind: "ASK", text: 'Next: **"What\'s the isolation bar — best-effort or zero-tolerance?"** Land on "zero cross-tenant leakage, it\'s a hard security requirement, not a nice-to-have." Write **"zero leaks"** underneath.' },
        { kind: "SAY", text: 'Propose the latency and availability targets yourself: **"p99 < 200ms regardless of tenant size"**, **"99.95% availability"**. Wait for a nod, then write them down.' },
        { kind: "SAY", text: 'State scope. In: "onboarding", "tenant isolation", "noisy-neighbor defense", "schema migrations", "usage metering". Out: "the product features themselves", "SSO/SAML details", "payment processing". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Write the throughput number: **"200K req/sec platform-wide"**, and note it out loud: "that number is meaningless per-tenant — one tenant might be 50K/s, another 5/s, which is exactly why isolation of performance matters, not just data."' },
      ],
      grading: "Do you extract the power-law shape of the tenant base as a first-class requirement, not just raw QPS? That single fact is what should drive the hybrid architecture later.",
    },
    {
      n: 2,
      title: "Tenancy Model and Data Model",
      minutes: 5,
      goal: "Commit to hybrid pooled + siloed tenancy, and defend the shared-schema-plus-tenant_id choice for the pooled tier against the two obvious alternatives.",
      why: "The interviewer wants to see you reason from the power-law numbers to the architecture, not recite 'multi-tenant SaaS uses tenant_id columns' from memory. Killing schema-per-tenant and DB-per-tenant out loud shows you've felt their operational cost.",
      steps: [
        { kind: "SAY", text: 'State the split: "Pool the long tail — about 49,900 tenants — on shared RLS-enforced Postgres shards. Silo the roughly 100 whale tenants on dedicated databases." Write **"pooled + siloed hybrid"** on the board.' },
        { kind: "RULE OUT", text: 'Get ahead of the alternatives: "Database-per-tenant for everyone is 50,000 DBs to operate — too expensive for the long tail." "Schema-per-tenant hits Postgres catalog bloat past ~10K schemas and a 50K-way migration fan-out." Cross both off for the pooled tier.' },
        { kind: "DRAW", text: 'Sketch a pooled-tier row: every table carries **"tenant_id (indexed, leading column)"**, plus the entity\'s normal fields. Say: "This is what lets one migration serve every pooled tenant instead of running per-tenant."' },
        { kind: "SAY", text: 'Name the resulting risk before being asked: "This shifts the isolation guarantee from \'the DB structurally can\'t see another tenant\'s schema\' to \'every query must filter by tenant_id\' — which is exactly what I\'ll close with Row-Level Security."' },
      ],
      grading: "Commits to hybrid tenancy with a reason tied to the power-law numbers, rules out the two alternatives with a concrete cost each, and volunteers the tenant_id-correctness risk unprompted.",
    },
    {
      n: 3,
      title: "High-Level Design (draw read, write, metering)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: the read path (tenant-resolved and isolated), the write/onboarding path, and usage metering running async. Label arrows with what enforces isolation, not just box names.",
      why: "Drawing the lanes separately proves you know they have different guarantees: the read path must never leak across tenants, onboarding must provision the right tier, and metering must never slow a request but also must never silently drop data.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **read path**: Client → API Gateway (resolves tenant_id) → Rate Limiter (per-tenant bucket) → App Service (AsyncLocal tenant context) → Tenant Directory (cached shard lookup) → Pooled or Siloed Postgres. Label the last arrow **"SET LOCAL + RLS"**.' },
        { kind: "DRAW", text: 'Add the **onboarding/write path** as a separate lane: Client → Onboarding Service → Tenant Directory (registers tenant) → Pooled Postgres or Siloed Postgres depending on plan tier, labeled **"< 30s provisioning"**.' },
        { kind: "DRAW", text: 'Add the **metering path** dropping off the App Service: → Kafka (acks=all) → Metering/Billing Service, dashed, labeled **"async, at-least-once, funds the bill"**.' },
        { kind: "SAY", text: 'Narrate the split: "Three lanes because they carry three different guarantees — the read path can never leak across tenants, onboarding decides pooled vs. siloed, and metering trades a little latency for correctness because it directly affects billing."' },
      ],
      grading: "Three clearly separated lanes, the read-path arrow explicitly labeled with the isolation mechanism (SET LOCAL + RLS), and metering framed as at-least-once rather than copy-pasted from a best-effort analytics pattern.",
    },
    {
      n: 4,
      title: "Deep Dive: Enforcing Isolation",
      minutes: 8,
      goal: "Show the RLS policy, explain SET LOCAL vs. SET under PgBouncer, and describe tenant context propagation end to end.",
      why: "This is the signature sub-problem. The interviewer is probing whether isolation is a real, database-enforced guarantee or just an application convention that one bad query can break.",
      steps: [
        { kind: "WRITE", text: 'Write the RLS policy: **"CREATE POLICY tenant_isolation ON accounts USING (tenant_id = current_setting(\'app.tenant_id\')::uuid);"** Say: "This runs on every SELECT, UPDATE, DELETE — the app can\'t bypass it by forgetting a WHERE clause."' },
        { kind: "SAY", text: 'Explain the PgBouncer gotcha unprompted: "Under transaction pooling, a physical connection is reused across different tenants\' transactions. A session-level SET leaks tenant context to the next tenant on that connection — so we use SET LOCAL, which is transaction-scoped and resets automatically."' },
        { kind: "DRAW", text: 'Sketch context propagation: JWT tenant_id claim → AsyncLocalStorage at request start → DB middleware issues SET LOCAL at the start of every transaction. "Isolation is structural, not something each handler has to remember."' },
        { kind: "RULE OUT", text: '"Relying on app-level WHERE tenant_id = ? alone" — one missed filter leaks data. "Session-level SET with pooled connections" — leaks context to the next tenant. Cross both off as insufficient on their own.' },
      ],
      grading: "The RLS policy written correctly, SET LOCAL vs. SET explained without being prompted, and tenant context propagation drawn as an explicit pipeline rather than described vaguely as 'the app handles it'.",
    },
    {
      n: 5,
      title: "Deep Dive: Noisy Neighbors and Migrations",
      minutes: 7,
      goal: "Cover per-tenant rate limiting and bulkheads, then the expand-migrate-contract pattern for shared-table schema changes.",
      why: "Anyone can say 'add a rate limiter'. The interviewer wants the full defense stack (limiter, bulkheaded pool, timeout, promotion path) and a migration strategy that acknowledges a bad change now hits thousands of tenants at once.",
      steps: [
        { kind: "SAY", text: 'Walk the noisy-neighbor defenses: "Per-tenant token bucket at the gateway, bulkheaded PgBouncer pools per shard so one tenant can\'t exhaust it, and a hard statement_timeout so a runaway report gets killed instead of pinning a connection."' },
        { kind: "SAY", text: 'Volunteer the promotion path: "A tenant that keeps tripping these limits gets promoted to a siloed dedicated database — tiering isn\'t a one-time signup decision, it\'s continuous."' },
        { kind: "SAY", text: 'Walk expand-migrate-contract: "Add the column nullable first — zero-risk deploy. Backfill in rate-limited batches so the backfill itself doesn\'t become a noisy neighbor. Drop the old column in a separate, later deploy."' },
        { kind: "SAY", text: 'Name the failure mode explicitly: "A single-step migration that adds a NOT NULL column with no default locks the table and breaks every in-flight write across every tenant on that shard — that\'s why it\'s three deploys, not one."' },
      ],
      grading: "Multiple layered defenses named (not just \"rate limiting\"), the promotion path volunteered, and expand-migrate-contract explained with a concrete failure mode for why it isn't one step.",
    },
    {
      n: 6,
      title: "Wrap: Metering, Trade-offs, and Close",
      minutes: 5,
      goal: "Contrast metering's at-least-once requirement against best-effort analytics, name the data-residency angle, and close with a one-sentence summary plus what you'd cover with more time.",
      why: "Staff-level signal is knowing which guarantees actually matter where — recognizing that metering can't be best-effort because it's money, and closing the interview like a collaborator managing the clock, not someone who ran out of things to say.",
      steps: [
        { kind: "SAY", text: '"Metering can\'t be best-effort like click analytics would be — a dropped event undercounts an invoice, so it\'s at-least-once delivery with idempotent upserts keyed by event_id."' },
        { kind: "SAY", text: '"Data residency rides on the same Tenant Directory that does shard routing — the directory carries a region field, so an EU tenant\'s shard just lives in an EU cluster."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need zero cross-tenant leakage as an absolute, or is there an acceptable audit-and-detect model for some data classes?" Treat requirements as negotiable.' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a hybrid pooled/siloed platform where Postgres RLS makes isolation structural rather than a convention. With more time I\'d cover GDPR deletion mechanics, SSO/SAML, and cross-region failover for siloed tenants."' },
      ],
      grading: "Explicitly distinguishes metering's reliability bar from best-effort analytics, ties data residency back to the tenant directory, and closes with a crisp summary plus a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a working design with a tenant_id column and basic auth, but isolation and noisy-neighbor risks stay hand-wavy.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Adds a tenant_id column to every table and filters by it in queries.",
          "Knows to resolve the tenant from a subdomain or JWT at the gateway.",
          "Picks Postgres and a load balancer without much justification.",
          "Mentions 'we'd add rate limiting' when prompted about abuse.",
          "Can sketch a basic onboarding flow that creates a tenant row.",
        ],
        gaps: [
          "Isolation relies entirely on the app remembering WHERE tenant_id = ?, with no database-enforced backstop like RLS.",
          "Doesn't distinguish pooled vs. siloed tenants — treats all 50K tenants as identical.",
          "No noisy-neighbor plan beyond a vague 'add a rate limiter'.",
          "Treats schema migrations like a single-tenant app would — one ALTER TABLE, no rollout plan.",
          "Usage metering and click analytics get the same treatment, missing that one funds a bill and can't drop events.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design from the power-law tenant distribution, picks a hybrid tenancy model with reasons, and names trade-offs when pushed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Identifies the power-law tenant distribution and proposes pooled + siloed tiers because of it.",
          "Rules out database-per-tenant and schema-per-tenant with a concrete operational cost for each.",
          "Uses Postgres RLS for isolation, not just app-level filtering.",
          "Names per-tenant rate limiting and connection pool bulkheads as noisy-neighbor defenses.",
          "Knows migrations on a shared table need an expand/contract-style rollout.",
          "Distinguishes at-least-once metering from best-effort analytics.",
        ],
        gaps: [
          "Doesn't volunteer the SET LOCAL vs. SET / PgBouncer pooling leak risk until asked directly.",
          "Mentions the pooled-to-siloed promotion path only when prompted about a specific tenant outgrowing its shard.",
          "Describes the migration pattern correctly but doesn't name the concrete failure mode of skipping it (a locked table breaking every in-flight write).",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, treats isolation as a database-enforced guarantee rather than a convention, and surfaces the subtle pooling failure modes before being asked.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the SET LOCAL vs. session-level SET risk under PgBouncer transaction pooling unprompted, as the specific mechanism by which isolation could actually break.",
          "Frames tenant tiering as a continuous promotion path with automatic triggers, not a static decision made once at signup.",
          "Explicitly separates data isolation (RLS) from performance isolation (bulkheads, rate limits, timeouts) as two different problems with two different failure modes.",
          "Contrasts usage metering's at-least-once requirement against best-effort analytics unprompted, and explains why the reliability bar differs.",
          "Names the concrete failure mode of a big-bang migration (a locked shared table breaking every in-flight write across every tenant on the shard) without being asked for a worst case.",
          "Pushes back on absolute requirements where reasonable (e.g., proposing audit-and-detect for lower-sensitivity data classes) while defending zero-tolerance for the core data path.",
          "Closes with a one-sentence summary and an explicit list of what's parked for lack of time.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Relying only on application-level WHERE tenant_id = ? filtering with no database-enforced backstop like Row-Level Security.",
      "Using session-level SET for tenant context with a transaction-pooled connection pooler like PgBouncer — a real, exploitable cross-tenant leak.",
      "Treating all 50,000 tenants as the same size and putting every tenant, including whales, in one shared database.",
      "No noisy-neighbor defense beyond 'add a rate limiter' — no connection pool bulkheads, no query timeouts, no promotion path.",
      "Running a single big-bang ALTER TABLE against a table shared by thousands of tenants instead of an expand-migrate-contract rollout.",
      "Treating usage metering like best-effort click analytics — dropping events on overflow when those events fund an invoice.",
      "No tenant directory or routing layer — assuming a single database can serve every tenant at any scale.",
    ],
    followUps: [
      {
        q: "Why Postgres RLS instead of just filtering by tenant_id in every query?",
        a: "Because application-level filtering is a convention, not a guarantee — one missed WHERE clause, one raw SQL debugging query, one ORM edge case, and tenant B's rows leak to tenant A. RLS moves the guarantee into the database: a policy on every table filters by the session's tenant context on every SELECT, UPDATE, and DELETE, so even a buggy or malicious query path can't return another tenant's data. The app still filters explicitly for index efficiency, but RLS is what makes the isolation structural rather than best-effort.",
      },
      {
        q: "What's the actual risk with connection pooling and tenant context?",
        a: "PgBouncer in transaction pooling mode hands a physical connection to a different client's transaction the instant the previous one commits, to keep connection counts low across thousands of tenants. If tenant context is set with a session-level SET, it stays on that physical connection after the transaction ends, so the next tenant to borrow that connection inherits the previous tenant's RLS context — a real cross-tenant leak. SET LOCAL scopes the setting to the current transaction only and Postgres resets it automatically at commit or rollback, which is the safe primitive under transaction pooling.",
      },
      {
        q: "How do you decide when a tenant should move from pooled to siloed?",
        a: "Track load per tenant per shard — QPS, storage, and connection-pool pressure attributable to that tenant specifically. When a tenant crosses a threshold (say, consistently over 5% of a shard's capacity, or a storage footprint that would let it dominate the shard's backup and vacuum load), trigger an alert and either offer a self-service upgrade or force a migration. It's a continuous operational decision fed by real usage data, not a one-time choice made at signup based on the plan tier alone.",
      },
      {
        q: "Why can't schema migrations be a single ALTER TABLE like in a normal app?",
        a: "In a single-tenant app, a locked table during a migration affects one customer briefly. In the pooled tier here, one shared table serves thousands of tenants simultaneously, so a locking migration — or a NOT NULL column added without a default — breaks every in-flight write across every one of those tenants at once. The expand-migrate-contract pattern splits the change into independently safe deploys: add nullable, backfill in rate-limited batches, then drop the old shape only after everything has cut over, so no single step can take down the whole shard.",
      },
      {
        q: "Why does usage metering need stronger delivery guarantees than click analytics would?",
        a: "Click analytics is informational — losing a few events under load is an acceptable trade for never blocking a hot path. Usage metering directly determines what a tenant gets billed, so a dropped event silently undercounts an invoice, which is a correctness bug with a dollar amount attached. That's why the metering pipeline uses acks=all on the Kafka producer, commit-after-write consumers, and idempotent upserts keyed by event_id — it tolerates duplicate deliveries (which just no-op on the upsert) but never tolerates a silent drop.",
      },
      {
        q: "How does data residency (EU data staying in the EU) fit into this architecture?",
        a: "It rides on the same Tenant Directory that already does shard routing. The directory entry for a tenant carries a region field alongside shard_id and tier; an EU tenant's directory entry simply points at a shard hosted in an EU-region Postgres cluster. Because every request already does a directory lookup before it knows which cluster to query, residency is enforced by that same lookup rather than needing a separate routing system — the region constraint is just one more column on infrastructure that already exists.",
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
          "This is one platform pretending to be many. Every tenant should feel like they have the whole system to themselves — their own data, their own performance, their own migration schedule — while the platform actually shares infrastructure wherever it's economical to do so. Every hard decision in this design is about where to draw that shared-vs-isolated line.",
          "Anchor everything on the shape of the tenant base: 50,000 tenants, power-law distributed, with the top ~100 (~0.2%) holding ~40% of the data. That single fact — not a stylistic preference — is what forces a hybrid architecture instead of one uniform design.",
        ],
      },
      {
        heading: "Hybrid tenancy: pooled and siloed",
        body: [
          "Database-per-tenant is too expensive to operate for 50,000 tenants when most of them are tiny — most of that dedicated capacity sits idle. One shared database for everyone lets a whale tenant's load pattern degrade thousands of small tenants sharing its shard. The resolution is a hybrid: pool the long tail behind shared, RLS-enforced Postgres shards, and give the small number of whale tenants their own dedicated database.",
          "Within the pooled tier, shared schema plus a tenant_id column beats schema-per-tenant, which hits Postgres catalog bloat past roughly 10,000 schemas and turns every migration into a 50,000-way fan-out. One shared schema means one migration serves every pooled tenant — at the cost of correctness now depending on every query filtering by tenant_id.",
        ],
      },
      {
        heading: "Isolation as a database guarantee, not an app convention",
        body: [
          "That tenant_id-filtering dependency is closed with Postgres Row-Level Security: a policy on every table filters rows by the current session's tenant context, enforced on every SELECT, UPDATE, and DELETE regardless of what the application code does. Tenant context itself flows from the validated JWT's tenant_id claim, captured in AsyncLocalStorage at the top of the request, and set on the database connection via SET LOCAL at the start of every transaction.",
          "SET LOCAL is not a stylistic choice — it's the mechanism that makes this safe under PgBouncer transaction pooling, where a physical connection is reused across different tenants' transactions. A session-level SET would leak tenant context to whichever tenant borrows that connection next; SET LOCAL is scoped to the current transaction and resets automatically on commit or rollback.",
        ],
      },
      {
        heading: "Noisy neighbors and the tenant directory",
        body: [
          "Data isolation doesn't imply performance isolation — a shared shard still shares CPU, connections, and I/O. The defense is layered: per-tenant token-bucket rate limiting at the gateway, bulkheaded connection pools per shard so one tenant can't exhaust it, hard query timeouts, and an automatic promotion path that moves a tenant from pooled to siloed once it crosses a load threshold. Tiering is continuous, not a one-time signup decision.",
          "A Tenant Directory ({tenant_id → shard_id, tier, region}) sits on the critical path of every request, cached aggressively. New tenants are placed on the least-loaded shard at signup; a hot shard gets rebalanced by dual-writing a subset of its tenants to a new shard and cutting the directory over atomically — a per-tenant migration, not a whole-database one. The same directory's region field satisfies data-residency requirements by construction.",
        ],
      },
      {
        heading: "Schema migrations at multi-tenant scale",
        body: [
          "A migration on a table shared by thousands of pooled tenants is felt by all of them simultaneously, so it can't be a single ALTER TABLE. The expand-migrate-contract pattern splits it into independently-safe deploys: add the new column nullable (expand), backfill existing rows in rate-limited batches so the backfill itself doesn't become a noisy neighbor (migrate), then drop the old column in a separate, later deploy once everything has cut over (contract).",
          "Siloed whale tenants replay the same DDL once per dedicated database; migration status is tracked per tenant in the directory so one stuck whale tenant's migration doesn't block the rollout for the rest of the platform.",
        ],
      },
      {
        heading: "Usage metering: a side channel with money attached",
        body: [
          "Usage metering emits off the request's hot path, the same way analytics would in a simpler system — but the reliability bar is different. A dropped click-analytics event is a shrug; a dropped usage event undercounts an invoice. The pipeline uses acks=all on the Kafka producer, consumers that commit only after the aggregate write succeeds, and idempotent upserts keyed by event_id, tolerating duplicate deliveries while never tolerating a silent drop, with a < 5 minute freshness SLA that's loose enough to batch cheaply at 50,000-tenant scale.",
        ],
      },
    ],
  },
};
