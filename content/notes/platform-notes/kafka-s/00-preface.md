# Preface
### Why I Wrote This Book

---

I have been running Kafka in production for long enough to remember when the
official answer to "how do I do exactly-once?" was "you can't, design around
it." I remember when the controller was a mutex on a ZooKeeper znode and a
broker restart could deadlock a five-node cluster for fifteen minutes because
the new controller had to re-read every partition's state from scratch. I
remember when `acks=all` did not actually mean what it said, because
`min.insync.replicas` defaulted to 1 and a single ISR could "ack all" with no
durability guarantee at all. I remember the producer that didn't retry on
`NotLeaderForPartition` because someone, in a fit of optimisation, had
configured `retries=0` and ten years later the ghost of that decision was still
silently dropping messages on every leader election.

Most of what I know about Kafka, I learned by being wrong about it first.

There are good books on Kafka. *Kafka: The Definitive Guide* is excellent for
operators. *Designing Data-Intensive Applications* puts Kafka in context
alongside the broader landscape of replication, consensus, and storage. The
Confluent blog is the closest thing the field has to a journal of record.
What I never found was a book at the level I most wanted: one that assumes you
already know what a topic is, takes the gloves off, and walks through the
*why* of every design decision — the dead-end designs that were tried and
rejected, the interactions between subsystems that the per-component
documentation cannot explain because they are not part of any single component,
the subtle invariants that you only notice when something violates them and
your pager goes off at 3 a.m.

This is that book. Or at least, my attempt at it.

---

## How I think about teaching Kafka

There is a hierarchy of understanding, and most engineers stop somewhere on
the lower rungs:

1. **Vocabulary.** Topic, partition, broker, consumer group. You can hold a
   conversation. You cannot debug.
2. **Recipes.** "If I want at-least-once, set `acks=all`, `enable.idempotence=true`,
   `max.in.flight.requests.per.connection<=5`." You can write code that mostly
   works. You cannot explain why one of those settings exists.
3. **Mechanism.** The producer batches records into a `RecordAccumulator`,
   compresses them as a single `RecordBatch`, sends them via a `Sender` thread
   over a long-lived TCP connection, and the broker writes them to a memory-mapped
   index plus an append-only log file served back via `sendfile()`. You can debug
   when things go wrong.
4. **Design rationale.** *Why* is the index sparse rather than dense?
   *Why* does the consumer pull rather than the broker pushing? *Why* is the
   high watermark advanced by the leader rather than negotiated? *Why* did the
   transactional protocol need a separate coordinator? When you can answer
   these, you can predict what a new feature will look like before reading the
   KIP.
5. **Engineering judgement.** When does Kafka stop being the right answer? What
   workloads is it terrible for? What's it doing in five years? When you can
   answer *these*, you can architect.

This book aims for level 4, with frequent excursions to level 5. Level 3 is the
floor — every chapter assumes you can either read or look up the mechanism and
focuses on the layer above it.

---

## What "senior" means in this context

I keep using the word "senior". I mean it specifically.

A senior engineer, in the sense I care about, has three things a junior does
not:

- **Memory of failures.** Not abstract failures from a textbook — specific,
  remembered failures from systems they ran. The way a forensic pathologist
  knows what a stab wound looks like vs. a fall from height.
- **A mental model of cost.** Not just "this works" but "this works, and the
  reason it works costs us 80 GB of RAM per broker, and here is the alternative
  design we discussed and rejected."
- **Comfort with the source.** When the documentation runs out, they go to the
  code. They expect to find bugs there sometimes.

I have tried to write to that audience. There are a fair number of paragraphs
in this book that read "the documentation says X; the source says Y; here is
the version where it changed; here is the JIRA." That is deliberate. It is what
the job actually looks like.

---

## A note on opinions

I have opinions. They are in this book. Some of them are unfashionable.

I do not think Kafka should be your first answer for a job queue. I think the
default `acks=1` is a footgun that has cost the industry millions of dropped
messages and should be removed. I think most teams using Kafka Streams should
be using a database with change-data-capture instead, and I think most teams
using Kafka for event sourcing have not actually thought about what they will
do when the schema changes in three years. I think KRaft was overdue by half a
decade. I think tiered storage is more interesting than the marketing makes it
look. I think the next five years of Kafka are going to be defined by the
queues KIP and the slow swallowing of OLAP-adjacent workloads, not by another
streaming-platform pivot.

You will find these opinions called out as opinions, not laundered as facts.
You are free to disagree. The goal of the book is to give you enough
mechanistic understanding that your disagreements are productive — that you
can say "no, you're wrong about job queues, *here* is why" rather than "I
heard somewhere that…".

---

## What I left out

Three things, deliberately:

**The Confluent platform.** This book is about open-source Apache Kafka.
ksqlDB, Confluent Cloud–specific behaviour, the licensed connectors — all
absent. There are good reasons to use the Confluent stack; this book just isn't
where to learn about it.

**Comparison shopping.** "Kafka vs. Pulsar / Kinesis / Pub/Sub / Redpanda."
You can find that everywhere. Where I do mention alternatives, it is to
illuminate a Kafka design choice — "here is why the broker is stateful, and
here is what changes if you make it stateless, à la Pulsar."

**Hand-holding.** I do not show you how to install Kafka. I do not walk you
through writing your first producer. There are a hundred good tutorials for
that. This book starts where the tutorials leave you stranded.

---

## A reading suggestion

Read the chapter, then close the book and try to explain its central idea to
yourself out loud, as if to a colleague. If you cannot, you have not
understood it yet — go back. Reading is not understanding, and understanding
is not yet skill. Skill comes from operating the thing under load, and that I
cannot give you in any book. What I can give you is the framework into which
your operational experience will fit.

The next chapter is about a single data structure: the append-only log. It is,
in some sense, the only chapter that strictly matters. Everything else in this
book is consequences.

Let us begin.
