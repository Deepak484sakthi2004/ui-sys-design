# RabbitMQ, ActiveMQ, SQS/SNS, EventBridge — Deep Technical Reference

> Target: Senior Java/JVM engineer, 40 LPA system design interviews.
> Focus: Protocol internals, queue types, failure modes, AWS messaging.

---

## 1. RabbitMQ: AMQP and the Exchange Model

### 1.1 AMQP 0-9-1 Protocol

RabbitMQ implements AMQP 0-9-1 (Advanced Message Queuing Protocol). Unlike Kafka (custom binary protocol) or JMS (API spec, not wire protocol), AMQP is a **wire-level protocol** — any language with an AMQP client can talk to RabbitMQ.

```
AMQP Connection model:
  Connection (TCP)
    └── Channel (multiplexed logical connection)
            └── Operations: declare exchange, declare queue, bind, publish, consume

Why channels? TCP connection setup is expensive. AMQP multiplexes many logical
streams over one TCP connection. Each channel has its own state.
```

Key AMQP concepts:
- **Exchange**: receives messages from producers, routes to queues via bindings
- **Queue**: buffer that stores messages
- **Binding**: rule that connects an exchange to a queue with an optional routing key
- **Consumer**: registered on a queue via `basicConsume()`

### 1.2 Exchange Types

#### Direct Exchange
```
Exchange: "payment_direct" (type=direct)
Bindings:
  "payment_direct" --routingKey="payment.success"--> queue "success_queue"
  "payment_direct" --routingKey="payment.failure"--> queue "failure_queue"

Producer: publish(exchange="payment_direct", routingKey="payment.success")
→ Message delivered to "success_queue" only

Use when: 1:1 routing based on exact routing key match
```

#### Topic Exchange
```
Exchange: "events" (type=topic)
Bindings:
  "events" --routingKey="payment.#"    --> queue "payment_all"    (# = zero or more words)
  "events" --routingKey="*.success"    --> queue "all_successes"  (* = exactly one word)
  "events" --routingKey="payment.*"    --> queue "payment_direct"

Producer: publish(exchange="events", routingKey="payment.success")
→ Matches: "payment.#" AND "*.success" AND "payment.*"
→ Delivered to ALL three queues (fan-out to matching)

Use when: complex routing with wildcard patterns (most flexible, most common in practice)
```

#### Fanout Exchange
```
Exchange: "notifications" (type=fanout)
Bindings:
  "notifications" --> queue "mobile_push"
  "notifications" --> queue "email_queue"
  "notifications" --> queue "sms_queue"

Producer: publish(exchange="notifications", routingKey="ignored")
→ Message copied to ALL bound queues, routing key IGNORED

Use when: broadcast patterns (event notification to multiple systems)
```

#### Headers Exchange
```
Exchange: "reporting" (type=headers)
Bindings:
  "reporting" --headers={format=pdf, type=report, x-match=all}--> queue "pdf_reports"
  "reporting" --headers={type=invoice, x-match=any}            --> queue "invoices"

Producer: publish(exchange="reporting", headers={format=pdf, type=report, dept=finance})
→ Matches pdf_reports (x-match=all: all headers must match)
→ Matches invoices (x-match=any: at least one header matches)

Use when: complex content-based routing on message attributes (rare, slower than topic)
```

### 1.3 Dead Letter Exchanges (DLX)

```
Queue configuration:
  x-dead-letter-exchange: "dlx"
  x-dead-letter-routing-key: "original.queue.failed"

Message becomes "dead" when:
  1. Rejected with requeue=false: channel.basicReject(deliveryTag, false)
  2. Nacked with requeue=false:   channel.basicNack(deliveryTag, false, false)
  3. TTL expires (message TTL or queue TTL)
  4. Queue length limit exceeded (x-max-length policy)

Dead message routed to: dlx exchange → dead letter queue
Dead letter queue retains: original routing key, original exchange, death reason, death count

Pattern: retry with backoff using multiple DLX queues:
  main_queue (TTL=5s) → dlx1 → retry_q1 (TTL=30s) → dlx2 → retry_q2 (TTL=5min) → dlx3 → dead_letter_final
```

### 1.4 Message TTL and Priority Queues

**Per-message TTL**: `expiration` property in AMQP message (milliseconds as string). Message discarded/DLX-routed when TTL expires in queue.

**Per-queue TTL**: `x-message-ttl` queue argument. Applies to all messages in queue.

**Priority Queues**:
```
Queue with x-max-priority=10 (0-10, higher = more priority)
Producer sets message.priority = 8

Internally: RabbitMQ maintains N priority sub-queues per priority queue.
            Consumers always served highest-priority message first.
            
Performance: Priority queues are slower than regular queues (N sub-queues,
             requires priority comparison on dequeue). Use sparingly.
             Max practical priority levels: 3-5.
```

---

## 2. RabbitMQ Internals: Erlang Process Model

### 2.1 Why Erlang?

RabbitMQ is written in Erlang. This is NOT incidental:
- Erlang processes = lightweight (2KB stack initially, grows as needed), millions per node
- Erlang OTP: supervision trees, automatic process restart on failure
- Erlang message passing: native actor model, no shared memory, no locks
- Erlang scheduler: preemptive, runs on N OS threads (one per CPU core), M:N green threads

### 2.2 Queue as an Erlang Process

Each classic queue is implemented as an Erlang process (or process group for mirrored):

```
RabbitMQ internal representation of a queue:
  - One Erlang process = one queue coordinator
  - Process state: message store references, consumer list, unacked set
  - Messages:
    * In memory: as Erlang terms (deserialized, fast access)
    * On disk: via Mnesia/message store files
  
Implication: A RabbitMQ node with 10,000 queues has 10,000+ Erlang processes.
             Erlang handles this fine (processes are cheap).
             BUT: each queue is serialized through ONE process → single-threaded per queue.
             High-throughput single queues become bottlenecks.
```

### 2.3 Message Persistence Mechanics

For a message to survive broker restart, BOTH must be true:
1. Queue is **durable** (`durable=true` when declaring)
2. Message is **persistent** (`delivery_mode=2` in AMQP properties)

```
Non-durable queue: lives in RAM only. Survives consumer disconnect, lost on broker restart.
Durable queue with transient message: queue survives restart, messages don't.
Durable queue with persistent message: both survive restart.

Persistence implementation (Classic queues):
  1. Message written to message store journal file (append-only, like WAL)
  2. message_store_index tracks msgId → file+offset
  3. Queue process records msgId in its persistent state (saved to Mnesia)
  4. On restart: read Mnesia state → replay journal → queue is restored

Performance penalty: fsync per message (or batch fsync with async confirmations)
→ This is why persistent messages require publisher confirms to be meaningful
```

### 2.4 Publisher Confirms

```java
channel.confirmSelect(); // enable publisher confirms
channel.basicPublish(exchange, routingKey, props, body);
if (!channel.waitForConfirms(5000)) {
    // message not confirmed → retry
}
```

Without confirms: at-most-once (message in broker TCP buffer = could be lost).
With confirms: at-least-once (broker confirms after writing to durable storage).
For exactly-once: use idempotent consumers (deduplicate on consumer side).

---

## 3. Classic Mirrored Queues (Deprecated) vs Quorum Queues

### 3.1 Classic Mirrored Queues — Why They Failed

```
Architecture:
  One master queue process + N mirror processes (one per HA mirror node)
  Synchronization: master sends all publishes to mirrors, waits for mirrors to ack

Problems:
  1. Split-brain: network partition → both master and mirror think they're master
     → Messages written to both, inconsistency when partition heals
  2. "Shoveling" on join: new mirror must copy all existing messages from master
     → Massive I/O spike, stalls entire queue
  3. Non-deterministic ordering: mirrors sometimes got out of sync, re-ordered on failover
  4. Publisher confirm timing: unclear when confirms were safe (before or after mirrors acked?)

Classic mirrored queues deprecated in RabbitMQ 3.9, REMOVED in RabbitMQ 4.0.
```

### 3.2 Quorum Queues — Raft-Based

```
Architecture:
  Uses Raft consensus protocol
  Quorum queue has: 1 leader + N-1 followers (default: 3 total = 1 leader + 2 followers)
  
Raft guarantees:
  - Writes are committed only when majority (quorum) acknowledge
  - Leader election: candidate must have majority vote
  - Log entries: sequentially numbered, term-based (like Kafka's leader epoch)
  
Write path:
  1. Producer sends to leader
  2. Leader appends to its Raft log
  3. Leader sends AppendEntries to followers
  4. When majority ACK (≥ 2 of 3 total): entry committed
  5. Leader sends publisher confirm to producer
  6. Leader delivers to consumer
  
Failure handling (e.g., leader crashes with 3-node quorum):
  1. Followers detect leader timeout (election timeout: 5s default)
  2. Follower increments term, sends RequestVote to peers
  3. Peer grants vote if: (a) at least as up-to-date log, (b) hasn't voted this term
  4. New leader elected, resumes from last committed Raft index
  → No data loss: only committed entries (majority-acked) survive
  → Uncommitted entries (written to leader but not yet majority-acked) are rolled back
```

### 3.3 Quorum Queue Internals

```
Storage: Raft log stored in separate WAL files on each Raft member node
         Format: sequence of log entries, each entry = {term, index, payload}
         
Consumer delivery:
  - Leader tracks which consumers are registered
  - Maintains per-consumer "credit" counter (flow control)
  - Dead message tracking: per-message delivery count (x-delivery-count header)
  
In-memory state:
  - RAM: inflight messages + consumer credit state
  - Disk: Raft WAL (persistent)
  
Key behavior differences from classic queues:
  - No manual consumer priority
  - No lazy mode (always uses disk-backed Raft log)
  - Max in-memory size: x-max-in-memory-length, x-max-in-memory-bytes
    (older messages paged to disk automatically)
  - Poison message handling: x-delivery-limit (max redeliveries before DLX)
```

### 3.4 Quorum Queues vs Classic: Performance

| Aspect | Classic Queue | Quorum Queue |
|--------|--------------|--------------|
| Single-node throughput | Highest | ~80% of classic |
| HA throughput | Lower (synchronous replication) | Higher (pipelined Raft) |
| Durability | Optional (must configure) | Always durable |
| Ordering | FIFO (single-threaded per queue) | FIFO |
| Max redelivery | Manual DLX setup | Built-in x-delivery-limit |
| Memory management | Manual (set vm_memory_high_watermark) | Automatic paging |
| Network partition safety | Unsafe (split-brain possible) | Safe (Raft majority required) |

**Recommendation**: Use quorum queues for ALL new production deployments. Classic queues (non-HA) are still valid for non-critical, disposable work queues.

---

## 4. ActiveMQ vs RabbitMQ vs Kafka

### 4.1 Protocol Comparison

| System | Protocol | Wire Format | Standards |
|--------|----------|-------------|-----------|
| ActiveMQ (Classic) | JMS (API), OpenWire (binary), STOMP, AMQP, MQTT | Mixed | JMS 1.1/2.0 |
| ActiveMQ Artemis | JMS 2.0, AMQP 1.0, STOMP, MQTT, OpenWire | Binary | AMQP 1.0 |
| RabbitMQ | AMQP 0-9-1, STOMP, MQTT (plugins) | Binary | AMQP 0-9-1 |
| Kafka | Kafka Protocol (proprietary) | Binary | None (de-facto standard) |

**JMS (Java Message Service)**: API specification only, NOT a wire protocol.
- `javax.jms.MessageProducer.send()` — what it does internally depends on provider
- ActiveMQ uses OpenWire under the hood for JMS
- RabbitMQ JMS plugin wraps AMQP 0-9-1
- Kafka has no JMS support natively (spring-kafka provides JMS-like API but not actual JMS)

### 4.2 Delivery Model Comparison

```
ActiveMQ (JMS model):
  Queue (point-to-point): One message → one consumer (competing consumers)
  Topic (pub-sub): One message → all durable/non-durable subscribers
  Durable subscriber: Must be registered in advance; broker stores messages while offline
  
RabbitMQ:
  Exchange → Queue: flexible routing
  One message in queue → one consumer (competing consumers by default)
  Multiple queues bound to same exchange = fan-out (each queue gets a copy)
  
Kafka:
  Partition → Consumer Group: each partition consumed by one consumer per group
  Multiple consumer groups = fan-out (each group gets all messages independently)
  Replay: consumers can seek to any offset (messages retained for log.retention period)
  
Key difference: Kafka retains messages after consumption (log). 
                RabbitMQ/ActiveMQ delete messages after acknowledgment.
```

### 4.3 When to Use Which

```
Use RabbitMQ when:
  ✓ You need complex routing logic (topic exchanges, binding rules)
  ✓ Message TTL, priority, or DLX patterns
  ✓ Low-latency, low-throughput transactional messaging (<50k msg/s)
  ✓ AMQP ecosystem integration
  ✓ Per-message acknowledgment with requeue (not supported in Kafka natively)
  ✓ JVM + non-JVM polyglot environment

Use Kafka when:
  ✓ High throughput (millions of events/second)
  ✓ Message replay required
  ✓ Stream processing (Kafka Streams, Flink source)
  ✓ Event sourcing patterns
  ✓ Long retention (days to weeks)
  ✓ Multiple independent consumer groups

Use ActiveMQ/Artemis when:
  ✓ Existing JMS codebase (Spring JMS, MDB in Jakarta EE)
  ✓ JMS 2.0 features needed (shared subscriptions, message-driven beans)
  ✓ Protocol bridging (MQTT for IoT → JMS for enterprise apps)
  ✓ Legacy enterprise integration patterns (ESB, Camel)
```

---

## 5. AWS SQS — Internals

### 5.1 At-Least-Once: The Multi-AZ Storage Model

```
SQS Standard Queue:
  - Messages stored across MULTIPLE storage partitions in ≥ 3 AZs
  - "At-least-once": same message may be stored in multiple partitions
  - On receive: SQS returns ONE copy of the message
  - BUT: due to eventual consistency in distributed storage, rarely, 
         the same message is served twice
  → Your consumer MUST be idempotent

SQS FIFO Queue:
  - Exactly-once processing (within deduplication window)
  - Higher consistency guarantees, but lower throughput (300 TPS hard limit per queue,
    3000 TPS with batching, 10 messages per batch)
```

### 5.2 Visibility Timeout — The Core Mechanism

```
Standard receive flow:
  1. Consumer calls ReceiveMessage (long poll, up to 20s)
  2. SQS returns message(s), marks them "invisible" for visibilityTimeout seconds
  3. Consumer processes message
  4. Consumer calls DeleteMessage → message permanently deleted
  5. If consumer crashes / doesn't delete within visibilityTimeout:
     Message becomes visible again → redelivered to another consumer (or same)

Defaults: visibilityTimeout=30s (configurable 0s to 12h)

ChangeMessageVisibility: extend timeout while processing long-running tasks
  sqs.changeMessageVisibility(receiptHandle, newTimeout);
  → Heartbeat pattern for long processing jobs

Pattern for at-least-once → effectively exactly-once:
  Step 1: Receive message
  Step 2: Process message
  Step 3: If success → DeleteMessage
          If failure → let visibilityTimeout expire (automatic retry)
  + Consumer is idempotent (idempotency key in message body)
```

### 5.3 SQS FIFO: Exactly-Once and Ordering

```
FIFO Queue components:
  MessageGroupId:      Ordering domain (like Kafka partition key)
  MessageDeduplicationId: Idempotency key (5-minute deduplication window)

Write path:
  Producer sends: {MessageGroupId="user-123", MessageDeduplicationId="txn-456", body=...}
  
  SQS checks: in the last 5 minutes, was there a message with DeduplicationId="txn-456"?
    YES → silently drop, return success (no duplicate stored)
    NO  → store message in FIFO order for group "user-123"

Ordering guarantee:
  Within a MessageGroupId: strict FIFO
  Across MessageGroupIds: no ordering guarantee

Consumer behavior:
  - Receiving a message from group "user-123" LOCKS that group
  - No other messages from "user-123" returned until current message is:
    a) Deleted (processed successfully)
    b) Moved to DLQ (maxReceiveCount exceeded)
    c) visibilityTimeout expires

  → This is how FIFO achieves ordering: one-in-flight-at-a-time per group
  → Implication: one slow consumer for group "X" blocks ALL messages from group "X"

Throughput:
  300 TPS per queue without batching (hard API limit)
  3000 TPS with 10-message batching
  → Not suitable for high-throughput (Kafka >> SQS FIFO for throughput)
```

### 5.4 SQS vs RabbitMQ vs Kafka

| Aspect | SQS Standard | SQS FIFO | RabbitMQ | Kafka |
|--------|-------------|----------|----------|-------|
| Ordering | Best-effort | Per-group | Per-queue | Per-partition |
| Delivery | At-least-once | Exactly-once* | At-least-once | At-least-once (exactly-once possible) |
| Throughput | ~10k TPS/queue (soft) | 300 TPS | ~50k/s per node | Millions/s |
| Retention | Up to 14 days | Up to 14 days | Until consumed | Configurable (forever) |
| Replay | No | No | No | Yes |
| Ops complexity | Zero (managed) | Zero (managed) | Medium | High |
| Dead letter | DLQ (native) | DLQ (native) | DLX (manual) | Manual (KafkaStreams) |

---

## 6. SNS (Simple Notification Service)

### 6.1 Fan-out Pattern

```
SNS Topic (pub-sub)
  ↓ publishes to all subscriptions
  ├── SQS Queue A  (filtered by MessageFilter policy)
  ├── SQS Queue B  (unfiltered)
  ├── Lambda function
  ├── HTTP/HTTPS endpoint
  └── Email

Producer → SNS → multiple SQS queues simultaneously
→ Classic fan-out: one event published once → multiple downstream systems receive copy
```

### 6.2 Message Filtering

```json
SNS Subscription Filter Policy:
{
  "event_type": ["payment.success", "payment.failure"],
  "amount": [{"numeric": [">=", 1000]}]
}
```

- Applied at SNS level before delivery to subscriber
- Subscribers only receive matching messages
- Reduces cost (fewer SQS receives, less Lambda invocations)

### 6.3 SNS vs Kafka for Fan-out

```
SNS fan-out:
  One publish → N SQS queues (decoupled)
  Scales to millions of subscribers
  No replay capability
  AWS-managed (zero ops)

Kafka consumer groups:
  One topic → N consumer groups (each reads full log)
  Replay supported (seek to any offset)
  Schema enforcement possible
  Self-managed or Confluent Cloud

Use SNS: simple event broadcasting to multiple AWS services
Use Kafka: stream processing, event sourcing, replay, high throughput
```

---

## 7. AWS EventBridge

### 7.1 Event Bus Pattern

```
Architecture:
  Events sources:
    - AWS services (EC2 state change, S3 events, CodePipeline, etc.)
    - Custom applications (PutEvents API)
    - Partner SaaS (Zendesk, Stripe, Datadog built-in integrations)
  
  Event Bus:
    - Default bus (AWS service events)
    - Custom buses (your application events)
    - Partner buses (SaaS provider events)
  
  Rules:
    - Event pattern matching (JSONPath-based filter on event attributes)
    - OR scheduled (rate/cron)
  
  Targets (up to 5 per rule):
    - SQS, SNS, Lambda, Step Functions, Kinesis, API Gateway
    - Cross-account targets
    - HTTP endpoints (EventBridge API destinations)
```

### 7.2 Event Pattern Matching

```json
Rule pattern:
{
  "source": ["com.myapp.orders"],
  "detail-type": ["OrderPlaced"],
  "detail": {
    "amount": [{"numeric": [">", 500]}],
    "region": ["us-east-1", "eu-west-1"]
  }
}
```

- Matching is done at EventBridge level (no compute cost for non-matching events)
- Pattern can match on any field in the JSON event
- Content-based filtering: more powerful than SNS filter policies

### 7.3 EventBridge vs SNS vs SQS: When to Use

```
EventBridge:
  ✓ Event-driven architecture spanning multiple AWS services
  ✓ Content-based routing with complex filters
  ✓ SaaS integrations (native Stripe, Zendesk, etc.)
  ✓ Schema registry (EventBridge Schema Registry) + code binding generation
  ✓ Event replay (Archive + Replay feature)
  ✓ Cross-account event delivery
  
SNS:
  ✓ Simple fan-out to multiple endpoints
  ✓ Mobile push notifications (APNS, FCM, ADM, Baidu)
  ✓ Simple pub-sub with basic filtering
  ✗ No event replay
  ✗ No schema registry
  
SQS:
  ✓ Decoupling producer/consumer
  ✓ Worker queue pattern (background jobs)
  ✓ Guaranteed delivery with retry
  ✓ Consumer controls processing rate (pull-based)
  
SNS + SQS (classic pattern):
  SNS for fan-out → SQS for durability + backpressure per consumer

EventBridge + SQS (modern pattern):
  EventBridge for routing/filtering → SQS for reliable delivery
  Better when: many event types, complex routing, SaaS sources
```

### 7.4 EventBridge Pipes (new-ish feature)

Point-to-point integration: SQS/Kinesis/DynamoDB Streams → [optional Filter] → [optional Enrichment via Lambda] → Target.

Replaces the pattern of "Lambda reads from SQS, filters, writes to another service." Now serverless with no Lambda code for simple transformations.

---

## 8. RabbitMQ Quorum Queues — Java Client Example

```java
// Declare quorum queue (Java AMQP client)
Map<String, Object> args = new HashMap<>();
args.put("x-queue-type", "quorum");
args.put("x-delivery-limit", 3);  // max redeliveries before DLX

channel.queueDeclare("my-quorum-queue", 
    true,   // durable (always true for quorum)
    false,  // exclusive
    false,  // autoDelete  
    args);

// Publisher confirms for reliability
channel.confirmSelect();
channel.basicPublish("", "my-quorum-queue",
    MessageProperties.PERSISTENT_TEXT_PLAIN,
    "hello".getBytes());
if (!channel.waitForConfirms(5000)) {
    // resend
}

// Consumer with manual ack
channel.basicConsume("my-quorum-queue", false,  // autoAck=false
    (consumerTag, delivery) -> {
        try {
            process(delivery.getBody());
            channel.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
        } catch (Exception e) {
            // requeue=false → triggers DLX after x-delivery-limit
            channel.basicNack(delivery.getEnvelope().getDeliveryTag(), false, false);
        }
    },
    consumerTag -> {});
```

---

## 9. Interview Fast-Fire Q&A

**Q: RabbitMQ topic exchange vs Kafka topics — what's the naming confusion?**
A: RabbitMQ topic exchange = routing mechanism (wildcard routing key matching). It has NOTHING to do with Kafka topics. A Kafka topic is like a RabbitMQ queue in terms of being a message store. In RabbitMQ's model, you would need an exchange (for routing) + queue (for storage) + binding (to connect them) to replicate what a single Kafka topic does.

**Q: Why were classic mirrored queues removed?**
A: The homegrown synchronization algorithm was not based on a distributed consensus protocol. In network partitions, both master and mirror could accept writes independently (split-brain), leading to data loss or duplication on partition heal. Quorum queues use Raft — writes are only committed when a majority of nodes ACK, so split-brain is impossible. The price is 1 fewer write throughput than classic queues without HA.

**Q: How does SQS achieve at-least-once delivery?**
A: SQS stores message copies across multiple storage servers in ≥ 3 AZs. Reads are non-deterministic — different calls may hit different storage nodes. If one server served a message but the delete confirmation didn't propagate before another server returned the same message, you get a duplicate. The visibility timeout prevents both consumers from processing the same message simultaneously, but it doesn't prevent both servers from handing it out before the delete is fully consistent.

**Q: When would you use EventBridge over SNS?**
A: Use EventBridge when: (1) your event sources include multiple AWS services and you want a unified event bus rather than per-service SNS topics; (2) you need complex content-based routing (EventBridge patterns are richer than SNS filters); (3) you need event replay (EventBridge Archive + Replay); (4) you have SaaS event sources (Stripe, Zendesk — built-in EventBridge integration); (5) you need cross-account delivery with fine-grained control. Use SNS when: simple fan-out, mobile push notifications, or minimal latency (SNS adds no extra filtering overhead for simple use cases).

**Q: What is RabbitMQ quorum queue Raft term and why does it matter?**
A: The Raft term is a monotonically increasing integer incremented each time a leader election occurs. A candidate can only become leader if it has the highest term AND an up-to-date log. Once elected, all writes in that term are tagged with the new term number. This prevents "zombie leaders" — a previously elected leader that got partitioned from the cluster, came back, and started accepting writes. It will see the higher term from the new leader and immediately step down. This is the critical safety property Raft provides that classic mirrored queues lacked.

---

Sources:
- [RabbitMQ Quorum Queues](https://www.rabbitmq.com/docs/quorum-queues)
- [Migrating from Classic Mirrored to Quorum Queues (RabbitMQ)](https://www.rabbitmq.com/blog/2025/07/29/latest-benefits-of-rmq-and-migrating-to-qq-along-the-way)
- [SQS FIFO Queue Exactly-Once Processing (AWS Docs)](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html)
- [RabbitMQ Queue Types (CloudAMQP)](https://www.cloudamqp.com/blog/rabbitmq-queue-types.html)
- [SQS FIFO Delivery Logic (AWS Docs)](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html)
- [Quorum Queues vs Classic on Amazon MQ (AWS)](https://aws.amazon.com/blogs/compute/introducing-quorum-queues-on-amazon-mq-for-rabbitmq/)
