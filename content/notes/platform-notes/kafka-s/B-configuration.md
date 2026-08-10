# Appendix B — Configuration Reference
### The Configs That Actually Matter

---

Kafka has hundreds of configurations. Most don't matter for most
deployments. This appendix is the curated set: configs you will
actually adjust, with my opinion on each. For the full list, see
`kafka.apache.org/documentation`.

Format: `key` — default — recommendation — purpose.

---

## B.1 Broker

### Identity and roles

```
node.id                     — required        — unique per broker; integer
process.roles               — broker          — for combined: "controller,broker"; for dedicated: "controller" or "broker"
controller.quorum.voters    — required (KRaft) — comma-list: "1@h1:9093,2@h2:9093,..."
```

### Listeners

```
listeners                            — required              — multi-listener: "INTERNAL://:9091,EXTERNAL://:9092"
advertised.listeners                 — required              — addresses clients connect to
listener.security.protocol.map       — required              — "INTERNAL:SASL_SSL,..."
inter.broker.listener.name           — same as listeners[0]   — which listener for replication
```

### Storage

```
log.dirs                             — /tmp/kafka-logs       — comma-list of disks (JBOD)
num.recovery.threads.per.data.dir    — 1                     — raise to 4-8 for many partitions
log.segment.bytes                    — 1073741824            — 1 GB; rarely tuned
log.roll.hours                       — 168                   — 7 days; lower for low-volume compacted topics
log.index.size.max.bytes             — 10485760              — 10 MB; never tuned
log.index.interval.bytes             — 4096                  — never tuned
```

### Retention (cluster default)

```
log.retention.hours                  — 168                   — 7 days; usually overridden per-topic
log.retention.bytes                  — -1 (unlimited)        — usually overridden per-topic
log.retention.check.interval.ms      — 300000                — 5 min; rarely tuned
```

### Replication and durability

```
default.replication.factor           — 1                     — set to 3 in production
min.insync.replicas                  — 1                     — set to 2 with RF=3
unclean.leader.election.enable       — false                 — keep false
replica.lag.time.max.ms              — 30000                 — 30s; rarely tuned
replica.fetch.min.bytes              — 1                     — long-poll min
replica.fetch.wait.max.ms            — 500                   — long-poll timeout
replica.fetch.max.bytes              — 1048576               — 1 MB per partition; raise for big batches
num.replica.fetchers                 — 1                     — raise to 4 on busy brokers
```

### Threading

```
num.network.threads                  — 3                     — raise to 8-16 on busy brokers
num.io.threads                       — 8                     — raise to ~ 2× CPU cores
queued.max.requests                  — 500                   — internal request queue
```

### Network

```
socket.send.buffer.bytes             — 102400                — 100 KB; raise for high-throughput
socket.receive.buffer.bytes          — 102400                — 100 KB
socket.request.max.bytes             — 104857600             — 100 MB; max single request
connections.max.idle.ms              — 600000                — 10 min idle close
max.connections.per.ip               — Integer.MAX            — set to ~1000 in production
max.connections                      — Integer.MAX            — cluster-wide cap
```

### Internal topics

```
offsets.topic.num.partitions         — 50                    — for __consumer_offsets
offsets.topic.replication.factor     — 3                     — match cluster
offsets.retention.minutes            — 10080                  — 7 days for inactive groups
group.initial.rebalance.delay.ms     — 3000                   — wait for late joiners
group.min.session.timeout.ms         — 6000                   — cluster floor
group.max.session.timeout.ms         — 1800000                 — cluster ceiling

transaction.state.log.num.partitions    — 50                  — for __transaction_state
transaction.state.log.replication.factor — 3
transaction.state.log.min.isr            — 2
```

### Compaction

```
log.cleaner.enable                   — true                   — never disable
log.cleaner.threads                  — 1                      — raise to 4-8 on heavy clusters
log.cleaner.dedupe.buffer.size       — 134217728              — 128 MB; raise for high-cardinality
log.cleaner.io.max.bytes.per.second  — Long.MAX_VALUE         — limit on busy clusters
log.cleaner.delete.retention.ms      — 86400000               — 1 day; tombstone retention
log.cleaner.backoff.ms               — 15000                  — sleep when no work
```

### KRaft / metadata

```
metadata.log.dir                     — log.dirs[0]            — typically separate disk
metadata.log.segment.bytes           — 1073741824             — 1 GB
controller.quorum.election.timeout.ms     — 1000              — Raft election; rarely tuned
controller.quorum.fetch.timeout.ms        — 2000              — Raft fetch; rarely tuned
broker.heartbeat.interval.ms              — 2000              — broker → controller heartbeat
broker.session.timeout.ms                 — 9000              — controller's tolerance
```

### Tiered storage

```
remote.log.storage.system.enable                — false       — set true cluster-wide to enable
remote.log.storage.manager.class.name           — required    — your implementation class
remote.log.metadata.manager.class.name          — default OK
remote.log.manager.task.interval.ms             — 30000        — RLM check frequency
remote.log.manager.thread.pool.size             — 10
remote.log.reader.threads                       — 10
```

### Security

```
authorizer.class.name                — null                   — set to org.apache.kafka.metadata.authorizer.StandardAuthorizer
allow.everyone.if.no.acl.found       — false                  — keep false in production
super.users                          — empty                  — User:admin

ssl.keystore.location                — required for TLS
ssl.keystore.password                — required for TLS
ssl.truststore.location              — required for TLS
ssl.client.auth                      — none                   — "required" for mTLS

sasl.enabled.mechanisms              — GSSAPI                  — "SCRAM-SHA-512" typical
sasl.mechanism.inter.broker.protocol — GSSAPI
```

---

## B.2 Producer

### Connection / identity

```
bootstrap.servers                    — required               — comma-list "h1:9092,h2:9092"
client.id                            — empty                  — set per-application for monitoring
security.protocol                    — PLAINTEXT              — "SASL_SSL" in production
```

### Durability

```
acks                                 — all                    — never weaken in production
enable.idempotence                   — true (3.0+)            — never disable
retries                              — Integer.MAX_VALUE      — leave default
max.in.flight.requests.per.connection — 5                     — default; safe with idempotence
delivery.timeout.ms                  — 120000                  — 2 min; outer retry budget
```

### Batching / throughput

```
batch.size                           — 16384                  — 16 KB; raise to 64K-1M for throughput
linger.ms                            — 0                      — raise to 5-50 for batching
buffer.memory                        — 33554432                — 32 MB; raise for high produce rate
compression.type                     — none                   — set to "lz4" or "zstd"
max.request.size                     — 1048576                 — 1 MB; raise carefully
```

### Timing

```
request.timeout.ms                   — 30000                  — single-request timeout
max.block.ms                         — 60000                  — send() blocking on buffer.full
metadata.max.age.ms                  — 300000                  — refresh metadata at most every 5 min
```

### Transactional

```
transactional.id                     — empty                  — set to stable string for transactions
transaction.timeout.ms               — 60000                  — coordinator-side timeout
```

### Idempotence (auto-set when enabled)

```
key.serializer                       — required               — e.g., StringSerializer
value.serializer                     — required               — e.g., KafkaAvroSerializer
```

---

## B.3 Consumer

### Connection / identity

```
bootstrap.servers                    — required
client.id                            — empty                  — set per-application
group.id                             — required for subscribe — unique per logical app
group.instance.id                    — null                   — set for static membership (recommended)
security.protocol                    — PLAINTEXT              — "SASL_SSL" in production
```

### Subscription

```
auto.offset.reset                    — latest                 — or "earliest"; never "none" without handler
partition.assignment.strategy        — RangeAssignor + CooperativeStickyAssignor
                                                              — set to CooperativeStickyAssignor only for new groups
isolation.level                      — read_uncommitted       — "read_committed" for transactional consumers
client.rack                          — empty                  — set for KIP-392 follower fetch
```

### Commits

```
enable.auto.commit                   — true                   — SET TO FALSE in production
auto.commit.interval.ms              — 5000                   — only matters with auto-commit on
```

### Heartbeats / liveness

```
heartbeat.interval.ms                — 3000                   — heartbeat frequency
session.timeout.ms                   — 45000                  — broker tolerance
max.poll.interval.ms                 — 300000                  — 5 min; tune lower for slow processors
```

### Polling

```
max.poll.records                     — 500                    — tune for processing speed
fetch.min.bytes                      — 1                      — raise to 1MB+ for batch consumers
fetch.max.wait.ms                    — 500                    — long-poll timeout
fetch.max.bytes                      — 52428800                — 50 MB total response cap
max.partition.fetch.bytes            — 1048576                 — 1 MB per partition cap
```

### Deserialization

```
key.deserializer                     — required
value.deserializer                   — required
```

### Connection

```
connections.max.idle.ms              — 540000                 — 9 min; less than broker's 10 min
request.timeout.ms                   — 30000
default.api.timeout.ms               — 60000                  — 1 min for blocking calls
```

---

## B.4 Streams (KafkaStreams)

```
application.id                       — required               — unique per Streams app; acts as group.id
bootstrap.servers                    — required
state.dir                            — /tmp/kafka-streams     — local state directory
num.stream.threads                   — 1                       — raise to 4-8 typically
num.standby.replicas                 — 0                       — set to 1 for fast failover
processing.guarantee                 — at_least_once          — "exactly_once_v2" for EOS
commit.interval.ms                   — 30000 (EOS) / 30000     — flush / commit frequency
cache.max.bytes.buffering            — 10485760                — 10 MB
default.deserialization.exception.handler — LogAndContinueExceptionHandler
default.production.exception.handler — DefaultProductionExceptionHandler
default.timestamp.extractor          — FailOnInvalidTimestamp  — or WallclockTimestampExtractor
```

---

## B.5 Connect (worker)

```
bootstrap.servers                    — required
group.id                             — required               — Connect cluster identity
key.converter                        — required               — e.g., StringConverter
value.converter                      — required
config.storage.topic                 — connect-configs
offset.storage.topic                 — connect-offsets
status.storage.topic                 — connect-status
config.storage.replication.factor    — 3
offset.storage.replication.factor    — 3
status.storage.replication.factor    — 3
plugin.path                          — empty                  — comma-list of plugin directories
listeners                            — http://:8083            — REST API
```

---

## B.6 Topic-level overrides (the right level for these)

These can be set per-topic via `kafka-configs.sh --alter
--entity-type topics`:

```
cleanup.policy                       — delete                 — or "compact" or "compact,delete"
delete.retention.ms                  — 86400000                — 1 day; tombstone TTL
file.delete.delay.ms                 — 60000
flush.messages                       — Long.MAX                — keep
flush.ms                             — Long.MAX                — keep
retention.bytes                      — -1                      — per-topic size cap
retention.ms                         — 604800000               — 7 days
segment.bytes                        — 1073741824              — 1 GB
segment.ms                           — 604800000               — 7 days; LOWER for compacted topics
min.insync.replicas                  — broker default          — set per-topic for stricter
unclean.leader.election.enable       — broker default          — keep false
min.cleanable.dirty.ratio            — 0.5                     — compaction trigger
max.compaction.lag.ms                — Long.MAX                — force compaction after this
min.compaction.lag.ms                — 0                       — minimum age to compact
compression.type                     — producer (use producer's choice) — or set "lz4", etc.
message.format.version               — 3.0-IV1                  — old; ignore
message.timestamp.type               — CreateTime              — or LogAppendTime
remote.storage.enable                — false                   — true to tier this topic
local.retention.ms                   — depends                  — hot tier retention
local.retention.bytes                — depends                  — hot tier size cap
```

---

## B.7 The "first ten configs" cheat sheet

If you remember nothing else:

**Broker:**
1. `default.replication.factor=3`
2. `min.insync.replicas=2`
3. `unclean.leader.election.enable=false`
4. `num.io.threads=16`

**Producer:**
5. `acks=all`
6. `enable.idempotence=true`
7. `linger.ms=20`
8. `compression.type=lz4`

**Consumer:**
9. `enable.auto.commit=false`
10. `partition.assignment.strategy=CooperativeStickyAssignor`

These ten cover most of what production-readiness means for a basic
Kafka deployment. Everything else is fine-tuning.
