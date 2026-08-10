# Database Selection and Tradeoffs — System Design Reference

> Target: Senior Java/systems engineer. 40 LPA system design interviews.
> This file ties together the internals from files 01-04 into actionable decision frameworks.

---

## 1. CAP Theorem — Applied Correctly

### 1.1 The Theorem

**CAP**: In a distributed system, you can guarantee at most two of:
- **C**onsistency — every read returns the most recent write (linearizability)
- **A**vailability — every request receives a non-error response
- **P**artition Tolerance — system continues despite network partitions

**The dirty secret of CAP**: Partition tolerance is **not optional** in real distributed systems — network partitions happen. So the real choice is: **when a partition occurs, sacrifice C or A?**

- **CP system**: goes unavailable (returns errors) during partition to preserve consistency
- **AP system**: remains available during partition but may return stale data
- **CA (no partition tolerance)**: only exists for single-node databases (not distributed)

### 1.2 Where Each Database Falls

| Database | CAP classification | Why |
|----------|------------------|-----|
| PostgreSQL (standalone) | CA | Single node; no network partition concern |
| PostgreSQL (streaming replication, sync) | CP | Sync commit blocks on replica ack; primary goes down if replica unavailable |
| PostgreSQL (streaming replication, async) | AP (eventual) | Primary stays available; replica may lag |
| MySQL (semi-sync replication) | CP (soft) | Primary waits for at least one replica ack |
| MongoDB (primary + writeConcern:majority) | CP | Writes must be acknowledged by majority; primary steps down if no majority |
| MongoDB (writeConcern:1, readPreference:secondary) | AP | Primary always available; secondaries may be stale |
| Cassandra (CL=QUORUM) | CP | Requires quorum acknowledgment; can reject writes if not enough nodes |
| Cassandra (CL=ONE) | AP | Always available; accepts stale reads |
| Redis (standalone) | CA | Single-node |
| Redis Cluster | AP | Cluster stays available during partition; may serve stale data from isolated nodes |
| Elasticsearch | AP | Cluster serves reads during partition; consistency on writes is best-effort |
| ZooKeeper | CP | Uses ZAB (Paxos-variant); rejects writes when no quorum |
| etcd | CP | Raft-based; requires quorum |
| CockroachDB | CP | Raft per range; strong consistency |
| Cassandra with LOCAL_QUORUM | CP within DC, AP cross-DC | Quorum within one DC; async between DCs |

**Key interview insight**: databases like Cassandra and MongoDB are not simply "AP" or "CP" — they are **tunable** along the CAP spectrum per operation via consistency levels.

---

## 2. PACELC Theorem — Practical Extension

### 2.1 Why CAP Is Insufficient

CAP only addresses partitions. But in practice:
- Network partitions are **rare** (seconds per year in well-operated systems)
- **Latency vs consistency tradeoffs happen ALL THE TIME** during normal operation

**PACELC** (Daniel Abadi, 2010):

```
IF Partition:
    trade off A (availability) vs C (consistency)
ELSE (normal operation):
    trade off L (latency) vs C (consistency)
```

A database has two separate tradeoffs: PA/EL, PA/EC, PC/EL, PC/EC.

### 2.2 PACELC Classification

| Database | Partition | Else | Classification | Notes |
|----------|-----------|------|----------------|-------|
| Cassandra | A | L | PA/EL | Default: high availability + low latency; sacrifice consistency |
| DynamoDB | A | L | PA/EL | Eventual consistency by default |
| MongoDB | A | L | PA/EL (tunable) | Default async replication = low latency |
| PostgreSQL sync replication | C | C | PC/EC | Blocks writes until replica confirms; higher latency |
| Spanner | C | C | PC/EC | True global consistency (TrueTime); accepts latency |
| CockroachDB | C | L | PC/EL | Strong consistency, but Raft minimizes latency overhead |
| HBase | C | L | PC/EL | Strongly consistent with ZooKeeper |
| MySQL semi-sync | C | L | PC/EL | Semi-sync adds latency only on commit; reads are fast |

### 2.3 Practical Use

For an interview discussing distributed database design:
1. CAP identifies the partition behavior
2. PACELC identifies the **everyday latency cost of consistency**
3. For global deployments: always think PACELC — partition is theoretical, latency is daily reality

```
Example: E-commerce checkout
- Need consistency (prevent oversell) → choose PC/EC path (sync commit)
- Accept higher write latency (~5ms for sync commit to replica vs 1ms async)
- Use read replica for product catalog reads (PA/EL path for reads is fine)
```

---

## 3. ACID vs BASE

### 3.1 ACID (Relational DBs)

| Property | Meaning | How PostgreSQL/MySQL implement it |
|---------|---------|----------------------------------|
| **A**tomicity | Transaction is all-or-nothing | WAL + undo log; on crash, rollback incomplete transactions |
| **C**onsistency | Data always in valid state | Constraints, triggers, FK checks enforced by DB engine |
| **I**solation | Concurrent transactions don't interfere | MVCC (snapshot isolation); locks for write-write conflicts |
| **D**urability | Committed data survives crashes | WAL fsynced before commit ACK; checkpoints flush to disk |

### 3.2 BASE (NoSQL Systems)

| Property | Meaning |
|---------|---------|
| **B**asically **A**vailable | System guarantees availability (CAP-A) |
| **S**oft state | Data state may change over time (without input, via replication convergence) |
| **E**ventual consistency | Given no new writes, all replicas will eventually converge to same value |

BASE is not "worse" than ACID — it's a different trade for different needs:
- BASE enables horizontal scale, multi-DC geo-distribution, higher write throughput
- ACID is essential for financial transactions, inventory management, strong consistency workloads

---

## 4. Decision Framework — When to Use What

### 4.1 Primary Workload Patterns

```
Read:Write ratio?
├─ Heavy reads (>90% reads)
│   ├─ Need full-text search? → Elasticsearch
│   ├─ Need exact lookups, low latency? → Redis (cache), or read replicas (PostgreSQL/MySQL)
│   └─ Need complex queries, joins? → PostgreSQL with read replicas
│
├─ Heavy writes (>70% writes)
│   ├─ Time-series / append-only? → Cassandra (TWCS), TimescaleDB (PostgreSQL extension), InfluxDB
│   ├─ Need ACID? → PostgreSQL (with partitioning), TiDB (distributed)
│   └─ Need geo-distributed, eventually consistent? → Cassandra, DynamoDB
│
└─ Balanced read/write
    ├─ Document model, flexible schema? → MongoDB
    ├─ Relational, complex queries? → PostgreSQL
    └─ High-concurrency, simple access patterns? → MySQL InnoDB
```

### 4.2 Full Decision Tree

```
1. Do you need transactions across multiple entities?
   YES → Go to 2
   NO  → Go to 3

2. Are transactions across different data domains (e.g., orders + inventory)?
   YES → Relational DB (PostgreSQL, MySQL) — ACID multi-table transactions
   NO  → MongoDB (4.0+ single replica set transactions) may work

3. What's the data model?
   Documents (variable schema, nested)  → MongoDB
   Wide-column (time-series, event log) → Cassandra
   Key-value (cache, session)           → Redis
   Search (full-text, faceted)          → Elasticsearch
   Relational (complex joins, reports)  → PostgreSQL

4. Scale requirements?
   Single-machine scale → PostgreSQL / MySQL
   Horizontal scale, multi-region → Cassandra, MongoDB Sharded, DynamoDB
   Extreme scale (petabytes) → Cassandra, HBase

5. Consistency requirements?
   Strong (financial, inventory) → PostgreSQL sync replication, CockroachDB, Spanner
   Eventual (social feeds, analytics) → Cassandra (CL=ONE/LOCAL_QUORUM), MongoDB secondary reads
```

### 4.3 Specific Use-Case Mapping

| Use Case | Recommended | Why | Alternative |
|---------|-------------|-----|-------------|
| User authentication, sessions | Redis | O(1) lookup, TTL for expiry | PostgreSQL with cache |
| Product catalog | PostgreSQL | Full-text via `tsvector`, complex filters | Elasticsearch for full-text |
| Order management | PostgreSQL | ACID, complex joins, reporting | MySQL (similar) |
| Social graph | PostgreSQL (pgGraph) | For medium scale; joins | Neo4j for large graphs |
| Activity feed | Cassandra | Append-heavy; time-ordered; high write throughput | Redis (small datasets) |
| IoT sensor data | Cassandra + TWCS | Time-series, high write throughput, TTL | TimescaleDB, InfluxDB |
| Real-time leaderboard | Redis ZSet | O(log N) ZADD + ZRANK + ZRANGE by score | PostgreSQL (slow at scale) |
| Distributed cache | Redis | Sub-millisecond, rich data structures | Memcached (simpler) |
| Full-text search | Elasticsearch | Inverted index, BM25, aggregations | PostgreSQL FTS (small scale) |
| Log aggregation | Elasticsearch | Near-real-time search, aggregations | Splunk (commercial) |
| Recommendation engine | Redis (for real-time) + PostgreSQL (for batch) | Fast feature lookups + ACID updates | Cassandra |
| Audit log | Cassandra / Kafka + S3 | Immutable append; time-ordered; high write | PostgreSQL (smaller scale) |
| Job queue | Redis Streams / PostgreSQL SKIP LOCKED | Redis: sub-ms; PostgreSQL: ACID, reliable | RabbitMQ, Kafka |
| Multi-tenant SaaS | PostgreSQL (row-level security) | Schema isolation, RBAC | Separate schemas per tenant |
| Geospatial queries | PostgreSQL + PostGIS | ST_ functions, spatial indexes | MongoDB (2dsphere) |

---

## 5. Read/Write Ratio Patterns and Architecture

### 5.1 Read-Heavy Architecture

```
                           ┌─────────────────────────────┐
Client ──────────────────► │  Redis Cache (read-through)  │ ──►  Cache Hit (sub-ms)
                           └─────────────────────────────┘
                                        │ cache miss
                                        ▼
                           ┌─────────────────────────────┐
                           │  Read Replicas (PostgreSQL)  │ ──►  Read (ms)
                           │  (multiple, load-balanced)   │
                           └─────────────────────────────┘
                                        │
                                        ▼
                           ┌─────────────────────────────┐
                           │  Primary PostgreSQL          │ ──►  Writes only
                           └─────────────────────────────┘
```

**Cache invalidation strategies**:
1. **TTL expiry**: simplest; accepts some staleness (fine for product catalog, user profiles)
2. **Write-through**: update cache on every write; always fresh but extra write overhead
3. **Cache-aside + version-based eviction**: on write, store version in DB + cache key; reads check version

### 5.2 Write-Heavy Architecture

```
Client ──► Write-optimized primary (Cassandra / sharded MySQL) ──► SSTables (LSM tree)
                                                                          │
                                                                          │ async
                                                                          ▼
                                                                  Read replicas /
                                                                  Materialized views /
                                                                  Elasticsearch (CDC)
```

**Write-heavy optimizations**:
- LSM-tree storage (Cassandra, RocksDB): sequential writes, no random I/O
- Disable sync fsync for WAL (risky but faster; `synchronous_commit = off` in PG)
- Batch writes: collect N writes → single transaction commit (reduces fsync overhead)
- Async replication: don't block on replica acknowledgment
- Denormalize: avoid JOINs on writes (write to pre-joined tables)

### 5.3 Time-Series Pattern

```
Data model: (device_id, timestamp) → value
Write: always insert new rows (no updates); time-series is append-only
Read: recent window (last 1h), aggregations over time ranges

Best fit:
- Cassandra with TWCS (TTL-based cleanup, no tombstone accumulation)
- TimescaleDB (PostgreSQL extension): hypertables auto-partitioned by time, continuous aggregates
- InfluxDB: purpose-built, columnar, specialized aggregation functions

Anti-pattern:
- MySQL/PostgreSQL without partitioning: table grows unbounded; old data costly to delete
```

---

## 6. Normalization vs Denormalization Tradeoffs

### 6.1 Normalized (3NF) — Relational Default

```sql
-- Normalized: Order references Customer and Product
orders:     {order_id, customer_id FK, created_at, status}
customers:  {customer_id, name, email, address}
order_items:{order_id FK, product_id FK, quantity, price}
products:   {product_id, name, description, category}
```

**Pros**: single source of truth; easy updates; no redundancy; smaller storage.
**Cons**: every query requires joins; joins are expensive at scale.

**Works well when**:
- OLTP with complex updates
- Schema frequently changes
- Data correctness is paramount

### 6.2 Denormalized — NoSQL/Analytics Default

```javascript
// MongoDB: entire order in one document, no joins needed
{
  _id: ObjectId("..."),
  customer: {id: "cust1", name: "Alice", email: "alice@example.com"},
  items: [
    {product_id: "p1", name: "Laptop", price: 999.99, quantity: 1},
    {product_id: "p2", name: "Mouse", price: 29.99, quantity: 2}
  ],
  status: "shipped",
  created_at: ISODate("2024-01-01")
}
```

**Pros**: single document fetch; no joins; schema matches access pattern.
**Cons**: customer name duplicated across all orders; name change = update all orders; storage overhead.

**Works well when**:
- Read-heavy; writes are rare or data is immutable (orders never change after creation)
- Access patterns are predictable and known upfront
- Scale out is required (no cross-shard joins)

### 6.3 The Cassandra Extreme: Query-Driven Schema Design

```
Same logical data → multiple physical tables, each optimized for one query:

-- Table 1: find orders by user
orders_by_user: (user_id, order_time, order_id, status, amount)
PRIMARY KEY (user_id, order_time)

-- Table 2: find orders by status (separate denormalized table)
orders_by_status: (status, order_time, order_id, user_id, amount)
PRIMARY KEY (status, order_time)

-- Table 3: find order by ID
orders_by_id: (order_id, user_id, order_time, status, amount, items)
PRIMARY KEY (order_id)
```

Write path: write to all 3 tables for every order creation. Storage: 3x. Benefit: every read is single-partition O(1).

---

## 7. Connection Pooling Strategies by Database (Java/Spring Boot)

### 7.1 PostgreSQL + HikariCP

```yaml
spring:
  datasource:
    url: jdbc:postgresql://host:5432/db?prepareThreshold=5
    hikari:
      maximum-pool-size: 10         # (2 × cores) + spindles; don't exceed PG max_connections / num_instances
      minimum-idle: 5
      connection-timeout: 30000     # fail-fast if pool exhausted
      idle-timeout: 600000          # 10 min; PG has no server-side idle timeout by default
      max-lifetime: 1800000         # 30 min; recycle before any proxy/firewall timeout
      keepalive-time: 60000         # ping idle connections to prevent stale state
```

**With PgBouncer**:
```yaml
hikari:
  maximum-pool-size: 100        # HikariCP holds connections to PgBouncer (cheap)
  # PgBouncer configured with:
  # pool_mode = transaction
  # default_pool_size = 20     # actual PostgreSQL connections
```

PgBouncer transaction pooling means `SET session_variable` doesn't persist. Don't use SET-based features (e.g., `SET search_path`) in transaction-pooled connections.

### 7.2 MySQL + HikariCP

```yaml
spring:
  datasource:
    url: jdbc:mysql://host:3306/db?useSSL=true&serverTimezone=UTC&rewriteBatchedStatements=true
    hikari:
      maximum-pool-size: 10
      max-lifetime: 1800000         # MUST be less than MySQL's wait_timeout (default 8h, often 600s in cloud)
      keepalive-time: 60000         # Sends SELECT 1 to prevent MySQL closing idle connection
      connection-test-query: SELECT 1
      data-source-properties:
        cachePrepStmts: true
        prepStmtCacheSize: 250
        useServerPrepStmts: true
```

**Gotcha**: AWS RDS/Aurora default `wait_timeout = 60` for connections idle >60s → connections become stale. Set `keepaliveTime` lower than `wait_timeout`.

### 7.3 MongoDB + Spring Data MongoDB

```yaml
spring:
  data:
    mongodb:
      uri: mongodb://host:27017/db?minPoolSize=5&maxPoolSize=20&waitQueueTimeoutMS=5000
      auto-index-creation: false    # disable auto index creation in production
```

Java driver manages its own connection pool (not HikariCP). No separate pool configuration needed.

```java
@Configuration
public class MongoConfig extends AbstractMongoClientConfiguration {
    @Override
    protected void configureClientSettings(MongoClientSettings.Builder builder) {
        builder.applyToConnectionPoolSettings(pool -> pool
            .maxSize(20)
            .minSize(5)
            .maxWaitTime(5, TimeUnit.SECONDS)
            .maxConnectionIdleTime(10, TimeUnit.MINUTES));
    }
}
```

### 7.4 Redis + Lettuce (Spring Data Redis default)

```yaml
spring:
  redis:
    host: localhost
    port: 6379
    lettuce:
      pool:
        max-active: 8
        max-idle: 8
        min-idle: 2
        max-wait: -1ms    # block indefinitely if pool exhausted (vs fail-fast)
```

**Lettuce vs Jedis**:
- **Lettuce** (default): async, non-blocking, Netty-based; one connection shared across threads
- **Jedis**: blocking, one connection per thread; better for Jedis-specific APIs

For Redis Cluster with Lettuce: adaptive reconnect + cluster topology refresh happens automatically.

### 7.5 Cassandra + DataStax Java Driver

```java
CqlSession session = CqlSession.builder()
    .withContactPoints(List.of(new InetSocketAddress("host", 9042)))
    .withLocalDatacenter("dc1")
    .withKeyspace("myapp")
    .withConfigLoader(DriverConfigLoader.fromClasspath("application.conf"))
    .build();
```

```hocon
# application.conf
datastax-java-driver {
  basic.request.consistency = LOCAL_QUORUM
  basic.request.timeout = 2 seconds
  basic.load-balancing-policy.local-datacenter = dc1
  advanced.connection.pool.local.size = 1    # connections per local host (increase for high throughput)
  advanced.connection.pool.remote.size = 1
  advanced.throttler.type = ConcurrencyLimitingRequestThrottler
  advanced.throttler.max-concurrent-requests = 1000
  advanced.throttler.max-queue-size = 10000
}
```

**Cassandra connection model**: one session per application; session manages connection pool internally. Do NOT create a new session per request (expensive — reconnects, re-discovers topology).

### 7.6 Elasticsearch + Java High Level REST Client / Java API Client

```java
// Modern Java API Client (8.x)
RestClient restClient = RestClient.builder(
    new HttpHost("localhost", 9200, "http")
).setHttpClientConfigCallback(builder -> builder
    .setMaxConnTotal(100)
    .setMaxConnPerRoute(10)
    .setDefaultRequestConfig(RequestConfig.custom()
        .setConnectTimeout(1000)
        .setSocketTimeout(30000)
        .build()))
.build();

ElasticsearchTransport transport = new RestClientTransport(restClient, new JacksonJsonpMapper());
ElasticsearchClient client = new ElasticsearchClient(transport);
```

**Spring Boot Elasticsearch configuration**:
```yaml
spring:
  elasticsearch:
    uris: http://localhost:9200
    connection-timeout: 1s
    socket-timeout: 30s
```

---

## 8. Anti-Patterns and War Stories

### 8.1 PostgreSQL

| Anti-Pattern | Consequence | Fix |
|-------------|------------|-----|
| `idle in transaction` connections accumulating | VACUUM blocked; locks held; connection starvation | Set `statement_timeout` and `idle_in_transaction_session_timeout` |
| Running VACUUM FULL on large tables during business hours | AccessExclusiveLock blocks all reads/writes | Schedule off-hours; use `pg_repack` for online bloat removal |
| Missing index on foreign key | Every FK-referenced table delete does a seqscan | Always index FK columns |
| `SELECT *` with `JSONB` column containing large blobs | Full document loaded even when only one field needed | Index and select specific JSONB paths; consider normalizing large fields |
| Using `NOT IN (SELECT ...)` with nullable column | NULL in subquery makes whole condition return false | Use `NOT EXISTS` or LEFT JOIN + IS NULL |

### 8.2 MySQL

| Anti-Pattern | Consequence | Fix |
|-------------|------------|-----|
| UUID primary key | B+Tree fragmentation; random page writes; buffer pool churn | Use `BIGINT AUTO_INCREMENT` or ordered UUID (UUIDv7) |
| OFFSET pagination on large tables | Full scan up to OFFSET | Keyset (cursor) pagination: `WHERE id > last_seen_id LIMIT 100` |
| `SELECT COUNT(*)` on InnoDB | Full table scan (no stored row count) | Maintain separate counter or use approximate: `information_schema.tables` |
| DDL on production without pt-online-schema-change | ALTER TABLE holds lock for hours | Use `pt-online-schema-change` or `gh-ost` for online DDL |

### 8.3 MongoDB

| Anti-Pattern | Consequence | Fix |
|-------------|------------|-----|
| Unbounded document growth (array that grows forever) | Document moves on disk, slows reads | Use separate collection with references |
| Using `_id` as shard key | Monotonic ObjectId → all writes to one shard | Use compound shard key; or hashed sharding |
| `$lookup` across shards | Cross-shard join is scatter-gather | Denormalize or ensure looked-up collection is on same shard |
| Skip + Limit for pagination | Cursor must scan all skipped documents | Use range-based pagination with `_id > last_id` |

### 8.4 Cassandra

| Anti-Pattern | Consequence | Fix |
|-------------|------------|-----|
| Partition size > 100MB | GC pressure, slow reads, compaction stalls | Bucket partition key (add time period to PK) |
| Using `ALLOW FILTERING` | Full cluster scatter-gather scan | Redesign schema; create proper table for query |
| Deleting many rows from a wide partition | Tombstone avalanche; read timeouts | Use TTL instead of explicit DELETE; TWCS |
| Using Cassandra for OLAP / ad-hoc queries | No aggregation, no flexible WHERE | Use Spark + S3/Parquet or Elasticsearch for analytics |

---

## 9. Master Summary — Database Comparison

```
                    Consistency  |  Scalability  |  Flexibility  |  Latency
                    ------------+---------+------+------+--------+---------
PostgreSQL          ACID ████    |  Single ██    |  High ████    |  Low ██
MySQL               ACID ████    |  Single ██    |  Med  ███     |  Low ██
MongoDB             Tunable ███  |  Horiz  ████  |  High ████    |  Low ███
Cassandra           Tunable ███  |  Horiz  █████ |  Low  █       |  VLow ████
Redis               None/opt █   |  Cluster ███  |  Med  ███     |  VLow █████
Elasticsearch       Eventual ██  |  Horiz  ████  |  High ████    |  Low  ███
```

### The One-Liner Decision Rules

1. **Default to PostgreSQL** — until proven you need something else. It handles OLTP + light OLAP + FTS + JSON + geospatial.
2. **Add Redis** — for cache, session store, rate limiting, leaderboards. Complements every primary DB.
3. **Choose Cassandra** — when write throughput exceeds what PostgreSQL can handle with replication, or you need multi-DC active-active with no single point of failure.
4. **Choose MongoDB** — when your data is naturally document-shaped, teams prefer flexible schema, and you don't need complex relational joins.
5. **Add Elasticsearch** — when you need full-text search with faceting/aggregation. Never use it as your primary store.
6. **Avoid premature polyglot persistence** — each new database adds operational complexity (backups, monitoring, expertise, ops runbooks). Only add a DB when PostgreSQL genuinely cannot meet the requirement.

---

## Interview Answer Framework

When asked "What database would you use for X?":

1. **Clarify requirements**: scale (QPS, data volume), consistency requirements, read/write ratio, query patterns, team expertise
2. **State your primary database**: give a concrete recommendation with the key reason
3. **Name one alternative**: show you know the tradeoffs
4. **Identify the hard constraint**: what is the forcing function (e.g., "if write throughput exceeds 50K/s, Cassandra over PostgreSQL")
5. **Address the PACELC tradeoff**: what consistency/latency trade are you making?

**Example answer template**:
> "For a ride-hailing system's trip data, I'd start with PostgreSQL for active trips (ACID required for status transitions: requested → confirmed → ongoing → completed). For historical trip analytics (100M+ rows), I'd partition PostgreSQL by month. If write throughput grows beyond PostgreSQL's capacity, I'd consider Cassandra with trip data partitioned by driver_id + time bucket. For real-time driver location (high-frequency writes, approximate queries), Redis geo operations or a time-series DB is more appropriate. For search and analytics on completed trips, Elasticsearch on a CDC pipeline from PostgreSQL."
