# Chapter 24 — Where Kafka Is Going
### The Next Five Years, Cautiously Predicted

---

Predicting infrastructure futures is a way to be wrong in print. But
the trajectory of Kafka is clearer than most — there are KIPs in
flight, vendor strategies on display, and clear pressures shaping
what comes next. This chapter makes some bets, with the caveat that
I'd reread them in 2030 and probably be embarrassed by some.

The big themes I see for the next five years:

1. **The end of ZooKeeper.** Already mostly here.
2. **Queues for Kafka** (KIP-932) — the long-anticipated
   queue-like consumer model.
3. **Tiered storage everywhere.** Object storage as the default
   long-tier.
4. **The Iceberg / table-format integration.** Kafka topics as
   Iceberg tables.
5. **AI-driven workloads** as a major pressure on the architecture.
6. **The simplification trend.** Removing legacy modes, codifying
   defaults.
7. **The competition.** Redpanda, Pulsar, WarpStream — and what
   Kafka does in response.

---

## 24.1 KRaft is now standard

Kafka 4.0 (2025) removed ZooKeeper support entirely. As of 2026,
every supported Kafka cluster is KRaft-based. This finishes a
multi-year transition.

The implications:

- **Operations have simplified.** No ZK ensemble to run alongside
  the brokers.
- **Faster failover** is the default.
- **The architecture is conceptually cleaner** — Kafka is just
  Kafka, not "Kafka and ZooKeeper".

Old documentation, old code, old recipes that mention ZK are now
strictly historical. If you're reading something on the internet
that talks about `/brokers/ids` znodes, it's at best 2024-vintage.

The lasting effect on operators: **reading the metadata log is
fundamental**. The previous mental model ("ZK has the truth, brokers
report") is replaced with "the metadata log is the truth, brokers
tail it." This is a shift, and if you operate Kafka, internalising
the new model is now mandatory.

---

## 24.2 KIP-932: Queues for Kafka

KIP-932, in beta as of 2026 and expected GA in late 2026 or 2027,
adds **queue-like semantics** to Kafka.

The problem KIP-932 solves: Kafka's consumer model is "one consumer
per partition." This works well for streaming aggregation but
poorly for traditional job queues (where you want N workers each
pulling work from a shared pool).

The solution: a new resource type called a **share group**, which
sits alongside consumer groups but with different semantics:

- Multiple consumers can read from the same partition simultaneously.
- Each record is delivered to exactly one consumer (load balanced).
- Per-message acknowledgement (ack/reject/release).
- Visibility timeouts (a delivered-but-not-acked record returns to
  the pool after a timeout).
- Delivery counts (a record can be retried up to N times before
  going to a DLQ).

This is, structurally, what SQS / RabbitMQ / Sidekiq look like.
Kafka was missing it; share groups add it.

Predictions:

- Within two years, "Kafka as a job queue" will go from anti-pattern
  to mainstream. Many teams that today use SQS or RabbitMQ
  *alongside* Kafka will consolidate.
- The producer side is unchanged — same Kafka producer, same topic.
  What changes is the consumer side.
- Adoption will be gradual; mature ecosystem of clients will take
  time.

This is the most operationally significant change in flight for
Kafka. Worth tracking.

---

## 24.3 Tiered storage as default

KIP-405 (tiered storage) shipped in 3.6 (2023) and has been
maturing. The current state (2026):

- Multiple production-ready implementations (Aiven, Confluent, AWS,
  others).
- Most cloud-Kafka offerings (Aiven, Confluent Cloud, MSK) ship with
  tiered storage on by default.
- Open-source self-hosted users are slower to adopt — the
  configuration is still moderately complex.

In five years' prediction:

- Tiered storage will be on by default in vanilla open-source
  Kafka.
- The compatibility limitations (compacted topics, in particular)
  will be lifted.
- Some workloads will go fully serverless on top of tiered storage —
  brokers as stateless caches over the tiered tier. This is the
  WarpStream / Redpanda Cloud approach (different companies,
  similar ideas).

---

## 24.4 Kafka and Iceberg

Apache Iceberg (and Hudi, Delta Lake) are table formats over object
storage. They've reshaped the data lake into a "lakehouse" that's
queryable like a database.

Kafka topics are *streams* of events; Iceberg tables are *snapshots*
that change over time. The two abstractions are dual:

- A Kafka topic, played end to end, can be materialised as an
  Iceberg table.
- An Iceberg table, with its WAL of operations, can be replayed as
  a Kafka topic.

KIP-1071 (proposed) and various vendor projects aim to make this
seamless: Kafka topics that are *also* Iceberg tables, without
explicit ETL.

Predictions:

- Within 2-3 years, "produce to Kafka topic, query as Iceberg
  table" is a single deployment unit, not two systems.
- Streaming + analytics merge operationally; the boundary between
  data engineering and stream engineering blurs.
- This is *good* for users — fewer systems to understand.

---

## 24.5 AI workloads

The biggest pressure on infrastructure in the late 2020s is AI
serving and training. Specific to Kafka:

### 24.5.1 Inference event streams

Real-time AI inference produces vast event streams: input prompts,
model outputs, user feedback, telemetry. Kafka is well-suited to
collecting these.

Implications: per-event size grows (model outputs are larger than
old-school events). Compression matters more. Streaming joins with
context from feature stores become complex.

### 24.5.2 Training data pipelines

Modern ML training is increasingly streaming-influenced — continual
learning, online learning, RLHF data flywheels. Kafka topics
become the ground-truth log of model interactions, with downstream
materialisations driving retraining.

### 24.5.3 The cost shift

AI workloads run on GPUs that cost more per hour than the entire
Kafka cluster around them. Kafka's CPU and disk costs become
rounding errors next to the GPUs.

What this means: **operational efficiency of Kafka matters less; AI
team productivity matters more**. Self-service tooling, easy
integration with ML infra, observability that AI engineers
understand — these become the priorities.

---

## 24.6 The simplification trend

Modern Kafka has been simplifying:

- ZK removed.
- KIP-848 (next-gen consumer protocol) replaces the JoinGroup
  dance with simple heartbeats.
- Cooperative rebalancing as default.
- Static membership easier to configure.
- Schema Registry as standard infrastructure.

I expect this to continue:

- More configurations get sensible defaults that don't need tuning.
- More features are turned on by default (idempotence, EOS-v2,
  cooperative rebalancing).
- The "Kafka beginner" experience improves; the gap between "can
  configure a producer" and "can operate a cluster" narrows.

The casualty is *flexibility*. Kafka used to be a kit you assembled;
it's becoming a platform. Some old-timers complain. Most users
benefit.

---

## 24.7 The competition

Three serious competitors to Apache Kafka:

### 24.7.1 Redpanda

A C++ rewrite of Kafka, API-compatible. Marketed for
lower latency and operational simplicity. As of 2026:

- Has a real product, used in production by some.
- The Kafka community is split; some ops teams swear by it,
  others stick with Apache Kafka.
- Their innovations (notably no JVM, native compaction, custom
  storage engine) are influencing Kafka's roadmap.

### 24.7.2 Pulsar

Apache Pulsar is a different design — stateless brokers with
storage in BookKeeper. Strengths in geo-replication and
multi-tenancy. Weaknesses in ecosystem maturity vs Kafka.

Pulsar has had a long campaign to challenge Kafka. As of 2026, it
has not displaced Kafka but has carved a niche in
multi-tenant-heavy environments.

### 24.7.3 WarpStream

A novel design: stateless brokers that store data directly in S3.
No local state, no replication management on the brokers side. The
operational complexity drops dramatically; the cost of cloud
storage is the primary cost.

WarpStream is Kafka-protocol-compatible, so existing producers /
consumers work unchanged. It's growing rapidly. Acquired by
Confluent in 2024, signaling the strategic significance of the S3-
backed approach.

### 24.7.4 What this means for Apache Kafka

The competition is shaping the project:

- **Lower latency** is a constant pressure (driving fluid-compute,
  reduced commits, etc).
- **Cloud-native operations** are increasingly emphasised.
- **Cost reduction** via tiered storage, smaller broker footprints.

Apache Kafka is unlikely to be displaced in the medium term — the
ecosystem is enormous, the user base is strong — but it will
continue to evolve under competitive pressure.

---

## 24.8 The non-prediction: what won't change

Some things look stable:

- **The log abstraction** is foundational and not going anywhere.
  Whatever else changes, "append-only ordered durable log" remains
  the right idea.
- **Producer / consumer / topic / partition** as the base
  vocabulary.
- **Kafka as the integration substrate** in event-driven
  architectures, increasingly mainstream.
- **The community-driven KIP process**.

Bet on the log; bet on the protocol. The implementation evolves; the
abstraction is durable.

---

## 24.9 What to read next

If you want to track Kafka's evolution in real-time:

- **The KIP wiki** — apache.org/confluence/display/KAFKA/Kafka+Improvement+Proposals
  is the source of truth for what's being proposed and discussed.
- **The dev mailing list** — every serious change is debated here.
- **The Confluent and vendor blogs** — vendor-flavoured, but
  often the first place to read about new features.
- **Strange Loop / Kafka Summit / re:Invent talks** — especially
  the "lessons learned" ones. The marketing talks can be skipped.
- **The release notes for each Kafka minor release** —
  short and information-dense.

---

## 24.10 A closing note

Kafka has been one of the few infrastructure systems that genuinely
changed the industry. Twenty years ago, asynchronous integration
was a mess of point-to-point connections. Today, "everything goes
through the log" is a default architecture for any company
serious about data.

The system itself has evolved enormously since I started using it
in 0.8.x. The fundamentals — the log, the partition, the offset —
have not changed. The implementation has been replaced wholesale,
multiple times. This is the sign of a healthy abstraction: the
exterior is stable; the interior can be redesigned without users
noticing.

The next five years will continue this. Some specific predictions
will be wrong. The pattern — "the log abstraction continues to be
useful, the implementation continues to improve" — will almost
certainly be right.

For engineers reading this book: you have time. The fundamentals
won't change. The KIPs in flight will, eventually, be the chapters
of a future edition. By then, this edition's appendices will be
archaeology.

That's fine. Infrastructure books, like the systems they describe,
have versions. Both should evolve.

— *the author*
