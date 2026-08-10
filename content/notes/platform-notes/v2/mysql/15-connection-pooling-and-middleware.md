# Chapter 15: Connection Pooling and Middleware — HikariCP, ProxySQL, and MySQL Router

> Every microservice, every API server, every batch job opens a connection to MySQL.
> Without pooling, each of those connections costs 2-10 ms to establish and ~2 MB of
> server-side memory. Multiply by hundreds of instances and you have a database spending
> more resources managing connections than executing queries. This chapter dissects the
> connection lifecycle from TCP handshake to thread teardown, then shows how HikariCP,
> ProxySQL, and MySQL Router solve this problem at different layers of the stack.

---

## 15.1 Why Connection Pooling Matters

### 15.1.1 The True Cost of a MySQL Connection

Opening a MySQL connection is not a single operation. It is a multi-step protocol
negotiation that touches the network stack, the TLS library, the authentication
subsystem, and the thread scheduler before a single query can execute.

```
   Client                                          MySQL Server
     │                                                  │
     │──── TCP SYN ─────────────────────────────────>│  │
     │<─── TCP SYN-ACK ────────────────────────────────│  1. TCP handshake
     │──── TCP ACK ─────────────────────────────────>│     (~0.2-1 ms LAN)
     │                                                  │
     │<─── Server Greeting (protocol ver, caps) ───────│  2. MySQL protocol
     │                                                  │     handshake
     │                                                  │
     │──── SSL/TLS ClientHello ─────────────────────>│  3. TLS negotiation
     │<─── ServerHello + Certificate ──────────────────│     (~1-3 ms)
     │──── ClientKeyExchange + Finished ────────────>│
     │<─── Finished ───────────────────────────────────│
     │                                                  │
     │──── Auth Response (user, password hash) ─────>│  4. Authentication
     │<─── OK / ERR packet ────────────────────────────│     (~0.5-2 ms)
     │                                                  │     (caching_sha2
     │                                                  │      or native)
     │──── SET NAMES utf8mb4 ───────────────────────>│  5. Session init
     │<─── OK ─────────────────────────────────────────│     (~0.1-0.5 ms)
     │──── SET autocommit=1 ────────────────────────>│
     │<─── OK ─────────────────────────────────────────│
     │                                                  │
     │  ═══ CONNECTION READY ═══                        │  Total: 2-10 ms
```

**Breakdown of connection cost:**

| Phase | Time (LAN) | Time (cross-AZ) | What Happens Server-Side |
|-------|------------|------------------|--------------------------|
| TCP handshake | 0.1-0.5 ms | 0.5-2 ms | Kernel accepts connection, creates socket |
| TLS negotiation | 1-3 ms | 2-5 ms | RSA/ECDHE key exchange, certificate verification |
| Authentication | 0.5-2 ms | 1-3 ms | `caching_sha2_password`: hash lookup, challenge-response |
| Thread creation | 0.1-0.5 ms | 0.1-0.5 ms | `pthread_create()`, allocate THD struct, per-session buffers |
| Session init | 0.2-1 ms | 0.5-2 ms | SET charset, timezone, autocommit, SQL mode |
| **Total** | **2-7 ms** | **4-13 ms** | **Thread ready to serve queries** |

### 15.1.2 Thread-Per-Connection Memory Cost

From Chapter 1, we know MySQL uses a thread-per-connection model. Each connection
creates one OS thread with its own stack and per-session buffers:

```
Per-Connection Memory Breakdown
================================

  thread_stack           =  1 MB   ← OS thread stack (default on 64-bit)
  sort_buffer_size       = 256 KB  ← allocated ON USE, not per-connection
  join_buffer_size       = 256 KB  ← allocated ON USE, per join operation
  read_buffer_size       = 128 KB  ← sequential scan buffer
  read_rnd_buffer_size   = 256 KB  ← random read buffer (MRR)
  binlog_cache_size      =  32 KB  ← transaction binlog cache
  tmp_table_size         =  16 MB  ← in-memory temp tables (worst case)
  net_buffer_length      =  16 KB  ← result set buffer (grows to max_allowed_packet)
  THD struct + session vars = ~40 KB ← internal metadata

  Minimum per connection: ~1.3 MB  (stack + THD + basic buffers)
  Typical under load:     ~2-4 MB  (sort + join + read buffers active)
  Worst case:             ~20 MB   (large temp tables + sort buffers)
```

Scale this to production:

```
Scenario                    Connections   Memory Overhead   MySQL Threads
─────────────────────────   ───────────   ───────────────   ─────────────
Small app, single instance      10            20 MB              10
Medium app, 10 instances        100          200 MB             100
Microservices, 50 instances     500            1 GB             500
Large platform, 200 instances  2000            4 GB            2000
Mega-scale, 500 instances      5000           10 GB            5000
```

At 2000+ connections, MySQL spends significant CPU on context switches between
threads and memory on per-session buffers. The `Threads_running` metric becomes
critical — even if 2000 connections exist, only 50-100 should be actively executing
queries at any moment. The rest should be idle.

>>> **Interview insight**: "How many connections should MySQL handle?" The answer is not
>>> `max_connections`. It is `Threads_running`. A server with 2000 connections but only
>>> 30 `Threads_running` is fine. A server with 200 connections but 200 `Threads_running`
>>> is in crisis — every thread competes for CPU, buffer pool mutexes, and row locks.
>>> The optimal `Threads_running` is typically 2-4x the CPU core count.

### 15.1.3 With Pooling vs Without Pooling

```
WITHOUT CONNECTION POOLING
══════════════════════════

  Request 1 ──> open connection (5ms) ──> query (2ms) ──> close connection
  Request 2 ──> open connection (5ms) ──> query (2ms) ──> close connection
  Request 3 ──> open connection (5ms) ──> query (2ms) ──> close connection
  ...
  1000 requests: 1000 × 5ms connect = 5 SECONDS of pure connection overhead
                 1000 × 2ms query   = 2 seconds of actual work
                 Total: 7 seconds   (71% overhead)


WITH CONNECTION POOLING (10 connections)
════════════════════════════════════════

  Pool init ──> open 10 connections (50ms total, once)

  Request 1 ──> borrow conn (0.01ms) ──> query (2ms) ──> return conn
  Request 2 ──> borrow conn (0.01ms) ──> query (2ms) ──> return conn
  Request 3 ──> borrow conn (0.01ms) ──> query (2ms) ──> return conn
  ...
  1000 requests: 1000 × 0.01ms borrow = 10ms pool overhead
                 1000 × 2ms query     = 2 seconds of actual work
                 Total: ~2.01 seconds  (0.5% overhead)

  Speedup: 3.5x — and the MySQL server handles 10 threads instead of 1000
```

The connection pool amortizes the creation cost across thousands of requests.
More importantly, it **caps the number of backend connections**, preventing the
database from being overwhelmed by a burst of traffic.

---

## 15.2 HikariCP — The Java Standard

HikariCP ("light" in Japanese) is the default connection pool in Spring Boot and the
de facto standard for Java applications talking to MySQL. Its design philosophy is
ruthless minimalism: fewer lines of code, fewer allocations, fewer locks.

### 15.2.1 Architecture — ConcurrentBag

The core data structure is `ConcurrentBag<PoolEntry>`, a custom collection designed
for connection pool access patterns. It operates at three levels:

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ConcurrentBag                                 │
│                                                                      │
│  LEVEL 1: Thread-Local List (FASTEST PATH)                          │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  ThreadLocal<List<PoolEntry>>                                    │ │
│  │                                                                  │ │
│  │  Thread-1: [conn_A, conn_D]    ← last connections used by T1    │ │
│  │  Thread-2: [conn_B]            ← last connection used by T2     │ │
│  │  Thread-3: [conn_C, conn_E]    ← last connections used by T3    │ │
│  │                                                                  │ │
│  │  Access: NO LOCK, direct array scan                              │ │
│  │  Latency: ~10-30 ns                                              │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                              │ miss                                   │
│                              ▼                                        │
│  LEVEL 2: Shared List (SLOW PATH)                                   │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  CopyOnWriteArrayList<PoolEntry>                                 │ │
│  │                                                                  │ │
│  │  [conn_A, conn_B, conn_C, conn_D, conn_E, conn_F, ...]         │ │
│  │                                                                  │ │
│  │  Access: CAS on PoolEntry.state (NOT_IN_USE → IN_USE)           │ │
│  │  Latency: ~50-200 ns (scan + CAS)                               │ │
│  │  "Steal" a connection from another thread's last-used list       │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                              │ miss                                   │
│                              ▼                                        │
│  LEVEL 3: Hand-Off Queue (WAIT PATH)                                │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  SynchronousQueue<PoolEntry>                                     │ │
│  │                                                                  │ │
│  │  Waiting threads park here until:                                │ │
│  │    1. A connection is returned by another thread                  │ │
│  │    2. A new connection is created (if pool < maxPoolSize)         │ │
│  │    3. connectionTimeout expires → SQLException thrown             │ │
│  │                                                                  │ │
│  │  Access: LockSupport.park / unpark                               │ │
│  │  Latency: microseconds to connectionTimeout                      │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

**Why ThreadLocal first?** CPU cache locality. When Thread-1 reuses the same connection
it used last time, the MySQL session state (prepared statements, autocommit state,
character set) is already correct — no `SET` commands needed. The JDBC connection
object and its internal buffers are likely still in the thread's L1/L2 cache.

**Why CopyOnWriteArrayList?** The shared list is read-heavy (scanned on every
`getConnection()` that misses thread-local) and write-rare (only written when a
connection is created or destroyed). `CopyOnWriteArrayList` gives lock-free reads
at the cost of copy-on-write for mutations — an ideal tradeoff for pool sizes of
10-50 entries.

**State machine for each PoolEntry:**

```
                   ┌─────────────────────────┐
                   │                         │
                   ▼                         │
    ┌───────────────────┐          ┌─────────┴─────────┐
    │   NOT_IN_USE      │──CAS──>│     IN_USE          │
    │   (available in   │         │   (checked out to   │
    │    pool)          │<────────│    application)     │
    └───────┬───────────┘ return  └─────────────────────┘
            │                              │
            │ evict (idle/maxLife)          │ evict (broken)
            ▼                              ▼
    ┌───────────────────┐          ┌───────────────────┐
    │    REMOVED         │          │    RESERVED        │
    │   (being closed)  │          │  (being created/   │
    │                   │          │   validated)        │
    └───────────────────┘          └───────────────────┘
```

All state transitions use `compareAndSet()` — no synchronized blocks, no
`ReentrantLock`. This is why HikariCP benchmarks show sub-microsecond
`getConnection()` latency on the fast path.

### 15.2.2 Connection Lifecycle

```
Application calls dataSource.getConnection()
        │
        ▼
  ┌─────────────────────┐
  │ 1. Check thread-    │─── hit ──> CAS(NOT_IN_USE → IN_USE)
  │    local list       │            return connection
  └────────┬────────────┘            (cost: ~15 ns)
           │ miss
           ▼
  ┌─────────────────────┐
  │ 2. Scan shared      │─── hit ──> CAS(NOT_IN_USE → IN_USE)
  │    list (all        │            add to thread-local list
  │    PoolEntries)     │            return connection
  └────────┬────────────┘            (cost: ~100 ns)
           │ miss (all IN_USE)
           ▼
  ┌─────────────────────┐
  │ 3. Pool size <      │─── yes ──> Create new connection
  │    maxPoolSize?     │            (TCP + auth: 2-10 ms)
  └────────┬────────────┘            Add to shared list
           │ no                      return connection
           ▼
  ┌─────────────────────┐
  │ 4. Wait on          │─── signaled ──> Receive connection
  │    SynchronousQueue │                  return to caller
  │    (up to           │
  │    connectionTimeout│─── timeout ──> throw SQLException
  │    = 30s default)   │    "Connection is not available,
  └─────────────────────┘     request timed out after 30000ms"


Application calls connection.close()  (returns to pool, NOT socket close)
        │
        ▼
  ┌─────────────────────┐
  │ 1. CAS(IN_USE →     │
  │    NOT_IN_USE)       │
  └────────┬─────────────┘
           │
           ▼
  ┌─────────────────────┐
  │ 2. Check: any       │─── yes ──> Hand off via SynchronousQueue
  │    threads waiting?  │            (LockSupport.unpark waiter)
  └────────┬─────────────┘
           │ no waiters
           ▼
  ┌─────────────────────┐
  │ 3. Add to this      │
  │    thread's local   │
  │    list for reuse   │
  └─────────────────────┘
```

### 15.2.3 Critical Configuration

```java
HikariConfig config = new HikariConfig();

// === Pool Sizing ===
config.setMaximumPoolSize(10);       // Hard ceiling on connections
                                     // Formula: (2 × CPU_cores) + effective_spindles
                                     // SSD: spindles=1, so pool = 2×cores + 1
                                     // e.g., 4 cores → pool = 9 ≈ 10

config.setMinimumIdle(10);           // Keep pool full at all times
                                     // Set equal to maxPoolSize for production
                                     // Avoids resize churn under bursty load
                                     // Different values only for dev/test

// === Timeout and Lifecycle ===
config.setConnectionTimeout(30_000); // 30 seconds — max wait for connection
                                     // Fail fast: don't let threads queue forever
                                     // If you hit this, pool is undersized or
                                     // queries are too slow

config.setIdleTimeout(600_000);      // 10 minutes — evict idle connections
                                     // Only applies if minimumIdle < maximumPoolSize
                                     // When minimumIdle = maximumPoolSize, ignored

config.setMaxLifetime(1_800_000);    // 30 minutes — HARD LIMIT on connection age
                                     // MUST be < MySQL wait_timeout (default 28800s)
                                     // Prevents stale connections after network hiccup
                                     // Connections rotate gracefully (not all at once)

config.setKeepaliveTime(60_000);     // Ping every 60s [HikariCP 4.0+]
                                     // Sends a lightweight health check
                                     // Prevents firewall/LB from killing idle conns

config.setValidationTimeout(5_000);  // Max 5s to validate a connection is alive
                                     // Uses JDBC4 Connection.isValid(timeout)
                                     // Faster than running a test query

// === MySQL Connector/J Optimizations ===
config.addDataSourceProperty("cachePrepStmts", "true");
config.addDataSourceProperty("prepStmtCacheSize", "250");
config.addDataSourceProperty("prepStmtCacheSqlLimit", "2048");
config.addDataSourceProperty("useServerPrepStmts", "true");
config.addDataSourceProperty("useLocalSessionState", "true");
config.addDataSourceProperty("rewriteBatchedStatements", "true");
config.addDataSourceProperty("cacheResultSetMetadata", "true");
config.addDataSourceProperty("elideSetAutoCommits", "true");
```

### 15.2.4 Pool Sizing — The Theory and the Practice

The formal pool sizing formula comes from the HikariCP wiki:

```
pool_size = Tn × (Cm - 1) + 1

Where:
  Tn = number of threads that need a database connection simultaneously
  Cm = number of simultaneous connections each thread holds
```

**Example**: A web server with 20 Tomcat threads, each holding 1 connection at a time:

```
pool_size = 20 × (1 - 1) + 1 = 1    ← Theoretical minimum (all queries serial)
```

This is too aggressive. In practice, concurrent requests overlap:

```
Thread-1:  |---query-A---|
Thread-2:       |---query-B---|
Thread-3:            |---query-C---|
                ^
                At this point, 3 connections needed simultaneously
```

**Practical rules:**

| Scenario | Recommended Pool Size | Reasoning |
|----------|----------------------|-----------|
| OLTP web app (4 cores) | 10 | `2 × 4 + 2 = 10`, most queries < 5ms |
| OLTP web app (16 cores) | 20-30 | More cores, more parallel queries |
| Batch processing | 5-8 | Long transactions, fewer concurrent |
| Mixed OLTP + reporting | 15 + dedicated reporting pool | Isolate workloads |
| Microservice (2 vCPU pod) | 5-8 | Small pods, limit per-pod footprint |

>>> **Interview insight**: The biggest misconception is "more connections = more throughput."
>>> PostgreSQL published the definitive graph: a connection pool of 10 outperforms a pool
>>> of 200 on a 4-core server. Why? Beyond the CPU core count, additional threads add
>>> context switch overhead, lock contention, and cache thrashing. The pool should be
>>> sized to the database server's parallelism capacity, NOT the application's thread count.

### 15.2.5 maxLifetime vs MySQL wait_timeout — The Critical Relationship

```
MySQL server:  wait_timeout = 28800 (8 hours)  ← server will close idle connections
                                                  after this duration

HikariCP:      maxLifetime  = 1800000 (30 min) ← client retires connections before
                                                  server can close them


Timeline (one connection):
─────────────────────────────────────────────────────────────────>
0 min              30 min              60 min              90 min
  |───── conn ──────|                    |                    |
  created       HikariCP retires    new conn created      retired
                (maxLifetime)       to replace it


What happens if maxLifetime > wait_timeout:
─────────────────────────────────────────────────────────────────>
0 min              8 hours
  |───── conn ──────X ERROR!
  created       MySQL closes it (wait_timeout)
                Next query on this connection:
                  "Communications link failure"
                  "The last packet successfully received was..."
```

**Rule**: `maxLifetime = wait_timeout - 30 seconds`

For cloud databases with lower `wait_timeout`:

| Environment | wait_timeout | Recommended maxLifetime |
|-------------|-------------|------------------------|
| Self-hosted MySQL (default) | 28800 (8 hrs) | 1800000 (30 min) |
| AWS RDS | 28800 (8 hrs) | 1800000 (30 min) |
| AWS Aurora | 28800 (8 hrs) | 1800000 (30 min) |
| GCP Cloud SQL | 28800 (8 hrs) | 1800000 (30 min) |
| PlanetScale | 900 (15 min) | 870000 (14.5 min) |
| Vitess-based | 600 (10 min) | 570000 (9.5 min) |

>>> **Interview insight**: "We get intermittent `CommunicationsException` at 3 AM."
>>> Classic symptom of maxLifetime > wait_timeout. At 3 AM, traffic is low. Connections
>>> sit idle. MySQL closes them at wait_timeout. HikariCP doesn't know — the PoolEntry
>>> still shows NOT_IN_USE. Next morning request grabs a dead connection. Fix: set
>>> maxLifetime below wait_timeout. HikariCP 4.0+ `keepaliveTime` also helps by pinging
>>> connections periodically.

### 15.2.6 HikariCP Monitoring

HikariCP exposes metrics via Micrometer (Spring Boot Actuator) or JMX:

```
Key Metrics (via Micrometer):
═══════════════════════════════════════════════════════════════════

hikaricp_connections_active{pool="MyAppPool"}
  → Currently checked-out connections
  → Alert if sustained at maxPoolSize for > 30s

hikaricp_connections_idle{pool="MyAppPool"}
  → Available connections in the pool
  → Should generally be > 0

hikaricp_connections_pending{pool="MyAppPool"}
  → Threads waiting for a connection
  → Alert if > 0 for sustained periods
  → > 0 means pool exhaustion is occurring

hikaricp_connections_total{pool="MyAppPool"}
  → Total pool size (active + idle)
  → Should be stable at maximumPoolSize

hikaricp_connections_timeout_total{pool="MyAppPool"}
  → Counter of connection acquisition timeouts (SQLExceptions thrown)
  → Alert if > 0 — means requests are failing

hikaricp_connections_creation_seconds_sum{pool="MyAppPool"}
  → Time spent creating new physical connections
  → Spike here = MySQL server or network issues

hikaricp_connections_usage_seconds{pool="MyAppPool"}
  → Timer: how long connections are held by application code
  → High p99 = slow queries or missing connection.close()
```

**Grafana Dashboard Panels:**

```
 ┌──────────────────────────────────────────────────────────────┐
 │  Pool Utilization (%)         │  Pending Threads             │
 │  ┌──────────────────────┐    │  ┌──────────────────────┐    │
 │  │  ████████░░  80%     │    │  │  ░░░░░░░░░░  0       │    │
 │  │  active/total        │    │  │  ALERT if > 0         │    │
 │  └──────────────────────┘    │  └──────────────────────┘    │
 ├──────────────────────────────┼──────────────────────────────┤
 │  Connection Acquire Time     │  Timeout Count               │
 │  ┌──────────────────────┐    │  ┌──────────────────────┐    │
 │  │  p50: 0.02ms         │    │  │  total: 0             │    │
 │  │  p99: 0.15ms         │    │  │  ALERT if > 0         │    │
 │  │  p999: 1.2ms         │    │  │  (requests failing)   │    │
 │  └──────────────────────┘    │  └──────────────────────┘    │
 └──────────────────────────────────────────────────────────────┘
```

---

## 15.3 Spring Boot Integration

### 15.3.1 Default Auto-Configuration

Spring Boot 2.x+ auto-configures HikariCP as the default `DataSource` when
`spring-boot-starter-jdbc` or `spring-boot-starter-data-jpa` is on the classpath.
No manual bean definition needed.

**application.yml — Production Configuration:**

```yaml
spring:
  datasource:
    url: jdbc:mysql://primary.db:3306/myapp?useSSL=true&requireSSL=true&serverTimezone=UTC&characterEncoding=UTF-8
    username: app_user
    password: ${DB_PASSWORD}          # Inject from environment variable or Vault
    driver-class-name: com.mysql.cj.jdbc.Driver
    hikari:
      pool-name: MyAppPool
      maximum-pool-size: 10
      minimum-idle: 10                # Equal to max for stable pool
      idle-timeout: 600000            # 10 minutes
      max-lifetime: 1800000           # 30 min (must be < MySQL wait_timeout)
      connection-timeout: 30000       # 30 seconds
      keepalive-time: 60000           # Ping every 60s
      validation-timeout: 5000        # 5s to validate
      leak-detection-threshold: 60000 # Log warning if conn held > 60s
      data-source-properties:
        cachePrepStmts: true
        prepStmtCacheSize: 250
        prepStmtCacheSqlLimit: 2048
        useServerPrepStmts: true
        useLocalSessionState: true
        rewriteBatchedStatements: true
        cacheResultSetMetadata: true
        elideSetAutoCommits: true
```

### 15.3.2 Read/Write Splitting with AbstractRoutingDataSource

For applications with a primary and one or more replicas, Spring provides
`AbstractRoutingDataSource` to route queries to the appropriate backend.

```java
public class ReadWriteRoutingDataSource extends AbstractRoutingDataSource {

    @Override
    protected Object determineCurrentLookupKey() {
        // TransactionSynchronizationManager tracks the current tx attributes
        boolean isReadOnly = TransactionSynchronizationManager
                .isCurrentTransactionReadOnly();
        return isReadOnly ? DataSourceType.REPLICA : DataSourceType.PRIMARY;
    }
}

public enum DataSourceType {
    PRIMARY,   // DML, DDL, SELECT ... FOR UPDATE
    REPLICA    // Read-only SELECT queries
}
```

**Configuration class:**

```java
@Configuration
public class DataSourceConfig {

    @Bean
    @ConfigurationProperties("spring.datasource.primary.hikari")
    public HikariDataSource primaryDataSource() {
        return new HikariDataSource();
    }

    @Bean
    @ConfigurationProperties("spring.datasource.replica.hikari")
    public HikariDataSource replicaDataSource() {
        return new HikariDataSource();
    }

    @Bean
    @Primary
    public DataSource routingDataSource(
            @Qualifier("primaryDataSource") DataSource primary,
            @Qualifier("replicaDataSource") DataSource replica) {

        ReadWriteRoutingDataSource routing = new ReadWriteRoutingDataSource();
        Map<Object, Object> dataSources = new HashMap<>();
        dataSources.put(DataSourceType.PRIMARY, primary);
        dataSources.put(DataSourceType.REPLICA, replica);
        routing.setTargetDataSources(dataSources);
        routing.setDefaultTargetDataSource(primary);
        return routing;
    }
}
```

**Usage in service layer:**

```java
@Service
public class OrderService {

    @Transactional(readOnly = true)   // ← routes to REPLICA
    public List<Order> getOrders(Long userId) {
        return orderRepository.findByUserId(userId);
    }

    @Transactional                     // ← routes to PRIMARY
    public Order createOrder(OrderRequest req) {
        Order order = new Order(req);
        return orderRepository.save(order);
    }

    @Transactional                     // ← routes to PRIMARY (default)
    public void cancelOrder(Long orderId) {
        Order order = orderRepository.findById(orderId)
                .orElseThrow(() -> new NotFoundException(orderId));
        order.setStatus(OrderStatus.CANCELLED);
        orderRepository.save(order);
    }
}
```

**application.yml for multi-datasource:**

```yaml
spring:
  datasource:
    primary:
      hikari:
        jdbc-url: jdbc:mysql://primary.db:3306/myapp
        username: app_writer
        password: ${DB_WRITER_PASSWORD}
        maximum-pool-size: 10
        pool-name: PrimaryPool
    replica:
      hikari:
        jdbc-url: jdbc:mysql://replica.db:3306/myapp
        username: app_reader
        password: ${DB_READER_PASSWORD}
        maximum-pool-size: 15          # Replicas handle more read traffic
        pool-name: ReplicaPool
```

>>> **Interview insight**: `@Transactional(readOnly = true)` does more than route to a
>>> replica. It tells the JDBC driver to set the session as read-only (`SET SESSION
>>> TRANSACTION READ ONLY`), which allows InnoDB to skip undo log generation and
>>> transaction ID assignment for pure reads. Combined with routing to a replica, this
>>> offloads read traffic from the primary and reduces replication lag by lowering primary
>>> load.

---

## 15.4 JDBC Driver Tuning (MySQL Connector/J)

The MySQL Connector/J driver has configuration properties that dramatically affect
performance. These are set as URL parameters or `dataSourceProperties` in HikariCP.

### 15.4.1 Prepared Statement Optimization

```
WITHOUT Server-Side Prepared Statements:
════════════════════════════════════════

  App                          MySQL
   │── COM_QUERY ──────────>│
   │   "SELECT * FROM        │  Parse SQL ──> Optimize ──> Execute
   │    users WHERE id=42"   │  (full parse every time)
   │<── Result ──────────────│
   │                         │
   │── COM_QUERY ──────────>│
   │   "SELECT * FROM        │  Parse SQL ──> Optimize ──> Execute
   │    users WHERE id=99"   │  (SAME PARSE, SAME PLAN, wasted CPU)
   │<── Result ──────────────│


WITH Server-Side Prepared Statements (useServerPrepStmts=true):
═══════════════════════════════════════════════════════════════

  App                          MySQL
   │── COM_STMT_PREPARE ───>│
   │   "SELECT * FROM        │  Parse ──> Optimize ──> Store plan
   │    users WHERE id=?"    │  Return stmt_id=7
   │<── OK (stmt_id=7) ─────│
   │                         │
   │── COM_STMT_EXECUTE ───>│
   │   stmt_id=7, param=42   │  Lookup plan ──> Bind param ──> Execute
   │<── Result ──────────────│   (NO re-parse, NO re-optimize)
   │                         │
   │── COM_STMT_EXECUTE ───>│
   │   stmt_id=7, param=99   │  Lookup plan ──> Bind param ──> Execute
   │<── Result ──────────────│   (reused plan, binary protocol)
```

**Driver properties and their effects:**

| Property | Default | Recommended | Effect |
|----------|---------|-------------|--------|
| `useServerPrepStmts` | false | true | Use MySQL server-side prepared statements (COM_STMT_PREPARE) |
| `cachePrepStmts` | false | true | Cache PreparedStatement objects client-side per connection |
| `prepStmtCacheSize` | 25 | 250 | Max cached prepared statements per connection |
| `prepStmtCacheSqlLimit` | 256 | 2048 | Max SQL length for cache key (bytes). Longer queries not cached |

**Why `prepStmtCacheSize=250`?** A typical Java application has 50-200 distinct SQL
statements. Setting the cache too small causes eviction churn. Setting too large
wastes memory (each cached PreparedStatement holds server resources). 250 covers
most applications with headroom.

### 15.4.2 Batch Statement Rewriting

```
WITHOUT rewriteBatchedStatements:
═════════════════════════════════

  App executes:
    PreparedStatement ps = conn.prepareStatement("INSERT INTO orders VALUES (?,?,?)");
    ps.setLong(1, 1001); ps.setString(2, "A"); ps.setBigDecimal(3, price1); ps.addBatch();
    ps.setLong(1, 1002); ps.setString(2, "B"); ps.setBigDecimal(3, price2); ps.addBatch();
    ps.setLong(1, 1003); ps.setString(2, "C"); ps.setBigDecimal(3, price3); ps.addBatch();
    ps.executeBatch();

  Wire protocol sends:
    INSERT INTO orders VALUES (1001, 'A', 10.00)     ← Round trip 1
    INSERT INTO orders VALUES (1002, 'B', 20.00)     ← Round trip 2
    INSERT INTO orders VALUES (1003, 'C', 30.00)     ← Round trip 3

  3 round trips, 3 separate InnoDB transactions (if autocommit=ON)


WITH rewriteBatchedStatements=true:
═══════════════════════════════════

  Same Java code, but the driver rewrites the batch into:

    INSERT INTO orders VALUES (1001,'A',10.00),(1002,'B',20.00),(1003,'C',30.00)

  1 round trip, 1 parse, 1 InnoDB insert operation
  Result: 10-50x faster for batch inserts
```

>>> **Interview insight**: `rewriteBatchedStatements=true` is the single highest-impact
>>> JDBC tuning for bulk inserts. A batch of 1000 rows goes from 1000 round trips to 1.
>>> But it only works with INSERT. UPDATE and DELETE batches are still sent individually.
>>> Also beware: the rewritten multi-value INSERT can exceed `max_allowed_packet` if the
>>> batch is very large — split batches into chunks of 500-1000 rows.

### 15.4.3 Session State Optimization

```
WITHOUT useLocalSessionState and elideSetAutoCommits:
═══════════════════════════════════════════════════════

  App: conn.setAutoCommit(true)
  Driver: SET autocommit=1           ← Round trip (even if already true)

  App: conn.setAutoCommit(true)
  Driver: SET autocommit=1           ← ANOTHER round trip (redundant!)

  App: conn.setReadOnly(true)
  Driver: SET SESSION TRANSACTION READ ONLY    ← Round trip

  Every connection checkout from pool: 2-3 unnecessary SET commands


WITH useLocalSessionState=true, elideSetAutoCommits=true:
═════════════════════════════════════════════════════════

  App: conn.setAutoCommit(true)
  Driver: (checks local state: already true → skip)    ← NO round trip

  App: conn.setAutoCommit(true)
  Driver: (still true → skip)                          ← NO round trip

  App: conn.setReadOnly(true)
  Driver: (state changed → send SET command)           ← Only when needed
```

### 15.4.4 Complete Driver Property Reference

```
JDBC URL with all optimizations:

jdbc:mysql://primary.db:3306/myapp
  ?useSSL=true
  &requireSSL=true
  &serverTimezone=UTC
  &characterEncoding=UTF-8
  &useServerPrepStmts=true
  &cachePrepStmts=true
  &prepStmtCacheSize=250
  &prepStmtCacheSqlLimit=2048
  &useLocalSessionState=true
  &elideSetAutoCommits=true
  &rewriteBatchedStatements=true
  &cacheResultSetMetadata=true
  &useCompression=false            ← enable only for high-latency links
  &connectionTimeZone=SERVER
  &maintainTimeStats=false         ← disable if not using slow query stats
  &useUnbufferedInput=false
  &socketTimeout=60000             ← 60s socket-level timeout (safety net)
```

| Property | Purpose | CPU Trade-off |
|----------|---------|---------------|
| `useServerPrepStmts=true` | Server-side prepared statements | Saves server CPU on repeated queries |
| `cachePrepStmts=true` | Client-side PS cache | Saves client memory allocation + server re-prepare |
| `rewriteBatchedStatements=true` | Multi-row INSERT rewrite | Saves network round trips |
| `useLocalSessionState=true` | Track session state locally | Saves SET command round trips |
| `elideSetAutoCommits=true` | Skip redundant autocommit SETs | Saves round trips |
| `cacheResultSetMetadata=true` | Cache column metadata | Saves serialization on repeated queries |
| `useCompression=true` | gzip wire protocol | Saves bandwidth, costs CPU (both sides) |
| `connectionTimeZone=SERVER` | Use server timezone | Avoids timezone conversion overhead |

---

## 15.5 ProxySQL — MySQL-Aware Proxy

ProxySQL is a high-performance, protocol-aware proxy for MySQL. Unlike a generic TCP
proxy (HAProxy, Envoy), ProxySQL understands the MySQL wire protocol, parses queries,
and makes routing decisions based on query content.

### 15.5.1 Architecture

```
 ┌───────────────────────────────────────────────────────────────────────┐
 │                       APPLICATION LAYER                               │
 │                                                                       │
 │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
 │  │ App Pod 1│ │ App Pod 2│ │ App Pod 3│ │ App Pod 4│ │ App Pod N│  │
 │  │ Pool: 10 │ │ Pool: 10 │ │ Pool: 10 │ │ Pool: 10 │ │ Pool: 10 │  │
 │  └─────┬────┘ └─────┬────┘ └─────┬────┘ └─────┬────┘ └─────┬────┘  │
 │        │            │            │            │            │         │
 │        └────────────┴────────────┴────────────┴────────────┘         │
 │                               │                                      │
 │                  50 app connections per pod                           │
 │                  × N pods = hundreds of frontend conns                │
 └───────────────────────────────┬──────────────────────────────────────┘
                                 │
                                 ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │                        PROXYSQL                                       │
 │                                                                       │
 │  ┌─────────────┐   ┌─────────────────┐   ┌──────────────────────┐   │
 │  │ FRONTEND    │   │ QUERY PROCESSOR  │   │ BACKEND              │   │
 │  │             │   │                  │   │ CONNECTION POOLS     │   │
 │  │ Listens on  │──>│ Parse query      │──>│                      │   │
 │  │ port 6033   │   │ Match rules      │   │ HG 10 (writer):     │   │
 │  │             │   │ Route to         │   │   primary:3306 ×20  │   │
 │  │ Accepts     │   │   hostgroup      │   │                      │   │
 │  │ MySQL       │   │ Rewrite query    │   │ HG 20 (reader):     │   │
 │  │ protocol    │   │ Check cache      │   │   replica1:3306 ×15 │   │
 │  │             │   │ Multiplex conn   │   │   replica2:3306 ×15 │   │
 │  └─────────────┘   └─────────────────┘   └──────────┬───────────┘   │
 │                                                      │               │
 │  ┌─────────────┐   ┌─────────────────┐              │               │
 │  │ ADMIN       │   │ STATS           │              │               │
 │  │ port 6032   │   │ Connection pool │              │               │
 │  │ MySQL CLI   │   │   stats, query  │              │               │
 │  │ compatible  │   │   digest stats  │              │               │
 │  └─────────────┘   └─────────────────┘              │               │
 └─────────────────────────────────────────────────────┬───────────────┘
                                                       │
                                                       ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │                       MYSQL BACKENDS                                  │
 │                                                                       │
 │  ┌────────────────┐   ┌────────────────┐   ┌────────────────┐       │
 │  │   PRIMARY       │   │   REPLICA 1     │   │   REPLICA 2     │       │
 │  │   primary:3306  │   │   replica1:3306 │   │   replica2:3306 │       │
 │  │                 │   │                 │   │                 │       │
 │  │ Threads: 20     │   │ Threads: 15     │   │ Threads: 15     │       │
 │  │ (NOT 500)       │   │ (NOT 500)       │   │ (NOT 500)       │       │
 │  └────────────────┘   └────────────────┘   └────────────────┘       │
 └───────────────────────────────────────────────────────────────────────┘

  Connection multiplexing effect:
    Frontend connections (apps → ProxySQL): 500+
    Backend connections (ProxySQL → MySQL):  50
    Multiplexing ratio: 10:1
```

### 15.5.2 Connection Multiplexing Internals

Multiplexing is ProxySQL's most important feature. It decouples the frontend
connection count from the backend connection count.

```
Without ProxySQL (direct connection):
═════════════════════════════════════

  App conn 1 ──────────────────────────────> MySQL thread 1
  App conn 2 ──────────────────────────────> MySQL thread 2
  App conn 3 ──────────────────────────────> MySQL thread 3
  ...
  App conn 500 ────────────────────────────> MySQL thread 500

  500 app connections = 500 MySQL threads
  Most are IDLE (Sleep state), wasting memory


With ProxySQL multiplexing:
═══════════════════════════

  App conn 1 ──┐
  App conn 2 ──┤                         ┌──> MySQL thread 1
  App conn 3 ──┤    ┌───────────────┐    ├──> MySQL thread 2
  App conn 4 ──┼───>│   ProxySQL    │───>├──> MySQL thread 3
  App conn 5 ──┤    │   backend     │    ├──> ...
  ...          │    │   pool        │    └──> MySQL thread 20
  App conn 500 ┘    └───────────────┘

  500 app connections → 20 MySQL threads
  ProxySQL assigns a backend connection only when a query arrives
  Returns backend to pool when query completes (between transactions)
```

**How multiplexing works per query:**

```
1. App sends query on frontend connection #47
2. ProxySQL parses query, determines target hostgroup (writer vs reader)
3. ProxySQL borrows a backend connection from hostgroup pool
4. ProxySQL forwards query to MySQL via backend connection
5. MySQL executes, returns result
6. ProxySQL forwards result to app on frontend connection #47
7. ProxySQL returns backend connection to pool
8. Frontend connection #47 remains open but consumes NO backend resource

Exception: if app starts a transaction (BEGIN/START TRANSACTION),
ProxySQL pins the backend connection to the frontend connection
for the duration of the transaction (cannot multiplex mid-transaction).
```

>>> **Interview insight**: ProxySQL multiplexing breaks under long transactions. If an
>>> application holds transactions open for seconds (e.g., user interaction within a
>>> transaction), backend connections get pinned and multiplexing ratio degrades to 1:1.
>>> Design rule: keep transactions as short as possible. Never hold a transaction open
>>> while waiting for user input or external API calls.

### 15.5.3 Read/Write Splitting Configuration

```sql
-- Connect to ProxySQL admin interface
-- mysql -h 127.0.0.1 -P 6032 -u admin -padmin

-- Step 1: Define backend MySQL servers
INSERT INTO mysql_servers (hostgroup_id, hostname, port, weight, max_connections) VALUES
  (10, 'primary.db.internal',  3306, 1,   50),   -- HG 10 = writer
  (20, 'replica1.db.internal', 3306, 100, 100),  -- HG 20 = reader (weight=100)
  (20, 'replica2.db.internal', 3306, 100, 100);  -- HG 20 = reader (weight=100)

-- Step 2: Define ProxySQL user (must match MySQL user)
INSERT INTO mysql_users (username, password, default_hostgroup) VALUES
  ('app_user', 'password_hash', 10);    -- Default to writer if no rule matches

-- Step 3: Define query rules for read/write splitting
INSERT INTO mysql_query_rules
  (rule_id, active, match_digest, destination_hostgroup, apply) VALUES
  (100, 1, '^SELECT.*FOR UPDATE',      10, 1),  -- FOR UPDATE → writer
  (200, 1, '^SELECT.*FOR SHARE',       10, 1),  -- FOR SHARE → writer
  (300, 1, '^SELECT',                  20, 1),  -- All other SELECT → reader
  (400, 1, '^(INSERT|UPDATE|DELETE)',   10, 1);  -- DML → writer (default)

-- Step 4: Load configuration to runtime
LOAD MYSQL SERVERS TO RUNTIME;
SAVE MYSQL SERVERS TO DISK;
LOAD MYSQL USERS TO RUNTIME;
SAVE MYSQL USERS TO DISK;
LOAD MYSQL QUERY RULES TO RUNTIME;
SAVE MYSQL QUERY RULES TO DISK;
```

### 15.5.4 Query Caching

ProxySQL includes a built-in query cache — a replacement for MySQL's removed
query cache (removed in 8.0). Unlike MySQL's old query cache, ProxySQL's version
sits outside the database and does not suffer from the global mutex problem.

```sql
-- Cache all SELECT queries matching this pattern for 5 seconds
INSERT INTO mysql_query_rules
  (rule_id, active, match_digest, cache_ttl, destination_hostgroup, apply) VALUES
  (50, 1, '^SELECT .* FROM products WHERE category_id', 5000, 20, 1);

-- cache_ttl is in milliseconds
-- Cached results are served directly from ProxySQL memory
-- No backend connection needed for cache hits

LOAD MYSQL QUERY RULES TO RUNTIME;
```

**Query cache flow:**

```
Request arrives at ProxySQL
       │
       ▼
  ┌─────────────┐
  │ Compute      │
  │ query digest │──── hash(normalized SQL + params)
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐     ┌────────────────────┐
  │ Cache lookup │──>│ Hit: return cached  │
  └──────┬──────┘     │ result (0.01ms)     │
         │ miss       └────────────────────┘
         ▼
  ┌─────────────┐
  │ Forward to   │
  │ MySQL backend│──── execute query
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ Store result │
  │ in cache     │──── with TTL from query rule
  │ Return to    │
  │ client       │
  └─────────────┘
```

### 15.5.5 Query Rewriting and Routing

```sql
-- Example 1: Rewrite queries to add optimizer hints
INSERT INTO mysql_query_rules
  (rule_id, active, match_pattern, replace_pattern, apply) VALUES
  (500, 1,
   'SELECT (.*) FROM orders WHERE user_id',
   'SELECT /*+ INDEX(orders idx_user_created) */ \1 FROM orders WHERE user_id',
   1);

-- Example 2: Route analytics queries to dedicated replica
INSERT INTO mysql_query_rules
  (rule_id, active, match_digest, destination_hostgroup, apply) VALUES
  (600, 1, '^SELECT.*GROUP BY.*HAVING',  30, 1);  -- HG 30 = analytics replica

-- Example 3: Block dangerous queries
INSERT INTO mysql_query_rules
  (rule_id, active, match_digest, error_msg, apply) VALUES
  (700, 1, '^SELECT.*FROM users$',
   'Query rejected: full table scan on users table not allowed', 1);

LOAD MYSQL QUERY RULES TO RUNTIME;
```

### 15.5.6 Health Checks and Failover

```sql
-- ProxySQL monitors backends via configurable health checks
UPDATE global_variables SET variable_value='2000'
  WHERE variable_name='mysql-monitor_connect_interval';     -- Check connectivity every 2s

UPDATE global_variables SET variable_value='1500'
  WHERE variable_name='mysql-monitor_ping_interval';        -- Ping every 1.5s

UPDATE global_variables SET variable_value='2000'
  WHERE variable_name='mysql-monitor_read_only_interval';   -- Check read_only every 2s

-- Automatic failover: if primary becomes read_only=1 (promoted replica),
-- ProxySQL moves it to the reader hostgroup
-- Works with orchestrator/MHA/InnoDB Cluster failover

UPDATE global_variables SET variable_value='true'
  WHERE variable_name='mysql-monitor_writer_is_also_reader';

LOAD MYSQL VARIABLES TO RUNTIME;
```

**Failover detection flow:**

```
ProxySQL monitor thread (runs continuously)
       │
       ├── Every 2s: check_connectivity(each backend)
       │     └── If connect fails 3 times → SHUNNED (removed from rotation)
       │
       ├── Every 1.5s: ping(each backend)
       │     └── If ping fails → SHUNNED
       │
       └── Every 2s: SELECT @@read_only (each backend)
             ├── read_only=0 → writer hostgroup (HG 10)
             └── read_only=1 → reader hostgroup (HG 20)

After failover (e.g., orchestrator promotes replica2):
  Old primary (primary.db):   read_only=1 → moved to HG 20 (reader)
  New primary (replica2.db):  read_only=0 → moved to HG 10 (writer)
  ProxySQL routes new writes to replica2.db automatically
```

---

## 15.6 MySQL Router (InnoDB Cluster)

MySQL Router is the official MySQL proxy, designed to work tightly with InnoDB
Cluster (Group Replication + MySQL Shell + Router). It is simpler than ProxySQL
but deeply integrated with the cluster metadata.

### 15.6.1 Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                      InnoDB Cluster                                    │
│                                                                       │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                │
│  │  Member 1    │   │  Member 2    │   │  Member 3    │                │
│  │  (PRIMARY)   │   │ (SECONDARY) │   │ (SECONDARY) │                │
│  │  R/W         │   │  R/O         │   │  R/O         │                │
│  │              │   │              │   │              │                │
│  │  Group       │◄─►│  Group       │◄─►│  Group       │                │
│  │  Replication │   │  Replication │   │  Replication │                │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘                │
│         │                  │                  │                        │
│         └─────────┬────────┴────────┬─────────┘                        │
│                   │  metadata DB    │                                   │
│                   │  (cluster       │                                   │
│                   │   topology)     │                                   │
│                   └────────┬────────┘                                   │
└────────────────────────────┼──────────────────────────────────────────┘
                             │
                    ┌────────┴────────┐
                    │  MySQL Router    │
                    │                  │
                    │  Port 6446: R/W  │ ──> routes to PRIMARY
                    │  Port 6447: R/O  │ ──> round-robin to SECONDARY
                    │  Port 6448: R/W  │ ──> (X Protocol, R/W)
                    │  Port 6449: R/O  │ ──> (X Protocol, R/O)
                    │                  │
                    │  Metadata Cache  │
                    │  (polls cluster  │
                    │   topology every │
                    │   TTL seconds)   │
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │  Application     │
                    │                  │
                    │  Writes → :6446  │
                    │  Reads  → :6447  │
                    └─────────────────┘
```

### 15.6.2 Bootstrap and Configuration

```bash
# Bootstrap Router against the cluster primary
mysqlrouter --bootstrap root@primary-host:3306 \
            --directory /opt/mysqlrouter \
            --conf-use-sockets \
            --account mysqlrouter_user \
            --account-create always

# This generates mysqlrouter.conf with:
#   - Routing sections for classic and X protocol
#   - Metadata cache configuration
#   - Credentials for metadata access
```

**Generated `mysqlrouter.conf`:**

```ini
[metadata_cache:ClusterName]
cluster_type=gr
router_id=1
user=mysqlrouter_user
metadata_cluster=ClusterName
ttl=5                          # Refresh topology every 5 seconds
auth_cache_ttl=-1
auth_cache_refresh_interval=2

[routing:ClusterName_rw]
bind_address=0.0.0.0
bind_port=6446
destinations=metadata-cache://ClusterName/?role=PRIMARY
routing_strategy=first-available
protocol=classic
max_connections=1024

[routing:ClusterName_ro]
bind_address=0.0.0.0
bind_port=6447
destinations=metadata-cache://ClusterName/?role=SECONDARY
routing_strategy=round-robin-with-fallback
protocol=classic
max_connections=1024
```

### 15.6.3 Failover Behavior

```
Normal operation:
  App ──> Router:6446 ──> Member 1 (PRIMARY)    [writes]
  App ──> Router:6447 ──> Member 2 (SECONDARY)  [reads, round-robin]
  App ──> Router:6447 ──> Member 3 (SECONDARY)  [reads, round-robin]

Primary failure (Member 1 crashes):
  1. Group Replication detects failure (within 5-10s, configurable)
  2. GR elects new primary (e.g., Member 2)
  3. Router's metadata cache detects topology change (within TTL seconds)
  4. Router updates routing:
     App ──> Router:6446 ──> Member 2 (NEW PRIMARY)  [writes]
     App ──> Router:6447 ──> Member 3 (SECONDARY)    [reads]
  5. Existing connections to old primary: dropped, app must reconnect
  6. New connections to :6446: routed to Member 2

Total failover time: GR election (5-10s) + Router TTL (5s) = 10-15s
```

### 15.6.4 MySQL Router vs ProxySQL — Comparison

```
┌───────────────────────┬────────────────────────┬──────────────────────┐
│ Feature               │ ProxySQL               │ MySQL Router         │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ Connection            │ Yes — full multiplexing│ No — 1:1 forwarding  │
│   multiplexing        │ N:1 frontend:backend   │ (connection routing) │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ Query-level routing   │ Yes — regex-based      │ No — port-based only │
│                       │ query rules            │ (:6446=RW, :6447=RO) │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ Query cache           │ Yes — built-in         │ No                   │
│                       │ TTL-based per rule     │                      │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ Query rewriting       │ Yes — regex replace    │ No                   │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ InnoDB Cluster        │ Manual config,         │ Native integration,  │
│   integration         │ monitor read_only      │ metadata cache       │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ Failover detection    │ Polling read_only      │ GR metadata events   │
│                       │ (2-5s)                 │ (TTL-based, 1-5s)    │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ Admin interface       │ MySQL-compatible CLI   │ REST API + config    │
│                       │ Dynamic reconfig       │ file (restart needed │
│                       │ (no restart)           │ for some changes)    │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ Performance overhead  │ ~0.1-0.5ms per query   │ ~0.05-0.2ms          │
│                       │ (query parsing)        │ (transparent proxy)  │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ Connection overhead   │ ~2 KB per frontend     │ ~1 KB per connection │
│                       │ connection             │                      │
├───────────────────────┼────────────────────────┼──────────────────────┤
│ Use when              │ Need multiplexing,     │ Running InnoDB       │
│                       │ query routing, caching │ Cluster, want simple │
│                       │ Microservices at scale │ R/W split + failover │
└───────────────────────┴────────────────────────┴──────────────────────┘
```

>>> **Interview insight**: "When would you choose MySQL Router over ProxySQL?" When running
>>> InnoDB Cluster and you need minimal-latency connection forwarding with automatic failover.
>>> Router has less overhead (no query parsing) but also less flexibility. ProxySQL is the
>>> choice when you need connection multiplexing (critical for microservices), query-level
>>> routing, or caching. In practice, many architectures use both: Router for cluster
>>> awareness + ProxySQL in front for multiplexing and query management.

---

## 15.7 Connection Lifecycle Management

### 15.7.1 MySQL Server-Side Connection Settings

```sql
-- View current connection limits and state
SHOW VARIABLES LIKE 'max_connections';          -- Default: 151
SHOW VARIABLES LIKE 'wait_timeout';             -- Default: 28800 (8 hours)
SHOW VARIABLES LIKE 'interactive_timeout';      -- Default: 28800 (8 hours)
SHOW VARIABLES LIKE 'connect_timeout';          -- Default: 10 seconds
SHOW VARIABLES LIKE 'net_read_timeout';         -- Default: 30 seconds
SHOW VARIABLES LIKE 'net_write_timeout';        -- Default: 60 seconds

-- Current connection state
SHOW STATUS LIKE 'Threads_connected';           -- Active connections right now
SHOW STATUS LIKE 'Threads_running';             -- Threads actively executing a query
SHOW STATUS LIKE 'Max_used_connections';        -- High watermark since last restart
SHOW STATUS LIKE 'Connections';                 -- Total connection attempts since start
SHOW STATUS LIKE 'Aborted_connects';            -- Failed connection attempts
SHOW STATUS LIKE 'Aborted_clients';             -- Connections closed abnormally
```

**Timeout hierarchy:**

```
Connection Lifecycle on MySQL Server
═════════════════════════════════════

  1. TCP SYN arrives
     │
     ▼
  2. connect_timeout (10s default)
     │  Server waits for client to complete authentication
     │  If exceeded: "Lost connection to MySQL server at 'reading initial
     │                communication packet'"
     ▼
  3. Connection established — now serving queries
     │
     ├── net_read_timeout (30s) — max time to wait for a packet from client
     │                            during a query transmission
     │
     ├── net_write_timeout (60s) — max time to wait for client to accept
     │                             result data (slow client)
     │
     └── wait_timeout (28800s / 8 hrs) — max idle time between queries
         │
         ▼
  4. Server closes idle connection after wait_timeout
     │  "MySQL server has gone away"
     │  SHOW STATUS: Aborted_clients++
     │
     ▼
  5. Thread destroyed, resources freed
```

### 15.7.2 max_connections Tuning

```sql
-- Default is 151, far too low for production
SET GLOBAL max_connections = 500;

-- Or in my.cnf:
-- [mysqld]
-- max_connections = 500
```

**Sizing max_connections:**

```
Formula:
  max_connections = (app_instances × pool_size_per_instance)
                    + monitoring_connections (10-20)
                    + admin_reserve (5-10)
                    + replication_connections (2-5)
                    + ProxySQL_overhead (if used)

Example:
  20 app instances × 10 connections each     = 200
  Monitoring (Prometheus, Datadog, etc.)     =  15
  Admin / DBA / migrations                   =  10
  Replication threads                        =   5
  Buffer for burst                           =  70
  ─────────────────────────────────────────────────
  Total max_connections                      = 300
```

**Memory implications:**

```
max_connections × worst_case_per_connection_memory = peak memory risk

  500 connections × 4 MB = 2 GB (typical)
  500 connections × 20 MB = 10 GB (worst case with large temp tables)

  Ensure: innodb_buffer_pool_size + (max_connections × 4 MB) + OS overhead < total RAM
```

### 15.7.3 Diagnosing Connection Issues

**"Too many connections" error:**

```sql
-- Error 1040: Too many connections

-- Step 1: Check current state
SHOW STATUS LIKE 'Threads_connected';       -- How many connected now?
SHOW STATUS LIKE 'Max_used_connections';     -- High watermark

-- Step 2: Who is connected?
SELECT user, host, db, command, time, state, info
FROM information_schema.processlist
WHERE command != 'Daemon'
ORDER BY time DESC;

-- Or with performance_schema (more detail):
SELECT thread_id, processlist_user, processlist_host,
       processlist_db, processlist_command, processlist_time,
       processlist_state, processlist_info
FROM performance_schema.threads
WHERE type = 'FOREGROUND'
ORDER BY processlist_time DESC;

-- Step 3: Find sleeping connections (potential leaks)
SELECT user, host, db, COUNT(*) as count, SUM(time) as total_idle_seconds
FROM information_schema.processlist
WHERE command = 'Sleep'
GROUP BY user, host, db
ORDER BY count DESC;

-- Step 4: Kill specific long-idle connections
KILL <process_id>;
```

**Common scenarios and fixes:**

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `Threads_connected` = `max_connections` | Too many app instances or pool too large | Increase max_connections or use ProxySQL multiplexing |
| High `Aborted_clients` | App not closing connections / wait_timeout too low | Fix connection leak, align HikariCP maxLifetime |
| High `Aborted_connects` | Auth failures, SSL errors, max_connections hit | Check credentials, SSL config, increase max_connections |
| `Max_used_connections` near limit | Burst traffic, connection storms | ProxySQL multiplexing, connection rate limiting |
| Many `Sleep` connections from same host | Connection leak in app code | Enable HikariCP leakDetectionThreshold |

### 15.7.4 Connection Leak Detection in HikariCP

```java
// Enable leak detection: log warning + stack trace if connection held > 60 seconds
config.setLeakDetectionThreshold(60_000);  // 60 seconds

// Log output when leak detected:
// WARN  c.z.h.p.ProxyLeakTask - Connection leak detection triggered for
//   com.mysql.cj.jdbc.ConnectionImpl@3a4b5c6d on thread http-nio-8080-exec-42,
//   stack trace follows
// java.lang.Exception: Apparent connection leak detected
//   at com.example.OrderService.processOrder(OrderService.java:47)
//   at com.example.OrderController.createOrder(OrderController.java:23)
//   ...
```

**Common leak patterns in Java:**

```java
// LEAK: connection not closed on exception
public void riskyMethod() {
    Connection conn = dataSource.getConnection();
    PreparedStatement ps = conn.prepareStatement("SELECT ...");
    ResultSet rs = ps.executeQuery();       // What if this throws?
    // ... process results ...
    conn.close();                            // Never reached if exception thrown!
}

// FIX: try-with-resources (Java 7+)
public void safeMethod() {
    try (Connection conn = dataSource.getConnection();
         PreparedStatement ps = conn.prepareStatement("SELECT ...");
         ResultSet rs = ps.executeQuery()) {
        // ... process results ...
    }   // conn.close() guaranteed by AutoCloseable, even on exception
}

// LEAK: Spring @Transactional method calls external API mid-transaction
@Transactional
public void processOrder(Order order) {
    orderRepository.save(order);
    paymentGateway.charge(order);     // HTTP call takes 5 seconds
                                      // Connection held the entire time!
    inventoryService.reserve(order);  // Another HTTP call
    orderRepository.updateStatus(order, COMPLETED);
}

// FIX: Move external calls outside the transaction
public void processOrder(Order order) {
    paymentGateway.charge(order);         // No DB connection held
    inventoryService.reserve(order);      // No DB connection held

    saveOrderTransactional(order);        // Short transaction, quick release
}

@Transactional
protected void saveOrderTransactional(Order order) {
    orderRepository.save(order);
    orderRepository.updateStatus(order, COMPLETED);
}   // Connection released immediately after commit
```

>>> **Interview insight**: The most insidious connection leak in Spring applications is
>>> `@Transactional` methods that call external services. The connection is held from
>>> `@Transactional` method entry to exit — including time spent waiting for HTTP responses.
>>> If the external service is slow, connections pool is exhausted even with low traffic.
>>> Rule: never call external APIs inside `@Transactional`. Split database work into a
>>> separate, short-lived transactional method.

---

## 15.8 Connection Pooling Patterns for Microservices

### 15.8.1 The Microservice Connection Explosion Problem

```
Monolith era:
  1 application × 20 connections = 20 MySQL connections
  Simple. Manageable.

Microservice era:
  50 services × 4 instances each × 10 connections per pool = 2000 MySQL connections
  Scale to holiday traffic:
  50 services × 20 instances each × 10 connections per pool = 10,000 MySQL connections

  MySQL max_connections = 10,000? → 20-40 GB memory for connection overhead
                                  → Context switch chaos
                                  → Not viable
```

### 15.8.2 Solution 1: ProxySQL as Central Proxy

```
┌────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                     │
│                                                         │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐  ... ×200  │
│  │Pod 1│ │Pod 2│ │Pod 3│ │Pod 4│ │Pod 5│             │
│  │ HCP │ │ HCP │ │ HCP │ │ HCP │ │ HCP │  HCP=Hikari│
│  │ =10 │ │ =10 │ │ =10 │ │ =10 │ │ =10 │             │
│  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘             │
│     └───────┴───────┴───┬───┴───────┘                  │
│                         │ 2000 connections              │
│                         ▼                               │
│           ┌──────────────────────────┐                  │
│           │ ProxySQL (Deployment)     │                  │
│           │ 2-3 replicas, HA         │                  │
│           │                          │                  │
│           │ Frontend: 2000 conns     │                  │
│           │ Backend:  50 conns       │ ← multiplexed   │
│           └────────────┬─────────────┘                  │
│                        │ 50 connections                  │
└────────────────────────┼───────────────────────────────┘
                         ▼
              ┌──────────────────┐
              │     MySQL        │
              │  Threads: ~50    │
              └──────────────────┘

  Multiplexing ratio: 40:1
  MySQL sees 50 connections, not 2000
```

**Pros**: Single point of control for routing, caching, query rules.
**Cons**: ProxySQL becomes a SPOF (must run HA), adds one network hop.

### 15.8.3 Solution 2: ProxySQL as Sidecar

```
┌─────────────────────────────────────────────────────────┐
│  Kubernetes Pod                                          │
│  ┌───────────────────────┬───────────────────────────┐  │
│  │  App Container         │  ProxySQL Sidecar          │  │
│  │                        │                            │  │
│  │  HikariCP pool=5      │  Frontend: localhost:6033  │  │
│  │  connects to           │  Backend pool: 2 conns     │  │
│  │  localhost:6033        │  to MySQL                  │  │
│  │                        │                            │  │
│  │  App thinks it's       │  Handles multiplexing,     │  │
│  │  talking to MySQL      │  R/W split, failover       │  │
│  └──────────┬─────────────┴────────────┬───────────────┘  │
│             │ localhost                 │ network          │
│             └──────────────────────────┘                  │
└────────────────────────────────────────┬────────────────┘
                                         │ 2 connections
                                         ▼
                              ┌──────────────────┐
                              │     MySQL         │
                              └──────────────────┘

  200 pods × 2 backend connections each = 400 MySQL connections
  (vs 200 × 5 = 1000 without sidecar multiplexing)
```

**Kubernetes sidecar YAML:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  replicas: 20
  template:
    spec:
      containers:
        - name: app
          image: order-service:latest
          env:
            - name: DB_HOST
              value: "127.0.0.1"    # Connect to sidecar, not MySQL directly
            - name: DB_PORT
              value: "6033"
          ports:
            - containerPort: 8080

        - name: proxysql
          image: proxysql/proxysql:2.5
          ports:
            - containerPort: 6033   # MySQL protocol
            - containerPort: 6032   # Admin interface
          volumeMounts:
            - name: proxysql-config
              mountPath: /etc/proxysql.cnf
              subPath: proxysql.cnf
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi

      volumes:
        - name: proxysql-config
          configMap:
            name: proxysql-config
```

>>> **Interview insight**: In Kubernetes, ProxySQL as a sidecar container is the most common
>>> pattern for MySQL connection management. Each pod gets its own ProxySQL — no shared
>>> SPOF, and the app connects to `localhost:6033` with zero network latency to the proxy.
>>> The sidecar handles connection multiplexing, read/write splitting, and failover. The
>>> trade-off is higher total CPU/memory usage (one ProxySQL per pod) vs centralized proxy
>>> (shared ProxySQL deployment).

### 15.8.4 Solution 3: Smaller Pools per Instance

When multiplexing proxies are not an option, reduce per-instance pool size:

```
Instead of:  50 instances × 10 connections = 500

Use:         50 instances ×  3 connections = 150

HikariCP config for small pools:
  maximumPoolSize = 3
  minimumIdle = 3
  connectionTimeout = 10000    # Fail faster (10s)
```

**When 3 connections work**: Most microservice requests make 1-2 database calls.
With a pool of 3, two concurrent requests can execute in parallel, and one waits.
For services with 100ms average request time, 3 connections serve 30 req/sec per
instance. Scale horizontally (more pods) instead of scaling pool size.

### 15.8.5 Solution 4: Connection Routing Mode in MySQL Router

```ini
# MySQL Router connection routing (not query routing)
[routing:rw_connections]
bind_port=6446
destinations=metadata-cache://myCluster/?role=PRIMARY
routing_strategy=first-available
max_connections=2048
max_connect_errors=100
client_connect_timeout=9

# max_connections limits total concurrent connections through Router
# Router does NOT multiplex — it's 1:1 forwarding
# But provides automatic failover and topology-aware routing
```

### 15.8.6 Pattern Comparison

```
┌──────────────────────┬────────────┬──────────┬──────────┬─────────────┐
│ Pattern              │ MySQL      │ Latency  │ Complex- │ Best For    │
│                      │ Connections│ Overhead │ ity      │             │
├──────────────────────┼────────────┼──────────┼──────────┼─────────────┤
│ Direct (no proxy)    │ N × pool   │ 0        │ Low      │ < 10 app    │
│                      │ (e.g. 500) │          │          │ instances   │
├──────────────────────┼────────────┼──────────┼──────────┼─────────────┤
│ Central ProxySQL     │ ProxySQL   │ +0.1-    │ Medium   │ 10-100 app  │
│                      │ backend    │  0.5ms   │          │ instances,  │
│                      │ (e.g. 50)  │          │          │ central     │
│                      │            │          │          │ control     │
├──────────────────────┼────────────┼──────────┼──────────┼─────────────┤
│ Sidecar ProxySQL     │ pods ×     │ +0.05ms  │ Medium-  │ Kubernetes, │
│                      │ backend/pod│ (local)  │ High     │ large scale │
│                      │ (e.g. 200) │          │          │             │
├──────────────────────┼────────────┼──────────┼──────────┼─────────────┤
│ Smaller pools        │ N × small  │ 0        │ Low      │ Simple,     │
│                      │ pool       │          │          │ moderate    │
│                      │ (e.g. 150) │          │          │ scale       │
├──────────────────────┼────────────┼──────────┼──────────┼─────────────┤
│ MySQL Router         │ N × pool   │ +0.05-   │ Low      │ InnoDB      │
│                      │ (1:1)      │  0.2ms   │          │ Cluster,    │
│                      │            │          │          │ failover    │
└──────────────────────┴────────────┴──────────┴──────────┴─────────────┘
```

---

## 15.9 MaxScale (MariaDB/MySQL)

MaxScale is MariaDB's enterprise proxy. While less commonly used in MySQL-native
deployments (where ProxySQL dominates), it is the default choice for MariaDB
environments and has several unique capabilities.

### 15.9.1 Core Features

```
┌───────────────────────────────────────────────────────────────────┐
│                         MaxScale                                   │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Router Modules                                              │  │
│  │  ┌────────────┐ ┌────────────┐ ┌──────────────────────────┐ │  │
│  │  │readwrite   │ │readconn    │ │binlogrouter              │ │  │
│  │  │split       │ │router      │ │(binlog relay)            │ │  │
│  │  │            │ │            │ │                           │ │  │
│  │  │ Splits R/W │ │ Routes to  │ │ Acts as intermediate     │ │  │
│  │  │ by query   │ │ a single   │ │ binlog server.           │ │  │
│  │  │ analysis   │ │ backend    │ │ Replicas connect to      │ │  │
│  │  │            │ │ (master or │ │ MaxScale instead of      │ │  │
│  │  │            │ │  slave)    │ │ primary. Reduces load    │ │  │
│  │  │            │ │            │ │ on primary from binlog   │ │  │
│  │  │            │ │            │ │ serving.                 │ │  │
│  │  └────────────┘ └────────────┘ └──────────────────────────┘ │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Filter Modules                                              │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐              │  │
│  │  │Query       │ │Throttle    │ │Tee          │              │  │
│  │  │Logging     │ │Filter      │ │Filter       │              │  │
│  │  │            │ │            │ │             │              │  │
│  │  │Log all     │ │Rate limit  │ │Mirror       │              │  │
│  │  │queries for │ │queries per │ │queries to   │              │  │
│  │  │audit       │ │user/source │ │a second     │              │  │
│  │  │            │ │            │ │backend      │              │  │
│  │  └────────────┘ └────────────┘ └────────────┘              │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Monitor Modules                                             │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐              │  │
│  │  │MariaDB     │ │Galera      │ │Clustrix     │              │  │
│  │  │Monitor     │ │Monitor     │ │Monitor      │              │  │
│  │  └────────────┘ └────────────┘ └────────────┘              │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

### 15.9.2 Binlog Router — Unique Feature

MaxScale's binlog router is a capability neither ProxySQL nor MySQL Router provides:

```
Without binlog router:
  Primary ──binlog──> Replica 1
  Primary ──binlog──> Replica 2
  Primary ──binlog──> Replica 3
  Primary ──binlog──> Replica 4
  (Primary serves 4 binlog dump threads, high I/O load)

With MaxScale binlog router:
  Primary ──binlog──> MaxScale ──binlog──> Replica 1
                                ──binlog──> Replica 2
                                ──binlog──> Replica 3
                                ──binlog──> Replica 4
  (Primary serves 1 binlog dump thread to MaxScale)
  (MaxScale relays to all replicas — offloads primary)
```

This is valuable when you have many replicas (10+) and binlog serving
becomes a bottleneck on the primary's I/O and CPU.

### 15.9.3 MaxScale vs ProxySQL

| Feature | MaxScale | ProxySQL |
|---------|----------|----------|
| License | BSL 1.1 (not open source) | GPLv3 (open source) |
| Connection multiplexing | Limited | Full |
| Query cache | No (deprecated) | Yes |
| Binlog relay | Yes | No |
| Query rewriting | Limited | Full regex |
| Galera Cluster support | Native | Via monitoring |
| Community & ecosystem | Smaller (MariaDB-centric) | Larger (MySQL-native) |
| Configuration | maxscale.cnf (file) | SQL admin interface (dynamic) |

>>> **Interview insight**: In MySQL-centric stacks, ProxySQL is the standard choice.
>>> MaxScale is relevant when using MariaDB, when you need binlog relay for many replicas,
>>> or when the enterprise support contract with MariaDB Corporation is a factor. The
>>> licensing (BSL 1.1 since MaxScale 2.1) means it is not fully open-source — a
>>> consideration for open-source-focused organizations.

---

## 15.10 Benchmarking Connection Pool Configuration

### 15.10.1 JMH Micro-Benchmark for Pool Overhead

```java
@BenchmarkMode(Mode.SampleTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@State(Scope.Benchmark)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 10, time = 1)
@Fork(2)
public class ConnectionPoolBenchmark {

    private HikariDataSource hikariDS;

    @Setup
    public void setup() {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:mysql://localhost:3306/benchmark");
        config.setUsername("bench_user");
        config.setPassword("bench_pass");
        config.setMaximumPoolSize(10);
        config.setMinimumIdle(10);
        config.addDataSourceProperty("cachePrepStmts", "true");
        config.addDataSourceProperty("prepStmtCacheSize", "250");
        config.addDataSourceProperty("useServerPrepStmts", "true");
        hikariDS = new HikariDataSource(config);
    }

    @Benchmark
    @Threads(1)
    public Connection getConnection_singleThread() throws SQLException {
        Connection conn = hikariDS.getConnection();
        conn.close();
        return conn;
    }

    @Benchmark
    @Threads(10)
    public Connection getConnection_highContention() throws SQLException {
        Connection conn = hikariDS.getConnection();
        conn.close();
        return conn;
    }

    @Benchmark
    @Threads(10)
    public int executeQuery_withPool() throws SQLException {
        try (Connection conn = hikariDS.getConnection();
             PreparedStatement ps = conn.prepareStatement("SELECT 1");
             ResultSet rs = ps.executeQuery()) {
            rs.next();
            return rs.getInt(1);
        }
    }

    @TearDown
    public void teardown() {
        hikariDS.close();
    }
}
```

**Expected results:**

```
Benchmark                                           Threads   Avg (ns)    p99 (ns)
─────────────────────────────────────────────────   ───────   ─────────   ─────────
getConnection_singleThread                              1          15          42
getConnection_highContention                           10         120         850
executeQuery_withPool                                  10     120,000     250,000
```

The `getConnection()` fast path (thread-local hit) is ~15 ns. Under contention
(10 threads, 10 connections), it rises to ~120 ns as threads compete via CAS on
the shared list. The query execution itself dominates at ~120 microseconds (network
round trip to MySQL).

### 15.10.2 Metrics to Monitor in Production

**Application-side (HikariCP via Micrometer):**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Metric                              │ Alert Threshold              │
├──────────────────────────────────────┼──────────────────────────────┤
│ hikaricp_connections_active          │ > maxPoolSize for > 30s      │
│   Currently in-use connections       │ (pool saturated)             │
├──────────────────────────────────────┼──────────────────────────────┤
│ hikaricp_connections_pending         │ > 0 for > 10s                │
│   Threads waiting for connection     │ (pool exhaustion occurring)  │
├──────────────────────────────────────┼──────────────────────────────┤
│ hikaricp_connections_timeout_total   │ > 0                          │
│   Connection acquisition failures    │ (requests failing)           │
├──────────────────────────────────────┼──────────────────────────────┤
│ hikaricp_connections_creation_seconds│ p99 > 5s                     │
│   Time to create new physical conn   │ (MySQL or network issues)    │
├──────────────────────────────────────┼──────────────────────────────┤
│ hikaricp_connections_usage_seconds   │ p99 > 10s                    │
│   How long app holds each connection │ (slow queries or leaks)      │
└──────────────────────────────────────┴──────────────────────────────┘
```

**MySQL-side metrics:**

```sql
-- Connection metrics to watch
SHOW GLOBAL STATUS WHERE Variable_name IN (
  'Threads_connected',        -- Current active connections
  'Threads_running',          -- Currently executing a query
  'Threads_created',          -- Total threads created (should be low after warmup)
  'Connections',              -- Total connection attempts since start
  'Aborted_connects',         -- Failed connection attempts
  'Aborted_clients',          -- Connections closed abnormally (timeout, crash)
  'Max_used_connections',     -- High watermark
  'Connection_errors_internal',
  'Connection_errors_max_connections',   -- Hit max_connections limit
  'Connection_errors_peer_address'
);
```

**Correlation dashboard:**

```
Time ──────────────────────────────────────────────────────>

App Pool Active    ████████████████████████████░░░░  90%
                   (approaching pool exhaustion)

App Pool Pending   ░░░░░░░░░░░░░░░░████████████████  rising
                   (threads waiting for connections)

MySQL Threads_run  ████████░░░░░░░░░░░░░░░░░░░░░░░░  30
                   (stable — MySQL is fine)

MySQL Threads_conn ████████████████████████████████░  200
                   (stable — matches total pool)

Diagnosis: App pool is undersized. MySQL has capacity.
Fix: Increase maximumPoolSize, OR find slow queries holding connections too long.
```

### 15.10.3 Load Testing Connection Pool Behavior

**Using Gatling to stress-test pool configuration:**

```scala
class ConnectionPoolStressTest extends Simulation {

  val httpProtocol = http
    .baseUrl("http://order-service:8080")
    .acceptHeader("application/json")

  val scn = scenario("Order Creation Burst")
    .exec(
      http("Create Order")
        .post("/api/orders")
        .body(StringBody("""{"productId": 42, "quantity": 1}"""))
        .check(status.is(201))
    )

  setUp(
    scn.inject(
      // Ramp to 100 req/s over 30 seconds
      rampUsersPerSec(1).to(100).during(30),
      // Hold at 100 req/s for 2 minutes
      constantUsersPerSec(100).during(120),
      // Spike to 500 req/s for 10 seconds
      rampUsersPerSec(100).to(500).during(5),
      constantUsersPerSec(500).during(10),
      rampUsersPerSec(500).to(100).during(5),
      // Cool down
      constantUsersPerSec(100).during(60)
    )
  ).protocols(httpProtocol)
    .assertions(
      global.responseTime.percentile(99).lt(500),       // p99 < 500ms
      global.successfulRequests.percent.gt(99.5)        // > 99.5% success
    )
}
```

**What to watch during the test:**

```
Phase                  Pool Active   Pool Pending   Response p99   MySQL Threads_running
────────────────────   ───────────   ────────────   ────────────   ─────────────────────
Ramp 1→100 rps              3/10          0             12ms              3
Hold 100 rps                 7/10          0             18ms              7
Spike 500 rps               10/10          15           950ms             10
  ← Pool exhaustion! Pending threads spiking, p99 degrading
Hold 500 rps                10/10          40          2800ms             10
  ← connectionTimeout approaching, 500 errors may start
Cool down 100 rps            7/10          0             15ms              7
```

**Conclusions from this test:**
- Pool of 10 handles 100 rps comfortably
- Pool of 10 cannot handle 500 rps burst — needs either larger pool, faster queries, or ProxySQL multiplexing
- Key metric: `pending > 0` is the earliest warning signal

---

## 15.11 End-to-End Architecture — Putting It All Together

### 15.11.1 Small-to-Medium Scale (< 50 instances)

```
┌──────────────────────────────────────────────────┐
│  Application Tier                                 │
│                                                   │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │ App ×10 │ │ App ×10 │ │ App ×10 │            │
│  │ Hikari  │ │ Hikari  │ │ Hikari  │            │
│  │ pool=10 │ │ pool=10 │ │ pool=10 │            │
│  └────┬────┘ └────┬────┘ └────┬────┘            │
│       │           │           │                  │
│       │  PRIMARY  │  REPLICA  │  REPLICA         │
│       └─────┬─────┘           │                  │
│             │   AbstractRoutingDataSource         │
│             │   @Transactional(readOnly)           │
│             │   routes reads to replica pool       │
└─────────────┼────────────────────────────────────┘
              ▼
┌──────────────────────────────────────────────────┐
│  Database Tier                                    │
│                                                   │
│  ┌────────────────┐  ┌────────────────┐          │
│  │  Primary        │  │  Replica (×2)   │          │
│  │  max_conn=350  │  │  max_conn=200  │          │
│  │  ~100 active   │  │  ~100 active   │          │
│  └────────────────┘  └────────────────┘          │
└──────────────────────────────────────────────────┘

  Stack: HikariCP + AbstractRoutingDataSource
  Total connections: 30 instances × 10 = 300
  No proxy layer needed
```

### 15.11.2 Large Scale (100+ instances)

```
┌───────────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                                │
│                                                                    │
│  ┌────────────────────────┐  ×200 pods                            │
│  │  Pod                    │                                       │
│  │  ┌─────────┬──────────┐│                                       │
│  │  │  App    │ ProxySQL ││                                       │
│  │  │ Hikari  │ sidecar  ││                                       │
│  │  │ pool=5  │ backend=2││                                       │
│  │  │ →local  │ →MySQL   ││                                       │
│  │  │  :6033  │  :3306   ││                                       │
│  │  └─────────┴──────────┘│                                       │
│  └────────────────────────┘                                       │
│                                                                    │
│  Frontend: 200 × 5 = 1000 (app → sidecar ProxySQL)               │
│  Backend:  200 × 2 = 400  (sidecar ProxySQL → MySQL)             │
│  ProxySQL handles R/W split, failover, query rules                │
└───────────────────────────────┬──────────────────────────────────┘
                                │ 400 connections
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  InnoDB Cluster                                                    │
│                                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                        │
│  │ Primary   │  │ Secondary│  │ Secondary│                        │
│  │ max=500  │  │ max=300  │  │ max=300  │                        │
│  │ ~200 act │  │ ~100 act │  │ ~100 act │                        │
│  └──────────┘  └──────────┘  └──────────┘                        │
│                                                                    │
│  MySQL Router for cluster metadata + failover awareness            │
└───────────────────────────────────────────────────────────────────┘

  Stack: HikariCP + ProxySQL sidecar + InnoDB Cluster + MySQL Router
  Multiplexing reduces MySQL threads from 1000+ to ~400
```

### 15.11.3 Configuration Quick Reference

```
┌────────────────────────┬──────────────────┬──────────────────────────┐
│ Component              │ Setting          │ Value                    │
├────────────────────────┼──────────────────┼──────────────────────────┤
│ HikariCP               │ maximumPoolSize  │ 10 (monolith)            │
│                        │                  │ 3-5 (microservice)       │
│                        │ minimumIdle      │ = maximumPoolSize        │
│                        │ maxLifetime      │ wait_timeout - 30s       │
│                        │ connectionTimeout│ 30000 ms                 │
│                        │ keepaliveTime    │ 60000 ms (v4.0+)         │
│                        │ leakDetection    │ 60000 ms                 │
├────────────────────────┼──────────────────┼──────────────────────────┤
│ MySQL Connector/J      │ cachePrepStmts   │ true                     │
│                        │ prepStmtCacheSize│ 250                      │
│                        │ useServerPrepStmts│true                     │
│                        │ rewriteBatched   │ true                     │
│                        │ useLocalSession  │ true                     │
│                        │ elideSetAuto     │ true                     │
├────────────────────────┼──────────────────┼──────────────────────────┤
│ MySQL Server           │ max_connections  │ instances × pool + 50    │
│                        │ wait_timeout     │ 28800 (or cloud default) │
│                        │ thread_cache_size│ 100 (reuse OS threads)   │
├────────────────────────┼──────────────────┼──────────────────────────┤
│ ProxySQL               │ backend pool     │ 20-50 per hostgroup      │
│                        │ max_connections  │ per server capacity      │
│                        │ monitor interval │ 1500-2000 ms             │
├────────────────────────┼──────────────────┼──────────────────────────┤
│ MySQL Router           │ TTL              │ 5 seconds                │
│                        │ max_connections  │ 1024-2048                │
│                        │ routing_strategy │ first-available (RW)     │
│                        │                  │ round-robin (RO)         │
└────────────────────────┴──────────────────┴──────────────────────────┘
```

---

## 15.12 Summary — Decision Tree

```
Do you need connection pooling?
│
└── YES (always, for any production MySQL application)
    │
    ├── Java application?
    │   └── Use HikariCP (Spring Boot default)
    │       ├── Pool size: start at 10, tune with metrics
    │       ├── maxLifetime < wait_timeout
    │       └── Enable all Connector/J optimizations
    │
    ├── Need read/write splitting?
    │   ├── Application-level: AbstractRoutingDataSource + @Transactional(readOnly)
    │   ├── Proxy-level: ProxySQL query rules or MySQL Router R/W ports
    │   └── Both: App routes to correct proxy port, proxy handles failover
    │
    ├── Need connection multiplexing? (> 100 app instances)
    │   └── ProxySQL (sidecar or central)
    │       └── Reduces MySQL threads from thousands to dozens
    │
    ├── Running InnoDB Cluster?
    │   └── MySQL Router for failover + topology awareness
    │       └── Optional: ProxySQL in front for multiplexing + caching
    │
    └── Need query caching at proxy layer?
        └── ProxySQL with cache_ttl in query rules
```

>>> **Interview insight**: The complete stack for a large-scale Java/MySQL deployment is:
>>> HikariCP (application-side pool) -> ProxySQL sidecar (multiplexing + R/W split) ->
>>> MySQL Router (cluster awareness) -> InnoDB Cluster (Group Replication). Each layer
>>> solves a different problem: HikariCP manages JDBC objects and thread-local reuse,
>>> ProxySQL reduces backend connections and routes queries, MySQL Router tracks cluster
>>> topology, and Group Replication provides HA. In interviews, demonstrate you understand
>>> which problem each layer solves, not just that these tools exist.

---

**Source code references:**
- HikariCP ConcurrentBag: `com.zaxxer.hikari.util.ConcurrentBag`
- HikariCP PoolEntry: `com.zaxxer.hikari.pool.PoolEntry`
- MySQL Connector/J: `com.mysql.cj.jdbc.ConnectionImpl`
- ProxySQL source: `github.com/sysown/proxysql` (C++)
- MySQL Router source: `github.com/mysql/mysql-router` (C++)
- MySQL thread handling: `sql/conn_handler/connection_handler_per_thread.cc`
