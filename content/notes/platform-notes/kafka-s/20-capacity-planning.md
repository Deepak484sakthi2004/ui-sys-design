# Chapter 20 — Capacity Planning
### Sizing Brokers, Partitions, and the Math You Should Do Once

---

Capacity planning for Kafka is one of those topics where everyone has
opinions and few have spreadsheets. The phrase "how many brokers do we
need?" gets asked roughly daily; the rigorous answer involves about
eight numbers, each of which the asker can usually estimate, but which
nobody bothers to write down. This chapter is the spreadsheet.

We cover:

- The eight inputs: bytes/sec, retention, replication, message size,
  consumer fan-out, partition count.
- Disk sizing: per-broker and per-topic.
- Network sizing: NIC bandwidth, replication multiplier.
- Memory sizing: heap, page cache, off-heap.
- CPU sizing: where it matters (compression, TLS, request handlers).
- Partition count: the math, the heuristics, the mistakes.
- Cluster sizing: number of brokers, controllers.

By the end you should be able to answer "we need to support X MB/s of
ingest with Y day retention, how many brokers and what kind?" with
arithmetic, not gut feel.

---

## 20.1 The eight inputs

Before any sizing math, write down:

| Input | Notation | Typical units |
|-------|----------|---------------|
| Peak ingest rate | $W_p$ | MB/s |
| Average ingest rate | $W_a$ | MB/s |
| Retention period | $T_r$ | days |
| Replication factor | $RF$ | (typically 3) |
| Average message size | $S_m$ | bytes |
| Consumer fan-out | $F$ | (number of independent consumer groups) |
| Compression ratio | $C$ | (typical 0.3 = 70% reduction) |
| Hot tier fraction (if tiered) | $h$ | (e.g., 12 hours / 7 days = 0.071) |

Get these as best you can. Order of magnitude is enough; precision
isn't required.

---

## 20.2 Disk sizing

### 20.2.1 Per-topic, hot tier

Hot-tier storage for one topic:

```
disk_per_topic = W_p × T_hot × RF × C
```

With:
- $W_p$ = 100 MB/s peak (= 8.64 TB/day)
- $T_{hot}$ = 7 days (no tiered storage, so $T_{hot} = T_r$)
- $RF$ = 3
- $C$ = 0.3 (70% compression)

```
= 100 MB/s × 86400 s/day × 7 days × 3 × 0.3
= 100 × 86400 × 7 × 3 × 0.3 / 10^6 TB
= 54.4 TB
```

Wait — let me redo. 100 MB/s × 86400 s = 8.64 GB/s/day, no wait,
100 MB/s × 86400 s = 8,640,000 MB = 8640 GB = 8.64 TB per day raw.
With compression ratio 0.3 (compressed is 30% of raw), it's 2.59
TB/day on disk. Times 7 days = 18.1 TB. Times RF=3 = 54.4 TB total
across the cluster.

### 20.2.2 Per-broker

If you have 6 brokers and the topic's partitions are evenly
distributed:

```
disk_per_broker = disk_per_topic / num_brokers
                = 54.4 TB / 6 = 9.07 TB per broker
```

For multiple topics, sum across topics.

Add headroom: aim for 60-70% utilisation as the high-water mark. So
provision $9.07 / 0.65 \approx 14$ TB per broker.

### 20.2.3 With tiered storage

Hot tier:

```
hot_per_broker = (W_p × T_hot × RF) / num_brokers × C
```

Cold tier:

```
cold_total = W_p × T_r × C   (only one copy in cold tier)
```

With same numbers but $T_{hot}=12$ hours, $T_r=365$ days:

```
hot_per_broker = (100 MB/s × 0.5 days × 3) / 6 × 0.3 ≈ 217 GB
cold_total = 100 MB/s × 365 days × 0.3 ≈ 947 TB
```

Per-broker SSD: 217 GB (very modest). Cold tier total: ~1 PB on S3.
The economics flip dramatically at long retention.

---

## 20.3 Network sizing

### 20.3.1 Per-broker, in

A broker hosts $\frac{1}{N}$ of partitions on average, so per-broker
ingest is:

```
in_per_broker = W_p / num_brokers
```

But each broker also receives **replication traffic from other
brokers** for partitions where it's a follower. With RF=3, follower
fetches multiply ingest by (RF-1):

```
in_per_broker_total = W_p / num_brokers × (1 + (RF-1)/RF)
                     ≈ W_p × 2 / 3 / num_brokers   (for RF=3)
```

Wait, let me think again. A broker leads ~1/N of partitions; ingest
to those partitions arrives directly. A broker also follows ~2/N of
partitions (for RF=3, it's a follower for partitions led by other
brokers); replication traffic for those arrives via fetch.

So ingest per broker:
```
in = (1/N × W_p) + (2/N × W_p)  = W_p × 3/N = W_p × RF/N
```

For 100 MB/s peak, RF=3, N=6 brokers: $100 \times 3 / 6 = 50$ MB/s
per broker. Within a 10 GbE NIC's 1.25 GB/s budget. Fine.

### 20.3.2 Per-broker, out

Egress from a broker:

```
out = (consumer_traffic) + (follower_traffic_to_other_brokers)
    = (1/N × W_p × F) + (2/N × W_p × (RF-1))
    = W_p × (F + 2(RF-1)) / N         (RF=3)
```

For F=3 consumer groups, RF=3, N=6:
$100 \times (3 + 4) / 6 = 117$ MB/s per broker.

### 20.3.3 Total broker traffic

In + out: $50 + 117 = 167$ MB/s per broker. About 1.3 Gbps. Far
under 10 GbE.

### 20.3.4 The point

For most workloads, network is rarely the bottleneck. Disk and CPU
hit limits first. But for very high-throughput or many-consumer
workloads, network can saturate — particularly outbound, which
multiplies with consumer count.

Plan against peak, not average. A 5x burst is common.

---

## 20.4 Memory sizing

### 20.4.1 JVM heap

As discussed in Chapter 17: 6-8 GB. That's the rule.

### 20.4.2 Page cache

The page cache wants to hold "the recent tail" of every active
partition. For a broker with N active partitions, with batch size B
and recent activity rate R:

```
desired_page_cache ≈ N × B × (recent_window_seconds × R / B)
                  ≈ N × R × recent_window_seconds
```

In practice: ensure page cache is a sizable fraction of one minute's
worth of broker ingest traffic. For 50 MB/s in, that's 3 GB per
minute. A page cache of 30-60 GB easily holds 10-20 minutes of
recent data — sufficient for most consumers.

For a 64 GB broker host: 8 GB heap + 56 GB page cache. For a 128 GB
host: 8 GB heap + 120 GB page cache. (Yes, you can have 128 GB
brokers; the marginal page cache is useful up to a point.)

### 20.4.3 Off-heap

Native libraries (compression, TLS, RocksDB if Streams) use off-heap.
Plan for 1-2 GB beyond the JVM heap.

---

## 20.5 CPU sizing

### 20.5.1 Where CPU goes

CPU on a Kafka broker is consumed by:

- **TLS encryption** (if no kTLS) — ~30-50% of available CPU at
  high throughput.
- **Compression / decompression** in the Sender thread (producer
  side; broker side mostly avoids this) — but log compaction does
  decompression-modify-compression cycles.
- **Request handler threads** — CRC validation, indexing, log
  appends, response building.
- **GC** — bursts, especially under long-lived heaps.
- **Network processor threads** — buffer copying, frame parsing.

### 20.5.2 Sizing rule

For a 10 MB/s or so broker: 4 cores is plenty.
For 100 MB/s: 8-16 cores comfortably.
For 1 GB/s: 32 cores plus, with TLS off the broker (or kTLS).

### 20.5.3 CPU vs memory trade

If you can't afford more cores, you can sometimes substitute memory
(more page cache reduces disk reads, lowering CPU spent on I/O wait).
But fundamentally, encrypted high-throughput Kafka is CPU-bound, and
sizing CPU correctly matters.

---

## 20.6 Partition count

### 20.6.1 The forces

More partitions:
- More parallelism for consumers.
- More parallelism for replication.
- Smaller individual partitions (faster recovery if one fails).

Fewer partitions:
- Less metadata overhead.
- Faster controller failover (fewer entries to process).
- Lower memory overhead per partition (each one has its own
  in-memory structures).

### 20.6.2 The heuristic

A reasonable rule of thumb:

```
partition_count = max(consumer_parallelism_target, throughput / 10_MB_per_partition_per_second)
```

With consumer parallelism target = 50 (you want to scale to 50
consumers in a group) and throughput = 100 MB/s:

```
partition_count = max(50, 100 / 10) = max(50, 10) = 50
```

Always pick **larger than you think you need** — partition counts
are quasi-permanent. Pick 100 partitions for a 50-consumer target.
Disk overhead for a few extra partitions is negligible; migration
later costs months.

### 20.6.3 Per-broker partition limits

Each broker can host roughly 1000-4000 partition replicas before the
metadata overhead becomes problematic. With RF=3 and N brokers, each
broker hosts ~3 × total_partitions / N replicas.

For 4000 max per broker, RF=3, N=6:
$\text{total partitions} = 4000 \times 6 / 3 = 8000$ partitions
across the cluster.

This is the cluster-level upper bound. Multi-thousand-partition topics
exist but are rarely sensible.

---

## 20.7 Cluster sizing

### 20.7.1 Number of brokers

```
num_brokers = max(
    ceil(total_disk / disk_per_broker_max),
    ceil(total_throughput / throughput_per_broker_max),
    minimum_for_HA  (typically 3 with RF=3)
)
```

Concrete example for 100 MB/s, 7-day retention, RF=3, no tiered
storage:

- Total disk = 8.64 TB/day × 7 × 3 = 181 TB raw, or 54 TB compressed.
  At 14 TB/broker (maxed at 65% utilisation), 4 brokers minimum.
- Total throughput = 100 MB/s peak, ~1.3 Gbps with replication. Any
  modest broker handles this. 3 brokers for HA suffice on throughput
  grounds.
- Minimum for HA = 3.

So: **6 brokers comfortably**, with room to grow. Using 4 or 5 is
tight; 3 with RF=3 is the floor (any broker outage drops you to RF=2
on every partition, no margin).

### 20.7.2 Number of controllers

KRaft controller quorums: 3 or 5. The choice:

- 3 controllers: tolerates 1 failure; requires 2 to function.
- 5 controllers: tolerates 2 failures; requires 3 to function.

For most clusters, 3 is fine. Use 5 if you span more than 3
availability zones, or if controller-level reliability matters
unusually.

Keep controllers on dedicated nodes (`process.roles=controller`)
for production. Combined-mode is for dev / small clusters.

---

## 20.8 Worked example

A new service: 500 MB/s peak, 1 GB/s burst capacity desired, 14-day
retention, RF=3, average 1 KB messages, 5 consumer groups, hot-tier
of 12 hours with tiered storage to S3.

### Disk

Hot tier per broker:
$$
\frac{500 \text{ MB/s} \times 0.5 \text{ days} \times 86400 \text{ s/day}}{1000 \text{ GB/TB}} \times 3 \times 0.3 \approx 0.65 \text{ TB / N brokers}
$$

For N = 12: 54 GB hot per broker. Trivial.

Cold tier total:
$$
500 \text{ MB/s} \times 14 \text{ days} \times 86400 \text{ s/day} \times 0.3 \approx 181 \text{ TB on S3}
$$

(Cold tier is only one copy.)

### Network

Per-broker ingress: $500 \text{ MB/s} \times 3 / 12 = 125 \text{ MB/s} = 1 \text{ Gbps}$.

Per-broker egress: with $F=5$, $RF=3$, $N=12$:
$$
\frac{500 \times (5 + 2 \times 2)}{12} = \frac{500 \times 9}{12} = 375 \text{ MB/s} = 3 \text{ Gbps}
$$

Total per broker: ~4 Gbps. 10 GbE per broker is fine; 25 GbE for
burst headroom.

### Memory

64 GB per broker; 8 GB heap, 50 GB page cache, 6 GB other. Or 128
GB if budget allows.

### CPU

For 500 MB/s with TLS (kTLS) and compression: 16 cores per broker is
ample.

### Partition count

For consumer parallelism of, say, 100 (you want the option):
partition count = 100 (or higher; 200 if the cardinality is
controllable).

### Brokers

12 brokers comfortably. Could be done in 6 brokers with bigger
hardware; 12 gives more headroom and faster recovery.

### Controllers

3 KRaft controllers on dedicated nodes.

### Total

12 brokers + 3 controllers + S3 bucket. About 4 Gbps each on the
brokers, 64 GB RAM, 16 cores, ~200 GB SSD. Cold tier on S3 grows to
~1 PB over a year (at 14-day retention with archival? — no, just 14 days).
Recompute: 500 MB/s × 14 days × 0.3 = 181 TB. Even at $0.022/GB-month
on S3: ~$4000/month. Compared to keeping all 14 days hot
($14/0.5 = 28 \times$ more SSD), the savings are dramatic.

---

## 20.9 Validating with load tests

The math gives you a starting cluster size. Validate with load:

1. Provision the planned cluster.
2. Run synthetic load matching projected peak.
3. Watch the fifteen metrics from Chapter 19.
4. Find the bottleneck. Scale or tune accordingly.
5. Run for hours or days; let GC, page cache, slow degradations
   surface.

A common surprise: the math says "12 brokers can handle this", and
they can, but only with kTLS. Without kTLS, you need 18. The math
has to know which costs are real for your setup.

---

## 20.10 Growth planning

Plan for capacity growth in advance:

- **Disk**: SSD doesn't grow without provisioning new disks. Add
  capacity when at 60% utilisation, not 90%.
- **Brokers**: adding brokers requires rebalancing partitions, which
  is slow and resource-intensive. Plan ahead.
- **Partitions**: as discussed, partition count is quasi-permanent.
  Pick generously up front.

A useful rule: provision for double the current load, plan for
4× growth in three years. If you're at 50% capacity, plan the next
expansion at 70% utilisation; at 75% capacity, the next expansion
should already be in progress.

---

## Summary box

- The eight inputs: peak / average ingest, retention, RF, message
  size, fan-out, compression, hot tier fraction.
- Disk: $W \times T \times RF \times C$, distributed across brokers,
  with 30-40% headroom.
- Network: ingress = $W \times RF / N$, egress = $W \times (F + 2(RF-1)) / N$.
- Memory: 8 GB heap, fill the rest with page cache.
- CPU: 4-32 cores depending on throughput; TLS dominates if no kTLS.
- Partition count: pick based on consumer parallelism and throughput,
  generously, up front. Migrating later is painful.
- Cluster: 3-12 brokers for most workloads; 3-5 KRaft controllers on
  dedicated nodes.
- Validate the math with load tests; growth-plan to 60% utilisation.

## Further reading

- Confluent's *Kafka Cluster Sizing* whitepaper — the reference
  material, with similar arithmetic but more vendor-specific.
- *Designing Data-Intensive Applications* chapter 11 for general
  capacity reasoning.
- Aiven's blog — frequently has up-to-date capacity discussions for
  cloud Kafka.

## War story: the cluster that ran out of partitions

A team's cluster supported 5,000 partitions across 8 brokers (~1900
replicas per broker — within limits but not lots of headroom). They
launched a new product that needed a 1,000-partition topic.
Adding it pushed each broker's replica count to ~2300; the cluster
was sluggish but functional.

Then a second product launched with another 1,000-partition topic.
The brokers each held ~2700 replicas; metadata overhead became
significant; controller failover went from 5 seconds to 90 seconds;
restart recovery time tripled.

The team had been told (correctly) that "a few thousand partitions
per broker is fine." They had not internalised that "fine" has a
breakdown point.

The fix was capacity expansion: 8 brokers → 16 brokers, partitions
spread thinner, ~1300 replicas per broker. This took two months of
planning and rebalancing.

The lesson: capacity is a curve, not a step. There's a comfortable
zone, a "fine" zone, and a "things start to suffer" zone. Plan to
stay in the comfortable zone; "fine" is where surprises emerge.

When in doubt: bigger cluster, fewer-partitioned brokers. Small
clusters with many partitions per broker are the riskiest setup, and
the most common.
