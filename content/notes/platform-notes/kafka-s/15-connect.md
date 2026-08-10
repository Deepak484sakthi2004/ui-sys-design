# Chapter 15 — Kafka Connect
### The Last-Mile Integration Layer

---

In any production system, Kafka is rarely the only piece of
infrastructure. There are databases, search indexes, data lakes,
SaaS APIs, file systems, message queues from a previous decade —
the whole zoo of systems data has to flow into and out of. Writing
custom code to bridge each one is exactly the integration-hairball
problem Kafka was designed to solve. Yet someone still has to write
the bridge code; *somewhere* the bytes have to be translated.

**Kafka Connect** is Kafka's answer. It is a runtime — a separate
process from brokers, but standardised and bundled with Kafka — for
running connectors that move data between Kafka and external systems.
A connector is a configurable, reusable unit of integration: "read
records from Postgres and produce to Kafka", "consume records from
Kafka and write to S3", "consume records from Kafka and index into
Elasticsearch". The connector ecosystem is large and mature; for
most common systems, you can configure rather than code.

Connect is not glamorous. It does not pop up in conference talks the
way Streams does. But in real production deployments, Connect moves
more bytes than any other Kafka component combined. Most "Kafka
projects" turn out to be 10% Streams or custom apps and 90% Connect.

This chapter covers:

- The Connect architecture: workers, tasks, connectors.
- Source vs sink connectors and how they map onto Kafka.
- Standalone vs distributed mode.
- How offsets work in Connect — for both source and sink connectors.
- Single Message Transforms (SMTs) for in-flight modification.
- Schema-aware connectors and the role of Schema Registry (Chapter 16).
- The big-name connectors: JDBC, S3, Debezium, Elasticsearch.
- Operational realities — monitoring, scaling, error handling, dead-letter
  queues.

By the end, you should be able to choose Connect over a custom
producer/consumer when it's the right tool, configure a basic source
or sink, and know what to monitor.

---

## 15.1 The architecture, top down

```
                ┌──────────────────────────────────────────┐
                │  CONNECT CLUSTER (or "worker fleet")     │
                │                                           │
                │   ┌──────────┐  ┌──────────┐  ┌────────┐  │
                │   │ Worker 1 │  │ Worker 2 │  │ Worker3│  │
                │   │ JVM      │  │ JVM      │  │ JVM    │  │
                │   │ ┌──────┐ │  │ ┌──────┐ │  │┌──────┐│  │
                │   │ │Task A│ │  │ │Task B│ │  ││Task C││  │
                │   │ │Task D│ │  │ │Task E│ │  ││Task F││  │
                │   │ └──────┘ │  │ └──────┘ │  │└──────┘│  │
                │   └──────────┘  └──────────┘  └────────┘  │
                └────────┬─────────────────────────┬────────┘
                         │                         │
                  reads/writes                  reads/writes
                         │                         │
                         ▼                         ▼
              ┌────────────────────┐        ┌─────────────────┐
              │  External system   │        │    KAFKA        │
              │  (Postgres, S3,    │ ←──→   │ (topics: source │
              │   Elasticsearch,   │        │  output / sink  │
              │   ...)             │        │  input)         │
              └────────────────────┘        └─────────────────┘
```

The cast:

**Worker.** A JVM process running the Connect runtime. A Connect
deployment is one or more workers; together they form a cluster.
Workers talk to each other via Kafka topics for coordination; they
don't talk via direct RPC.

**Connector.** A configured integration unit. A "JdbcSourceConnector
configured to read from `customers` table in production-postgres" is
one connector. A "S3SinkConnector configured to write the
`order-events` topic to `s3://exports/orders/`" is another.

**Task.** A connector is divided into tasks — units of parallelism.
A JDBC source connector reading 10 tables creates 10 tasks (one per
table). An S3 sink connector for a 24-partition topic creates up to
24 tasks (one per partition). The connector decides task count via
`tasks.max` config.

**Plugin.** The actual connector implementation — a JAR. Source/sink
connector plus the supporting classes (converters, transforms,
predicates).

Workers run tasks. The Connect runtime distributes tasks across workers
via a consumer-group-like protocol on internal topics. When workers
join or leave, tasks rebalance — exactly like a consumer group's
rebalance, with similar costs.

---

## 15.2 Source vs sink

There are two flavours of connector:

### Source connector

Reads from an external system, writes to Kafka.

Examples:
- **JDBC Source** — reads from a relational database via SQL polling.
- **Debezium** — reads from a database's *change log* (write-ahead
  log, binlog) for true CDC.
- **File Source** — tails a file on disk.
- **Kinesis Source** — reads from AWS Kinesis.

A source task's job: produce records to Kafka topics.

### Sink connector

Reads from Kafka, writes to an external system.

Examples:
- **S3 Sink** — writes records to S3, batched into files.
- **JDBC Sink** — upserts records into a relational database.
- **Elasticsearch Sink** — indexes records.
- **HDFS Sink** — writes to HDFS, often partitioned by date.

A sink task's job: consume records from Kafka, write them out.

---

## 15.3 Standalone vs distributed

Connect can run in two modes.

### Standalone

A single worker. Single JVM. Tasks all run in one process. Configuration
is on the local filesystem.

Use for development, testing, and small deployments where simplicity
matters more than fault tolerance. If the worker dies, everything
stops.

### Distributed

Multiple workers in a cluster. Workers coordinate via Kafka topics:

- **`connect-configs`** — connector and task configurations.
  Compacted topic.
- **`connect-offsets`** — source connector offsets (where each source
  task left off in the external system). Compacted topic.
- **`connect-status`** — worker / connector / task health status.
  Compacted topic.

Workers join a "Connect cluster" by sharing a `group.id` (the
`group.id` config in Connect, distinct from any other consumer group).
The group coordinator (a broker) elects a leader worker, which assigns
tasks across the workers.

If a worker dies, its tasks rebalance to other workers automatically.
If a connector is deleted (or a task fails), the rebalance redistributes
remaining tasks.

Use distributed mode for any production deployment with more than a
trivial number of connectors. Provision at least 3 workers for fault
tolerance.

### REST API

Distributed Connect exposes a REST API on each worker (default port
8083) for managing connectors:

```
POST /connectors                     # create a new connector
GET /connectors                      # list all
GET /connectors/<name>               # get config
GET /connectors/<name>/status        # health
PUT /connectors/<name>/config        # update config
DELETE /connectors/<name>            # delete
POST /connectors/<name>/restart      # restart task(s)
```

Workers proxy REST calls to the leader, which writes to `connect-configs`.
All operations are eventually consistent.

---

## 15.4 Source connector offsets

A source connector reads from an external system. Where it left off in
that system — the "source offset" — is the connector's own
responsibility to track.

Examples:

- **JDBC Source.** Source offset = last value of the `incrementing` or
  `timestamp` column read.
- **Debezium MySQL.** Source offset = binlog filename + position +
  GTID.
- **File Source.** Source offset = byte offset in the file.

Each source task reports source offsets via the runtime. The runtime
persists them in the `connect-offsets` topic.

Critically: **the source offset is committed with the produced
records, not after**. Connect uses Kafka's transactional protocol
(KIP-618 in 3.3+) to atomically commit "I produced these records to
output topic AND I have advanced the source offset to X". If the
worker dies after producing but before committing the source offset,
the next instance re-reads from the old source offset, possibly
producing duplicates — at-least-once semantics by default.

For exactly-once source connectors (KIP-618), the transactional commit
makes the producer + offset atomic. Caveat: the *external* system
must be deterministic; if you read the same source offset twice, you
must get the same records both times. For databases this is true;
for tail-log sources, mostly true; for some queue-like systems, not
true at all.

---

## 15.5 Sink connector offsets

A sink connector reads from Kafka and writes to an external system. Its
offsets are *Kafka offsets* — exactly the same as a normal consumer.
They live in `__consumer_offsets`, indexed by the connector's
auto-generated consumer group (typically `connect-<connector-name>`).

A sink task processes a batch of records, writes them to the
external system, then commits the offsets. The offsets are committed
*after* the external write completes — at-least-once semantics. If
the worker dies after writing but before committing, the new owner
reprocesses, and the external write is repeated.

For idempotent external systems (upserting by primary key, writing to
S3 with deterministic file naming), this is fine. For non-idempotent
external systems (sending an email, calling a notification API), this
is a real problem; design accordingly.

---

## 15.6 Single Message Transforms (SMTs)

Often you don't want the raw record from the source — you want a
slightly modified version. SMTs run inline in the connector to
transform each record.

Configuration looks like:

```json
{
    "name": "my-source",
    "config": {
        "connector.class": "io.confluent.connect.jdbc.JdbcSourceConnector",
        "...": "...",
        "transforms": "addPrefix,maskField",
        "transforms.addPrefix.type": "org.apache.kafka.connect.transforms.RegexRouter",
        "transforms.addPrefix.regex": "(.*)",
        "transforms.addPrefix.replacement": "myapp_$1",
        "transforms.maskField.type": "org.apache.kafka.connect.transforms.MaskField$Value",
        "transforms.maskField.fields": "ssn",
        "transforms.maskField.replacement": "****"
    }
}
```

Two transforms applied in sequence: first add a topic prefix, then
mask the SSN field.

Built-in SMTs:

- **InsertField** / **HoistField** / **DropField** — schema mutation.
- **MaskField** — for redaction.
- **RegexRouter** — change the destination topic name based on regex.
- **TimestampConverter** — convert between timestamp formats.
- **Cast** — change a field's type.
- **Filter** — drop records matching a predicate.
- **HeaderFrom** — move a field into a header (or vice versa).

For custom logic beyond these, you write your own SMT (`Transformation`
interface).

A common pattern: use SMTs for *light* transformation (renaming,
dropping, redacting), and route to a Streams app for heavy
transformation (joins, aggregations). Keeping SMTs simple makes them
easier to reason about and easier to swap connector implementations
later.

---

## 15.7 Converters and Schema Registry

A connector communicates with Kafka via byte arrays — that's what
the producer/consumer API takes. Converters translate between the
connector's typed representation (a `Struct` with named fields) and
the bytes that go into the topic.

Configurations:

- `key.converter` and `value.converter` — required for all connectors.
- Common values:
  - `org.apache.kafka.connect.storage.StringConverter` — UTF-8 strings.
  - `org.apache.kafka.connect.json.JsonConverter` — JSON.
  - `io.confluent.connect.avro.AvroConverter` — Avro with Schema
    Registry.
  - `io.confluent.connect.protobuf.ProtobufConverter` — Protobuf with
    Schema Registry.

For source connectors, the converter serializes the typed record
before writing to Kafka. For sink connectors, the converter deserializes
the bytes from Kafka before passing the typed record to the connector.

If you use schema-aware converters (Avro / Protobuf via Schema
Registry), the records flowing through Kafka have schemas registered
and versioned, enabling downstream consumers to evolve safely. We
cover Schema Registry in Chapter 16.

---

## 15.8 Some specific connectors worth knowing

### 15.8.1 JDBC Source

Polls a relational database via SQL. Two main modes:

- **Bulk mode**: reads all rows on each poll. Use for small reference
  tables.
- **Incrementing/Timestamp mode**: reads only rows where the
  incrementing column or timestamp column has advanced. Use for
  appendable tables.

Limitations:

- It's poll-based — latency is bounded by the poll interval, often
  10-30 seconds.
- It can't see deletes (no row to "select").
- It puts read load on the database.

For a real CDC use case, prefer Debezium.

### 15.8.2 Debezium

The premier open-source CDC platform. Reads from the database's
write-ahead log (Postgres logical replication, MySQL binlog, MongoDB
oplog, Oracle LogMiner / XStream, etc.) and produces events to Kafka.

Outputs CDC events with `before` and `after` images, delete events, and
source metadata (transaction ID, timestamp, position). Typically
keyed by primary key.

Use cases:
- Replicating database state to Kafka for downstream consumers.
- Materialising views, search indexes, caches.
- Database-to-database replication via Kafka as transport.

Operational:
- Consumes the database's WAL — usually low load on the source.
- The connector must keep up with the WAL or the WAL grows
  unboundedly. Watch lag carefully.
- Failover / restart is non-trivial; the connector saves WAL position
  to `connect-offsets`.

### 15.8.3 S3 Sink

Writes records from Kafka topics to S3, organised into files by some
partitioning scheme (time-based, field-based, etc.). Files can be
JSON, Avro, Parquet, etc.

Use cases:
- Long-term archival of Kafka data.
- Feeding data lakes for analytics (Athena, Presto, Spark).
- Backup / disaster recovery.

Operational:
- Files only become visible after they're "flushed" — which depends on
  the rotation policy (size, time, count). Until rotation, downstream
  systems don't see new data.
- Since the introduction of tiered storage (Chapter 13), the S3 sink
  for archival is partially obsolete — but it's still useful for
  *transformed* archival (different format, different partitioning).

### 15.8.4 Elasticsearch Sink

Indexes records into Elasticsearch. Each Kafka record becomes an
Elasticsearch document.

Use cases:
- Search.
- Logs / metrics aggregation.
- Real-time dashboards.

Operational:
- Backpressure if Elasticsearch is slow — set
  `linger.ms` and batch size carefully.
- Mapping conflicts — if Kafka schema changes incompatibly, ES
  rejects.
- Idempotent indexing requires a deterministic doc ID (typically the
  Kafka key or a hash of the value).

---

## 15.9 Error handling and dead-letter queues

A sink task that hits a non-retryable error has three options:

1. **Stop the task.** Default. The connector enters a failed state
   and requires admin intervention.
2. **Skip the bad record.** Log and continue. Risk of data loss.
3. **Send to a dead-letter topic.** Keep going, but preserve the
   failure for later inspection.

The third is usually right. Configure:

```json
{
    "errors.tolerance": "all",
    "errors.deadletterqueue.topic.name": "my-sink-dlq",
    "errors.deadletterqueue.context.headers.enable": "true"
}
```

Records that fail conversion or transformation go to `my-sink-dlq`
with headers describing the failure. An ops process can drain the
DLQ, fix the issue, and re-produce.

For source connectors, error handling is more complex — failures
often mean the upstream system has a problem the connector can't paper
over. The default is "fail loudly" and let an operator investigate.

---

## 15.10 Operational realities

### 15.10.1 Worker sizing

Each worker is a JVM with a configurable heap. Sizes from 4 GB (small
deployments) to 32 GB+ (heavy). Memory pressure comes from:

- Internal buffers per task.
- Schema Registry caches.
- Per-connector state (e.g., Debezium's offset cache).
- Producer/consumer batches.

Cluster sizing: number of workers ≈ ceil(total tasks / tasks per
worker). A worker can comfortably run 10-50 tasks depending on their
load profile.

### 15.10.2 Monitoring

JMX metrics under `kafka.connect:*`:

- `connector-state` per connector — RUNNING / FAILED / PAUSED.
- `task-state` per (connector, task) — same.
- `connector-class-loader-instance-name` — useful for debugging
  classpath issues.
- `source-record-poll-rate` per task — input rate.
- `source-record-write-rate` per task — output rate to Kafka.
- `sink-record-read-rate` per task — input rate from Kafka.
- `sink-record-send-rate` per task — output rate to external.
- `lag` in various forms — how far behind a task is.

Key alerts:

- Any task in FAILED state.
- Sink lag growing for sustained period.
- Source connector "lag" against external source (varies by connector).

### 15.10.3 Versioning and upgrades

Connectors are JARs. Plugin path:

```properties
plugin.path=/usr/share/java/connect-plugins
```

Adding a new connector class involves dropping a JAR (and its
dependencies) into this directory and restarting the worker. Removing
or updating: same.

Connector implementations evolve. A breaking change in a connector's
internals can require config migration on upgrade. Keep an eye on
release notes.

### 15.10.4 Security

Connect inherits Kafka's security: TLS to the brokers, SASL auth, ACLs
on the topics it reads/writes. Plus its own concerns:

- Credentials for external systems (database passwords, AWS keys).
  Stored in worker config, environment variables, or external secret
  stores via the `ConfigProvider` interface.
- The Connect REST API itself — by default unauthenticated. Put behind
  a reverse proxy with auth, or enable HTTPS with mutual TLS.

Connect makes it easy to *see* every secret because connector
configurations are stored in `connect-configs` (a Kafka topic) and
exposed via the REST API. Config providers (KIP-297) let you reference
external secret stores instead of inlining secrets.

---

## 15.11 Configurations that matter

```properties
# Worker
group.id=my-connect-cluster                     # cluster identity
bootstrap.servers=broker1:9092,broker2:9092
key.converter=org.apache.kafka.connect.json.JsonConverter
value.converter=org.apache.kafka.connect.json.JsonConverter
key.converter.schemas.enable=false              # for plain JSON
value.converter.schemas.enable=false

# Internal topics (Connect creates these)
config.storage.topic=connect-configs
offset.storage.topic=connect-offsets
status.storage.topic=connect-status
config.storage.replication.factor=3
offset.storage.replication.factor=3
offset.storage.partitions=25
status.storage.replication.factor=3

# Plugin path
plugin.path=/usr/share/java/connect-plugins

# REST API
listeners=http://0.0.0.0:8083
rest.advertised.host.name=...                   # for cross-worker comms
rest.advertised.port=8083

# Per-connector (in JSON config sent to /connectors)
{
    "name": "my-connector",
    "config": {
        "connector.class": "io.confluent.connect.jdbc.JdbcSourceConnector",
        "tasks.max": "8",
        "topics": "...",
        "errors.tolerance": "all",
        "errors.deadletterqueue.topic.name": "my-dlq",
        "transforms": "...",
        ...
    }
}
```

---

## Summary box

- Connect is a **runtime** for moving data between Kafka and external
  systems via configurable, reusable **connectors**.
- **Workers** run **tasks**; workers form a cluster coordinated via
  internal Kafka topics (`connect-configs`, `connect-offsets`,
  `connect-status`).
- **Source** connectors track their own offsets in the external
  system; sink connectors use Kafka's normal consumer offsets.
- **Single Message Transforms (SMTs)** modify records inline.
- **Converters** translate between Connect's typed records and Kafka
  bytes; schema-aware converters integrate with Schema Registry.
- The big-name connectors — JDBC, Debezium, S3, Elasticsearch — cover
  most integration needs.
- **Dead-letter queues** are the right error-handling pattern for
  sinks; configure them.
- **KIP-618** added exactly-once for source connectors using the
  transactional protocol.

## Further reading

- The Apache Kafka source: `connect/` directory. Particularly
  `connect-runtime/src/main/java/org/apache/kafka/connect/runtime/`.
- Debezium documentation: debezium.io. The CDC connector ecosystem.
- KIP-26: Add Kafka Connect framework.
- KIP-297: Externalize Secrets for Connect Configurations.
- KIP-618: Exactly-Once Support for Source Connectors.
- *Kafka Connect: Build and Run Data Pipelines* by Mickael Maison and
  Kate Stanley.

## War story: the connector that quietly stopped

A team had a JDBC source connector pulling user-update events from
Postgres into Kafka. Worked fine for a year. One morning the
downstream consumer team complained: no new updates in 36 hours.

The connector's status said RUNNING. Tasks were RUNNING. JMX
poll-rate was zero, but no error.

What had happened: someone had altered the source table, dropping
the `updated_at` column the connector was using as the incrementing
column. The connector had silently stopped finding new rows because
its query (`SELECT ... WHERE updated_at > ?`) returned zero rows.
No error — just no progress.

The fix was a five-minute config update once the cause was found. But
the *finding* took three hours, because the connector's "RUNNING"
state was misleading: technically the task was alive, polling at the
configured interval, just not finding anything.

Lessons:

1. **Don't trust connector state alone.** Monitor *throughput* — if
   a source connector that should be producing 10 records/min
   suddenly drops to 0, that's an alert regardless of the state.
2. **Source schema is part of the connector's contract.** A source
   side schema change should trigger review of every connector
   reading from it.
3. **Logging at INFO level is sometimes too quiet.** When investigating,
   raise to DEBUG temporarily; you may see the issue immediately.

We added per-connector throughput monitoring with PagerDuty alerts on
prolonged zero-throughput. The same pattern caught a Debezium failure
six months later — the WAL position had stalled because the
replication slot had been dropped by someone cleaning up "unused"
Postgres resources.

The pattern, generally: **trust integration health metrics over
component status metrics**. A component that says it's healthy while
the integration is broken is the worst kind of failure.
