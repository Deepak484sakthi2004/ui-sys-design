# Chapter 19 — Monitoring and Operations
### What to Watch, What to Alarm On, and the Runbook for the 3 a.m. Page

---

A Kafka cluster that nobody is watching is a Kafka cluster that
will surprise you. Kafka has *many* metrics — JMX exposes thousands —
and the temptation is either to ignore them all or to alert on every
one and drown. Both fail. The discipline is to find the small set of
metrics that mean something at the human-attention level, alert on
those, and use the rest as drill-down for incidents.

This chapter is operations-grade. We cover:

- The metric taxonomy: what JMX exposes and how to navigate it.
- The fifteen metrics that matter for alerts.
- The dashboards that should be on every Kafka SRE's screen.
- The on-call playbook: a runbook for the most common pages.
- MirrorMaker 2 and cross-cluster replication.
- Backups, disaster recovery, and what each costs.
- Capacity planning (a brief preview; full chapter next).

By the end you should have a concrete plan for monitoring a Kafka
deployment and a runbook structure for handling incidents.

---

## 19.1 The metric taxonomy

Kafka exposes metrics via JMX (Java Management Extensions) on the
broker JVM, on Connect workers, on producers, on consumers. Most
production deployments use a JMX exporter (Prometheus JMX exporter is
common) to scrape these into a time-series database.

Top-level JMX domains:

- **`kafka.server`** — broker-level metrics: throughput, replication,
  request handlers, log management, etc.
- **`kafka.network`** — request-handling, processor, response queue.
- **`kafka.controller`** — controller-specific metrics.
- **`kafka.cluster`** — partition-level metrics.
- **`kafka.coordinator.group`** — group coordinator state.
- **`kafka.coordinator.transaction`** — transaction coordinator state.
- **`kafka.log`** — log compaction, segment rolling.
- **`java.lang`** — JVM metrics: heap, GC, threads.
- **`kafka.streams`** — Streams application metrics.
- **`kafka.connect`** — Connect worker metrics.
- **`kafka.consumer`** / **`kafka.producer`** — client-side metrics.

Each metric has a name (`type=...,name=...`) and several attributes
(usually a numeric value plus rate variants — `OneMinuteRate`,
`FiveMinuteRate`, `MeanRate`). For monitoring, the rate metrics are
generally what you want.

---

## 19.2 The fifteen metrics that matter

Forget the rest until you're handling these. These are my actual
on-call alerts, refined over years.

### Broker health (5)

1. **`UnderReplicatedPartitions`** (`kafka.cluster:type=Partition,name=UnderReplicatedPartitions,...`)
   Should be `0`. > 0 means a follower is lagging or dead.
   *Alert: > 0 for 5 minutes.*

2. **`OfflinePartitionsCount`** (`kafka.controller:type=KafkaController,name=OfflinePartitionsCount`)
   Should be `0`. > 0 means a partition has no leader — clients
   can't read or write it.
   *Alert: > 0 for 1 minute.*

3. **`ActiveControllerCount`** (`kafka.controller:type=KafkaController,name=ActiveControllerCount`)
   Should be `1` cluster-wide (sum across all brokers in KRaft —
   cluster sum should = 1).
   *Alert: != 1 for 1 minute.*

4. **`RequestHandlerAvgIdlePercent`** (`kafka.server:type=KafkaRequestHandlerPool,name=RequestHandlerAvgIdlePercent`)
   Should be > 0.7 typically. < 0.3 sustained means handlers are
   saturated.
   *Alert: < 0.3 for 5 minutes.*

5. **`NetworkProcessorAvgIdlePercent`** (`kafka.network:type=SocketServer,name=NetworkProcessorAvgIdlePercent`)
   Same idea, for network threads.
   *Alert: < 0.3 for 5 minutes.*

### Throughput (3)

6. **`BytesInPerSec`** (`kafka.server:type=BrokerTopicMetrics,name=BytesInPerSec`)
   Bytes per second produced into the broker.
   *Alert: sudden drop or spike vs baseline.*

7. **`BytesOutPerSec`** (`kafka.server:type=BrokerTopicMetrics,name=BytesOutPerSec`)
   Bytes per second consumed out (includes replication).
   *Alert: same.*

8. **`MessagesInPerSec`** (`kafka.server:type=BrokerTopicMetrics,name=MessagesInPerSec`)
   Records per second in.
   *Alert: same.*

### Latency (3)

9. **`TotalTimeMs (Produce)`** (`kafka.network:type=RequestMetrics,name=TotalTimeMs,request=Produce`)
   p99 time to handle a Produce request.
   *Alert: p99 > 100 ms for 5 minutes.*

10. **`TotalTimeMs (FetchConsumer)`** (`...,request=FetchConsumer`)
    p99 time to handle a consumer Fetch.
    *Alert: p99 > 500 ms for 5 minutes.*

11. **`TotalTimeMs (FetchFollower)`** (`...,request=FetchFollower`)
    p99 follower fetch latency.
    *Alert: p99 > 100 ms for 5 minutes.* (Slow follower fetches drag
    `acks=all` produce latency.)

### Substrate (4)

12. **JVM heap usage** (`java.lang:type=Memory`)
    Old gen utilisation — should not climb monotonically; should
    plateau or saw-tooth on GC.
    *Alert: old-gen > 90% sustained.*

13. **GC pause time** (from GC log or JMX `java.lang:type=GarbageCollector`)
    Total time spent in GC per minute.
    *Alert: > 5% of wall time per minute.*

14. **Disk usage** (per `log.dirs`)
    *Alert: > 80%.*

15. **Network bytes** (per NIC)
    *Alert: > 80% of NIC capacity sustained.*

A cluster monitored against these 15 will catch ~95% of incidents
before users notice. The other 5% are subtle and require deeper
investigation.

---

## 19.3 Dashboards

I keep three dashboards on a fresh installation:

### 19.3.1 Cluster Overview

One screen, big numbers:

- Total bytes in/out, messages in.
- Total partitions / brokers / topics.
- `UnderReplicatedPartitions` count.
- `OfflinePartitionsCount`.
- ISR-shrink-rate (per minute).
- p99 produce / fetch latency.

This is the dashboard you look at first to ask "is the cluster broadly
healthy?"

### 19.3.2 Per-Broker Drilldown

For each broker:

- Heap usage, GC pause time.
- CPU, disk usage, network bytes.
- RequestHandlerAvgIdlePercent.
- Per-request-type latency p99.
- ISR membership for hosted partitions.

When a single broker is unhealthy, this dashboard tells you which
component (JVM, OS, broker code) is the issue.

### 19.3.3 Per-Topic / Per-Consumer-Group

- Topic: bytes in/out per topic, partition count, ISR health.
- Consumer group: lag per partition, lag total, last-commit-time.
- Producer: send rate per topic.

When a specific application is misbehaving, this is where you go.

---

## 19.4 Consumer lag: the operational metric

Consumer lag — the gap between a partition's HWM and the consumer's
committed offset — is the single most important consumer-side
metric. Persistent lag means the consumer can't keep up; growing
lag means the consumer is falling behind faster than it processes.

`kafka-consumer-groups.sh --describe --group my-group` shows lag
per partition. For monitoring, use `Burrow` (LinkedIn's tool) or
the `kafka-lag-exporter` to scrape lag into Prometheus.

Alert philosophy:

- **Lag > N records** is a coarse alert. The right N depends on the
  use case.
- **Lag > N seconds** is better — convert lag into wall-time by
  multiplying by ingestion rate.
- **Lag growing for > 15 minutes** is the strongest signal. Steady-state
  lag is normal; growing lag is the symptom.

For high-volume topics, a few-hundred-record lag is normal. For
critical low-volume topics, even a 10-record lag for a few minutes
might be an alert.

---

## 19.5 The on-call runbook (skeleton)

Every Kafka SRE team needs a runbook. Here is the skeleton — fill in
your specifics.

### 19.5.1 Page: UnderReplicatedPartitions > 0

1. Identify which broker is the source of the lag:
   `kafka-topics.sh --describe --under-replicated-partitions`.
2. SSH to that broker. Check JVM (heap, GC), CPU, disk I/O.
3. If broker is alive but lagging: look at `iostat` for disk
   contention; `top` for CPU; GC log for pauses.
4. If broker is unreachable: check infrastructure (VM up? Network
   reachable? Disk full?).
5. If all else fails: restart the broker. (Confirm with team — don't
   restart unilaterally on shared clusters.)

### 19.5.2 Page: OfflinePartitionsCount > 0

1. *This is serious.* No leader for some partition.
2. `kafka-topics.sh --describe --unavailable-partitions`.
3. The affected partitions had all their ISR replicas down. Identify
   why.
4. If brokers are recovering: wait. The partition will come online
   when an ISR replica returns.
5. If brokers are permanently lost (e.g., hardware failure on
   multiple at once): consider unclean leader election as a last
   resort. **This loses data.** Confirm with stakeholders before
   running.

### 19.5.3 Page: Producer p99 latency spike

1. Check `RequestHandlerAvgIdlePercent` per broker. If low, broker is
   saturated.
2. Check ISR-shrink-rate. If recent shrinks, replication is sluggish.
3. Check `BytesInPerSec` per topic — a runaway producer flooding the
   cluster.
4. Check disk I/O on brokers. Page cache thrashing is the silent
   killer.
5. If a single client is the source: throttle it (quotas) or contact
   the team.

### 19.5.4 Page: Consumer lag growing

1. Check the consumer's last-commit-time. Stale = consumer is stuck.
2. Check the consumer group's rebalance state. Recurring rebalances
   mean the consumer is being kicked.
3. Check the consumer's process: is it CPU-bound? Stuck on a
   downstream system?
4. Common causes: downstream slow, GC pause, consumer code bug.
5. Pause and resume can help if downstream is the bottleneck.

### 19.5.5 Page: ActiveControllerCount != 1

1. `1` is healthy. `0` means no controller — cluster-wide control
   plane is down.
2. `> 1` means split-brain on the controller — the worst possible
   failure.
3. For 0: check that controllers are running. Restart if necessary.
   Investigate why the previous controller died.
4. For > 1: check controller logs for split-brain root cause
   (network partition, mis-configured Raft timeouts, etc.).
   Restart controllers one at a time if needed.

---

## 19.6 Cross-cluster replication: MirrorMaker 2

For multi-region deployments, you replicate data between clusters.
The standard tool is **MirrorMaker 2** (MM2), which is a Kafka Connect
connector wrapping the replication.

Architecture:

```
Cluster A (us-east)              MirrorMaker 2 (Connect cluster)              Cluster B (us-west)
   ┌────────┐                          ┌────────────────┐                       ┌────────┐
   │ Topics │ ──────────────────────→  │ Source Conn    │ ──────────────────→  │ Topics │
   └────────┘                          │ + Sink Conn    │                       └────────┘
                                       └────────────────┘
```

MM2 features:
- Topic auto-creation on the destination.
- Topic-prefix renaming (so `cluster-a.orders` on B is recognisably
  from A).
- Consumer offset translation.
- Active-active and active-passive topologies.

Operational realities:
- MM2 is itself a Kafka Connect cluster. You operate it.
- Lag on MM2 is its own metric — MM2 has consumer-group offsets in
  the source cluster.
- Bidirectional replication has subtle loops: prefix renaming
  prevents echo, but configuration mistakes have caused
  catastrophic loops.

For very critical replication needs, commercial products (Confluent
Replicator, Cluster Linking) provide more.

---

## 19.7 Backups and DR

Kafka has historically been "if you replicated to RF=3, that's your
backup". This is increasingly being augmented:

### 19.7.1 Tiered storage as soft-backup

Tiered storage (Chapter 13) gives you long retention on cheap object
storage. If the hot tier is destroyed, you can re-bootstrap from the
cold tier (in principle — the recovery path is non-trivial).

### 19.7.2 Cross-region replication

MM2 to another region for DR. Total data residency in two regions =
true backup against single-region disasters.

### 19.7.3 Dump-to-storage

Periodic dump of every topic's contents to S3 (via Kafka Connect S3
sink) is a more archive-style backup. Less precise than replication
but cheaper and adequate for some compliance needs.

### 19.7.4 Configuration backup

Often forgotten: the cluster's *configuration* (topic configs, ACLs,
quotas, schema registry contents, Connect configs) is just as
important as the data. Back this up via:
- GitOps (preferred — every config change is in version control).
- Automated dumps to object storage.

A cluster with all data preserved but no configuration is a paperweight.

---

## 19.8 Operational practices

### 19.8.1 Rolling restarts

Modern brokers support rolling restart with no downtime:

```bash
# For each broker:
kafka-broker-api-versions.sh --bootstrap-server broker:9092 ...
# Trigger graceful shutdown
# Wait for ISR to recover
# Restart broker
# Wait for under-replicated count to return to 0
# Move to next broker
```

Tools like **Cruise Control** automate this and balance partition
assignments.

### 19.8.2 Capacity expansion

Adding brokers:
1. Spin up new broker(s) with new broker IDs.
2. Existing topics don't auto-rebalance. Use `kafka-reassign-partitions.sh`
   to spread partitions to new brokers.
3. Throttle the reassignment (it does heavy I/O and network work).

Cruise Control or Confluent's Auto Data Balancer automates this.

### 19.8.3 Decommissioning

Removing brokers:
1. Move all partitions off the broker (via reassignment).
2. Verify zero partitions hosted.
3. Shut down the broker.

Don't skip step 2. A broker shut down with partitions still hosted
will trigger leader elections and ISR shrinks.

### 19.8.4 Topic deletion

Topic deletion is asynchronous. After `kafka-topics.sh --delete`,
the broker schedules deletion of the underlying log files. This can
take minutes. The topic is *removed from metadata* immediately but
disk reclaim follows.

If you delete a high-traffic topic mid-incident, expect IO spike from
file deletion.

---

## Summary box

- The fifteen metrics: under-replicated, offline partitions, active
  controller, request-handler idle, network idle, throughput,
  latency p99, JVM heap and GC, disk usage, network bytes.
- Three dashboards: cluster overview, per-broker drill-down, per-topic /
  per-consumer-group.
- **Consumer lag** is the most important consumer metric. Convert
  to wall-time. Alert on growth, not just absolute.
- The runbook should cover the common pages: under-replicated,
  offline, latency spike, lag, controller anomalies.
- **MirrorMaker 2** is the standard cross-cluster replication tool.
  It is itself a Connect cluster you operate.
- Backups: replication is most of the answer; tiered storage adds
  long-term retention; configuration backup matters too.

## Further reading

- LinkedIn's Burrow (consumer lag monitoring tool).
- Cruise Control (cluster balancing automation).
- Lenses, Confluent Control Center, Aiven Console — managed UIs.
- *The Kafka Operator's Handbook* (Confluent) — vendor-flavoured but
  useful patterns.

## War story: the dashboard nobody looked at

A team had a beautiful dashboard. Twelve panels, all the right
metrics. It had been set up six months prior, during the launch
project. Nobody looked at it after launch.

When the cluster started having intermittent issues — produce
latency spikes once a day — nobody noticed for a week. The dashboard
was showing exactly what was happening; pad the panels, the
information was right there.

The fix was not "set up better monitoring" — they had monitoring.
The fix was **alert on the metrics, don't just chart them**.
Dashboards are diagnostic; alerts are detection. Without alerts, the
dashboard is a passive document.

After the incident, they added Prometheus alerts for the fifteen
metrics in this chapter, with PagerDuty integration. The next time
latency started spiking, they had a page within five minutes,
investigated, and resolved within twenty.

The lesson is universal beyond Kafka: **a dashboard with no alert
is documentation, not monitoring**. Pick what's important and alert
on it. Pad the rest with charts. Don't conflate the two.
