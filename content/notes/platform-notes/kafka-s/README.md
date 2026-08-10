# The Kafka Codex
### A Senior Engineer's Treatise on the Distributed Log

> *"Kafka is two ideas, repeated. The first is that an append-only log is a
> remarkably general data structure. The second is that consensus is too
> expensive to use casually, so push it to one place and amortise it."*

---

## What this book is

This is a working engineer's book about Apache Kafka. Not a getting-started
tutorial. Not a vendor pamphlet. Not a JIRA-by-JIRA replay of every KIP since
2011. It is the book I wish had existed when I first carried a pager for a
Kafka cluster and discovered, the hard way, that the documentation explained
the *what* but not the *why*.

I have been running Kafka in production since 0.8.x — through the
ZooKeeper-to-KRaft migration, three storage redesigns, the rise and stabilisation
of exactly-once semantics, the slow death of the old consumer protocol, and
several painful all-night incidents that taught me what the docs leave out. This
book is what I learned along the way, organised the way I would teach it to a
strong engineer joining my team.

**Who it is for**

- Senior backend / platform engineers who already know what a topic is, can
  read Java stack traces, and want to understand the system end-to-end.
- Interview candidates targeting principal / staff / 40-LPA-and-up roles where
  "explain HWM advancement under leader epoch transitions" is a fair question.
- SREs and on-call engineers who want to debug Kafka faster than `grep` allows.
- Engineers building on Kafka — Streams jobs, Connect pipelines, custom
  consumers — who want to reason about what their code is *actually* doing.

**Who it is not for**

- People looking for "what is a producer, what is a topic" in five hundred
  words. The official quickstart does that better.
- People who want a copy-paste recipe book. The recipes here come with the
  reasoning that makes them generalise.

---

## How this book is organised

Seven parts. You can read straight through, or jump in by topic. Cross-references
are explicit so chapters work as standalone deep-dives.

### Part I — Foundations

Theory and mental model. Read this part first if you have not already
internalised "Kafka is a log."

| # | Chapter | What you take away |
|---|---------|--------------------|
| 0 | [Preface](./00-preface.md) | Why this book; how to read it |
| 1 | [The Log — A Deceptively Simple Idea](./01-the-log.md) | The single abstraction the entire system is built on |
| 2 | [From Log to System](./02-architecture.md) | Brokers, topics, partitions, replicas, controller — the moving parts |
| 3 | [The Mental Model](./03-mental-model.md) | How to *think* about Kafka before reasoning about any specific failure |

### Part II — The Producer

Everything that happens between `producer.send(record)` and bytes hitting a
broker socket.

| # | Chapter | What you take away |
|---|---------|--------------------|
| 4 | [Producer Internals](./04-producer-internals.md) | RecordAccumulator, BufferPool, Sender thread, partitioner |
| 5 | [Idempotence and Transactions](./05-idempotence-and-transactions.md) | PID, sequence numbers, transactional coordinator, exactly-once |

### Part III — The Broker

The heart of the system: how data is stored, replicated, and served.

| # | Chapter | What you take away |
|---|---------|--------------------|
| 6 | [The Storage Engine](./06-storage-engine.md) | Log segments, sparse indexes, page cache, sendfile, fsync semantics |
| 7 | [The Network Stack](./07-network-stack.md) | Acceptor / processor / handler threads; request lifecycle; purgatories |
| 8 | [Replication](./08-replication.md) | ISR, HWM, LEO, leader epoch; KIP-101 truncation; unclean elections |
| 9 | [The Controller and KRaft](./09-controller-kraft.md) | The metadata log, Raft, the ZK-to-KRaft migration |

### Part IV — The Consumer

How readers stay aligned with a moving log without stepping on each other.

| # | Chapter | What you take away |
|---|---------|--------------------|
| 10 | [Consumer Internals](./10-consumer-internals.md) | Fetch protocol, offsets, position management, auto-commit semantics |
| 11 | [Group Coordinator and Rebalancing](./11-group-coordinator.md) | Eager vs cooperative; static membership; KIP-848 next-gen protocol |

### Part V — Higher-Level Constructs

Things built *on top of* the producer/broker/consumer triad.

| # | Chapter | What you take away |
|---|---------|--------------------|
| 12 | [Log Compaction](./12-log-compaction.md) | Tombstones, the cleaner thread, compacted topics as state stores |
| 13 | [Tiered Storage](./13-tiered-storage.md) | KIP-405 architecture, RemoteLogManager, when to use it, when not to |
| 14 | [Kafka Streams](./14-streams.md) | KStream / KTable, RocksDB, state store recovery, EOS in Streams |
| 15 | [Kafka Connect](./15-connect.md) | Workers, tasks, offset storage, single-message transforms, distributed mode |
| 16 | [Schema Registry and Evolution](./16-schema-registry.md) | Avro / Protobuf / JSON Schema; compatibility levels; the migration trap |

### Part VI — Operations and Production

What the runbook does not tell you.

| # | Chapter | What you take away |
|---|---------|--------------------|
| 17 | [Performance Tuning](./17-performance-tuning.md) | JVM, GC, OS, NIC, filesystem, broker / client knobs that matter |
| 18 | [Security](./18-security.md) | TLS, SASL/SCRAM, OAUTHBEARER, ACLs, audit, the threat model |
| 19 | [Monitoring and Operations](./19-monitoring-ops.md) | Metrics that catch real incidents; the JMX taxonomy; SLOs |
| 20 | [Capacity Planning](./20-capacity-planning.md) | Sizing partitions, brokers, disk, network; back-of-envelope math |

### Part VII — Patterns and Practice

Where the rubber meets the road.

| # | Chapter | What you take away |
|---|---------|--------------------|
| 21 | [Use Case Catalogue](./21-use-cases.md) | Event sourcing, CDC, metrics pipelines, ML feature stores, the lot |
| 22 | [Anti-Patterns and Pitfalls](./22-anti-patterns.md) | Things I have seen go wrong; how they go wrong; how to avoid them |
| 23 | [Case Studies](./23-case-studies.md) | LinkedIn, Uber, Netflix, Stripe — what they actually built |
| 24 | [Where Kafka Is Going](./24-the-future.md) | KIP-848, queues, ZK removal, Iceberg integration, the AI workload |

### Appendices

| # | Title | What's in it |
|---|-------|--------------|
| A | [The Wire Protocol Reference](./A-wire-protocol.md) | RecordBatch v2, common request/response shapes |
| B | [Configuration Reference](./B-configuration.md) | Annotated list of broker / producer / consumer configs that actually matter |
| C | [The KIP Reading Guide](./C-kip-reading-guide.md) | Which KIPs to read, in what order, to understand modern Kafka |
| D | [Glossary](./D-glossary.md) | Terms, with cross-references to chapters |

---

## How to read this book

There are three reasonable paths:

**The straight read.** Front to back. Best for the engineer who wants to
genuinely understand the system. Plan on twenty hours. It is not a long book by
page count, but the density is high and you will want to stop and think.

**The interview path.** Chapters 1, 2, 6, 8, 9, 10, 11, 22. About six hours.
Hits everything that comes up in a senior systems-design loop, with anti-patterns
to flavour your answers.

**The on-call path.** Chapters 3, 6, 8, 17, 19, 22. Three hours. What you
need to understand the system you just got paged on.

Each chapter ends with three things: a **summary box** of the load-bearing
ideas, a **further reading** pointer (the canonical KIPs and papers), and a
short **war story** drawn from production — the kind you would tell over beers
to explain why a particular config exists.

---

## Conventions

- **Code listings** are Java unless flagged otherwise. Kafka's reference
  client is Java; the protocol is language-neutral but the reference
  implementation is what defines edge-case behaviour.
- **Configuration keys** are written `like.this.in.code` and refer to
  broker, producer, or consumer configs depending on context — the chapter
  header makes the side clear.
- **Versions.** Unless noted, behaviour described is Kafka 3.7+ in KRaft mode.
  Where ZooKeeper-era behaviour differs and is still relevant (most production
  fleets in 2026 still have at least *some* legacy clusters), it is called out.
- **KIP references** are linked. KIP = "Kafka Improvement Proposal", the
  RFC-equivalent process by which any non-trivial change to Kafka is proposed
  and reviewed. Reading the KIPs is how you go from competent to fluent.
- **War stories** are real, but identifying details have been changed.

---

## A word on certainty

I have tried to be precise. I have also been doing this long enough to know
that anything I write with absolute confidence will be subtly wrong in some
version, on some platform, under some workload. Kafka is a moving target;
this book describes a snapshot of a system that has been quietly redesigning
itself underneath the API for fifteen years. When in doubt, **read the source**.
The Kafka codebase is, by the standards of distributed systems, unusually
readable. Most of what I learned, I learned by going there.

The chapter on the broker network stack will tell you exactly where to look.

— *the author*
