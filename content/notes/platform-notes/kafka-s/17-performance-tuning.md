# Chapter 17 — Performance Tuning
### JVM, OS, NIC, Filesystem, and the Knobs That Actually Matter

---

Tuning Kafka is a peculiar discipline. The default configurations are
conservative and right for almost every situation. The internet is full
of "tune your Kafka cluster!" articles offering fifty knobs to twiddle,
and most of them are noise. The brokers, the JVM, and the kernel all
have their own opinions about how to behave; layering tweaks across
all three without understanding their interactions is how you make
things worse.

This chapter is opinionated. It covers the small set of changes that
actually move the needle, in the order I would address them, with the
reasoning behind each. The rule is: don't tune anything until you have
data showing it matters.

We cover:

- The JVM: heap sizing, garbage collector choice (G1 vs ZGC vs
  Shenandoah), and the GC log.
- The OS: page cache, swappiness, dirty page management,
  vm.max_map_count.
- The disk: filesystem choice, mount options, the page cache (again).
- The NIC: TCP, TLS overhead, kTLS, multi-listener.
- The broker configurations that move the needle.
- The producer and consumer configs, recapped from earlier chapters
  with a tuning lens.
- Benchmarking honestly: what `kafka-producer-perf-test` does and
  doesn't tell you.

By the end you should be able to look at a Kafka cluster's resource
metrics and predict, within a small range, what's slow and what to
change.

---

## 17.1 First principles

Three rules of tuning, in order:

1. **Measure before changing.** If you don't have data, you don't have a
   problem. "It feels slow" is not data.
2. **Change one thing at a time.** Multi-variable optimisation is for
   experiments, not production.
3. **Have a way to roll back.** Every change should be reversible. If
   you're not sure how to undo a config, don't apply it.

A corollary: most teams have *zero* good performance data. Their
"tuning" is cargo-culted from blog posts. The first 80% of "Kafka tuning"
in most environments is "stop doing strange things and use the
defaults." Reflexive default-restoration is often the biggest single win.

---

## 17.2 The JVM

### 17.2.1 Heap sizing

The most-overtuned knob. There is, in 2026, a strong consensus on Kafka
broker heap sizing:

> 6 GB to 8 GB. That's it.

Not 32 GB. Not 16 GB. Six to eight. The reasons:

- **The broker's own working set is small.** A request is processed in
  a request handler thread, a small request object lives briefly, log
  data is mmap'd or sendfile'd, almost nothing else. The broker's heap
  pressure comes from few sources: in-flight requests, in-flight
  responses, replicas' fetcher state, controller's metadata cache.
- **The page cache wants every spare byte.** RAM not used by the JVM
  is RAM available for the page cache. The page cache is what makes
  Kafka fast (Chapter 6). A 32 GB heap is 26 GB of RAM not available
  to the page cache. That's a real cost.
- **Larger heaps mean larger GC pauses.** Even with G1 and ZGC, a 32
  GB heap pauses longer than an 8 GB heap. The broker is latency-sensitive
  on the request-handler threads; long pauses cause RequestQueue to
  back up.

The exception: brokers with very large numbers of partitions (10K+) may
need slightly more (12-16 GB) for the metadata caches. But most brokers
fit comfortably in 6-8 GB.

```bash
KAFKA_HEAP_OPTS="-Xms6g -Xmx6g"
```

Set `Xms` = `Xmx`. Avoid heap resize at runtime; allocate up front and
keep it stable.

### 17.2.2 Garbage collector

G1GC has been the Kafka default for years and works well. Modern
Kafka images ship with it pre-configured.

```bash
KAFKA_JVM_PERFORMANCE_OPTS="-server -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=20 \
  -XX:InitiatingHeapOccupancyPercent=35 \
  -XX:+ExplicitGCInvokesConcurrent \
  -Djava.awt.headless=true"
```

For higher-end deployments, the new generation of low-pause collectors
shines:

- **ZGC** (`-XX:+UseZGC`): sub-millisecond pauses up to terabyte
  heaps. Production-ready since Java 17, fully GA since 21. For brokers,
  often gives slightly worse throughput than G1 in exchange for
  *much* better pause times. Worth measuring.
- **Shenandoah** (`-XX:+UseShenandoahGC`): similar story, different
  vendor (Red Hat's offering).

In 2026 my baseline recommendation is G1 unless you've measured
benefits from ZGC on your specific workload.

### 17.2.3 GC logging

**Always log GC.** GC pauses are a leading cause of mysterious
broker slowness, and you cannot diagnose them without the log.

```bash
-Xlog:gc*:file=/var/log/kafka/gc.log:time,uptime,level,tags:filecount=10,filesize=100M
```

Watch for:

- Pauses > 200 ms on G1 (something's stalling the broker).
- Concurrent failures (G1 mode change to STW).
- Old-gen growth without recovery (memory leak).

GC log analysis tools: GCEasy, GCViewer.

### 17.2.4 Off-heap

Some Kafka clients (the producer's BufferPool, in older versions)
allocate off-heap. Modern producer (3.0+) uses heap. The broker uses
mmap for log indexes — these don't count as JVM heap, they're in
the OS page cache.

The relevant config is `MaxDirectMemorySize`, which bounds direct
buffers (NIO). Default is roughly equal to `Xmx`. Rarely needs tuning
unless you see `OutOfMemoryError: Direct buffer memory`.

---

## 17.3 The OS

### 17.3.1 swappiness

Set `vm.swappiness=1` (or 0, but 1 is safer). Kafka's working set is
in the page cache; swapping JVM memory to disk to free RAM is
catastrophic — every JVM access becomes a disk read.

```bash
sysctl -w vm.swappiness=1
echo "vm.swappiness=1" >> /etc/sysctl.conf
```

### 17.3.2 vm.max_map_count

Each segment file's index is mmap'd. A broker with thousands of
partitions and many segments per partition can hit the kernel's
mmap limit and throw `OutOfMemoryError: Map failed` from JVM.

```bash
sysctl -w vm.max_map_count=262144
echo "vm.max_map_count=262144" >> /etc/sysctl.conf
```

The default 65536 is too low for serious Kafka. 262144 is a safe
default; raise further for very large clusters.

### 17.3.3 Dirty page management

`vm.dirty_ratio` and `vm.dirty_background_ratio` control how aggressively
the kernel flushes dirty (write-pending) pages to disk.

Defaults vary by distribution but typically:
- `vm.dirty_ratio=20` — when 20% of memory is dirty, *blocking* flush.
- `vm.dirty_background_ratio=10` — when 10%, background flush starts.

For Kafka, defaults are usually fine. Some operators lower them to
prevent occasional latency spikes when a big sync happens.

### 17.3.4 File descriptors

```bash
ulimit -n 100000          # in /etc/security/limits.conf
```

Each connection plus each open log file uses a FD. Kafka servers can
need 100K+ FDs. Default 1024 will run out fast. Raise it.

### 17.3.5 NUMA

On NUMA hosts (most modern multi-socket servers), pin Kafka to one
NUMA node:

```bash
numactl --cpunodebind=0 --membind=0 java ... kafka.Kafka
```

This avoids cross-socket memory access. The benefit is real (5-15%
throughput) but only matters at the high end.

For containers / Kubernetes, equivalent kernel settings.

### 17.3.6 The CPU scheduler

For latency-sensitive brokers, pin Kafka threads to dedicated cores
(via `taskset`) and consider `nohz_full` to reduce kernel jitter on
those cores. This is a niche optimisation; most deployments don't
need it.

---

## 17.4 The disk

### 17.4.1 Filesystem

**XFS is the recommended filesystem** for Kafka log directories. It
handles large files and high-throughput sequential writes well.
ext4 also works but has occasional fragmentation issues on
long-running, write-heavy workloads.

ZFS is popular in some cool kids' clubs. It works but adds CPU
overhead from checksumming and copy-on-write. Worth the trade for
some deployments (data integrity), not for others (raw throughput).

Avoid: tmpfs (loses data on reboot), NFS / network filesystems
(latency variance, lock semantics), btrfs (subtle issues with very
large files).

### 17.4.2 Mount options

Standard mount options:

```
/dev/nvme0n1p1 /data/kafka xfs defaults,noatime,nodiratime 0 0
```

`noatime` prevents the kernel from updating the file's access
timestamp on every read — a small but real save on a high-read
broker.

`nodiratime` is similar for directories.

Don't enable `sync` (synchronous writes) — it kills throughput. Kafka
relies on replication for durability (Chapter 6), not on per-write
fsync.

### 17.4.3 SSD vs HDD

In 2026, almost everything is SSD or NVMe. The few HDD deployments
left are for cold-tier topics (very large retention with low read
rate, where the cost matters). Even those are migrating to tiered
storage on object storage.

For active brokers: NVMe if you can afford it, SATA SSD otherwise.
HDDs are not viable for hot tiers any more.

### 17.4.4 RAID? JBOD!

As discussed in Chapter 6: JBOD is preferred to RAID for Kafka.
Replication is the durability mechanism. RAID adds write
amplification with marginal benefit.

The exception: RAID-0 (striping) for performance on systems with
many small disks. Rare; usually individual large NVMe is simpler.

### 17.4.5 The page cache, again

Restating: most of your RAM should be page cache. A broker with 64 GB
RAM, 8 GB heap, leaves about 50 GB for page cache. Watch:

```bash
free -h
# look at "buff/cache" column — should be most of RAM on a healthy broker
```

If page cache is small while disk reads are high, something is
evicting it. Common culprits: another process on the host (don't run
other big things on broker hosts), the kernel `dirty_*` settings
flushing aggressively, or just simply not enough RAM.

---

## 17.5 The NIC

### 17.5.1 Bandwidth

Plan: peak-traffic bytes/sec in + replication multiplier + headroom.
A topic with 100 MB/s of producer write, RF=3, has 100 MB/s in (to
leader) + 200 MB/s out (to followers) on the leader. With acks=all,
the followers' replicas also do 100 MB/s in, generating combined 400
MB/s of traffic on each broker for that one topic.

Multi-topic clusters add up. 10 GbE (1.25 GB/s) is comfortable for
modest deployments; 25 GbE for higher; 100 GbE for very high.

### 17.5.2 TCP tuning

For high-throughput brokers, the default TCP buffers can be too
small:

```bash
sysctl -w net.core.wmem_max=2097152
sysctl -w net.core.rmem_max=2097152
sysctl -w net.ipv4.tcp_wmem='4096 65536 2097152'
sysctl -w net.ipv4.tcp_rmem='4096 65536 2097152'
```

Plus the broker-side socket buffer settings:

```properties
socket.send.buffer.bytes=1048576           # 1 MB
socket.receive.buffer.bytes=1048576
```

These help TCP throughput on long-fat-network connections (high
bandwidth-delay product) — common in cross-region replication or
WAN-traffic deployments.

### 17.5.3 TLS overhead

We've discussed TLS extensively (Chapters 6 and 18). Key numbers:

- **Without TLS, no kTLS:** sendfile zero-copy works. Maximum
  throughput.
- **With TLS, no kTLS:** sendfile broken. ~30-50% throughput hit.
  CPU bound.
- **With TLS, kTLS:** sendfile preserved. Near-zero overhead.

Linux 4.13+ has kTLS. JDK 17+ + OpenSSL provider can use it. For
high-throughput production with TLS, ensure kTLS is on.

### 17.5.4 Multi-listener

Separate listener for inter-broker traffic so internal replication
isn't competing with client traffic:

```properties
listeners=INTERNAL://0.0.0.0:9091,EXTERNAL://0.0.0.0:9092,REPLICATION://0.0.0.0:9093
inter.broker.listener.name=REPLICATION
```

Each listener has its own processor pool. A spike on EXTERNAL doesn't
slow REPLICATION, which is what you want.

---

## 17.6 The broker configurations

Recapping the configs that move the needle:

### 17.6.1 Threads

```properties
num.network.threads=8                  # default 3; raise for >5k connections
num.io.threads=16                      # default 8; raise to ~ 2× CPU cores
num.replica.fetchers=4                 # default 1; raise on busy brokers
```

`num.io.threads` is the most-tuned. On a busy broker, raise until
`RequestHandlerAvgIdlePercent` is consistently > 70%.

### 17.6.2 Throughput

```properties
socket.send.buffer.bytes=1048576
socket.receive.buffer.bytes=1048576
socket.request.max.bytes=104857600     # 100 MB cap on any single request
queued.max.requests=500                # internal request queue size
```

### 17.6.3 Replication

```properties
replica.lag.time.max.ms=30000          # default; rarely tuned
replica.fetch.min.bytes=1
replica.fetch.wait.max.ms=500
replica.fetch.max.bytes=10485760       # 10 MB per partition; raise for big batches
replica.high.watermark.checkpoint.interval.ms=5000
```

### 17.6.4 Log

```properties
log.flush.interval.messages=Long.MAX        # don't fsync on every message (default — keep)
log.flush.interval.ms=null                  # don't fsync periodically (default — keep)
log.segment.bytes=1073741824                # 1 GB (default; rarely tuned)
log.roll.ms=604800000                       # 7 days (default; tune lower for low-volume compacted)
num.recovery.threads.per.data.dir=4         # parallel cold-start recovery
```

---

## 17.7 The producer configs (tuning lens)

Recapped from Chapter 4 with a tuning eye:

```properties
acks=all                              # durability; non-negotiable
enable.idempotence=true               # default; non-negotiable
linger.ms=20                           # batching for throughput
batch.size=131072                      # 128 KB; raise for high-throughput producers
buffer.memory=67108864                # 64 MB; raise if produce rate > 50 MB/s
compression.type=lz4                  # always on; lz4 or zstd
max.in.flight.requests.per.connection=5    # safe with idempotence
```

The single biggest "free" producer tuning is `compression.type=lz4`.
If you're not compressing, you're paying 3-5× the bandwidth and disk
you need.

---

## 17.8 The consumer configs (tuning lens)

Recapped from Chapter 10:

```properties
fetch.min.bytes=1048576              # 1 MB; raise for batch consumers
fetch.max.wait.ms=500
max.partition.fetch.bytes=10485760   # 10 MB
max.poll.records=500                 # tune for processing speed
isolation.level=read_uncommitted     # or read_committed for transactional
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
group.instance.id=...                # static membership
```

The biggest consumer wins are `CooperativeStickyAssignor` +
`group.instance.id` (rebalance pain) and `fetch.min.bytes=1MB` for
batch consumers (throughput).

---

## 17.9 Benchmarking honestly

`kafka-producer-perf-test.sh` and `kafka-consumer-perf-test.sh` are
included with Kafka. They produce/consume synthetic loads and report
throughput.

They are useful but limited:

- They generate **uniform synthetic data**, often more compressible
  than real data. Realistic compression is sometimes very different.
- They use **default producer/consumer settings**, often not what
  production uses.
- They generate **constant load**, not bursty real traffic.
- They run **briefly**, not long enough to expose GC, ISR-shrink, or
  other slow-onset problems.

Use them as quick smoke tests, not as load profiles. For real
benchmarking, build a load generator that mirrors your actual
producers' patterns.

A common pattern: replay an actual production traffic capture against
a non-prod cluster. This is the gold standard — the workload is real,
the cluster is realistic, and you can tune iteratively.

---

## 17.10 The order in which to change things

When tuning a Kafka cluster (greenfield or troubled), I work in this
order:

1. **JVM heap to 6-8 GB; G1 GC; GC logs on.** First win. Avoid the
   default 1 GB heap, which crashes under any real load.
2. **`vm.swappiness=1`, `vm.max_map_count=262144`, `ulimit -n 100000`.**
   OS basics. Should be your image's default.
3. **JBOD with XFS, mounted `noatime`.** Storage layer.
4. **Set `min.insync.replicas=2` cluster-wide.** Durability floor.
5. **Producer compression on, `linger.ms=20`.** Bandwidth and
   throughput.
6. **Consumer cooperative assignor + static membership.** Rebalance
   pain.
7. **Inspect JMX (`RequestHandlerAvgIdlePercent`,
   `UnderReplicatedPartitions`, `RequestQueueSize`, GC logs).** Find
   the actual bottleneck.
8. **Tune `num.io.threads` / `num.network.threads` / `num.replica.fetchers`
   based on JMX.**
9. **TLS via kTLS if relevant.**
10. **Iterate on per-config knobs as JMX dictates.**

Steps 1-6 are zero-thought. Step 7 is where actual *thinking* about
your specific cluster begins. Most teams are stuck somewhere in 1-6
and don't know it.

---

## Summary box

- **JVM heap: 6-8 GB.** Not more. Leave RAM for the page cache.
- **Set `vm.swappiness=1`, `vm.max_map_count=262144`,
  `ulimit -n 100000`** at the OS layer.
- **XFS + JBOD + `noatime`** for storage.
- **Don't fsync** (the default — keep it). Replication is the
  durability mechanism.
- **TLS without kTLS costs 30-50% throughput** on heavy clusters.
  Use kTLS or budget for it.
- **Compression on** (lz4 or zstd) is usually the single biggest
  producer tuning.
- **Tune by JMX**, not by horoscope. The cluster tells you what's
  saturated.
- **The defaults are mostly right.** Most "tuning" is
  default-restoration after years of misguided changes.

## Further reading

- Brendan Gregg, *Systems Performance* (2nd ed). Chapter 8 (file
  systems) and chapter 10 (network) are required.
- Martin Thompson, *Mechanical Sympathy* talks. Particularly on the
  JVM at low latency.
- Cliff Click's collected writings on JIT, GC, JVM internals.
- The Kafka Streams performance tuning chapter — often applies
  directly to broker tuning by analogy.

## War story: the "Kafka is slow" cluster

A team's cluster was "slow" — produce p99 was 200 ms, consumer lag
was high. They had been tuning for three months. They had:

- Heap at 32 GB.
- `num.network.threads=24`.
- `num.io.threads=64`.
- `socket.send.buffer.bytes=10485760` (10 MB).
- About fifteen other "tweaks" from various blog posts.

JMX showed `RequestHandlerAvgIdlePercent` at 90%. The handlers were
*idle*. So the broker wasn't doing the work; something else was.

The discovery: `vm.swappiness=60` (default). The 32 GB JVM heap was
being aggressively swapped. Every produce involved several disk
reads of swapped pages. The broker's "slowness" was the kernel
swapping JVM memory back in.

Steps to fix:

1. `vm.swappiness=1`. Heap stayed in RAM.
2. Heap reduced to 8 GB. Page cache reclaimed 24 GB of RAM.
3. Reverted all the "tuning" — `num.io.threads` back to 16,
   `num.network.threads` to 8, socket buffers back to 1 MB.

Cluster latency dropped from p99 200 ms to p99 8 ms. Consumer lag
caught up within minutes.

The team had been tuning increasingly elaborate things while ignoring
the fundamental: the OS was working against them. Every "tweak" they
added made it slightly worse, because the bigger heap caused more
swapping. A single `sysctl` was the actual fix.

The lesson: **start at the bottom of the stack. Get the OS right. Get
the JVM right. Then look at Kafka.** The vast majority of Kafka
performance issues I've seen were OS or JVM, not broker. The broker
is robust; the *substrate* is where things go wrong.
