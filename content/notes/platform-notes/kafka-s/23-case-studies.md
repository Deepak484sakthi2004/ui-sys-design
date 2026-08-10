# Chapter 23 — Case Studies
### What LinkedIn, Uber, Netflix, and Stripe Actually Built

---

The internet has hundreds of "how X uses Kafka" blog posts. Most of
them are marketing-flavoured: a one-paragraph description of the
problem, a diagram with Kafka in the middle, and a triumphant note
about scale. Useful for inspiration; less useful for learning.

This chapter collects four well-documented case studies, told with
the architecture-decision focus that this book has used throughout.
For each: what the problem was, what they considered, what they
chose, what didn't work, and what scale looks like. The patterns
generalise; the numbers don't, but they're informative.

---

## 23.1 LinkedIn: where Kafka came from

### The problem

LinkedIn in 2010: a sprawling integration graph with eight major
data-consuming systems (search, ads, recommendations, the data
warehouse, the activity stream, the social graph, the news feed, the
relevance models) and dozens of smaller ones. Every producer-consumer
pair had its own integration: REST APIs, point-to-point queues,
nightly database dumps, ad-hoc CSV transfers.

Adding a new consumer required changes to every relevant producer.
Adding a new producer required configuring every consumer.

The cost of integration was overwhelming the cost of building
features.

### The architecture choice

LinkedIn chose to invest in a new system that would:

- Have all event traffic flow through a single, durable log.
- Support multiple independent consumers reading at their own pace.
- Retain data long enough for downstream systems to backfill or
  catch up after outages.
- Scale horizontally as event volume grew.

They evaluated existing options (RabbitMQ, ActiveMQ, others) and found
they didn't meet the throughput / retention / scaling requirements.
They built Kafka from scratch.

### What they built (early)

A small Scala codebase, a few brokers, ZooKeeper for coordination.
Producer pushed records; consumers polled; brokers persisted to
disk.

Initial scale (2011): single-digit GB/s. Open-sourced 2011, Apache
project 2012.

### What they built (today)

LinkedIn now runs the largest Kafka deployment in the world, by
public claim. Numbers from public talks (2023-2024):

- ~7 trillion messages per day across the fleet.
- Multi-petabyte daily ingest.
- 4000+ brokers across many clusters.
- Tiered storage in production for the long-retention tail.
- The largest contributor to Kafka's open-source development.

Their architecture is heavily multi-cluster: separate clusters for
different teams / criticality / use case. Mirroring between clusters
is automated.

### Lessons

LinkedIn's ongoing contributions to Kafka — KIPs they led — include
many of the features discussed in this book: cooperative
rebalancing (KIP-429), incremental fetch sessions (KIP-227), and
the original Kafka Streams design.

The lesson is that **solving an integration problem at scale
sometimes requires building infrastructure**. The "buy vs build"
calculation skews toward "build" when the existing options can't
match your requirements, and the resulting system can become an
industry standard if it's good.

---

## 23.2 Uber: real-time everything

### The problem

Uber's business: matching riders to drivers in real time, computing
prices in real time, predicting demand in real time, paying drivers
based on real-time work, etc. Almost everything Uber does is
"react to a stream of events from the physical world".

By 2015, Uber had grown to need thousands of microservices, each
producing and consuming events. The data integration problem was
extreme: trip events, location updates, payment events, user
events, driver events — all needed to flow into multiple downstream
systems for matching, pricing, billing, fraud, ML, analytics.

### The architecture choice

Uber adopted Kafka as the central event substrate. But their scale
was such that a single Kafka cluster wouldn't serve all needs;
neither would a small handful.

Instead, they built **uReplicator** (their MirrorMaker
replacement), allowing topics to be selectively mirrored between
many clusters. They run dozens of Kafka clusters segregated by
function and geography.

### What they built

Public talks describe:

- Hundreds of Kafka clusters globally.
- ~10 trillion messages/day at peak.
- Multi-region active-active replication for disaster recovery.
- Custom client libraries for their polyglot environment.
- A "data services" platform that sits on top of Kafka, providing
  topic management, schema registry integration, and
  self-service onboarding.

A specific innovation: Uber's "lossless" Kafka replication via
uReplicator was developed because MirrorMaker 1's loss-prone
replication wasn't acceptable for financial data. uReplicator's
approach influenced MirrorMaker 2's design.

### Lessons

- **Multi-cluster from the start** at very large scale. A single
  global cluster doesn't survive cross-region issues; better to
  segregate and replicate.
- **Self-service tooling** is essential. With thousands of teams
  using Kafka, manual management doesn't scale; their data services
  platform abstracts the operations.
- **Custom replication** when off-the-shelf doesn't meet
  requirements. Sometimes the right answer is to build your own
  tool, contribute it back if useful.

Uber's blog (eng.uber.com) has long-form posts describing their
infrastructure. Worth reading if you're operating at multi-cluster
scale.

---

## 23.3 Netflix: stream processing at scale

### The problem

Netflix is in the entertainment business, but operationally is a data
business. Every second, billions of events: user playback events,
recommendation interactions, A/B test exposures, content delivery
metrics, etc.

The challenge is real-time analytics on this stream — feeding
recommendation models, A/B test results, content-delivery
optimisation. They run thousands of jobs continuously processing
this data.

### The architecture choice

Netflix uses Kafka heavily but is also notable for **Mantis** (their
Java stream processing engine, partially open-source, partially
internal) and **Keystone**, their data ingestion pipeline.

The Keystone pipeline:

```
Application emits events ──→ Local agent ──→ Kafka (frontend cluster)
                                                  ↓
                                              ETL processing
                                                  ↓
                                              Kafka (backend cluster)
                                                  ↓
                                              Spark/Flink/Druid jobs
```

Two-tier: a frontend cluster optimised for ingest (high throughput,
low transformation), a backend cluster optimised for downstream
consumption (more partitions, better consumer parallelism).

### What they built

Public talks describe:

- ~6 trillion events/day in 2019; presumably much higher now.
- 1+ Pb/day data volume.
- Hundreds of Kafka clusters.
- Custom client library (`message-bus`) for their JVM stack.
- Heavy use of Kafka Streams and other stream processors.

A specific innovation: Netflix uses **rack-aware fetch (KIP-392)**
extensively for cross-region cost optimisation — consumers in a
region prefer same-region followers to avoid cross-region traffic.

### Lessons

- **Frontend / backend cluster separation** for operational
  isolation: ingest spikes don't affect query workloads.
- **Custom client libraries** for very large fleets — wrapping the
  underlying Kafka client with company-standard configurations,
  metrics, error handling.
- **Embrace stream processing** — when your business is data,
  stream processing IS the business logic.

Netflix's open-source contributions (notably Mantis, Conductor,
Hollow) embody many of their architectural principles.

---

## 23.4 Stripe: financial data integrity

### The problem

Stripe processes payments. Every event has financial implications;
data loss is unacceptable; consistency must be auditable.

This is a different shape of Kafka problem from Uber/Netflix:
volumes are lower (millions of events/sec, not trillions/day) but
correctness requirements are higher.

### The architecture choice

Stripe built their event-sourcing architecture on Kafka, with
strict invariants:

- Every business event is recorded in Kafka.
- All derived state is computed from the log.
- Schema evolution is rigorously controlled.
- Every action is auditable from the log.

They use Kafka transactions extensively for the
consume-process-produce pattern, ensuring financial state changes
are atomic across topics.

### What they built

Public talks (less voluminous than Uber's or Netflix's) describe:

- Internal event-sourcing platform built on Kafka.
- Custom audit and observability tooling.
- Strict CI processes for schema changes.
- Multi-region active-active for disaster recovery.

A specific innovation: Stripe heavily uses **CDC from
Postgres/MongoDB into Kafka**, treating the database as
record-of-truth and Kafka as derived stream. The pattern allows
existing transactional code to continue working while new
event-driven services consume the resulting Kafka topics.

### Lessons

- **Correctness > throughput** for financial workloads.
  `acks=all`, `min.insync.replicas=2`, transactions are
  non-negotiable.
- **CDC as a bridging strategy** when you can't rewrite all your
  applications to be event-driven natively. The database stays
  authoritative; Kafka becomes the integration substrate.
- **Audit and observability are not optional**. Every change has
  to be traceable.

Stripe's engineering blog has detailed posts on their event-driven
architecture, which has influenced how many financial-services
companies approach the same problem.

---

## 23.5 Common patterns across all four

Synthesising:

### 23.5.1 Multi-cluster from real scale

Single-cluster Kafka has limits — partition count, controller
load, blast radius, network topology. Above a certain scale, the
right answer is multiple clusters with replication between them.
LinkedIn, Uber, Netflix all do this; Stripe does on a smaller
scale.

### 23.5.2 Self-service tooling

When hundreds of teams use Kafka, manual ops doesn't scale. Each of
the four built (or buys) a self-service platform: topic provisioning,
schema management, monitoring, alerting, on-call routing.
Building this is its own engineering project.

### 23.5.3 Custom client libraries

Each company wraps the official Kafka client with company-specific
defaults, metrics, error handling. The wrapper enforces
organisation-wide standards (compression on, metric tags consistent,
auth integration) that the raw library doesn't.

### 23.5.4 Heavy investment in observability

Each company has detailed monitoring on:
- Producer / consumer metrics per application.
- Cluster-level metrics (the fifteen from Chapter 19).
- Cross-cluster replication lag.
- Topic-level metrics (size, throughput, consumer fan-out).
- Schema-level governance.

### 23.5.5 Stream processing as a first-class concern

Each company has invested heavily in stream processing — Kafka
Streams, Flink, Spark Structured Streaming, custom engines. The
stream is the substrate; what you do with it is the business.

---

## 23.6 The non-FAANG case study: a typical mid-size deployment

For balance: a real mid-size deployment (anonymised), serving a
SaaS company with ~500 engineering staff and a few hundred
microservices.

### Their cluster

- 1 production Kafka cluster, 12 brokers, 3 KRaft controllers.
- ~3000 partitions across ~150 topics.
- Peak throughput ~100 MB/s, average ~30 MB/s.
- 7-day retention on most topics; 30 days on critical ones.
- RF=3, min.insync.replicas=2 cluster-wide.
- TLS + SASL/SCRAM, ACLs.
- Schema Registry for ~40 schema-aware topics.
- Kafka Connect cluster (3 workers) running Debezium for CDC and
  S3 sink for archival.

### What they get from it

- Decoupled microservice messaging (the original use case).
- CDC from main databases into the analytics warehouse.
- Real-time event tracking from web clients.
- A few stream processing jobs (Streams) for materialised views.

### What they don't have

- Multi-cluster setup. Single cluster, single region.
- Tiered storage. They handle retention with disk and explicit
  archival.
- Kafka in many other regions. Cross-region traffic goes through
  application-level replication.

### What this looks like operationally

- 2 SREs split-time on Kafka (along with other duties).
- Pages per month: typically 1-3, mostly self-resolving.
- Major incidents per year: 0-2.
- Cost: ~$30-50K/month all-in (cloud + ops time).

### Lessons

This is **the median Kafka deployment**, not a hyperscale one.
Most companies' Kafka deployments look like this, not like
LinkedIn's. The patterns from the hyperscalers transfer, but the
operational complexity is much lower.

---

## 23.7 Patterns to learn from / patterns to avoid

After studying many deployments:

### Patterns to copy

1. **Self-service via tooling.** Even at small scale, automating
   topic provisioning + ACL management saves repeated friction.
2. **Schema Registry from day one.** The cost is small; the
   benefit compounds.
3. **Per-team / per-criticality clusters** for isolation,
   even if it's only "production" and "internal-tools".
4. **Detailed application-level metrics** (per-producer, per-consumer)
   in addition to broker metrics.
5. **Treat Kafka as critical infrastructure.** Capacity planning,
   disaster recovery, security all need first-class attention.

### Patterns to avoid

1. **The single mega-cluster** that does everything. Eventually
   it's a single point of failure for everything; tenants compete.
2. **No standardisation.** Every team configuring producers
   differently, with different compression, different `acks`, different
   error handling. A nightmare.
3. **Skipping the platform investment.** Self-service tooling is
   work, but not building it just shifts the work to repeated
   support questions.
4. **Vendoring Kafka without operational expertise.** "Just deploy
   Kafka" without understanding the operational implications has
   produced more incidents than I can count.

---

## Summary box

- LinkedIn invented Kafka to solve their integration hairball.
- Uber operates dozens of clusters globally for scale and isolation.
- Netflix uses two-tier (frontend / backend) clusters for
  ingest / processing separation.
- Stripe leans on Kafka transactions for financial-grade correctness.
- All four invested heavily in self-service tooling, custom
  clients, observability, and stream processing.
- The median Kafka deployment is much smaller than these — but
  the patterns scale down.

## Further reading

- LinkedIn engineering blog (engineering.linkedin.com): countless
  Kafka-flavoured posts, often KIP-author-bylined.
- Uber engineering blog (eng.uber.com): uReplicator, schema registry,
  data services platform.
- Netflix tech blog (netflixtechblog.com): Keystone, Mantis,
  stream processing.
- Stripe engineering blog (stripe.com/blog/engineering): event
  sourcing, audit-grade systems.
- Confluent's case study collection: vendor-flavoured but useful
  cross-section.
- *Designing Event-Driven Systems* by Ben Stopford: the case for
  the patterns.

A continuing theme: **the companies running Kafka at extreme scale
have all built their own platforms on top of it.** The official
project gives you the engine; making it tractable for hundreds of
engineering teams is its own engineering effort. This is true at
small scale too, just less obvious.
