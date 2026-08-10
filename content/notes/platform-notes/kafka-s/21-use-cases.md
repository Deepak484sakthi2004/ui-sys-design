# Chapter 21 — Use Case Catalogue
### What People Actually Build with Kafka

---

A catalogue of real Kafka use cases, with the architecture pattern,
the gotchas, and the alternatives. This isn't an exhaustive list —
that would take another book — but it covers the patterns I have
seen most often and have opinions about.

For each pattern:

- **What it is** — the architecture sketch.
- **Why Kafka** — what specifically Kafka brings to the problem.
- **Gotchas** — the failure modes I've seen.
- **Alternatives** — when something else is better.

---

## 21.1 Asynchronous service-to-service messaging

The original use case. Service A wants to tell service B something
without waiting for B's response.

```
Service A → produce(event) → Kafka topic
                                   ↓
                           Service B consumes
```

**Why Kafka.** Decoupling, durability, replay, fan-out. B can be down
for hours and the events will be there when it comes back. C can
subscribe later without A knowing.

**Gotchas.**
- Latency floor: producer batching + commit + consume + process is
  10-100 ms minimum. For sub-millisecond service-to-service,
  consider gRPC or in-process.
- Order guarantees are per-key; design keys carefully.
- A consumer group sees only events produced *after* it subscribes
  (with `auto.offset.reset=latest`); plan for `earliest` if you
  want backfill on launch.

**Alternatives.**
- **Direct gRPC**: simpler when both sides are always available and
  ordering doesn't matter.
- **Job queue (Sidekiq, Celery, SQS)**: better for fan-out-of-one
  task processing.
- **Pub/sub (NATS, Redis Streams)**: lighter weight when retention
  doesn't matter.

---

## 21.2 Event sourcing

The application's state is a function of an immutable event log.

```
User action → Event written to Kafka → State derived from log

  topic: user-events                  topic: user-state (compacted)
  ──────────────────                  ─────────────────────────────
  off 0: created      ───────────►    K=user-1: {created, plan: free}
  off 1: upgraded                ───► K=user-1: {created, plan: pro}
  off 2: cancelled               ───► K=user-1: {created, plan: pro, cancelled}
```

**Why Kafka.** Immutable, ordered, durable, replayable. Combined
with compacted state topics (Chapter 12), gives you a complete
audit log + current state.

**Gotchas.**
- **Schema evolution.** Events written today must be readable in five
  years. Schema Registry + careful evolution patterns (Chapter 16) are
  load-bearing.
- **Snapshotting.** Replaying years of events on startup is slow.
  Periodic snapshots stored elsewhere (S3, database) make recovery
  practical.
- **Side effects.** Events that triggered emails / payments must
  not re-trigger on replay. Design events as facts, side effects as
  separate.
- **Consistency boundaries.** Cross-aggregate consistency is hard.
  Saga pattern, eventual consistency.

**Alternatives.**
- **CRUD with audit log**: simpler if you don't actually need
  replay-from-log.
- **Event Store (eventstoredb)**: purpose-built for event sourcing;
  better optimised for the pattern.
- **CDC + database**: state in database, log derived; sometimes a
  cleaner factoring.

---

## 21.3 Change Data Capture (CDC)

A database's changes streamed to Kafka.

```
Postgres ──CDC──→ Debezium connector ──→ Kafka topic ──→ Downstream
                                                          (search index,
                                                           data lake,
                                                           cache, etc.)
```

**Why Kafka.** The single source of truth becomes the database +
log. Downstream materialisations (Elasticsearch, Solr, data lake)
all consume the same Kafka topic, eliminating per-pair integrations.

**Gotchas.**
- **Debezium operational model.** Debezium reads the database's WAL
  (logical replication slot in Postgres, binlog in MySQL).
  Misconfiguration of replication slots can fill up disk in the
  source DB.
- **Schema evolution.** Database schema changes propagate to topics;
  consumers must handle.
- **Initial snapshot.** Bootstrapping reads the entire current
  database state. Can be huge; takes hours.
- **Primary key dependence.** Records are typically keyed by primary
  key; non-PK queries downstream require careful indexing.

**Alternatives.**
- **Polling** (JDBC source): simpler, higher latency, no delete
  detection.
- **Database-native replication** (Postgres logical replication,
  MySQL binlog directly): tighter coupling but no Kafka middle layer.

---

## 21.4 Log aggregation

Application logs from many services flow into Kafka.

```
Service A logs ──→ Filebeat / Fluentd / Vector ──→ Kafka topic
Service B logs ──→ ...                          ──→ Kafka topic
                                                       ↓
                                              Logstash / Elasticsearch
                                              S3 archive
                                              SIEM
```

**Why Kafka.** Buffer between log producers and downstream
consumers. If Elasticsearch is down, logs queue in Kafka; ES catches
up later. Multiple downstream consumers (alerting, archival, SIEM)
share the same source.

**Gotchas.**
- **Volume.** Log volume can dwarf application traffic. Plan disk.
- **Hot keys.** Logs with timestamps as keys produce hot-spotting if
  partitioning is naive.
- **Schema.** Free-form JSON logs are easy to produce, painful to
  parse. Standardise where possible.

**Alternatives.**
- **Syslog + log routers**: simpler, established.
- **Direct to ES**: fewer moving parts, less buffering.
- **Vector / Logstash with disk buffer**: similar buffering without
  Kafka.

---

## 21.5 Metrics pipeline

Application metrics shipped via Kafka.

```
Service emits metrics ──→ Kafka ──→ Stream processor (aggregation) ──→ TSDB
                                                              (Prometheus,
                                                               InfluxDB)
```

**Why Kafka.** Same as logs but for metrics: buffering, fan-out,
replay.

**Gotchas.**
- Metrics have low durability requirements; `acks=1` and
  `min.insync.replicas=1` are reasonable trade-offs for throughput.
- Aggregate before storing. Per-metric-event retention in TSDB is
  expensive.
- **Cardinality explosion.** Adding labels to metrics can multiply
  series count; Kafka doesn't help with this.

**Alternatives.**
- **Direct push to Prometheus**: simpler.
- **OpenTelemetry collector**: purpose-built telemetry pipeline.
- **StatsD**: classic, lightweight.

For very-high-volume metrics with downstream multi-consumer needs,
Kafka adds value. For modest volumes, direct push suffices.

---

## 21.6 Stream processing pipelines

Real-time enrichment, aggregation, filtering.

```
Source topic ──→ Streams app ──→ Output topic ──→ Downstream
                       ↑
                       │ joins with
                       ↓
                 Reference table topic
```

**Why Kafka.** Native integration with the stream platform. Streams
+ Connect + Schema Registry covers most real-time data needs.

**Gotchas.** Covered in Chapter 14. Briefly: stateful streams are
hard to operate; co-partitioning is mandatory for joins;
EOSv2 is essential for correctness.

**Alternatives.**
- **Flink**: more powerful for complex stream processing, more
  operational complexity.
- **Spark Structured Streaming**: heavier, batch-oriented.
- **ksqlDB**: SQL-like interface to Streams; nice for simple cases.
- **Database materialised views with CDC**: when state derivation is
  the goal, often simpler.

---

## 21.7 ML feature pipelines

Real-time and batch features for ML, served from Kafka-derived
state stores.

```
Raw events ──→ Kafka ──→ Streams (windowed aggregates) ──→ Feature topic (compacted)
                                                                ↓
                                                       Feature store (online)
                                                                ↓
                                                          ML inference
```

**Why Kafka.** Feature computation is naturally a stream-processing
problem. Online inference benefits from low-latency feature
freshness.

**Gotchas.**
- **Training/serving skew.** Features computed by Streams must match
  features computed in batch (often by Spark). Coordinating the two
  is non-trivial.
- **Backfill.** Reprocessing historical data to compute new features
  requires replay infrastructure.
- **State size.** Per-user-per-feature state grows large; plan
  state store sizing carefully.

**Alternatives.**
- **Feast / Tecton**: feature stores built on top of Kafka and other
  systems.
- **Database-driven features**: features as SQL views on the
  warehouse, served via fast read replicas.

---

## 21.8 IoT / device telemetry

Sensors, devices, vehicles emit events; Kafka aggregates.

```
Devices ──MQTT──→ MQTT broker ──MQTT-Kafka bridge──→ Kafka ──→ Processing
```

**Why Kafka.** Aggregation point; durability against backend
downtime; replay for debugging device behaviour.

**Gotchas.**
- **MQTT protocol** is preferred at the edge; bridge to Kafka.
- **Per-device partitioning** can be hot-spotty if some devices are
  much busier.
- **Device clock skew** affects event-time semantics in stream
  processing.

**Alternatives.**
- **Cloud-specific IoT platforms** (AWS IoT, Azure IoT) integrate
  more tightly with their respective ecosystems.

---

## 21.9 Mobile / web event tracking

Clickstream / event tracking from mobile and web clients.

```
Browser / app ──→ Edge ingest ──→ Kafka ──→ Processing pipelines
                                              (analytics, A/B tests,
                                               ML features, etc.)
```

**Why Kafka.** Buffering against analytics-system downtime; fan-out
to many consumers (analytics, ML, real-time alerts).

**Gotchas.**
- **Client-side buffering**: mobile devices may queue events offline;
  ingestion gets bursty.
- **Event schema design**: client-emitted events are hard to evolve.
- **Privacy**: PII in clickstream is a regulatory issue.

**Alternatives.**
- **Snowplow / Segment / RudderStack**: managed event collection.
- **Direct to data warehouse**: simpler if real-time isn't needed.

---

## 21.10 Job queue (the controversial one)

Using Kafka as a generic job queue.

```
Producer enqueues "do this work" event ──→ Kafka ──→ Worker consumer
```

**Why Kafka (proponents say).** It's already there, supports
exactly-once, has replication and persistence.

**Why I usually disagree.** Kafka is a *log*, not a queue:

- **No per-message acknowledgement.** A consumer either commits
  forward or doesn't; you can't NACK and requeue an individual job.
- **No priority queues.** A log has one order; "high priority" jobs
  must be a separate topic.
- **No delay queues.** Scheduling a job for "in 1 hour" requires
  application-level state.
- **No visibility timeout.** A worker that picks up a job and dies
  partway through doesn't release the lock; the job is "in progress"
  until the consumer is rebalanced, then the new owner reprocesses
  from the committed offset (re-doing all the *previous* uncommitted
  jobs too).
- **Fan-out semantics differ.** A traditional queue distributes a
  job to one of N workers; Kafka's consumer group model effectively
  gives one partition to one worker.

For genuine job-queue needs, use a job queue: Sidekiq, Celery, AWS
SQS, Temporal. Kafka is the wrong shape.

The exception: **batch processing of pre-partitioned work**. If you
have N batches of work, partition them into N partitions, and want
N workers each processing one batch — Kafka maps cleanly onto this.
This is "ETL pipeline" pattern, not "job queue".

KIP-932 (Kafka Queues for Kafka, in beta as of 2026) explicitly adds
queue-like semantics to Kafka, including per-message acks and
non-sequential consumption. For greenfield "I want a queue" use
cases, that's the right tool — but it's new, not yet
production-pervasive.

---

## 21.11 Audit / compliance log

Every action in the system written to a permanent log for
regulatory reasons.

```
Application ──→ produce(audit_event) ──→ Kafka ──→ Long-term archive (S3)
                                            ↓
                                    Real-time auditor
```

**Why Kafka.** Append-only nature matches audit-log requirements.
Replication for durability. Schema evolution for record format
changes over time.

**Gotchas.**
- **Tamper resistance.** Standard Kafka can be configured to *delete*
  data; auditors may want stronger guarantees. Consider blockchain
  or immutable storage for highest assurance.
- **Retention compliance.** Records may need to be kept (for years)
  or deleted (GDPR right-to-deletion). Reconciling these is
  application-level.
- **Searchability.** Audit logs are read for forensics, often by
  date or user. A compacted topic isn't appropriate; archival to a
  searchable store (Elasticsearch, ClickHouse, Athena on S3) is.

**Alternatives.**
- **Append-only databases** (CockroachDB with audit logs, ClickHouse).
- **WORM storage** (Write Once Read Many) for ultimate compliance.

---

## 21.12 Materialised views

A read-optimised view of data that's continuously kept up-to-date
from source events.

```
Source events ──→ Kafka ──→ Streams app ──→ Compacted topic
                                                    ↓
                                            Materialised state
                                            (in-memory or RocksDB)
                                                    ↓
                                            Interactive queries
```

**Why Kafka.** Streams' state stores + compacted topics = fast
read access to derived state, with full recovery from log on
restart.

**Gotchas.**
- **State store consistency.** Reads from a Streams app's state
  store happen during processing; ad-hoc reads (interactive queries)
  may see stale data.
- **Recovery time.** Large state takes time to rebuild from
  changelog (Chapter 14).

**Alternatives.**
- **Database with CDC**: store derived data in Postgres / MySQL,
  feed via CDC.
- **Materialise (the company)**: SQL-native streaming materialised
  views.

---

## 21.13 Data lake ingestion

Real-time data flow into data lake (S3, ADLS, GCS) for analytics.

```
Sources ──→ Kafka ──→ S3 sink connector ──→ Data lake
                                                ↓
                                       Spark, Athena, Trino
```

**Why Kafka.** Buffers ingest; multiple sinks can read same data;
near-real-time analytics possible.

**Gotchas.**
- **File rotation policy.** S3 sink writes files; how often to
  rotate determines latency for downstream queries.
- **Format choice.** Parquet for query, Avro for evolution; sometimes
  both (Parquet from Avro).
- **Iceberg / Hudi / Delta Lake.** Modern table formats over object
  storage make data-lake ingestion more like a database. Kafka +
  these = "lakehouse"

**Alternatives.**
- **Direct ingest** to data lake without Kafka if real-time fan-out
  isn't needed.
- **Spark Streaming** instead of Kafka Connect for transformations.

---

## 21.14 Multi-region replication

Active-passive or active-active across regions.

```
Region A: writes ──→ Kafka A ──MM2──→ Kafka B (Region B)
Region B: writes ──→ Kafka B ──MM2──→ Kafka A
```

**Why Kafka.** Disaster recovery; geographic load distribution;
latency optimisation for regional users.

**Gotchas.**
- **Replication lag.** Cross-region is slower than intra-region;
  consumers in B reading data produced in A see latency.
- **Loop avoidance.** Bidirectional replication can echo records
  forever without proper topic-prefix renaming.
- **Conflict resolution.** Active-active requires application-level
  conflict handling (last-write-wins, CRDT, custom).

**Alternatives.**
- **Single-region Kafka** with geographic load balancers in front
  if latency between regions is acceptable.
- **Cluster Linking** (Confluent commercial offering).

---

## Summary box

The patterns I've seen most:

1. **Async service messaging** — bread and butter.
2. **CDC** — the gateway drug to event-driven architecture.
3. **Stream processing** — the fancy stuff.
4. **Log aggregation** — high-volume, low-glamour, very common.
5. **Event sourcing** — powerful, hard to do well.
6. **Materialised views** — the modern factor.
7. **Audit logs** — universal compliance need.

The pattern *not* to use Kafka for: **plain job queues**. Wrong
shape; KIP-932 (Queues for Kafka) is the right tool for that, when
it goes GA.

For each use case, the question is: *what does Kafka specifically
add over the alternative?* If the answer is just "it's there" or
"it's hot", reconsider. Kafka is a heavy dependency; bring it in for
problems that actually want a log.
