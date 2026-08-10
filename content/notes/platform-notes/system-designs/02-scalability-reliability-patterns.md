# Scalability & Reliability Patterns — Deep Technical Reference

> Target: Senior Java/Systems developer, 15yr exp, 40 LPA interview preparation.
> Every pattern covered at production-engineering depth.

---

## Table of Contents

**Scalability:**
1. Vertical vs Horizontal Scaling
2. Stateless Service Design & Session Externalization
3. Read Replicas & Read-Your-Own-Writes
4. CQRS
5. Event Sourcing
6. Database Sharding Strategies
7. Cell-Based Architecture

**Reliability:**
8. Circuit Breaker (Resilience4j Internals)
9. Retry Patterns & Jitter
10. Bulkhead Pattern
11. Rate Limiting Algorithms
12. Timeout Patterns
13. Idempotency
14. Backpressure

---

## PART 1: SCALABILITY PATTERNS

---

## 1. Vertical vs Horizontal Scaling

### Vertical Scaling (Scale Up)

Add more CPU/RAM/disk to existing machines.

**When it works:**
- Stateful systems where horizontal sharding is complex (legacy RDBMS).
- Systems with fine-grained shared state (in-memory cache, locking).
- Short-term capacity relief when re-architecting isn't feasible.

**Hard ceiling:**
- AWS largest instance: `u-24tb1.metal` (224 vCPU, 24 TB RAM). Cost: ~$220/hr.
- For most services, you hit the cost cliff long before the hardware limit.
- Single point of failure: one machine goes down, all capacity is lost.

**JVM implications:**
Vertical scaling often means larger heap. But JVM GC pauses scale poorly with heap size:
```
Heap 8GB,  CMS: 2–5ms pauses (minor), 1–3s (major)
Heap 32GB, CMS: 8–20ms minor, 5–15s major
Heap 128GB, ZGC: <15ms pauses (ZGC is designed for this)
```

G1GC is the default since Java 9. For heaps >32GB:
- Use ZGC (Java 15+, sub-millisecond pauses)
- Use Shenandoah (Red Hat, competitive with ZGC)
- -XX:+UseZGC -Xmx128g still better than large heap with G1

### Horizontal Scaling (Scale Out)

Add more machines running the same code.

**Prerequisites for horizontal scaling:**
1. **Statelessness:** No request depends on local state from a previous request.
2. **Load balancing:** Traffic distributed across all instances.
3. **Shared external state:** Sessions, caches, locks moved to external systems.
4. **Idempotency:** Any instance can handle any request (retries safe).

**The 12-Factor App** (Heroku, Adam Wiggins): Factor VI — Processes. "Execute the app as one or more stateless processes. Any data that needs to persist must be stored in a stateful backing service."

**Stateful vs Stateless services:**

| Service Type | Scaling Approach | Challenge |
|-------------|-----------------|-----------|
| Stateless API | Add instances, round-robin LB | None significant |
| Stateful (sessions in-memory) | Sticky sessions or externalize state | Adds complexity |
| Database primary | Vertical OR active-active (complex) | Conflict resolution |
| Cache | Consistent hashing ring (Twemproxy, Redis Cluster) | Resharding |
| Message broker (Kafka) | Add partitions, increase consumer group size | Rebalancing |

---

## 2. Stateless Service Design & Session Externalization

### Why Sessions Break Horizontal Scaling

Classic Java EE pattern: `HttpSession` stored in application server memory. Sticky sessions (LB routes same user to same server via cookie or IP hash) seem to solve it, but:

1. If that server dies, user's session is lost.
2. Uneven load: power users with large sessions accumulate on the same node.
3. Canary deployments are harder (can't drain a server quickly if sessions are live).
4. Zero-downtime deployments require session migration.

### Session Externalization with Redis

```java
// Spring Session with Redis
@EnableRedisHttpSession(maxInactiveIntervalInSeconds = 1800)
@Configuration
public class SessionConfig {
    @Bean
    public LettuceConnectionFactory connectionFactory() {
        return new LettuceConnectionFactory(
            new RedisStandaloneConfiguration("redis-host", 6379));
    }
}
```

**What Spring Session does:**
1. Intercepts `HttpServletRequest.getSession()`.
2. Serializes `HttpSession` attributes to Redis hash at key `spring:session:sessions:{sessionId}`.
3. Sets TTL = maxInactiveIntervalInSeconds.
4. Sends `SESSION` cookie with the session ID.
5. On each request: loads session from Redis, deserializes, provides to controller.

**Redis session storage structure:**
```
HSET spring:session:sessions:abc123 \
  sessionAttr:user "{id:42, name:'alice'}" \
  lastAccessedTime "1714500000000" \
  maxInactiveInterval "1800" \
  creationTime "1714499000000"

EXPIRE spring:session:sessions:abc123 1800
```

**Performance impact:**
- 1 Redis GET per request (deserialize session)
- 1 Redis HSET per request (update lastAccessedTime)
- Network RTT to Redis: 0.5–2ms per request (sub-millisecond with Redis Cluster in same AZ)

**Serialization choice:**
- Java serialization (default): binary, version-sensitive, dangerous
- Jackson JSON: human-readable, handles class evolution, recommended
- Kryo: fastest binary, less portable

---

## 3. Read Replicas & Read-Your-Own-Writes

### Replica Lag

MySQL/PostgreSQL async replication:
```
Primary: COMMIT transaction → writes to WAL/binlog
         → sends binlog events to replica
Replica: receives binlog → applies → replica lag = now - last_applied_event_time
```

Typical replica lag:
- Same AZ, idle replica: 10–100ms
- Cross-AZ: 5–20ms network + application latency
- Under heavy write load: 1s – several minutes

**What replica lag means:**
```
t=0:  User updates profile photo. Written to primary.
t=50ms: User refreshes their profile. Load balancer sends to replica.
         Replica lag = 200ms → replica still shows old photo.
         User confusion: "I just changed it!"
```

### Read-Your-Own-Writes

**Solutions:**

**1. Always read from primary for writes by the same user:**
```java
// Routing logic: if user wrote something recently, read from primary
boolean readFromPrimary = sessionCache.get("user_wrote_recently_" + userId) != null;
DataSource ds = readFromPrimary ? primaryDs : replicaDs;
```

**2. Read primary with timestamp bound:**
```java
// Store the last write timestamp in session
long lastWriteTs = session.get("lastWriteTimestamp");
// Read from replica but wait until replica catches up
if (replicaLag.getLag() > (System.currentTimeMillis() - lastWriteTs)) {
    return primaryDb.read(key);  // replica not caught up, use primary
}
return replicaDb.read(key);
```

**3. Sticky reads for a short window:**
After a write, route all reads for the same user to the primary for T seconds (T > max expected replica lag). Amazon DynamoDB's "read your own writes" consistency option works similarly.

**4. Monotonic reads:**
Ensure a user never reads an older state than what they previously read. Tag reads with replica version; route to a replica that has at least that version.

### PostgreSQL Synchronous Replication

For critical data, PostgreSQL supports synchronous replication:
```sql
-- On primary:
SET synchronous_commit = 'remote_write';
-- or 'remote_apply' (waits for replica to apply, not just write WAL)

-- postgresql.conf:
synchronous_standby_names = 'replica1'
```

With `remote_apply`, primary waits for replica to apply the transaction before acknowledging. Replica lag = 0 for committed transactions. Cost: every write waits for round trip to replica.

---

## 4. CQRS (Command Query Responsibility Segregation)

### Core Concept

Separate the *write model* (commands that change state) from the *read model* (queries that read state).

```
          Commands (writes)
               |
               ↓
    ┌─────────────────────┐
    │   Command Handler   │
    │   - validates       │
    │   - applies rules   │
    │   - emits events    │
    └─────────────────────┘
               |
               ↓
        Write DB (normalized)
               |
               | (event or change stream)
               ↓
    ┌─────────────────────┐
    │  Projection Builder │
    │  - denormalizes     │
    │  - builds views     │
    └─────────────────────┘
               |
               ↓
        Read DB (denormalized, optimized for queries)
               |
               ↑
          Queries (reads)
```

### Why Separate Read and Write Models?

**Problem with unified model:**
- Write model: normalized (3NF), handles concurrency, enforces invariants.
- Query model: joins 10 tables for a single user-facing view.
- These are fundamentally different requirements.

**With CQRS:**
- Write model: optimized for consistency and transactions (PostgreSQL, normalized).
- Read model: denormalized, precomputed, fast reads. Could be Elasticsearch for full-text, Redis for hot data, Cassandra for time-series.

**Amazon's internal product page:**
- Write: Product catalog DB (normalized)
- Read: Denormalized "document" stored in DynamoDB — includes product title, price, ratings summary, seller name (already joined). A single DynamoDB read returns the complete page data.

### CQRS Implementation in Java (Axon Framework)

```java
// Command side
@Aggregate
public class OrderAggregate {
    @AggregateIdentifier
    private String orderId;
    private OrderStatus status;

    @CommandHandler
    public OrderAggregate(CreateOrderCommand cmd) {
        // Validate business rules
        if (cmd.items().isEmpty()) throw new IllegalArgumentException("No items");
        // Emit domain event (Axon persists to event store)
        apply(new OrderCreatedEvent(cmd.orderId(), cmd.items(), cmd.userId()));
    }

    @EventSourcingHandler
    public void on(OrderCreatedEvent event) {
        this.orderId = event.orderId();
        this.status = OrderStatus.CREATED;
    }
}

// Query side projection
@Component
public class OrderProjection {
    @QueryHandler
    @EventHandler
    public void on(OrderCreatedEvent event) {
        // Build denormalized read model
        OrderView view = new OrderView(
            event.orderId(),
            fetchUserName(event.userId()),  // join with user service
            event.items(),
            "CREATED"
        );
        orderViewRepository.save(view);
    }
}
```

### CQRS Pitfalls

1. **Eventual consistency in the read model:**
   After a command succeeds, the read model is updated asynchronously. Users may see stale data.
   Fix: Show an optimistic UI update; or use synchronous projection update for critical paths.

2. **Query-side complexity:**
   Multiple specialized read stores means multiple systems to maintain.
   Don't CQRS everything — only data models with genuinely different read/write access patterns.

3. **Event replay:**
   If you want to rebuild a read model, you replay all events. Fast projections can process millions of events/minute. Slow projections (with external service calls) can take hours.

---

## 5. Event Sourcing

### Core Concept

Instead of storing current state, store the **sequence of events that led to the current state**. Current state is derived by replaying events.

```
Traditional persistence:
Order table: {id: 1, status: SHIPPED, totalAmount: 100.00}
(previous states lost)

Event sourcing:
Event log:
  1. OrderCreated {orderId:1, items:[...], totalAmount:100.00}
  2. PaymentProcessed {orderId:1, paymentId:p1, amount:100.00}
  3. OrderShipped {orderId:1, trackingId:t123}

Current state = replay(events 1→3) = {status: SHIPPED, tracking: t123, ...}
```

### Why Event Sourcing

1. **Complete audit trail:** "What happened to this order?" — replay the log.
2. **Temporal queries:** "What was the state of this order at time T?" — replay up to T.
3. **Event-driven integration:** Other systems consume the event log.
4. **Debugging:** Reproduce exact state that led to a bug.
5. **CQRS natural fit:** Write model = event store; read model = projections from events.

### Snapshotting

Replaying 10 years of events on every load is expensive. Snapshots cache aggregate state every N events.

```
Snapshot strategy:
  Events 1–500: OrderAggregate state at event 500 → stored as snapshot
  Events 501–600: append new events
  
  On load: fetch latest snapshot (event 500) + replay events 501–600 only.
```

**Snapshot storage:**
```java
@Component
public class AggregateRepository {
    private static final int SNAPSHOT_THRESHOLD = 50;

    public Order load(String orderId) {
        Optional<Snapshot> snapshot = snapshotStore.getLatest(orderId);
        List<Event> events;
        Order order;

        if (snapshot.isPresent()) {
            order = snapshot.get().state();          // fast load
            events = eventStore.loadFrom(orderId,    // load only tail
                snapshot.get().sequenceNumber() + 1);
        } else {
            order = new Order();
            events = eventStore.loadAll(orderId);    // full replay
        }

        events.forEach(order::apply);

        // Create snapshot if threshold exceeded
        if (order.version() % SNAPSHOT_THRESHOLD == 0) {
            snapshotStore.save(new Snapshot(orderId, order.version(), order));
        }

        return order;
    }
}
```

**Snapshot gotcha:** Snapshots are *not* the source of truth. If your serialization format changes, old snapshots might fail to deserialize. Solution: snapshots are *droppable* — you can always fall back to full event replay. Don't treat snapshots as the source of truth.

### Schema Evolution and Event Versioning

Events are immutable and stored forever. Business logic changes, but old events don't.

**Upcasting pattern:**
```java
// Event V1 (original)
public record OrderCreatedEventV1(String orderId, List<String> itemIds) {}

// Event V2 (new field added: customerId)
public record OrderCreatedEventV2(String orderId, List<String> itemIds, String customerId) {}

// Upcaster: transparently converts V1 to V2 on read
@Component
public class OrderCreatedEventUpcaster implements EventUpcaster {
    @Override
    public Stream<IntermediateEventRepresentation> upcast(
            Stream<IntermediateEventRepresentation> events) {
        return events.map(e -> {
            if (e.getType().getName().equals("OrderCreatedEventV1")) {
                return e.upcastPayload(
                    Map.class,
                    payload -> {
                        payload.put("customerId", "UNKNOWN"); // default value
                        return payload;
                    },
                    "OrderCreatedEventV2"
                );
            }
            return e;
        });
    }
}
```

**Event versioning strategies:**
1. **Weak schema (additive only):** New fields are optional with defaults. Old events read fine. Most pragmatic.
2. **Strong schema with upcasters:** Each event version has an explicit upcaster chain. Complex but auditable.
3. **Copy-on-transform:** Physically migrate old events to new format (risky, loses history).

### Event Sourcing Challenges

1. **Eventually consistent read models:** Accept or handle with read-your-own-writes.
2. **Event schema migration:** Plan for it upfront. Use Avro/Protobuf for schema evolution built-in.
3. **Event store query limitations:** Can only query by aggregate ID natively. Want "find all orders for user X"? You need a projection. This is why CQRS + Event Sourcing go together.
4. **Eventual projection consistency:** A projection might be seconds behind. Design UIs accordingly.
5. **Large aggregates with thousands of events:** Snapshotting is mandatory. Or break aggregates smaller.

---

## 6. Database Sharding Strategies

### Range-Based Sharding

Keys assigned to shards by range of value.

```
Shard 0: userId 0–999,999
Shard 1: userId 1,000,000–1,999,999
Shard 2: userId 2,000,000–2,999,999
```

**Advantages:**
- Range queries are efficient: "get users 1M–1.5M" → single shard.
- No lookup table needed (rule-based routing).

**Hotspot problem:**
```
January 1 (new year): thousands of users sign up simultaneously.
All get userIds in range 3,000,000–3,050,000.
All go to Shard 3. Shard 3 is the hot shard.
Shards 0, 1, 2 are cold.
```

**Fix for time-series:** Cassandra's time-based partitioning has this problem. Solution: add a bucket (hash prefix) to distribute records.
```
key = bucket_id + ":" + timestamp
bucket_id = hash(user_id) % NUM_BUCKETS  // spread across multiple partitions
```

---

### Hash-Based Sharding

`shard = hash(key) % N`

**Advantages:**
- Uniform distribution (for uniform key space).
- No hotspots for random keys.

**Disadvantages:**
- Range queries require scatter-gather: must query all N shards and merge.
- Adding/removing shards: consistent hashing mitigates this (covered in file 01).

**Cross-shard queries:**
```
"Find all orders with amount > $100 across all users"
→ Query all N shards in parallel
→ Merge and sort results
→ Expensive: N parallel queries + network + merge overhead

Solutions:
1. Denormalize: pre-aggregate into a separate "high-value-orders" table on a single shard.
2. CQRS: maintain a separate read model (e.g., Elasticsearch) for complex queries.
3. Accept scatter-gather for low-frequency analytical queries.
```

---

### Directory-Based Sharding

A **lookup service** (shard map) stores the mapping from key to shard.

```
[Shard Map Service]
  userId 42 → Shard 3
  userId 99 → Shard 7
  ...

Client → Shard Map → finds shard ID → queries that shard directly
```

**Advantages:**
- Complete flexibility: can remap any key to any shard.
- Shard migration: update the map, migrate data, redirect traffic.
- Heterogeneous shards: powerful machines host more data.

**Disadvantages:**
- Shard map is a bottleneck and single point of failure (must be replicated).
- Extra latency: one lookup before every query (mitigated by caching the map).

**Used by:** Vitess (YouTube's MySQL sharding layer), Spanner.

---

### Cross-Shard Join Strategies

**Option 1: Application-side join:**
```java
List<Order> orders = orderShard.findByUserId(userId);
List<String> productIds = orders.stream()
    .flatMap(o -> o.items().stream())
    .map(Item::productId)
    .collect(toList());
List<Product> products = productShard.findByIds(productIds); // batch lookup
// Join in application
```

**Option 2: Denormalization:**
At write time, store product name, price in the order row. No join needed at read time. Trade space for query simplicity.

**Option 3: Global/reference tables:**
Small, rarely-changing tables (countries, categories) replicated on every shard. No cross-shard query needed.

---

## 7. Cell-Based Architecture

### Blast Radius Reduction

**The problem:** In a global-scale system, a bug or overload in one component affects ALL customers worldwide.

**Cell-based architecture:** Divide the system into isolated "cells" (also called "silos" or "pods"). Each cell serves a subset of customers and is fully self-contained — it has its own compute, storage, and dependencies. A failure in one cell affects only that cell's customers.

```
                    Global Control Plane
                (thin layer: routing only)
                    /          \
                   /            \
          ┌────────────┐    ┌────────────┐
          │   Cell 1   │    │   Cell 2   │
          │ (Users A-M)│    │ (Users N-Z)│
          │            │    │            │
          │ App Servers│    │ App Servers│
          │ Database   │    │ Database   │
          │ Cache      │    │ Cache      │
          │ Kafka      │    │ Kafka      │
          └────────────┘    └────────────┘
```

**Netflix:** Calls their cells "regions." Each AWS region is semi-isolated. The Netflix global control plane handles sign-in and routing; most streaming is regional.

**Amazon:** Uses "Availability Zone independence." Services deployed in 3 AZs, with circuit breakers preventing one AZ's failure from cascading to others.

**Shopify:** Shops are their cells. Each merchant's shop is assigned to a cell. A misbehaving shop only affects others in the same cell (and even then, the bulkhead limits it).

### Cell Size Tradeoffs

| Cell Size | Blast Radius | Utilization | Complexity |
|-----------|-------------|-------------|------------|
| 1 per AZ (large cells) | Large | High (full capacity) | Low |
| 100s of micro-cells | Small | Low (over-provisioned) | High |
| 5–10 cells per region | Medium | Good | Medium |

**Shopify's design:** ~500–1000 shops per cell. Large enough for reasonable resource utilization, small enough that cell failure is not catastrophic.

---

## PART 2: RELIABILITY PATTERNS

---

## 8. Circuit Breaker

### State Machine

```
     [CLOSED]
     Normal operation.
     Counts failures.
         |
         | failure rate > threshold
         ↓
      [OPEN]
      Reject calls immediately.
      After timeout: enter HALF-OPEN.
         |
         | timeout expires
         ↓
    [HALF-OPEN]
    Allow limited test calls.
         |
         |────────────────────────→  [CLOSED] (if test calls succeed)
         |
         └────────────────────────→  [OPEN]   (if test calls fail)
```

### Resilience4j Internals

Resilience4j's `CircuitBreaker` is backed by one of two sliding window implementations.

#### Count-Based Sliding Window

Implemented as a **circular array** of N elements (where N = `slidingWindowSize`).

```
slidingWindowSize = 5, last 5 calls:

calls: [SUCCESS, SUCCESS, FAIL, SUCCESS, FAIL]  ← circular array
         index:    0         1      2      3      4

On each new call outcome:
  - Evict oldest entry (index advances)
  - Insert new outcome
  - Recompute failure rate
```

**Data structure detail:**
```java
// Simplified internal structure
class FixedSizeSlidingWindow {
    final long[] calls;       // 0=success, 1=failure, 2=slow
    final int size;
    int headIndex = 0;
    Metrics totalCounts;      // Atomically updated: successes, failures, slowCalls, totalDuration

    void record(long durationNanos, boolean success) {
        int evictedOutcome = calls[headIndex];
        calls[headIndex] = encode(success, durationNanos);
        headIndex = (headIndex + 1) % size;
        totalCounts.subtract(evictedOutcome);
        totalCounts.add(encode(success, durationNanos));
    }
}
```

**Atomicity:** Resilience4j uses `synchronized` blocks around the recording and snapshot reading operations. This ensures thread-safe failure rate calculation.

#### Time-Based Sliding Window

Implemented as **N circular buckets**, each representing 1 second (or configurable duration).

```
slidingWindowSize = 10 (seconds)
Each bucket: {successes: int, failures: int, slowCalls: int, totalDuration: long}

Current time t=T:
Buckets: [bucket(T-9), bucket(T-8), ..., bucket(T-1), bucket(T)]
                                            sum all → failure rate

At t=T+1:
  - Oldest bucket (T-9) is evicted
  - New bucket (T+1) is added
  - bucket(T+1) starts empty
```

This is more accurate than count-based for rate-limited APIs where call frequency varies. "10% failure in the last 10 seconds" means something specific regardless of traffic volume.

#### Configuration Parameters

```java
CircuitBreakerConfig config = CircuitBreakerConfig.custom()
    .slidingWindowType(SlidingWindowType.COUNT_BASED)
    .slidingWindowSize(10)                          // last 10 calls
    .minimumNumberOfCalls(5)                        // must have at least 5 calls before evaluating
    .failureRateThreshold(50.0f)                    // open if ≥50% failure rate
    .slowCallRateThreshold(80.0f)                   // also open if ≥80% calls are "slow"
    .slowCallDurationThreshold(Duration.ofSeconds(2)) // "slow" = >2s
    .waitDurationInOpenState(Duration.ofSeconds(30)) // stay OPEN for 30s
    .permittedNumberOfCallsInHalfOpenState(3)       // allow 3 test calls
    .automaticTransitionFromOpenToHalfOpenEnabled(true)
    .build();
```

#### Slow Call Tracking

Resilience4j tracks not just failures but *slow calls*. A call that takes 10s and succeeds is still a problem (it blocks threads, exhausts connection pools). The `slowCallRateThreshold` opens the circuit if too many calls are slow, even if none are failing.

```java
// Decorated call
CircuitBreaker cb = CircuitBreakerRegistry.ofDefaults().circuitBreaker("service-a");
Supplier<String> decoratedCall = CircuitBreaker.decorateSupplier(cb, () -> {
    return serviceA.call();  // if throws: counted as failure
                             // if too slow: counted as slow call
});

// Using it
try {
    String result = decoratedCall.get();
} catch (CallNotPermittedException e) {
    // Circuit is OPEN — fast-fail, don't wait
    return fallback();
}
```

---

## 9. Retry Patterns & Jitter

### Exponential Backoff

Base formula: `delay = base * 2^attempt`

```
Attempt 0: delay = 100ms * 2^0 = 100ms
Attempt 1: delay = 100ms * 2^1 = 200ms
Attempt 2: delay = 100ms * 2^2 = 400ms
Attempt 3: delay = 100ms * 2^3 = 800ms
Attempt 4: delay = 100ms * 2^4 = 1600ms
...with maxDelay cap = 30s
```

### The Thundering Herd Problem

**Scenario:** 1000 clients are all connected to a service. The service goes down at t=0. All 1000 clients get an error and schedule a retry.

**Without jitter:**
```
t=0:    Service fails. 1000 clients get errors.
t=100ms: All 1000 clients retry simultaneously.
          Service just restarted → immediately overwhelmed again.
t=200ms: All 1000 clients retry again.
          ...
Service cannot recover because it's being hammered by synchronized retries.
```

**AWS Route 53 outage in 2019** was partly exacerbated by synchronized retries from DNS clients after the initial failure.

### Jitter Algorithms

**Full Jitter:**
```python
delay = random(0, base * 2^attempt)
```

All retries are uniformly randomized between 0 and the exponential cap. Each client retries at a completely random time. Maximally spreads the retry load.

**Equal Jitter:**
```python
v = base * 2^attempt / 2
delay = v + random(0, v)
```

Keeps a minimum guaranteed wait of `v`. Prevents some clients from retrying immediately (better than full jitter for low traffic scenarios).

**Decorrelated Jitter (AWS recommendation):**
```python
sleep = random(base, sleep * 3)  # previous sleep used as min
```

Each retry's delay is derived from the previous one, but randomized. Creates natural spreading without perfectly exponential growth.

**AWS SDK default (Java SDK v2):**
```java
RetryPolicy retryPolicy = RetryPolicy.builder()
    .numRetries(3)
    .backoffStrategy(BackoffStrategy.defaultStrategy()) // uses equal jitter
    .build();
```

**Resilience4j retry with jitter:**
```java
IntervalFunction intervalWithJitter =
    IntervalFunction.ofExponentialRandomBackoff(
        Duration.ofMillis(100),  // initial interval
        2.0,                     // multiplier
        0.5,                     // randomization factor (0.5 = ±50% of interval)
        Duration.ofSeconds(30)   // maxInterval
    );

RetryConfig config = RetryConfig.custom()
    .maxAttempts(3)
    .intervalFunction(intervalWithJitter)
    .retryExceptions(SocketTimeoutException.class, ServiceUnavailableException.class)
    .ignoreExceptions(ValidationException.class)  // don't retry business errors
    .build();
```

### What NOT to Retry

```java
// Don't retry:
// - 400 Bad Request (your payload is invalid — retrying won't fix it)
// - 401 Unauthorized (token is invalid — retry won't fix it)
// - 404 Not Found (usually a bug, not transient)
// - 422 Unprocessable Entity (validation failure)

// Do retry:
// - 429 Too Many Requests (with backoff)
// - 500 Internal Server Error (could be transient)
// - 502 Bad Gateway (upstream is down, might recover)
// - 503 Service Unavailable (explicitly signals retry)
// - Connection timeout
// - Read timeout (with idempotency!)
```

**Critical:** Only retry *idempotent* operations. Retrying a non-idempotent POST may create duplicate records. Use idempotency keys.

---

## 10. Bulkhead Pattern

### The Problem

Without isolation:
```
Thread Pool (100 threads):
  Service A calls: 60 threads waiting for slow Service A response
  Service B calls: 30 threads waiting for Service B
  Service C calls: 10 threads available
  
  Service A becomes very slow (GC, overloaded):
    → All 100 threads eventually stuck waiting for Service A
    → Service B and C calls also start failing (no threads available)
    → One service's slowness takes down everything
```

### Thread Pool Isolation (Hystrix style)

Separate thread pools per downstream dependency:

```
Total application thread pool: 200 threads

Service A dedicated pool: 40 threads
Service B dedicated pool: 30 threads
Service C dedicated pool: 20 threads
Core application pool:    110 threads

Now when Service A slows down:
  → Max 40 threads blocked on Service A
  → Service B, C still operational (their pools unaffected)
  → Core app still responds
```

**Resilience4j thread pool bulkhead:**
```java
ThreadPoolBulkheadConfig config = ThreadPoolBulkheadConfig.custom()
    .maxThreadPoolSize(40)
    .coreThreadPoolSize(20)
    .queueCapacity(10)         // queue up to 10 waiting calls
    .keepAliveDuration(Duration.ofMillis(20))
    .build();

ThreadPoolBulkhead bulkhead = ThreadPoolBulkheadRegistry.of(config)
    .bulkhead("service-a");

// Submit calls to the isolated pool
CompletableFuture<String> future = bulkhead.executeSupplier(
    () -> serviceA.call()
);
```

**When the pool is full:**
If all 40 threads + 10 queue slots are occupied, new calls to service A get `BulkheadFullException` immediately (fail fast). This prevents the calling thread from blocking.

### Semaphore Isolation

Instead of a separate thread pool, limit the *number of concurrent calls* with a semaphore:

```java
BulkheadConfig config = BulkheadConfig.custom()
    .maxConcurrentCalls(25)            // max 25 concurrent calls at once
    .maxWaitDuration(Duration.ofMillis(500)) // wait up to 500ms to acquire permit
    .build();

Bulkhead bulkhead = BulkheadRegistry.of(config).bulkhead("service-a");
String result = bulkhead.executeSupplier(() -> serviceA.call());
```

**Thread pool vs Semaphore:**

| | Thread Pool | Semaphore |
|--|-------------|-----------|
| Isolation | Strong (separate threads) | Weak (same thread) |
| Overhead | High (thread context switch) | Low (semaphore acquire) |
| Async support | Natural | Can block caller thread |
| Use case | Highly variable latency services | Fast, consistent services |
| Memory | Each idle thread: 256KB–1MB stack | Negligible |

**When to choose semaphore:** For in-process calls (caches, local computation), or when the downstream service is fast and the main concern is concurrent call limiting.

**When to choose thread pool:** When the downstream service can be very slow (external HTTP calls), and you need true isolation so slow calls don't consume the caller's threads.

---

## 11. Rate Limiting Algorithms

### Token Bucket

**Model:** A bucket holds tokens. Tokens refill at a fixed rate. Each request consumes a token. If no tokens available, request is rejected.

```
Bucket capacity: 100 tokens
Refill rate: 10 tokens/second

t=0s: bucket=100, 50 requests arrive → 50 tokens consumed, bucket=50
t=0.1s: bucket += 1 (10/s * 0.1s), 30 requests → bucket=21
t=0.2s: bucket += 1, 25 requests arrive → 22 rejected (only 22 tokens)
```

**Burst handling:** Token bucket allows bursts up to bucket capacity. If traffic is low for a period, the bucket fills up, allowing a burst. This models real-world traffic better than leaky bucket.

**Redis token bucket (atomic Lua script):**
```lua
-- KEYS[1] = bucket key, ARGV[1] = max_tokens, ARGV[2] = refill_rate/s,
-- ARGV[3] = now (microseconds), ARGV[4] = requested tokens
local key = KEYS[1]
local max_tokens = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])  -- tokens per second
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local last_time = redis.call('HGET', key, 'last_time')
local tokens = redis.call('HGET', key, 'tokens')

if last_time == false then
    last_time = now
    tokens = max_tokens
else
    last_time = tonumber(last_time)
    tokens = tonumber(tokens)
    local elapsed = (now - last_time) / 1000000  -- convert µs to seconds
    tokens = math.min(max_tokens, tokens + elapsed * refill_rate)
end

local allowed = tokens >= requested
if allowed then
    tokens = tokens - requested
end

redis.call('HSET', key, 'last_time', now, 'tokens', tokens)
redis.call('PEXPIRE', key, 60000)  -- cleanup after 60s inactivity

return allowed and 1 or 0
```

**Why Lua script?** Atomicity. Without it:
```
Client 1: reads tokens=5
Client 2: reads tokens=5
Client 1: tokens=5-1=4, writes
Client 2: tokens=5-1=4, writes (race condition: consumed 2 tokens but both see 5)
```

The Lua script executes atomically on Redis (single-threaded command execution).

---

### Leaky Bucket

**Model:** Requests enter a queue (the bucket). A processor drains the queue at a fixed rate. Requests that overflow the queue are rejected.

```
         ┌─────────────────┐
Requests → │    Queue        │
         │ (max N requests) │
         └────────┬────────┘
                  │ processes at fixed rate R req/s
                  ↓
               [Output]
```

**Key difference from token bucket:** Leaky bucket *smooths* output to exactly R req/s. Token bucket allows bursts up to capacity. Leaky bucket is better for protecting downstream services from bursts.

**Use case:** Outbound API rate limiting (you're limited by an external API's rate limit). Leaky bucket ensures you never exceed it, even with internal traffic spikes.

---

### Sliding Window Log

**Exact algorithm:** For each key, maintain a log of all request timestamps. On each request:
1. Remove timestamps older than `windowSize`.
2. Count remaining timestamps.
3. If count < limit: add current timestamp, allow.
4. Else: reject.

```
Window = 60s, limit = 100 requests

Timestamps log: [t-55s, t-40s, t-30s, t-10s, t-2s, t-now]
After cleanup (remove >60s old): same (all within 60s)
Count = 6 (hypothetically low). Allow.
```

**Memory:** O(limit) timestamps per key. For 100 req/min limit: 100 timestamps. For 10,000 req/min: 10,000 timestamps. Can be expensive at scale.

**Redis implementation:**
```lua
-- Sliding window log with sorted set
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])  -- seconds
local limit = tonumber(ARGV[3])

-- Remove timestamps outside window
redis.call('ZREMRANGEBYSCORE', key, 0, now - window * 1000)

-- Count requests in window
local count = redis.call('ZCARD', key)

if count < limit then
    -- Add current request
    redis.call('ZADD', key, now, now .. '-' .. math.random(1000000))
    redis.call('PEXPIRE', key, window * 1000)
    return 1  -- allowed
else
    return 0  -- rejected
end
```

---

### Sliding Window Counter

**Compromise between fixed window and log:** Approximate sliding window using two fixed-window counters.

```
Current time: 1:15 (in the middle of 1:00–2:00 window)
Previous window (0:00–1:00): 70 requests
Current window (1:00–2:00): 40 requests, 15 minutes elapsed (25% of window)

Estimated requests in rolling 60-min window:
  = 70 * (1 - 0.25) + 40  ← weight previous by remaining overlap
  = 70 * 0.75 + 40
  = 52.5 + 40
  = 92.5 ← below limit of 100, allow
```

**Memory:** O(1) per key (just two counters + timestamps). Much cheaper than sliding window log.

**Accuracy:** Approximates the actual sliding window. The error is bounded by the previous window's request count.

---

### Distributed Rate Limiting

**Problem:** Rate limit per user across 10 load balancer nodes. Local counters don't work — each node only knows about requests it received.

**Redis-based distributed rate limiting:**
```java
@Service
public class RateLimiter {
    private final StringRedisTemplate redis;
    private final String luaScript; // sliding window Lua script

    public boolean isAllowed(String userId, int limit, int windowSecs) {
        long now = System.currentTimeMillis();
        List<String> keys = List.of("rate:" + userId);
        List<String> args = List.of(
            String.valueOf(now),
            String.valueOf(windowSecs),
            String.valueOf(limit)
        );
        Long result = redis.execute(
            RedisScript.of(luaScript, Long.class), keys, args.toArray());
        return result != null && result == 1L;
    }
}
```

**Clock skew issue:** Different application servers may have slightly different system times. For token bucket: the refill calculation depends on elapsed time. Clock skew of 50ms can cause minor inaccuracies. Mitigation: use Redis server time (`redis.call('TIME')`) in the Lua script rather than client time.

---

## 12. Timeout Patterns

### Connection Timeout vs Read Timeout

```
Client ─────────────────────────────────────────── Server

Phase 1: TCP SYN → SYN-ACK → ACK  (TCP handshake)
         │← connection timeout window →│

Phase 2: HTTP request sent
         │← read timeout window →│
         HTTP response received
```

**Connection timeout:** Maximum time to establish a TCP connection (and TLS handshake for HTTPS). If server is down, TCP SYN gets no response → connection timeout triggers.

Typical values: 1–5 seconds. No reason to wait longer — if server doesn't respond in 5s, it's effectively down.

**Read timeout:** Maximum time to wait for a response after the connection is established. This is where most "slow backend" problems manifest.

Typical values: depends on SLA. For a user-facing API, 3–10s. For internal batch jobs, 60–300s.

**HttpClient configuration in Java:**
```java
// Apache HttpClient 5.x
RequestConfig requestConfig = RequestConfig.custom()
    .setConnectionRequestTimeout(Timeout.ofSeconds(2))  // wait for pool slot
    .setConnectTimeout(Timeout.ofSeconds(3))             // TCP handshake
    .setResponseTimeout(Timeout.ofSeconds(10))           // read response
    .build();

CloseableHttpClient client = HttpClients.custom()
    .setDefaultRequestConfig(requestConfig)
    .build();

// Java 11+ HttpClient
HttpClient client = HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(3))
    .build();

HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("http://example.com/api"))
    .timeout(Duration.ofSeconds(10))  // overall request timeout
    .build();
```

### Cascading Timeouts

In a microservice chain, timeouts must be *smaller* as you go deeper:

```
Client (30s timeout)
  → Service A (25s timeout)
    → Service B (20s timeout)
      → Service C (15s timeout)
        → Database (10s timeout)
```

If Service C has a 30s timeout but Service A has a 25s timeout, Service A will give up before C does — wasting C's resources.

**Deadline propagation:** gRPC supports deadline propagation natively. The client sets an overall deadline; gRPC propagates remaining time through the RPC chain. Each hop decrements the deadline.

```java
// gRPC deadline propagation
Context deadline = Context.current().withDeadline(
    Deadline.after(5, TimeUnit.SECONDS), executor);
deadline.run(() -> {
    stub.withDeadlineAfter(5, TimeUnit.SECONDS).callMethod(request);
    // Downstream services called with remaining deadline
});
```

---

## 13. Idempotency

### What Is Idempotency

An operation is idempotent if performing it multiple times has the same effect as performing it once.

- Idempotent: GET, PUT (set resource to specific state), DELETE (delete already-deleted = no-op)
- NOT idempotent by default: POST (create), PATCH (increment)

**Why it matters for reliability:**
```
Client ──── POST /orders ────→ Server
                               Server processes (creates order), commits DB
            ←── [TCP timeout] (response never reaches client)
Client: "Did the server receive my request? I'll retry."
Client ──── POST /orders ────→ Server
                               Server processes AGAIN → DUPLICATE ORDER
```

### Idempotency Keys

Client generates a unique ID (UUID v4) for each operation. Server stores the result of processing that ID. On replay, returns the stored result without reprocessing.

**Stripe's implementation:**
```
POST /charges
Idempotency-Key: a2b3c4d5-e6f7-8901-a2b3-c4d5e6f78901
Content-Type: application/json
{"amount": 2000, "currency": "usd", "customer": "cus_xyz"}
```

**Server-side:**
```java
@PostMapping("/charges")
public ResponseEntity<Charge> createCharge(
        @RequestHeader("Idempotency-Key") String idempotencyKey,
        @RequestBody ChargeRequest request) {

    // Check if we've seen this key before
    Optional<IdempotencyRecord> existing =
        idempotencyStore.find(idempotencyKey);

    if (existing.isPresent()) {
        // Return the EXACT same response as the first time
        return ResponseEntity.ok(existing.get().result());
    }

    // Process the charge
    Charge charge = chargeService.process(request);

    // Store result atomically (in same DB transaction)
    idempotencyStore.save(
        new IdempotencyRecord(idempotencyKey, charge,
                              Instant.now().plus(24, HOURS)));

    return ResponseEntity.status(201).body(charge);
}
```

**Storage of idempotency records:**
- Must be stored in the same database transaction as the business operation (atomicity).
- Or stored in Redis with TTL for stateless/non-critical operations.
- Cleanup: after 24h (or whatever your retry window is), records can be deleted.

**Conflict detection:** What if two requests with the same idempotency key but different request bodies arrive?
```
Request 1: Idempotency-Key=abc, amount=100
Request 2: Idempotency-Key=abc, amount=200  ← different body, same key
```
Stripe returns `422 Unprocessable Entity: A request with a different body was previously made with this idempotency key`. Keys are bound to the specific request body.

### Database-Level Idempotency

For internal systems where you control both sides:

```sql
-- INSERT with ON CONFLICT DO NOTHING (PostgreSQL)
INSERT INTO orders (order_id, user_id, amount, created_at)
VALUES ('ord-123', 'user-456', 100.00, NOW())
ON CONFLICT (order_id) DO NOTHING;

-- INSERT with ON CONFLICT DO UPDATE (upsert)
INSERT INTO user_preferences (user_id, theme)
VALUES ('user-456', 'dark')
ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme;
```

**MySQL equivalent:**
```sql
INSERT IGNORE INTO orders (order_id, user_id, amount) VALUES (...);
-- or
INSERT INTO orders ... ON DUPLICATE KEY UPDATE amount = amount;
```

---

## 14. Backpressure

### The Problem

Without backpressure:
```
Producer (10,000 events/s) ──→ Queue ──→ Consumer (1,000 events/s)
                                  ↓
                          Queue fills up → OutOfMemoryError
                          OR events dropped silently
```

Backpressure is the mechanism by which a *slow consumer* signals to its *fast producer* to slow down.

### Reactive Streams & Project Reactor

Java's Reactive Streams specification defines a protocol with a `Publisher`, `Subscriber`, `Subscription`, and `Processor`. The key method: `Subscription.request(n)` — subscriber tells publisher "give me N more items."

```
Publisher                       Subscriber
    |                               |
    |← subscribe(subscriber) ───────|  Subscriber subscribes
    |                               |
    |─── onSubscribe(subscription) →|  Publisher sends subscription handle
    |                               |
    |                               |── subscription.request(10) →  (subscriber requests 10 items)
    |                               |
    |─── onNext(item1) ────────────→|
    |─── onNext(item2) ────────────→|
    ... (10 items)
    |                               |
    |                               | (subscriber processes items, then:)
    |                               |── subscription.request(10) →  (request next 10)
    ...
```

**Backpressure in practice (Project Reactor):**
```java
// Slow consumer — processes items at its own pace
Flux.range(1, 1_000_000)
    .log()                           // logs request(N) calls
    .onBackpressureBuffer(1000)      // buffer up to 1000 items, drop beyond
    .subscribe(new BaseSubscriber<Integer>() {
        @Override
        protected void hookOnSubscribe(Subscription subscription) {
            request(1);  // request one item at a time
        }

        @Override
        protected void hookOnNext(Integer value) {
            // Process
            processSlowly(value);
            request(1);  // request next only after processing current
        }
    });
```

### Backpressure Strategies

**1. Buffer:** Store excess items in a queue. Risk: unbounded buffer → OOM.
```java
flux.onBackpressureBuffer(maxSize, item -> log.warn("Dropped: {}", item));
```

**2. Drop:** Discard items when consumer is busy.
```java
flux.onBackpressureDrop(item -> log.warn("Dropped: {}", item));
```

**3. Latest:** Keep only the most recent item, discard older ones.
```java
flux.onBackpressureLatest();  // if consumer is slow, always processes latest
```

**4. Error:** Fail if producer is faster than consumer. Forces the problem to be handled explicitly.
```java
flux.onBackpressureError();  // throws OverflowException
```

**5. Slow the producer:** In Reactive Streams, `request(n)` propagates upstream. A reactive database driver (R2DBC) supports this — it only fetches from DB when the subscriber requests items.

### Kafka Consumer as Backpressure Example

Kafka consumers inherently have backpressure — the consumer controls its fetch rate:

```java
// Kafka consumer: pull model
ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));
// poll() only fetches what the consumer is ready to process
// If processing is slow, poll() isn't called → partition lag builds up
// But the producer is NOT slowed down (Kafka as buffer)
```

Kafka IS the buffer. Backpressure in Kafka means consumer lag grows, not producer slowdown. You monitor consumer lag (`kafka-consumer-groups.sh --describe`) and alert when it exceeds thresholds.

### Bulkhead + Backpressure in Practice

```java
// Combining bulkhead (concurrency limit) with backpressure (reactive)
Semaphore semaphore = new Semaphore(25);  // max 25 concurrent calls

Flux.fromIterable(requests)
    .flatMap(req ->
        Mono.fromCallable(() -> {
            semaphore.acquire();
            try {
                return serviceA.callBlocking(req);
            } finally {
                semaphore.release();
            }
        }).subscribeOn(Schedulers.boundedElastic()),
        25  // max concurrency — inner parameter
    )
    .subscribe();
```

---

## Pattern Interaction Summary

```
╔══════════════════════════════════════════════════════════════╗
║  RELIABILITY PATTERN LAYERING                               ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Request → [Rate Limiter] → [Circuit Breaker]               ║
║                                  ↓                           ║
║             [Bulkhead Thread Pool]                           ║
║                                  ↓                           ║
║                      [Retry + Backoff + Jitter]             ║
║                                  ↓                           ║
║                           [Timeout]                          ║
║                                  ↓                           ║
║                        Downstream Service                    ║
║                                                              ║
║  Failures bubble up: timeout → retry → circuit breaker      ║
║  opens → rate limiter sees reduced capacity                  ║
╚══════════════════════════════════════════════════════════════╝
```

**Order of application:**
1. Rate limiter (outermost): prevents overload before anything else.
2. Circuit breaker: fail fast if downstream is known-bad.
3. Bulkhead: limit concurrent attempts.
4. Retry: attempt recovery with backoff.
5. Timeout (innermost): bound each individual attempt.

---

Sources consulted:
- [Resilience4j CircuitBreaker docs](https://resilience4j.readme.io/docs/circuitbreaker)
- [Saga Pattern: Choreography vs Orchestration - AWS](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-choreography.html)
- [Microservices Pattern: Saga](https://microservices.io/patterns/data/saga.html)
- [Event Sourcing Pattern - Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [CQRS Pattern - Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
