# Appendix C — The KIP Reading Guide
### Which KIPs to Read, In What Order

---

The KIP (Kafka Improvement Proposal) process is how every non-trivial
change to Kafka is proposed, designed, debated, and accepted. KIPs
are the *real* documentation of Kafka — far more detailed than the
official docs, more current than any third-party book, and
written by the people who actually built the features.

Reading the right KIPs is one of the highest-leverage things an
engineer learning Kafka can do. This appendix curates the most
important ones, in suggested reading order.

URL pattern: `https://cwiki.apache.org/confluence/display/KAFKA/KIP-N...`

---

## C.1 Foundational KIPs

These shaped the modern protocol. Read in this order.

**KIP-1: Allow Producer to publish messages to a specific
partition.** The original partitioning contract. Short.

**KIP-32: Add timestamps to Kafka messages.** Why records have
timestamps; the introduction of the timeindex.

**KIP-35: Retrieve protocol version.** How clients negotiate API
versions. Foundational for forward-compatibility.

**KIP-43: Kafka SASL enhancements.** SASL handshake protocol; how
authentication works on the wire.

**KIP-50: Move authorizer interface.** ACL framework introduction.

**KIP-52: Connector control APIs.** Connect's REST API.

**KIP-101: Alter Replication Protocol to use Leader Epoch rather
than HWM.** *Required reading.* The fix to a long-standing
data-loss bug; understanding this is understanding modern
replication.

---

## C.2 Producer evolution

**KIP-98: Exactly Once Delivery and Transactional Messaging.** The
big one. Idempotence + transactions. ~30 pages, dense, worth all of
it.

**KIP-107: AdminClient API for partition reassignment.** AdminClient
beginnings.

**KIP-185: Make exactly once in-order delivery per partition the
default producer setting.** Why `enable.idempotence` flipped on by
default.

**KIP-360: Improve handling of unknown producer.** Producer-state
expiration; subtle EOS interactions.

**KIP-447: Producer scalability for exactly once semantics.** EOSv2.
Why one transactional producer per app instead of per task.

**KIP-480: Sticky Partitioner.** The partitioner improvement.

**KIP-679: Producer will enable the strongest delivery guarantees
by default.** The 3.0 change of defaults.

**KIP-794: Strictly Uniform Sticky Partitioner.** The fix to
KIP-480's bias.

---

## C.3 Consumer evolution

**KIP-62: Allow consumer to send heartbeats from a background
thread.** Why heartbeat is independent of poll.

**KIP-227: Introduce Incremental FetchRequests.** Fetch session
optimisation.

**KIP-320: Allow fetchers to detect and handle log truncation.** How
consumers handle leader-truncation scenarios.

**KIP-345: Reduce multiple consumer rebalances by specifying member
id.** Static membership.

**KIP-392: Allow consumers to fetch from closest replica.**
Rack-aware fetch.

**KIP-394: Require member.id for initial JoinGroup request.** A
small but consequential change to the rebalance protocol.

**KIP-429: Kafka Consumer Incremental Rebalance Protocol.**
Cooperative rebalancing. *Required reading.*

**KIP-848: The Next Generation of the Consumer Rebalance Protocol.**
The new protocol replacing JoinGroup/SyncGroup. Future-shaping.

---

## C.4 Storage

**KIP-58: Make Log Compaction point configurable.** Compaction
internals.

**KIP-112: Handle disk failure for JBOD.** Why a single disk failure
no longer takes down the broker.

**KIP-263: Allow brokers to skip sanity check of inactive segments
on startup.** Fast cold-start.

**KIP-405: Kafka Tiered Storage.** *Required reading* if you care
about long retention. ~30 pages.

**KIP-516: Topic Identifiers.** Why partitions have UUIDs.

**KIP-630: Kafka Raft Snapshot.** How metadata logs avoid
unbounded growth.

**KIP-963: Additional metrics in Tiered Storage.** Operational
metrics for tiered storage.

---

## C.5 Controller / KRaft

**KIP-500: Replace ZooKeeper with a Self-Managed Metadata Quorum.**
*Required reading.* The motivation and design for KRaft.

**KIP-595: A Raft Protocol for the Metadata Quorum.** The Raft
variant Kafka uses. ~25 pages of dense protocol design.

**KIP-631: The Quorum-based Kafka Controller.** Operational
description of the new controller.

**KIP-866: ZooKeeper to KRaft Migration.** How the migration works.
Read if you're operating a hybrid cluster.

**KIP-919: Allow AdminClient to Talk Directly with the KRaft
Controller Quorum and add Controller Registration.** Modern
admin paths.

---

## C.6 ISR / replication

**KIP-279: Fix log divergence between leader and follower after
fast leader fail-over.** A subtle replication fix.

**KIP-497: Add inter-broker API to alter ISR.** Why ISR changes go
through the controller (replacing ZK direct-write).

**KIP-704: Send a hint to the partition leader to recover the
partition.** Recovery edge cases.

---

## C.7 Streams

**KIP-129: Streams Exactly-Once Semantics.** EOS in Streams.

**KIP-138: Change punctuate semantics.** How processor-API
schedule callbacks work.

**KIP-167: Add custom dynamic handlers for serialisation
exceptions.**

**KIP-258: Allow timestamps in Kafka Streams.**

**KIP-535: Allow state stores to serve stale reads during
rebalance.** Interactive queries.

**KIP-866 (Streams variant)** is also worth a skim.

---

## C.8 Connect

**KIP-26: Add Kafka Connect framework to Kafka.** The original
proposal.

**KIP-66: Single Message Transforms.** SMTs.

**KIP-297: Externalize Secrets for Connect Configurations.**

**KIP-618: Exactly-Once Support for Source Connectors.**

---

## C.9 Security

**KIP-12: Kafka Sasl/Kerberos and SSL implementation.**

**KIP-43: SASL handshake** (already mentioned).

**KIP-238: Expose Kafka cluster ID in metadata response.**

**KIP-684: Support mutual authentication for SASL.**

**KIP-686: Add Hierarchical OAuth bearer Token Mechanism for
Kafka.**

---

## C.10 The new wave (currently shipping or in flight)

These are KIPs to track now (early 2026):

**KIP-848: Next-Gen Consumer Rebalance Protocol.** GA in Kafka
4.0+.

**KIP-932: Queues for Kafka.** *Beta as of writing.* The
queue-semantics addition. The biggest user-visible new feature in
years.

**KIP-1071: Iceberg Integration.** (Status varies; track
discussion.)

**KIP-1102: Enable Tiered Storage for Compacted Topics.** (In
discussion.)

**KIP-1140: Improve fetch session memory usage.** Operational
optimisations.

KIPs in flight are visible at the wiki, sorted by status:
*Discussion*, *Vote*, *Accepted*, *Implemented*, *Released*,
*Rejected*. Reading the discussions is often more illuminating than
reading the final KIP — the alternatives that were considered, and
why they were rejected, teach more than the design that won.

---

## C.11 Reading strategy

### For beginners

Read these eight KIPs first:

1. KIP-1 (partitioning)
2. KIP-101 (leader epoch / replication)
3. KIP-98 (idempotence + transactions)
4. KIP-405 (tiered storage)
5. KIP-429 (cooperative rebalancing)
6. KIP-500 (KRaft motivation)
7. KIP-595 (KRaft Raft)
8. KIP-848 (new consumer protocol)

About 200 pages of dense reading, but it covers the modern Kafka
architecture end to end.

### For operators

Add KIP-112 (JBOD), KIP-345 (static membership), KIP-447 (EOSv2),
KIP-866 (ZK migration). About 100 more pages.

### For client implementers

Add KIP-35 (API versions), KIP-43 (SASL), KIP-227 (incremental
fetch), KIP-320 (truncation), KIP-516 (topic IDs), KIP-684 (mutual
auth). About 80 more pages.

### For Streams users

Add KIP-129 (EOS), KIP-535 (interactive queries), KIP-258
(timestamps). KIP-447 doubles for both.

---

## C.12 What KIPs teach you

KIPs are dense and structured. Each follows the same template:

- Status (Discussion, Accepted, Released)
- Motivation
- Public Interfaces (config / API changes)
- Proposed Changes
- Compatibility / Migration plan
- Rejected Alternatives
- Test Plan

The **Rejected Alternatives** section is often the most educational.
It tells you what was tried, what didn't work, and why the chosen
design was preferred. Real engineering decisions, not propaganda.

I have learned more about distributed systems from reading Kafka
KIPs than from any single textbook. They are dense, technically
honest, well-archived, and free.

If you're serious about Kafka, KIP literacy is a high-leverage
skill. Start with the ten above.
