# Chapter 22 — Anti-Patterns and Pitfalls
### Things I Have Seen Go Wrong

---

A book full of "do this" needs a chapter of "don't do that". Here
are the anti-patterns I've seen most often in production. Each is a
recipe for a specific kind of pain. Each has caused at least one
incident I had to clean up.

If you read only one chapter of this book before going on call, read
this one.

---

## 22.1 The "we don't need replication" cluster

A team running RF=1 because "we'll just re-produce if we lose data."

Why it goes wrong: a single broker hardware failure deletes the
data. Re-producing from upstream requires the upstream to *still
have* the data, which is rarely true. Most "I'll re-produce" plans
are aspirational at best.

The fix: RF=3 (or RF=2 if you really, really can't afford the disk),
`min.insync.replicas=2`, `acks=all`. The cost is 3x storage; the
benefit is "the cluster works as a system".

Specific pain: I have seen at least three production incidents
caused by RF=1 plus a hardware failure plus a dead upstream. Each
one cost weeks of recovery and incomplete data forever.

---

## 22.2 The "we don't really need acks=all" producer

`acks=1` (or `acks=0`) for a topic where data loss matters.

Why it goes wrong: leader can crash after acknowledging but before
replicating. Data lost. Producer thinks it succeeded; consumer never
sees it; you find out months later from a regulator.

The fix: `acks=all` always for production topics where loss matters.
The latency cost is minimal in practice (Chapter 4); the durability
benefit is genuine.

Specific pain: covered in Chapter 4's war story.

---

## 22.3 The "I'll just turn off auto-commit's interval" consumer

Setting `auto.commit.interval.ms=1` to reduce duplicate processing
on crash.

Why it goes wrong: auto-commit happens *inside `poll()`*, regardless
of whether the application has processed the records yet. Tighter
interval means more frequent commits, but the fundamental race
between "delivered to app" and "processed by app" remains.

The fix: turn auto-commit *off* (`enable.auto.commit=false`) and
commit explicitly after processing.

Specific pain: covered in Chapter 10's war story.

---

## 22.4 The "we'll fix the partition count later" topic

Picking a small partition count (4, 8, 16) "because the volume is
small now."

Why it goes wrong: partition count is quasi-permanent. Migrating
later (especially if records are keyed) requires complex
re-partitioning that can take months. Volume always grows; the small
number you picked at launch becomes the hard ceiling on consumer
parallelism forever.

The fix: pick partition counts generously. 100-200 partitions for a
"normal" topic is reasonable; the disk cost is trivial.

Specific pain: covered in Chapter 2's war story.

---

## 22.5 The "I'll just use Kafka as a database" application

Querying state from a Kafka topic by replaying it.

Why it goes wrong: Kafka is a log, not a database. There's no
indexing on values, no random query, no joins, no transactions
across keys. Doing "SELECT * WHERE foo = bar" requires reading the
entire topic.

The fix: maintain a materialised state in a database (Postgres,
RocksDB via Streams, ElasticSearch — pick the right one). Kafka is
the source-of-truth log; the database is the queryable view.

Specific pain: I've seen teams build "Kafka as database" with
read-from-beginning consumers that build in-memory hashmaps. Works
fine until the topic is too big to fit; then they're stuck.

---

## 22.6 The "we'll set up monitoring later" cluster

Cluster runs for months without alerts. First alert is "everything
is on fire."

Why it goes wrong: incidents that would have been minor (an
under-replicated partition for an hour) become catastrophic by the
time someone notices.

The fix: set up the fifteen alerts from Chapter 19 *before* the
cluster goes to production. Test the alerts by introducing failures
in staging.

Specific pain: every incident I've seen lasted longer than necessary
because the team didn't notice promptly.

---

## 22.7 The "we'll figure out security later" cluster

No TLS, no auth, no ACLs. "It's behind the VPN."

Why it goes wrong: insider threats are real. New products
unintentionally expose data. Compliance audits demand security in
weeks, not quarters. Retrofitting auth into an existing cluster with
hundreds of clients is brutal.

The fix: ship with TLS + SASL + ACLs from day one.

Specific pain: covered in Chapter 18's war story.

---

## 22.8 The "we'll keep all the data forever" cluster

Retention set to infinity (or very long).

Why it goes wrong: disk grows unboundedly. Eventually disk fills,
broker crashes, recovery is painful. Cost is real. Without tiered
storage, infinite retention is infeasible at any scale.

The fix: pick a real retention. 7-30 days for most operational
topics. Use tiered storage (Chapter 13) if you need long retention.
Archive to S3 if you need *truly* long retention (forever) at low
cost.

Specific pain: a team I worked with had a 5-year-retention topic
that grew to 200 TB on local SSD before they noticed.

---

## 22.9 The "let's run ZooKeeper on the same hosts as brokers" deployment

Co-locating ZK ensemble (or KRaft controllers) with brokers.

Why it goes wrong: broker traffic spikes consume CPU/disk/network,
starving the control plane. Controller failover slows; ISR updates
delayed; cluster instability.

The fix: dedicated nodes for KRaft controllers. (For old
ZooKeeper-mode clusters: dedicated ZK ensemble.) Dev / small
clusters can co-locate; production should not.

Specific pain: a team had cluster-wide latency spikes during
business-hour peaks; root cause was ZK CPU starvation on hosts
shared with brokers.

---

## 22.10 The "infinite retries" producer

`retries=Integer.MAX_VALUE` (which is the default in modern Kafka)
combined with no application-level error handling.

Why it goes wrong: a permanently-failing send (e.g., authorisation
denied, non-existent topic) retries forever, blocking the producer.
Memory fills with pending records.

The fix: `delivery.timeout.ms` (default 120000 ms = 2 minutes)
bounds the total retry time. Set this conservatively. After
exhausting, the callback fires with the error — you must handle it
in the application.

Specific pain: a team had a producer that hung for hours when a topic
was renamed; they eventually killed the process and lost all
in-flight records.

---

## 22.11 The "let me just compact this huge topic" decision

Enabling `cleanup.policy=compact` on a topic that has billions of
unique keys.

Why it goes wrong: the cleaner's dedupe buffer overflows; compaction
runs slowly or not at all; the topic grows. Eventually you realise
compaction was never working.

The fix: estimate key cardinality before enabling compaction. For
high-cardinality topics, raise `log.cleaner.dedupe.buffer.size`
(default 128 MB) or split the topic by key prefix.

Specific pain: covered in Chapter 12's war story.

---

## 22.12 The "let me share this consumer-group ID" mistake

Two unrelated applications using the same `group.id`.

Why it goes wrong: they share partition assignments. App A reads
some partitions, App B reads others — neither sees the full data.
Mysterious "missing records" in both applications.

The fix: every distinct application has its own `group.id`. Use
naming conventions: `application-name.environment.consumer-name`.

Specific pain: I've seen this twice in production. Each time,
debugging took hours because nobody suspected the cause.

---

## 22.13 The "we'll roll our own consumer" decision

Skipping the official Kafka client library, writing protocol from
scratch.

Why it goes wrong: the protocol is large, the edge cases are many,
the official client has fifteen years of bug fixes.

The fix: use the official library (Java) or the well-maintained
language-specific clients (`librdkafka` for C/C++/Python/Go,
`kafka-python`, `aiokafka` for asyncio Python, etc).

Specific pain: I've seen one team build a custom Go consumer in
2017 that reproduced every consumer bug Kafka had previously fixed,
plus a few new ones. They eventually migrated to `librdkafka`.

---

## 22.14 The "let me make every topic a transactional one" pattern

Enabling transactions everywhere.

Why it goes wrong: transactions add overhead (extra round trips,
LSO management, coordinator state). For topics without
exactly-once requirements, the cost is wasted.

The fix: use transactions only where needed: consume-process-produce
loops with strict exactly-once semantics. Plain idempotent producers
suffice for most cases.

Specific pain: a team had a 30% throughput regression after
"upgrading to exactly-once everywhere"; they rolled back to plain
idempotent producers on most topics.

---

## 22.15 The "we'll skip Schema Registry" choice

Plain JSON or raw bytes, no schema management.

Why it goes wrong: schemas drift. Producer-consumer mismatches.
Silent breakage. Audit nightmares.

The fix: Schema Registry from day one if you have multiple teams.
Even for single-team setups, a documented schema in code + version
control catches a lot of issues.

Specific pain: a team had a JSON-encoded topic where a producer
silently switched a numeric field from int to float. Three of seven
consumers crashed; two silently rounded; two were fine. Nobody
noticed for days.

---

## 22.16 The "let's just bump the heap when there's a memory issue" reflex

Increasing JVM heap to fix any memory-related issue.

Why it goes wrong: bigger heap → bigger GC pauses → broker stalls →
cascading issues. The right answer to broker memory pressure is
usually *less* heap, not more (so the page cache wins).

The fix: keep heap at 6-8 GB. If memory issues arise, investigate
root cause: leak (which more heap won't fix), too many partitions,
weird allocation pattern.

Specific pain: covered in Chapter 17's war story.

---

## 22.17 The "I'll just delete this topic" recovery action

Deleting a problematic topic to "make the issue go away."

Why it goes wrong: topic deletion is *destructive*. If consumers
were behind, they lose unprocessed data. Downstream services may
break. Application logs may reference offsets that no longer exist.

The fix: investigate first. Topic deletion is rarely the right
response to an incident. Pause producers, drain consumers, *then*
delete if necessary.

Specific pain: a team deleted a topic during an incident "just to
clear it"; downstream services using the topic broke; recovery took
three days.

---

## 22.18 The "we'll just use the same broker for everything" cluster

A single Kafka cluster handling production critical data, dev/test,
metrics, and logging.

Why it goes wrong: workloads compete. A spike in dev traffic affects
production. A flaky logging app drives ISR shrinks. Operational
windows for one workload block others.

The fix: separate clusters for separate criticality classes.
Production-critical, dev/test, observability — at least three
clusters. The operational overhead per cluster has dropped (KRaft,
automation) so this is more viable than it used to be.

Specific pain: I've seen teams have production outages caused by a
chatty internal-tool consumer. Separation would have prevented it.

---

## 22.19 The "let me skip the consumer offset commit" optimisation

A consumer that processes records but never commits, "because it
just reads to update an in-memory cache."

Why it goes wrong: on restart, the consumer reads from
`auto.offset.reset` — typically `latest` for an in-memory cache.
But sometimes you want to backfill. And you've forgotten how the
cache populates. And the application has subtle dependencies on
"complete recent state" that aren't met after a restart.

The fix: commit offsets even for "throwaway" consumers, so you have
a reproducible position.

Specific pain: a team had an in-memory cache that "always self-recovered";
during an incident requiring restart, they discovered it took 30
minutes to "catch up" because of the auto-reset to latest.

---

## 22.20 The "we'll use Kafka because it's the standard" decision

Adopting Kafka because everyone else does, without a specific
problem to solve.

Why it goes wrong: Kafka is a heavy dependency. Operating it
correctly takes specialist knowledge. If you don't actually need
the log abstraction, the operational cost may exceed the benefit.

The fix: ask what problem Kafka specifically solves for you. If the
answer is "decoupling, replay, fan-out", great. If the answer is
"it's the standard", reconsider.

Specific pain: I've seen multiple companies adopt Kafka, deploy it
poorly, run it incorrectly, and ultimately migrate to simpler
systems (Redis Streams, RabbitMQ, even direct gRPC) that better
matched their actual problem.

---

## Summary box

The big anti-patterns:

1. RF=1 / acks≠all / min.insync<2 — "I don't really need durability".
2. Auto-commit + naive consumer — "I'll just trust the defaults".
3. Small partition count — "we'll fix it later".
4. No monitoring — "we'll set it up later".
5. No security — "we're behind the VPN".
6. Unbounded retention — "keep everything".
7. Co-located controllers + brokers — "save a host".
8. Skipping Schema Registry — "we don't need that".
9. Sharing group IDs / clusters / topics for unrelated workloads.
10. Treating Kafka as a database / job queue / DBMS.

Each is a specific kind of pain. Avoiding them saves more
operational time than any tuning chapter.

## War story: the cluster that had every anti-pattern

A team had inherited a Kafka cluster from a departed contractor.
They asked me to "review it for best practices."

Findings:

- RF=1 on every topic.
- `acks=0` on most producers.
- `enable.auto.commit=true` on every consumer.
- 4 partitions per topic regardless of throughput.
- No monitoring beyond a green/red status check.
- No TLS, no ACLs, no auth.
- 365-day retention (on local SSD, no tiered storage).
- 2 brokers (yes, two).
- ZooKeeper running on the same hosts as the brokers.
- Custom Python consumer with bugs reproducing 2015-era issues.
- Two services accidentally sharing a `group.id`.

The cluster had had three "minor incidents" (data loss, partial
outage) in the previous month that the team had attributed to "flaky
infrastructure". On review, every one of them was traceable to the
above.

The remediation plan was a six-month project. We started with the
durability defaults (RF, acks, min.insync), did monitoring and
security in parallel, then partition count, then everything else.
Most of it was 1-line config changes, but each required testing and
careful rollout because of the production traffic.

The lesson: anti-patterns compound. A cluster with one mistake is
manageable; a cluster with a dozen is a rebuild project. The cost of
"set it up right the first time" is small. The cost of "we'll fix
the technical debt later" is enormous.

If you take one thing from this book: build correctly from day one.
The defaults are good — use them. The opinionated recommendations
in this book are opinionated for reasons. Skipping them to save
hours costs months later.
