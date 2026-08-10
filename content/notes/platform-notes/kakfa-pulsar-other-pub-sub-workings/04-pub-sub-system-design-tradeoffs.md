# Pub/Sub System Design Tradeoffs — Interview Master Reference

> Target: Senior Java/JVM engineer, 40 LPA system design interviews.
> This is the synthesis document — ties together Kafka, Pulsar, RabbitMQ, SQS for system design.

---

## 1. The Fundamental Tradeoffs Table

```
                    ┌──────────┬──────────┬──────────┬──────────┬──────────┐
                    │ Kafka    │ Pulsar   │ RabbitMQ │ SQS Std  │ SQS FIFO │
┌───────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤
│ Peak Throughput   │ 10M+ /s  │ 2-5M /s  │ 200K /s  │ ~50K /s  │ 3K /s   │
│ p99 Latency       │ 5-50ms   │ 5-15ms   │ <1ms     │ 1-20ms   │ 1-20ms  │
│ Ordering          │ Partition│ Partition│ Per queue│ None     │ Per group│
│ Delivery          │ At-least │ At-least │ At-least │ At-least │ Exactly  │
│                   │ +EOS opt │ once     │ once     │ once     │ once     │
│ Replay            │ Yes      │ Yes      │ No       │ No       │ No      │
│ Retention (max)   │ Forever  │ Forever  │ Until ack│ 14 days  │ 14 days │
│ Message ordering  │ Offset   │ EntryId  │ FIFO/pri │ None     │ Strict  │
│ Consumer model    │ Pull     │ Push+Pull│ Push     │ Pull     │ Pull    │
│ Routing           │ Key hash │ Key hash │ Exchange │ None     │ GroupId │
│ Multi-tenancy     │ Bolt-on  │ Native   │ vhosts   │ Managed  │ Managed │
│ Ops complexity    │ High     │ Higher   │ Medium   │ Zero     │ Zero    │
└───────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
```

**Notes on throughput**: Kafka numbers assume optimal conditions (batching, lz4, SSD, large producers). Real-world: 200-500 MB/s per broker is typical. Pulsar numbers reflect BookKeeper network overhead. RabbitMQ is limited by per-queue single-process model.

---

## 2. Ordering Guarantees: A Taxonomy

### 2.1 Global Total Order (Theoretically Impossible at Scale)

For true global ordering across all messages in a distributed system, you need a single serialization point. This is equivalent to a distributed lock or a single-master database — bottleneck by definition.

```
Global total order → throughput bottleneck:
  Single partition Kafka topic: globally ordered, ~50K msg/s max
  Multi-partition Kafka topic: partition-level order, unlimited throughput

You cannot have both global order AND high throughput.
CAP theorem analog: Order vs Throughput vs Availability — pick 2.
```

### 2.2 Partition-Level Ordering (Kafka/Pulsar)

```
Kafka partitions: messages with same key → same partition → FIFO per partition
  key("user-123") → hash → partition 7 → always partition 7
  All messages for user-123 are totally ordered within partition 7
  Messages across different users may be concurrent (no cross-partition order)

This is sufficient for most use cases:
  ✓ User session events (user-scoped ordering)
  ✓ Financial transactions per account (account-scoped ordering)
  ✓ IoT sensor readings (device-scoped ordering)
  ✗ Cross-entity causality (if A → B → C across different users)
```

### 2.3 Message-Group Ordering (SQS FIFO)

```
SQS FIFO with MessageGroupId = "order-789":
  Messages for order-789 are delivered in strict order
  Processing is serial per group (one-in-flight at a time)
  
  Throughput = 300 msgs/sec / number_of_active_groups
  → With 100 groups all active: effectively 3 msgs/sec per group
  → Massive throughput bottleneck
  
Real-world use: state machine transitions, order lifecycle events (placed → confirmed → shipped)
```

### 2.4 Casual Ordering with Vector Clocks

For cross-partition/cross-service causality, encode causality in the message:
```json
{
  "event": "order.shipped",
  "orderId": "789",
  "causedBy": "event-id-123",  // the order.placed event that caused this
  "vectorClock": {"order-service": 5, "fulfillment-service": 2}
}
```
Consumer reconstructs causal order from vector clocks. Used in distributed databases (DynamoDB, Riak). Rare in typical pub/sub applications.

---

## 3. Delivery Semantics: Implementation Cost

### 3.1 At-Most-Once (Fire and Forget)

```java
// Kafka: acks=0
props.put("acks", "0");
producer.send(record);  // no retry, no confirmation

// Use when: metrics, telemetry, where loss is acceptable
// Cost: zero (just the network send)
// Failure mode: broker restart or network blip → messages silently dropped
```

### 3.2 At-Least-Once (Default for Most Systems)

```java
// Kafka: acks=all + retries + idempotent consumer
props.put("acks", "all");
props.put("retries", "Integer.MAX_VALUE");
props.put("max.in.flight.requests.per.connection", "5");

// Consumer: manual commit AFTER processing
consumer.poll(Duration.ofMillis(100)).forEach(record -> {
    process(record);            // process first
    consumer.commitSync();      // commit after (at-least-once: crash between = reprocess)
});
```

**The at-least-once guarantee chain**:
1. Producer: `acks=all` + retry on failure
2. Broker: writes to disk + replicates to ISR
3. Consumer: commits offset AFTER successful processing (not before)

If consumer crashes after processing but before commit → message reprocessed.
**Consumer must be idempotent** or use deduplication.

### 3.3 Exactly-Once: The Full Cost

Exactly-once = no duplicates + no data loss. Implementation cost is high:

```
Kafka exactly-once (E2E):
  Producer side:
    enable.idempotence=true          → PID + sequence number dedup per session
    transactional.id="producer-1"   → persistent PID across restarts
    transaction.timeout.ms=10000    → max transaction duration

  Consumer-Transform-Producer:
    producer.beginTransaction()
    records = consumer.poll()
    for (record : records) {
        transformed = transform(record)
        producer.send(transformed)
    }
    producer.sendOffsetsToTransaction(offsets, consumerGroupMetadata)
    producer.commitTransaction()
    → Atomic: either all output + offset commit happens, or none
  
  Consumer (reading results):
    isolation.level=read_committed
    → reads only past LSO (no uncommitted transactional data)
  
  Overhead:
    - 2PC per transaction (adds ~1-2ms latency per transaction batch)
    - Transaction coordinator write to __transaction_state
    - LSO tracking blocks reads when transactions are open
    - Best practice: batch many records per transaction (not one transaction per record)
```

**Practically exactly-once** (idempotent consumers) is often cheaper:

```java
// Consumer with idempotency key
consumer.poll(Duration.ofMillis(100)).forEach(record -> {
    String idempotencyKey = record.key() + "-" + record.offset();
    if (!processedKeys.containsKey(idempotencyKey)) {  // Redis/DB check
        process(record);
        processedKeys.put(idempotencyKey, true);
    }
    consumer.commitSync();
});
// Cost: one extra DB lookup per message
// Works with any messaging system (not just Kafka)
```

---

## 4. Backpressure Patterns

### 4.1 Kafka Producer Backpressure

```
Flow:
  Application → RecordAccumulator (32MB pool, DirectByteBuffer)
  
  When pool full (all batches awaiting send):
    producer.send() blocks for max.block.ms (default 60s)
    After max.block.ms: throws TimeoutException
  
  Upstream impact: application thread blocked → natural backpressure
  
  Correct pattern:
    Use async sends with callback-based flow control
    OR use Reactor/RxJava with backpressure-aware Kafka publisher (reactor-kafka)
```

### 4.2 Kafka Consumer Lag Management

```
Consumer lag = producer_offset - consumer_committed_offset

Lag is NORMAL during burst processing. Becomes a problem when:
  1. Lag grows unboundedly (consumer never catches up)
  2. Lag triggers alert → scaling required

Horizontal scaling: add consumers (up to partition_count)
  If consumer_count < partition_count: add consumer
  If consumer_count = partition_count: can't scale (add partitions, but costly)

Vertical: increase fetch.min.bytes, increase batch processing

Lag spike patterns:
  - Sudden spike: GC pause, slow downstream call
  - Gradual growth: insufficient consumer instances
  - Step function: new code deployed with slow processing logic
```

### 4.3 RabbitMQ Credit-Based Flow Control

```
RabbitMQ uses credit-based flow control at multiple levels:

Channel-level: consumer sends "credits" to broker (basic.qos prefetch_count)
  channel.basicQos(10);  // only 10 unacked messages at a time per consumer
  If all 10 slots occupied: broker stops pushing messages to this consumer
  → Back pressure via inflight limit

Per-connection: memory/disk thresholds
  vm_memory_high_watermark (default 40% of RAM)
  → When exceeded: ALL publishing connections blocked (TCP-level flow control)
  → Producers receive "connection.blocked" frame
  
Implication: a slow consumer CAN block producers if memory fills
→ Configure x-max-length or x-max-length-bytes on queues to prevent unbounded growth
→ Use lazy queues (or quorum queues) for large queues to keep them on disk
```

### 4.4 Pulsar Backpressure

```
Producer-side:
  pendingQueueSize (default 1000): max outstanding unacked sends
  If full: producer.sendAsync() blocks OR throws ProducerQueueIsFullError
  
Broker-side:
  Per-topic resource groups with rate limiting (namespace policy)
  publishRateInMsgs, publishRateInBytes
  → Exceeded: producer receives error, must back off
  
Consumer-side:
  receiverQueueSize (default 1000): messages prefetched by broker to consumer
  → Smaller queue: less memory, more broker-consumer round trips
  → Larger queue: higher throughput, more memory
  
  Partitioned topic consumer: receiverQueueSize × numPartitions messages prefetched
  → For 100 partitions × 1000 queue size = 100K messages in flight
  → Memory consideration: adjust receiverQueueSize for partitioned topics
```

---

## 5. Schema Evolution Strategies

### 5.1 Compatibility Modes

```
BACKWARD (consumer can read old + new schema):
  Producer upgraded first, then consumers.
  New fields must have defaults.
  Old consumers reading new data: ignore new fields, use defaults for removed fields.
  
  Avro example: add field with default
    v1: {name: "user", fields: [{name: "id", type: "string"}]}
    v2: {name: "user", fields: [{name: "id", type: "string"},
                                 {name: "email", type: "string", default: ""}]}
  v1 consumer reading v2 data: ignores "email" field → OK

FORWARD (producer can read old + new schema):
  Consumer upgraded first, then producers.
  New fields must have defaults.
  New consumers reading old data: use default for missing fields.

FULL (both backward AND forward):
  Both old and new consumers/producers interoperate.
  Only additive changes allowed (add field with default).
  Never remove fields, never change field types.
  Most restrictive, safest for long-term evolution.

BREAKING (neither backward nor forward):
  Rename field, change type (int → string), remove field without default.
  Requires topic migration or consumer version negotiation.
```

### 5.2 Avro vs Protobuf vs JSON Schema

| Aspect | Avro | Protobuf | JSON Schema |
|--------|------|----------|-------------|
| Binary format | Yes (compact) | Yes (compact) | No (text) |
| Schema in payload | Only schema ID | Only field tags | No (schema separate) |
| Schema evolution | Excellent (defaults required) | Good (optional fields) | Basic |
| Code generation | Yes (avrogen) | Yes (protoc) | Limited |
| Schema fingerprint | Yes (Rabin/SHA fingerprint) | Yes (file descriptor hash) | Manual |
| Language support | JVM-first, others good | All major languages | All |
| Null handling | Nullable union type | Proto3: optional | nullable |
| JVM performance | Fast (generated classes or reflection) | Fastest (zero-copy decode) | Slowest |
| Kafka SR format | `[0x00][4-byte schema ID][avro bytes]` | `[0x00][4-byte schema ID][proto bytes]` | `[0x00][4-byte schema ID][json bytes]` |

**Interview answer for "Avro vs Protobuf"**:
- Use Avro for Kafka/Pulsar in a JVM-heavy ecosystem with Schema Registry — excellent backward/forward compatibility, compact binary, native Confluent SR support.
- Use Protobuf for gRPC services + event streaming — better cross-language support, slightly faster deserialization, explicit field tags survive schema evolution naturally (no defaults required for forward compat).
- Avoid JSON Schema for high-throughput messaging (3-5x larger payload, slower parsing).

### 5.3 Schema Migration Patterns

**Double-write pattern** (zero downtime):
```
Step 1: Deploy new consumer that handles both v1 and v2
Step 2: Deploy new producer writing v2 (old producer still writing v1)
Step 3: Once all v1 data consumed or expired: decommission v1 producer
Step 4: Simplify consumer to v2 only
```

**Topic migration pattern** (clean break):
```
Old topic: orders-v1 (Avro v1)
New topic:  orders-v2 (Avro v2)

Transition period:
  New producer → orders-v2
  Old producer → orders-v1 (until deprecated)
  
  Dual consumer reads both:
    orders-v1 consumer: translate v1 → canonical model
    orders-v2 consumer: translate v2 → canonical model
  
After transition: decommission orders-v1
```

---

## 6. Consumer Lag Monitoring

### 6.1 Key Metrics for Kafka

```
Per consumer group, per partition:
  consumer_lag = log_end_offset - committed_offset
  
Critical metrics:
  1. records-lag-max:         max lag across all partitions in group
  2. records-consumed-rate:   messages/sec being processed
  3. commit-latency-avg:      time to commit offsets
  4. join-time-avg:           time spent in rebalance
  5. sync-time-avg:           time in sync phase
  
Producer metrics (broker-side):
  6. under-replicated-partitions: non-zero → ISR issue, affects producer ACKs
  7. isr-shrinks-per-sec:        high → follower liveness issues
  8. active-controller-count:    must be exactly 1
  
JVM metrics (broker):
  9. jvm.gc.pause:            G1GC/ZGC pause times
  10. jvm.memory.pool.heap.used: heap pressure
  11. kafka.network.processor.avg.idle.percent: < 30% → network saturation
```

### 6.2 LSO Lag (the Hidden Lag)

```
Standard consumer group lag = HWM - committed_offset
BUT with transactions:
  LSO lag = HWM - LSO (often more important)
  Consumer lag relative to LSO = LSO - committed_offset
  
  Metric: kafka_consumer_fetch_manager_metrics_records_lag{group=...}
  vs
  kafka_server_BrokerTopicMetrics_LogStartOffset
  
Open transactions that don't commit or abort will:
  → Freeze LSO
  → Starve read_committed consumers
  → Cause consumer lag to grow even when no real backlog
  
Alert on: LSO frozen for > transaction.timeout.ms (default 1 minute)
```

### 6.3 Monitoring Tools

- **Burrow** (LinkedIn): Kafka consumer lag monitoring as a service — evaluates trend (growing, steady, catching up) rather than just absolute lag value
- **Kafka JMX metrics**: native, accessible via JMX/JMX Exporter → Prometheus
- **Confluent Control Center**: commercial, full observability stack
- **AWS MSK CloudWatch metrics**: `SumOffsetLag`, `EstimatedTimeLag`
- **kcat** (formerly kafkacat): CLI for quick lag inspection

```bash
# Quick lag check via kafka CLI:
kafka-consumer-groups.sh --bootstrap-server broker:9092 \
  --describe --group my-consumer-group
# Output: TOPIC, PARTITION, CURRENT-OFFSET, LOG-END-OFFSET, LAG, CONSUMER-ID, HOST
```

---

## 7. Kafka Streams vs Flink vs Spark Streaming

### 7.1 Mental Model

```
Kafka Streams:
  - LIBRARY (not a cluster)
  - Runs inside your JVM application process
  - State: local RocksDB + Kafka changelog topics
  - Scale: run more instances of your app
  - Exactly-once: end-to-end (Kafka → KS → Kafka)
  - Best for: simple-to-medium stateful transformations within Kafka ecosystem

Apache Flink:
  - CLUSTER (separate deployment)
  - True streaming (event-at-a-time, not micro-batch)
  - State: RocksDB/heap + periodic checkpoints to S3/HDFS
  - Exactly-once: source → processing → sink (configurable)
  - Best for: complex stateful processing, CEP (complex event processing),
             low-latency aggregations, multi-source joins

Spark Streaming (Structured Streaming):
  - CLUSTER (separate deployment)
  - Micro-batch (trigger intervals: 0ms continuous, 1s, 1m, etc.)
  - State: RDD/Dataset checkpoints
  - Exactly-once: source → Spark → sink (requires idempotent sinks)
  - Best for: teams already on Spark, batch/stream unification, ML feature engineering
```

### 7.2 Decision Framework

```
Q: Is your source and sink both Kafka?
   YES → Consider Kafka Streams (simplest ops)
   NO  → Flink or Spark

Q: Do you need sub-second latency?
   YES → Flink (true streaming) > Kafka Streams > Spark Streaming
   NO  → Spark Structured Streaming may be simpler for your team

Q: Do you need complex event patterns (CEP)?
   YES → Flink (FlinkCEP library) — no comparison here
   NO  → Any of the above

Q: Do you already have a Spark cluster?
   YES → Use Spark Structured Streaming (reuse infrastructure)
   NO  → Don't spin up Spark just for streaming

Q: Team size and ops capacity?
   Small team → Kafka Streams (no extra cluster, deploys with your app)
   Platform team → Flink (richer features, dedicated cluster managed by platform)

Q: Stateful processing complexity?
   Simple (windowed counts, joins):   Kafka Streams or Flink
   Complex (iterative algorithms, graph processing): Flink only

Q: Do you need to join multiple non-Kafka sources?
   YES → Flink (connectors: Kafka, Kinesis, Pulsar, Iceberg, JDBC, ...)
   NO  → Kafka Streams (Kafka-only)
```

### 7.3 State Backend Comparison

```
Kafka Streams (RocksDB):
  Local RocksDB on each instance (disk-backed)
  Backed up to Kafka changelog topic (compacted)
  On restart: restore from changelog topic (can be slow for large state)
  Mitigation: standby replicas (num.standby.replicas) — warm replicas
  
Flink (RocksDB + incremental checkpoints):
  Local RocksDB, incrementally checkpointed to distributed storage
  Checkpoint = diff since last checkpoint (efficient for large state)
  On restart: restore from checkpoint (typically <30s for GB-scale state)
  Exactly-once: Flink barriers (like watermarks but for checkpoints)
  
Spark (in-memory or HDFS):
  Stateful operations: updateStateByKey/mapWithState
  In-memory state per micro-batch
  Checkpoint to HDFS/S3 for recovery
  Less suitable for very large state (memory bound)
```

---

## 8. Common System Design Patterns

### 8.1 Outbox Pattern (Database + Kafka)

```
Problem: Write to DB AND publish to Kafka atomically.
         DB commit can succeed while Kafka publish fails (or vice versa).

Solution: Transactional Outbox

Step 1: In the same DB transaction:
  INSERT INTO orders (id, data, status) VALUES (...)
  INSERT INTO outbox (id, topic, key, payload, created_at) VALUES (...)
  COMMIT;

Step 2: Outbox poller (CDC via Debezium OR polling):
  SELECT * FROM outbox WHERE processed = false ORDER BY created_at
  FOR EACH row: producer.send(row.topic, row.key, row.payload)
                UPDATE outbox SET processed=true WHERE id=row.id

Result: Atomic write to DB + eventually consistent Kafka publish
        Kafka publish is at-least-once (poller retries on failure)
        Consumer must be idempotent (dedup on outbox event ID)

Debezium CDC approach (better):
  Debezium reads DB WAL (binlog/WAL) → no polling, minimal latency (<1s)
  Avoids polling overhead, works at WAL level
```

### 8.2 Event Sourcing with Kafka

```
Traditional: Store current state in DB
Event sourcing: Store ALL state changes as events in Kafka (append-only)
  
Topic: account-events (compacted + long retention)
  {eventId: "e1", accountId: "a1", type: "AccountOpened", balance: 1000}
  {eventId: "e2", accountId: "a1", type: "Deposited", amount: 500, newBalance: 1500}
  {eventId: "e3", accountId: "a1", type: "Withdrawn", amount: 200, newBalance: 1300}
  
Replay: Consume from offset 0 → rebuild full account state
Snapshot: Periodically write compact snapshot to another topic → avoid full replay
CQRS: Separate read models (projections) built by different consumers

Kafka advantages: immutable log = audit trail, replay = time travel debugging
Kafka pitfalls: GDPR deletion (you can't delete events), large event chains slow to replay
```

### 8.3 Saga Pattern (Distributed Transactions via Kafka)

```
Choreography-based saga (events drive saga):

Order Service:  OrderPlaced → Kafka
Payment Service: Kafka → PaymentReserved → Kafka  
Inventory Service: Kafka → InventoryReserved → Kafka
Shipping Service: Kafka → OrderShipped → Kafka

Compensation on failure:
Payment fails: PaymentFailed → Kafka
Order Service: Kafka → OrderCancelled (compensate)
Inventory Service: Kafka → InventoryReleased (compensate)

No central coordinator — each service reacts to events independently
Downside: complex saga flow is hard to debug/monitor
```

### 8.4 Fan-Out Pattern

```
SNS + SQS (AWS):
  OrderPlaced event → SNS topic
    ├── SQS: email_queue (email service)
    ├── SQS: analytics_queue (analytics service)
    ├── SQS: inventory_queue (inventory service)
    └── Lambda: real-time dashboard update

Kafka multiple consumer groups:
  Topic: order-events
    consumer-group: email-service (reads all events, sends emails)
    consumer-group: analytics-service (reads all events, updates dashboards)
    consumer-group: inventory-service (reads all events, updates stock)

  Each group maintains independent offset → true fan-out
  New group can start from offset 0 → replay all historical events
  → Kafka fan-out > SNS fan-out when replay + ordering matter
```

---

## 9. Common Interview Deep-Dives

### 9.1 "Design a system that processes payments in order per user with no duplicate processing"

```
Requirements translated:
  - Per-user ordering → partition by userId
  - No duplicates → exactly-once semantics
  
Architecture:
  Payment API → Kafka topic "payments" (partitioned by userId hash)
    → Payment Processor (Kafka Streams or Flink)
        - Idempotent consumer (check payment UUID in Redis)
        - Process payment
        - Commit offset only after successful payment
    → Kafka topic "payment-results"
    → Notification Service (consumer group)
    → Ledger Service (consumer group)
  
Exactly-once options:
  Option A: Kafka transactions (producer + consumer in same txn)
    → Strong guarantee, adds 2-5ms latency per transaction
  Option B: Idempotency key in Redis (simpler, no Kafka EOS overhead)
    → Redis TTL for idempotency keys = max message retention time
  
Ordering guarantee:
  Single partition per userId → strict ordering ✓
  Multiple consumers per partition → NOT possible (ordering breaks)
  Partitioned topic with 1 consumer per partition → OK
```

### 9.2 "Why is Kafka fast? Explain to me as if I'm a kernel engineer."

```
Layer 1: Sequential I/O
  All writes are appends to the active .log segment.
  Linux readahead: OS pre-fetches sequentially, hiding disk latency.
  
Layer 2: Page Cache Exploitation  
  Producer writes: kernel copies data to page cache, marks dirty → async flush to disk.
  Consumer reads of recently produced data: page cache hit, no disk I/O.
  
  Kafka heap intentionally small (4-8GB) → OS free RAM → large page cache.
  At 32GB RAM with 6GB heap: ~24GB of message data cached in kernel memory.
  
Layer 3: Zero-Copy (sendfile)
  Without TLS, consumer fetch uses FileChannel.transferTo() → sendfile() syscall.
  Data path: disk → page cache (DMA) → NIC buffer (DMA). Zero CPU copies.
  2 total copies vs 4 in traditional approach.
  
Layer 4: Batch Compression
  RecordBatch compressed as a unit → higher compression ratio (cross-record dictionary).
  Network bandwidth × 5-10 vs uncompressed.
  
Layer 5: Binary Protocol
  No JSON parsing overhead. Fixed-size fields where possible. Varint encoding for offsets.
  LMAX Disruptor-style ring buffer concepts in some Kafka paths.
  
Combined: throughput limited by NIC bandwidth, not CPU or disk.
Measured: 2+ GB/s write on single broker with 10GbE NIC.
```

### 9.3 "Explain exactly-once in Kafka. What can go wrong?"

```
What works:
  PID + sequence numbers: prevents duplicate writes from retrying producer
  Transactions: atomic multi-partition write + offset commit
  read_committed: consumers don't see uncommitted data
  
What can go wrong:
  1. Consumer processes message AND commits offset, BUT downstream write fails.
     → Consumer offset advanced, message "gone", downstream effect not applied
     → EOS covers Kafka-to-Kafka but NOT Kafka-to-DB
     → Solution: write-then-ack pattern, or outbox pattern

  2. Transaction coordinator crash during PREPARE_COMMIT phase:
     → On restart, coordinator reads __transaction_state, resends markers
     → Safe: idempotent marker writes

  3. Producer epoch reset:
     → transactional.id restarted → new epoch issued → old producer requests rejected
     → If old producer had inflight writes: they're fenced (rejected by broker)
     → Data potentially lost if old producer was mid-transaction
     → Solution: transactional.id must be stable and unique per logical producer

  4. LSO blocking consumers:
     → Open transaction (never committed/aborted) freezes LSO
     → Consumers with read_committed see no new data
     → Alert on: uncommitted transactions > transaction.timeout.ms
     → Cause: bug in producer code (exception before commitTransaction())
     
  5. Compaction + transactions:
     → Compaction respects LSO: never compacts below LSO
     → But once committed: if compaction deletes a record that was in a transaction,
        the control batch (commit marker) is also eventually removed
     → Consumer must not rely on re-reading old committed transaction markers
```

### 9.4 "How does Kafka rebalancing work and how do you minimize downtime?"

```
Rebalancing triggers:
  - Consumer joins group (new deployment, scale-out)
  - Consumer leaves group (crash, scale-in)
  - Subscription change
  - Metadata change (new partitions added)
  - max.poll.interval.ms exceeded (slow processing → consumer leaves voluntarily)
  - session.timeout.ms exceeded (dead consumer detected)

Minimize rebalance impact:
  1. Use CooperativeStickyAssignor: only moved partitions stop processing
     
  2. Static group membership (group.instance.id):
     On pod restart: same instance ID → no rebalance if rejoins within session.timeout.ms
     Kubernetes: set group.instance.id = pod-name (stable across restarts)
     
  3. Tune max.poll.interval.ms:
     If processing is slow (DB writes, HTTP calls): increase to 10-30 minutes
     Risk: dead consumer detection is slower
     
  4. Separate processing from polling:
     Poll in one thread, process in thread pool, commit in polling thread
     Call consumer.pause() on partitions when thread pool full
     → Keeps heartbeat alive, prevents max.poll.interval.ms expiry
     
  5. Kubernetes rolling deployments:
     PodDisruptionBudget: ensure not all pods restart simultaneously
     Readiness probe: mark pod ready only after first successful poll
     
  6. KIP-429 (Incremental cooperative rebalancing) - Default Kafka 3.x:
     With CooperativeStickyAssignor, rebalances complete in 2 small rounds instead of 1 big one
     Unaffected partitions: 0 downtime
     Moved partitions: only during the brief revocation + reassignment (milliseconds per partition)
```

---

## 10. Quick-Reference Cheat Sheet

### When a System Design Interview Asks "What messaging system would you use?"

```
"It depends on..."
  
Low-latency task queue (<5ms, per-message priorities, flexible routing):
  → RabbitMQ with quorum queues

High-throughput event streaming (>100k events/sec, replay needed):
  → Apache Kafka

Multi-tenant platform with independent scaling of compute/storage:
  → Apache Pulsar

AWS-native, simple queuing, zero ops overhead:
  → SQS Standard (at-least-once) or SQS FIFO (ordered, exactly-once, low throughput)

AWS event-driven microservices with complex routing:
  → EventBridge + SQS

Real-time stream processing on top of Kafka:
  → Kafka Streams (simple, Kafka-native) or Apache Flink (complex, multi-source)

Cross-datacenter, exactly-once replication:
  → Pulsar (native geo-replication) or Kafka + KRaft + MirrorMaker2
```

### Key Numbers to Remember

```
Kafka:
  Default partition count:  1 (set this manually based on throughput)
  Max partitions per broker: ~2000-4000 (KRaft removes old limits)
  __consumer_offsets partitions: 50
  __transaction_state partitions: 50
  Default segment size: 1 GB
  Default segment roll time: 7 days
  Default retention: 7 days
  Default fetch.min.bytes: 1 byte (set to 1MB+ for throughput)
  Default batch.size: 16 KB
  Default linger.ms: 0 ms
  Default buffer.memory: 32 MB
  Recommended heap: 6 GB (G1GC or ZGC)
  
RabbitMQ:
  Default ack timeout: delivery_timeout (default: no limit, configure it!)
  Quorum queue min nodes: 3 (for N=1 failure tolerance)
  Default vm_memory_high_watermark: 40%
  Default heartbeat: 60s
  
SQS:
  Standard: ~50k TPS soft limit, 14-day retention max, 256KB max message
  FIFO: 300 TPS (3000 with batching), 5-min deduplication window
  Visibility timeout: default 30s, max 12h
  Long poll max: 20s
  
Pulsar:
  Default ensemble/Qw/Qa: 3/3/2
  Default bundle count: 4 per namespace
  Default ledger roll time: 4h
  Default ledger roll size: 2GB
```

---

Sources:
- [Cooperative Rebalancing in Kafka (Confluent)](https://www.confluent.io/blog/cooperative-rebalancing-in-kafka-streams-consumer-ksqldb/)
- [Kafka Streams vs Flink vs Spark (Onehouse)](https://www.onehouse.ai/blog/apache-spark-structured-streaming-vs-apache-flink-vs-apache-kafka-streams-comparing-stream-processing-engines)
- [Kafka Streams vs Flink (Redpanda)](https://www.redpanda.com/guides/event-stream-processing-kafka-streams-vs-flink)
- [SQS Exactly-Once Processing (AWS)](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html)
- [Kafka Exactly-Once Semantics (Confluent)](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)
- [Kafka Design: Efficient Data Transfer (Confluent)](https://docs.confluent.io/kafka/design/efficient-design.html)
- [Apache Pulsar Messaging Concepts](https://pulsar.apache.org/docs/next/concepts-messaging/)
- [RabbitMQ Quorum Queues](https://www.rabbitmq.com/docs/quorum-queues)
- [Instaclustr Cooperative Rebalancing (up to 20x faster)](https://www.instaclustr.com/blog/rebalance-your-apache-kafka-partitions-with-the-next-generation-consumer-rebalance-protocol/)
