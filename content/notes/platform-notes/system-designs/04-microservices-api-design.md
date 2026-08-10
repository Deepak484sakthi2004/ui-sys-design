# Microservices & API Design — Deep Technical Reference

> Target: Senior Java/Systems developer, 15yr exp, 40 LPA interviews.
> Production-depth coverage of microservices architecture, communication patterns, and API design.

---

## Table of Contents

1. Service Decomposition (DDD & Bounded Contexts)
2. Inter-Service Communication
3. gRPC Deep Dive
4. API Gateway Patterns
5. Service Discovery
6. Data Consistency in Microservices
7. Distributed Tracing
8. API Versioning Strategies
9. Database-Per-Service Pattern
10. Strangler Fig Pattern
11. Event-Driven Architecture
12. Idempotent Consumer Pattern

---

## 1. Service Decomposition: DDD & Bounded Contexts

### Domain-Driven Design (DDD) Primer

Eric Evans' DDD provides the vocabulary and patterns for decomposing a complex domain into cohesive services.

**Key concepts:**

- **Domain:** The subject area your software addresses (e-commerce, banking, shipping).
- **Bounded Context:** A linguistic boundary within which a domain model is consistent. The same term can mean different things in different bounded contexts.
- **Aggregate:** A cluster of domain objects treated as a unit for data changes. Has a single root entity (Aggregate Root). Transactions are limited to one aggregate.
- **Context Map:** Explicit mapping of how different bounded contexts relate.

### Finding Service Boundaries

**The "different things" test:**

"Customer" in e-commerce means different things to different teams:
- **Order service:** Customer = billing address, payment method, order history
- **Support service:** Customer = support tickets, escalation history, SLA tier
- **Loyalty service:** Customer = points balance, tier (Gold/Silver), redemptions

These are three different bounded contexts with three different models of "Customer." Three services, not one God-service with a monster Customer table.

**The "team size" heuristic (Conway's Law):**
> "Organizations which design systems are constrained to produce designs which are copies of the communication structures of those organizations."

A service boundary often matches a team boundary. A team of 5–8 engineers owns one service (Amazon's "two-pizza team rule"). If understanding a service requires knowing what 3 other teams are doing, the boundary is wrong.

**The "verb + noun" pattern:**
Services often emerge from business capabilities:
- Process Payment → Payment Service
- Track Shipment → Shipment Tracking Service
- Recommend Products → Recommendation Service
- Send Notification → Notification Service

**What NOT to do (anti-patterns):**

1. **Chatty services:** OrderService calls CustomerService 5 times per request. Tight coupling, high latency, hard to operate independently.
2. **Shared database:** Two services share the same table. Any schema change requires coordination. No independent deployment. This is a distributed monolith.
3. **Service-per-database-table:** Too fine-grained. CRUD services have no business logic. You just moved the problem down a layer.
4. **Shared domain objects across services:** `common-domain.jar` imported by all services. Any change requires redeployment of all services. Eliminates independent deployment.

### Bounded Context Interaction Patterns

**1. Shared Kernel:** Two contexts share a small common model. Risky — changes require both teams.

**2. Customer-Supplier:** One context (supplier) provides data/API to another (customer). Supplier team considers customer's needs when making changes. Common for internal APIs.

**3. Anticorruption Layer (ACL):** When integrating with a legacy system or poorly designed external API, the ACL translates between the external model and your internal domain model.

```java
// External payment gateway uses their own Order model
public class StripeAnticorruptionLayer {
    public PaymentResult processPayment(Order ourOrder) {
        // Translate our domain model to Stripe's model
        StripeChargeRequest stripeReq = new StripeChargeRequest(
            ourOrder.getTotalCents(),    // Stripe uses cents
            ourOrder.getCurrency().getIsoCode(),
            toStripeMetadata(ourOrder)
        );
        StripeCharge charge = stripeClient.createCharge(stripeReq);
        // Translate Stripe's response back to our domain model
        return new PaymentResult(
            charge.getId(),
            charge.getStatus().equals("succeeded"),
            charge.getAmount()
        );
    }
}
```

**4. Open Host Service:** A service exposes a well-defined API (published language) that multiple consuming services use. Like a public API.

---

## 2. Inter-Service Communication

### Synchronous (Request-Response)

The caller waits for the response before proceeding.

**REST (HTTP/1.1 or HTTP/2):**
- Text-based (JSON), human-readable, browser-friendly.
- Easy to test with curl/Postman.
- Stateless, caches well.
- Higher overhead than binary protocols.

**gRPC (HTTP/2 + Protobuf):**
- Binary, compact, fast.
- Strongly typed contracts.
- Bidirectional streaming.
- Code generation from `.proto` files.
- Covered in depth in Section 3.

**When to use synchronous:**
- The response is needed before proceeding (e.g., payment authorization before order confirmation).
- Real-time user interactions (search, autocomplete).
- Request-response where the client needs to act on the result.

**Synchronous coupling risk:**
```
Client → Service A → Service B → Service C

If C is down: C throws timeout
→ B waits until its timeout, then fails
→ A waits until its timeout, then fails
→ Client waits until A's timeout, then fails

Total failure time = sum of all timeouts (cascading)
```

Mitigate with: circuit breakers, bulkheads, timeout budgets, async fallback.

### Asynchronous (Event-Driven)

The caller publishes an event and continues. The reaction happens later.

**Message broker (Kafka, SQS, RabbitMQ):**
```
Order Service → [Kafka: order.created] → Payment Service (consumes)
                                        → Inventory Service (consumes)
                                        → Notification Service (consumes)
```

**When to use async:**
- Fire-and-forget scenarios (send email after registration — no one waits for the email to send).
- Workflows that span multiple services over time (order processing takes minutes).
- Decoupling producers from consumers (spikes are absorbed by the queue).
- When downstream service availability shouldn't affect the upstream.

**Async challenges:**
- No immediate error feedback to caller.
- Eventual consistency — the system isn't in a consistent state immediately.
- Harder to debug (events flow through multiple services, hard to trace).
- Message ordering (Kafka partitions maintain order within a partition).
- Idempotency required (duplicate message delivery must be handled).

### Sync vs Async Decision Matrix

| Criteria | Synchronous | Asynchronous |
|----------|-------------|--------------|
| Need immediate response | Yes | No |
| Long-running operation | No | Yes |
| High availability required | No (coupled to downstream) | Yes (decoupled) |
| Ordering important | Yes (trivial) | Partition-level (Kafka) |
| Simple error handling | Yes | No |
| Independent deployment | Partial | Yes |
| Spike handling | No (blocks) | Yes (queue absorbs) |

---

## 3. gRPC Deep Dive

### Protocol Buffers: Binary Encoding

Define your service in `.proto`:

```protobuf
syntax = "proto3";

service OrderService {
  rpc CreateOrder (CreateOrderRequest) returns (CreateOrderResponse);
  rpc GetOrder    (GetOrderRequest)    returns (OrderResponse);
  rpc StreamOrders(StreamRequest)     returns (stream OrderResponse);  // server streaming
  rpc UpdateOrders(stream UpdateRequest) returns (stream UpdateResponse);  // bidirectional
}

message CreateOrderRequest {
  string user_id    = 1;
  repeated Item items = 2;
  double total_amount = 3;
}

message Item {
  string product_id = 1;
  int32  quantity   = 2;
  double price      = 3;
}
```

**How Protobuf encodes fields:**

Each field is encoded as `(field_number << 3) | wire_type`:
- Wire type 0: Varint (int32, int64, bool, enum)
- Wire type 1: 64-bit (double, fixed64)
- Wire type 2: Length-delimited (string, bytes, embedded messages, repeated fields)
- Wire type 5: 32-bit (float, fixed32)

```
Field 1 (user_id, type string = wire_type 2):
  Tag: (1 << 3) | 2 = 0x0A = 10
  Length: 4 (for "u001")
  Data: "u001" as bytes

Field 3 (total_amount, type double = wire_type 1):
  Tag: (3 << 3) | 1 = 0x19 = 25
  Data: 8 bytes IEEE 754 double
```

**Size comparison: JSON vs Protobuf**

For `CreateOrderRequest` with 3 items:
- JSON: ~380 bytes (field names as strings, decimal numbers, braces, brackets)
- Protobuf: ~90 bytes (field numbers instead of names, binary numbers, no delimiters)

**~4x size reduction** → 4x less bandwidth, 4x less serialization CPU.

### HTTP/2 Multiplexing

HTTP/1.1 problem: One request per TCP connection. With connection pooling, you have N connections, but each is idle most of the time or head-of-line blocked.

HTTP/2: Multiple independent *streams* over a single TCP connection:

```
Single TCP Connection between Service A and Service B:

Stream 1: [HEADERS][DATA][DATA][DATA]
Stream 3: [HEADERS][DATA]
Stream 5: [HEADERS][DATA][DATA][DATA][DATA]
Stream 7: [HEADERS]

Frames from different streams are interleaved:
Stream 1 DATA → Stream 3 DATA → Stream 5 DATA → Stream 1 DATA → Stream 7 HEADERS → ...

Each stream is independent — slow response on Stream 1 doesn't block Stream 3.
```

**gRPC connection management:**
- One long-lived connection per backend.
- Multiple concurrent RPCs share one connection.
- Connection setup overhead: once per backend, not per RPC.
- Keep-alive pings: `SETTINGS_KEEP_ALIVE_TIMEOUT` prevents idle connection closure.

### gRPC Streaming Types

#### 1. Server Streaming

Client sends one request, receives a stream of responses:

```protobuf
rpc GetOrderHistory (GetOrdersRequest) returns (stream OrderResponse);
```

```java
// Server
public void getOrderHistory(GetOrdersRequest request,
        StreamObserver<OrderResponse> responseObserver) {
    List<Order> orders = orderRepo.findByUser(request.getUserId());
    for (Order order : orders) {
        responseObserver.onNext(toProto(order));  // stream each order
    }
    responseObserver.onCompleted();  // signal end of stream
}

// Client
stub.getOrderHistory(request, new StreamObserver<OrderResponse>() {
    @Override
    public void onNext(OrderResponse order) {
        processOrder(order);  // called for each order as it arrives
    }
    @Override
    public void onCompleted() { /* all orders received */ }
    @Override
    public void onError(Throwable t) { /* handle error */ }
});
```

**Use case:** Returning large result sets without buffering everything. Log streaming. Real-time price feeds.

#### 2. Client Streaming

Client sends a stream, server responds once:

```protobuf
rpc BatchCreateOrders (stream CreateOrderRequest) returns (BatchResult);
```

**Use case:** File upload (stream chunks), batch inserts.

#### 3. Bidirectional Streaming

Both sides send streams independently:

```protobuf
rpc Chat (stream ChatMessage) returns (stream ChatMessage);
```

```java
// Both client and server can send at any time
// Order is preserved within each stream
// Two streams operate independently
```

**Use case:** Real-time chat, game state sync, bidirectional telemetry.

### When gRPC Beats REST

| Scenario | gRPC Advantage |
|----------|---------------|
| Internal service-to-service | Binary protocol, 4x smaller payloads |
| High throughput (>10K req/s) | Multiplexing, header compression |
| Streaming | First-class streaming support |
| Polyglot systems | Code generation for 10+ languages |
| Tight latency budget | Lower serialization overhead |
| Bidirectional communication | Built-in, vs WebSocket + custom protocol |

**When REST wins:**
- Public APIs (browsers don't support gRPC natively yet — grpc-web is an option but adds a proxy)
- When discoverability and tooling (curl, Postman, browser DevTools) matter
- Human-readable payloads needed for debugging
- Simple CRUD operations where Protobuf overhead isn't justified

### gRPC Flow Control

HTTP/2 flow control prevents fast producers from overwhelming slow consumers.

```
Initial stream window: 65,535 bytes (HTTP/2 default)
When receiver processes data, it sends WINDOW_UPDATE frames:
    "I've consumed 32KB, you can send 32KB more"

gRPC service config for flow control:
```

```java
// Server-side flow control configuration
NettyServerBuilder.forPort(8080)
    .initialFlowControlWindow(1024 * 1024)   // 1MB per stream
    .flowControlWindow(1024 * 1024)           // 1MB per connection
    .maxMessageSize(4 * 1024 * 1024)          // 4MB max message
    .build();
```

---

## 4. API Gateway Patterns

### What an API Gateway Does

The API gateway is the single entry point for all clients into your microservices system.

```
          ┌──────────────────────────────┐
          │        API Gateway           │
          │  - SSL termination           │
          │  - Authentication (JWT/OAuth)│
          │  - Rate limiting             │
          │  - Request routing           │
          │  - Request aggregation       │
          │  - Response transformation   │
          │  - Logging / metrics         │
          └──────────────────────────────┘
              /           |          \
    [Order Service]  [User Service]  [Inventory Service]
```

**SSL Termination:** HTTPS from client to gateway; HTTP (or mTLS) from gateway to services. Simplifies certificate management — one cert at the gateway, not per service.

**Authentication Centralization:**
```java
// Gateway filter: validate JWT before forwarding
@Component
public class AuthenticationGatewayFilter implements GlobalFilter {
    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String token = exchange.getRequest().getHeaders()
            .getFirst(HttpHeaders.AUTHORIZATION);

        if (token == null || !token.startsWith("Bearer ")) {
            exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
            return exchange.getResponse().setComplete();
        }

        try {
            Claims claims = jwtService.parse(token.substring(7));
            // Forward userId to downstream service via header
            ServerHttpRequest mutatedRequest = exchange.getRequest()
                .mutate()
                .header("X-User-Id", claims.getSubject())
                .header("X-User-Role", claims.get("role", String.class))
                .build();
            return chain.filter(exchange.mutate().request(mutatedRequest).build());
        } catch (JwtException e) {
            exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
            return exchange.getResponse().setComplete();
        }
    }
}
```

Downstream services trust the `X-User-Id` header (since only the gateway can set it, after validating the JWT). They don't need to parse JWTs themselves.

### Request Aggregation

Mobile apps often need data from 5 different services to render a single screen. Without aggregation, the app makes 5 HTTP calls (slow, especially on mobile).

With API gateway aggregation:
```
Mobile app → GET /api/home-screen
             
             Gateway internally:
             → GET /users/{id}        (user info)
             → GET /orders/recent     (recent orders)
             → GET /recommendations   (personalized recs)
             → GET /notifications     (unread count)
             [all 4 in parallel]
             
             Aggregates results → single JSON response to mobile
```

This is the **API Composition** pattern. Reduces mobile round trips from 4 to 1.

**Spring Cloud Gateway example:**
```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-service
          uri: lb://ORDER-SERVICE      # lb = load-balanced via service discovery
          predicates:
            - Path=/api/orders/**
          filters:
            - StripPrefix=1
            - name: CircuitBreaker
              args:
                name: orderCircuitBreaker
                fallbackUri: forward:/fallback/orders
            - name: RateLimiter
              args:
                redis-rate-limiter.replenishRate: 100
                redis-rate-limiter.burstCapacity: 200
```

### BFF (Backend for Frontend)

One gateway per frontend type. Different frontends have different data needs.

```
Mobile App  → [Mobile BFF]  → microservices (compact payloads, push notification support)
Web App     → [Web BFF]     → microservices (rich data, pagination)
3rd Party   → [Public API]  → microservices (rate limited, versioned, documented)
```

**Why BFF:**
- Mobile app needs compressed data (limited bandwidth, CPU).
- Web app needs full data with embedded objects.
- A single BFF for both serves neither well.
- Each BFF team owns their interface, can optimize independently.

Netflix uses multiple BFFs: one for each device type (TV, iOS, Android, browser).

---

## 5. Service Discovery

### The Problem

In microservices, service instances come and go. `order-service` might run on 10 IPs that change daily. How do consumers find the current addresses?

### Client-Side Discovery

The client is responsible for finding the service instance.

```
Client → Service Registry (Consul/Eureka)
         "Give me list of order-service instances"
         ← [10.0.0.1:8080, 10.0.0.2:8080, 10.0.0.3:8080]

Client → load balance among instances → choose 10.0.0.2:8080 → make request
```

**Components:**
- **Service registry:** Stores service name → list of instances (health-checked).
- **Registration:** Each service registers itself on startup, deregisters on shutdown.
- **Health check:** Registry periodically pings instances; removes unhealthy ones.

**Eureka (Netflix OSS):**
```java
// Service registers on startup
@SpringBootApplication
@EnableEurekaClient
public class OrderServiceApplication {
    // Eureka client auto-registers based on application.yml:
    // spring.application.name: order-service
    // eureka.instance.hostname: ${HOST_NAME}
}

// Client calls:
@Autowired
private DiscoveryClient discoveryClient;

public void callOrderService() {
    List<ServiceInstance> instances = discoveryClient.getInstances("order-service");
    ServiceInstance instance = loadBalance(instances);  // round-robin, random, etc.
    String url = instance.getUri() + "/orders";
    restTemplate.getForObject(url, OrderResponse[].class);
}
```

**Eureka consistency model:**
Eureka is AP (availability over consistency). It continues serving stale instance lists during network partitions. This is intentional — a temporarily stale list is better than an error.

### Server-Side Discovery

Client calls a load balancer (LB). LB queries the registry and routes to an available instance.

```
Client → Load Balancer (AWS ALB, NGINX, Envoy)
              ↓
          Service Registry query
              ↓
         Routes to healthy instance
```

**Kubernetes Service:** The canonical server-side discovery in K8s.
```yaml
apiVersion: v1
kind: Service
metadata:
  name: order-service
spec:
  selector:
    app: order
  ports:
    - port: 80
      targetPort: 8080
```

`order-service` DNS name resolves to the ClusterIP. kube-proxy maintains iptables rules routing to healthy pods. Service discovery is invisible to the application.

**DNS-based discovery:** Many systems use DNS with short TTLs. AWS Route 53 + ALB: ECS tasks register with the load balancer; ALB DNS resolves to current healthy tasks.

### Service Mesh (Sidecar Pattern)

Instead of building discovery/LB/circuit breaking into each service, a *sidecar proxy* (Envoy) handles it transparently.

```
[Service A Pod]                    [Service B Pod]
┌──────────────────┐               ┌──────────────────┐
│ [Order Service]  │               │ [Payment Service] │
│     ↕ localhost  │               │     ↕ localhost   │
│ [Envoy Sidecar]──│─── mTLS ─────→│──[Envoy Sidecar] │
└──────────────────┘               └──────────────────┘
```

Service A calls `localhost:8001` (its sidecar). The sidecar:
1. Looks up service B's address from the control plane (Istio Pilot).
2. Establishes mTLS to service B's sidecar.
3. Applies retry, circuit breaking, rate limiting policies.
4. Emits metrics (Prometheus), traces (Jaeger), logs.

Service A doesn't know any of this is happening. It just calls localhost.

**Istio control plane:**
- **Pilot:** Pushes service discovery data and routing config to sidecar proxies.
- **Citadel:** Issues certificates for mTLS.
- **Mixer:** (deprecated in Istio 1.5+, merged into Envoy): Policy enforcement, telemetry.

---

## 6. Data Consistency in Microservices

### Why ACID Doesn't Work Across Services

In a monolith:
```java
@Transactional
public void checkout(Order order) {
    orderRepo.save(order);         // DB write 1
    inventoryRepo.reserve(order);  // DB write 2 (same DB, same transaction)
    paymentRepo.charge(order);     // DB write 3
    // All in one ACID transaction — commit or rollback atomically
}
```

In microservices, each service has its own database. There is no distributed transaction manager that provides ACID across services (2PC across microservices is an anti-pattern — too slow, too brittle).

**The tradeoff:** Microservices accept eventual consistency. If the payment fails after inventory was reserved, you need a compensating transaction to unreserve.

### Saga Pattern (Revisited for Microservices Context)

Covered in depth in file 02, here's the Java implementation:

#### Orchestrated Saga with Temporal

**Temporal** (created by ex-Uber engineers) is the production-grade Saga orchestrator. State is persisted automatically; if the orchestrator crashes, it recovers from where it left off.

```java
// Workflow definition (orchestrator)
@WorkflowInterface
public interface OrderWorkflow {
    @WorkflowMethod
    OrderResult processOrder(OrderRequest request);
}

@WorkflowImpl(taskQueues = "order-processing")
public class OrderWorkflowImpl implements OrderWorkflow {
    private final InventoryActivities inventory =
        Workflow.newActivityStub(InventoryActivities.class,
            ActivityOptions.newBuilder()
                .setStartToCloseTimeout(Duration.ofSeconds(10))
                .setRetryOptions(RetryOptions.newBuilder()
                    .setMaximumAttempts(3).build())
                .build());
    
    private final PaymentActivities payment =
        Workflow.newActivityStub(PaymentActivities.class, /* options */);
    
    @Override
    public OrderResult processOrder(OrderRequest request) {
        String reservationId = null;
        String paymentId = null;
        
        try {
            // Step 1: Reserve inventory
            reservationId = inventory.reserve(request.getItems());
            
            // Step 2: Charge payment
            paymentId = payment.charge(request.getPaymentMethod(),
                request.getTotalAmount());
            
            // Step 3: Confirm inventory (commit the reservation)
            inventory.confirm(reservationId);
            
            return OrderResult.success(request.getOrderId());
            
        } catch (InventoryException e) {
            // Compensate: nothing to undo (reservation failed)
            return OrderResult.failure("Inventory unavailable");
            
        } catch (PaymentException e) {
            // Compensate: release inventory reservation
            if (reservationId != null) {
                inventory.release(reservationId);
            }
            return OrderResult.failure("Payment failed");
        }
    }
}
```

**Why Temporal is better than rolling your own:**
- Handles workflow persistence automatically (state stored in Temporal's DB).
- Re-executes from last checkpoint after crash (deterministic replay).
- Built-in retry policies, timeouts, activity heartbeating.
- Visibility: see all running workflows, their state, history.

---

## 7. Distributed Tracing

### The Problem

```
Request ID: req-abc123
User hits POST /checkout

→ API Gateway (2ms)
  → Order Service (15ms)
    → Inventory Service (50ms)  ← SLOW — why?
      → Database (45ms)         ← actually the slow part
    → Payment Service (8ms)
  → Notification Service (3ms)
```

Without distributed tracing, you know the overall request was slow. But which service? Which database query?

### Correlation IDs (Minimum Viable Tracing)

At minimum, propagate a trace ID through every request:

```java
// API Gateway: generate trace ID
String traceId = UUID.randomUUID().toString();
request.setAttribute("traceId", traceId);
downstreamRequest.setHeader("X-Trace-Id", traceId);

// Each service: log with trace ID
log.info("[{}] Processing order {}", traceId, orderId);

// Each outbound call: forward trace ID
HttpRequest outboundReq = HttpRequest.newBuilder()
    .header("X-Trace-Id", request.getHeader("X-Trace-Id"))
    .build();
```

This at least lets you grep logs across services for a single request.

### OpenTelemetry (Production Standard)

OpenTelemetry provides a standardized API for traces, metrics, and logs.

**Concepts:**
- **Trace:** A complete request lifecycle, spanning multiple services.
- **Span:** A unit of work within a trace. Has a start time, end time, attributes, events.
- **Span context:** `traceId` + `spanId` + trace flags, propagated across service boundaries.

```
Trace: req-abc123
├── Span: API Gateway [0ms, 2ms]
├── Span: Order Service [2ms, 17ms]
│   ├── Span: DB Query (select) [2ms, 4ms]
│   ├── Span: Inventory Service call [4ms, 54ms]  ← 50ms
│   │   ├── Span: DB Query (update) [4ms, 52ms]  ← 48ms! This is the issue.
│   └── Span: Payment Service call [54ms, 62ms]
└── Span: Notification Service [62ms, 65ms]
```

**Java instrumentation (auto-instrumentation via agent):**

The OpenTelemetry Java agent instruments common frameworks (Spring, JDBC, Kafka, gRPC) automatically without code changes:

```shell
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.service.name=order-service \
     -Dotel.exporter.otlp.endpoint=http://jaeger:4317 \
     -jar order-service.jar
```

The agent intercepts JDBC calls, HTTP client calls, Kafka sends/receives, and creates spans automatically.

**Manual instrumentation for business logic:**
```java
Tracer tracer = GlobalOpenTelemetry.getTracer("order-service");

Span span = tracer.spanBuilder("validateAndEnrichOrder")
    .setAttribute("order.id", orderId)
    .setAttribute("order.userId", userId)
    .startSpan();

try (Scope scope = span.makeCurrent()) {
    // business logic
    OrderValidationResult result = validator.validate(order);
    span.setAttribute("order.validationResult", result.toString());
    return result;
} catch (Exception e) {
    span.setStatus(StatusCode.ERROR, e.getMessage());
    span.recordException(e);
    throw e;
} finally {
    span.end();
}
```

### Context Propagation Across Services

**W3C Trace Context standard (HTTP):**
```
traceparent: 00-{traceId}-{spanId}-{flags}
tracestate:  vendor-specific key=value

Example:
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
```

**gRPC metadata (for gRPC calls):**
OpenTelemetry auto-instruments gRPC to propagate context in gRPC metadata headers.

**Kafka (message header propagation):**
```java
// Producer: inject span context into Kafka message headers
Span span = tracer.spanBuilder("publish.order.created").startSpan();
try (Scope scope = span.makeCurrent()) {
    Headers headers = new RecordHeaders();
    openTelemetry.getPropagators().getTextMapPropagator()
        .inject(Context.current(), headers, KafkaHeaderSetter.INSTANCE);
    kafkaTemplate.send(new ProducerRecord<>(
        "order.created", null, null, key, value, headers));
}

// Consumer: extract span context from Kafka message headers
Context extracted = openTelemetry.getPropagators().getTextMapPropagator()
    .extract(Context.current(), record.headers(), KafkaHeaderGetter.INSTANCE);
Span span = tracer.spanBuilder("process.order.created")
    .setParent(extracted)  // links to the producer span
    .startSpan();
```

### Jaeger for Trace Storage and Visualization

```
Services → OTLP (gRPC) → Jaeger Collector → Cassandra/Elasticsearch (storage)
                                            → Jaeger Query Service
                                            → Jaeger UI (view traces)
```

Jaeger UI allows:
- Search by service name, trace ID, operation name, tag value, duration range.
- Waterfall view showing all spans in a trace.
- Service dependency graph.
- Comparison of similar traces (why was this one slow?).

---

## 8. API Versioning Strategies

### Why Versioning Is Necessary

Deployed clients (mobile apps especially) cannot be updated instantly. A mobile app might be running v1.2 for months after you've released v2.0 backend. Your API must support both simultaneously.

### Strategy 1: URL Path Versioning

```
/api/v1/orders
/api/v2/orders
```

**Pros:** Explicit, cache-friendly (distinct cache keys per version), easy to route at gateway.

**Cons:** Duplication — if 99% of endpoints haven't changed, they're still at different URLs. Clients must update all their URL strings when upgrading.

**When to use:** Public APIs, major breaking changes, when versions will coexist for months or years.

**Routing at gateway:**
```yaml
routes:
  - id: orders-v1
    uri: lb://order-service-v1
    predicates:
      - Path=/api/v1/orders/**
  - id: orders-v2
    uri: lb://order-service-v2
    predicates:
      - Path=/api/v2/orders/**
```

### Strategy 2: HTTP Header Versioning

```
GET /api/orders
Accept-Version: v2
```

**Pros:** URL stays clean. Multiple versions served from the same endpoint.

**Cons:** Less visible (you can't see the version in browser URL bar). Breaks caching (must include version in Vary header: `Vary: Accept-Version`). Less tooling support.

```java
@GetMapping("/api/orders")
public ResponseEntity<?> getOrders(
        @RequestHeader(value = "Accept-Version", defaultValue = "v1") String version) {
    if ("v2".equals(version)) {
        return ResponseEntity.ok(orderServiceV2.getOrders());
    }
    return ResponseEntity.ok(orderServiceV1.getOrders());
}
```

### Strategy 3: Content Negotiation (Media Type Versioning)

```
GET /api/orders
Accept: application/vnd.mycompany.orders+json;version=2
```

**Pros:** RESTful (proper use of Accept header). 

**Cons:** Verbose and unintuitive for most developers. Not supported by all HTTP clients (especially mobile SDKs).

**Used by:** GitHub API (`application/vnd.github.v3+json`).

### Strategy 4: Query Parameter

```
GET /api/orders?version=2
```

**Pros:** Easy to test in browser.

**Cons:** Pollutes query space. Can conflict with other query params. Not standard.

### Handling Backward-Compatible Changes

Not every API change needs a new version. Changes that are backward-compatible:

1. Adding new optional fields to response (old clients ignore unknown fields).
2. Adding new optional fields to request body (service uses defaults).
3. Adding new endpoints.
4. Making previously required fields optional.

Changes that break backward compatibility (require new version):
1. Removing fields from response.
2. Changing field types (integer → string).
3. Renaming fields.
4. Changing semantics (status code behavior, pagination format).

**Tolerant reader principle:** Clients should ignore unknown fields they don't understand. Jackson in Java ignores unknown properties by default (configurable via `@JsonIgnoreProperties(ignoreUnknown = true)` or globally).

---

## 9. Database-Per-Service Pattern

### Why Each Service Gets Its Own Database

1. **Independent deployment:** Service A can upgrade its database schema without coordinating with Service B.
2. **Polyglot persistence:** Order service uses PostgreSQL (relational, ACID). Catalog service uses MongoDB (flexible documents). Analytics service uses ClickHouse (columnar). Each service picks the best tool.
3. **Isolation of failures:** Service A's database being slow doesn't affect Service B's queries.
4. **Independent scaling:** Scale the database independently based on the service's load.

### The Join Problem

In a monolith, joining the `orders` table with the `users` table is trivial (both in same DB). In microservices, Order Service and User Service have separate databases.

**Solution 1: API Composition (synchronous join)**
```java
// Order Service: join at the application layer
public List<OrderWithUserInfo> getOrdersWithUsers() {
    List<Order> orders = orderRepo.findAll();
    Set<String> userIds = orders.stream()
        .map(Order::getUserId).collect(toSet());

    // Batch call to User Service
    Map<String, UserInfo> users = userServiceClient
        .getUsersByIds(userIds);  // one HTTP call with all IDs

    return orders.stream()
        .map(o -> new OrderWithUserInfo(o, users.get(o.getUserId())))
        .collect(toList());
}
```

**Solution 2: CQRS Read Model (denormalized materialized view)**
```
OrderCreated event → [Projection service] → Denormalized DB
                                             (order + user info, pre-joined)
UserUpdated event  →                       → Update relevant order projections
```

**Solution 3: Data lake / OLAP (for analytics/reporting)**
All services stream their data to a data lake (Kafka → S3/BigQuery/Snowflake). Joins happen there at analytics time, not in production services.

### Data Ownership and Cross-Service Queries

**Principle:** Only the owning service can write to its database. Other services must go through the owning service's API to read or write.

```
❌ WRONG:
Order Service → SELECT * FROM users.users WHERE id = 'u1'
              (Order Service directly queries User Service's database)

✓ CORRECT:
Order Service → GET /users/u1  (API call to User Service)
Order Service → consume UserUpdated events from Kafka
```

**Event-driven denormalization:**
```java
// User Service publishes events on change
@Service
public class UserService {
    public User updateEmail(String userId, String newEmail) {
        User user = userRepo.findById(userId);
        user.setEmail(newEmail);
        userRepo.save(user);
        eventBus.publish(new UserUpdatedEvent(userId, newEmail, user.getName()));
        return user;
    }
}

// Order Service maintains its own copy of relevant user data
@KafkaListener(topics = "user.updated")
public void onUserUpdated(UserUpdatedEvent event) {
    // Update our local denormalized copy
    orderUserCache.updateEmail(event.getUserId(), event.getNewEmail());
}
```

---

## 10. Strangler Fig Pattern

### Migrating from Monolith to Microservices

Martin Fowler named this after the strangler fig tree, which grows around a host tree until it completely replaces it.

```
Phase 1: Monolith handles everything
[Client] → [Monolith] → Database

Phase 2: Route one functionality to new service via a facade
[Client] → [Strangler Facade/Proxy] → [Monolith]            (most features)
                                    → [New Microservice]    (extracted feature)

Phase 3: Extract more services
[Client] → [API Gateway] → [Service A]  (fully extracted)
                         → [Service B]  (fully extracted)
                         → [Monolith]   (remaining legacy)

Phase 4: All extracted, monolith retired
[Client] → [API Gateway] → [Service A]
                         → [Service B]
                         → [Service C]
```

### Practical Migration Steps

**Step 1: Identify the extraction candidate**

Pick a bounded context that is:
- Well-defined (clear inputs/outputs)
- Low coupling with the rest of the monolith
- A pain point (the team maintaining it is separate, or it needs its own scaling)

**Step 2: Add the facade (routing layer)**

Deploy a proxy in front of the monolith. Initially, everything goes to the monolith.

```java
// Strangler facade
@RestController
public class OrderStranglerController {
    private final MonolithClient monolith;
    private final NewOrderService newOrderService;
    private final FeatureFlags flags;

    @PostMapping("/orders")
    public ResponseEntity<Order> createOrder(@RequestBody CreateOrderRequest req) {
        if (flags.isEnabled("new-order-service")) {
            return newOrderService.create(req);
        }
        return monolith.post("/orders", req);
    }
}
```

**Step 3: Build and deploy the new service in parallel**

New service runs alongside. The facade routes a small % of traffic (canary) to the new service. Observe. If no issues, increase %.

**Step 4: Migrate the database**

The hardest part. Options:
- **Dual-write:** Write to both old DB and new DB. Read from new DB. When satisfied, stop writing to old.
- **Change Data Capture (CDC):** Debezium reads the monolith's binlog and publishes changes to Kafka. New service consumes and maintains its own copy.
- **Database view:** New service reads from a view/schema in the same DB (transitional, not final).

**Step 5: Retire the monolith code for this feature**

Once new service is stable and monolith is no longer used for this feature, remove the monolith code path.

**Netflix's experience:**
Netflix began migrating from their monolith to AWS/microservices in 2009. It took **7 years** to fully decommission the last monolith datacenter. The strangler fig approach allowed continuous service during the migration.

---

## 11. Event-Driven Architecture

### Event Types (Don't Mix These Up)

**Event-Carried State Transfer:**
Event contains enough data for consumers to process without making API calls.

```json
// Fat event — carries all relevant state
{
  "type": "OrderShipped",
  "orderId": "ord-123",
  "userId": "usr-456",
  "items": [...],
  "trackingNumber": "UPS-789",
  "shippedAt": "2024-05-01T10:00:00Z",
  "userEmail": "alice@example.com",   // denormalized — consumer doesn't need to call User Service
  "userName": "Alice"
}
```

**Thin event (event notification):**
Event just says "something happened." Consumer must call back to get details.

```json
// Thin event — just a notification
{
  "type": "OrderShipped",
  "orderId": "ord-123"
}
```

Consumer receives thin event → calls `GET /orders/ord-123` → gets details.

**Tradeoff:**
- Fat events: Consumer can process independently. But payload is larger, and if data changes after the event was published, the event has stale data.
- Thin events: Small payload, always-current data on callback. But creates a synchronous coupling between consumer and producer's API. Consumer must handle the producer being temporarily unavailable.

**Domain Events:**
A domain event captures something meaningful that happened in your business domain.

```java
// Not a "technical" event — it expresses business meaning
public record OrderConfirmed(
    String orderId,
    String customerId,
    List<OrderItem> items,
    Money total,
    Instant confirmedAt
) implements DomainEvent {}

// Technical events describe system changes, not business events
// "inserted into orders table" is NOT a domain event
// "OrderConfirmed" IS a domain event
```

**Event Sourcing** uses domain events as the source of truth (covered in file 02).

---

## 12. Idempotent Consumer Pattern

### The Duplicate Message Problem

Message brokers like Kafka and SQS guarantee **at-least-once delivery**. During failures, messages can be redelivered:

```
Producer → Kafka topic

Consumer reads message, processes it, commits Kafka offset.
Between "process" and "commit offset":
  - Consumer crashes
  - Consumer restarts
  - Consumer re-reads the message (offset not committed)
  - Message processed TWICE

Result: order created twice, payment charged twice, email sent twice.
```

**Exactly-once** semantics exist in Kafka (via transactions) but require end-to-end support and are complex to implement correctly.

**Practical approach:** Accept at-least-once, make consumers idempotent.

### Implementation: Deduplication Table

```java
@Service
public class OrderEventConsumer {
    private final OrderRepository orderRepo;
    private final DeduplicationRepository dedupRepo;

    @KafkaListener(topics = "payment.processed")
    @Transactional
    public void handlePaymentProcessed(
            ConsumerRecord<String, PaymentProcessedEvent> record) {

        String messageId = record.headers().lastHeader("message-id")
            .map(h -> new String(h.value())).orElse(record.topic() +
                "-" + record.partition() + "-" + record.offset());

        // Check if we've already processed this message
        if (dedupRepo.existsByMessageId(messageId)) {
            log.info("Duplicate message {} — skipping", messageId);
            return;  // idempotent: already processed
        }

        // Process
        PaymentProcessedEvent event = record.value();
        orderRepo.updateStatus(event.getOrderId(), OrderStatus.PAID);

        // Mark as processed (in same transaction)
        dedupRepo.save(new DeduplicationRecord(messageId, Instant.now()));
    }
}
```

**DeduplicationRecord schema:**
```sql
CREATE TABLE processed_messages (
    message_id  VARCHAR(255) PRIMARY KEY,
    processed_at TIMESTAMP NOT NULL
);

-- Cleanup old entries (processed > 7 days ago)
DELETE FROM processed_messages WHERE processed_at < NOW() - INTERVAL '7 days';
```

**Key requirement:** The deduplication check and business logic must be in the **same transaction**. Otherwise:
```
Thread 1: check → not found (gap) → crash before saving dedup record
Thread 2: check → not found → processes → saves dedup record
Thread 1 restarts → check → not found AGAIN → processes AGAIN (duplicate!)
```

### Kafka Idempotent Producer

On the producer side, Kafka supports idempotent delivery to prevent duplicates due to producer retries:

```java
Properties props = new Properties();
props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
// Automatically sets:
// acks = all (wait for all ISR acknowledgment)
// retries = Integer.MAX_VALUE
// max.in.flight.requests.per.connection = 5

// Each message gets a sequence number.
// Kafka broker deduplicates retransmitted messages using (producerId, sequenceNumber).
```

**Kafka transactions (exactly-once semantics):**
```java
producer.initTransactions();
try {
    producer.beginTransaction();
    producer.send(new ProducerRecord<>("output-topic", key, value));
    // Commit Kafka offset within the same transaction:
    producer.sendOffsetsToTransaction(offsets, consumerGroupId);
    producer.commitTransaction();
} catch (Exception e) {
    producer.abortTransaction();
}
```

This atomically commits the output message AND the input offset — so if the consumer crashes after processing but before committing the offset, it re-reads and re-processes, but the transactional producer will produce a duplicate that Kafka's broker deduplicates using the sequence number.

**Limitation:** Transactional Kafka only works when both producer and consumer use Kafka. If the consumer writes to a database, the two-phase commit problem reappears. The deduplication table approach is more universally applicable.

---

## Architecture Summary: Putting It All Together

```
                         ┌──────────────────────────────────────┐
                         │        External Clients               │
                         │  Mobile App | Web App | 3rd Party    │
                         └─────────────┬────────────────────────┘
                                       │ HTTPS
                                       ▼
                         ┌──────────────────────────────────────┐
                         │           API Gateway                  │
                         │  Auth | Rate Limit | Route | Aggregate│
                         └───────────────┬──────────────────────┘
                                         │ Internal (mTLS via service mesh)
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                           │
    ┌─────────▼──────────┐   ┌──────────▼──────────┐  ┌────────────▼──────────┐
    │   Order Service    │   │   Payment Service   │  │  Notification Service │
    │  (REST / gRPC)     │   │  (REST / gRPC)      │  │  (Kafka consumer)     │
    │   PostgreSQL       │   │   PostgreSQL         │  │   Cassandra           │
    └─────────┬──────────┘   └──────────┬──────────┘  └───────────────────────┘
              │                          │
              └─────────────┬────────────┘
                            │ Publishes domain events
                            ▼
                     ┌──────────────┐
                     │    Kafka     │
                     │  (event bus) │
                     └──────────────┘
                            │ Consumed by
              ┌─────────────┼────────────────────┐
              │             │                    │
    ┌─────────▼────┐  ┌─────▼──────────┐  ┌─────▼──────────────┐
    │  Analytics   │  │  Search Index  │  │  Notification Svc  │
    │  (Flink)     │  │  (Elasticsearch│  │  (FCM/SES/Twilio)  │
    └──────────────┘  └────────────────┘  └────────────────────┘

Observability layer (cross-cutting):
  - Distributed tracing: OpenTelemetry → Jaeger
  - Metrics: Micrometer → Prometheus → Grafana
  - Logs: Logback → Fluentd → Elasticsearch → Kibana (ELK)
  - Alerts: Alertmanager → PagerDuty
```

---

## Interview Cheat Sheet

| Question | Key Points |
|----------|-----------|
| How to find service boundaries? | DDD bounded contexts, Conway's Law, business capability mapping |
| REST vs gRPC for internal services? | gRPC for performance (4x smaller, multiplexing, streaming), REST for public APIs |
| How does service discovery work in K8s? | K8s Service + ClusterIP + kube-proxy iptables; DNS resolves to ClusterIP |
| How to maintain consistency across services without 2PC? | Saga pattern (choreography/orchestration), TCC for ACID-like semantics |
| How to trace a request across 5 services? | OpenTelemetry, W3C traceparent header, Jaeger for storage and visualization |
| How to version APIs without breaking clients? | URL versioning for major breaks; backward-compatible changes need no versioning; tolerant reader |
| How to migrate from monolith? | Strangler fig: facade → parallel run → traffic shift → retire monolith code |
| How to handle duplicate Kafka messages? | Deduplication table (message_id → processed_at), in same transaction as business logic |
| What's the BFF pattern? | Separate gateways per frontend type (mobile BFF, web BFF, public API), each optimized for its client |

---

Sources consulted:
- [gRPC Core Concepts](https://grpc.io/docs/what-is-grpc/core-concepts/)
- [gRPC on HTTP/2](https://grpc.io/blog/grpc-on-http2/)
- [Saga Pattern - Temporal.io](https://temporal.io/blog/mastering-saga-patterns-for-distributed-transactions-in-microservices)
- [Saga Choreography - AWS](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-choreography.html)
- [CQRS + Event Sourcing - Confluent](https://developer.confluent.io/courses/event-sourcing/cqrs/)
- [Consistent Hashing - HelloInterview](https://www.hellointerview.com/learn/system-design/core-concepts/consistent-hashing)
