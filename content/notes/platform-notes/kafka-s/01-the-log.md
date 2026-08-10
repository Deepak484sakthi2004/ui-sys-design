# Chapter 1 — The Log
### A Deceptively Simple Idea

---

Before there was a system called Kafka, there was a problem at LinkedIn.

It was 2010. LinkedIn had a sprawling fleet of services — the social graph,
the activity stream, the search index, the news feed, the data warehouse, the
relevance models, the ad platform — and every one of them needed to know
*what was happening across the company in approximately real time*. Someone
viewed a profile; the search index needed to update relevance, the ad system
needed to update its bidding model, the data warehouse needed to log the
event, the recommendation system needed to recompute. The same fact about the
world had eight downstream consumers, each with its own latency tolerance,
its own backfill story, its own preferred encoding.

The pre-Kafka world solved this with point-to-point integrations. Service A
talks to service B via a database, to service C via a REST call, to service D
via a JMS queue, to service E via a nightly batch dump to HDFS. The integration
graph was a hairball. Adding a new consumer meant changing every producer.
Replaying history meant *not having* history, because the queue had drained
hours ago. Slow consumers slowed producers. Fast consumers got blocked behind
their slowest peer. There was no single place where you could go to see *the
truth about what happened*, and so there were eight slightly different
truths, drifting from each other in subtle ways nobody had time to debug.

The team — Jay Kreps, Neha Narkhede, Jun Rao, and a small group of others —
asked themselves a question: what is the simplest possible data structure that
solves this?

Their answer was a log.

---

## 1.1 What is a log?

Not a *log file* in the syslog sense — though syslog logs are the thing's
spiritual ancestor. A log here means something more abstract:

> A **log** is an append-only, totally ordered sequence of records, where each
> record is assigned a monotonically increasing identifier (its *offset*) and
> can be read by its offset.

That is the entire definition. Three properties:

1. **Append-only.** You can write to the end. You cannot mutate or delete
   in the middle. Records, once written, are immutable.
2. **Totally ordered.** Every record has a unique position relative to every
   other record. There is no ambiguity about which came first.
3. **Addressable by offset.** Given an offset, you can read the record at
   that position, and continue reading forward.

There is no other operation. No update. No delete-by-key. No
"insert-before-X". No transactions across non-adjacent records. The log is so
restrictive it is almost not a data structure — it's barely more than a file.

And yet.

---

## 1.2 Why this turns out to be enough

The deep observation, the one the Kafka founders made and that the rest of
the industry took five years to catch up to, is this:

> An append-only log is a remarkably general intermediate representation. Once
> you have it, you can build a queue, a database, a stream processor, a
> change-data-capture system, an event store, or a metrics pipeline on top of
> it — without changing the log.

Let me unpack that, because the implication is large.

### The log is a queue

If multiple consumers each track their own position in the log, and the log
retains records long enough for the slowest consumer to read them, you have a
queue. With one wrinkle: unlike a traditional queue, *reading does not
remove*. The log is the source of truth; the consumer's offset is the only
piece of state that changes. New consumers can be added at any time and read
from any historical position. Old consumers can rewind. A bug in your
processing logic? Reset the offset, replay. This is impossible with a
"destructive read" queue.

### The log is a journal

Databases have used logs internally for fifty years. Every relational
database is, at its heart, a write-ahead log followed by a B-tree (or LSM tree)
that materialises the log into queryable form. The "Kafka insight" is that
this journal can be promoted from internal implementation detail to
*system-of-record*, and the materialisations downstream can be many — one
team's Postgres, another team's Elasticsearch, a third team's data lake —
all reading from the same log, all eventually consistent with the same
ground truth.

This is what people mean when they say "Kafka makes the log the source of
truth." The database becomes a *cache* of the log, computed by some
materialisation function. Multiple caches can exist for multiple query needs.
None of them is canonical; the log is.

### The log is a clock

Distributed systems have a hard problem: there is no global "now". Different
machines disagree about wall-clock time, and even if they did agree, network
delays make "what happened first" a fundamentally ambiguous question. Lamport
showed in 1978 that you can replace wall-clock time with logical time — a
counter that increments per event — and reason about causality without ever
synchronising clocks.

A Kafka partition is a logical clock. The offset is the timestamp. Two
events on the same partition have a strict happens-before relationship; two
events on different partitions, generally, do not. This is not incidental —
it is exactly the partial order that distributed systems require, and it is
exactly the order Kafka provides.

### The log is a stream

If you read a log faster than records are being written, you eventually catch
up to the head and your reads start blocking on new appends. At that point,
you are processing a stream. There is no abrupt mode change between "batch"
and "stream" in this view; they are the same operation parameterised by how
far behind you are. Spark calls this "structured streaming" and treats batch
as a special case. Flink calls it "unified processing." Kafka was there
first, almost incidentally, because the log itself does not distinguish.

### The log is a CRDT, in a sense

A log of events, replayed on multiple replicas, will produce identical state
on each replica *provided the replay is deterministic*. Determinism is a
strong demand, but if you have it — and most well-designed event-handling
code does — then the log gives you replication "for free", in much the same
way that a CRDT does. You don't synchronise the state; you synchronise the
log, and let each replica recompute. This is, almost word-for-word, the
philosophy of state-machine replication, the model underneath Raft and Paxos.

---

## 1.3 The five claims that flow from "the log is the system"

Take the abstraction seriously and five non-obvious system properties drop
out:

### Claim 1: Decoupling is total

Producers do not know who their consumers are. Consumers do not know who
their producers are. They share only a topic name and a schema. A producer
can be added or removed without a single line of consumer code changing. A
consumer can be added or removed without a single line of producer code
changing. This is the integration-hairball problem, dissolved.

### Claim 2: Replay is free

If the log retains, replay costs whatever a sequential read of the relevant
records costs. The economics of this are dramatic: a consumer that drops
messages is no longer a catastrophe, it is an inconvenience. Reset the
offset, replay from yesterday, you are back to ground truth. This changes
your operational posture entirely. Failures stop being events that cost you
data and become events that cost you a few hours of recompute.

### Claim 3: Decoupled scaling

Producers are CPU-bound or I/O-bound on whatever they do. Consumers may be
DB-bound, GPU-bound, network-bound, or human-bound. With a queue in between,
each scales on its own axis. The producer does not block on the slowest
consumer because *there is no fast/slow producer/consumer pairing* — there
is the log, and there are independent readers.

### Claim 4: A natural unit of replication

Replicate the log; replicate the system. Because the log is a totally
ordered sequence of immutable records, two replicas in agreement about the
sequence of records will eventually compute identical downstream state.
Compare to replicating mutable state directly (the leader-follower replication
of MySQL, say): the volume of state is much larger, the conflicts are much
more complex. Logs are, in a precise sense, the *cheapest possible* thing to
replicate.

### Claim 5: Time travel

Once you have a log, every consumer holds a position. Move the position
backward, read again. Move it forward, skip records. Keep multiple positions
for multiple use-cases. The log itself is not modified by any of these
operations. This is the "infinite Ctrl-Z" of stream processing, and it is the
operational reason most ops teams who have used Kafka and a non-Kafka
alternative end up preferring Kafka. It is forgiving in a way that no
imperative system ever is.

---

## 1.4 The price you pay

If logs were strictly better than every other abstraction, the world would be
all logs. It isn't; there are real costs.

### Cost 1: You must choose your partitions correctly, forever

A topic in Kafka is not one log. It is **N** logs, where N is the partition
count, and ordering is guaranteed *within a partition*, never across
partitions. The choice of how to assign records to partitions — typically by
hashing a key — determines your ordering guarantees, your parallelism, your
consumer scalability, and (badly chosen) your hot-spotting nightmares.
Worse, partition count is *almost immutable*. You can add partitions, but
adding partitions changes the hash mapping for all subsequent records, so any
"records with key K go to partition P" invariant your downstream relies on is
*broken* by the addition.

I have personally seen a major reorg of a partitioning scheme take a team a
calendar quarter to plan and execute. The decision is more permanent than
your database schema. We will return to this in Chapter 2 and again in
Chapter 22's anti-patterns.

### Cost 2: There is no random write, ever

If you mis-key a record, you cannot edit it. You can write a tombstone or a
correction event, and consumers can be coded to apply corrections, but the
corrupt record is in the log forever (or at least until retention expires).
For some use cases — financial events, audit logs — this is what you want.
For others, it is a perpetual asterisk on every analytical query.

### Cost 3: The query model is impoverished

A log answers exactly one question: "what happened, in order?" It does not
answer "give me all records where customer_id = 47", or "count records by
hour", or "join records from two topics on a foreign key". For those, you
need a downstream materialisation — a database, a search index, a Streams
job. Kafka itself cannot answer them, and the temptation to add a query
layer to Kafka has produced ksqlDB, KStreams interactive queries, and several
other systems of varying success. The log is a poor query target by design.

### Cost 4: Everything ages

A log retained forever is a log that grows forever. Storage, even cheap
object storage with tiered storage (Chapter 13), is not free. Almost every
production Kafka deployment has a retention policy — typically 1, 3, or 7
days — and that retention policy *destroys the replay-everything property*.
You can replay back to retention; you cannot replay before. For long-term
retention, you need a separate archival path (a CDC sink to a data lake is the
common one), and now you have two systems and an integration to maintain. The
"single source of truth" property starts to fray.

---

## 1.5 The history nobody tells you

Some context that helps when reading the rest of this book.

The log-as-system idea was not invented at LinkedIn. Jay Kreps' 2013 essay
*The Log: What every software engineer should know about real-time data's
unifying abstraction*[^1] is required reading and traces the lineage:

- **Database internals.** Every major database has had a log at its core
  since at least the 1970s. ARIES, the canonical write-ahead log algorithm,
  is from 1992. The notion that the log *is* the database, and the index is
  just a cache, was already a folk theorem among database researchers.
- **State-machine replication.** Lamport, Schneider, and the Paxos lineage
  formalised the idea that you can replicate any deterministic state machine
  by replicating the sequence of inputs to it. Once you accept this, you
  realise the "sequence of inputs" is just a log.
- **Streaming SCM.** Tools like Bitkeeper and Git treat version control as a
  log of patches. Every Git commit is, in essence, a log entry.
- **Unix pipes.** A pipeline like `cat events | grep error | wc -l` is a
  little stream processor over a textual log, computed in-memory. Doug
  McIlroy's 1964 memo describing pipes is, in retrospect, the urtext of
  stream processing.

What LinkedIn contributed was not the idea of the log. It was the idea that
*you should build the log out of the entire company's nervous system*,
operationally — a single high-throughput, durable, replayable, partitioned
log to which everything writes and from which everything reads. Plus, of
course, an actual implementation that could survive production traffic.

The first version, internally, was hacked together in a few months in
2010. Open-sourced in 2011. Apache top-level project in 2012. By 2015 it was
running essentially every serious data integration at LinkedIn, Netflix,
Uber, Airbnb, and a long tail of others. By 2020 it had displaced most of the
"enterprise messaging" world (TIBCO, IBM MQ, ActiveMQ, much of RabbitMQ's
streaming use cases). The reason was almost entirely that none of those
older systems had committed to the log as the system. They had committed to
the message — to the destructive read, the per-message acknowledgement, the
broker-side state about what each consumer had seen — and that turned out to
be the wrong place to put your bet.

---

## 1.6 The shape of a Kafka log on disk

We will go very deep on this in Chapter 6. Here is the sketch, so that
nothing in the next four chapters surprises you.

A Kafka **partition** is implemented on a broker as a directory. Inside the
directory, the log is broken into **segments**. Each segment is three files
with the same numeric prefix:

```
my-topic-0/
  00000000000000000000.log         ← the actual record bytes
  00000000000000000000.index       ← sparse offset → file-position map
  00000000000000000000.timeindex   ← sparse timestamp → offset map
  00000000000000123456.log
  00000000000000123456.index
  00000000000000123456.timeindex
  ...
```

The numeric prefix is the **base offset** of the segment — the offset of
the first record it contains. Segments are rolled (a new one started) every
1 GB or every 7 days, by default. Old segments are deleted (or compacted —
Chapter 12) according to the retention policy.

The `.log` file is *append-only*. The OS kernel writes the data out via its
normal page cache. When a consumer asks for offset 723, the broker:

1. Finds the segment whose base offset is the largest one ≤ 723. (Binary
   search on a small in-memory list.)
2. Looks up 723 in that segment's `.index` to find the byte position. The
   index is sparse — one entry per ~4 KB of log — so the lookup gives you a
   *nearby* position, not exact.
3. Sequentially scans forward in the `.log` file from that position until it
   finds offset 723.
4. Sends the requested bytes to the consumer using the Linux `sendfile()`
   syscall — a zero-copy path that goes from page cache directly to the
   network socket buffer without ever copying through user-space.

Step 4 is one reason Kafka is fast. Step 2 is one reason Kafka is cheap on
RAM. Step 1 is one reason Kafka can have very large topics — you do not pay
proportionally to the number of segments at lookup time. Every one of these
properties is a downstream consequence of treating storage as an immutable,
append-only, offset-addressed log. None of them is available in a
destructive-read queue, and that is, in the end, what people mean when they
say "Kafka is fast."

---

## 1.7 What we have, and what we do not yet have

We have a log: an append-only, totally ordered, offset-addressed sequence of
records, partitioned for horizontal scale.

We do not yet have:

- **Durability.** A single broker can lose its disk. We need replication.
- **Availability.** A single broker can crash. We need a failover protocol.
- **Coordination.** We need a way to agree on which broker is the leader of a
  partition, and which followers are caught up. Replication and consensus.
- **Producers and consumers** with reasonable APIs and behaviour under
  partial failure. They will need batching, retries, partitioning, group
  membership.
- **Operational tooling.** Monitoring, schema management, security.

These are the next twenty-three chapters. The log itself is just the
foundation.

But it is a foundation that has, at this point, been load-bearing for almost
every interesting data system built since 2010. If you understand only one
thing from this book, understand this: a log is not a data structure that
Kafka happens to use. The log *is the system*. Everything else is in service
of making the log durable, available, and serviceable at scale.

---

## Summary box

- A Kafka **log** is an append-only, totally ordered, offset-addressable
  sequence of records.
- A **topic** is N independent logs (partitions). Ordering is guaranteed
  within a partition, not across.
- The log generalises to a queue, a journal, a stream, and a clock — the
  ability to materialise it many ways downstream is the central idea.
- The cost is that partitioning decisions are quasi-permanent, queries
  require downstream materialisations, and retention forces an archival path.
- On disk, a partition is a directory of segment files; offset lookups go
  through a sparse in-RAM index; reads use `sendfile()` for zero-copy
  delivery.

## Further reading

- Jay Kreps, *The Log: What every software engineer should know about
  real-time data's unifying abstraction*. The essay that introduced the
  industry to the framing.
- Martin Kleppmann, *Designing Data-Intensive Applications*, chapters 5
  and 11. Excellent surrounding context — replication, stream processing.
- Pat Helland, *Immutability Changes Everything*. ACM Queue, 2015. Why
  append-only is a strategic choice, not just a tactical one.
- The original Kafka paper, *Kafka: a Distributed Messaging System for Log
  Processing* (NetDB 2011). Short, readable; the architecture is recognisable
  but missing replication, which came later.

## War story: the day we discovered our "log" wasn't one

Early in my career, before I worked on Kafka, I worked on an "event bus" at a
trading firm. It was a JMS broker — IBM MQ, if you must know — and the
operational story was that it gave us a "single source of truth for trade
events." For three years we believed this.

The day we discovered we were wrong was an audit. A regulator asked us to
reconstruct the state of every position at 14:32:17 on a particular Wednesday
six months prior. We could not do it. The events from that day had been
consumed and acknowledged and were *gone*. We had a database — many
databases, actually — that *claimed* to be derived from those events, but the
databases had been written to directly by various processes over the years
("just this once, we needed to fix something"), and we had no way to verify
that the database was a faithful function of the original events. There was
no original log to replay.

We failed that audit. We spent eighteen months migrating to a different
architecture — one with a durable, replayable log at the centre, every
mutation flowing through it, every database materialised from it,
re-materialiseable from it. That architecture's substrate was Kafka.

The moral is in the title of this chapter. The log is *deceptively simple*.
Most engineers, on first encounter, think: that's just a queue with longer
retention. The thing they miss is that the *retention is the point*. A
queue with retention is a fundamentally different artefact — it is a system
of record. The system you build on top of it is correct in a way that no
system built on a destructive-read queue can be. Once you have seen the
difference, in production, under audit, you do not go back.

[^1]: https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying
